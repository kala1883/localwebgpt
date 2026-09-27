/**
 * LWB-029 真 NTFS 验收：多文件写入的日志与回滚边界。
 *
 * ## 与单元测试的分工
 *
 * `tests/unit/executor-native-adapter.test.ts` 的 F/G/H/J 组用假护栏穷尽
 * **组合**：十个日志边界一个不落、第一/中间/最后一个文件、快照缺失、
 * 折叠的每一种结果、脱敏。那些用例的意义是「穷尽」，因此它们的磁盘是假的。
 *
 * 本文件反过来：**条目少、环节真** —— 真 NTFS、真 `PowerShellWinfsBackend`、
 * 真的 `WriteFileGuarded`（同一句柄内复核 + 截断 + `FlushFileBuffers`）、
 * 真 SQLite、真快照库、真 `claimForExecution`。它回答的是「这套东西接在真
 * 操作系统上还成不成立」：
 *
 *  - 验收 1：故障落在**第一、中间、最后一个**文件上，回滚**真的把字节写回去了**
 *    —— 拿磁盘上的字节与执行之前的快照逐字节比，不是拿报告的措辞比；
 *  - 验收 2：**收回本身失败**时进待恢复，绝不报成一次干净的回滚；
 *  - 验收 3：日志边界上「进程停住」之后，账本折出来的结论不会比磁盘乐观；
 *  - 持久化边界：目标快照取不到 ⇒ 拒绝，且目标文件**零写入**。
 *
 * 假护栏证不了第一条：它说的是**字节**的事实，而那正是单元测试刻意不碰的部分。
 * 反过来，本文件只跑两条日志边界（`intent` 与 `verified`）—— 「每一个边界」
 * 是 F 组的活，真盘上跑十遍只是慢十倍，不多证明任何事。
 *
 * ## 故障注入打在哪里
 *
 * 两处，都是**边界**而不是内部实现：
 *
 *  1. `withRefusals` 包在护栏**外面**：命中的那一次调用直接返回拒绝，
 *     于是它**根本没到过文件系统**。这正是「护栏在越过破坏性区域之前失败」
 *     的忠实构造 —— 它一个字节都没写，对应的结论文档里叫 `untouched`；
 *  2. `crashAt` 拦在 `repos.journal.append` 上，也就是每条日志落库的那一刻。
 *     拦住一条日志 == 「它描述的那件事发生了，而账上没记」。
 *
 * ## 未执行项（不在本文件里冒充 PASS）
 *
 * 「进程真的被杀」没有构造：本文件用「抛在日志边界上」代替它，两者的区别是
 * **进程还在**（于是后面的代码还能跑、还能写出报告）。因此 `crashAt` 那些
 * 用例断言的是「按这本账折出来的结论」，而不是「一个真被杀的进程会留下什么」
 * —— 后者要等 LWB-030 的启动恢复来读同一本账。这一条在
 * `docs/evidence/lwb-029/` 里标了 `NOT_RUN`，没有与 `PASS` 合并。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeOp, FileEncoding, NewlineStyle } from '@lwb/contracts';
import {
  aggregateOf,
  claimForExecution,
  createNativeApplier,
  ITEM_STAGE,
  itemOutcomes,
  readItemEvents,
} from '@lwb/executor';
import type { ApplyReport, ExecutionPlan, ItemEvent, ItemStage } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput } from '@lwb/persistence';
import { isWinfsError, PowerShellWinfsBackend } from '@lwb/winfs';
import type { WinfsError, WinfsOps } from '@lwb/winfs';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

const CONNECTION = 'conn_jrn';
const WORKSPACE = 'ws_jrn';
const PRINCIPAL = 'principal_jrn';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_jrn';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：每个用例的地都是空的。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本用例不该问进程探针：认领时这块地是空的');
  },
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * 一个文件的正文：带 BOM 与 CRLF。
 *
 * 刻意不是「一行纯 ASCII」—— 「字节回去了」这句话要能证伪，
 * 盘上那一份就得有不止一种可能的形态。
 */
const bodyOf = (seed: string, which: string, when: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${when}-${seed}-${which}\r\n第二行\r\n`, 'utf8'),
  ]);

/** 一条注入规则：某个路径的第 N 次写入（1 起数）返回这个拒绝。 */
interface RefusalRule {
  readonly path: string;
  readonly nth: number;
  readonly code?: WinfsError['code'];
  readonly win32_error?: number;
  readonly message?: string;
  /** 报告「已越过破坏性区域」—— 真护栏只有在句柄里才知道这件事。 */
  readonly touched?: true;
}

describeWindows('LWB-029 真 NTFS：多文件写入的日志与回滚边界', () => {
  let sandbox = '';
  let backend: PowerShellWinfsBackend;
  let opened: ReturnType<typeof openDatabase> | undefined;
  let repos: Repositories;
  let seq = 0;

  const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;
  const DB = (): Repositories => repos;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-journal-boundary-'));
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
    readonly objectsRoot: string;
    readonly plan: ExecutionPlan;
    readonly change_id: string;
    /** 相对路径 → 执行之前磁盘上的字节。 */
    readonly baseline: ReadonlyMap<string, Buffer>;
    readonly abs: (relative: string) => string;
    readonly onDisk: (relative: string) => Promise<Buffer>;
    readonly report: (ops?: WinfsOps) => Promise<ApplyReport>;
    readonly ledger: () => { readonly events: readonly ItemEvent[]; readonly aggregate: string };
    readonly stagesOf: (relative: string) => string[];
  }

  /**
   * 搭一套**真的**工作区 + 多条目修改集 + 计划。
   *
   * 身份（卷序列号 / 文件索引）与哈希全部由护栏自己给出：本文件不自己算
   * 一份，否则验的是测试写的第二个实现，而不是交付物。
   */
  async function rig(seed: string, files: readonly string[]): Promise<Rig> {
    if (opened !== undefined) closeDatabase(opened.db);
    const dir = path.join(sandbox, seed);
    await mkdir(dir, { recursive: true });

    opened = openDatabase({ path: ':memory:' });
    repos = new Repositories(opened.db);
    const objectsRoot = path.join(sandbox, `${seed}-objects`);
    const blobs = new BlobStore({ objectsRoot, registry: repos.blobs, newId: () => nextId('blob') });

    const volume = await backend.statVolume({ path: dir });
    assert.equal(volume.ok, true, `statVolume 失败：${JSON.stringify(volume)}`);
    if (isWinfsError(volume)) throw new Error('上面一行已经断言过');
    const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };

    const baseline = new Map<string, Buffer>();
    const items: ChangeItemInput[] = [];
    const digestFiles: {
      path: string;
      op: ChangeOp;
      before_sha256: string | null;
      before_size: number;
      after_sha256: string;
      after_size: number;
      encoding: FileEncoding;
      newline: NewlineStyle;
      bom: boolean;
    }[] = [];

    for (const relative of files) {
      const target = path.join(dir, relative.split('/').join(path.sep));
      await mkdir(path.dirname(target), { recursive: true });
      const before = bodyOf(seed, relative, 'before');
      const after = bodyOf(seed, relative, 'after');
      await writeFile(target, before);
      baseline.set(relative, before);

      const read = await backend.readFileGuarded({ ...ref, relative_path: relative });
      assert.equal(read.ok, true, `读取基线失败：${JSON.stringify(read)}`);
      if (isWinfsError(read)) throw new Error('上面一行已经断言过');

      const beforeBlob = await blobs.putAndRegister(before, { id: nextId('blob') });
      const afterBlob = await blobs.putAndRegister(after, { id: nextId('blob') });

      items.push({
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
        removed_lines: 2,
      });
      digestFiles.push({
        path: relative,
        op: 'edit_text',
        before_sha256: read.sha256,
        before_size: beforeBlob.put.size,
        after_sha256: afterBlob.put.sha256,
        after_size: afterBlob.put.size,
        encoding: 'utf-8-bom',
        newline: 'crlf',
        bom: true,
      });
    }

    repos.connections.create({
      id: CONNECTION,
      principal_kind: 'model_surface',
      principal_id: PRINCIPAL,
      alias: '真盘日志连接',
      enabled: true,
    });
    repos.workspaces.create({
      id: WORKSPACE,
      alias: '真盘日志工作区',
      kind: 'directory',
      canonical_root: dir,
      volume_id: volume.volume_id,
      root_file_id: volume.file_id,
      policy_version: POLICY_VERSION,
      mode: MODE,
    });
    const generation = repos.workspaces.requireById(WORKSPACE).generation;

    const digest = canonicalChangeDigest({
      contract_version: CONTRACT,
      policy_version: POLICY_VERSION,
      root_generation: generation,
      workspace_id: WORKSPACE,
      files: digestFiles,
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
      summary: `真盘日志摘要 ${seed}`,
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

    const recorded = repos.changes.items(change.id);
    const idOf = new Map(recorded.map((item) => [item.canonical_path, item.id]));

    return {
      dir,
      objectsRoot,
      plan: outcome.plan,
      change_id: change.id,
      baseline,
      abs: (relative) => path.join(dir, relative.split('/').join(path.sep)),
      onDisk: (relative) => readFile(path.join(dir, relative.split('/').join(path.sep))),
      report: (ops: WinfsOps = backend) =>
        createNativeApplier({ repos, ops, blobs })(outcome.plan, new AbortController().signal),
      ledger: () => {
        const events = readItemEvents(repos, outcome.plan.operation_id);
        return { events, aggregate: aggregateOf(itemOutcomes(events), recorded.length) };
      },
      stagesOf: (relative) => {
        const id = idOf.get(relative);
        assert.ok(id !== undefined, `夹具里没有 ${relative} 这个条目`);
        return readItemEvents(repos, outcome.plan.operation_id)
          .filter((event) => event.item_id === id)
          .map((event) => event.stage);
      },
    };
  }

  /**
   * 把故障插在护栏**外面**：命中的那一次调用直接返回拒绝，
   * 因此它**根本没有到过文件系统**。
   *
   * 转发必须显式写出每一个方法：`PowerShellWinfsBackend` 用私有字段
   * （`#helper`），私有字段的品牌检查会挡住 `Object.create` 那种转发。
   */
  function withRefusals(rules: readonly RefusalRule[]): WinfsOps {
    const seen = new Map<string, number>();
    return {
      capability: () => backend.capability(),
      statVolume: (req) => backend.statVolume(req),
      validatePath: (req) => backend.validatePath(req),
      resolvePath: (req) => backend.resolvePath(req),
      readFileGuarded: (req) => backend.readFileGuarded(req),
      createFileGuarded: (req) => backend.createFileGuarded(req),
      listDirectory: (req) => backend.listDirectory(req),
      writeFileGuarded: async (req) => {
        const nth = (seen.get(req.relative_path) ?? 0) + 1;
        seen.set(req.relative_path, nth);
        const rule = rules.find((r) => r.path === req.relative_path && r.nth === nth);
        if (rule === undefined) return backend.writeFileGuarded(req);
        const refusal: WinfsError = {
          ok: false,
          code: rule.code ?? 'FILE_BUSY',
          message: rule.message ?? '注入：这一次调用不去碰文件系统',
          win32_error: rule.win32_error ?? 32,
          ...(rule.touched === true ? { touched: true as const } : {}),
        };
        return refusal;
      },
    };
  }

  /**
   * 在**某一个日志边界**上停住。
   *
   * 打的是 `repos.journal.append`：每条条目级日志真正落库的那一刻。
   * 拦住一条日志 == 「它描述的那件事发生了，而账上没记」。
   */
  function crashAt(stage: ItemStage): () => boolean {
    const original = repos.journal.append;
    let fired = false;
    repos.journal.append = function patched(input: Parameters<typeof original>[0]): number {
      if (input.stage === stage && !fired) {
        fired = true;
        throw new Error(`注入：在 ${stage} 这个边界上进程停住`);
      }
      return original.call(repos.journal, input);
    };
    return () => fired;
  }

  const thrownBy = async (fn: () => Promise<unknown>): Promise<Error> => {
    try {
      await fn();
    } catch (error) {
      assert.ok(error instanceof Error, `抛出的不是 Error：${String(error)}`);
      return error;
    }
    throw new assert.AssertionError({ message: '本应抛出，却没有抛' });
  };

  const THE_THREE = ['src/a.txt', 'src/b.txt', 'src/c.txt'];

  /** 盘上这一份与执行之前那一份**逐字节**相同吗。 */
  async function backAtBaseline(r: Rig, relative: string): Promise<boolean> {
    return sha256(await r.onDisk(relative)) === sha256(r.baseline.get(relative)!);
  }

  it('验收 1：失败在**中间** —— 前一个的字节真的被写回基线，后一个一个字都没动', async () => {
    const r = await rig('middle', THE_THREE);

    const report = await r.report(withRefusals([{ path: 'src/b.txt', nth: 1 }]));

    assert.equal(report.kind, 'rolled_back');
    if (report.kind !== 'rolled_back') throw new Error('上面一行已经断言过');
    assert.match(report.detail, /已回到基线 1/, '写成的那个必须被收回去');
    assert.match(report.detail, /未改动 2/, '没写成的两个：一个失败、一个没轮到');

    // 磁盘上**逐字节**的实话。哈希比的是真字节，不是报告的措辞。
    assert.equal(await backAtBaseline(r, 'src/a.txt'), true, 'a 必须回到基线');
    assert.equal(await backAtBaseline(r, 'src/b.txt'), true, 'b 从没被碰过');
    assert.equal(await backAtBaseline(r, 'src/c.txt'), true, 'c 从没被轮到');

    // 账：三个条目都有终局，缺一条就说不清。
    assert.deepEqual(r.stagesOf('src/a.txt'), [
      ITEM_STAGE.intent,
      ITEM_STAGE.written,
      ITEM_STAGE.flushed,
      ITEM_STAGE.verified,
      ITEM_STAGE.restored,
    ]);
    assert.deepEqual(r.stagesOf('src/b.txt'), [ITEM_STAGE.intent, ITEM_STAGE.untouched]);
    assert.deepEqual(r.stagesOf('src/c.txt'), [ITEM_STAGE.untouched]);
    assert.equal(r.ledger().aggregate, 'rolled_back');
    // 适配器停在 APPLYING；终局由协调器的 `#finalize` 落。
    assert.equal(DB().changes.requireById(r.change_id).state, 'APPLYING');
  });

  it('验收 1：失败在**最后一个** —— 前面两个都收回去，且是倒序', async () => {
    const r = await rig('last', THE_THREE);

    const report = await r.report(withRefusals([{ path: 'src/c.txt', nth: 1 }]));

    assert.equal(report.kind, 'rolled_back');
    if (report.kind !== 'rolled_back') throw new Error('上面一行已经断言过');
    assert.match(report.detail, /已回到基线 2/);

    for (const relative of THE_THREE) {
      assert.equal(await backAtBaseline(r, relative), true, `${relative} 必须回到基线`);
    }
    assert.equal(r.stagesOf('src/a.txt').at(-1), ITEM_STAGE.restored);
    assert.equal(r.stagesOf('src/b.txt').at(-1), ITEM_STAGE.restored);
    assert.equal(r.stagesOf('src/c.txt').at(-1), ITEM_STAGE.untouched);
    assert.equal(r.ledger().aggregate, 'rolled_back');
  });

  it('验收 1：失败在**第一个** —— 零字节写出，后两个补记「没轮到」', async () => {
    const r = await rig('first', THE_THREE);

    const report = await r.report(withRefusals([{ path: 'src/a.txt', nth: 1 }]));

    assert.equal(report.kind, 'rolled_back');
    if (report.kind !== 'rolled_back') throw new Error('上面一行已经断言过');
    assert.match(report.detail, /未改动 3/);
    for (const relative of THE_THREE) {
      assert.equal(await backAtBaseline(r, relative), true);
    }
    // 「没轮到」与「动过了但没记」在账上必须分得开：少了后两条，
    // 折叠会得出「说不清」，于是一次「一个字节都没写」的执行
    // 会要求人去核验两个从来没被碰过的文件。
    assert.deepEqual(r.stagesOf('src/a.txt'), [ITEM_STAGE.intent, ITEM_STAGE.untouched]);
    assert.deepEqual(r.stagesOf('src/b.txt'), [ITEM_STAGE.untouched]);
    assert.deepEqual(r.stagesOf('src/c.txt'), [ITEM_STAGE.untouched]);
    assert.equal(r.ledger().aggregate, 'rolled_back');
  });

  it('验收 1：三个文件全部写成 ⇒ `applied`，逐条目四步都走过', async () => {
    const r = await rig('all', THE_THREE);

    const report = await r.report();

    assert.equal(report.kind, 'applied');
    if (report.kind !== 'applied') throw new Error('上面一行已经断言过');
    assert.ok(report.detail, '全部写成的报告必须带上逐条目小结');
    assert.match(report.detail, /已写入并核验 3/);
    for (const relative of THE_THREE) {
      assert.equal(await backAtBaseline(r, relative), false, `${relative} 应当是目标内容`);
      assert.deepEqual(r.stagesOf(relative), [
        ITEM_STAGE.intent,
        ITEM_STAGE.written,
        ITEM_STAGE.flushed,
        ITEM_STAGE.verified,
      ]);
    }
    assert.equal(r.ledger().aggregate, 'applied');
  });

  it('验收 2：**收回本身**被拒 ⇒ 待恢复，绝不报成一次干净的回滚', async () => {
    const r = await rig('rollback-refused', ['src/a.txt', 'src/b.txt']);

    // 两次拒绝各说各的：b 的第一次写被挡（循环停在这），
    // 而 a 的**第二次**写 —— 也就是把它收回去的那一次 —— 也要被挡。
    const thrown = await thrownBy(() =>
      r.report(
        withRefusals([
          { path: 'src/b.txt', nth: 1 },
          {
            path: 'src/a.txt',
            nth: 2,
            code: 'PERMISSION_DENIED',
            win32_error: 5,
            message: '注入：收回这一次被拒',
          },
        ]),
      ),
    );

    assert.equal((thrown as { code?: string }).code, 'RECOVERY_REQUIRED');
    // 盘上：a 留着我们写下去的字节（收回被拒），b 原样。
    // 这一条是「不把待恢复报成回滚」的**磁盘**证据 —— 报告与账本都可能
    // 说错，而这两个文件里的字节不会。
    assert.equal(await backAtBaseline(r, 'src/a.txt'), false, 'a 上的字节没能收回，就不该说收回去了');
    assert.equal(await backAtBaseline(r, 'src/b.txt'), true);
    // 账：a 的终局是「可能留有本次执行的字节」，而这是**对的**。
    assert.equal(r.stagesOf('src/a.txt').at(-1), ITEM_STAGE.restore_failed);
    assert.equal(r.stagesOf('src/b.txt').at(-1), ITEM_STAGE.untouched);
    assert.equal(r.ledger().aggregate, 'unfinished');
  });

  it('验收 3：在 `verified` 边界上停住 ⇒ 盘上已有目标字节，账上只有意图', async () => {
    const r = await rig('crash-verified', ['src/a.txt', 'src/b.txt']);
    const fired = crashAt(ITEM_STAGE.verified);

    const thrown = await thrownBy(() => r.report());

    assert.equal(fired(), true, '注入没有落在 `verified` 这个边界上');
    assert.match(thrown.message, /注入：在 item_verified 这个边界上进程停住/);
    // 字节确实写出去了 —— 最危险的那一格：盘上是**批准过的内容**，
    // 而账上说不清。折叠的方向因此只能是「不知道」，不可能是「写成了」。
    const a = DB().changes.items(r.change_id).find((item) => item.canonical_path === 'src/a.txt')!;
    assert.equal(sha256(await r.onDisk('src/a.txt')), a.target_sha256);
    // 三条回执日志在**同一个事务**里（见 `apply.ts` 的 `writeOne`）：
    // 第三条抛了，前两条一起回滚 ——「说了写了、没说刷没刷」这种中间态
    // 在库层面就不可能出现。这不是巧合，是那三行必须同生共死的原因。
    assert.deepEqual(r.stagesOf('src/a.txt'), [ITEM_STAGE.intent]);
    assert.equal(r.ledger().aggregate, 'unfinished');
    assert.equal(DB().changes.requireById(r.change_id).state, 'APPLYING');
  });

  it('验收 3：在 `intent` 边界上停住 ⇒ 盘上零改动（账记不上就不许写）', async () => {
    const r = await rig('crash-intent', ['src/a.txt']);
    const fired = crashAt(ITEM_STAGE.intent);

    await thrownBy(() => r.report());

    assert.equal(fired(), true);
    assert.equal(await backAtBaseline(r, 'src/a.txt'), true);
    assert.deepEqual(r.ledger().events, []);
    assert.equal(r.ledger().aggregate, 'unfinished');
  });

  it('目标快照取不到 ⇒ 拒绝，目标文件**零写入**（在阶段 A 就被拦下）', async () => {
    const r = await rig('snapshot-gone', ['src/a.txt', 'src/b.txt']);
    const item = DB().changes.items(r.change_id).find((i) => i.canonical_path === 'src/b.txt')!;
    const blob = DB().blobs.requireById(item.new_blob_id!);
    // `storage_ref` 是相对**受保护根**的引用（`objects/<shard>/<sha>`），
    // 而 `objectsRoot` 已经是那个 `objects` 目录本身 —— 去掉第一段再拼。
    const segments = blob.storage_ref.replace(/\\/g, '/').split('/');
    assert.equal(segments[0], 'objects', `快照引用的形状不对：${blob.storage_ref}`);
    await rm(path.join(r.objectsRoot, ...segments.slice(1)));

    const report = await r.report();

    assert.equal(report.kind, 'refused');
    if (report.kind !== 'refused') throw new Error('上面一行已经断言过');
    // **拦在阶段 A，而不是阶段 A2。** 这一条是实测出来的，不是设计时就知道的：
    // 阶段 A 的核对也要把目标字节读出来比对（它要回答「要不要写」），
    // 于是快照缺失在**更早、更便宜**的那一步就暴露了。
    // 验收标准要的是「快照持久化失败时目标文件零写入」，两处都满足；
    // 阶段 A2 那一层由单元 H 组用假护栏单独验（真盘上造不出「A 时还在、
    // A2 时没了」的窗口，那需要在快照库上再开一个注入点）。
    assert.match(report.detail, /未写入任何字节/);
    assert.match(report.detail, /目标快照/);
    // **零写入**是这条验收标准的原话：两个文件都还是执行之前的样子。
    for (const relative of ['src/a.txt', 'src/b.txt']) {
      assert.equal(await backAtBaseline(r, relative), true, `${relative} 必须零改动`);
    }
    assert.equal(
      DB().changes.requireById(r.change_id).state,
      'VALIDATING',
      '没写入就不该记下执行意图',
    );
    assert.deepEqual(r.ledger().events, []);
  });

  it('账本里不出现工作区根的绝对路径 —— 连护栏原话里那一份也被抹掉', async () => {
    const r = await rig('redaction', ['src/a.txt']);
    const leak = r.abs('src/a.txt');

    // 一条**带着绝对路径**、且自称已越过破坏性区域的拒绝 —— 真护栏的消息
    // 就是这么写的（`WinfsGuard.ps1` 的 `Open-Guarded` 把 `$Path` 拼进去）。
    // 它走到 `restore_skipped`，那句话会跟着进日志。
    await thrownBy(() =>
      r.report(
        withRefusals([
          {
            path: 'src/a.txt',
            nth: 1,
            touched: true,
            code: 'IO_ERROR',
            win32_error: 5,
            message: `注入：写 ${leak} 时被拒`,
          },
        ]),
      ),
    );

    const rows = DB().journal.list(r.plan.operation_id);
    assert.ok(rows.length > 0);
    // 先证明那条原话**真的**进了账本：没有这一条，下面的断言可能只是
    // 因为夹具没把路径放进去而通过。
    assert.ok(
      rows.some((row) => (row.detail ?? '').includes('注入：写')),
      '那条护栏原话必须真的进了账本，否则本用例验的是空气',
    );
    for (const row of rows) {
      assert.equal(
        (row.detail ?? '').includes(leak),
        false,
        `日志行里出现了绝对路径：${row.detail ?? ''}`,
      );
    }
  });
});
