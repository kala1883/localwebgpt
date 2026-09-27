/**
 * LWB-024 可复现证据采集：代次、过期与审批撤销（三条验收标准）。
 *
 *  1. 离线前批准、重连后过期的任务不会自动落盘。
 *  2. 权限缩小时不能应用老计划。
 *  3. 清理不会删除运行中、待恢复或仍在撤销窗口的快照。
 *
 * ## 三条都是否定式的，因此装置必须比「调一次函数看返回值」更硬
 *
 *  - **标准 1** 的主语是「不会」。本脚本不用「函数返回 refused」当证据，而是拿
 *    **同一批落库事实**在两个时刻各判一次：T0 放行、T0+11 分钟拒绝。行没变、
 *    只有 `now` 变了 —— 这才证明了 LWB-024 步骤 2 的那句「不信任排队时校验」：
 *    判定是每次现算的，不是读一个排队时写下的标志位。随后紧跟一条**对照**：把
 *    旧的批准落成 EXPIRED 再签一份新的，同一个修改集在同一时刻又放行了 ——
 *    于是「刚才那次拒绝是冲着过期去的」有了反面对照，而不是靠读代码相信。
 *  - **标准 2** 枚举「权限缩小的每一种形状」，逐条给出**具名的原因**。只断言
 *    「被拒绝」是不够的：一个恒真的拒绝也能让它通过。因此每一格都先断言收缩
 *    **之前**放行，再断言收缩之后拒绝，并断言**是哪一条**绑定不成立。哪几条能
 *    经由真实门禁触发、哪几条今天只有纯函数入口，逐条写明。
 *  - **标准 3** 是唯一需要**真实字节**的一条。第 3 节把字节写到临时目录，跑
 *    **真的** `BlobStore.collectGarbage`，然后数磁盘上的文件 —— 不读返回值就
 *    下结论。并带一条**反向探针**：同一批行、同一时刻，把逐对象判据撤掉再跑
 *    一轮，受保护的那些**会**被删。没有这条反证，「一个都没删」与「本来就没
 *    东西可删」在证据上无法区分。
 *
 * ## 本脚本**不**碰任何工作区
 *
 * 全程只写两个地方：一个 `:memory:` 状态库，以及 `os.tmpdir()` 下的一个临时
 * 对象目录（退出时删除）。**没有任何一次写入发生在被授权的工作区里** ——
 * G2 未通过，P3 门禁要求不得在真实仓库上联调（docs/evidence/g2-read.md）。
 *
 * 用法：node --import tsx scripts/evidence/lwb-024.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { APPLY_ENTRY_STATES, evaluateApplyGate } from '@lwb/approvals';
import { BlobStore, objectPath } from '@lwb/blob-store';
import { canonicalChangeDigest } from '@lwb/changes';
import {
  EXECUTION_BINDING_REASONS,
  INVALIDATABLE_STATES,
  NON_TERMINAL_STATES,
  PENDING_CHANGE_STATES,
  executionBindingErrorCode,
  invalidateChangeSet,
  invalidatePendingForConnection,
  invalidatePendingForWorkspace,
  planSnapshotRetention,
  reclaimedChangeMetadata,
  revalidateExecutionBindings,
  snapshotGuard,
  sweepExpired,
} from '@lwb/changes';
import { CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import { closeDatabase, openDatabase, Repositories } from '@lwb/persistence';
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// 脚手架（与 lwb-020 ~ lwb-023 同一套）
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

async function guarded(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    const error = cause as { code?: string; message?: string };
    check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
  }
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 跑一个外部命令，**成功时也把退出码补成 0**。
 *
 * `execFile` 成功时回调只有 `stdout`/`stderr`，没有 `code` 字段；失败时才把退出码
 * 放在错误的 `code` 上。因此在成功路径上 `result.code` 是 `undefined`，而
 * `undefined === 0` 为假 —— lwb-023 的第一版因此把三条「其实通过了」的检查报成
 * FAIL。一个总在成功时报错的装置，和一个总在失败时报通过的装置一样不能用。
 */
async function exec(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run(command, [...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const PRINCIPAL = 'principal_ev024';
const POLICY_VERSION = 3;
const GENERATION = 5;
const MODE = 'read_propose_apply_with_local_approval';
const ACTOR = 'console:evidence-session';

/** 夹具的「现在」。保留窗口的边界要精确到毫秒，因此时钟是注入的，不是 `new Date()`。 */
const T0 = '2026-09-25T10:00:00.000Z';
const T0_MS = Date.parse(T0);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION = LIMITS.SNAPSHOT_RETENTION_MS;
const MINUTE_MS = 60 * 1000;

let clockNow = T0;
const clock = (): string => clockNow;
let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

const opened: OpenDatabaseResult = openDatabase({ path: ':memory:' });
const repos = new Repositories(opened.db, clock);

/**
 * 一个场景**自带**工作区与连接。
 *
 * 这样「把代次推一格」「把连接禁用」这类不可逆的改动不会溢到别的场景上。
 * 共享一份工作区会让后面每一格的「收缩之前放行」这个前提悄悄失效 ——
 * 而那种失效的表现是某一格报出别的理由，看上去像被测代码错了。
 */
interface FixtureIds {
  readonly workspace_id: string;
  readonly connection_id: string;
}

function makeFixtureIds(seed: string, policyVersion = POLICY_VERSION): FixtureIds {
  const workspaceId = `ws_${seed}`;
  const connectionId = `conn_${seed}`;
  repos.connections.create({
    id: connectionId,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: `夹具连接 ${seed}`,
    enabled: true,
  });
  repos.workspaces.create({
    id: workspaceId,
    alias: `夹具工作区 ${seed}`,
    kind: 'directory',
    canonical_root: `C:\\lwb-024-evidence\\${seed}`,
    volume_id: `vol-${seed}`,
    root_file_id: `root-${seed}`,
    policy_version: policyVersion,
    mode: MODE,
  });
  // `workspaces.create` 从代次 1 开始，而夹具声明的默认代次是常量 5。先把它推
  // 上去，否则「前提：此刻放行」放行的不是「代次相符」，而是「代次恰好也错」。
  while (repos.workspaces.requireById(workspaceId).generation < GENERATION) {
    repos.workspaces.bumpGeneration(workspaceId, policyVersion);
  }
  return { workspace_id: workspaceId, connection_id: connectionId };
}

const PATH_TO: Readonly<Record<string, readonly ChangeSetState[]>> = {
  REJECTED: ['REJECTED'],
  EXPIRED: ['EXPIRED'],
  INVALIDATED: ['INVALIDATED'],
  APPROVED: ['APPROVED'],
  QUEUED: ['APPROVED', 'QUEUED'],
  VALIDATING: ['APPROVED', 'QUEUED', 'VALIDATING'],
  APPLYING: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING'],
  RECOVERY_REQUIRED: ['APPROVED', 'QUEUED', 'RECOVERY_REQUIRED'],
  APPLIED: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'APPLIED'],
  ROLLED_BACK: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'ROLLED_BACK'],
};

/** 沿转移表把一个修改集推到目标状态；`QUEUED` 那一步同时建出操作行。 */
function drive(changeId: string, target: ChangeSetState): void {
  const steps = PATH_TO[target];
  if (steps === undefined) throw new Error(`PATH_TO 缺少 ${target}`);
  let previous: ChangeSetState = 'PENDING_APPROVAL';
  let operationId: string | null = null;
  for (const step of steps) {
    if (step === 'QUEUED') {
      operationId = repos.operations.create({ id: nextId('op'), change_id: changeId }).operation.id;
    } else if (operationId !== null) {
      repos.operations.transition(operationId, [previous], step);
    }
    repos.changes.transition(changeId, [previous], step);
    previous = step;
  }
}

const fakeSha = (seed: string): string => seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

interface Scenario {
  readonly seed: string;
  readonly workspace_id: string;
  readonly connection_id: string;
  readonly change_id: string;
  readonly approval_id: string;
}

interface MakeOptions {
  readonly contract_version?: string;
  readonly policy_version?: number;
  readonly generation?: number;
  readonly expires_at?: string;
  readonly drive_to?: ChangeSetState;
}

/**
 * 一个修改集：摘要走**真的** `canonicalChangeDigest`。
 *
 * 不能用一个「像摘要的串」：门禁会先从落库事实重算摘要再比对，伪造的摘要会在
 * 到达被测判据之前就撞上 `DIGEST_NOT_REPRODUCIBLE` —— 那是夹具的锅，而它在日志
 * 里长得像被测代码有问题。
 */
function makeScenario(seed: string, options: MakeOptions = {}): Scenario {
  const policyVersion = options.policy_version ?? POLICY_VERSION;
  const generation = options.generation ?? GENERATION;
  const contractVersion = options.contract_version ?? CONTRACT_VERSION;
  const ids = makeFixtureIds(seed, policyVersion);

  const beforeBytes = `before-${seed}`;
  const afterBytes = `after-${seed}`;
  const beforeSha = fakeSha(`1${seed}`);
  const afterSha = fakeSha(`2${seed}`);
  const relPath = `src/${seed}.ts`;

  const before = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: beforeSha,
    size: beforeBytes.length,
    storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: afterSha,
    size: afterBytes.length,
    storage_ref: `objects/${afterSha}`,
  }).blob;

  const items: ChangeItemInput[] = [
    {
      id: nextId('ci'),
      path: relPath,
      op: 'edit_text',
      base_file_id: `file-${seed}`,
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 2,
      removed_lines: 1,
    },
  ];

  const change = repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: ids.connection_id,
    workspace_id: ids.workspace_id,
    root_generation: generation,
    policy_version: policyVersion,
    contract_version: contractVersion,
    digest: canonicalChangeDigest({
      contract_version: contractVersion,
      policy_version: policyVersion,
      root_generation: generation,
      workspace_id: ids.workspace_id,
      files: [
        {
          path: relPath,
          op: 'edit_text',
          before_sha256: beforeSha,
          before_size: beforeBytes.length,
          after_sha256: afterSha,
          after_size: afterBytes.length,
          encoding: 'utf-8',
          newline: 'lf',
          bom: false,
        },
      ],
    }),
    summary: `夹具 ${seed}`,
    expires_at: options.expires_at ?? new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  });

  const approval = repos.approvals.create({
    id: nextId('apr'),
    change_id: change.id,
    digest: change.digest,
    actor: ACTOR,
    expires_at: new Date(T0_MS + LIMITS.APPROVAL_TTL_MS).toISOString(),
  });

  if (options.drive_to !== undefined && options.drive_to !== 'PENDING_APPROVAL') {
    drive(change.id, options.drive_to);
  }

  return {
    seed,
    workspace_id: ids.workspace_id,
    connection_id: ids.connection_id,
    change_id: change.id,
    approval_id: approval.id,
  };
}

/** 从一个修改集身上只读地取出门禁判定。 */
function gateOf(changeId: string, now: string): ReturnType<typeof evaluateApplyGate> {
  return evaluateApplyGate({ repos, change_id: changeId, allowed_from: APPLY_ENTRY_STATES, now });
}

/**
 * 一次判定**没有改动任何东西**的证据：把可观察状态串成一个可比较的值。
 *
 * 「门禁只判定、不消费」这句话若只靠读代码相信，那它与「门禁碰巧还没被接上消费
 * 路径」在证据上无法区分。串成一个值，是为了让「判定前后逐字段相同」成为一个
 * 能被断言的命题。
 */
function observableStateOf(changeId: string): string {
  const change = repos.changes.requireById(changeId);
  const approvals = repos.approvals
    .listForChange(changeId)
    .map((a) => `${a.id}:${a.state}`)
    .sort();
  const operation = repos.operations.findByChangeId(changeId);
  const journal = operation === null ? [] : repos.journal.list(operation.id).map((entry) => entry.stage);
  return JSON.stringify({
    change_state: change.state,
    approvals,
    operation_state: operation?.state ?? null,
    journal,
  });
}

/** 递归数一个目录下的文件。用来量「磁盘上还剩几个字节」。 */
async function countFiles(root: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countFiles(path.join(root, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let objectsRoot = '';

async function main(): Promise<void> {
  console.log('LWB-024 证据采集：代次、过期与审批撤销');
  console.log(`仓库根 ${repoRoot}`);
  console.log(`Node ${process.version} / ${process.platform} ${process.arch}`);
  console.log(
    `常量 APPROVAL_TTL=${String(LIMITS.APPROVAL_TTL_MS)}ms CHANGE_TTL=${String(LIMITS.CHANGE_TTL_MS)}ms ` +
      `SNAPSHOT_RETENTION=${String(RETENTION)}ms 契约版本 ${CONTRACT_VERSION}`,
  );

  // =========================================================================
  section('1. 验收标准 1 —— 离线前批准、重连后过期不会自动落盘');
  // =========================================================================

  await guarded('1', () => {
    const scenario = makeScenario('s1', { drive_to: 'APPROVED' });

    // ---- 同一批行，两个时刻 --------------------------------------------
    const offlineEnded = new Date(T0_MS + LIMITS.APPROVAL_TTL_MS + MINUTE_MS).toISOString();
    const before = gateOf(scenario.change_id, T0);
    const after = gateOf(scenario.change_id, offlineEnded);
    const describe = (v: ReturnType<typeof evaluateApplyGate>): string =>
      v.kind === 'refused' ? `${v.kind}/${v.reason}` : v.kind;

    console.log(
      `  同一批落库事实：T0(${T0}) → ${describe(before)}；${offlineEnded} → ${describe(after)}`,
    );
    check('1.1 前提：T0 时刻这条计划是放行的（否则后面的拒绝可能来自别的原因）', before.kind === 'ready');
    check(
      '1.2 离线 11 分钟后落在批准有效期之外：门禁拒绝，理由是「批准过期」',
      after.kind === 'refused' && after.reason === 'APPROVAL_EXPIRED',
      after.kind === 'refused' ? `${after.reason} / ${after.code}` : `实际 ${after.kind}`,
    );
    // 本节的核心：行没变，只有 now 变了。若判定读的是排队时写下的标志位，
    // 两个时刻必然给出同一个答案。
    check(
      '1.3 行没有变、只有 now 变了 —— 判定是每次现算的，不是读排队时写下的标志位',
      before.kind === 'ready' && after.kind === 'refused',
      '同一 change_id、同一批准 id、同一份摘要，两个时刻两个答案',
    );
    // 判定之后批准行本身没有被改写：拒绝是一个**投影**，不是一次写。
    check(
      '1.4 拒绝之后批准行本身没有被改写（只判定，不写）',
      repos.approvals.requireById(scenario.approval_id).state === 'ACTIVE',
      `落库状态仍是 ${repos.approvals.requireById(scenario.approval_id).state}，被投影成 EXPIRED 的只是判定结果`,
    );

    // ---- 对照：换一份新的批准，同一时刻又放行 ----------------------------
    // 没有这条对照，「1.2 拒绝了」就也可能是撞上了别的判据。
    repos.approvals.expireDue(offlineEnded);
    const fresh = repos.approvals.create({
      id: nextId('apr'),
      change_id: scenario.change_id,
      digest: repos.changes.requireById(scenario.change_id).digest,
      actor: ACTOR,
      expires_at: new Date(Date.parse(offlineEnded) + LIMITS.APPROVAL_TTL_MS).toISOString(),
    });
    const refreshed = gateOf(scenario.change_id, offlineEnded);
    check(
      '1.5 对照：同一时刻、同一修改集，换一份未过期的批准后又放行',
      refreshed.kind === 'ready',
      `新批准 ${fresh.id}；实际 ${describe(refreshed)}`,
    );

    // ---- 重连后的启动清理：不留一个「仍然 APPROVED」的旧计划 --------------
    // 这里有两个**不同的**时钟，不是一个：批准 10 分钟，修改集 24 小时。
    // 把它们当成一个，就会把「清理收掉了批准」误读成「这个计划已经落不了盘了」——
    // 反过来，一个只认一条过期时间的实现也会让这一段通过。因此这一格分开问：
    // 收掉的是**批准**，而修改集在它自己的窗口里原地不动。
    const sweepNow = new Date(Date.parse(offlineEnded) + LIMITS.APPROVAL_TTL_MS + MINUTE_MS).toISOString();
    const report = sweepExpired(repos, { now: sweepNow });
    const sweptState = repos.changes.requireById(scenario.change_id).state;
    check(
      '1.6 重连清理收掉的是**批准**（1.5 新签的那份到点作废），修改集仍是 APPROVED',
      repos.approvals.requireById(fresh.id).state === 'EXPIRED' &&
        sweptState === 'APPROVED' &&
        !report.expired_changes.some((o) => o.change_id === scenario.change_id),
      `${sweepNow} 一轮收掉 ${String(report.expired_changes.length)} 个修改集、${String(report.expired_approvals)} 条批准；` +
        `修改集状态 ${sweptState}（它自己的有效期到 ${repos.changes.requireById(scenario.change_id).expires_at}）`,
    );
    const afterSweep = gateOf(scenario.change_id, sweepNow);
    check(
      '1.7 批准过期此时是**行上的事实**，不再只是判定时的投影：门禁给的理由与 1.2 相同，来源换了',
      afterSweep.kind === 'refused' && afterSweep.reason === 'APPROVAL_EXPIRED',
      afterSweep.kind === 'refused' ? `${afterSweep.reason} / ${afterSweep.code}` : `实际 ${afterSweep.kind}`,
    );

    // ---- 修改集自身有效期的那一半（LWB-024 之前写在库里却无人读） --------
    const ttl = makeScenario('s1-ttl', {
      drive_to: 'APPROVED',
      expires_at: new Date(T0_MS + MINUTE_MS).toISOString(),
    });
    const later = new Date(T0_MS + 2 * MINUTE_MS).toISOString();
    const ttlVerdict = gateOf(ttl.change_id, later);
    const ttlApproval = repos.approvals.requireById(ttl.approval_id);
    check(
      '1.8 批准仍有效、修改集自己到期了：拒绝来自修改集那条 24 小时有效期',
      ttlVerdict.kind === 'refused' &&
        ttlVerdict.reason === 'CHANGE_EXPIRED' &&
        ttlApproval.state === 'ACTIVE' &&
        later < ttlApproval.expires_at,
      `批准 ${ttlApproval.state}（${ttlApproval.expires_at} 到期），修改集有效至 ${new Date(T0_MS + MINUTE_MS).toISOString()}`,
    );

    // ---- 只判定不消费 ----------------------------------------------------
    const noconsume = makeScenario('s1-noconsume', { drive_to: 'APPROVED' });
    const snapshotBefore = observableStateOf(noconsume.change_id);
    for (const now of [T0, new Date(T0_MS + 99 * MINUTE_MS).toISOString()]) gateOf(noconsume.change_id, now);
    check(
      '1.9 判定不消费：两次判定（放行一次、拒绝一次）前后，状态与日志逐字段相同',
      observableStateOf(noconsume.change_id) === snapshotBefore,
      snapshotBefore,
    );

    note(
      '1.10 「不自动落盘」这句话在本次采集里能证到哪一步',
      '能证：通往写入的那道门（门禁 + 执行前复核）在所有入口上都拒绝，且拒绝不依赖调用方的自述。' +
        '不能证：文件真的没被写 —— 写入方是执行协调器（LWB-026），尚未交付，因此本脚本观察不到一次真实的落盘尝试。' +
        '这一条列在文末的未执行项里',
    );

    // ---- 反方向：修改集自己的那 24 小时到点后，被收掉的是那一行 ----------
    // 1.6/1.7 证的是「批准过期不连带修改集」。只证这一边的话，一个把
    // 「批准过期」当成唯一过期判据的实现同样能全绿 —— 而它的表现是
    // 一份 24 小时后仍然 APPROVED 的老计划留在库里。
    const longSweepNow = new Date(T0_MS + LIMITS.CHANGE_TTL_MS + MINUTE_MS).toISOString();
    const longReport = sweepExpired(repos, { now: longSweepNow });
    const finalState = repos.changes.requireById(scenario.change_id).state;
    check(
      '1.11 越过修改集自身的有效期后再清一次：那一行被收成 EXPIRED，并出现在清理报告里',
      finalState === 'EXPIRED' && longReport.expired_changes.some((o) => o.change_id === scenario.change_id),
      `${longSweepNow} 收掉 ${String(longReport.expired_changes.length)} 个修改集；状态 ${finalState}`,
    );
  });

  // =========================================================================
  section('2. 验收标准 2 —— 权限缩小时不能应用老计划');
  // =========================================================================

  await guarded('2', () => {
    interface Row {
      readonly name: string;
      readonly shrink: (s: Scenario) => void;
      readonly reasons: readonly string[];
      readonly primary: string;
    }

    // 每一格：先断言收缩**之前**放行，再收缩，再断言拒绝的**具体理由**。
    // 只断言「被拒绝」是不够的 —— 一个恒真的拒绝也能让它通过。
    const rows: readonly Row[] = [
      {
        name: '工作区被停用',
        shrink: (s) => void repos.workspaces.setEnabled(s.workspace_id, false),
        reasons: ['WORKSPACE_DISABLED', 'GENERATION_CHANGED'],
        primary: 'WORKSPACE_DISABLED',
      },
      {
        // 移除不是「把 enabled 放着不管」：`markRemoved` 同时把它置为不可用，
        // 因此这一格的理由有三条。写全的理由是「一次收缩可能同时触发多条判据」，
        // 而门禁给出的 primary 仍是那条**最直接**的（移除先于停用）。
        name: '工作区被移除',
        shrink: (s) => void repos.workspaces.markRemoved(s.workspace_id),
        reasons: ['WORKSPACE_REMOVED', 'WORKSPACE_DISABLED', 'GENERATION_CHANGED'],
        primary: 'WORKSPACE_REMOVED',
      },
      {
        name: '工作区代次前移（重定位 / 重新授权）',
        shrink: (s) => void repos.workspaces.bumpGeneration(s.workspace_id, POLICY_VERSION),
        reasons: ['GENERATION_CHANGED'],
        primary: 'GENERATION_CHANGED',
      },
      {
        name: '策略版本变化（连带代次前移）',
        shrink: (s) => void repos.workspaces.bumpGeneration(s.workspace_id, POLICY_VERSION + 1),
        reasons: ['GENERATION_CHANGED', 'POLICY_VERSION_CHANGED'],
        primary: 'GENERATION_CHANGED',
      },
      {
        name: '归属连接被本地操作者禁用',
        shrink: (s) => void repos.connections.setEnabled(s.connection_id, false),
        reasons: ['CONNECTION_DISABLED'],
        primary: 'CONNECTION_DISABLED',
      },
    ];

    let allOk = true;
    const detail: string[] = [];
    for (const [index, row] of rows.entries()) {
      const scenario = makeScenario(`s2-${index}`, { drive_to: 'APPROVED' });
      const admitted = gateOf(scenario.change_id, T0).kind === 'ready';
      const stateBefore = observableStateOf(scenario.change_id);

      row.shrink(scenario);

      const verdict = gateOf(scenario.change_id, T0);
      const gotPrimary = verdict.kind === 'refused' ? verdict.reason : '(放行)';
      // 门禁的 primary 与纯函数算出的**全部**理由都要对得上：前者是给操作者
      // 的一句话，后者是排障要的全景，两处对同一批事实必须给出同一个答案。
      const binding = revalidateExecutionBindings({
        change: repos.changes.requireById(scenario.change_id),
        workspace: repos.workspaces.findById(scenario.workspace_id),
        connection: repos.connections.findById(scenario.connection_id),
        now: T0,
        allowed_from: INVALIDATABLE_STATES,
      });
      const stateUnchanged = observableStateOf(scenario.change_id) === stateBefore;
      const ok =
        admitted &&
        verdict.kind === 'refused' &&
        gotPrimary === row.primary &&
        JSON.stringify([...binding.reasons]) === JSON.stringify([...row.reasons]) &&
        stateUnchanged;
      if (!ok) allOk = false;

      detail.push(`${row.name}:${gotPrimary}`);
      console.log(
        `  ${row.name}：收缩前=放行 → 收缩后=${gotPrimary}` +
          `（全部理由 ${binding.reasons.join('+') || '(无)'}，码 ${verdict.kind === 'refused' ? verdict.code : '-'}` +
          `，状态未改=${String(stateUnchanged)}）`,
      );
    }
    check('2.1 五条门禁可达的收缩路径逐条：先放行、后拒绝、理由具名、且不动状态', allOk, detail.join('；'));

    // ---- 失效写入的那一半：批量失效 -------------------------------------
    const a = makeScenario('s2-batch-a', { drive_to: 'APPROVED' });
    const b = makeScenario('s2-batch-b', { drive_to: 'APPROVED' });
    const other = makeScenario('s2-batch-other', { drive_to: 'APPROVED' });
    const workspaceReport = invalidatePendingForWorkspace(repos, {
      workspace_id: a.workspace_id,
      trigger: 'POLICY_CHANGED',
      now: T0,
    });
    check(
      '2.2 按工作区批量失效：该工作区的那条被作废，另一个工作区分毫未动',
      workspaceReport.invalidated.length === 1 &&
        repos.changes.requireById(a.change_id).state === 'INVALIDATED' &&
        repos.changes.requireById(b.change_id).state === 'APPROVED' &&
        repos.changes.requireById(other.change_id).state === 'APPROVED',
      `作废 ${String(workspaceReport.invalidated.length)} 条，跳过 ${String(workspaceReport.skipped.length)} 条`,
    );

    const connScenario = makeScenario('s2-conn', { drive_to: 'APPROVED' });
    const connReport = invalidatePendingForConnection(repos, {
      connection_id: connScenario.connection_id,
      trigger: 'CONNECTION_DISABLED',
      now: T0,
    });
    check(
      '2.3 按连接批量失效：该连接名下的一条被作废',
      connReport.invalidated.length === 1 && repos.changes.requireById(connScenario.change_id).state === 'INVALIDATED',
      `作废 ${String(connReport.invalidated.length)} 条`,
    );

    // ---- 失效之后：批准被撤，而且再签一份也复活不了 -----------------------
    const dead = makeScenario('s2-dead', { drive_to: 'APPROVED' });
    const outcome = invalidateChangeSet(repos, { change_id: dead.change_id, trigger: 'WORKSPACE_RELOCATED', now: T0 });
    const refused = gateOf(dead.change_id, T0);
    check(
      '2.4 失效把挂在身上的批准一并收掉，并记下它去了哪里',
      outcome.approval_to === 'REVOKED' && repos.approvals.requireById(dead.approval_id).state === 'REVOKED',
      `approval_to=${String(outcome.approval_to)} trigger=${outcome.trigger}`,
    );
    // 这里曾经写的是 CHANGE_STATE_INVALID，那是把**判定的次序**当成了实现细节。
    // 门禁先问批准、再问修改集状态：一份已被撤销的批准是更**具体**的答案
    // （它说明这次「停」是从批准那头进来的），而「状态不允许」是更笼统的那条。
    // 2.6 才是状态那半边的取证：再签一份批准之后，批准这一格变得无可指摘，
    // 挡住的就只剩修改集状态 —— 那时理由正是 CHANGE_STATE_INVALID。
    check(
      '2.5 被失效的修改集：门禁拒绝，理由是「批准已被撤销」（批准这一格先于状态被问）',
      refused.kind === 'refused' && refused.reason === 'APPROVAL_REVOKED',
      refused.kind === 'refused' ? `${refused.reason} / ${refused.code}` : `实际 ${refused.kind}`,
    );
    // 部分唯一索引只挡「第二条 ACTIVE」，因此这一步在数据库层**会成功** ——
    // 挡住复活的是修改集已经不在 APPROVED。只撤销不失效，等于把一次明确的
    // 「停」变成「再点一下就能继续」。
    const resigned = repos.approvals.create({
      id: nextId('apr'),
      change_id: dead.change_id,
      digest: repos.changes.requireById(dead.change_id).digest,
      actor: ACTOR,
      expires_at: new Date(T0_MS + LIMITS.APPROVAL_TTL_MS).toISOString(),
    });
    const afterResign = gateOf(dead.change_id, T0);
    check(
      '2.6 再签一份批准在数据库层是允许的，但它复活不了这个计划',
      repos.approvals.requireById(resigned.id).state === 'ACTIVE' &&
        afterResign.kind === 'refused' &&
        afterResign.reason === 'CHANGE_STATE_INVALID',
      `新批准 ${resigned.id} 落库状态=${repos.approvals.requireById(resigned.id).state}；门禁=${afterResign.kind}`,
    );

    const multi = makeScenario('s2-multi', { drive_to: 'APPROVED' });
    repos.connections.setEnabled(multi.connection_id, false);
    repos.workspaces.markRemoved(multi.workspace_id);
    const multiVerdict = revalidateExecutionBindings({
      change: repos.changes.requireById(multi.change_id),
      workspace: repos.workspaces.findById(multi.workspace_id),
      connection: repos.connections.findById(multi.connection_id),
      now: T0,
      allowed_from: INVALIDATABLE_STATES,
    });
    check(
      '2.7 多因同时成立时理由**一条不少**，且按固定次序排列（排列与发现顺序无关）',
      multiVerdict.reasons.length >= 3 &&
        JSON.stringify([...multiVerdict.reasons]) ===
          JSON.stringify(EXECUTION_BINDING_REASONS.filter((r) => multiVerdict.reasons.includes(r))) &&
        multiVerdict.primary === 'WORKSPACE_REMOVED',
      `实际 ${multiVerdict.reasons.join('+')}`,
    );

    // ---- 十条理由：能经由门禁触发的，与只有纯函数入口的 -------------------
    const gateReachable = [
      'WORKSPACE_DISABLED',
      'WORKSPACE_REMOVED',
      'GENERATION_CHANGED',
      'POLICY_VERSION_CHANGED',
      'CONNECTION_DISABLED',
      'CHANGE_EXPIRED',
      'CHANGE_STATE_INVALID',
    ];
    const pureOnly = ['WORKSPACE_MISSING', 'OWNER_CONNECTION_MISSING', 'CONTRACT_VERSION_CHANGED'];
    check(
      '2.8 十条理由全部被点到名：七条有真实门禁入口，三条今天只有纯函数入口',
      new Set([...gateReachable, ...pureOnly]).size === EXECUTION_BINDING_REASONS.length &&
        EXECUTION_BINDING_REASONS.every((r) => gateReachable.includes(r) || pureOnly.includes(r)),
      `门禁可达 ${String(gateReachable.length)} 条；纯函数 ${String(pureOnly.length)} 条`,
    );

    // 三条只能由纯函数触发的，逐条给出装置与**为什么门禁到不了**。
    const isolated: readonly (readonly [string, () => string, string])[] = [
      [
        'WORKSPACE_MISSING',
        () => {
          const s = makeScenario('s2-pure-missing', { drive_to: 'APPROVED' });
          return (
            revalidateExecutionBindings({
              change: repos.changes.requireById(s.change_id),
              workspace: null,
              connection: repos.connections.findById(s.connection_id),
              now: T0,
              allowed_from: INVALIDATABLE_STATES,
            }).primary ?? '(无)'
          );
        },
        '`workspaces` 没有删除路径（移除走的是 markRemoved + 代次前移），因此「行不在了」今天造不出来。' +
          '而判据仍必须有：库文件被外部改动、或将来加入清理时，它就是那条路径',
      ],
      [
        'OWNER_CONNECTION_MISSING',
        () => {
          const s = makeScenario('s2-pure-noconn', { drive_to: 'APPROVED' });
          return (
            revalidateExecutionBindings({
              change: repos.changes.requireById(s.change_id),
              workspace: repos.workspaces.findById(s.workspace_id),
              connection: null,
              now: T0,
              allowed_from: INVALIDATABLE_STATES,
            }).primary ?? '(无)'
          );
        },
        '`connections` 没有删除路径（禁用走 setEnabled），同上',
      ],
      [
        'CONTRACT_VERSION_CHANGED',
        () => {
          const s = makeScenario('s2-pure-contract', { drive_to: 'APPROVED', contract_version: 'lwb-contract-0' });
          return (
            revalidateExecutionBindings({
              change: repos.changes.requireById(s.change_id),
              workspace: repos.workspaces.findById(s.workspace_id),
              connection: repos.connections.findById(s.connection_id),
              now: T0,
              allowed_from: INVALIDATABLE_STATES,
            }).primary ?? '(无)'
          );
        },
        '它的真实触发是**契约升级**：升级前建立的修改集停在库里，升级后重连时被判为不可执行。' +
          '要经由门禁触发就得真的改掉 CONTRACT_VERSION 并重建修改集，那会把仓库自身的状态带进证据里',
      ],
    ];
    let pureOk = true;
    for (const [expected, runIt, why] of isolated) {
      const got = runIt();
      if (got !== expected) pureOk = false;
      console.log(`  ${expected}: ${got}`);
      console.log(`    门禁不可达的原因：${why}`);
    }
    check('2.9 这三条的纯函数入口逐条成立，且每条都写明了门禁不可达的原因', pureOk);

    check(
      '2.10 每个理由都映射到一个错误码（映射表是全函数）',
      EXECUTION_BINDING_REASONS.every((reason) => /^[A-Z][A-Z_]+$/.test(executionBindingErrorCode(reason))),
      EXECUTION_BINDING_REASONS.map((r) => `${r}→${executionBindingErrorCode(r)}`).join(' '),
    );
  });

  // =========================================================================
  section('3. 验收标准 3 —— 清理不会删除运行中、待恢复或仍在撤销窗口的快照');
  // =========================================================================

  await guarded('3', async () => {
    const store = new BlobStore({ objectsRoot, registry: repos.blobs, newId: () => nextId('blob') });
    const T_YOUNG_END_MS = T0_MS + 6 * DAY_MS;
    const NOW = new Date(T0_MS + RETENTION + 1000).toISOString();

    interface RealFixture {
      readonly label: string;
      readonly change_id: string;
      readonly blobs: readonly string[];
    }

    /** 造一个引用**真实落盘字节**的修改集，并把引用计数打到零。 */
    const withRealBytes = async (
      label: string,
      target: ChangeSetState,
      driveAtMs: number | null,
    ): Promise<RealFixture> => {
      clockNow = T0;
      const ids = makeFixtureIds(`s3-${label}`);
      const beforeBytes = Buffer.from(`before-${label}-${'x'.repeat(24)}`, 'utf8');
      const afterBytes = Buffer.from(`after-${label}-${'y'.repeat(24)}`, 'utf8');
      const before = await store.putAndRegister(beforeBytes, { id: nextId('blob') });
      const after = await store.putAndRegister(afterBytes, { id: nextId('blob') });
      const relPath = `src/${label}.ts`;

      const change = repos.changes.create({
        id: nextId('chg'),
        owner_connection_id: ids.connection_id,
        workspace_id: ids.workspace_id,
        root_generation: GENERATION,
        policy_version: POLICY_VERSION,
        contract_version: CONTRACT_VERSION,
        digest: canonicalChangeDigest({
          contract_version: CONTRACT_VERSION,
          policy_version: POLICY_VERSION,
          root_generation: GENERATION,
          workspace_id: ids.workspace_id,
          files: [
            {
              path: relPath,
              op: 'edit_text',
              before_sha256: before.put.sha256,
              before_size: before.put.size,
              after_sha256: after.put.sha256,
              after_size: after.put.size,
              encoding: 'utf-8',
              newline: 'lf',
              bom: false,
            },
          ],
        }),
        summary: `真实字节夹具 ${label}`,
        expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
        items: [
          {
            id: nextId('ci'),
            path: relPath,
            op: 'edit_text',
            base_file_id: `file-${label}`,
            base_sha256: before.put.sha256,
            target_sha256: after.put.sha256,
            old_blob_id: before.id,
            new_blob_id: after.id,
            encoding: 'utf-8',
            bom: false,
            newline: 'lf',
            added_lines: 1,
            removed_lines: 1,
          },
        ],
      });

      // 时刻必须在流转**之前**设好：保留窗口的起点是 `updated_at`，
      // 而它是每次流转写下的。
      if (driveAtMs !== null) clockNow = new Date(driveAtMs).toISOString();
      if (target !== 'PENDING_APPROVAL') drive(change.id, target);
      clockNow = T0;

      repos.blobs.releaseRef(before.id);
      repos.blobs.releaseRef(after.id);

      return { label, change_id: change.id, blobs: [before.id, after.id] };
    };

    const fileOf = (blobId: string): string => objectPath(objectsRoot, repos.blobs.requireById(blobId).sha256);

    // 六个夹具：运行中的两个、待恢复的一个、窗口内的一个、窗口已满的一个，
    // 外加一个**分叉**的 —— 修改集停在 QUEUED，操作却已经进了 RECOVERY_REQUIRED。
    const running = await withRealBytes('running', 'APPLYING', null);
    const validating = await withRealBytes('validating', 'VALIDATING', null);
    const awaiting = await withRealBytes('awaiting', 'RECOVERY_REQUIRED', null);
    const young = await withRealBytes('young', 'APPLIED', T_YOUNG_END_MS);
    const old = await withRealBytes('old', 'APPLIED', T0_MS);
    const diverged = await withRealBytes('diverged', 'QUEUED', null);
    const divergedOp = repos.operations.requireByChangeId(diverged.change_id);
    repos.operations.transition(divergedOp.id, ['QUEUED'], 'RECOVERY_REQUIRED');

    const all = [running, validating, awaiting, young, old, diverged];
    const onDisk = (f: RealFixture): number => f.blobs.filter((id) => existsSync(fileOf(id))).length;
    const filesBefore = await countFiles(objectsRoot);

    check(
      '3.1 前提：这些快照的字节真的在磁盘上，且引用计数已经是零',
      onDisk(running) === 2 &&
        onDisk(young) === 2 &&
        repos.blobs.requireById(young.blobs[0]!).refcount === 0 &&
        repos.blobs.listPendingGc().length >= all.length * 2,
      `磁盘上 ${String(all.reduce((sum, f) => sum + onDisk(f), 0))} 个夹具文件（期望 ${String(all.length * 2)}）；` +
        `待回收 ${String(repos.blobs.listPendingGc().length)} 个`,
    );

    // ---- 保留计划：逐条给出「谁还在等这些字节」 --------------------------
    const plan = planSnapshotRetention(repos, { now: NOW });
    const reasonOf = (changeId: string): string =>
      plan.protected_changes.find((d) => d.change_id === changeId)?.reason ?? '(不在保护清单里)';
    const reasons = new Map(all.map((f) => [f.label, reasonOf(f.change_id)]));
    console.log(`  逐条判据：${[...reasons].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  计数：${JSON.stringify(plan.counts_by_reason)}`);

    check(
      '3.2 运行中的两个、待恢复的两个（含分叉的那一个）、窗口内的一个都在保护清单里',
      reasons.get('running') === 'IN_EXECUTION' &&
        reasons.get('validating') === 'IN_EXECUTION' &&
        reasons.get('awaiting') === 'AWAITING_RECOVERY' &&
        reasons.get('diverged') === 'AWAITING_RECOVERY' &&
        reasons.get('young') === 'WITHIN_RETENTION_WINDOW' &&
        reasons.get('old') === '(不在保护清单里)',
      `分叉那条=${String(reasons.get('diverged'))}（只看修改集状态会漏掉它）`,
    );

    const youngDecision = plan.protected_changes.find((d) => d.change_id === young.change_id);
    const edgeMs = youngDecision === undefined ? Number.NaN : Date.parse(youngDecision.retain_until);
    check(
      '3.3 窗口右端是「终结时刻 + 保留期」，差一毫秒仍受保护、正好到期就不受保护',
      Number.isFinite(edgeMs) &&
        snapshotGuard(repos, { now: new Date(edgeMs - 1).toISOString() }).protect({ id: young.blobs[0]! }) !== null &&
        snapshotGuard(repos, { now: new Date(edgeMs).toISOString() }).protect({ id: young.blobs[0]! }) === null,
      `retain_until=${String(youngDecision?.retain_until)}`,
    );

    // ---- 真的一轮回收：数磁盘上的文件 ------------------------------------
    const guard = snapshotGuard(repos, { now: NOW });
    const report = await store.collectGarbage({
      isSafeToCollect: () => true,
      protect: (blob) => guard.protect(blob),
    });
    const filesAfter = await countFiles(objectsRoot);
    const deleted = all.flatMap((f) => f.blobs).filter((id) => !existsSync(fileOf(id)));
    const survivors = all.flatMap((f) => f.blobs).filter((id) => existsSync(fileOf(id)));

    console.log(
      `  磁盘文件数：回收前 ${String(filesBefore)} → 回收后 ${String(filesAfter)}；` +
        `本轮回收 ${String(report.collected.length)} 个对象、跳过 ${String(report.skipped.length)} 个`,
    );
    check(
      '3.4 磁盘上少掉的**恰好**是窗口已满的那两个文件（不是「少了几个」，是「就是那两个」）',
      deleted.length === 2 && deleted.every((id) => old.blobs.includes(id)) && survivors.length === (all.length - 1) * 2,
      `删掉 ${String(deleted.length)} 个，全部属于窗口已满的那一条；留下 ${String(survivors.length)} 个`,
    );
    check(
      '3.5 运行中、待恢复（含分叉）与窗口内的字节一个都没少，且仍标记为待回收',
      [running, validating, awaiting, young, diverged].every((f) =>
        f.blobs.every(
          (id) => existsSync(fileOf(id)) && repos.blobs.requireById(id).retention_state === 'pending_gc',
        ),
      ),
      `留下的仍然只是「待回收」，没有被顺手改成别的状态`,
    );
    check(
      '3.6 跳过时给出了具名理由（「跳过」不能是一句无声的什么都不做）',
      report.skipped.some((s) => s.reason.includes('撤销窗口')) &&
        report.skipped.some((s) => s.reason.includes('正在执行中')) &&
        report.skipped.some((s) => s.reason.includes('恢复')),
      [...new Set(report.skipped.map((s) => s.reason))].join(' | '),
    );

    // ---- 反向探针：撤掉逐对象判据，同一批行会连受保护的一起删 ------------
    // 没有这条反证，「一个都没删」与「本来就没东西可删」在证据上无法区分。
    const probeYoung = await withRealBytes('probe-young', 'APPLIED', T_YOUNG_END_MS);
    const probeRunning = await withRealBytes('probe-running', 'APPLYING', null);
    const unprotected = await store.collectGarbage({ isSafeToCollect: () => true });
    const probeDeleted = [probeYoung, probeRunning].flatMap((f) => f.blobs).filter((id) => !existsSync(fileOf(id)));
    check(
      '3.7 反向探针：撤掉 protect 后，窗口内的与运行中的字节**都被删了**',
      probeDeleted.length === 4 && unprotected.refused === false,
      `没有 protect 时本轮删掉 ${String(probeDeleted.length)} 个 —— 因此 3.4/3.5 里那些「留下」是判据挣来的，不是没东西可删`,
    );

    // ---- 全局谓词那一层：它单独**不能**表达标准 3 -------------------------
    const refuseProbe = await withRealBytes('probe-refuse', 'APPLIED', T_YOUNG_END_MS);
    const refusedAll = await store.collectGarbage({
      isSafeToCollect: () => false,
      unsafeReason: '存在在途操作或未决恢复，拒绝回收。',
      protect: () => null,
    });
    check(
      '3.8 全局谓词为假时确实什么都不删 —— 但那让这条标准空洞地成立，所以它替不了逐对象判据',
      refusedAll.refused === true && refusedAll.collected.length === 0 && existsSync(fileOf(refuseProbe.blobs[0]!)),
      `refusal_reason=${String(refusedAll.refusal_reason)}`,
    );

    check(
      '3.9 这些受保护的快照引用计数全部是零（保护不是靠引用计数挣来的）',
      [running, validating, awaiting, young, diverged].every((f) =>
        f.blobs.every((id) => repos.blobs.requireById(id).refcount === 0),
      ),
      '判据问的是「谁还可能需要这些字节」，而不是「计数是多少」',
    );
  });

  // =========================================================================
  section('4. 审计保留的是必要元数据，不是原文副本');
  // =========================================================================

  await guarded('4', async () => {
    const store = new BlobStore({ objectsRoot, registry: repos.blobs, newId: () => nextId('blob') });
    clockNow = T0;
    const body = 'SECRET-BODY-绝不应当出现在审计里的正文-'.repeat(3);
    const put = await store.putAndRegister(Buffer.from(body, 'utf8'), { id: nextId('blob') });
    const relPath = 'src/audit-target.ts';
    const ids = makeFixtureIds('audit');

    const change = repos.changes.create({
      id: nextId('chg'),
      owner_connection_id: ids.connection_id,
      workspace_id: ids.workspace_id,
      root_generation: GENERATION,
      policy_version: POLICY_VERSION,
      contract_version: CONTRACT_VERSION,
      digest: canonicalChangeDigest({
        contract_version: CONTRACT_VERSION,
        policy_version: POLICY_VERSION,
        root_generation: GENERATION,
        workspace_id: ids.workspace_id,
        files: [
          {
            path: relPath,
            op: 'create_text',
            before_sha256: null,
            before_size: 0,
            after_sha256: put.put.sha256,
            after_size: put.put.size,
            encoding: 'utf-8',
            newline: 'lf',
            bom: false,
          },
        ],
      }),
      summary: '夹具 audit',
      expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
      items: [
        {
          id: nextId('ci'),
          path: relPath,
          op: 'create_text',
          base_file_id: null,
          base_sha256: null,
          target_sha256: put.put.sha256,
          old_blob_id: null,
          new_blob_id: put.id,
          encoding: 'utf-8',
          bom: false,
          newline: 'lf',
          added_lines: 2,
          removed_lines: 0,
        },
      ],
    });

    const metadata = reclaimedChangeMetadata(repos, change.id);
    const serialized = JSON.stringify(metadata);
    console.log(`  审计元数据：${serialized}`);

    check('4.1 字节被回收后仍拿得到审计所需的元数据（不是静默丢失）', metadata !== null);
    check(
      '4.2 元数据里没有工作区相对路径，也没有正文片段',
      metadata !== null && !serialized.includes('src/') && !serialized.includes('SECRET-BODY'),
      `长度 ${String(serialized.length)} 字节`,
    );
    // 比「不含某些子串」更强的判据：把允许出现的字段名**列全**。
    // 子串比对只能证明「我没搜到那几个词」，而字段白名单能证明「它没带别的东西」。
    // 名单里没有的东西和有的东西同样重要：没有任何**相对路径**（只有标识符
    // `change_id` / `workspace_id`）、没有任何正文、没有任何 blob id 与对象名。
    const allowed = [
      'added_lines',
      'after_bytes',
      'before_bytes',
      'change_id',
      'created_at',
      'digest',
      'ended_at',
      'item_count',
      'removed_lines',
      'state',
      'workspace_id',
    ];
    const keys = Object.keys(metadata ?? {}).sort();
    check(
      '4.3 元数据的字段就是那十一个：身份（两个标识符 + 摘要 + 状态 + 两个时刻）与规模（条目数 + 行数 + 字节数），没有别的',
      keys.every((k) => allowed.includes(k)) && allowed.every((k) => keys.includes(k)),
      `实际字段 ${keys.join(',')}`,
    );
    check(
      '4.4 规模与身份对得上：条目数、字节数、摘要',
      metadata !== null &&
        metadata.change_id === change.id &&
        metadata.item_count === 1 &&
        metadata.after_bytes === put.put.size &&
        metadata.digest === change.digest,
      `item_count=${String(metadata?.item_count)} after_bytes=${String(metadata?.after_bytes)}`,
    );
    check('4.5 它不抛：排障路径上「这个修改集已经不在了」是一个正常答案', reclaimedChangeMetadata(repos, 'chg_不存在') === null);
  });

  // =========================================================================
  section('5. 集合由转移表推出（而不是几张手抄的清单）');
  // =========================================================================

  await guarded('5', () => {
    console.log(`  可失效 ${INVALIDATABLE_STATES.join(',')}`);
    console.log(`  未终结 ${NON_TERMINAL_STATES.join(',')}`);
    console.log(`  待批准 ${PENDING_CHANGE_STATES.join(',')}`);
    const notInvalidatable = NON_TERMINAL_STATES.filter((s) => !INVALIDATABLE_STATES.includes(s));
    check(
      '5.1 可失效 ⊆ 未终结，且两者**不是**同一个集合（分界点在「写入是否已经开始」）',
      INVALIDATABLE_STATES.every((s) => NON_TERMINAL_STATES.includes(s)) &&
        INVALIDATABLE_STATES.length < NON_TERMINAL_STATES.length,
      `可失效 ${String(INVALIDATABLE_STATES.length)} 个 / 未终结 ${String(NON_TERMINAL_STATES.length)} 个`,
    );
    check(
      '5.2 「不可失效」不等于「已终结」：清理不能凭前者认为事情结束了',
      notInvalidatable.length === 3,
      `差集 ${notInvalidatable.join(',')}`,
    );
  });

  // =========================================================================
  section('6. 可复现的测试命令与输出');
  // =========================================================================

  await guarded('6', async () => {
    const result = await exec(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'run-tests.mjs'), 'tests/unit', '--grep', 'LWB-024'],
      repoRoot,
    );
    for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
      if (/^# (tests|suites|pass|fail|skipped) /.test(line)) console.log(`  ${line}`);
    }
    check('6.1 本任务的单元测试在 node 运行器下全部通过', result.code === 0, `退出码 ${String(result.code)}`);
  });

  // =========================================================================
  section('未执行项（不得记为通过）');
  // =========================================================================

  skip(
    '观察一次真实的落盘尝试被拦下（验收标准 1 的端到端那一半）',
    '写入方是执行协调器 `packages/executor/coordinator.ts`（LWB-026），尚未交付。' +
      '因此本脚本能证的是「通往写入的那道门在所有入口上都拒绝」，不能证「文件真的没被写」——' +
      '这两句话在证据强度上不是一回事，不合并',
  );
  skip(
    '在真实工作区上联调（重定位 / 停用 / 移除一条真实工作区）',
    'G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）',
  );
  skip(
    '在真实 ChatGPT 网页端确认模型无法自行批准或解除失效',
    'LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）。MCP Inspector 的成功不能替代它',
  );
  skip(
    '由定时任务真正触发的那一次回收',
    '定时触发与守护进程装配根（apps/daemon/src/main.ts）尚未交付。本节跑的是被装配后应当被调用的那一次' +
      ' `collectGarbage`，输入与判据都是生产模块本身',
  );
  skip(
    '「解除失效」这条路径',
    '本任务只做失效，不做反向。`INVALIDATED` 在转移表里是终态、没有任何出边 —— 这是刻意的：' +
      '解除失效等于让一次已经作废的批准复活，而它的下一步动作应当是重新读取、重新提议',
  );

  console.log(
    `\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`} — ${String(passes)} PASSED / ${String(failures)} FAILED / ${String(skips)} NOT_RUN`,
  );
}

objectsRoot = await mkdtemp(path.join(os.tmpdir(), 'lwb-024-evidence-'));
try {
  await main();
} finally {
  await rm(objectsRoot, { recursive: true, force: true });
  closeDatabase(opened.db);
  process.exitCode = failures === 0 ? 0 : 1;
}
