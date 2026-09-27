/**
 * LWB-027 真 NTFS 验收：受保护的既有文件写入。
 *
 * ## 这个文件与单元测试的分工
 *
 * `tests/unit/executor-native-adapter.test.ts` 用假护栏穷尽**分类**：每一种
 * 护栏错误该报成冲突、拒绝，还是「必须进恢复」。那是分支覆盖的活。
 *
 * 本文件反过来：**只有一条路径**（正常写入），但每一个环节都是真的 ——
 * 真 NTFS、真 `PowerShellWinfsBackend`、真的 `CreateFileW` 与
 * `FlushFileBuffers`、真 SQLite、真快照库、真 `claimForExecution`。
 * 它回答的是「这套东西接在真操作系统上还成不成立」：
 *
 *  - 验收 1 前半：检查前目标被改过 ⇒ 冲突，且**改的人的内容原样留着**；
 *  - 验收 1 后半：检查后到写入结束期间，普通竞争保存被共享模式挡住；
 *  - 验收 2：回读哈希与已批准的新哈希一致，才报告该文件写成。
 *
 * 假护栏证不了这三条：它们说的是**句柄**与**字节**的事实，而那正是单元
 * 测试刻意不碰的部分。
 *
 * ## 关于验收 1 后半的装置（必须说清楚）
 *
 * 「我们的写入期间，别人的保存被挡住」严格说需要把 `Op-WriteFileGuarded`
 * 的句柄生命周期摊开给外部看 —— 而它是一次请求内的开→写→刷→回读→关，
 * 没有可以被别的进程插进去的窗口。
 *
 * 因此这里用护栏自己的 `holdHandle`：它走的是**同一个** `Open-Guarded`、
 * **同一组**标志（`GENERIC_READ|GENERIC_WRITE` + 仅 `FILE_SHARE_READ`），
 * 只是把「写完就关」换成了「持有」。它证明的是**这组标志的性质**，
 * 不是 `Op-WriteFileGuarded` 内部的时序 —— 后者由
 * `native/winfs/WinfsGuard.ps1` 的实现本身保证（同一处 `Open-Guarded` 调用）。
 * 实测见 `docs/evidence/lwb-027/`：20 轮里 20 轮立即被挡、20 轮在 500ms
 * 之后仍被挡；助手进程退出后立刻恢复。
 *
 * 那个 20/20 是**修过之后**的数：`holdHandle` 起初把句柄留在函数局部变量里，
 * 于是 GC 随时可能把它终结 —— 连跑 20 轮曾出现 19/20，即这个用例本身有大约
 * 二十分之一的间歇失败率。修法是让护栏把持有的句柄留在一个脚本作用域的
 * 列表里（`$script:LwbHeldHandles`），活到助手退出为止。**因此本用例依赖
 * 那条修改**：若有人把引用留存去掉，这里会以一种看起来像环境抖动的方式
 * 开始偶发失败。
 *
 * 同一节还断言**反方向**：持有期间我们自己的写入路径也必须失败
 * （`FILE_BUSY`），而不是绕开共享规则 —— 那是「不降级普通文件 API」这
 * 条要求在这一侧的证据。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import { claimForExecution, createNativeApplier } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput } from '@lwb/persistence';
import { PowerShellWinfsBackend, ResidentHelper, isWinfsError } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const CONNECTION = 'conn_real';
const WORKSPACE = 'ws_real';
const PRINCIPAL = 'principal_real';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_real';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：每个用例的地都是空的。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本用例不该问进程探针');
  },
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * 取「全部写成」报告里的逐条目小结。
 *
 * `apply.ts` 从 LWB-029 起在 `applied` 上附一句逐条目结果（`detail`）。
 * 断言用 `kind` 加这一句的实际内容，而不是 `deepEqual` 整个对象 ——
 * 后者会把这句文案的每一个字都钉进真盘用例里，改一个字就红一片，
 * 而它并不是本文件要验的东西。
 */
function appliedDetail(report: ApplyReport): string {
  assert.equal(report.kind, 'applied');
  if (report.kind !== 'applied') throw new Error('unreachable');
  assert.ok(report.detail, '全部写成的报告必须带上逐条目小结');
  return report.detail;
}

/**
 * 一次**普通保存**：编辑器按保存走的就是 `File.WriteAllText`。
 *
 * 刻意不走护栏：这一节要观察的正是「不受我们管辖的那一方会怎样」。
 */
function ordinarySave(target: string, text: string): 'SAVED' | 'BLOCKED' {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  [IO.File]::WriteAllText('${target.replace(/'/g, "''")}', '${text}' + [char]10)`,
    '  "SAVED"',
    '} catch { "BLOCKED" }',
  ].join('\n');
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  // 只认 ASCII 的结论词：本机控制台代码页会把非 ASCII 输出弄成乱码，
  // 而乱码里判 `includes` 会让一个失败的保存看起来像成功。
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.includes('SAVED') ? 'SAVED' : 'BLOCKED';
}

describeWindows('LWB-027 真 NTFS：受保护的既有文件写入', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  let blobs: BlobStore;
  let opened: ReturnType<typeof openDatabase> | undefined;
  let repos: Repositories;
  let seq = 0;

  const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-write-path-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    if (opened !== undefined) closeDatabase(opened.db);
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  interface Rig {
    readonly dir: string;
    readonly relative: string;
    readonly plan: ExecutionPlan;
    readonly change_id: string;
    readonly report: () => Promise<ApplyReport>;
    readonly abs: (relative: string) => string;
  }

  /**
   * 搭一套**真的**工作区 + 修改集 + 计划。
   *
   * 身份（卷序列号 / 文件索引）由护栏自己给出，本文件不自己算一份 ——
   * 否则验的是测试写的第二个实现，而不是交付物。
   */
  async function rig(seed: string, options: { readonly target?: string } = {}): Promise<Rig> {
    if (opened !== undefined) closeDatabase(opened.db);
    const dir = path.join(sandbox, seed);
    await mkdir(dir, { recursive: true });

    const relative = options.target ?? 'notes.txt';
    const targetAbs = path.join(dir, relative.split('/').join(path.sep));
    const before = Buffer.from(`before-${seed}\n`, 'utf8');
    // 带 BOM 与 CRLF：写入必须逐字节保真，而不是「看起来一样」。
    const after = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`after-${seed}\r\nsecond line\r\n`, 'utf8'),
    ]);
    await writeFile(targetAbs, before);

    opened = openDatabase({ path: ':memory:' });
    repos = new Repositories(opened.db);
    blobs = new BlobStore({
      objectsRoot: path.join(sandbox, `${seed}-objects`),
      registry: repos.blobs,
      newId: () => nextId('blob'),
    });

    const volume = await backend.statVolume({ path: dir });
    assert.equal(volume.ok, true, `statVolume 失败：${JSON.stringify(volume)}`);
    if (isWinfsError(volume)) throw new Error('上面一行已经断言过');

    const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };
    const read = await backend.readFileGuarded({ ...ref, relative_path: relative });
    assert.equal(read.ok, true, `读取基线失败：${JSON.stringify(read)}`);
    if (isWinfsError(read)) throw new Error('上面一行已经断言过');

    repos.connections.create({
      id: CONNECTION,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: '真盘连接',
      enabled: true,
    });
    repos.workspaces.create({
      id: WORKSPACE,
      alias: '真盘工作区',
      kind: 'directory',
      canonical_root: dir,
      volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    const generation = repos.workspaces.requireById(WORKSPACE).generation;

    const beforeBlob = await blobs.putAndRegister(before, { id: nextId('blob') });
    const afterBlob = await blobs.putAndRegister(after, { id: nextId('blob') });
    const item: ChangeItemInput = {
      id: nextId('ci'),
      path: relative,
      op: 'edit_text',
      // 磁盘上那个对象的真实身份与真实哈希 —— 批准绑定的就是它们。
      base_file_id: read.identity.file_id,
      base_sha256: read.sha256,
      target_sha256: afterBlob.put.sha256,
      old_blob_id: beforeBlob.id,
      new_blob_id: afterBlob.id,
      // 目标字节的实际形态：带 BOM 的 UTF-8、CRLF。
      encoding: 'utf-8-bom',
      bom: true,
      newline: 'crlf',
      added_lines: 2,
      removed_lines: 1,
    };

    const digest = canonicalChangeDigest({
      contract_version: CONTRACT,
      policy_version: POLICY_VERSION,
      root_generation: generation,
      workspace_id: WORKSPACE,
      files: [
        {
          path: relative,
          op: 'edit_text',
          before_sha256: item.base_sha256 ?? null,
          before_size: beforeBlob.put.size,
          after_sha256: item.target_sha256,
          after_size: afterBlob.put.size,
          encoding: 'utf-8-bom',
          newline: 'crlf',
          bom: true,
        },
      ],
    });

    const nowMs = Date.now();
    const change = repos.changes.create({
      id: nextId('chg'),
      owner_connection_id: CONNECTION,
      workspace_id: WORKSPACE,
      root_generation: generation,
      policy_version: POLICY_VERSION,
      contract_version: CONTRACT,
      digest,
      summary: `真盘摘要 ${seed}`,
      expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
      items: [item],
    });
    const queued = approveAndQueue({
      repos,
      change_id: change.id,
      digest,
      actor: 'console:真盘测试',
      now: new Date(nowMs).toISOString(),
      idempotency_key: `key-${seed}`,
    });

    const outcome = claimForExecution(
      {
        repos,
        executor_id: EXECUTOR_ID,
        holder: HOLDER,
        probe: deadProbe,
        lease_ms: 30_000,
        now: Date.now,
      },
      change.id,
    );
    assert.equal(outcome.kind, 'claimed', `认领未成功：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'claimed') throw new Error('上面一行已经断言过');

    void queued;
    const applier = createNativeApplier({ repos, ops: backend, blobs });
    return {
      dir,
      relative,
      plan: outcome.plan,
      change_id: change.id,
      report: () => applier(outcome.plan, new AbortController().signal),
      abs: (r: string) => path.join(dir, r.split('/').join(path.sep)),
    };
  }

  it('验收 2：回读哈希与已批准的新哈希一致，才报告该文件写成；字节逐字保真', async () => {
    const r = await rig('accept2');
    const item = repos.changes.items(r.change_id)[0]!;

    const report = await r.report();

    assert.match(appliedDetail(report), /已写入并核验 1/);
    const onDisk = await readFile(r.abs(r.relative));
    assert.equal(sha256(onDisk), item.target_sha256, '磁盘字节必须等于被批准的目标哈希');
    // 长度也要对上：哈希相同但长度不同是不可能的，而长度对不上却哈希相同
    // 是不可能的反面 —— 真正要防的是「回读拿到的是缓存里的旧字节」，
    // 长度与它指向的快照登记尺寸一致是这条路走通了的旁证。
    assert.equal(onDisk.length, repos.blobs.requireById(item.new_blob_id!).size);
    // BOM 与 CRLF 逐字节保真：不是「解码后一样」。
    assert.deepEqual([...onDisk.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须原样写入');
    assert.equal(onDisk.toString('utf8').includes('\r\n'), true, 'CRLF 必须保留');
    // 适配器不写终局：它停在 APPLYING，终局由协调器的 `#finalize` 落。
    assert.equal(repos.changes.requireById(r.change_id).state, 'APPLYING');
  });

  it('验收 1 前半：检查前被原地改写 ⇒ 冲突，改的人的内容原样留着', async () => {
    const r = await rig('accept1a');
    // 「VS Code 保存了」：同一个对象、原地写入，文件 ID 不变、内容变了。
    const theirs = Buffer.from('编辑器保存的内容\n', 'utf8');
    await writeFile(r.abs(r.relative), theirs);

    const report = await r.report();

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /磁盘内容已不是被批准的基线/);
    const after = await readFile(r.abs(r.relative));
    assert.equal(after.equals(theirs), true, '我们未写入任何字节，别人的内容必须原样');
  });

  it('验收 1 前半：检查前被删除重建 ⇒ 冲突（批准的是那一个对象，不是那个位置）', async () => {
    const r = await rig('accept1b');
    // 编辑器「原子保存」的典型做法：写临时文件再替换。替换之后路径同名，
    // 而文件 ID 已经变了 —— 只比哈希的实现会在这里放行。
    const theirs = Buffer.from('替换后的新对象\n', 'utf8');
    await rm(r.abs(r.relative));
    await writeFile(r.abs(r.relative), theirs);

    const report = await r.report();

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /目标对象已不是被批准的那一个/);
    assert.equal((await readFile(r.abs(r.relative))).equals(theirs), true);
  });

  it('验收 1 后半：写入路径那组共享标志挡得住普通竞争保存，且我们不绕开它', async () => {
    const r = await rig('accept1c');
    const abs = r.abs(r.relative);

    // ① 没人持有的时候，普通保存是通的 —— 否则下面的「被挡」可能只是
    //    文件本来就不能写（只读、ACL 之类），而那条结论就不是共享模式的功劳。
    assert.equal(ordinarySave(abs, 'before-hold'), 'SAVED');
    // ① 自己动过盘，因此「基准」必须在 ① 之后取。拿 ① 之前的字节去比对，
    // 验的就成了 ① 写没写成，与共享模式无关。
    const baseline = await readFile(abs);
    assert.equal(baseline.toString('utf8'), 'before-hold\n');

    const helper = new ResidentHelper();
    await helper.start();
    try {
      const volume = await backend.statVolume({ path: r.dir });
      assert.equal(volume.ok, true);
      if (isWinfsError(volume)) throw new Error('上面一行已经断言过');
      const held = await helper.call({
        // 护栏自己的持有操作：同一个 `Open-Guarded`、同一组标志。
        // 它是 spike 专用，因此刻意不在 `WinfsOps` 里 —— 这里用底层客户端。
        op: 'holdHandle',
        root_path: r.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: r.relative,
        access: 'write',
        share_mode: 'read',
      });
      assert.equal(held['ok'], true, `holdHandle 失败：${JSON.stringify(held)}`);

      // ② 普通竞争保存被共享模式挡住，而且文件内容没有变。
      assert.equal(ordinarySave(abs, 'editor-competes'), 'BLOCKED', '持有期间普通保存必须被拒');
      assert.equal((await readFile(abs)).equals(baseline), true, '被拒的保存不得留下半个字节');

      // ③ 反方向：我们自己的写入路径同样受共享规则约束，返回错误而**不**
      //    降级成普通文件 API。这一条是「占用一律返回错误」的正面证据。
      const guarded = await backend.writeFileGuarded({
        root_path: r.dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        relative_path: r.relative,
        // 传**当前**哈希：若传一个过期的基线，那次失败就可能来自基线核对，
        // 于是「被占用」这条结论便没有了证据。要让它只能栽在打开这一步。
        expected_sha256: sha256(baseline),
        content_base64: Buffer.from('我们自己的写入\n', 'utf8').toString('base64'),
      });
      assert.equal(guarded.ok, false, '被占用时我们的写入也必须失败');
      if (isWinfsError(guarded)) {
        assert.equal(guarded.code, 'FILE_BUSY');
        assert.equal(guarded.win32_error, 32, '共享冲突的 Win32 码是 32');
      }
    } finally {
      await helper.stop();
    }

    // ④ 持有者一退出，保存立刻恢复 —— 挡住它的是句柄，不是权限。
    assert.equal(ordinarySave(abs, 'after-release'), 'SAVED');
  });
});
