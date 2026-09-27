/**
 * LWB-028 真 NTFS 验收：不覆盖的文本文件创建。
 *
 * ## 与单元测试的分工
 *
 * `tests/unit/executor-native-adapter.test.ts` 的 E 组用假护栏穷尽**分类**：
 * 创建这条路上每一种「护栏说了什么」该报成冲突、拒绝，还是必须进恢复。
 *
 * 本文件反过来：**只有少数几条路径**，但每一个环节都是真的 —— 真 NTFS、
 * 真 `PowerShellWinfsBackend`、真的 `CreateFileW` 与 `CREATE_NEW`、真 SQLite、
 * 真快照库、真 `claimForExecution`。它回答的是「这套东西接在真操作系统上
 * 还成不成立」：
 *
 *  - 验收 1：检查不存在后被别人创建的文件不会被覆盖（两个方向都测：
 *    名字**在阶段 A 之前**就被占着，以及**在阶段 A 与阶段 C 之间**被抢先）；
 *  - 验收 2：回读哈希等于已批准的新哈希，才报告新文件建成；
 *  - 验收 3：不隐式创建父目录、不修改 ACL、不设置任何属性。
 *
 * ## 「判定与创建是同一次系统调用」这句在真盘上怎么证
 *
 * 从**外面**是证不了的 —— 那正是它的意思。能证的是它的两个可观测后果：
 *
 *  1. 那个名字已经被占着时，`CREATE_NEW` 失败（`FILE_VERSION_CONFLICT` /
 *     Win32 183，即 `ERROR_ALREADY_EXISTS`），而**别人的字节一个都没动**；
 *  2. 阶段 A 与阶段 C 之间被抢先时，失败来自 `CREATE_NEW` 而不是来自
 *     「读到的内容与预期不符」—— 后者才是「先检查再创建」那种实现在
 *     这个窗口里会给出的答案。
 *
 * 第 2 条的装置（`withRacer`）必须说清楚：它把**抢跑**插在护栏边界上
 * （`createFileGuarded` 一进来就往磁盘上放那个文件），除此之外一切都是真的。
 * 这是本文件唯一一处非生产代码，而它插的位置正是验收标准问的那个窗口。
 * 为什么不用 `Object.create(backend)` 转发：`PowerShellWinfsBackend` 用的是
 * 私有字段（`#helper`），而私有字段会被 `this` 的品牌检查挡住 ——
 * 转发必须显式一个一个方法写出来。
 *
 * ## 未执行项
 *
 * 「新文件**部分**写入 / 进程在创建与刷盘之间退出」在真盘上**没有**构造
 * 出来：`Op-CreateFileGuarded` 是一次请求内的 建→写→刷→回读，中间没有可以
 * 从外面插进去的窗口，而本机也没有故障注入或可安全填满的卷。这一条在
 * `docs/evidence/lwb-028/` 里逐条标了 `NOT_RUN`，没有与 `PASS` 合并。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, isBridgeError, LIMITS } from '@lwb/contracts';
import { claimForExecution, createNativeApplier } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput } from '@lwb/persistence';
import { isWinfsError, PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const CONNECTION = 'conn_create';
const WORKSPACE = 'ws_create';
const PRINCIPAL = 'principal_create';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_create';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：每个用例的地都是空的。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本用例不该问进程探针');
  },
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

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

/** 起一次 pwsh 并取回它的标准输出。只用于**独立于护栏**的观察。 */
function pwsh(script: string): string {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

/**
 * 一个文件的 ACL，按**与路径无关**的形式摘要出来。
 *
 * 比 `icacls` 的原始文本可靠：换行折行与路径长度会让两份逐字相同的 ACL
 * 看起来不一样，而这里只取「谁 | 什么权限 | 允许还是拒绝 | 是不是继承来的」。
 * 输出里可能带非 ASCII 的账户名（本机控制台代码页会把它弄成乱码），
 * 因此**只拿两份摘要互相比**，不去断言任何具体文本。
 */
function aclSummary(target: string): string {
  return pwsh(
    [
      '$ErrorActionPreference = "Stop"',
      `$acl = Get-Acl -LiteralPath ${quote(target)}`,
      '"OWNER=" + $acl.Owner',
      '$acl.Access | ForEach-Object { $_.IdentityReference.ToString() + "|" + $_.FileSystemRights.ToString() + "|" + $_.AccessControlType.ToString() + "|" + $_.IsInherited.ToString() }',
    ].join('\n'),
  ).trim();
}

/** 文件属性（`Archive` / `ReadOnly` / `Hidden` …）——「没设置过任何属性」的证据。 */
function attributesOf(target: string): string {
  return pwsh(
    ['$ErrorActionPreference = "Stop"', `(Get-Item -LiteralPath ${quote(target)}).Attributes.ToString()`].join(
      '\n',
    ),
  ).trim();
}

describeWindows('LWB-028 真 NTFS：不覆盖的文本文件创建', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  let blobs: BlobStore;
  let opened: ReturnType<typeof openDatabase> | undefined;
  let repos: Repositories;
  let seq = 0;

  const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-create-path-'));
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
    readonly abs: (relative: string) => string;
    readonly report: (ops?: WinfsOps) => Promise<ApplyReport>;
  }

  /**
   * 搭一套**真的**工作区 + 修改集 + 计划，目标是一个**还不存在**的文件。
   *
   * 身份（卷序列号 / 文件索引）由护栏自己给出；目标字节来自真快照库。
   * 基线字段全为 `null` —— 那正是创建与改写的方向差别，也是状态库触发器
   * 对 `create_text` 的硬性要求。
   */
  async function createRig(
    seed: string,
    options: { readonly target?: string; readonly parent_exists?: boolean } = {},
  ): Promise<Rig> {
    if (opened !== undefined) closeDatabase(opened.db);
    const dir = path.join(sandbox, seed);
    await mkdir(dir, { recursive: true });

    const relative = options.target ?? 'created.txt';
    const targetAbs = path.join(dir, relative.split('/').join(path.sep));
    // 带 BOM 与 CRLF：写入必须逐字节保真，而不是「看起来一样」。
    const after = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`created-${seed}\r\nsecond line\r\n`, 'utf8'),
    ]);
    if (options.parent_exists !== false) {
      await mkdir(path.dirname(targetAbs), { recursive: true });
    }
    // 刻意**不**创建目标本身：这是一次创建。

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

    const afterBlob = await blobs.putAndRegister(after, { id: nextId('blob') });
    const item: ChangeItemInput = {
      id: nextId('ci'),
      path: relative,
      op: 'create_text',
      // 一次创建不基于任何已存在的对象 —— 三个基线字段全是 null。
      base_file_id: null,
      base_sha256: null,
      target_sha256: afterBlob.put.sha256,
      old_blob_id: null,
      new_blob_id: afterBlob.id,
      encoding: 'utf-8-bom',
      bom: true,
      newline: 'crlf',
      added_lines: 2,
      removed_lines: 0,
    };

    const digest = canonicalChangeDigest({
      contract_version: CONTRACT,
      policy_version: POLICY_VERSION,
      root_generation: generation,
      workspace_id: WORKSPACE,
      files: [
        {
          path: relative,
          op: 'create_text',
          before_sha256: null,
          before_size: 0,
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
      summary: `真盘创建摘要 ${seed}`,
      expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
      items: [item],
    });
    approveAndQueue({
      repos,
      change_id: change.id,
      digest,
      actor: 'console:真盘测试',
      now: new Date(nowMs).toISOString(),
      idempotency_key: `key-${seed}`,
    });

    const outcome = claimForExecution(
      { repos, executor_id: EXECUTOR_ID, holder: HOLDER, probe: deadProbe, lease_ms: 30_000, now: Date.now },
      change.id,
    );
    assert.equal(outcome.kind, 'claimed', `认领未成功：${JSON.stringify(outcome)}`);
    if (outcome.kind !== 'claimed') throw new Error('上面一行已经断言过');

    const applier = createNativeApplier({ repos, ops: backend, blobs });
    return {
      dir,
      relative,
      plan: outcome.plan,
      change_id: change.id,
      abs: (r: string) => path.join(dir, r.split('/').join(path.sep)),
      report: (ops: WinfsOps = backend) =>
        createNativeApplier({ repos, ops, blobs })(outcome.plan, new AbortController().signal),
    };
  }

  /**
   * 把**抢跑**插在护栏边界上：`createFileGuarded` 一进来，别人先把那个名字
   * 建出来，然后照常交给真护栏。
   *
   * 这是本文件唯一一处非生产代码，而它插的位置正是验收标准第一条问的那个
   * 窗口。转发必须显式写出每一个方法：`PowerShellWinfsBackend` 用私有字段
   * （`#helper`），而私有字段的品牌检查会挡住 `Object.create` 那种转发。
   */
  function withRacer(onRace: () => Promise<void>): { ops: WinfsOps; arm: () => void } {
    let armed = false;
    return {
      arm: () => {
        armed = true;
      },
      ops: {
        capability: () => backend.capability(),
        statVolume: (req) => backend.statVolume(req),
        validatePath: (req) => backend.validatePath(req),
        resolvePath: (req) => backend.resolvePath(req),
        readFileGuarded: (req) => backend.readFileGuarded(req),
        writeFileGuarded: (req) => backend.writeFileGuarded(req),
        listDirectory: (req) => backend.listDirectory(req),
        createFileGuarded: async (req) => {
          if (armed) {
            armed = false;
            await onRace();
          }
          return backend.createFileGuarded(req);
        },
      },
    };
  }

  it('验收 2：新文件建出来，磁盘字节等于已批准的目标哈希（BOM 与 CRLF 逐字节保真）', async () => {
    const r = await createRig('accept2');
    const item = repos.changes.items(r.change_id)[0]!;
    const before = await readdir(r.dir);

    const report = await r.report();

    assert.match(appliedDetail(report), /已写入并核验 1/);
    const onDisk = await readFile(r.abs(r.relative));
    assert.equal(sha256(onDisk), item.target_sha256, '磁盘字节必须等于被批准的目标哈希');
    assert.equal(onDisk.length, repos.blobs.requireById(item.new_blob_id).size);
    assert.deepEqual([...onDisk.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须原样写入');
    assert.equal(onDisk.toString('utf8').includes('\r\n'), true, 'CRLF 必须保留');
    // 适配器不写终局：它停在 APPLYING，终局由协调器的 `#finalize` 落。
    assert.equal(repos.changes.requireById(r.change_id).state, 'APPLYING');
    // 工作区根下**只多了一个**条目，且就是那一个 —— 创建不许顺手带出别的东西。
    assert.deepEqual(await readdir(r.dir), [...before, 'created.txt'].sort());
  });

  it('护栏回执：readback_ok 与 flushed 同时为真，独立回读得到同一个哈希', async () => {
    const r = await createRig('receipt');
    const item = repos.changes.items(r.change_id)[0]!;
    const volume = await backend.statVolume({ path: r.dir });
    if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);
    const ref = { root_path: r.dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };

    const created = await backend.createFileGuarded({
      ...ref,
      relative_path: r.relative,
      content_base64: Buffer.from('护栏直调\n', 'utf8').toString('base64'),
    });

    assert.equal(created.ok, true, `创建失败：${JSON.stringify(created)}`);
    if (isWinfsError(created)) throw new Error('上面一行已经断言过');
    assert.equal(created.readback_ok, true, '回读与目标逐字节相同');
    assert.equal(created.flushed, true, '刷盘必须完成');
    assert.equal(created.after_sha256, created.target_sha256);
    assert.equal(created.canonical_relative_path, r.relative);
    assert.equal(created.bytes_written, Buffer.byteLength('护栏直调\n'));

    // 独立回读：另起一次护栏调用，不复用创建那次的返回值。
    const reread = await backend.readFileGuarded({ ...ref, relative_path: r.relative });
    assert.equal(reread.ok, true);
    if (isWinfsError(reread)) throw new Error('上面一行已经断言过');
    assert.equal(reread.sha256, created.after_sha256, '独立回读必须与回执一致');
    assert.notEqual(reread.sha256, item.target_sha256, '这一条路上写的是护栏直调的字节');
  });

  it('验收 1：目标已被别人占着 ⇒ CREATE_NEW 拒绝（Win32 183），那份字节原样还在', async () => {
    const r = await createRig('occupied');
    const volume = await backend.statVolume({ path: r.dir });
    if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);
    const ref = { root_path: r.dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };
    const theirs = Buffer.from('别人先放在那里的内容\n', 'utf8');
    await writeFile(r.abs(r.relative), theirs);

    const created = await backend.createFileGuarded({
      ...ref,
      relative_path: r.relative,
      content_base64: Buffer.from('我们想创建的内容\n', 'utf8').toString('base64'),
    });

    assert.equal(created.ok, false, '名字被占着时创建必须失败');
    if (isWinfsError(created)) {
      assert.equal(created.code, 'FILE_VERSION_CONFLICT');
      // 实测：本机（Windows 11 26200 / NTFS）`CREATE_NEW` 撞上已有文件返回
      // **80**（`ERROR_FILE_EXISTS`）。183（`ERROR_ALREADY_EXISTS`）是同一个
      // 映射表里的兄弟码 —— 两条都映射到 `FILE_VERSION_CONFLICT`，而判据
      // 锚在那个**映射后的码**上（它才是护栏承诺的东西），原始码只作记录。
      assert.equal(created.win32_error, 80);
      // 刻意**没有** touched：那才是「对象已经被创建出来了」的字段
      // （LWB-029 把它从 actual_state 上分出来 —— 观测是尽力而为的，
      // 「动过但没观测到」必须能与「没动过」区分开）。这一次一个对象
      // 都没被创建，因此两个字段都不该出现。
      assert.equal(created.touched, undefined);
      assert.equal(created.actual_state, undefined);
    }
    assert.equal((await readFile(r.abs(r.relative))).equals(theirs), true, '别人的字节一个都不能动');
  });

  it('验收 1：大小写别名碰撞 ⇒ 同样拒绝（NTFS 大小写不敏感）', async () => {
    const r = await createRig('alias', { target: 'Case.txt' });
    const volume = await backend.statVolume({ path: r.dir });
    if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);
    const ref = { root_path: r.dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };
    const theirs = Buffer.from('别人用另一种大小写建的\n', 'utf8');
    await writeFile(path.join(r.dir, 'case.txt'), theirs);

    const created = await backend.createFileGuarded({
      ...ref,
      relative_path: 'Case.txt',
      content_base64: Buffer.from('x\n', 'utf8').toString('base64'),
    });

    assert.equal(created.ok, false, '大小写不同但是同一个名字位置');
    if (isWinfsError(created)) {
      assert.equal(created.code, 'FILE_VERSION_CONFLICT');
      // 与精确同名那一格是**同一个**码：大小写别名在 NTFS 上不是另一个名字。
      assert.equal(created.win32_error, 80);
    }
    // 只留下那一个对象，没有多出一个 `Case.txt`。
    assert.deepEqual(await readdir(r.dir), ['case.txt']);
    assert.equal((await readFile(path.join(r.dir, 'case.txt'))).equals(theirs), true);
  });

  it('验收 1：检查之后、创建之前被别人抢先 ⇒ 未改动地退回，抢先者的字节原样还在', async () => {
    const r = await createRig('raced');
    const theirs = Buffer.from('就在那个窗口里挤进来的\n', 'utf8');
    const racer = withRacer(async () => {
      await writeFile(r.abs(r.relative), theirs);
    });
    racer.arm();

    const report = await r.report(racer.ops);

    // 这个窗口里的失败，实话是：**一个对象都没被创建**（失败来自
    // `CREATE_NEW` 本身，护栏根本没进破坏性区域）。LWB-028 时这一格只能
    // 抛成待恢复，因为那时还没有「什么都没做」这个名字可报；LWB-029 把
    // 逐条目终局折出来之后，它落在 `rolled_back` 上 —— 盘上没有本次执行
    // 的字节，这是可以被独立证实的一句话，而不是一句必须叫人来认的猜测。
    assert.equal(report.kind, 'rolled_back');
    if (report.kind !== 'rolled_back') throw new Error('上面一行已经断言过');
    assert.match(report.detail, /未改动/);
    assert.match(report.detail, /FILE_VERSION_CONFLICT/);

    assert.equal((await readFile(r.abs(r.relative))).equals(theirs), true, '抢先者的字节一个都不能动');
    // 只留下抢先者那一个对象，没有多出别的。
    assert.deepEqual(await readdir(r.dir), [r.relative]);
    // 执行意图已经记在账上：适配器停在 APPLYING，终局由协调器的
    // `#finalize` 落 —— 本用例只跑到适配器，所以这里还是 APPLYING。
    assert.equal(repos.changes.requireById(r.change_id).state, 'APPLYING');
  });

  it('验收 3：缺父目录 ⇒ 冲突；那一级目录在磁盘上依然不存在', async () => {
    const r = await createRig('noparent', { target: 'missing-dir/new.txt', parent_exists: false });

    const report = await r.report();

    assert.equal(report.kind, 'conflict');
    if (report.kind !== 'conflict') return;
    assert.match(report.detail, /父目录 missing-dir 不存在/);
    assert.match(report.detail, /不隐式创建父目录/);
    // 磁盘上的事实：那一级目录没有被我们补出来，一个字节也没写。
    await assert.rejects(() => stat(path.join(r.dir, 'missing-dir')));
    assert.deepEqual(await readdir(r.dir), []);
    assert.equal(repos.changes.requireById(r.change_id).state, 'VALIDATING', '没有写入就不该记下执行意图');
  });

  it('验收 3：ACL 与属性都是系统给的默认值 —— 与普通方式建的同目录文件逐项相同', async () => {
    const r = await createRig('acl');

    assert.match(appliedDetail(await r.report()), /已写入并核验 1/);

    // 对照组：用**普通方式**在同一个目录里建一个文件。护栏建出来的那个
    // 必须与它逐项相同 —— 不同就说明我们动过 ACL 或属性（继承之外的东西）。
    const control = path.join(r.dir, 'control.txt');
    await writeFile(control, Buffer.from('control\n', 'utf8'));
    const created = r.abs(r.relative);

    assert.equal(attributesOf(created), attributesOf(control), '属性必须与普通建的文件相同');
    assert.equal(aclSummary(created), aclSummary(control), 'ACL 必须与普通建的文件相同');
    // 目录那一侧同样不许被改：父目录就是工作区根，它的 ACL 也得原样。
    const parentControl = path.join(sandbox, 'acl-parent-control');
    await mkdir(parentControl, { recursive: true });
    assert.equal(aclSummary(r.dir), aclSummary(parentControl), '父目录的 ACL 不得被修改');

    // 「设置执行权限」在 NTFS 上没有对应的位；本文件能核对的是**没有任何
    // 属性被设置**（上面那条）与**没有显式 ACE**（下面这条）—— 两者合起来
    // 就是「护栏只调用了 CreateFileW，没有调用任何改属性的 API」。
    const explicit = pwsh(
      [
        '$ErrorActionPreference = "Stop"',
        `(Get-Acl -LiteralPath ${quote(created)}).Access | Where-Object { -not $_.IsInherited } | Measure-Object | Select-Object -ExpandProperty Count`,
      ].join('\n'),
    ).trim();
    assert.equal(explicit, '0', `不该有非继承来的 ACE，实际有 ${explicit} 条`);
  });
});
