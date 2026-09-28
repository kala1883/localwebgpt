/**
 * LWB-030 真 NTFS 验收：启动恢复与未知结果协调。
 *
 * ## 与单元测试的分工
 *
 * `tests/unit/recovery-verdict.test.ts` 与 `recovery-plan.test.ts` 穷尽**判定表**
 * 与**折叠表**（纯函数、几百格）。`tests/unit/recovery-persistence.test.ts`
 * 验状态库那一层（迁移 v7、一次性、摘要绑定）。
 *
 * 本文件反过来：**只有少数几条主线**，但每一个环节都是真的 —— 真 NTFS、
 * 真 `PowerShellWinfsBackend`、真 `CreateFileW`、真 SQLite **文件**（不是
 * `:memory:`，因为「重启」是本文件的主角）、真快照库、真 `claimForExecution`、
 * 真 `createNativeApplier`。
 *
 * ## 「重启」在这台机器上怎么演
 *
 * 从测试里杀掉自己再复活是做不到的。能做的是**把那个进程留下的一切原样
 * 交给下一个**：关掉库连接，再用**同一个库文件**打开一个新的 `Repositories`，
 * 然后跑 `RecoveryService.sweepStartup()`。上一个进程留下的状态库、快照库、
 * 磁盘这三样，一个字节都没被整理过 —— 而它们正是恢复要读的全部输入。
 * 本文件所有断言的立足点就是这个：如果它不成立，测的就不是恢复。
 *
 * 崩溃点是**按验收标准**挑的：`apply.ts` 落完盘就停在 `APPLYING`（它不写
 * 终局，终局由协调器的 `#finalize` 落，见 LWB-027/028 的证据）。于是
 * 「写得完、应答丢」这个窗口就等于「跑完 applier，不跑协调器」——
 * 它不是一个模拟出来的窗口，它就是那个窗口本身。
 *
 * ## 三条验收标准各自长什么样
 *
 *  - **验收 1**（写入完成但应答丢失后，重启查询收敛为实际已达状态，
 *    **不重复修改**）：跑完 applier → 重启 → 收敛为 `APPLIED` 且
 *    `recovered = true`；而「不重复修改」的证据是**文件对象的身份、
 *    内容哈希与最后写入时刻三者都没变** —— 只比内容是不够的，一次
 *    「把同样的字节再写一遍」也会让内容不变。
 *  - **验收 2**（用户在崩溃后继续编辑时不被自动恢复覆盖）：崩溃之后
 *    用户在同一个文件上继续编辑 → 重启 → 判定为第三种内容，**留在人工**，
 *    而且用户那一次编辑的字节与写入时刻一个都没被动过。
 *  - **验收 3**（数据库/快照不完整时默认暂停，不能当成新安装清空历史）：
 *    库文件坏掉 → `openDatabase` 拒绝、且不凭空建一个新库；快照被删掉 →
 *    需要它那一步（收场写回）**停下**，`repaired = 0`、一个字节不写、
 *    状态不动。后半条走的是 `repair` 而不是扫描 —— 因为扫描根本不读
 *    快照（判定表全部建立在**对工作区的观测**上，见 `verdict.ts` 的文件头），
 *    而快照真正被要用的地方是「把已经写下去的那些收回来」。
 *
 * ## 未执行项
 *
 *  - 「写到一半进程被杀死」在真盘上没有构造：`writeFileGuarded` 是一次
 *    请求内的 校验→截断→写入→刷盘→回读，中间没有可以从外面插进去的窗口，
 *    而本机没有故障注入。这一条在 `docs/evidence/lwb-030/` 里标了 `NOT_RUN`。
 *  - 「跨卷」「只读卷」同 LWB-027/028，未构造。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore, resolveStorageRef } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import type { ChangeDigestFile } from '@lwb/changes';
import { CONTRACT_VERSION, isBridgeError, LIMITS } from '@lwb/contracts';
import type { ChangeOp } from '@lwb/contracts';
import { claimForExecution, createNativeApplier, ITEM_STAGE } from '@lwb/executor';
import type { ApplyReport, ExecutionPlan } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput } from '@lwb/persistence';
import { RecoveryService } from '@lwb/recovery';
import { isWinfsError, PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsOps } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const CONNECTION = 'conn_rec';
const WORKSPACE = 'ws_rec';
const PRINCIPAL = 'principal_rec';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_rec';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：每个用例的地都是新开的一块。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本用例不该问进程探针');
  },
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * 文件的「身份 + 内容 + 最后写入时刻」。
 *
 * 后两项是这一份指纹存在的理由：只比内容的话，一次「把同样的字节再写
 * 一遍」也会通过 —— 而验收 1 要求的正是**没有写**。
 */
async function fingerprint(target: string): Promise<{
  readonly file_id: string;
  readonly sha256: string;
  readonly mtime_ms: number;
  readonly size: number;
}> {
  const info = await stat(target);
  return {
    file_id: `${info.dev.toString(16)}:${info.ino.toString(16)}`,
    sha256: sha256(await readFile(target)),
    mtime_ms: info.mtimeMs,
    size: info.size,
  };
}

describeWindows('LWB-030 真 NTFS：启动恢复与未知结果协调', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  let blobSeq = 0;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-recovery-'));
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏后端不可用：${capability.resolved_backend_reason}`);
  });

  after(async () => {
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  interface FileSpec {
    /** 工作区内的相对路径（`/` 分隔，与条目里的写法一致）。 */
    readonly relative: string;
    readonly before: string;
    readonly after: string;
    readonly op?: ChangeOp;
  }

  interface Rig {
    readonly dir: string;
    readonly dbPath: string;
    readonly objectsRoot: string;
    readonly volume_id: string;
    readonly root_file_id: string;
    readonly specs: readonly FileSpec[];
    readonly change_id: string;
    readonly operation_id: string;
    readonly plan: ExecutionPlan;
    readonly abs: (relative: string) => string;
  }

  /**
   * 搭一套**真的**工作区：真目录、真文件、真身份、真摘要、真批准、真认领。
   *
   * 身份（`base_file_id`）取自护栏在真文件上给出的文件索引 —— 不是编的。
   * 这一点很要紧：判定表里「同一个对象」那一格全靠它，而编一个身份会让
   * 那一格永远为假，测出来的就只剩「身份不明」那一条。
   */
  async function buildRig(seed: string, specs: readonly FileSpec[]): Promise<Rig> {
    const dir = path.join(sandbox, seed);
    const objectsRoot = path.join(sandbox, `${seed}-objects`);
    const dbPath = path.join(sandbox, `${seed}.db`);
    await mkdir(dir, { recursive: true });

    for (const spec of specs) {
      const target = path.join(dir, spec.relative.split('/').join(path.sep));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(spec.before, 'utf8'));
    }

    const opened = openDatabase({ path: dbPath });
    try {
      const repos = new Repositories(opened.db);
      const blobs = new BlobStore({
        objectsRoot,
        registry: repos.blobs,
        newId: () => `blb_${seed}_${String((blobSeq += 1))}`,
      });

      const volume = await backend.statVolume({ path: dir });
      assert.equal(volume.ok, true, `statVolume 失败：${JSON.stringify(volume)}`);
      if (isWinfsError(volume)) throw new Error('上面一行已经断言过');

      repos.connections.create({
        id: CONNECTION,
        principal_kind: 'model_surface',
        principal_id: PRINCIPAL,
        alias: '恢复用例连接',
        enabled: true,
      });
      repos.workspaces.create({
        id: WORKSPACE,
        alias: '恢复用例工作区',
        kind: 'directory',
        canonical_root: dir,
        volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        policy_version: POLICY_VERSION,
        mode: MODE,
      });
      const generation = repos.workspaces.requireById(WORKSPACE).generation;
      const ref = {
        root_path: dir,
        root_volume_id: volume.volume_id,
        root_file_id: volume.file_id,
      };

      const items: ChangeItemInput[] = [];
      // 可变的累积器，因此是 `ChangeDigestFile[]` 而不是入参那个 `readonly`。
      const files: ChangeDigestFile[] = [];

      for (const spec of specs) {
        const op = spec.op ?? 'edit_text';
        const beforeBytes = Buffer.from(spec.before, 'utf8');
        const afterBytes = Buffer.from(spec.after, 'utf8');
        // 基线身份取自**真文件**，不是编的。
        const observed = await backend.readFileGuarded({ ...ref, relative_path: spec.relative });
        assert.equal(observed.ok, true, `基线读取失败：${JSON.stringify(observed)}`);
        if (isWinfsError(observed)) throw new Error('上面一行已经断言过');

        const oldBlob = await blobs.putAndRegister(beforeBytes);
        const newBlob = await blobs.putAndRegister(afterBytes);
        assert.equal(oldBlob.put.sha256, sha256(beforeBytes), '装置：冻结的基线哈希');
        assert.equal(observed.sha256, oldBlob.put.sha256, '装置：磁盘上的基线就是刚写下去的那一份');

        items.push({
          id: `ci_${seed}_${spec.relative}`,
          path: spec.relative,
          op,
          base_file_id: observed.identity.file_id,
          base_sha256: oldBlob.put.sha256,
          target_sha256: newBlob.put.sha256,
          old_blob_id: oldBlob.id,
          new_blob_id: newBlob.id,
          encoding: 'utf-8',
          bom: false,
          newline: 'lf',
          added_lines: 1,
          removed_lines: 1,
        });
        files.push({
          path: spec.relative,
          op,
          before_sha256: oldBlob.put.sha256,
          before_size: oldBlob.put.size,
          after_sha256: newBlob.put.sha256,
          after_size: newBlob.put.size,
          encoding: 'utf-8',
          newline: 'lf',
          bom: false,
        });
      }

      const digest = canonicalChangeDigest({
        contract_version: CONTRACT,
        policy_version: POLICY_VERSION,
        root_generation: generation,
        workspace_id: WORKSPACE,
        files,
      });

      const nowMs = Date.now();
      const change = repos.changes.create({
        id: `chg_${seed}`,
        owner_connection_id: CONNECTION,
        workspace_id: WORKSPACE,
        root_generation: generation,
        policy_version: POLICY_VERSION,
        contract_version: CONTRACT,
        digest,
        summary: `真盘恢复摘要 ${seed}`,
        expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
        items,
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

      return {
        dir,
        dbPath,
        objectsRoot,
        volume_id: volume.volume_id,
        root_file_id: volume.file_id,
        specs,
        change_id: change.id,
        operation_id: repos.operations.requireByChangeId(change.id).id,
        plan: outcome.plan,
        abs: (relative: string) => path.join(dir, relative.split('/').join(path.sep)),
      };
    } finally {
      closeDatabase(opened.db);
    }
  }

  /** 打开这个用例的那一份现场（库 + 快照库 + 一个服务实例）。调用方负责关库。 */
  function openService(rig: Rig, ops: WinfsOps = backend) {
    const opened = openDatabase({ path: rig.dbPath });
    const repos = new Repositories(opened.db);
    const blobs = new BlobStore({ objectsRoot: rig.objectsRoot, registry: repos.blobs });
    let minted = 0;
    const recovery = new RecoveryService({
      repos,
      ops,
      blobs,
      now: Date.now,
      newId: () => `rec_${rig.change_id}_${String((minted += 1))}`,
    });
    return { opened, repos, blobs, recovery };
  }

  /**
   * 跑一次真实的写盘。**不**跑协调器 —— 那就是「应答丢失」这个窗口。
   *
   * `await` 必须在 `try` 里：写成 `return createNativeApplier(...)(...)`
   * 会让 `finally` 在**写盘开始之前**就关上库连接（写盘是异步的），
   * 而那种失败长得很像「快照取不到」—— 一个诚实的假象，会让人去查快照。
   */
  async function applyWithoutFinalize(rig: Rig, ops: WinfsOps = backend): Promise<ApplyReport> {
    const { opened, repos, blobs } = openService(rig, ops);
    try {
      return await createNativeApplier({ repos, ops, blobs })(
        rig.plan,
        new AbortController().signal,
      );
    } finally {
      closeDatabase(opened.db);
    }
  }

  /**
   * 「重启」：用**同一个库文件**另起一套机器，然后跑启动扫描。
   *
   * 三样东西原样交过去 —— 状态库、快照库、磁盘。上一个「进程」没有留下
   * 任何别的东西，因此这次扫描读到的就是它留下的全部输入。
   */
  async function restartAndSweep(rig: Rig, ops: WinfsOps = backend) {
    const context = openService(rig, ops);
    const report = await context.recovery.sweepStartup();
    return { ...context, report };
  }

  /** 手工阻断这块地（模拟「安全暂停」或一次失联的执行器留下的现场）。 */
  function blockSlot(rig: Rig, reason: string): void {
    const { opened, repos } = openService(rig);
    try {
      const workspace = repos.workspaces.requireById(WORKSPACE);
      repos.write_slots.block({
        volume_id: workspace.volume_id,
        root_file_id: workspace.root_file_id,
        reason,
      });
    } finally {
      closeDatabase(opened.db);
    }
  }

  /** 把快照对象从库里删掉。返回它的绝对路径，便于断言「确实不在了」。 */
  async function deleteSnapshot(rig: Rig, blobId: string): Promise<string> {
    const { opened, repos } = openService(rig);
    let absolute: string;
    try {
      absolute = resolveStorageRef(rig.objectsRoot, repos.blobs.requireById(blobId).storage_ref);
    } finally {
      closeDatabase(opened.db);
    }
    await unlink(absolute);
    return absolute;
  }

  /** 第一条条目的基线快照 id（收场只收回「已达目标」的那几条）。 */
  function firstBaselineBlobId(rig: Rig): string {
    const { opened, repos } = openService(rig);
    try {
      const first = repos.changes.items(rig.change_id).sort((a, b) => a.seq - b.seq)[0];
      assert.ok(first?.old_blob_id, '装置：第一条必须有基线快照');
      return first.old_blob_id;
    } finally {
      closeDatabase(opened.db);
    }
  }

  // -------------------------------------------------------------------------
  // 验收 1
  // -------------------------------------------------------------------------

  it('验收 1：写得完、应答丢 —— 重启收敛为「已应用」，且**一个字节都没有重写**', async () => {
    const rig = await buildRig('accept1', [
      { relative: 'notes/a.txt', before: 'base-a\n', after: 'target-a\n' },
    ]);

    const report = await applyWithoutFinalize(rig);
    assert.equal(report.kind, 'applied', `写盘没成功：${JSON.stringify(report)}`);
    const target = rig.abs('notes/a.txt');
    // 此刻磁盘上已经是目标内容，而状态库里那两行还停在 APPLYING。
    const written = await fingerprint(target);
    assert.equal(written.sha256, sha256(Buffer.from('target-a\n', 'utf8')), '装置：盘上已是目标');

    // ---- 崩溃：上面那个「进程」已经关了库，什么都没被整理过。 ----

    const { opened, repos, report: sweep } = await restartAndSweep(rig);
    try {
      assert.equal(sweep.leftovers, 1, '上一个进程留下一个未终结操作');
      assert.equal(sweep.reconciled.length, 1, '它应当被自动定案');
      assert.equal(sweep.awaiting_manual.length, 0);
      assert.equal(sweep.undecidable.length, 0);

      const operation = repos.operations.requireById(rig.operation_id);
      assert.equal(operation.state, 'APPLIED', '收敛到实际已达的状态');
      // `recovered = true` 记的是「这一次定案是恢复流程做出的」，
      // 不是「我们确定是我们写的」—— 后者从来就不在判定里。
      assert.equal(operation.recovered, true, '协调而来的终局必须被标出来');
      assert.notEqual(operation.finished_at, null, '协调之后它就是一条收场的记录');
      assert.equal(repos.changes.requireById(rig.change_id).state, 'APPLIED');

      // **不重复修改**：内容、对象身份、最后写入时刻三者都没变。
      assert.deepEqual(await fingerprint(target), written, '重启收敛不得碰那个文件');

      // 逐条目回执说的是「核验到目标状态」，而不是「我们写的」。
      const results = repos.operations.itemResults(rig.operation_id);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.state, 'RECOVERED_TARGET');
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('验收 1 补充：收敛之后该工作区**不再**需要恢复（写能力可以放开）', async () => {
    const rig = await buildRig('accept1b', [
      { relative: 'notes/b.txt', before: 'base-b\n', after: 'target-b\n' },
    ]);
    await applyWithoutFinalize(rig);

    const { opened, repos, recovery, report } = await restartAndSweep(rig);
    try {
      assert.equal(report.leftovers, 1);
      assert.equal(
        recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)),
        false,
        '收敛之后这个工作区不该继续被标成待恢复 —— 否则它会永远关着写能力',
      );
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('删除已生效、但删除日志写入前崩溃：重启按“路径不存在”收敛为 APPLIED', async () => {
    const rig = await buildRig('delete-log-crash', [
      { relative: 'notes/deleted.txt', before: '基线内容\n', after: '', op: 'delete_file' },
    ]);
    const context = openService(rig);
    const append = context.repos.journal.append;
    let injected = false;
    context.repos.journal.append = function patched(input: Parameters<typeof append>[0]): number {
      if (input.stage === ITEM_STAGE.deleted && !injected) {
        injected = true;
        throw new Error('故障注入：删除发生后、删除日志提交前进程退出');
      }
      return append.call(context.repos.journal, input);
    };

    try {
      await assert.rejects(
        createNativeApplier({ repos: context.repos, ops: backend, blobs: context.blobs })(
          rig.plan,
          new AbortController().signal,
        ),
        /删除发生后、删除日志提交前进程退出/,
      );
    } finally {
      closeDatabase(context.opened.db);
    }

    assert.equal(injected, true, '故障注入必须落在删除后的日志边界');
    await assert.rejects(readFile(rig.abs('notes/deleted.txt')), { code: 'ENOENT' });

    const restarted = await restartAndSweep(rig);
    try {
      assert.equal(restarted.report.reconciled.length, 1);
      assert.equal(restarted.report.awaiting_manual.length, 0);
      assert.equal(restarted.report.undecidable.length, 0);
      assert.equal(restarted.report.reconciled[0]?.reconciliation.kind, 'APPLIED');
      assert.equal(restarted.repos.operations.requireById(rig.operation_id).state, 'APPLIED');
      const item = restarted.repos.operations.itemResults(rig.operation_id)[0];
      assert.equal(item?.state, 'RECOVERED_TARGET');
      assert.equal(item?.after_sha256, sha256(Buffer.alloc(0)));
    } finally {
      closeDatabase(restarted.opened.db);
    }
  });

  it('混合态授权恢复：崩溃时已删除的条目由完整快照以 CREATE_NEW 还原', async () => {
    const rig = await buildRig('delete-repair', [
      { relative: 'a/deleted.txt', before: '待删除文件的基线\n', after: '', op: 'delete_file' },
      { relative: 'b/untouched.txt', before: '没有动过\n', after: '新目标\n' },
    ]);
    const oldFileId = rig.plan.items.find((entry) => entry.canonical_path === 'a/deleted.txt')?.base_file_id;
    const context = openService(rig);
    const append = context.repos.journal.append;
    let injected = false;
    context.repos.journal.append = function patched(input: Parameters<typeof append>[0]): number {
      if (input.stage === ITEM_STAGE.deleted && !injected) {
        injected = true;
        throw new Error('故障注入：首条删除后退出，后续写尚未开始');
      }
      return append.call(context.repos.journal, input);
    };
    try {
      await assert.rejects(
        createNativeApplier({ repos: context.repos, ops: backend, blobs: context.blobs })(
          rig.plan,
          new AbortController().signal,
        ),
        /首条删除后退出/,
      );
    } finally {
      closeDatabase(context.opened.db);
    }

    assert.equal(injected, true);
    await assert.rejects(readFile(rig.abs('a/deleted.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(rig.abs('b/untouched.txt'), 'utf8'), '没有动过\n');

    const restarted = await restartAndSweep(rig);
    try {
      assert.equal(restarted.report.awaiting_manual.length, 1);
      const inspection = await restarted.recovery.inspect(rig.operation_id);
      assert.equal(inspection?.reconciliation.reason, 'MIXED');
      assert.equal(inspection?.repair.kind, 'ok');
      const grant = await restarted.recovery.authorize({
        operation_id: rig.operation_id,
        actor: 'console:删除恢复验收',
      });
      const result = await restarted.recovery.repair({
        operation_id: rig.operation_id,
        authorization_id: grant.authorization_id,
      });
      assert.equal(result.repaired, 1);
      assert.equal(result.failed, null);
      assert.equal(restarted.repos.operations.requireById(rig.operation_id).state, 'ROLLED_BACK');
      assert.equal(await readFile(rig.abs('a/deleted.txt'), 'utf8'), '待删除文件的基线\n');
      assert.equal(await readFile(rig.abs('b/untouched.txt'), 'utf8'), '没有动过\n');
      assert.notEqual(
        (await fingerprint(rig.abs('a/deleted.txt'))).file_id,
        oldFileId,
        'CREATE_NEW 恢复会生成新文件身份；回读校验按基线哈希确认内容，不能伪称原 ID 未变',
      );
    } finally {
      closeDatabase(restarted.opened.db);
    }
  });

  it('步骤 1 补充：扫描**不重放** —— 重启两次，第二次无事可做，磁盘一个字不动', async () => {
    const rig = await buildRig('idempotent', [
      { relative: 'notes/i.txt', before: 'base\n', after: 'target\n' },
    ]);
    await applyWithoutFinalize(rig);
    const target = rig.abs('notes/i.txt');
    const written = await fingerprint(target);

    const first = await restartAndSweep(rig);
    try {
      assert.equal(first.report.reconciled[0]?.reconciliation.reason, 'ALL_TARGET');
    } finally {
      closeDatabase(first.opened.db);
    }
    assert.deepEqual(await fingerprint(target), written, '第一次扫描不该碰磁盘');

    const second = await restartAndSweep(rig);
    try {
      // 第二次已经无事可做：那个操作不再是未终结的。
      assert.equal(second.report.leftovers, 0);
      assert.equal(second.report.reconciled.length, 0);
      assert.equal(second.report.awaiting_manual.length, 0);
      assert.equal(second.report.undecidable.length, 0);
      assert.equal(second.repos.operations.requireById(rig.operation_id).state, 'APPLIED');
    } finally {
      closeDatabase(second.opened.db);
    }
    assert.deepEqual(await fingerprint(target), written, '第二次扫描同样不该碰磁盘');
  });

  it('步骤 1 补充：定案时解除写阻断 —— 一个「已定案却仍被阻断」的工作区会永远关着写能力', async () => {
    const rig = await buildRig('blockade', [
      { relative: 'notes/bk.txt', before: 'base\n', after: 'target\n' },
    ]);
    await applyWithoutFinalize(rig);
    blockSlot(rig, '上一个执行器在写盘中途失联（本用例构造）');

    // 扫描之前：这块地被标着，因此工作区不可写。
    const before = openService(rig);
    try {
      assert.equal(
        before.recovery.requiresRecovery(before.repos.workspaces.requireById(WORKSPACE)),
        true,
        '地被阻断时该工作区必须报待恢复',
      );
    } finally {
      closeDatabase(before.opened.db);
    }

    const { opened, repos, recovery, report } = await restartAndSweep(rig);
    try {
      assert.equal(report.reconciled.length, 1);
      assert.equal(
        report.reconciled[0]?.blockade.kind,
        'cleared',
        '导致阻断的那个操作已经终结，阻断应当随之解除',
      );
      assert.equal(repos.write_slots.find(rig.volume_id, rig.root_file_id)?.blocked_at, null);
      assert.equal(recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)), false);
    } finally {
      closeDatabase(opened.db);
    }
  });

  // -------------------------------------------------------------------------
  // 验收 2
  // -------------------------------------------------------------------------

  it('验收 2：用户在崩溃之后继续编辑 —— 恢复**不覆盖**，用户的字节与时刻都没被动过', async () => {
    const rig = await buildRig('accept2', [
      { relative: 'notes/live.txt', before: 'base\n', after: 'target\n' },
    ]);
    await applyWithoutFinalize(rig);

    // 用户接着改。这是「崩溃之后」那一次编辑：内容既不是基线也不是目标。
    const live = rig.abs('notes/live.txt');
    await writeFile(live, Buffer.from('用户接着写的东西\n', 'utf8'));
    const theirs = await fingerprint(live);
    assert.notEqual(theirs.sha256, sha256(Buffer.from('target\n', 'utf8')));

    const { opened, repos, report: sweep } = await restartAndSweep(rig);
    try {
      assert.equal(sweep.reconciled.length, 0, '第三种内容不得被自动定案');
      assert.equal(sweep.awaiting_manual.length, 1);
      assert.equal(sweep.awaiting_manual[0]?.reconciliation.reason, 'THIRD_CONTENT');
      assert.equal(repos.operations.requireById(rig.operation_id).state, 'RECOVERY_REQUIRED');
      assert.equal(repos.changes.requireById(rig.change_id).state, 'RECOVERY_REQUIRED');

      // 用户那一次编辑的字节与最后写入时刻**一个都没变**。
      assert.deepEqual(await fingerprint(live), theirs, '自动恢复不许覆盖用户的编辑');

      // 而回执里这一条是「现场不属于我们」，不是任何形式的「回来了」。
      const results = repos.operations.itemResults(rig.operation_id);
      assert.equal(results[0]?.state, 'UNKNOWN', '现场不属于我们时不许记成任何一种「回来了」');
      assert.equal(results[0]?.error_code, 'THIRD_CONTENT', '而「为什么」也要留在回执上');
      // 两个哈希各自记一件事：`before` 是**被批准的那一份基线**（稳定锚点），
      // `after` 是**这一次观测到的内容**——对第三种内容它就是用户那一份。
      // 一个哈希不声称归属，也不声称时间，因此这与 §8.4 那句不冲突：
      // 上面那条 `fingerprint` 的 deepEqual 才是「没动过」的证据。
      assert.equal(results[0]?.before_sha256, sha256(Buffer.from('base\n', 'utf8')));
      assert.equal(results[0]?.after_sha256, theirs.sha256);
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('验收 2 补充：判成人工时**不动状态**，只留日志，而且恢复记录仍然读得到', async () => {
    const rig = await buildRig('manual', [
      { relative: 'notes/m.txt', before: 'base\n', after: 'target\n' },
    ]);
    await applyWithoutFinalize(rig);
    await writeFile(rig.abs('notes/m.txt'), Buffer.from('别人的\n', 'utf8'));

    const { opened, repos, recovery, report: sweep } = await restartAndSweep(rig);
    try {
      assert.equal(sweep.awaiting_manual.length, 1);

      const stages = repos.journal.list(rig.operation_id).map((row) => row.stage);
      assert.ok(stages.includes('recovery_swept'), `日志里没有扫描标记：${stages.join(',')}`);
      assert.ok(
        stages.includes('recovery_manual_required'),
        `日志里没有人工标记：${stages.join(',')}`,
      );
      // 而**没有**任何一条写着「收场成功了」。
      assert.equal(stages.includes('recovery_repaired'), false);

      // 步骤 4 后半句：记录来自状态库，因此停用连接也不妨碍读它。
      const record = recovery.records(rig.operation_id);
      assert.ok(record, '恢复记录必须读得到');
      assert.equal(record?.operation_state, 'RECOVERY_REQUIRED');
      assert.equal(record?.change_state, 'RECOVERY_REQUIRED');
      assert.equal(record?.recovered, false);
      assert.equal(record?.authorizations.length, 0, '还没人授权');
      assert.ok(record.journal.length >= 2);
      assert.equal(record.items[0]?.canonical_path, 'notes/m.txt');
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('验收 2 补充：**不重放旧批准** —— 人工那一步里没有「把目标补写上去」这条路', async () => {
    // 一条已达、一条是第三种内容。第三种内容挡着，因此连「收场」都不成立：
    // 越过它就要动别人的内容，而那条线正是整件事的边界。
    const rig = await buildRig('noreplay', [
      { relative: 'notes/rep1.txt', before: 'b1\n', after: 't1\n' },
      { relative: 'notes/rep2.txt', before: 'b2\n', after: 't2\n' },
    ]);
    await applyWithoutFinalize(rig);
    await writeFile(rig.abs('notes/rep2.txt'), Buffer.from('用户的\n', 'utf8'));

    const { opened, repos, recovery } = await restartAndSweep(rig);
    try {
      const inspection = await recovery.inspect(rig.operation_id);
      assert.ok(inspection);
      assert.equal(inspection?.reconciliation.kind, 'MANUAL');
      assert.equal(inspection?.repair.kind, 'refused');
      assert.equal(
        inspection?.repair.kind === 'refused' ? inspection.repair.reason : null,
        'HAS_UNRESOLVED_ITEMS',
      );
      // 因此连授权都签发不出来。
      await assert.rejects(
        () => recovery.authorize({ operation_id: rig.operation_id, actor: 'console:test' }),
        (error: unknown) => isBridgeError(error) && error.code === 'RECOVERY_REQUIRED',
      );
      assert.equal(repos.recovery_authorizations.listForOperation(rig.operation_id).length, 0);
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('混合态（一条已达、一条未变）：不自动定案，但**可以**经本地授权收回', async () => {
    const rig = await buildRig('repair', [
      { relative: 'notes/r1.txt', before: 'base-r1\n', after: 'target-r1\n' },
      { relative: 'notes/r2.txt', before: 'base-r2\n', after: 'target-r2\n' },
    ]);
    await applyWithoutFinalize(rig);
    const first = rig.abs('notes/r1.txt');
    const written = await fingerprint(first);
    assert.equal(written.sha256, sha256(Buffer.from('target-r1\n', 'utf8')));

    // 用户撤销了第二个文件的修改（原地保存，对象没换，内容回到基线）。
    const second = rig.abs('notes/r2.txt');
    await writeFile(second, Buffer.from('base-r2\n', 'utf8'));

    const { opened, repos, recovery, report: sweep } = await restartAndSweep(rig);
    try {
      assert.equal(sweep.reconciled.length, 0, '混合态不得被自动定案');
      assert.equal(sweep.awaiting_manual.length, 1);
      assert.equal(sweep.awaiting_manual[0]?.reconciliation.reason, 'MIXED');

      // 「可以收场」：没有现场不属于我们，且确实有东西要收。
      const inspection = await recovery.inspect(rig.operation_id);
      assert.equal(inspection?.repair.kind, 'ok');
      assert.equal(
        inspection?.repair.kind === 'ok' ? inspection.repair.action : null,
        'ROLLBACK_TO_BASELINE',
      );

      const granted = await recovery.authorize({
        operation_id: rig.operation_id,
        actor: 'console:测试',
      });
      assert.equal(granted.digest.length, 64);
      assert.equal(repos.recovery_authorizations.findById(granted.authorization_id)?.state, 'ACTIVE');

      const repaired = await recovery.repair({
        operation_id: rig.operation_id,
        authorization_id: granted.authorization_id,
      });
      assert.equal(repaired.repaired, 1);
      assert.equal(repaired.failed, null);

      // 收回来了：第一个文件回到基线字节，第二个文件一个字节都没被动。
      const back = await fingerprint(first);
      assert.equal(back.sha256, sha256(Buffer.from('base-r1\n', 'utf8')));
      assert.notEqual(back.sha256, written.sha256);
      assert.equal((await fingerprint(second)).sha256, sha256(Buffer.from('base-r2\n', 'utf8')));

      // 定案来自**重新观测一次**，不是来自我们自己的声明。
      assert.equal(repos.operations.requireById(rig.operation_id).state, 'ROLLED_BACK');
      assert.equal(repos.changes.requireById(rig.change_id).state, 'ROLLED_BACK');
      assert.deepEqual(
        repos.operations
          .itemResults(rig.operation_id)
          .map((row) => `${row.item_id}:${row.state}`)
          .sort(),
        ['ci_repair_notes/r1.txt:RECOVERED_ORIGINAL', 'ci_repair_notes/r2.txt:RECOVERED_ORIGINAL'],
      );

      // 授权一次性：用过了。
      assert.equal(
        repos.recovery_authorizations.findById(granted.authorization_id)?.state,
        'CONSUMED',
      );
      assert.equal(repaired.reconciliation.kind, 'ROLLED_BACK');
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('步骤 4 补充：授权签发之后磁盘又被改过 ⇒ 摘要不符，**拒绝执行**且不写任何字节', async () => {
    // 「本地恢复授权」钉的不是「你同意收场」这句话，而是**你同意收回
    // 现在这些字节**。签发之后用户又动了一次，那句话就不再指向现在的现场。
    const rig = await buildRig('stale', [
      { relative: 'notes/s1.txt', before: 'base-s1\n', after: 'target-s1\n' },
      { relative: 'notes/s2.txt', before: 'base-s2\n', after: 'target-s2\n' },
    ]);
    const report = await applyWithoutFinalize(rig);
    assert.equal(report.kind, 'applied', `装置：写盘要先成功：${JSON.stringify(report)}`);
    await writeFile(rig.abs('notes/s2.txt'), Buffer.from('base-s2\n', 'utf8'));

    const { opened, repos, recovery } = await restartAndSweep(rig);
    try {
      // 装置：混合态（一条已达、一条未变），因此收场判据成立、授权签得出来。
      const inspection = await recovery.inspect(rig.operation_id);
      assert.equal(inspection?.reconciliation.reason, 'MIXED', '装置：现场应当是混合态');
      assert.equal(inspection?.repair.kind, 'ok', '装置：这时候收场是允许的');

      const granted = await recovery.authorize({
        operation_id: rig.operation_id,
        actor: 'console:测试',
      });

      // 授权之后，用户在第一个文件上又写了一次。
      const first = rig.abs('notes/s1.txt');
      await writeFile(first, Buffer.from('用户刚刚写的\n', 'utf8'));
      const theirs = await fingerprint(first);

      await assert.rejects(
        () =>
          recovery.repair({
            operation_id: rig.operation_id,
            authorization_id: granted.authorization_id,
          }),
        (error: unknown) => isBridgeError(error),
        '磁盘变过之后，那份授权不再有效',
      );

      assert.deepEqual(await fingerprint(first), theirs, '拒绝执行时不得碰磁盘');
      // 授权**没有**被消费掉：它还在，只是对这一份现场不成立。
      assert.equal(
        repos.recovery_authorizations.findById(granted.authorization_id)?.state,
        'ACTIVE',
        '被拒绝的消费不该把授权烧掉',
      );
      assert.equal(repos.operations.requireById(rig.operation_id).state, 'RECOVERY_REQUIRED');
    } finally {
      closeDatabase(opened.db);
    }
  });

  // -------------------------------------------------------------------------
  // 验收 3
  // -------------------------------------------------------------------------

  it('验收 3：快照被删掉 ⇒ 收场**停下**（repaired=0、一个字节不写、状态不动）', async () => {
    const rig = await buildRig('snap', [
      { relative: 'notes/sn1.txt', before: 'base-sn1\n', after: 'target-sn1\n' },
      { relative: 'notes/sn2.txt', before: 'base-sn2\n', after: 'target-sn2\n' },
    ]);
    await applyWithoutFinalize(rig);
    // 用户撤销第二条 ⇒ 混合态 ⇒ 收场判据成立，而目标正是第一条。
    await writeFile(rig.abs('notes/sn2.txt'), Buffer.from('base-sn2\n', 'utf8'));

    const first = rig.abs('notes/sn1.txt');
    const written = await fingerprint(first);

    // 把第一条的**基线快照**从库里删掉。
    const objectPath = await deleteSnapshot(rig, firstBaselineBlobId(rig));
    await assert.rejects(() => stat(objectPath), '装置：快照对象确实不在了');

    const { opened, repos, recovery } = await restartAndSweep(rig);
    try {
      // 判定这一步不需要快照（它读的是工作区），因此扫描照常跑完并留待人工。
      assert.equal(repos.operations.requireById(rig.operation_id).state, 'RECOVERY_REQUIRED');
      const inspection = await recovery.inspect(rig.operation_id);
      assert.equal(inspection?.repair.kind, 'ok', '装置：收场判据在快照缺失之前是成立的');

      const granted = await recovery.authorize({
        operation_id: rig.operation_id,
        actor: 'console:测试',
      });
      const repaired = await recovery.repair({
        operation_id: rig.operation_id,
        authorization_id: granted.authorization_id,
      });

      // **停下**：一条都没收回来，而且说得出为什么。
      assert.equal(repaired.repaired, 0);
      assert.ok(repaired.failed, '失败必须带一句原因，而不是静默的 0');
      assert.match(repaired.failed ?? '', /取不到基线快照|快照/);

      // 一个字节都没写，状态也没动。
      assert.deepEqual(await fingerprint(first), written, '取不到快照时绝不许碰磁盘');
      assert.equal(repos.operations.requireById(rig.operation_id).state, 'RECOVERY_REQUIRED');
      const stages = repos.journal.list(rig.operation_id).map((row) => row.stage);
      assert.ok(
        stages.includes('recovery_repair_failed'),
        `日志里没有失败标记：${stages.join(',')}`,
      );
      assert.equal(stages.includes('recovery_repaired'), false);

      // 而**历史还在**：记录读得到，那条授权也读得到（它被消费过，是
      // 一次真实的操作记录）。「不完整」与「新安装」的区别就在这里。
      const record = recovery.records(rig.operation_id);
      assert.equal(record?.operation_state, 'RECOVERY_REQUIRED');
      assert.equal(record?.authorizations.length, 1);
      assert.equal(record?.authorizations[0]?.state, 'CONSUMED');
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('验收 3 补充：护栏不可用 ⇒ 判定不成，**原样留着**、一个字不改', async () => {
    const rig = await buildRig('noprobe', [
      { relative: 'notes/np.txt', before: 'base\n', after: 'target\n' },
    ]);
    await applyWithoutFinalize(rig);
    const target = rig.abs('notes/np.txt');
    const written = await fingerprint(target);

    // 把故障插在护栏边界上：`readFileGuarded` 直接抛（真实现里这是
    // pwsh 起不来、或者护栏进程中途消失时的形态）。这是本文件唯一一处
    // 非生产代码，而它插的位置正是「判定做不成」那一条要问的地方。
    // 转发必须逐个方法写出来：`PowerShellWinfsBackend` 用私有字段，
    // 品牌检查会挡住 `Object.create` 那种转发（同 LWB-028 的 `withRacer`）。
    const failing: WinfsOps = {
      capability: () => backend.capability(),
      statVolume: (req) => backend.statVolume(req),
      validatePath: (req) => backend.validatePath(req),
      resolvePath: (req) => backend.resolvePath(req),
      readFileGuarded: () => {
        throw new Error('护栏进程无法启动（本用例构造的后端故障）。');
      },
      writeFileGuarded: (req) => backend.writeFileGuarded(req),
      createFileGuarded: (req) => backend.createFileGuarded(req),
      listDirectory: (req) => backend.listDirectory(req),
    };

    const { opened, repos, recovery, report: sweep } = await restartAndSweep(rig, failing);
    try {
      assert.equal(sweep.leftovers, 1, '它仍然被标成待恢复 —— 标记不依赖护栏');
      assert.equal(sweep.reconciled.length, 0);
      assert.equal(sweep.awaiting_manual.length, 0);
      assert.equal(sweep.undecidable.length, 1, '判不成要如实报出来，不能当成「没事」');
      assert.match(sweep.undecidable[0]?.detail ?? '', /护栏/);

      // 原样留着：状态是待恢复，字节一个没动。
      assert.equal(repos.operations.requireById(rig.operation_id).state, 'RECOVERY_REQUIRED');
      assert.deepEqual(await fingerprint(target), written, '判定不成时不许碰磁盘');

      // 于是这个工作区仍然带着未处理的恢复记录 —— 写能力关着。
      assert.equal(recovery.requiresRecovery(repos.workspaces.requireById(WORKSPACE)), true);

      // 而且它**仍然可以被读**：这正是「判不成」与「新安装」的区别。
      const record = recovery.records(rig.operation_id);
      assert.equal(record?.operation_state, 'RECOVERY_REQUIRED');
      assert.ok((record?.journal.length ?? 0) >= 1, '扫描那一条日志仍然在');
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('验收 3 补充：库文件坏掉 ⇒ 拒绝打开，且**不**凭空建一个新库', async () => {
    const rig = await buildRig('brokendb', [
      { relative: 'notes/db.txt', before: 'base\n', after: 'target\n' },
    ]);
    await applyWithoutFinalize(rig);

    // 把库文件写成垃圾（保留长度）：一个「有文件、但不是库」的现场。
    const garbage = Buffer.alloc(8192, 0x41);
    await writeFile(rig.dbPath, garbage);

    assert.throws(() => openDatabase({ path: rig.dbPath }), '坏掉的库必须拒绝打开');

    // 而它**没有**被换成一个新库：那些垃圾字节还在原处。
    assert.deepEqual(await readFile(rig.dbPath), garbage, '拒绝打开时不得改写别人的文件');
  });
});
