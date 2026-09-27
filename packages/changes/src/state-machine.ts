/**
 * 修改集 / 操作 / 批准的状态机（LWB-022 步骤 1，方案 §8.1）。
 *
 * ## 为什么转移表是**数据**而不是一串 `if`
 *
 * 验收标准里有一条是否定式的：*不可从 APPLIED、REJECTED、EXPIRED 倒退到
 * 可再次执行状态*。否定式的性质不能靠「读一遍实现，觉得没写错」来确认 ——
 * 它能被确认，是因为它可以被**遍历**：把转移表当图走一遍闭包，检查
 * 「终态能到达的状态里有没有可执行的」。
 *
 * 写成散布在十几个 `throw` 里的判断，同一句话就只能靠人眼过。因此这里的
 * 转移表是三个 `Record<State, readonly State[]>`，`Record` 的键是状态的**全集**，
 * 少写一个状态是编译错误 —— 「每个状态都被归类过」因此不是纪律，是类型。
 *
 * ## 表里的边从哪来
 *
 * 骨架是方案 §8.1 的图，一字不改。图之外另有两条边，它们不是自选的：
 *
 *  - `APPROVED → EXPIRED` / `QUEUED → EXPIRED`：LWB-024 验收标准 1 原文
 *    「离线前批准、重连后过期的任务不会自动落盘」。批准的有效期是 10 分钟
 *    （`LIMITS.APPROVAL_TTL_MS`），而排队到执行之间可以隔着一次离线 ——
 *    只允许从 `PENDING_APPROVAL` 过期，会让「批准过期了」这件事在
 *    `QUEUED` 上无处表达。
 *  - `APPROVED → INVALIDATED` / `QUEUED → INVALIDATED`：LWB-024 步骤 1 原文
 *    「工作区重定位、策略变化、连接禁用和本地撤销批准时使相关**待执行**
 *    修改集失效」。「待执行」按定义包含已经批准与已经排队的那些。
 *
 * 三条 `EXPIRED` / `INVALIDATED` / `REJECTED` 是**墓碑态**：它们没有出边。
 *
 * ## 这个模块**不做**什么
 *
 *  - **不写库。** 转移表是纯数据；`transitionChange` / `transitionOperation`
 *    把表检查与仓储层的条件更新接在一起，但条件更新本身在仓储层 ——
 *    那里的 `WHERE state IN (…)` 才是并发下的真正保证（见
 *    `ChangesRepo.transition` 的注释）。本模块只保证**调用方声明的转移
 *    是图里的一条边**，从而让「状态对不对」这件事不必在每个调用点重想一遍。
 *  - **不发明状态。** 状态的全集来自 `@lwb/contracts`，本模块不定义新的字面量。
 */

import { BridgeError } from '@lwb/contracts';
import type { ApprovalState, ChangeSetState, OperationState } from '@lwb/contracts';
import type { ChangeSetRecord, OperationRecord, Repositories } from '@lwb/persistence';

// ---------------------------------------------------------------------------
// 转移表
// ---------------------------------------------------------------------------

/**
 * 修改集的转移表（方案 §8.1）。
 *
 * 键是**全集**：`Record<ChangeSetState, …>` 让漏掉一个状态成为编译错误。
 * 值为空数组即墓碑态 —— 「没有出边」是一个显式声明，而不是「没写」。
 */
export const CHANGE_TRANSITIONS: Readonly<Record<ChangeSetState, readonly ChangeSetState[]>> = {
  // 只在这一格上等待人的决定。三条墓碑边（拒绝 / 过期 / 失效）与一条前进边。
  PENDING_APPROVAL: ['REJECTED', 'EXPIRED', 'INVALIDATED', 'APPROVED'],
  // APPROVED 不表示已写；它表示「有一份仍然有效的批准，可以排队了」。
  APPROVED: ['QUEUED', 'EXPIRED', 'INVALIDATED'],
  // QUEUED 不表示成功。校验可能发现磁盘已经变了（CONFLICT），
  // 也可能在动手之前就退出（FAILED_NO_CHANGE），
  // 还可能在进程死掉后留下一个说不清的状态（RECOVERY_REQUIRED）。
  QUEUED: ['VALIDATING', 'CONFLICT', 'FAILED_NO_CHANGE', 'RECOVERY_REQUIRED', 'EXPIRED', 'INVALIDATED'],
  // 这一格是**写之前**的最后一次核对：全部既有文件身份与原始哈希。
  // 它只有一条前进边 —— 任何一处不符都在这里退出，不会走到 APPLYING。
  VALIDATING: ['APPLYING', 'CONFLICT', 'FAILED_NO_CHANGE', 'RECOVERY_REQUIRED'],
  // 已经开始写盘。这一格之后的任何「不知道」都不是失败，是需要恢复。
  APPLYING: ['APPLIED', 'ROLLED_BACK', 'RECOVERY_REQUIRED'],
  // 方案 §8.1：核验后可协调为 APPLIED（recovered=true）或 ROLLED_BACK，
  // 否则继续等待人工。**没有回到 QUEUED 的边** —— 重放一次未知结果的写入
  // 正是这一格要阻止的事。
  RECOVERY_REQUIRED: ['APPLIED', 'ROLLED_BACK'],
  // --- 以下为墓碑态：没有出边 -------------------------------------------
  REJECTED: [],
  EXPIRED: [],
  INVALIDATED: [],
  APPLIED: [],
  ROLLED_BACK: [],
  FAILED_NO_CHANGE: [],
  CONFLICT: [],
};

/**
 * 操作的转移表。它是修改集表的**同一段路径**，只是起点更靠后 ——
 * 操作在修改集进入 `APPROVED` 之后才被创建，因此没有 `PENDING_APPROVAL`
 * 开头的那三段。
 *
 * 两张表分开写而不是从修改集表裁剪出来，是因为它们**可以合法地分叉**：
 * LWB-024 让修改集失效时，操作未必跟着走同一条边（一次已经失败的写入
 * 不会因为工作区被重定位而变成别的什么）。共用一张表会让这种分叉看起来
 * 像一处疏漏。
 */
export const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  QUEUED: ['VALIDATING', 'CONFLICT', 'FAILED_NO_CHANGE', 'RECOVERY_REQUIRED'],
  VALIDATING: ['APPLYING', 'CONFLICT', 'FAILED_NO_CHANGE', 'RECOVERY_REQUIRED'],
  APPLYING: ['APPLIED', 'ROLLED_BACK', 'RECOVERY_REQUIRED'],
  RECOVERY_REQUIRED: ['APPLIED', 'ROLLED_BACK'],
  // --- 墓碑态 -------------------------------------------------------------
  APPLIED: [],
  ROLLED_BACK: [],
  FAILED_NO_CHANGE: [],
  CONFLICT: [],
};

/**
 * 批准的转移表。
 *
 * 三张表里唯一一张**全部**从 ACTIVE 出发的：批准一旦离开 ACTIVE 就再也
 * 回不去（`approvals_no_reactivate` 触发器在数据库层也写着同一句话）。
 * 那张触发器是结构性的保证，本表是同一句话在应用层的表达 ——
 * 两处都要有，因为触发器挡住的是**已经写下去的** UPDATE，
 * 而本表挡住的是**根本不该发起的**一次调用。
 */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  ACTIVE: ['CONSUMED', 'REVOKED', 'EXPIRED'],
  CONSUMED: [],
  REVOKED: [],
  EXPIRED: [],
};

/**
 * **可执行**的修改集状态：这些状态意味着「将要写、正在写」。
 *
 * LWB-022 验收标准 2 的否定式断言需要一个正面的名字：不是「不可从终态倒退
 * 到 QUEUED 及以上」，而是「不可从终态到达任何一个可执行状态」。两个说法
 * 等价，但后者可以被遍历检查。
 *
 * `@lwb/approvals` 的 `EXECUTION_STATES` 就指向这里 —— 那是执行协调器
 * 在写盘前复核批准时允许的来源状态，与本节讲的是同一个集合。
 * 两处各写一遍会让「执行中有哪几个状态」有两个答案。
 */
export const EXECUTION_CHANGE_STATES: readonly ChangeSetState[] = ['QUEUED', 'VALIDATING', 'APPLYING'];

export function isExecutionChangeState(state: ChangeSetState): boolean {
  return EXECUTION_CHANGE_STATES.includes(state);
}

/**
 * 同一个集合，**操作**那一侧。
 *
 * 两个常量而不是一个，因为 `ChangeSetState` 与 `OperationState` 是两个
 * 联合类型：它们的字面量重合，编译器却不会让一个赋给另一个
 * （`'PENDING_APPROVAL'` 不是 `OperationState`）。把上面那个直接传给
 * `transitionOperation` 是**编译不过**的 —— 而那道编译错误值得保留，
 * 它正是「修改集在 QUEUED 而操作早已终结」这类错位在类型层的探针。
 *
 * 名字与内容都刻意与上面那份逐字对应：这两行不描述两个集合，
 * 描述的是**同一个集合在两个类型世界里的同一个名字**。
 */
export const EXECUTION_OPERATION_STATES: readonly OperationState[] = ['QUEUED', 'VALIDATING', 'APPLYING'];

// ---------------------------------------------------------------------------
// 图上的查询
// ---------------------------------------------------------------------------

/** 一条转移是否在图里。`from === to` 一律为假：状态机里没有自环。 */
export function canTransition(from: ChangeSetState, to: ChangeSetState): boolean {
  return CHANGE_TRANSITIONS[from].includes(to);
}

export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

/**
 * `from` 沿转移表能到达的**全部**状态（含 `from` 自身）。
 *
 * 存在的唯一理由是让「终态到不了可执行状态」这句话可以被写成一次计算 ——
 * 见 `tests/unit/change-state-machine.test.ts` 与 `scripts/evidence/lwb-022.ts`。
 */
export function reachableChangeStates(from: ChangeSetState): ReadonlySet<ChangeSetState> {
  const seen = new Set<ChangeSetState>();
  const queue: ChangeSetState[] = [from];
  while (queue.length > 0) {
    const current = queue.pop() as ChangeSetState;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of CHANGE_TRANSITIONS[current]) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** 全表可达性：每个状态 → 它能到达的集合。供证据脚本一次算完所有墓碑。 */
export function reachableFromEveryChangeState(): ReadonlyMap<ChangeSetState, ReadonlySet<ChangeSetState>> {
  const all = new Map<ChangeSetState, ReadonlySet<ChangeSetState>>();
  for (const state of Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]) {
    all.set(state, reachableChangeStates(state));
  }
  return all;
}

// ---------------------------------------------------------------------------
// 表检查
// ---------------------------------------------------------------------------

/** 拒绝的原因。比错误码细：错误码面向调用方，原因面向排障。 */
export type TransitionRefusal =
  /** 来源集合里有终态 —— 想把墓碑推回可执行状态。 */
  | 'TERMINAL_STATE'
  /** 表里没有这条边。 */
  | 'ILLEGAL_EDGE'
  /** `to` 出现在 `from` 里：这次调用什么也不会改变，却会成功返回。 */
  | 'NO_OP'
  /** 来源集合为空。 */
  | 'NO_SOURCE_STATES';

interface TransitionCheck<S extends string> {
  readonly from: readonly S[];
  readonly to: S;
  readonly edges: Readonly<Record<S, readonly S[]>>;
  readonly terminal: readonly S[];
}

/**
 * 把「调用方声明的来源集合」与转移表对一遍。
 *
 * 检查的是**每一个**来源，不是一个：只查 `from[0]` 会让
 * `transition(id, ['PENDING_APPROVAL', 'APPLIED'], 'QUEUED')` 通过前半句而被放行 ——
 * 而它把墓碑态也写进了允许的来源里，正是验收标准 2 要挡的那件事。
 */
function refuseTransition<S extends string>(check: TransitionCheck<S>): TransitionRefusal | null {
  const { from, to, edges, terminal } = check;
  if (from.length === 0) return 'NO_SOURCE_STATES';
  // NO_OP 排在终态之前：`from: ['APPLIED'], to: 'APPLIED'` 两个都真，
  // 而「什么也没变却成功了」是更精确的那句话。
  if (from.includes(to)) return 'NO_OP';
  if (from.some((state) => terminal.includes(state))) return 'TERMINAL_STATE';
  if (from.some((state) => !edges[state].includes(to))) return 'ILLEGAL_EDGE';
  return null;
}

function transitionError(
  kind: '修改集' | '操作' | '批准',
  reason: TransitionRefusal,
  from: readonly string[],
  to: string,
): BridgeError {
  const detail = { reason, from: [...from].sort().join(','), to };
  switch (reason) {
    case 'TERMINAL_STATE':
      // 这句话是验收标准 2 的原文，逐字保留 —— 排障的人应当直接读到它。
      return new BridgeError(
        'CHANGE_STATE_INVALID',
        `${kind}已经进入终态，不可再流转到其他状态（终态不可逆）。`,
        detail,
      );
    case 'ILLEGAL_EDGE':
      return new BridgeError('CHANGE_STATE_INVALID', `${kind}状态机里没有这条转移。`, detail);
    case 'NO_OP':
      return new BridgeError('CHANGE_STATE_INVALID', `来源状态里已经包含目标状态，这次流转什么也不会改变。`, detail);
    case 'NO_SOURCE_STATES':
      return new BridgeError('INTERNAL_ERROR', `${kind}状态流转必须声明合法的来源状态。`, detail);
    default: {
      const never: never = reason;
      throw new Error(`未处理的流转拒绝原因：${String(never)}`);
    }
  }
}

/** 只检查、不写库。装配期与执行前复核用得上。 */
export function assertChangeTransition(from: readonly ChangeSetState[], to: ChangeSetState): void {
  const reason = refuseTransition<ChangeSetState>({
    from,
    to,
    edges: CHANGE_TRANSITIONS,
    terminal: TERMINAL_TOMBSTONES,
  });
  if (reason) throw transitionError('修改集', reason, from, to);
}

export function assertOperationTransition(from: readonly OperationState[], to: OperationState): void {
  const reason = refuseTransition<OperationState>({
    from,
    to,
    edges: OPERATION_TRANSITIONS,
    terminal: OPERATION_TOMBSTONES,
  });
  if (reason) throw transitionError('操作', reason, from, to);
}

export function assertApprovalTransition(from: readonly ApprovalState[], to: ApprovalState): void {
  const reason = refuseTransition<ApprovalState>({
    from,
    to,
    edges: APPROVAL_TRANSITIONS,
    terminal: APPROVAL_TOMBSTONES,
  });
  if (reason) throw transitionError('批准', reason, from, to);
}

/**
 * 墓碑态：没有出边的那些。**由转移表本身推出**，不是另抄一份清单。
 *
 * 手写的清单会与表漂移，而漂移的方向恰好是最坏的那个：表里偷偷多了一条出边，
 * 而清单还说它是墓碑。推出来的清单不会。
 */
const TERMINAL_TOMBSTONES: readonly ChangeSetState[] = (
  Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]
).filter((state) => CHANGE_TRANSITIONS[state].length === 0);

const OPERATION_TOMBSTONES: readonly OperationState[] = (
  Object.keys(OPERATION_TRANSITIONS) as OperationState[]
).filter((state) => OPERATION_TRANSITIONS[state].length === 0);

const APPROVAL_TOMBSTONES: readonly ApprovalState[] = (
  Object.keys(APPROVAL_TRANSITIONS) as ApprovalState[]
).filter((state) => APPROVAL_TRANSITIONS[state].length === 0);

/** 推导出的墓碑态，供测试与证据逐条核对（它们必须等于契约里那两份清单）。 */
export const TERMINAL_BY_TRANSITION_TABLE = TERMINAL_TOMBSTONES;
export const TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE = OPERATION_TOMBSTONES;
export const TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE = APPROVAL_TOMBSTONES;

// ---------------------------------------------------------------------------
// 与仓储层接起来
// ---------------------------------------------------------------------------

/**
 * 检查 + 条件更新。
 *
 * 两件事同时发生才算一次合法流转：
 *
 *  1. **本次调用想走的是一条图里的边**（本模块的表检查）；
 *  2. **数据库里那一行此刻确实处在允许的来源状态**（`ChangesRepo.transition`
 *     的 `WHERE state IN (…)`）。
 *
 * 只做第一件会让「两个进程同时流转」都通过；只做第二件会让「从终态出发的
 * 一次非法调用」在**恰好**当前状态匹配时成功。两件都要。
 *
 * 本函数**不**自己写 SQL：条件更新是仓储层的职责，而在别处再写一遍
 * `UPDATE changesets` 就是第二个能改这张表状态的地方。
 */
export function transitionChange(
  repos: Repositories,
  input: { readonly change_id: string; readonly from: readonly ChangeSetState[]; readonly to: ChangeSetState },
): ChangeSetRecord {
  assertChangeTransition(input.from, input.to);
  return repos.changes.transition(input.change_id, input.from, input.to);
}

export function transitionOperation(
  repos: Repositories,
  input: {
    readonly operation_id: string;
    readonly from: readonly OperationState[];
    readonly to: OperationState;
    readonly recovered?: boolean;
    readonly finished?: boolean;
  },
): OperationRecord {
  assertOperationTransition(input.from, input.to);
  return repos.operations.transition(input.operation_id, input.from, input.to, {
    ...(input.recovered === undefined ? {} : { recovered: input.recovered }),
    ...(input.finished === undefined ? {} : { finished: input.finished }),
  });
}

/**
 * 批准的流转**没有**这样一个包装函数，这是刻意的。
 *
 * 批准的三种流转（消费 / 撤销 / 到期）在仓储层各有自己的条件写，而且
 * **各自带着本流转必需的额外条件**：消费必须同时比对摘要与有效期
 * （`consume` 的 `WHERE … AND digest = ? AND expires_at > ?`），
 * 而摘要不是「从哪个状态到哪个状态」能表达的东西。套一层只做表检查的
 * 包装，会让调用方以为走它就已经带上了那些条件 —— 而它没有。
 *
 * 因此批准这一侧只提供 `assertApprovalTransition`：调用方先用它确认
 * 自己想走的是图里的边，再调仓储层那个带完整条件的动作。
 * `@lwb/approvals` 的 `decide.ts` 正是这么用的。
 */
export function assertApprovalStateChange(from: readonly ApprovalState[], to: ApprovalState): void {
  assertApprovalTransition(from, to);
}

/** 供装配与测试核对：本模块声明的墓碑态数量。 */
export const TERMINAL_COUNTS = Object.freeze({
  change: TERMINAL_TOMBSTONES.length,
  operation: OPERATION_TOMBSTONES.length,
  approval: APPROVAL_TOMBSTONES.length,
});
