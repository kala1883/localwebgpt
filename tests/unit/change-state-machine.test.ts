/**
 * LWB-022 单元测试（一）：状态机与转移表。
 *
 * ## 装置为什么是这个形状
 *
 * 本任务的三条验收标准里有一条是**否定式**的：
 *
 *  - 「不可从 APPLIED、REJECTED、EXPIRED 倒退到可再次执行状态」——
 *    断言的是「没有一条路」。
 *
 * 「没有一条路」不能靠读一遍实现来确认，只能**遍历**：把转移表当图走一遍
 * 闭包，检查终态能到达的集合里有没有可执行状态。因此本文件里最重的几组
 * 用例都是图论性质的，而不是「调一次、看它抛不抛」。
 *
 * 遍历的前提是转移表**覆盖了全部状态**。这一条不靠纪律，靠两处断言：
 * `Record<State, …>` 的键是全集（漏一个是编译错误），以及 A 组把键集合与
 * `@lwb/contracts`、`@lwb/persistence` 的冻结枚举逐一对齐。少了 A 组，
 * 「表里没有 PENDING_APPROVAL 这一格」会让 C 组**静默通过** —— 一个状态
 * 不在表里，它的可达集合就是空的，而空集合里当然没有可执行状态。
 * 因此 C 组同时带一条非平凡性断言（C3）：可执行状态**确实**能从前面的
 * 状态到达。否则一张全空的表也能过 C1。
 *
 * ## 用的是真库，不是桩
 *
 * E 组要证的是「拒绝发生在**任何写入之前**”，这需要真的有一行可以被写坏。
 * `ChangesRepo.transition` 的 `WHERE state IN (…)` 是并发下的真正保证，
 * 把它桩掉等于用桩自己的保证替换掉被测的保证。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  APPROVAL_STATES,
  CHANGE_STATE_LABELS,
  CONTRACT_VERSION,
  LIMITS,
  OPERATION_STATES,
  TERMINAL_CHANGE_STATES,
  isTerminalChangeState,
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
import type { ChangeItemInput, OpenDatabaseResult } from '@lwb/persistence';
import {
  APPROVAL_TRANSITIONS,
  CHANGE_TRANSITIONS,
  EXECUTION_CHANGE_STATES,
  OPERATION_TRANSITIONS,
  TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE,
  TERMINAL_BY_TRANSITION_TABLE,
  TERMINAL_COUNTS,
  TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE,
  assertApprovalTransition,
  assertChangeTransition,
  assertOperationTransition,
  canTransition,
  canTransitionApproval,
  isExecutionChangeState,
  reachableChangeStates,
  reachableFromEveryChangeState,
  transitionChange,
  transitionOperation,
} from '@lwb/changes';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CONNECTION = 'conn_sm';
const WORKSPACE = 'ws_sm';
const PRINCIPAL = 'principal_sm';
const VOLUME = 'vol-sm';
const GENERATION = 3;
const POLICY_VERSION = 2;
const T0 = '2026-09-25T10:00:00.000Z';
const T0_MS = Date.parse(T0);

let opened: OpenDatabaseResult;
let repos: Repositories;
let seq = 0;

const nextId = (prefix: string): string => `${prefix}_${(seq += 1).toString().padStart(4, '0')}`;

/** 造一个 sha256 形状的十六进制串。**不是**真哈希：本测试不读文件内容。 */
const fakeSha = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');

/**
 * 建一个 `PENDING_APPROVAL` 修改集，走**真实仓储**。
 *
 * 摘要字段的取值只要形状对即可：本文件测的是状态，不是内容。
 * 但表和触发器都是真的 —— `changesets_content_immutable` 与
 * `changesets_terminal_tombstone` 会在 E 组里真的被触发。
 */
function makeChange(seed: string): string {
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
    summary: `状态机夹具 ${seed}`,
    expires_at: new Date(T0_MS + LIMITS.CHANGE_TTL_MS).toISOString(),
    items,
  }).id;
}

function stateOf(changeId: string): ChangeSetState {
  return repos.changes.requireById(changeId).state;
}

/** 沿**合法边**把一个修改集推到目标状态。非法路径会在这里就炸，而不是静默跳过。 */
const PATHS: Readonly<Record<string, readonly ChangeSetState[]>> = {
  PENDING_APPROVAL: [],
  APPROVED: ['APPROVED'],
  QUEUED: ['APPROVED', 'QUEUED'],
  VALIDATING: ['APPROVED', 'QUEUED', 'VALIDATING'],
  APPLYING: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING'],
  APPLIED: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'APPLIED'],
  ROLLED_BACK: ['APPROVED', 'QUEUED', 'VALIDATING', 'APPLYING', 'ROLLED_BACK'],
};

/** 把修改集走到某个状态；返回它的 id。只支持 `PATHS` 里有路的那几个。 */
function advanceTo(seed: string, target: ChangeSetState): string {
  const changeId = makeChange(seed);
  const path = PATHS[target];
  assert.ok(path !== undefined, `夹具不支持走到 ${target}`);
  let previous: ChangeSetState = 'PENDING_APPROVAL';
  for (const step of path) {
    transitionChange(repos, { change_id: changeId, from: [previous], to: step });
    previous = step;
  }
  return changeId;
}

/** 捕获一次 `BridgeError`，并断言它确实是本工程错误而不是 TypeError。 */
function catchBridgeError(fn: () => unknown): BridgeError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BridgeError, `应抛出 BridgeError，实际：${String(caught)}`);
  return caught;
}

/** 一次拒绝的具体理由。断言理由**必须存在**：光「抛了个错」证明不了拒绝的是这件事。 */
function reasonOf(error: BridgeError): unknown {
  const details = error.details;
  assert.ok(details !== undefined, `BridgeError(${error.code}) 应当带上 details.reason`);
  return details['reason'];
}

/** 转移表的全部边，形如 `['PENDING_APPROVAL→APPROVED', …]`，升序。 */
function edgesOf(table: Readonly<Record<string, readonly string[]>>): string[] {
  const edges: string[] = [];
  for (const [from, tos] of Object.entries(table)) {
    for (const to of tos) edges.push(`${from}→${to}`);
  }
  return edges.sort();
}

/** 某个状态的**全部前驱**。用来表达「QUEUED 只能由 APPROVED 到达」。 */
function predecessorsOf(state: ChangeSetState): ChangeSetState[] {
  return (Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[])
    .filter((candidate) => CHANGE_TRANSITIONS[candidate].includes(state))
    .sort();
}

before(() => {
  opened = openDatabase({ path: ':memory:' });
  repos = new Repositories(opened.db);
  repos.connections.create({
    id: CONNECTION,
    principal_kind: 'model_surface',
    principal_id: PRINCIPAL,
    alias: '状态机夹具',
    enabled: true,
  });
  repos.workspaces.create({
    id: WORKSPACE,
    alias: '状态机夹具',
    kind: 'directory',
    canonical_root: 'C:\\state-machine-fixture',
    volume_id: VOLUME,
    root_file_id: 'root-file-id',
    policy_version: POLICY_VERSION,
    mode: 'read_propose_apply_with_local_approval',
  });
});

after(() => {
  closeDatabase(opened.db);
});

// ---------------------------------------------------------------------------
// A. 转移表与冻结枚举对齐
// ---------------------------------------------------------------------------

describe('LWB-022 A 转移表的键是状态全集，且与冻结枚举一致', () => {
  it('A1 修改集转移表覆盖契约定义的全部状态', () => {
    // 这一条是 C 组的**前提**：不在表里的状态可达集合为空，会让
    // 「终态到不了可执行状态」静默通过。
    assert.deepEqual(
      Object.keys(CHANGE_TRANSITIONS).sort(),
      Object.keys(CHANGE_STATE_LABELS).sort(),
      '转移表必须覆盖 CHANGE_STATE_LABELS 的每一个状态',
    );
    assert.deepEqual(
      Object.keys(CHANGE_TRANSITIONS).sort(),
      [...FROZEN_CHANGE_STATES].sort(),
      '转移表的键必须等于迁移 v1 冻结的那一份',
    );
  });

  it('A2 操作转移表覆盖 FROZEN_OPERATION_STATES', () => {
    assert.deepEqual(Object.keys(OPERATION_TRANSITIONS).sort(), [...FROZEN_OPERATION_STATES].sort());
    assert.deepEqual(Object.keys(OPERATION_TRANSITIONS).sort(), [...OPERATION_STATES].sort());
  });

  it('A3 批准转移表覆盖契约，且与 approvals 表的 CHECK 约束一致', () => {
    assert.deepEqual(Object.keys(APPROVAL_TRANSITIONS).sort(), [...APPROVAL_STATES].sort());

    // 强断言：直接从建表语句里把 CHECK 的取值读出来。`APPROVAL_STATES` 没有
    // 冻进迁移文件（另两个有），所以「库里认哪些值」与「表里认哪些值」
    // 只能这样对 —— 否则 approvals 表多出一个状态时，转移表不会有反应。
    const row = opened.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
      .get() as { sql: string } | undefined;
    assert.ok(row !== undefined, 'approvals 表必须存在');

    const check = /state\s+TEXT\s+NOT NULL\s+CHECK\s*\(state\s+IN\s*\(([^)]*)\)\)/i.exec(row.sql);
    assert.ok(check !== null, `approvals.state 必须有 CHECK 约束，实际建表语句：${row.sql}`);
    const inDdl = (check[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((part) => part.length > 0)
      .sort();

    assert.deepEqual(inDdl, Object.keys(APPROVAL_TRANSITIONS).sort());
  });

  it('A4 每条边的两端都是已知状态（值里没有拼错的状态名）', () => {
    const known = new Set(Object.keys(CHANGE_TRANSITIONS));
    for (const edge of edgesOf(CHANGE_TRANSITIONS)) {
      const [from, to] = edge.split('→') as [string, string];
      assert.ok(known.has(from), `边的起点 ${from} 不在状态全集里`);
      assert.ok(known.has(to), `边的终点 ${to} 不在状态全集里`);
    }
    // 自环一律不许：自环会让「NO_OP 被拒绝」与「这条边存在」互相矛盾。
    for (const edge of edgesOf(CHANGE_TRANSITIONS)) {
      const [from, to] = edge.split('→') as [string, string];
      assert.notEqual(from, to, `状态机里不应有自环：${edge}`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 墓碑态由表推出
// ---------------------------------------------------------------------------

describe('LWB-022 B 墓碑态是推出来的，且与契约的清单一致', () => {
  it('B1 推出来的墓碑态等于 TERMINAL_CHANGE_STATES 与冻结的墓碑清单', () => {
    // 三方对齐：从转移表推出的、契约里的、迁移文件冻结的。
    // 手写第三份清单会与表漂移，而漂移方向恰好是最坏的：表里多了一条出边，
    // 清单还说它是墓碑 —— 于是「终态不可逆」变成一句没人核对的话。
    assert.deepEqual([...TERMINAL_BY_TRANSITION_TABLE].sort(), [...TERMINAL_CHANGE_STATES].sort());
    assert.deepEqual(
      [...TERMINAL_BY_TRANSITION_TABLE].sort(),
      [...FROZEN_TOMBSTONE_CHANGE_STATES].sort(),
    );
    assert.deepEqual(
      [...TERMINAL_BY_TRANSITION_TABLE].sort(),
      (Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]).filter(isTerminalChangeState).sort(),
    );
  });

  it('B2 TERMINAL_COUNTS 如实反映三张表的墓碑数', () => {
    assert.equal(TERMINAL_COUNTS.change, TERMINAL_BY_TRANSITION_TABLE.length);
    assert.equal(TERMINAL_COUNTS.operation, TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE.length);
    assert.equal(TERMINAL_COUNTS.approval, TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE.length);
  });

  it('B3 操作与批准的墓碑态就是「没有出边」的那几个', () => {
    assert.deepEqual(
      [...TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE].sort(),
      ['APPLIED', 'CONFLICT', 'FAILED_NO_CHANGE', 'ROLLED_BACK'],
    );
    assert.deepEqual(
      [...TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE].sort(),
      ['CONSUMED', 'EXPIRED', 'REVOKED'],
    );
  });

  it('B4 RECOVERY_REQUIRED 不是墓碑：它必须能走到 APPLIED 或 ROLLED_BACK', () => {
    // 方案 §8.1：「RECOVERY_REQUIRED 可在核验后协调为 APPLIED（recovered=true）、
    // ROLLED_BACK，或继续等待人工」。把它当墓碑等于把一个需要人工介入的
    // 状态变成一个死结。
    assert.ok(!TERMINAL_BY_TRANSITION_TABLE.includes('RECOVERY_REQUIRED'));
    assert.deepEqual([...CHANGE_TRANSITIONS.RECOVERY_REQUIRED].sort(), ['APPLIED', 'ROLLED_BACK']);
    // 而它**不能**回到可执行状态：重放一次结果未知的写入正是它要阻止的事。
    for (const execution of EXECUTION_CHANGE_STATES) {
      assert.ok(
        !canTransition('RECOVERY_REQUIRED', execution),
        `RECOVERY_REQUIRED 不得回到 ${execution}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// C. 验收标准 2：终态不可回到可执行状态
// ---------------------------------------------------------------------------

describe('LWB-022 C 验收标准 2：不可从终态倒退到可再次执行状态', () => {
  it('C1 每一个终态的可达集合里都没有可执行状态', () => {
    const reachable = reachableFromEveryChangeState();
    for (const terminal of TERMINAL_BY_TRANSITION_TABLE) {
      const reached = reachable.get(terminal);
      assert.ok(reached !== undefined, `${terminal} 必须在可达性表里`);
      const illegal = [...reached].filter(isExecutionChangeState);
      assert.deepEqual(illegal, [], `${terminal} 不得到达任何可执行状态，实际可达：${illegal.join(',')}`);
    }
  });

  it('C2 终态的可达集合恰好是它自己（没有出边）', () => {
    for (const terminal of TERMINAL_BY_TRANSITION_TABLE) {
      assert.deepEqual([...reachableChangeStates(terminal)], [terminal]);
      assert.deepEqual([...CHANGE_TRANSITIONS[terminal]], []);
    }
  });

  it('C3 非平凡性：可执行状态确实能从前面的状态到达', () => {
    // 没有这一条，一张**全空的**转移表也能通过 C1 —— 而那样的表什么也没保证。
    for (const execution of EXECUTION_CHANGE_STATES) {
      assert.ok(
        reachableChangeStates('PENDING_APPROVAL').has(execution),
        `PENDING_APPROVAL 应当能到达 ${execution}`,
      );
    }
    // 反过来也要成立：终态集合非空，否则 C1 是对空集说话。
    assert.ok(TERMINAL_BY_TRANSITION_TABLE.length > 0);
  });

  it('C4 QUEUED 的唯一前驱是 APPROVED', () => {
    // 这一条是「没有批准的修改集排不进队」在状态机里的写法。
    // 它不是形式问题：一旦允许 PENDING_APPROVAL → QUEUED，绕过批准直接排队
    // 就成了一条**合法**转移，从此任何调用点都能这么写。
    assert.deepEqual(predecessorsOf('QUEUED'), ['APPROVED']);
    // 同理，写盘只能从 VALIDATING 进入。
    assert.deepEqual(predecessorsOf('APPLYING'), ['VALIDATING']);
  });

  it('C5 校验与写入之间的边是单向的，且 APPLIED 只可能来自 APPLYING 或恢复', () => {
    assert.deepEqual(predecessorsOf('APPLIED'), ['APPLYING', 'RECOVERY_REQUIRED']);
    assert.deepEqual(predecessorsOf('VALIDATING'), ['QUEUED']);
  });

  it('C6 闭包是传递的：PENDING_APPROVAL 能到达每一个状态', () => {
    const reached = reachableChangeStates('PENDING_APPROVAL');
    assert.ok(reached.has('PENDING_APPROVAL'), '闭包必须含起点自身');
    // 多跳，不是一跳：这两条都要经过 APPROVED → QUEUED → VALIDATING。
    assert.ok(reached.has('ROLLED_BACK'), 'APPLYING → ROLLED_BACK 是方案 §8.1 的一条边');
    assert.deepEqual([...reached].sort(), Object.keys(CHANGE_TRANSITIONS).sort());
  });

  it('C7 PENDING_APPROVAL 是唯一的入口状态，且没有状态是进不去的', () => {
    // 没有前驱 = 只能从新建立的修改集进入。它是状态图的根。
    assert.deepEqual(predecessorsOf('PENDING_APPROVAL'), []);
    // 反过来：除根之外每个状态都必须至少有一条入边。一个没有入边的状态
    // 是**死状态** —— 它在转移表里写着，却永远不可能出现，而针对它的
    // 用例会一直「通过」。
    for (const state of Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]) {
      if (state === 'PENDING_APPROVAL') continue;
      assert.ok(
        predecessorsOf(state).length > 0,
        `${state} 没有任何入边，是一个永远到不了的状态`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D. 表检查的拒绝理由
// ---------------------------------------------------------------------------

describe('LWB-022 D 表检查：拒绝的理由必须说清是哪种', () => {
  it('D1 NO_OP：来源里已含目标，且比 TERMINAL_STATE 更精确', () => {
    const error = catchBridgeError(() => assertChangeTransition(['APPLIED'], 'APPLIED'));
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    // 两个理由都真（APPLIED 既是终态又与目标相同），要报的是更精确的那个：
    // 「你这次调用什么也改变不了」比「你碰了终态」对排障更有用。
    assert.equal(reasonOf(error), 'NO_OP');
  });

  it('D2 TERMINAL_STATE：把墓碑推回可执行状态', () => {
    for (const terminal of TERMINAL_BY_TRANSITION_TABLE) {
      const error = catchBridgeError(() => assertChangeTransition([terminal], 'QUEUED'));
      assert.equal(error.code, 'CHANGE_STATE_INVALID');
      assert.equal(reasonOf(error), 'TERMINAL_STATE', `${terminal} 应当按终态拒绝`);
    }
  });

  it('D2b 终态连「合法」的去处也去不了（不是只挡可执行状态）', () => {
    const error = catchBridgeError(() => assertChangeTransition(['APPLIED'], 'ROLLED_BACK'));
    assert.equal(reasonOf(error), 'TERMINAL_STATE');
  });

  it('D3 每一个来源都被检查，不是只看 from[0]', () => {
    // APPROVED → QUEUED 合法，VALIDATING → QUEUED 不合法，而两者都不是终态。
    // 只查 from[0] 的实现会放行 —— 而它同时宣称了「VALIDATING 也能排队」。
    const error = catchBridgeError(() => assertChangeTransition(['APPROVED', 'VALIDATING'], 'QUEUED'));
    assert.equal(reasonOf(error), 'ILLEGAL_EDGE');
  });

  it('D4 ILLEGAL_EDGE：表里没有这条边', () => {
    const error = catchBridgeError(() => assertChangeTransition(['PENDING_APPROVAL'], 'APPLYING'));
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    assert.equal(reasonOf(error), 'ILLEGAL_EDGE');
  });

  it('D5 回归：PENDING_APPROVAL → QUEUED 不是一条边', () => {
    // 「批准并应用」曾经一步从待批准跳到已排队。加上这条边的诱惑很实在
    // （少一次 UPDATE），而代价是把「绕过批准直接排队」变成合法转移。
    // 这条用例钉住它：`approveAndQueue` 必须走两步。
    const error = catchBridgeError(() => assertChangeTransition(['PENDING_APPROVAL'], 'QUEUED'));
    assert.equal(reasonOf(error), 'ILLEGAL_EDGE');
    assert.equal(canTransition('PENDING_APPROVAL', 'QUEUED'), false);
  });

  it('D6 来源集合为空：按内部错误拒绝，不是「悄悄成功」', () => {
    const error = catchBridgeError(() => assertChangeTransition([], 'APPROVED'));
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(reasonOf(error), 'NO_SOURCE_STATES');
  });

  it('D7 details 里带上来源与目标，来源是排序后拼接的', () => {
    const error = catchBridgeError(() => assertChangeTransition(['VALIDATING', 'APPROVED'], 'QUEUED'));
    const details = error.details as Record<string, unknown>;
    assert.equal(details['from'], 'APPROVED,VALIDATING');
    assert.equal(details['to'], 'QUEUED');
  });

  it('D8 合法的边不会被误拒', () => {
    assertChangeTransition(['PENDING_APPROVAL'], 'APPROVED');
    assertChangeTransition(['PENDING_APPROVAL'], 'REJECTED');
    assertChangeTransition(['APPROVED'], 'QUEUED');
    assertChangeTransition(['QUEUED'], 'VALIDATING');
    assertChangeTransition(['VALIDATING'], 'APPLYING');
    assertChangeTransition(['APPLYING'], 'APPLIED');
    assertChangeTransition(['RECOVERY_REQUIRED'], 'APPLIED');
    // 多来源：两个来源都必须有这条边。注意不能拿 `['PENDING_APPROVAL','APPROVED']
    // → 'APPROVED'` 当例子 —— 那会命中 NO_OP（来源里已含目标），而被拒是**对的**。
    assertChangeTransition(['APPLYING', 'RECOVERY_REQUIRED'], 'APPLIED');
  });

  it('D9 操作与批准的检查是同一套（含各自的墓碑）', () => {
    assertOperationTransition(['QUEUED'], 'VALIDATING');
    const opTerminal = catchBridgeError(() => assertOperationTransition(['APPLIED'], 'QUEUED'));
    assert.equal(reasonOf(opTerminal), 'TERMINAL_STATE');

    assertApprovalTransition(['ACTIVE'], 'CONSUMED');
    const approvalTerminal = catchBridgeError(() => assertApprovalTransition(['CONSUMED'], 'ACTIVE'));
    assert.equal(reasonOf(approvalTerminal), 'TERMINAL_STATE');
    // 批准没有回头路：离开 ACTIVE 就回不去。这是 `approvals_no_reactivate`
    // 触发器在应用层的同一句话 —— 两处都要有，触发器挡的是**已经写下去的**
    // UPDATE，本表挡的是**根本不该发起的**一次调用。
    for (const spent of TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE) {
      assert.equal(canTransitionApproval(spent, 'ACTIVE'), false, `${spent} 不得到回 ACTIVE`);
    }
  });
});

// ---------------------------------------------------------------------------
// E. 与仓储层接起来：拒绝发生在任何写入之前
// ---------------------------------------------------------------------------

describe('LWB-022 E 流转的两层检查：图里的边 + 行此刻的状态', () => {
  it('E1 合法的流转真的落库', () => {
    const changeId = makeChange('e1');
    assert.equal(stateOf(changeId), 'PENDING_APPROVAL');
    const record = transitionChange(repos, {
      change_id: changeId,
      from: ['PENDING_APPROVAL'],
      to: 'APPROVED',
    });
    assert.equal(record.state, 'APPROVED');
    assert.equal(stateOf(changeId), 'APPROVED');
  });

  it('E2 图里没有的边：抛错，且状态一个字节都没动', () => {
    const changeId = makeChange('e2');
    const error = catchBridgeError(() =>
      transitionChange(repos, { change_id: changeId, from: ['PENDING_APPROVAL'], to: 'APPLYING' }),
    );
    assert.equal(reasonOf(error), 'ILLEGAL_EDGE');
    assert.equal(stateOf(changeId), 'PENDING_APPROVAL');
  });

  it('E3 行此刻不在声明的来源里：条件写失败，状态不变', () => {
    // 这一条**图检查会放过**（APPROVED → QUEUED 是合法边），只有仓储层的
    // `WHERE state IN (…)` 能挡住。两层缺一不可：只做图检查会让两个进程
    // 同时流转都通过；只做条件写会让「从终态发起的一次调用」在恰好匹配时成功。
    const changeId = advanceTo('e3', 'APPROVED');
    const error = catchBridgeError(() =>
      transitionChange(repos, { change_id: changeId, from: ['PENDING_APPROVAL'], to: 'APPROVED' }),
    );
    assert.equal(error.code, 'CHANGE_STATE_INVALID');
    const details = error.details as Record<string, unknown>;
    assert.equal(details['current_state'], 'APPROVED');
    assert.equal(details['allowed_from'], 'PENDING_APPROVAL');
    assert.equal(stateOf(changeId), 'APPROVED');
  });

  it('E4 走到 APPLIED 之后，任何流转都被拒绝且状态不变', () => {
    const changeId = advanceTo('e4', 'APPLIED');
    for (const to of ['QUEUED', 'VALIDATING', 'APPLYING', 'ROLLED_BACK'] as const) {
      const error = catchBridgeError(() =>
        transitionChange(repos, { change_id: changeId, from: ['APPLIED'], to }),
      );
      assert.equal(reasonOf(error), 'TERMINAL_STATE', `APPLIED → ${to} 应当按终态拒绝`);
      assert.equal(stateOf(changeId), 'APPLIED');
    }
  });

  it('E5 请求不存在的修改集：按找不到处理，不是状态错误', () => {
    const error = catchBridgeError(() =>
      transitionChange(repos, { change_id: 'chg_missing', from: ['PENDING_APPROVAL'], to: 'APPROVED' }),
    );
    assert.equal(error.code, 'CHANGE_NOT_FOUND');
  });

  it('E6 操作的流转同样两层检查', () => {
    const changeId = advanceTo('e6', 'QUEUED');
    const op = repos.operations.create({ id: nextId('op'), change_id: changeId });
    assert.equal(op.kind, 'created');
    assert.equal(op.operation.state, 'QUEUED');

    const validating = transitionOperation(repos, {
      operation_id: op.operation.id,
      from: ['QUEUED'],
      to: 'VALIDATING',
    });
    assert.equal(validating.state, 'VALIDATING');

    // 图里没有 QUEUED → APPLIED 这条边：写盘必须先经过校验。
    const illegal = catchBridgeError(() =>
      transitionOperation(repos, { operation_id: op.operation.id, from: ['QUEUED'], to: 'APPLIED' }),
    );
    assert.equal(reasonOf(illegal), 'ILLEGAL_EDGE');
    assert.equal(repos.operations.requireById(op.operation.id).state, 'VALIDATING');

    // 行不在声明的来源里 —— 图检查会放过（VALIDATING → APPLYING 合法）。
    const stale = catchBridgeError(() =>
      transitionOperation(repos, {
        operation_id: op.operation.id,
        from: ['QUEUED'],
        to: 'APPLYING',
      }),
    );
    assert.equal(stale.code, 'CHANGE_STATE_INVALID');
    assert.equal(repos.operations.requireById(op.operation.id).state, 'VALIDATING');
  });

  it('E7 `recovered`/`finished` 只在明确给出时生效', () => {
    const changeId = advanceTo('e7', 'APPLYING');
    const op = repos.operations.create({ id: nextId('op'), change_id: changeId });
    const operationId = op.operation.id;

    // 走一遍合法的三跳。写盘之前必须先校验 —— 这正是 E6 拒绝 QUEUED → APPLIED 的理由。
    transitionOperation(repos, { operation_id: operationId, from: ['QUEUED'], to: 'VALIDATING' });
    transitionOperation(repos, { operation_id: operationId, from: ['VALIDATING'], to: 'APPLYING' });

    // 一个「不知道写没写」的操作：进 RECOVERY_REQUIRED 时没给任何选项，
    // 于是它既没被标成已恢复，也没有结束时间 —— 这两个字段是**事实**，
    // 不能由一个没传的参数顺手填上。
    const unknown = transitionOperation(repos, {
      operation_id: operationId,
      from: ['APPLYING'],
      to: 'RECOVERY_REQUIRED',
    });
    assert.equal(unknown.recovered, false, '未显式给出时不得把操作标成已恢复');
    assert.equal(unknown.finished_at, null, '未说 finished 时不得写 finished_at');

    // 核验之后协调为 APPLIED：方案 §8.1 的 `recovered=true` 就是这一跳。
    const recovered = transitionOperation(repos, {
      operation_id: operationId,
      from: ['RECOVERY_REQUIRED'],
      to: 'APPLIED',
      recovered: true,
      finished: true,
    });
    assert.equal(recovered.state, 'APPLIED');
    assert.equal(recovered.recovered, true);
    assert.ok(recovered.finished_at !== null, 'APPLIED 应当写上 finished_at');
  });
});
