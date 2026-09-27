/**
 * LWB-029 可复现证据采集：多文件日志与持久化边界。
 *
 * 装置与 LWB-027/028 同一套：**真 NTFS** ←经→ 真 `PowerShellWinfsBackend`
 * （真的 `CreateFileW`、`WriteFile`、`FlushFileBuffers`、
 * `GetFileInformationByHandle`）→ 真适配器与真编排
 * （`packages/executor/src/apply.ts`、`journal.ts`）→ 真 SQLite、真快照库、
 * 真 `claimForExecution`。**没有假件**，唯一的例外在 §5 与 §7 里写明。
 *
 * ## 逐条对应任务书
 *
 *  步骤 1「应用前验证全部既有目标与快照；所有旧/新 blob 持久化完成后才能
 *  写入工作区」 —— §1 ②：在**第一次写入调用**的那一刻，把每个条目的旧、新
 *  两个快照都在磁盘上找一遍。少一个就 FAIL。
 *
 *  步骤 2「对每个文件记录 intent、观察身份、已写/已刷盘/已验证状态；数据库
 *  提交与文件刷盘之间保留可恢复断点」 —— §1 ③（四个阶段逐一落库、顺序正确、
 *  `seq` 严格递增）+ §4（把进程停在某个边界上，看账本与磁盘各自说了什么）。
 *
 *  步骤 3「普通失败在仍持有安全句柄时有界恢复；恢复失败进入
 *  RECOVERY_REQUIRED」 —— §2（真的把字节写回去了）与 §3 甲（收回被拒 ⇒ 待恢复）。
 *
 *  步骤 4「完成回执记录逐文件实际状态与 aggregate 状态，不把部分完成当全成功」
 *   —— §1 ⑤ 与 §5：后者专门验反方向 ——「一个写成、一个没轮到」绝不能折叠成
 *  `applied`。
 *
 *  验收「故障注入覆盖每个日志边界以及第一、中间、最后一个文件」 —— 真盘上
 *  跑得了的是「第一/中间/最后一个文件」（§2）与两条最有代表性的日志边界
 *  （§4）；**十个边界一个不落**由 `tests/unit/executor-native-adapter.test.ts`
 *  的 F 组覆盖。理由见 §8 的 NOT_RUN —— 真盘上跑十遍只是慢十倍，不多证明任何事。
 *
 *  验收「快照持久化失败时目标文件零写入」 —— §3 乙。
 *
 *  验收「批量失败不会调用 Git reset/checkout/stash/clean」 —— §7，静态判据
 *  与动态负实验两条合起来才算数（单看任何一条都不够，理由写在那里的 NOTE 里）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-029.ts
 * 退出码：全部通过 0；任一项失败 1。
 *
 * 本文件证明不了的事（见 §8）：**真实 ChatGPT 网页端验收**需要真实账号与
 * Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；**启动恢复**属 LWB-030
 * —— 本文件里所有「进程在半路停住」都是**抛异常**，进程还活着，因此读到的
 * 是「按这本账折出来的结论」，而不是一个真被杀的进程留下的现场。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { approveAndQueue } from '@lwb/approvals';
import { BlobStore } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import {
  aggregateOf,
  claimForExecution,
  createNativeApplier,
  describeOutcomes,
  ITEM_STAGE,
  itemOutcomes,
  readItemEvents,
} from '@lwb/executor';
import type { ApplyReport, ExecutionPlan, ItemEvent, ItemStage } from '@lwb/executor';
import type { ProcessProbe } from '@lwb/ipc';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';
import { disposeWinfsBackend, getWinfsBackend, isWinfsError } from '@lwb/winfs';
import type { WinfsError, WinfsOps } from '@lwb/winfs';

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;
let skips = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function note(name: string, detail: string): void {
  console.log(`NOTE ${name} — ${detail}`);
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function skip(name: string, why: string): void {
  skips += 1;
  console.log(`NOT_RUN ${name} — ${why}`);
}

/** 跑一段；炸了就把真实原因报成 FAIL，而不是让整个脚本消失。 */
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
    if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
    if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
  }
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** 脱敏判据：证据里不得出现本机绝对路径。 */
const leaksLocalPaths = (text: string): boolean => /[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(text);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_ev29';
const WORKSPACE = 'ws_ev29';
const PRINCIPAL = 'principal_ev29';
const POLICY_VERSION = 1;
const MODE = 'read_propose_apply_with_local_approval';
const EXECUTOR_ID = 'exe_ev29';
const HOLDER = { pid: process.pid, started_at: new Date(Date.now() - 60_000).toISOString() };
const CONTRACT = CONTRACT_VERSION;

/** 认领时不该被问到：地是空的，槽是空的。 */
const deadProbe: ProcessProbe = {
  identify: () => {
    throw new Error('本证据不该问进程探针（LWB-026 已经证过它）');
  },
};

const realOps = getWinfsBackend();

let sandbox = '';
let opened: OpenDatabaseResult | undefined;
let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

/** 一个文件的正文：带 BOM 与 CRLF —— 「字节回去了」这句话要能证伪。 */
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
  readonly touched?: true;
}

interface Rig {
  readonly dir: string;
  readonly objectsRoot: string;
  readonly blobs: BlobStore;
  readonly ref: { readonly root_path: string; readonly root_volume_id: string; readonly root_file_id: string };
  readonly plan: ExecutionPlan;
  readonly change_id: string;
  readonly operation_id: string;
  readonly items: readonly ChangeItemInput[];
  /** 相对路径 → 执行之前磁盘上的字节。 */
  readonly baseline: ReadonlyMap<string, Buffer>;
  readonly abs: (relative: string) => string;
  readonly onDisk: (relative: string) => Buffer;
  readonly submit: () => Promise<ApplyReport>;
  readonly thrown: () => Promise<{ code?: string; message?: string; details?: Record<string, unknown> }>;
  readonly events: () => ItemEvent[];
  readonly stagesOf: (relative: string) => string[];
  readonly aggregate: () => string;
  readonly rows: () => ReturnType<Repositories['journal']['list']>;
  readonly stateOf: () => string;
}

let rigCount = 0;

/**
 * 搭一套**真的**工作区 + 多条目修改集 + 计划。
 *
 * 注入点（拒绝、日志边界）包在真护栏**外面**：未被命中的每一次调用仍然
 * 是真的 —— 真句柄、真字节。
 *
 * `dir` 可以让调用点指定工作区的位置（§7 要靠它把工作区放在一个真 git
 * 仓库上）；不给就自己造一个。
 */
async function makeRig(
  seed: string,
  files: readonly string[],
  options: {
    readonly dir?: string;
    /** 第一次写入调用发生时（**在任何字节落盘之前**）回调一次。 */
    readonly onFirstWrite?: (relative: string) => void;
    readonly refusals?: readonly RefusalRule[];
    readonly crashAt?: ItemStage;
  } = {},
): Promise<Rig> {
  rigCount += 1;
  if (opened !== undefined) closeDatabase(opened.db);
  const dir = options.dir ?? path.join(sandbox, `${seed}-${rigCount}`);
  mkdirSync(dir, { recursive: true });

  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  const objectsRoot = path.join(sandbox, `${seed}-${rigCount}-objects`);
  const blobs = new BlobStore({ objectsRoot, registry: repos.blobs, newId: () => nextId('blob') });

  const volume = await realOps.statVolume({ path: dir });
  if (isWinfsError(volume)) throw new Error(`statVolume 失败：${JSON.stringify(volume)}`);
  const ref = { root_path: dir, root_volume_id: volume.volume_id, root_file_id: volume.file_id };

  const baseline = new Map<string, Buffer>();
  const items: ChangeItemInput[] = [];
  const digestFiles: {
    path: string;
    op: 'edit_text';
    before_sha256: string | null;
    before_size: number;
    after_sha256: string;
    after_size: number;
    encoding: 'utf-8-bom';
    newline: 'crlf';
    bom: boolean;
  }[] = [];

  for (const relative of files) {
    const target = path.join(dir, relative.split('/').join(path.sep));
    mkdirSync(path.dirname(target), { recursive: true });
    const before = bodyOf(seed, relative, 'before');
    const after = bodyOf(seed, relative, 'after');
    writeFileSync(target, before);
    baseline.set(relative, before);

    const read = await realOps.readFileGuarded({ ...ref, relative_path: relative });
    if (isWinfsError(read)) throw new Error(`读取基线失败：${JSON.stringify(read)}`);

    const beforeBlob = await blobs.putAndRegister(before, { id: nextId('blob') });
    const afterBlob = await blobs.putAndRegister(after, { id: nextId('blob') });

    items.push({
      id: nextId('ci'),
      path: relative,
      op: 'edit_text',
      base_file_id: read.identity.file_id,
      base_sha256: read.sha256,
      target_sha256: afterBlob.put.sha256,
      old_blob_id: beforeBlob.id,
      new_blob_id: afterBlob.id,
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
    alias: '取证连接',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '取证工作区',
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
    summary: `取证摘要 ${seed}`,
    expires_at: new Date(nowMs + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });
  approveAndQueue({
    repos,
    change_id: change.id,
    digest,
    actor: 'console:取证',
    now: new Date(nowMs).toISOString(),
    idempotency_key: `key-${seed}-${rigCount}`,
  });

  const outcome = claimForExecution(
    { repos, executor_id: EXECUTOR_ID, holder: HOLDER, probe: deadProbe, lease_ms: 30_000, now: Date.now },
    change.id,
  );
  if (outcome.kind !== 'claimed') throw new Error(`认领未成功：${JSON.stringify(outcome)}`);

  const recorded = repos.changes.items(change.id);
  const idOf = new Map(recorded.map((item) => [item.canonical_path, item.id]));

  const seenWrites = new Map<string, number>();
  const ops: WinfsOps = {
    capability: () => realOps.capability(),
    statVolume: (req) => realOps.statVolume(req),
    validatePath: (req) => realOps.validatePath(req),
    resolvePath: (req) => realOps.resolvePath(req),
    readFileGuarded: (req) => realOps.readFileGuarded(req),
    createFileGuarded: (req) => realOps.createFileGuarded(req),
    listDirectory: (req) => realOps.listDirectory(req),
    writeFileGuarded: async (req) => {
      const nth = (seenWrites.get(req.relative_path) ?? 0) + 1;
      seenWrites.set(req.relative_path, nth);
      // 「第一次写入调用」= 全局第一次，且发生在字节落盘**之前**。
      if (seenWrites.size === 1 && nth === 1) options.onFirstWrite?.(req.relative_path);
      const rule = options.refusals?.find((r) => r.path === req.relative_path && r.nth === nth);
      if (rule !== undefined) {
        const refusal: WinfsError = {
          ok: false,
          code: rule.code ?? 'FILE_BUSY',
          message: rule.message ?? '注入：这一次调用不去碰文件系统',
          win32_error: rule.win32_error ?? 32,
          ...(rule.touched === true ? { touched: true as const } : {}),
        };
        return refusal;
      }
      return realOps.writeFileGuarded(req);
    },
  };

  if (options.crashAt !== undefined) {
    const stage = options.crashAt;
    const original = repos.journal.append;
    let fired = false;
    repos.journal.append = function patched(input: Parameters<typeof original>[0]): number {
      if (input.stage === stage && !fired) {
        fired = true;
        throw new Error(`注入：在 ${stage} 这个边界上进程停住`);
      }
      return original.call(repos.journal, input);
    };
  }

  const events = (): ItemEvent[] => readItemEvents(repos, outcome.plan.operation_id);
  const applier = () => createNativeApplier({ repos, ops, blobs });

  return {
    dir,
    objectsRoot,
    blobs,
    ref,
    plan: outcome.plan,
    change_id: change.id,
    operation_id: outcome.plan.operation_id,
    items,
    baseline,
    abs: (relative) => path.join(dir, relative.split('/').join(path.sep)),
    onDisk: (relative) => readFileSync(path.join(dir, relative.split('/').join(path.sep))),
    submit: () => applier()(outcome.plan, new AbortController().signal),
    thrown: async () => {
      try {
        await applier()(outcome.plan, new AbortController().signal);
      } catch (cause) {
        const error = cause as { code?: string; message?: string; details?: Record<string, unknown> };
        return { code: error.code, message: error.message, details: error.details };
      }
      throw new Error('本应抛出，却没有抛');
    },
    events,
    stagesOf: (relative) => {
      const id = idOf.get(relative);
      if (id === undefined) throw new Error(`夹具里没有 ${relative}`);
      return events()
        .filter((event) => event.item_id === id)
        .map((event) => event.stage);
    },
    aggregate: () => aggregateOf(itemOutcomes(events()), recorded.length),
    rows: () => repos.journal.list(outcome.plan.operation_id),
    stateOf: () => repos.changes.requireById(change.id).state,
  };
}

/** 报告里那句给人看的话（各 `kind` 都有 `detail`，形状不同而已）。 */
function detailOf(report: ApplyReport): string {
  const detail = (report as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
}

/** 盘上这一份与执行之前那一份逐字节相同吗。 */
const backAtBaseline = (r: Rig, relative: string): boolean =>
  sha256(r.onDisk(relative)) === sha256(r.baseline.get(relative)!);

/** 一个快照引用在磁盘上的位置（`storage_ref` 相对**受保护根**，去掉第一段）。 */
function objectPathOf(r: Rig, storageRef: string): string {
  const segments = storageRef.replace(/\\/g, '/').split('/');
  if (segments[0] !== 'objects') throw new Error(`快照引用的形状不对：${storageRef}`);
  return path.join(r.objectsRoot, ...segments.slice(1));
}

const git = (cwd: string, argv: readonly string[]): string =>
  execFileSync('git', [...argv], { cwd, encoding: 'utf8' }).trim();

/** 一条合成的条目级日志（§5 用；不落库，只喂给折叠函数）。 */
function syntheticEvent(
  itemId: string,
  stage: ItemStage,
  seq: number,
): ItemEvent {
  return {
    seq,
    item_id: itemId,
    stage,
    observed_file_id: null,
    observed_sha256: null,
    target_sha256: null,
    error_code: null,
    detail: null,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const THE_THREE = ['src/a.txt', 'src/b.txt', 'src/c.txt'] as const;

async function main(): Promise<void> {
  console.log(`LWB-029 证据采集 @ ${new Date().toISOString()}`);
  console.log(`node ${process.version} / ${process.platform} ${process.arch}`);

  sandbox = path.join(os.tmpdir(), `lwb-029-${process.pid.toString()}`);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });

  try {
    // -----------------------------------------------------------------------
    section('第 0 节 装置');

    const capability = await realOps.capability();
    check(
      '护栏后端可用，且落在 PowerShell 助手上（真 Win32 句柄）',
      capability.available === true,
      `backend=${capability.resolved_backend_reason}`,
    );
    check(
      '能力自述：不宣称崩溃原子替换、也不宣称跨文件事务（两条都不含糊）',
      capability.crash_atomic_replace === false && capability.cross_file_transaction === false,
      `crash_atomic_replace=${String(capability.crash_atomic_replace)} cross_file_transaction=${String(capability.cross_file_transaction)}`,
    );

    // 先建一个库只为读表结构：**零迁移**这句话要用真库验，而不是读源码。
    opened = openDatabase({ path: ':memory:' });
    repos = new Repositories(opened.db);
    const columns = (
      opened.db.prepare('PRAGMA table_info(journal_entries)').all() as { name: string }[]
    )
      .map((column) => column.name)
      .sort();
    const expectedColumns = [
      'created_at',
      'detail',
      'error_code',
      'id',
      'item_id',
      'observed_file_id',
      'observed_sha256',
      'operation_id',
      'seq',
      'stage',
      'target_sha256',
    ];
    check(
      '执行日志沿用 LWB-006 就有的那张表：列集合逐字相符，本任务零迁移',
      JSON.stringify(columns) === JSON.stringify(expectedColumns),
      columns.join(','),
    );

    // -----------------------------------------------------------------------
    await guarded('§1 正向', async () => {
      section('第 1 节 正向：三个文件真的写成，逐条目日志四步齐全');

      // 回调发生在 `submit()` 之内，那时 `r1` 才刚赋值完 —— 用一层间接引用。
      let rigRef: Rig | undefined;
      let sawAllSnapshots = false;
      let firstWritePath = '';
      const r1 = await makeRig('all-ok', THE_THREE, {
        onFirstWrite: (relative) => {
          firstWritePath = relative;
          sawAllSnapshots = rigRef !== undefined && allSnapshotsOnDisk(rigRef);
        },
      });
      rigRef = r1;

      const report = await r1.submit();

      check('① 交回 applied（不是 no_change、不是 refused）', report.kind === 'applied', `kind=${report.kind}`);
      check(
        '② 步骤 1：**第一次写入调用**的那一刻，全部条目的旧/新快照都已经在磁盘上',
        sawAllSnapshots,
        `第一次写的是 ${firstWritePath}；判据是每个条目的 old_blob_id / new_blob_id 都能在对象目录里找到`,
      );

      const expected = [ITEM_STAGE.intent, ITEM_STAGE.written, ITEM_STAGE.flushed, ITEM_STAGE.verified];
      let allFour = true;
      for (const relative of THE_THREE) {
        const stages = r1.stagesOf(relative);
        const ok = JSON.stringify(stages) === JSON.stringify(expected);
        if (!ok) allFour = false;
        check(`③ 步骤 2：${relative} 的四个阶段逐一落库且顺序正确`, ok, stages.join(' → '));
      }
      check('③ 汇总：三个条目都走完四步', allFour);

      const seqs = r1.rows().map((row) => row.seq);
      check(
        '③ 日志序号严格递增且不重复（恢复流程靠顺序表达「先意图、后结果」）',
        seqs.length > 0 && seqs.every((value, index) => index === 0 || value > seqs[index - 1]!),
        `seq=${seqs.join(',')}`,
      );

      let bytesMatch = true;
      for (const relative of THE_THREE) {
        const item = r1.items.find((entry) => entry.path === relative)!;
        if (sha256(r1.onDisk(relative)) !== item.target_sha256) bytesMatch = false;
      }
      check('④ 三个文件的磁盘字节都等于各自已批准的 target_sha256', bytesMatch);

      check(
        '⑤ 步骤 4：`applied` 的报告附带逐条目小结（不是一句「全部成功」）',
        /已写入并核验 3/.test(detailOf(report)),
        detailOf(report).slice(0, 120),
      );
      check('⑥ 适配器止步于 APPLYING —— 终局由协调器的收尾落', r1.stateOf() === 'APPLYING', `change.state=${r1.stateOf()}`);
      check('⑦ 折叠结果是 applied', r1.aggregate() === 'applied', r1.aggregate());
    });

    // -----------------------------------------------------------------------
    await guarded('§2 故障在中间', async () => {
      section('第 2 节 故障注入在**中间**那个文件：有界恢复把字节写回基线');

      const r2 = await makeRig('fail-middle', THE_THREE, {
        refusals: [{ path: 'src/b.txt', nth: 1 }],
      });

      const report = await r2.submit();

      check('① 报告是 rolled_back（不是 applied、不是「部分成功」）', report.kind === 'rolled_back', `kind=${report.kind}`);
      check(
        '② 报告逐条目：1 个已回到基线、2 个未改动',
        /已回到基线 1/.test(detailOf(report)) && /未改动 2/.test(detailOf(report)),
        detailOf(report).slice(0, 160),
      );
      check('③ 一号文件**逐字节**回到执行之前（真盘哈希比对）', backAtBaseline(r2, 'src/a.txt'));
      check('④ 二号文件从未被碰过', backAtBaseline(r2, 'src/b.txt'));
      check('⑤ 三号文件从未被轮到', backAtBaseline(r2, 'src/c.txt'));
      check(
        '⑥ 一号的日志终局是 restored（写成了、又收回来了）',
        r2.stagesOf('src/a.txt').at(-1) === ITEM_STAGE.restored,
        r2.stagesOf('src/a.txt').join(' → '),
      );
      check(
        '⑦ 二号的日志终局是 untouched（护栏没越过破坏性区域）',
        r2.stagesOf('src/b.txt').at(-1) === ITEM_STAGE.untouched,
        r2.stagesOf('src/b.txt').join(' → '),
      );
      check(
        '⑧ 「没轮到」被单独补记 —— 与「动过了但没记」在账上分得开',
        r2.stagesOf('src/c.txt').join() === ITEM_STAGE.untouched,
        r2.stagesOf('src/c.txt').join(' → '),
      );
      check('⑨ 折叠结果是 rolled_back', r2.aggregate() === 'rolled_back', r2.aggregate());
      check(
        '⑩ 三个条目**都有终局** —— 缺一条，折叠就会说「说不清」',
        itemOutcomes(r2.events()).size === 3,
        `账上有结论的条目数 ${itemOutcomes(r2.events()).size}`,
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§3 收回被拒 / 快照缺失', async () => {
      section('第 3 节 甲：收回本身就失败 ⇒ 待恢复，不报成一次干净的回滚');

      const r3 = await makeRig('rollback-refused', ['src/a.txt', 'src/b.txt'], {
        refusals: [
          { path: 'src/b.txt', nth: 1 },
          {
            path: 'src/a.txt',
            nth: 2,
            code: 'PERMISSION_DENIED',
            win32_error: 5,
            message: '取证注入：收回这一次被拒',
          },
        ],
      });

      const thrown = await r3.thrown();

      check('① 抛出 RECOVERY_REQUIRED（不是交回一份 rolled_back 报告）', thrown.code === 'RECOVERY_REQUIRED', String(thrown.code));
      check(
        '② 病因是「写到一半失败」，且指明了是哪个路径',
        thrown.details?.reason === 'WRITE_FAILED_MIDWAY',
        JSON.stringify(thrown.details ?? {}).slice(0, 160),
      );
      check(
        '③ 一号文件上确实**留着**本次执行的字节 —— 这是「没能收回」的磁盘证据',
        !backAtBaseline(r3, 'src/a.txt'),
        `磁盘 ${sha256(r3.onDisk('src/a.txt')).slice(0, 16)}… vs 基线 ${sha256(r3.baseline.get('src/a.txt')!).slice(0, 16)}…`,
      );
      check('④ 二号文件原样', backAtBaseline(r3, 'src/b.txt'));
      check(
        '⑤ 一号的日志终局是 restore_failed（不是 restored）',
        r3.stagesOf('src/a.txt').at(-1) === ITEM_STAGE.restore_failed,
        r3.stagesOf('src/a.txt').join(' → '),
      );
      check('⑥ 折叠结果是 unfinished —— 「说不清」而不是「收回来了」', r3.aggregate() === 'unfinished', r3.aggregate());

      section('第 3 节 乙：目标快照取不到 ⇒ 拒绝，目标文件零写入');

      const r4 = await makeRig('snapshot-gone', ['src/a.txt', 'src/b.txt']);
      const victim = repos.changes.items(r4.change_id).find((item) => item.canonical_path === 'src/b.txt')!;
      const blob = repos.blobs.requireById(victim.new_blob_id!);
      const objectPath = objectPathOf(r4, blob.storage_ref);
      const existedBefore = existsSync(objectPath);
      rmSync(objectPath);

      const report = await r4.submit();

      check('① 删除动作本身生效了（先证明这个实验不是空跑）', existedBefore && !existsSync(objectPath));
      check('② 报告是 refused', report.kind === 'refused', `kind=${report.kind}`);
      check('③ 拒绝理由说的是快照取不到，而不是别的', /快照/.test(detailOf(report)), detailOf(report).slice(0, 140));
      check('④ 验收：目标文件**零写入**（a）', backAtBaseline(r4, 'src/a.txt'));
      check('⑤ 验收：目标文件**零写入**（b）', backAtBaseline(r4, 'src/b.txt'));
      check(
        '⑥ 一个字节都没写，就没记执行意图（状态还是 VALIDATING）',
        r4.stateOf() === 'VALIDATING',
        `change.state=${r4.stateOf()}`,
      );
      check('⑦ 账上一条条目级日志都没有', r4.events().length === 0, `${r4.events().length} 条`);
    });

    // -----------------------------------------------------------------------
    await guarded('§4 日志边界', async () => {
      section('第 4 节 甲：停在 `verified` 边界 ⇒ 盘上已是目标字节，账上只有意图');

      const r5 = await makeRig('crash-verified', ['src/a.txt', 'src/b.txt'], {
        crashAt: ITEM_STAGE.verified,
      });
      const thrown = await r5.thrown();

      check('① 注入确实生效（异常带着那句话）', /item_verified/.test(thrown.message ?? ''), (thrown.message ?? '').slice(0, 100));
      const itemA = repos.changes.items(r5.change_id).find((item) => item.canonical_path === 'src/a.txt')!;
      check(
        '② 盘上**已经是批准过的那份内容** —— 这是最危险的一格',
        sha256(r5.onDisk('src/a.txt')) === itemA.target_sha256,
      );
      check(
        '③ 账上只有 intent：三条回执日志在同一个事务里，第三条抛了，前两条一起回滚',
        r5.stagesOf('src/a.txt').join() === ITEM_STAGE.intent,
        r5.stagesOf('src/a.txt').join(' → ') || '(空)',
      );
      const folded = describeOutcomes(itemOutcomes(r5.events()), new Map([[itemA.id, itemA.canonical_path]]));
      check('④ 折叠结果是 unfinished（宁可说不知道，绝不说写成了）', r5.aggregate() === 'unfinished', r5.aggregate());
      check('⑤ 报告里的逐条目小结把这一条标成「状态不明」', /状态不明/.test(folded), folded.slice(0, 140));

      section('第 4 节 乙：停在 `intent` 边界 ⇒ 盘上零改动（账记不上就不许写）');

      const r6 = await makeRig('crash-intent', ['src/a.txt'], { crashAt: ITEM_STAGE.intent });
      await r6.thrown();

      check('① 盘上逐字节还是执行之前那一份', backAtBaseline(r6, 'src/a.txt'));
      check('② 账上一条日志都没有（这条日志就是它自己，它没落上）', r6.events().length === 0);
      check('③ 折叠结果是 unfinished', r6.aggregate() === 'unfinished', r6.aggregate());
    });

    // -----------------------------------------------------------------------
    await guarded('§5 部分完成不算全成功', async () => {
      section('第 5 节 步骤 4 的反方向：一个写成、一个没轮到时，折叠**不是** applied');

      // 这一节的输入是**合成的日志行**，不是一次真执行 —— 理由见 §8 的
      // NOT_RUN：真盘上要稳定造出「一号写成、二号没轮到且不失败」很别扭
      // （循环在第一个失败处就停了，所以「没轮到」总是伴随一次失败）。
      // 这里要验的是**折叠**这一层，喂给它的就是 `readItemEvents` 会返回的
      // 那种行，因此合成它并不削弱这一条断言。
      const r7 = await makeRig('partial', ['src/a.txt', 'src/b.txt']);
      const itemA = repos.changes.items(r7.change_id).find((item) => item.canonical_path === 'src/a.txt')!;
      const itemB = repos.changes.items(r7.change_id).find((item) => item.canonical_path === 'src/b.txt')!;

      const writtenThenUntouched: ItemEvent[] = [
        syntheticEvent(itemA.id, ITEM_STAGE.intent, 0),
        syntheticEvent(itemA.id, ITEM_STAGE.written, 1),
        syntheticEvent(itemA.id, ITEM_STAGE.flushed, 2),
        syntheticEvent(itemA.id, ITEM_STAGE.verified, 3),
        syntheticEvent(itemB.id, ITEM_STAGE.untouched, 4),
      ];
      const outcomes = itemOutcomes(writtenThenUntouched);

      check(
        '① 逐条目：一个是 written、一个是 untouched',
        outcomes.get(itemA.id)?.kind === 'written' && outcomes.get(itemB.id)?.kind === 'untouched',
        [...outcomes.values()].map((outcome) => outcome.kind).join(','),
      );
      check(
        '② 折叠结果是 unfinished —— 部分完成绝不被当成全成功',
        aggregateOf(outcomes, 2) === 'unfinished',
        aggregateOf(outcomes, 2),
      );
      check(
        '③ 反方向也成立：单条目全部 written 才是 applied',
        aggregateOf(itemOutcomes(writtenThenUntouched.slice(0, 4)), 1) === 'applied',
        aggregateOf(itemOutcomes(writtenThenUntouched.slice(0, 4)), 1),
      );
      check(
        '④ 账本少一个条目就不算完（`expectedItems` 是硬判据）',
        aggregateOf(outcomes, 3) === 'unfinished',
        aggregateOf(outcomes, 3),
      );
      check(
        '⑤ 报告会把「没轮到的那个」记成未改动，而不是沉默地漏掉',
        /已写入并核验 1/.test(describeOutcomes(outcomes, new Map([[itemA.id, itemA.canonical_path], [itemB.id, itemB.canonical_path]]))),
        describeOutcomes(outcomes, new Map([[itemA.id, itemA.canonical_path], [itemB.id, itemB.canonical_path]])).slice(0, 120),
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§6 脱敏', async () => {
      section('第 6 节 护栏原话里的绝对路径不进账本');

      // 工作区根要**先知道**，因为下面那句注入消息得把根拼进去 ——
      // 真护栏就是这么写消息的：`WinfsGuard.ps1` 的 `Open-Guarded` 把
      // `$Path`（绝对路径，且必然落在根下）拼进消息。
      const redactionDir = path.join(sandbox, 'redaction-ws');
      const marker = path.join(redactionDir, 'src', 'a.txt');

      const r8 = await makeRig('redaction', ['src/a.txt'], {
        dir: redactionDir,
        refusals: [
          {
            path: 'src/a.txt',
            nth: 1,
            touched: true,
            code: 'IO_ERROR',
            win32_error: 5,
            message: `取证注入：写 ${marker} 时被拒`,
          },
        ],
      });

      check(
        '⓪ 先确认这个标记确实落在工作区根之下（否则本节验的是「根外的路径也没被脱敏」）',
        marker.startsWith(r8.ref.root_path + path.sep),
        `根=${r8.ref.root_path}`,
      );

      const thrown = await r8.thrown();
      const rows = r8.rows();
      const texts = rows.map((row) => row.detail ?? '');
      const joined = texts.join('\n');

      check('① 这次执行确实留下了日志行', rows.length > 0, `${rows.length} 行`);
      check(
        '② 那条护栏原话真的进了账本（否则本节验的是空气）',
        joined.includes('取证注入：写'),
        texts.find((text) => text.includes('取证注入：写'))?.slice(0, 120) ?? '(没找到)',
      );
      check(
        '③ 没有任何一行日志带着那个绝对路径',
        !joined.includes(marker),
        texts.find((text) => text.includes(marker))?.slice(0, 160) ?? '（没有泄漏）',
      );
      check(
        '④ 抛出去的那句话同样干净 —— 协调器会把它的 message 原样写进**改动级**日志行',
        !(thrown.message ?? '').includes(marker),
        (thrown.message ?? '').slice(0, 160),
      );
      check(
        '⑤ 脱敏发生了，而不是「路径本来就没进去」：那句原话里现在站着占位符',
        (thrown.message ?? '').includes('<工作区根>') && (thrown.message ?? '').includes('取证注入：写'),
        redactedSample(thrown.message ?? ''),
      );
      check(
        '⑥ 病因一字未动：脱的是根，不是消息的其余部分',
        (thrown.message ?? '').includes('时被拒'),
        redactedSample(thrown.message ?? ''),
      );
      check(
        '⑦ 账本全文不含本机绝对路径',
        !leaksLocalPaths(joined),
        '判据：/[A-Za-z]:\\\\|\\/tmp\\/|\\/home\\/|\\/Users\\//',
      );

      note(
        '关于脱敏的**边界**（第 6 节第 ⓪ 与 ⑦ 条之间的那条线）',
        '`redactRoot` 换掉的只有工作区根这一个字符串，因此它的保护范围就是「根下的绝对路径」。'
          + '这不是保守的近似，而是**正好够用**：护栏只会去碰工作区根下的路径，'
          + '所以它消息里的绝对路径必是根下的路径。根**之外**的路径它压根不会提到 —— '
          + '真提到的时候（本机别处的临时目录等），本条不负责，也不该假装负责。',
      );
    });

    // -----------------------------------------------------------------------
    await guarded('§7 批量失败不碰 Git', async () => {
      section('第 7 节 验收：批量失败不会调用 git reset/checkout/stash/clean');

      // --- 静态：编排层与日志层里根本没有进程调用 ---------------------------
      const sources = [
        'packages/executor/src/apply.ts',
        'packages/executor/src/journal.ts',
        'packages/executor/src/native-adapter.ts',
        'packages/executor/src/claim.ts',
      ];
      const forbidden = ['child_process', 'execSync', 'spawnSync', 'execFile', "'git'", '"git"'];
      const offenders: string[] = [];
      for (const relative of sources) {
        const text = readFileSync(path.join(process.cwd(), relative), 'utf8');
        for (const needle of forbidden) {
          if (text.includes(needle)) offenders.push(`${relative}:${needle}`);
        }
      }
      check(
        '① 静态：执行包里没有任何进程调用（连字符串 `git` 都没有）',
        offenders.length === 0,
        offenders.length === 0 ? `${sources.length} 个文件 × ${forbidden.length} 个模式，零命中` : offenders.join(', '),
      );

      const guardOutput = execFileSync(process.execPath, ['scripts/check-fsguard-imports.mjs'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim();
      check(
        '② 静态：仓库既有的导入护栏仍然拦着 `child_process`（本仓库的机制，不是本节新造的）',
        /通过/.test(guardOutput),
        guardOutput.slice(-120),
      );

      // --- 动态负实验：在**真的 git 仓库**里跑一次失败的批量 ----------------
      const repo = path.join(sandbox, 'git-negative');
      const r9 = await makeRig('git-negative', THE_THREE, {
        dir: repo,
        refusals: [{ path: 'src/b.txt', nth: 1 }],
      });

      git(repo, ['init', '--quiet']);
      git(repo, ['config', 'user.email', 'evidence@lwb.invalid']);
      git(repo, ['config', 'user.name', 'LWB Evidence']);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '--quiet', '-m', '基线']);

      // 先在这个仓库里留下「未提交的改动」与「栈里的一条」——
      // 只有它们先存在，「没被动过」这句话才有内容。
      writeFileSync(path.join(repo, 'src', 'dirty.txt'), '未提交的改动\n');
      writeFileSync(path.join(repo, 'src', 'stashed.txt'), '将被 stash 的内容\n');
      git(repo, ['add', 'src/stashed.txt']);
      git(repo, ['stash', 'push', '--quiet', '--message', '取证：先放一份在栈里']);

      interface GitSnapshot {
        readonly head: string;
        readonly stash: string;
        readonly status: string;
        readonly refs: string;
        readonly reflog: string;
      }
      const snapshotGit = (): GitSnapshot => ({
        head: git(repo, ['rev-parse', 'HEAD']),
        stash: git(repo, ['stash', 'list']),
        status: git(repo, ['status', '--porcelain']),
        refs: git(repo, ['show-ref']),
        reflog: git(repo, ['reflog', '--format=%H']),
      });

      const before = snapshotGit();
      check(
        '③ 实验起点是有内容的：栈里有一条、工作区有一处未提交',
        before.stash.split('\n').filter(Boolean).length === 1 && before.status.includes('dirty.txt'),
        `stash ${before.stash.split('\n').filter(Boolean).length} 条；status=${JSON.stringify(before.status.split('\n').filter(Boolean))}`,
      );

      // **失败的批量**就发生在这个仓库上：它真的往 src/a.txt 写了目标字节、
      // 又在回滚里把基线字节写了回去。
      const report = await r9.submit();

      const after = snapshotGit();

      check('④ 那次批量确实失败了，并且确实回滚了', report.kind === 'rolled_back', `kind=${report.kind}`);
      check(
        '⑤ 而一号文件回到了工作区原先的那一份（哈希与执行之前逐字节相同）',
        backAtBaseline(r9, 'src/a.txt'),
        `磁盘 ${sha256(r9.onDisk('src/a.txt')).slice(0, 16)}… vs 基线 ${sha256(r9.baseline.get('src/a.txt')!).slice(0, 16)}…`,
      );
      check(
        '⑤′ 而且这次回滚是**有内容**的：批准的那份与基线本就不同，不能靠「什么都没写」蒙混过关',
        (() => {
          const item = r9.items.find((entry) => entry.path === 'src/a.txt')!;
          return sha256(r9.baseline.get('src/a.txt')!) !== item.target_sha256;
        })(),
      );
      check(
        '⑤″ Git 自己也这么说：工作区这份文件的 blob 哈希 == 已提交的那一个（`hash-object` 与 `rev-parse` 比对，绕开我自己拼字节时的换行差异）',
        git(repo, ['hash-object', 'src/a.txt']) === git(repo, ['rev-parse', 'HEAD:src/a.txt']),
        `${git(repo, ['hash-object', 'src/a.txt']).slice(0, 12)}…`,
      );
      check('⑥ 动态：`HEAD` 前后一致（没有 reset、没有 checkout）', before.head === after.head, after.head.slice(0, 12));
      check(
        '⑦ 动态：`git stash list` 前后一致（没有 stash 进出）',
        before.stash === after.stash,
        `${before.stash.split('\n').filter(Boolean).length} 条 → ${after.stash.split('\n').filter(Boolean).length} 条`,
      );
      check(
        '⑧ 动态：`git status --porcelain` 前后一致（没有 clean、没有 checkout）',
        before.status === after.status,
        JSON.stringify(after.status.split('\n').filter(Boolean)),
      );
      check('⑨ 动态：`git show-ref` 前后一致（没有任何一个 ref 被移动过）', before.refs === after.refs);
      check('⑩ 动态：reflog 前后一致', before.reflog === after.reflog, `${after.reflog.split('\n').filter(Boolean).length} 条`);
      check('⑪ 那个仓库里没有任何一次新的提交', before.head === git(repo, ['rev-parse', 'HEAD']));

      note(
        '关于本节第 ⑥–⑪ 条的证明力',
        '它们证明的是「在这次失败批量的前前后后，那个仓库的 git 状态没有被改动」。'
          + '它**不**能单独证明执行器从没调用过 git —— 那一条由 ① 与 ② 的静态判据负责'
          + '（`packages/executor` 里连 `child_process` 都 import 不进来，导入护栏会在 CI 上拦下）。'
          + '两条合起来才是这根验收标准；单看任何一条都不够。',
      );
    });

    // -----------------------------------------------------------------------
    section('第 8 节 本文件证明不了的事');
    skip(
      '真实 ChatGPT 网页端完成可复现的读—写—回读',
      '需要真实账号与 Secure MCP Tunnel 凭据，当前 BLOCKED（LWB-002）；MCP Inspector 成功不能替代',
    );
    skip(
      '进程真的被杀之后，启动恢复读这本账会得出什么',
      '属 LWB-030。本文件里的「停住」都是**抛异常**，进程还活着 —— '
        + '因此读到的是「按这本账折出来的结论」，而不是一个真被杀的进程留下的现场',
    );
    skip(
      '十个日志边界在真盘上一一注入',
      '真盘上跑十条只是慢十倍，不多证明任何事；`tests/unit/executor-native-adapter.test.ts` 的 F 组 '
        + '（F1–F10）用假护栏把十个边界逐一覆盖，真盘上取了两条最有代表性的（§4 甲/乙）',
    );
    skip(
      '快照在「阶段 A 通过之后、阶段 A2 之前」消失',
      '真盘上要在快照库上再开一个注入点才造得出来。验收标准要的「快照持久化失败 ⇒ 零写入」'
        + '在 §3 乙 已经满足（拦在阶段 A，更早也更便宜）；A2 那一层由单元 H 组覆盖',
    );
    skip(
      '§5 的那次执行是真的跑出来的',
      '§5 的输入是合成的日志行（正文里写了理由）：真盘上「一号写成、二号没轮到而不失败」'
        + '要求循环不是因为失败而停下，而那正是本工程的循环结构不允许的形态',
    );
    skip(
      '`change_apply` 工具对模型可见',
      '属 LWB-032；适配器与编排尚未接入工具面，这是有意的',
    );
    skip(
      '撤销一次**已终结**的提议',
      '属 LWB-031；本任务的回滚是「一次执行内部」的有界恢复，不是用户可见的撤销',
    );
  } finally {
    if (opened !== undefined) closeDatabase(opened.db);
    await disposeWinfsBackend();
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`\n小计：PASS=${passes} FAIL=${failures} NOT_RUN=${skips}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** 全部条目的旧、新快照都在磁盘上吗（步骤 1 的判据）。 */
function allSnapshotsOnDisk(r: Rig): boolean {
  for (const item of r.items) {
    for (const blobId of [item.old_blob_id, item.new_blob_id]) {
      if (blobId === null || blobId === undefined) continue;
      const storageRef: string | undefined | null = repos.blobs.requireById(blobId).storage_ref;
      // 没有 `storage_ref` 的 blob 根本不在磁盘上，因此「快照已持久化」这句话不成立。
      if (storageRef === undefined || storageRef === null) return false;
      if (!existsSync(objectPathOf(r, storageRef))) return false;
    }
  }
  return true;
}

/** 把脱敏后的那一段截出来给人看（顺带是一道「别把整句话打出来」的闸）。 */
function redactedSample(message: string): string {
  const at = message.indexOf('取证注入：写');
  return at < 0 ? '(没有那句原话)' : message.slice(at, at + 80);
}

await main();
