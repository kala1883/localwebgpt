/**
 * LWB-022 可复现证据采集：状态机与幂等存储。
 *
 * 三条验收标准在这里各有一段：
 *
 *  1. 并发重复调用收敛到同一操作（第 2 节）。
 *  2. 不可从 APPLIED、REJECTED、EXPIRED 倒退到可再次执行状态（第 1 节）。
 *  3. 所有未知结果都可以用 operation_id 查询，不要求重新发同一写任务（第 3 节）。
 *
 * ## 装置为什么是这个形状
 *
 * 三条里两条是否定式 / 收敛式的，因此**必须真的做那件事，再数落库的行数**：
 *
 *  - **真实状态库**：临时目录里的 SQLite **文件**（不是内存库）。这一点是
 *    本任务的核心：`UNIQUE(change_id)` 与 `WHERE state IN (…)` 的保证若只
 *    在内存里成立，那它就不是「进程重启也不丢」的保证。第 2 节用**两条
 *    独立的连接**（各自 `openDatabase`、各自 `Repositories`）来证明这些
 *    保证住在数据库里，不住在进程内存里。
 *  - **独立第二连接计数**：所有行数都经由另一条连接读，不借进程内的对象。
 *  - **真实仓储与触发器**：修改集走 `ChangesRepo.create`，不可变触发器、
 *    墓碑触发器、部分唯一索引全在库里。
 *
 * ## 装置**没有**做什么（免得被读成比实际更强）
 *
 * 修改集的**内容**是合成的（blob 行是真的，字节不是）。本任务的三条验收
 * 全部只关于**状态与标识**，与文件内容无关；「prepare 在真实夹具上产出
 * 修改集」已由 LWB-020 在真实 NTFS 副本上采集过（docs/evidence/lwb-020/）。
 * 在这里再跑一遍 prepare，只是把 LWB-020 的结论再说一次，而会让本脚本
 * 多依赖一层与它无关的装置。
 *
 * 本任务**不碰文件系统**，因此本脚本**不**要求 Windows（也没有 `WINDOWS_ONLY`
 * 早退）—— 状态机与幂等事实与平台无关。这一点本身是条信息：它说明
 * 「终态不可逆」不是靠某个平台调用实现的。
 *
 * 用法：node --import tsx scripts/evidence/lwb-022.ts
 * 退出码：全部通过 0；任一项失败 1。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  APPROVAL_STATES,
  CHANGE_STATE_LABELS,
  CONTRACT_VERSION,
  LIMITS,
  OPERATION_STATES,
  TERMINAL_CHANGE_STATES,
} from '@lwb/contracts';
import type { ChangeSetState } from '@lwb/contracts';
import { BridgeError } from '@lwb/contracts';
import {
  FROZEN_CHANGE_STATES,
  FROZEN_OPERATION_STATES,
  FROZEN_TOMBSTONE_CHANGE_STATES,
  Repositories,
  closeDatabase,
  openDatabase,
} from '@lwb/persistence';
import type { ChangeItemInput } from '@lwb/persistence';
import {
  APPROVAL_TRANSITIONS,
  CHANGE_TRANSITIONS,
  EXECUTION_CHANGE_STATES,
  OPERATION_TRANSITIONS,
  TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE,
  TERMINAL_BY_TRANSITION_TABLE,
  TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE,
  canTransition,
  isExecutionChangeState,
  reachableChangeStates,
  reachableFromEveryChangeState,
  transitionChange,
} from '@lwb/changes';
import {
  OUTCOME_POLICY,
  asChangeId,
  asIdempotencyKey,
  asOperationId,
  classifyOperation,
  queryOperation,
  queueOperation,
  requireOperationId,
} from '@lwb/idempotency';

// ---------------------------------------------------------------------------
// 脚手架（与 lwb-020.ts / lwb-021.ts 同一套）
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

function reportSectionFailure(name: string, cause: unknown): void {
  const error = cause as { code?: string; message?: string; details?: unknown; stack?: string };
  check(`${name} 段跑完`, false, `${error.code ?? '(无错误码)'}：${error.message ?? String(cause)}`);
  if (error.details !== undefined) console.log(`      details=${JSON.stringify(error.details)}`);
  if (error.stack) console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`);
}

async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    reportSectionFailure(name, cause);
  }
}

async function catchBridge(fn: () => Promise<unknown> | unknown): Promise<BridgeError> {
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof BridgeError) return cause;
    throw cause;
  }
  throw new Error('装置错误：期望抛出 BridgeError，实际成功返回');
}

/** 把抛出的错误压成一行：码 + 理由标签。 */
function errLine(cause: unknown): string {
  if (cause instanceof BridgeError) {
    return `${cause.code}/${String(cause.details?.['reason'] ?? '(无 reason)')}`;
  }
  return `(不是 BridgeError) ${String(cause)}`;
}

// ---------------------------------------------------------------------------
// 状态库旁路：独立的第二连接
// ---------------------------------------------------------------------------

const TABLES = [
  'approvals',
  'operations',
  'changesets',
  'change_items',
  'operation_item_results',
  'journal_entries',
  'idempotency_records',
] as const;
type TableName = (typeof TABLES)[number];

function countRows(dbPath: string, table: TableName): number {
  const opened = openDatabase({ path: dbPath });
  try {
    const row = opened.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    closeDatabase(opened.db);
  }
}

function readState(dbPath: string, changeId: string): string {
  const opened = openDatabase({ path: dbPath });
  try {
    const row = opened.db.prepare('SELECT state FROM changesets WHERE id = ?').get(changeId) as
      | { state: string }
      | undefined;
    return row?.state ?? '(不存在)';
  } finally {
    closeDatabase(opened.db);
  }
}

/** 直接执行一条 SQL，返回是否**成功改动了行**（被触发器拒绝时为 false）。 */
function runSql(
  dbPath: string,
  sql: string,
  params: readonly unknown[],
): { readonly ok: boolean; readonly changed: number; readonly error: string } {
  const opened = openDatabase({ path: dbPath });
  try {
    const result = opened.db.prepare(sql).run(...(params as never[]));
    return { ok: true, changed: result.changes, error: '' };
  } catch (cause) {
    return { ok: false, changed: 0, error: String((cause as { message?: string }).message ?? cause) };
  } finally {
    closeDatabase(opened.db);
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_ev022';
const WORKSPACE = 'ws_ev022';
const PRINCIPAL = 'principal_ev022';
const VOLUME = 'vol-ev022';
const GENERATION = 4;
const POLICY_VERSION = 2;
const T0_MS = Date.parse('2026-09-25T10:00:00.000Z');

let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

const fakeSha = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');

/** 建一个 `PENDING_APPROVAL` 修改集（内容合成，表与触发器是真的）。 */
function makeChange(repos: Repositories, seed: string): string {
  const beforeSha = fakeSha(`1${seed}`);
  const afterSha = fakeSha(`2${seed}`);
  const before = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: beforeSha,
    size: 10,
    storage_ref: `objects/${beforeSha}`,
  }).blob;
  const after = repos.blobs.ensure({
    id: nextId('blob'),
    sha256: afterSha,
    size: 11,
    storage_ref: `objects/${afterSha}`,
  }).blob;

  const items: ChangeItemInput[] = [
    {
      id: nextId('ci'),
      path: `src/${seed}.ts`,
      op: 'edit_text',
      base_file_id: 'file-id-1',
      base_sha256: beforeSha,
      target_sha256: afterSha,
      old_blob_id: before.id,
      new_blob_id: after.id,
      encoding: 'utf-8',
      bom: false,
      newline: 'lf',
      added_lines: 1,
      removed_lines: 1,
    },
  ];

  return repos.changes.create({
    id: nextId('chg'),
    owner_connection_id: CONNECTION,
    workspace_id: WORKSPACE,
    root_generation: GENERATION,
    policy_version: POLICY_VERSION,
    contract_version: CONTRACT_VERSION,
    digest: fakeSha(`d${seed}`),
    summary: `LWB-022 证据夹具 ${seed}`,
    expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  }).id;
}

/** 建一个已批准的修改集（走图里那条边，不直接改状态）。 */
function makeApproved(repos: Repositories, seed: string): string {
  const changeId = makeChange(repos, seed);
  transitionChange(repos, { change_id: changeId, from: ['PENDING_APPROVAL'], to: 'APPROVED' });
  return changeId;
}

function seedRegistry(repos: Repositories): void {
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: 'LWB-022 证据脚本',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: 'LWB-022 证据工作区（无文件系统访问）',
    kind: 'directory',
    canonical_root: 'C:\\lwb-022-evidence',
    volume_id: VOLUME,
    root_file_id: 'root-file-id',
    policy_version: POLICY_VERSION,
    mode: 'read_propose_apply_with_local_approval',
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-evidence-022-'));
  const dbPath = path.join(sandbox, 'state.sqlite');

  try {
    // -----------------------------------------------------------------------
    section('0 装置');
    // -----------------------------------------------------------------------
    const opened = openDatabase({ path: dbPath });
    const repos = new Repositories(opened.db);
    seedRegistry(repos);
    note(
      '状态库',
      `schema_version=${String(opened.schema_version)} 迁移 ${opened.applied_migrations.join(',')}`,
    );
    note('库文件', dbPath);
    note('平台', `${process.platform}（本任务不访问文件系统，故不设 Windows 门槛）`);

    check(
      '0.1 转移表覆盖全部冻结状态（遍历的前提）',
      Object.keys(CHANGE_TRANSITIONS).sort().join(',') === [...FROZEN_CHANGE_STATES].sort().join(',') &&
        Object.keys(CHANGE_TRANSITIONS).sort().join(',') ===
          Object.keys(CHANGE_STATE_LABELS).sort().join(',') &&
        Object.keys(OPERATION_TRANSITIONS).sort().join(',') ===
          [...FROZEN_OPERATION_STATES].sort().join(',') &&
        Object.keys(APPROVAL_TRANSITIONS).sort().join(',') === [...APPROVAL_STATES].sort().join(',') &&
        Object.keys(OPERATION_TRANSITIONS).sort().join(',') === [...OPERATION_STATES].sort().join(','),
      `修改集 ${String(Object.keys(CHANGE_TRANSITIONS).length)} 态 / 操作 ` +
        `${String(Object.keys(OPERATION_TRANSITIONS).length)} 态 / 批准 ` +
        `${String(Object.keys(APPROVAL_TRANSITIONS).length)} 态`,
    );

    check(
      '0.2 墓碑态由转移表推出，且等于契约与冻结清单',
      [...TERMINAL_BY_TRANSITION_TABLE].sort().join(',') ===
        [...TERMINAL_CHANGE_STATES].sort().join(',') &&
        [...TERMINAL_BY_TRANSITION_TABLE].sort().join(',') ===
          [...FROZEN_TOMBSTONE_CHANGE_STATES].sort().join(','),
      `修改集墓碑 ${TERMINAL_BY_TRANSITION_TABLE.join(',')}；操作墓碑 ` +
        `${TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE.join(',')}；批准墓碑 ` +
        `${TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE.join(',')}`,
    );

    // -----------------------------------------------------------------------
    section('1 验收标准 2：不可从终态倒退到可再次执行状态');
    // -----------------------------------------------------------------------
    await guarded('1', async () => {
      // 1a. 表层面：终态的可达集合里没有可执行状态。
      const reachable = reachableFromEveryChangeState();
      const illegalPairs: string[] = [];
      let edgesChecked = 0;
      for (const terminal of TERMINAL_BY_TRANSITION_TABLE) {
        const reached = reachable.get(terminal) ?? new Set<ChangeSetState>();
        for (const target of reached) {
          edgesChecked += 1;
          if (isExecutionChangeState(target)) illegalPairs.push(`${terminal}→${target}`);
        }
      }
      check(
        '1.1 每个终态的可达闭包里都没有可执行状态',
        illegalPairs.length === 0,
        `走了 ${String(edgesChecked)} 个可达状态，违规 ${String(illegalPairs.length)} 个` +
          (illegalPairs.length > 0 ? `：${illegalPairs.join(',')}` : ''),
      );

      // 1b. 非平凡性：否则一张全空的表也能过 1.1。
      const reachesExecution = EXECUTION_CHANGE_STATES.every((state) =>
        reachableChangeStates('PENDING_APPROVAL').has(state),
      );
      check(
        '1.2 非平凡性：可执行状态确实能从前面的状态到达',
        reachesExecution,
        `PENDING_APPROVAL 可达 ${[...reachableChangeStates('PENDING_APPROVAL')].length} 个状态`,
      );

      // 1c. 逐条：终态 × 可执行状态，图里都没有边。
      const badEdges: string[] = [];
      for (const terminal of TERMINAL_BY_TRANSITION_TABLE) {
        for (const execution of EXECUTION_CHANGE_STATES) {
          if (canTransition(terminal, execution)) badEdges.push(`${terminal}→${execution}`);
        }
      }
      check(
        '1.3 终态 × 可执行状态：一条边都没有',
        badEdges.length === 0,
        `${String(TERMINAL_BY_TRANSITION_TABLE.length * EXECUTION_CHANGE_STATES.length)} 个组合，` +
          `违规 ${String(badEdges.length)}`,
      );

      // 1d. 真库上走一遍：把修改集推到 APPLIED，再试所有回退。
      const applied = makeApproved(repos, 'applied');
      for (const step of [
        { from: 'APPROVED' as const, to: 'QUEUED' as const },
        { from: 'QUEUED' as const, to: 'VALIDATING' as const },
        { from: 'VALIDATING' as const, to: 'APPLYING' as const },
        { from: 'APPLYING' as const, to: 'APPLIED' as const },
      ]) {
        transitionChange(repos, { change_id: applied, from: [step.from], to: step.to });
      }
      check('1.4 夹具已走到 APPLIED', readState(dbPath, applied) === 'APPLIED');

      const changesetsBefore = countRows(dbPath, 'changesets');
      const refusalReasons: string[] = [];
      for (const execution of EXECUTION_CHANGE_STATES) {
        const error = await catchBridge(() =>
          transitionChange(repos, { change_id: applied, from: ['APPLIED'], to: execution }),
        );
        refusalReasons.push(`${execution}:${String(error.details?.['reason'])}`);
      }
      check(
        '1.5 试图把 APPLIED 退回可执行状态：全部按终态拒绝',
        refusalReasons.every((entry) => entry.endsWith('TERMINAL_STATE')),
        refusalReasons.join(' '),
      );
      check(
        '1.6 拒绝之后状态与行数都没变',
        readState(dbPath, applied) === 'APPLIED' && countRows(dbPath, 'changesets') === changesetsBefore,
        `state=${readState(dbPath, applied)}，changesets ${String(countRows(dbPath, 'changesets'))} 行`,
      );

      // 1e. 三个墓碑各走一遍（REJECTED / EXPIRED 是真走出来的，不是直接改的）。
      const rejected = makeChange(repos, 'rejected');
      transitionChange(repos, { change_id: rejected, from: ['PENDING_APPROVAL'], to: 'REJECTED' });
      const expired = makeChange(repos, 'expired');
      transitionChange(repos, { change_id: expired, from: ['PENDING_APPROVAL'], to: 'EXPIRED' });
      const terminalSamples = [
        { id: applied, state: 'APPLIED' },
        { id: rejected, state: 'REJECTED' },
        { id: expired, state: 'EXPIRED' },
      ];
      const sampleResults: string[] = [];
      for (const sample of terminalSamples) {
        const error = await catchBridge(() =>
          transitionChange(repos, { change_id: sample.id, from: [sample.state as ChangeSetState], to: 'QUEUED' }),
        );
        sampleResults.push(`${sample.state}→QUEUED ${errLine(error)}`);
      }
      check(
        '1.7 三个墓碑（APPLIED / REJECTED / EXPIRED）退回 QUEUED 一律被拒',
        sampleResults.every((line) => line.includes('TERMINAL_STATE')),
        sampleResults.join(' | '),
      );

      // 1f. 落库试探：直接 SQL 能不能把终态改回去。
      //     这一条**故意**要问出「能」—— 它是本层的边界，必须被说清而不是被绕过。
      const direct = runSql(dbPath, 'UPDATE changesets SET state = ? WHERE id = ?', ['QUEUED', applied]);
      note(
        '边界：库层不挡终态回退',
        direct.ok && direct.changed === 1
          ? '直接 UPDATE 可以把 APPLIED 改回 QUEUED（改动 1 行）；' +
            '挡它的是 @lwb/changes 的转移表与 ChangesRepo.transition 的条件写（应用层），' +
            '不是数据库触发器 —— 见「未执行项」与偏离项'
          : `直接 UPDATE 被数据库拒绝：${direct.error}`,
      );
      // 把这一行改回去，免得它污染后面的计数。
      if (direct.ok && direct.changed === 1) {
        runSql(dbPath, 'UPDATE changesets SET state = ? WHERE id = ?', ['APPLIED', applied]);
      }
      check('1.8 试探之后状态已复原', readState(dbPath, applied) === 'APPLIED');

      // 1g. 操作的终态同样不可逆。
      const opTerminalReasons: string[] = [];
      for (const terminal of TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE) {
        if (!OPERATION_TRANSITIONS[terminal].length) opTerminalReasons.push(`${terminal}:0 出边`);
      }
      check(
        '1.9 操作态的四个墓碑没有出边',
        opTerminalReasons.length === TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE.length,
        opTerminalReasons.join(' '),
      );
      check(
        '1.10 批准离开 ACTIVE 后回不去（应用层与触发器同一句话）',
        TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE.every(
          (state) => !APPROVAL_TRANSITIONS[state].includes('ACTIVE'),
        ),
        `墓碑 ${TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE.join(',')}`,
      );
    });

    // -----------------------------------------------------------------------
    section('2 验收标准 1：并发重复调用收敛到同一操作');
    // -----------------------------------------------------------------------
    let sharedChange = '';
    await guarded('2', async () => {
      // 2a. 第一次：创建。
      sharedChange = makeApproved(repos, 'shared');
      const first = queueOperation(repos, {
        change_id: asChangeId(sharedChange),
        from: ['APPROVED'],
        idempotency_key: 'ev022-first',
        new_operation_id: () => nextId('op'),
      });
      check(
        '2.1 第一次排队：状态 QUEUED、操作创建、existed=false',
        first.existed === false &&
          first.change.state === 'QUEUED' &&
          readState(dbPath, sharedChange) === 'QUEUED' &&
          countRows(dbPath, 'operations') === 1,
        `op=${first.operation.id}，operations ${String(countRows(dbPath, 'operations'))} 行`,
      );

      // 2b. 换键重试：被拒，且没有第二个操作。
      const operationsBefore = countRows(dbPath, 'operations');
      const swapped = await catchBridge(() =>
        queueOperation(repos, {
          change_id: asChangeId(sharedChange),
          from: ['APPROVED'],
          idempotency_key: 'ev022-second-different-key',
          new_operation_id: () => nextId('op'),
        }),
      );
      check(
        '2.2 换一个幂等键再排：被拒绝，操作数不变',
        swapped.code === 'CHANGE_STATE_INVALID' &&
          countRows(dbPath, 'operations') === operationsBefore,
        `${errLine(swapped)}，operations ${String(countRows(dbPath, 'operations'))} 行`,
      );

      // 2c. 第二条**独立连接**：绕过状态检查，直接建操作 —— 撞 UNIQUE(change_id)。
      const openedB = openDatabase({ path: dbPath });
      try {
        const reposB = new Repositories(openedB.db);
        const outcome = reposB.operations.create({
          id: nextId('op_from_b'),
          change_id: sharedChange,
          idempotency_key: 'ev022-from-connection-b',
        });
        check(
          '2.3 第二条连接直接建操作：撞唯一索引，返回既有那一个',
          outcome.kind === 'exists' && outcome.operation.id === first.operation.id,
          `kind=${outcome.kind}，返回 ${outcome.operation.id}`,
        );
        check(
          '2.4 两条连接看到的是同一个操作（保证住在数据库里）',
          countRows(dbPath, 'operations') === operationsBefore &&
            reposB.operations.requireByChangeId(sharedChange).id === first.operation.id,
          `operations ${String(countRows(dbPath, 'operations'))} 行`,
        );

        // 2e. 第二条连接重放同一次排队：状态检查先挡住。
        const fromB = await catchBridge(() =>
          queueOperation(reposB, {
            change_id: asChangeId(sharedChange),
            from: ['APPROVED'],
            new_operation_id: () => nextId('op_from_b'),
          }),
        );
        check(
          '2.5 第二条连接重放排队：在任何写入之前被拒',
          fromB.code === 'CHANGE_STATE_INVALID' &&
            countRows(dbPath, 'operations') === operationsBefore,
          `${errLine(fromB)}`,
        );
      } finally {
        closeDatabase(openedB.db);
      }

      // 2f. 「无丢失更新」：A 持立即事务时，B 的写入拿不到锁（不是排队后各写一份）。
      const openedA = openDatabase({ path: dbPath });
      const openedSlowB = openDatabase({ path: dbPath, busyTimeoutMs: 150 });
      try {
        const reposA = new Repositories(openedA.db);
        const heldChange = makeApproved(reposA, 'held');
        openedA.db.exec('BEGIN IMMEDIATE');
        reposA.operations.create({ id: nextId('op_held'), change_id: heldChange });
        const reposSlowB = new Repositories(openedSlowB.db);
        // 这里**不能**用 `catchBridge`：抢锁失败抛的是 SQLite 的错误，
        // 不是本工程的 BridgeError —— 而那正是本条要观察的东西。
        let contendedCode = '';
        let contendedMessage = '';
        try {
          reposSlowB.operations.create({ id: nextId('op_contended'), change_id: heldChange });
        } catch (cause) {
          contendedCode = String((cause as { code?: string }).code ?? '(无 code)');
          contendedMessage = String((cause as { message?: string }).message ?? cause);
        }
        check(
          '2.6 A 持立即事务时 B 的写入超时失败（无脏写）',
          /BUSY|locked/i.test(contendedMessage),
          `${contendedCode}：${contendedMessage.slice(0, 80)}`,
        );
        openedA.db.exec('COMMIT');
        check(
          '2.7 提交后 B 重试撞唯一索引，仍然只有一个操作',
          reposSlowB.operations.create({ id: nextId('op_contended'), change_id: heldChange }).kind ===
            'exists',
          `operations ${String(countRows(dbPath, 'operations'))} 行`,
        );
      } finally {
        closeDatabase(openedSlowB.db);
        closeDatabase(openedA.db);
      }
    });

    // 2g. 「进程重启不删除幂等事实」：关掉主连接，重新打开。
    closeDatabase(opened.db);
    await guarded('2g', async () => {
      const reopened = openDatabase({ path: dbPath });
      try {
        const repos2 = new Repositories(reopened.db);
        const operation = repos2.operations.requireByChangeId(sharedChange);
        const replay = await catchBridge(() =>
          queueOperation(repos2, {
            change_id: asChangeId(sharedChange),
            from: ['APPROVED'],
            new_operation_id: () => nextId('op_after_restart'),
          }),
        );
        check(
          '2.8 重开数据库之后：操作仍在，重排仍被收敛（幂等事实不在内存里）',
          operation.id.length > 0 && replay.code === 'CHANGE_STATE_INVALID',
          `op=${operation.id}，重排 ${errLine(replay)}`,
        );
      } finally {
        closeDatabase(reopened.db);
      }
    });

    // 之后的段落用一条新连接继续（上一条已按「进程重启」关掉）。
    const reopened = openDatabase({ path: dbPath });
    const repos3 = new Repositories(reopened.db);
    try {
      // ---------------------------------------------------------------------
      section('3 验收标准 3：未知结果可以用 operation_id 查询');
      // ---------------------------------------------------------------------
      await guarded('3', async () => {
        // 3a. 进行中。
        const inProgressChange = makeApproved(repos3, 'inprogress');
        const queued = queueOperation(repos3, {
          change_id: asChangeId(inProgressChange),
          from: ['APPROVED'],
          idempotency_key: 'ev022-in-progress',
          new_operation_id: () => nextId('op'),
        });
        const queried = queryOperation(repos3, asOperationId(queued.operation.id));
        check(
          '3.1 排队中：IN_PROGRESS，且要求用 operation_id 查询（不是重发）',
          queried.found &&
            queried.outcome.kind === 'IN_PROGRESS' &&
            queried.outcome.must_query_by_operation_id &&
            queried.outcome.file_effect === 'unknown' &&
            !queried.outcome.saved,
          `kind=${queried.outcome.kind} saved=${String(queried.outcome.saved)} ` +
            `file_effect=${queried.outcome.file_effect}`,
        );

        // 3b. 写入后带核验回执 —— 唯一可以说「已保存」的一种。
        const itemId = repos3.changes.items(inProgressChange)[0]?.id ?? '';
        repos3.operations.transition(queued.operation.id, ['QUEUED'], 'VALIDATING');
        repos3.operations.transition(queued.operation.id, ['VALIDATING'], 'APPLYING');
        repos3.journal.append({ operation_id: queued.operation.id, stage: 'intent', item_id: itemId });
        repos3.operations.setItemResult({
          operation_id: queued.operation.id,
          item_id: itemId,
          state: 'VERIFIED',
          before_sha256: fakeSha('b'),
          after_sha256: fakeSha('a'),
        });
        repos3.journal.append({ operation_id: queued.operation.id, stage: 'verified', item_id: itemId });
        repos3.operations.transition(queued.operation.id, ['APPLYING'], 'APPLIED', { finished: true });

        const appliedQuery = queryOperation(repos3, asOperationId(queued.operation.id));
        check(
          '3.2 写入并核验后：APPLIED / saved=true / file_effect=changed',
          appliedQuery.outcome.kind === 'APPLIED' &&
            appliedQuery.outcome.saved &&
            appliedQuery.outcome.file_effect === 'changed' &&
            !appliedQuery.outcome.must_query_by_operation_id,
          `kind=${appliedQuery.outcome.kind} verified_items=${String(appliedQuery.outcome.verified_items)}`,
        );
        check(
          '3.3 查询带回逐文件结果与追加日志（可核验，不是一句话）',
          appliedQuery.items.length === 1 &&
            appliedQuery.items[0]?.state === 'VERIFIED' &&
            appliedQuery.journal.map((entry) => entry.stage).join(',') === 'intent,verified',
          `items=${String(appliedQuery.items.length)} journal=${appliedQuery.journal.length} 条`,
        );

        // 3c. APPLIED 但没有逐文件回执 —— 降级为 UNKNOWN，不读成成功。
        const noReceiptChange = makeApproved(repos3, 'noreceipt');
        const noReceipt = queueOperation(repos3, {
          change_id: asChangeId(noReceiptChange),
          from: ['APPROVED'],
          new_operation_id: () => nextId('op'),
        });
        repos3.operations.transition(noReceipt.operation.id, ['QUEUED'], 'VALIDATING');
        repos3.operations.transition(noReceipt.operation.id, ['VALIDATING'], 'APPLYING');
        repos3.operations.transition(noReceipt.operation.id, ['APPLYING'], 'APPLIED', { finished: true });
        const noReceiptQuery = queryOperation(repos3, asOperationId(noReceipt.operation.id));
        check(
          '3.4 状态是 APPLIED 但没有逐文件回执：只报 UNKNOWN，不报已保存',
          noReceiptQuery.outcome.kind === 'UNKNOWN' && !noReceiptQuery.outcome.saved,
          `kind=${noReceiptQuery.outcome.kind}，operation.state=APPLIED`,
        );

        // 3d. 逐文件的「不知道」压过操作自己的结论。
        const unknownChange = makeApproved(repos3, 'unknownitem');
        const unknownOp = queueOperation(repos3, {
          change_id: asChangeId(unknownChange),
          from: ['APPROVED'],
          new_operation_id: () => nextId('op'),
        });
        const unknownItem = repos3.changes.items(unknownChange)[0]?.id ?? '';
        repos3.operations.setItemResult({
          operation_id: unknownOp.operation.id,
          item_id: unknownItem,
          state: 'UNKNOWN',
        });
        repos3.operations.transition(unknownOp.operation.id, ['QUEUED'], 'VALIDATING');
        repos3.operations.transition(unknownOp.operation.id, ['VALIDATING'], 'APPLYING');
        repos3.operations.transition(unknownOp.operation.id, ['APPLYING'], 'APPLIED', { finished: true });
        const unknownQuery = queryOperation(repos3, asOperationId(unknownOp.operation.id));
        check(
          '3.5 operation=APPLIED 但有一个文件是 UNKNOWN：结论升级为 NEEDS_RECOVERY',
          unknownQuery.outcome.kind === 'NEEDS_RECOVERY' &&
            !unknownQuery.outcome.saved &&
            unknownQuery.outcome.must_query_by_operation_id &&
            unknownQuery.outcome.unknown_items.join(',') === unknownItem,
          `kind=${unknownQuery.outcome.kind} unknown_items=[${unknownQuery.outcome.unknown_items.join(',')}]`,
        );

        // 3e. 恢复不明：RECOVERY_REQUIRED。
        const recoveryChange = makeApproved(repos3, 'recovery');
        const recoveryOp = queueOperation(repos3, {
          change_id: asChangeId(recoveryChange),
          from: ['APPROVED'],
          new_operation_id: () => nextId('op'),
        });
        repos3.operations.transition(recoveryOp.operation.id, ['QUEUED'], 'VALIDATING');
        repos3.operations.transition(recoveryOp.operation.id, ['VALIDATING'], 'APPLYING');
        repos3.operations.transition(recoveryOp.operation.id, ['APPLYING'], 'RECOVERY_REQUIRED');
        const recoveryQuery = queryOperation(repos3, asOperationId(recoveryOp.operation.id));
        check(
          '3.6 写了一半（RECOVERY_REQUIRED）：NEEDS_RECOVERY，且禁止重发同一写任务',
          recoveryQuery.outcome.kind === 'NEEDS_RECOVERY' &&
            recoveryQuery.outcome.must_query_by_operation_id &&
            recoveryQuery.outcome.file_effect === 'unknown',
          `kind=${recoveryQuery.outcome.kind}`,
        );

        // 3f. 查一个不存在的 id：不抛错，答案是 UNKNOWN。
        let threw = '';
        let missing: ReturnType<typeof queryOperation> | null = null;
        try {
          missing = queryOperation(repos3, asOperationId('op_never_existed'));
        } catch (cause) {
          threw = errLine(cause);
        }
        check(
          '3.7 查一个不存在的 operation_id：不抛错，答案是 UNKNOWN',
          threw === '' && missing !== null && !missing.found && missing.outcome.kind === 'UNKNOWN',
          threw === '' ? `found=${String(missing?.found)} kind=${String(missing?.outcome.kind)}` : threw,
        );

        // 3g. 只给 operation_id：模拟「幂等键已经不在手上了」。
        const onlyId = queryOperation(repos3, requireOperationId(queued.operation.id));
        check(
          '3.8 查询只依赖 operation_id（查询签名里没有幂等键）',
          onlyId.found && onlyId.outcome.operation_id === queued.operation.id,
          `operation_id=${String(onlyId.outcome.operation_id)}`,
        );

        // 3h. 只读：查三次不改变任何事实。
        const opsBefore = countRows(dbPath, 'operations');
        const itemsBefore = countRows(dbPath, 'operation_item_results');
        for (let i = 0; i < 3; i += 1) {
          queryOperation(repos3, asOperationId(queued.operation.id));
        }
        check(
          '3.9 查询是只读的：行数与操作状态都没有变化',
          countRows(dbPath, 'operations') === opsBefore &&
            countRows(dbPath, 'operation_item_results') === itemsBefore &&
            repos3.operations.requireById(queued.operation.id).state === 'APPLIED',
          `operations ${String(opsBefore)} 行，逐文件结果 ${String(itemsBefore)} 行`,
        );

        // 3i. 策略表：只有 APPLIED 敢说「已保存」。
        const kinds = Object.keys(OUTCOME_POLICY) as (keyof typeof OUTCOME_POLICY)[];
        check(
          '3.10 七种答案里只有 APPLIED 的 saved 为真；三种「不知道」都要求查询',
          kinds.length === 7 &&
            kinds.every((kind) => OUTCOME_POLICY[kind].saved === (kind === 'APPLIED')) &&
            (['IN_PROGRESS', 'NEEDS_RECOVERY', 'UNKNOWN'] as const).every(
              (kind) => OUTCOME_POLICY[kind].must_query_by_operation_id,
            ),
          kinds.join(','),
        );
      });

      // ---------------------------------------------------------------------
      section('4 标识符与残余路径');
      // ---------------------------------------------------------------------
      await guarded('4', async () => {
        // 4a. 解析边界。
        const rejected: string[] = [];
        const cases: readonly [string, () => unknown][] = [
          ['空串', () => asIdempotencyKey('')],
          ['太短', () => asIdempotencyKey('a'.repeat(LIMITS.MIN_IDEMPOTENCY_KEY_CHARS - 1))],
          ['太长', () => asIdempotencyKey('a'.repeat(LIMITS.MAX_IDEMPOTENCY_KEY_CHARS + 1))],
          ['含换行', () => asChangeId('a\nb')],
          ['含 NUL', () => asOperationId('a\u0000b')],
          ['非字符串', () => asOperationId(42)],
          ['查询 id 为空', () => requireOperationId('  ')],
        ];
        for (const [label, fn] of cases) {
          const error = await catchBridge(fn);
          rejected.push(`${label}=${String(error.details?.['reason'])}`);
        }
        check(
          '4.1 七个形状不合法的标识符全部被解析函数拒绝',
          rejected.length === cases.length && rejected.every((line) => !line.includes('undefined')),
          rejected.join(' '),
        );

        // 4b. 残余路径：操作已在而修改集还在 APPROVED 时，唯一索引那条路返回既有操作。
        const orphanChange = makeApproved(repos3, 'orphan');
        const operationsBefore4 = countRows(dbPath, 'operations');
        const orphan = repos3.operations.create({
          id: nextId('op_orphan'),
          change_id: orphanChange,
        });
        const residual = queueOperation(repos3, {
          change_id: asChangeId(orphanChange),
          from: ['APPROVED'],
          idempotency_key: 'ev022-residual',
          new_operation_id: () => nextId('op'),
        });
        check(
          '4.2 残余路径（状态检查被绕过）：existed=true 且没有新建第二个操作',
          orphan.kind === 'created' &&
            residual.existed &&
            residual.operation.id === orphan.operation.id &&
            countRows(dbPath, 'operations') === operationsBefore4 + 1,
          `existed=${String(residual.existed)} op=${residual.operation.id}，` +
            `operations ${String(operationsBefore4)} → ${String(countRows(dbPath, 'operations'))} 行`,
        );

        // 4c. 幂等键不参与「要不要新建操作」—— 两个修改集共用一个键，仍是两个操作。
        const keyShared = 'ev022-shared-key';
        const changeA = makeApproved(repos3, 'sharedA');
        const changeB = makeApproved(repos3, 'sharedB');
        const opA = queueOperation(repos3, {
          change_id: asChangeId(changeA),
          from: ['APPROVED'],
          idempotency_key: keyShared,
          new_operation_id: () => nextId('op'),
        });
        const opB = queueOperation(repos3, {
          change_id: asChangeId(changeB),
          from: ['APPROVED'],
          idempotency_key: keyShared,
          new_operation_id: () => nextId('op'),
        });
        check(
          '4.3 同一个幂等键用于两个修改集：仍然是两个操作（键只是记账）',
          opA.operation.id !== opB.operation.id,
          `${opA.operation.id} vs ${opB.operation.id}`,
        );

        // 4d. 分类函数是纯函数：同样的输入给同样的答案。
        const pure = classifyOperation({ operation: null, items: [] });
        check(
          '4.4 没有操作记录时是 UNKNOWN（不是失败）',
          pure.kind === 'UNKNOWN' && !pure.saved,
          `kind=${pure.kind} message=${pure.message.slice(0, 24)}…`,
        );
      });
    } finally {
      closeDatabase(reopened.db);
    }

    // -----------------------------------------------------------------------
    section('未执行项（不得记为通过）');
    // -----------------------------------------------------------------------
    skip(
      '真的两个进程并行发起同一次排队',
      '本脚本用两条连接 + 立即事务的锁竞争来逼近它（2.6），但 better-sqlite3 是同步的，' +
        '同一进程内造不出两个真正并行的执行流；「A 持锁时 B 拿不到锁」证明的是**串行化**，' +
        '不是并行下的行为。真正的多进程验证需要两个 daemon 进程，而 daemon 的装配根（main.ts）尚不存在',
    );
    skip(
      '数据库层禁止终态回退',
      '本库没有这样的触发器：changesets_terminal_tombstone 挡的是 DELETE，不是 UPDATE。' +
        '第 1 节 1f 已经**量到**直接 UPDATE 可以把 APPLIED 改回 QUEUED（1 行）。' +
        '挡它的是应用层（转移表 + ChangesRepo.transition 的条件写），见偏离项',
    );
    skip(
      '写入真的落盘、然后回滚',
      'LWB-026（执行协调器）未实现；本任务的交付物里没有任何写文件的代码路径。' +
        '第 3 节的状态是用仓储层直接推出来的，不是执行器写出来的',
    );
    skip(
      '批准被消费（ACTIVE → CONSUMED）',
      '消费发生在执行器认领操作时（LWB-026）。本脚本全程未消费任何批准',
    );
    skip(
      '在真实工作区上联调',
      'G2 未通过（LWB-002 BLOCKED）；P3 门禁：可在契约冻结前提下继续实现，但不得在真实仓库上联调（docs/evidence/g2-read.md）',
    );
    skip(
      '在真实 ChatGPT 网页端确认模型无法自行排队',
      'LWB-002 BLOCKED（真实账号与 Secure MCP Tunnel 凭证）。MCP Inspector 的成功不能替代它',
    );
    skip(
      '品牌类型「不可互赋」的运行期证据',
      '品牌只在编译期存在（运行期就是字符串）。这一条的验证在 tests/unit/idempotency.test.ts 里，' +
        '用 @ts-expect-error 钉住，由 `npx tsc --noEmit` 核对；本脚本无法在运行期复现它',
    );

    console.log(
      `\n${failures === 0 ? 'ALL PASS' : `${String(failures)} FAILED`} — ${String(passes)} PASSED / ${String(failures)} FAILED / ${String(skips)} NOT_RUN`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
