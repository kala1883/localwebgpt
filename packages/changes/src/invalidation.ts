/**
 * 代次、过期与审批撤销（LWB-024）。
 *
 * ## 三件事，三个不同的时刻
 *
 * 这个模块的导出分属三个时刻，混在一起会看不出它们为什么不能合并：
 *
 *  1. **决定之前**（`INVALIDATABLE_STATES` / `EXPIRABLE_STATES`）——
 *     哪几个状态还可能被「拦下来」。由转移表**推导**，不另抄一份清单。
 *  2. **写入之前**（`revalidateExecutionBindings`）——纯函数，只读，
 *     把「这次执行依据的每一个代次与期限」重新核对一遍。它**返回全部
 *     不成立的理由**，不是抛第一个：排障时要看的是全景，而门禁要报的是
 *     主因，两者是同一次判定的两种投影。
 *  3. **事后**（失效写入、`sweepExpired`、`planSnapshotRetention`）——
 *     让已经不能执行的东西**显式地**变成不能执行，并把「哪些字节还不能删」
 *     从权威表里重建出来。
 *
 * ## 为什么「重新验证」要在这里而不是在排队时
 *
 * LWB-024 步骤 2 的原文是「执行前重新验证批准期限和所有代次，**不信任
 * 排队时校验**」。排队那一刻的校验是一次**采样**：它证明的是「那一刻成立」。
 * 而本任务验收标准 1 描述的正是采样失效的那条路径 —— 离线前批准、
 * 重连后过期。批准期限的判定在 `@lwb/approvals` 的门禁里（它每次用 `now`
 * 重算，不读标志位），**代次与工作区绑定**的判定在这里。
 *
 * 分工的理由：门禁回答「这份批准还能不能用」，本模块回答「它依据的那个
 * 世界还在不在」。前者只依赖 `approvals` 与 `changesets` 两张表，
 * 后者还要读 `workspaces` 与 `connections` —— 而门禁的调用方（控制台轮询、
 * 工具面）未必有后两者的可见性。
 *
 * ## refcount 不是「谁还需要这些字节」的答案
 *
 * 步骤 3 要求「定义过期清理与 blob 引用保留」。`blobs.refcount` 是**有几个
 * 引用**的计数，而回收真正要回答的问题是「**谁**还可能需要这些字节」——
 * 一个运行中的操作、一次未决的恢复、或一个仍在撤销窗口内的已终结修改集。
 * 这三者都写在权威表里（`changesets.state` / `operations.state` /
 * `changesets.updated_at`），因此本模块**从表里重建**保护判据，
 * 而不是读那个计数。
 *
 * 两者的差别不是风格：计数归零与「没人需要了」之间隔着一个
 * `releaseRef` 调用，而那次调用可能来自一条与保留策略无关的代码路径。
 * 计数为零而字节仍被需要的组合是**可以存在**的，下面的
 * `WITHIN_RETENTION_WINDOW` 就是它。
 *
 * ## 删除仍由 BlobStore 执行，本模块提供权威保留判据
 *
 * `snapshotGuard` 产出逐对象判据；`collectSnapshotGarbage` 只负责把该判据
 * 接入 `BlobStore.collectGarbage`。真正的删除仍在 BlobStore，那里固定了
 * 两条顺序不变量（先删字节后改状态、删除前再核实引用计数）。
 *
 * 编排层必须另外给出全局 `isSafeToCollect`。daemon 仅在单实例锁持有、启动
 * 恢复已结束、网络监听尚未开放时使用它；不能把它当成逐对象保留规则。
 */

import { BridgeError, CONTRACT_VERSION, LIMITS } from '@lwb/contracts';
import type { ApprovalState, BridgeErrorCode, ChangeSetState, OperationState } from '@lwb/contracts';
import type { BlobStore, GcReport } from '@lwb/blob-store';
import type {
  ChangeItemRecord,
  ChangeSetRecord,
  ConnectionRecord,
  Repositories,
  WorkspaceRecord,
} from '@lwb/persistence';

import { CHANGE_TRANSITIONS, EXECUTION_CHANGE_STATES, OPERATION_TRANSITIONS } from './state-machine.ts';

// ---------------------------------------------------------------------------
// 一、哪几个状态还可能被拦下来
// ---------------------------------------------------------------------------

/**
 * 可以失效的修改集状态：转移表里有 `INVALIDATED` 出边的那些。
 *
 * **推导，不是抄写。** 手写一份 `['PENDING_APPROVAL','APPROVED','QUEUED']`
 * 会与转移表漂移，而漂移的方向恰好是最坏的那个：表里给某个状态加了
 * `INVALIDATED` 出边，而失效逻辑还不知道它可以被失效 —— 于是那条边永远
 * 走不到，而「加了一条边」看起来像完成了一件事。
 *
 * 推导出来还有一个好处：`RECOVERY_REQUIRED` 与 `APPLYING` **不在**集合里
 * 这件事，是转移表说的（它们只能走向 APPLIED / ROLLED_BACK），
 * 不是本模块的偏好。它们不是「待执行」，是「待恢复」。
 */
export const INVALIDATABLE_STATES: readonly ChangeSetState[] = (
  Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]
).filter((state) => CHANGE_TRANSITIONS[state].includes('INVALIDATED'));

/** 可以过期的修改集状态：转移表里有 `EXPIRED` 出边的那些。同样是推导。 */
export const EXPIRABLE_STATES: readonly ChangeSetState[] = (
  Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]
).filter((state) => CHANGE_TRANSITIONS[state].includes('EXPIRED'));

/**
 * 两个集合的并集：**尚未决定的**修改集。
 *
 * 这是所有扫描/清理动作的作用域。它在结构上是一个小集合 —— 每个修改集
 * 最终都会离开这里（被拒绝、被批准并执行、过期、失效），因此
 * `ChangesRepo.listByStates(PENDING_CHANGE_STATES)` 不需要分页，
 * 而分页恰恰是「扫描漏掉一行」最容易藏身的地方。
 */
export const PENDING_CHANGE_STATES: readonly ChangeSetState[] = [
  ...new Set([...INVALIDATABLE_STATES, ...EXPIRABLE_STATES]),
].sort() as readonly ChangeSetState[];

/**
 * 尚未终结的修改集状态：转移表里**有出边**的那些。同样是推导。
 *
 * 与 `PENDING_CHANGE_STATES` 的差别是要点：`VALIDATING` / `APPLYING` /
 * `RECOVERY_REQUIRED` 不能失效也不能过期（表里没有那些边），但它们
 * **尚未终结** —— 因此保留策略必须把它们算进来。
 * 把这两个集合混成一个是「一次写入正在跑，而清理认为它已经结束」的成因。
 */
export const NON_TERMINAL_STATES: readonly ChangeSetState[] = (
  Object.keys(CHANGE_TRANSITIONS) as ChangeSetState[]
).filter((state) => CHANGE_TRANSITIONS[state].length > 0);

/**
 * 尚未收束的操作状态：操作转移表里有出边的那些。同样是推导。
 *
 * 保留策略**不能**用 `OperationsRepo.listUnfinished()`：那个方法问的是
 * 「上一个进程留下了什么」，因此只认三个执行状态 —— 一个
 * `RECOVERY_REQUIRED` 的操作不属于「遗留」，它已经被人接手了。
 * 而保留策略问的是「这些字节还有人在等吗」，等待恢复的那一个恰恰最需要
 * 原始字节。两者混用的表现是「待恢复的快照被回收了」，而那一刻回滚
 * 取不到原始字节。
 */
const OPEN_OPERATION_STATES: readonly OperationState[] = (
  Object.keys(OPERATION_TRANSITIONS) as OperationState[]
).filter((state) => OPERATION_TRANSITIONS[state].length > 0);

// ---------------------------------------------------------------------------
// 二、执行前重新验证（纯函数）
// ---------------------------------------------------------------------------

/** 一次执行的绑定关系里，可能不成立的那些。每一条都对应一次真实经历过的失效。 */
export type ExecutionBindingReason =
  /** 修改集指向的工作区记录已经不在了（库被换过、行被删）。 */
  | 'WORKSPACE_MISSING'
  /** 工作区已被移除（`removed_at` 非空），路径与身份都不可再用。 */
  | 'WORKSPACE_REMOVED'
  /** 工作区被停用，或处于暂停/待恢复。 */
  | 'WORKSPACE_DISABLED'
  /**
   * 工作区是只读模式 —— 可以读，但不能生成修改集，更不能应用。
   *
   * 单独一条而**不**并进 `WORKSPACE_DISABLED`，尽管两者对「能不能写」
   * 的含义相同：并进去会让错误码变成 `PAUSED`，而策略层对同一件事说的是
   * `POLICY_DENIED`（见 `packages/policy/src/decide.ts` 的
   * `WORKSPACE_MODE_READ_ONLY`）。两层对同一个事实报两个码，正是本模块
   * 开头说的那种「排障的人会去查那个说错的地方」。
   */
  | 'WORKSPACE_MODE_READ_ONLY'
  /** 资源根代次与修改集记录的不一致：重定位、启停、改模式都会递增它。 */
  | 'GENERATION_CHANGED'
  /** 工作区策略版本与修改集记录的不一致。 */
  | 'POLICY_VERSION_CHANGED'
  /** 修改集是在另一个契约版本下建立的。 */
  | 'CONTRACT_VERSION_CHANGED'
  /** 建立这个修改集的那条连接已经不在了。 */
  | 'OWNER_CONNECTION_MISSING'
  /** 归属连接被禁用。 */
  | 'CONNECTION_DISABLED'
  /** 修改集自身超过了有效期（`LIMITS.CHANGE_TTL_MS`）。 */
  | 'CHANGE_EXPIRED'
  /** 修改集当前状态不在本次调用允许的来源集合里。 */
  | 'CHANGE_STATE_INVALID';

/**
 * 固定的报告次序。
 *
 * 「全部理由」如果按发现顺序返回，两次同样的调用可能给出不同的排列 ——
 * 而排障记录里最不需要的东西就是不确定的顺序。这个数组同时是
 * `revalidateExecutionBindings` 的排序依据与测试的核对清单。
 */
export const EXECUTION_BINDING_REASONS: readonly ExecutionBindingReason[] = [
  'WORKSPACE_MISSING',
  'WORKSPACE_REMOVED',
  'WORKSPACE_DISABLED',
  'WORKSPACE_MODE_READ_ONLY',
  'GENERATION_CHANGED',
  'POLICY_VERSION_CHANGED',
  'CONTRACT_VERSION_CHANGED',
  'OWNER_CONNECTION_MISSING',
  'CONNECTION_DISABLED',
  'CHANGE_EXPIRED',
  'CHANGE_STATE_INVALID',
];

export interface ExecutionBindingInput {
  readonly change: ChangeSetRecord;
  /** 找不到时传 `null`，**不要**传一个「大致对得上」的记录。 */
  readonly workspace: WorkspaceRecord | null;
  readonly connection: ConnectionRecord | null;
  readonly now: string;
  /** 本次调用允许的来源状态。与 `evaluateApplyGate` 的 `allowed_from` 同义。 */
  readonly allowed_from: readonly ChangeSetState[];
}

export interface ExecutionBindingVerdict {
  readonly ok: boolean;
  /** **全部**不成立的理由，按 `EXECUTION_BINDING_REASONS` 的次序。 */
  readonly reasons: readonly ExecutionBindingReason[];
  /** 第一条，供只需要一句话的调用方使用。`ok` 时是 `null`。 */
  readonly primary: ExecutionBindingReason | null;
  readonly code: BridgeErrorCode | null;
  readonly message: string | null;
}

/**
 * 原因 → 错误码。与 `packages/policy/src/decide.ts` 的
 * `generationFailures` / `workspaceFailures` / 连接段逐条对齐。
 *
 * 三处（策略、门禁、本模块）对同一个事实给出同一个错误码这件事，
 * 值得一个具名函数：不一致时的表现是「策略说代次变了、门禁说没批准」，
 * 而排障的人会去查那个说错的地方。
 */
export function executionBindingErrorCode(reason: ExecutionBindingReason): BridgeErrorCode {
  switch (reason) {
    case 'WORKSPACE_MISSING':
    case 'WORKSPACE_REMOVED':
      return 'WORKSPACE_NOT_GRANTED';
    case 'WORKSPACE_DISABLED':
      return 'PAUSED';
    // 与策略层的 `WORKSPACE_MODE_READ_ONLY` 用同一个码。见类型定义处的说明。
    case 'WORKSPACE_MODE_READ_ONLY':
      return 'POLICY_DENIED';
    case 'GENERATION_CHANGED':
    case 'POLICY_VERSION_CHANGED':
    case 'CONTRACT_VERSION_CHANGED':
      return 'WORKSPACE_GENERATION_CHANGED';
    case 'OWNER_CONNECTION_MISSING':
      return 'NOT_AUTHORIZED';
    case 'CONNECTION_DISABLED':
      return 'CONNECTION_DISABLED';
    case 'CHANGE_EXPIRED':
    case 'CHANGE_STATE_INVALID':
      return 'CHANGE_STATE_INVALID';
    default: {
      const never: never = reason;
      throw new Error(`未处理的执行绑定原因：${String(never)}`);
    }
  }
}

/** 一句给操作者看的说明。**不含路径与内容。** */
export function executionBindingMessage(reason: ExecutionBindingReason): string {
  switch (reason) {
    case 'WORKSPACE_MISSING':
      return '修改集指向的工作区已不存在；该计划不能执行。';
    case 'WORKSPACE_REMOVED':
      return '该工作区已被移除；旧的修改集与批准均已失效。';
    case 'WORKSPACE_DISABLED':
      return '该工作区当前不可用（已停用或已暂停）；已阻断本次执行。';
    case 'WORKSPACE_MODE_READ_ONLY':
      return '该工作区为只读模式：可以读取，但不能生成修改集或写入；已阻断本次执行。';
    case 'GENERATION_CHANGED':
      return '工作区代次已变化，旧的票据、游标、修改集与批准均已失效。';
    case 'POLICY_VERSION_CHANGED':
      return '该工作区的策略版本已变化，需重新读取后再操作。';
    case 'CONTRACT_VERSION_CHANGED':
      return `修改集建立于另一个契约版本（${CONTRACT_VERSION} 之前），不能按当前语义执行；请重新读取后再提议。`;
    case 'OWNER_CONNECTION_MISSING':
      return '建立该修改集的连接已不存在；该计划不能执行。';
    case 'CONNECTION_DISABLED':
      return '该连接已被本地操作者禁用；已阻断本次执行。';
    case 'CHANGE_EXPIRED':
      return '修改集已超过有效期；请重新读取后再提议。';
    case 'CHANGE_STATE_INVALID':
      return '修改集当前状态不允许写入。';
    default: {
      const never: never = reason;
      throw new Error(`未处理的执行绑定原因：${String(never)}`);
    }
  }
}

/**
 * 执行前把「这次执行依据的世界」重新核对一遍。**只读，纯函数。**
 *
 * 返回**全部**不成立的理由而不是抛第一个，是因为两个调用方要的东西不同：
 * 门禁要一句话（`primary`），排障要全景（`reasons`）。抛异常只能给前者。
 *
 * 工作区这一侧有**两条**而不是一条，尽管它们对「能不能写」的含义相同
 * （现在不能写）：`WORKSPACE_DISABLED`（停用/暂停）与
 * `WORKSPACE_MODE_READ_ONLY`（只读模式）。分开的理由只有一个 ——
 * 策略层对这两件事报的是**两个不同的错误码**（`PAUSED` 与
 * `POLICY_DENIED`），而两处对同一个事实报两个码，正是本文件开头说的
 * 那种「排障的人会去查那个说错的地方」。
 *
 * 模式这一条曾经**只写在注释里**：本函数当时声称合并了「模式为只读」，
 * 代码里却只有 `enabled` 一项。它今天被补上，是因为执行协调器
 * （`packages/executor/`）成了「排队应用」这条路的第一道 —— 而一个
 * 在模式改变之后仍然能落盘的已批准修改集，恰好是唯一会读到这段话的人
 * 所依赖的那条保证。
 */
export function revalidateExecutionBindings(input: ExecutionBindingInput): ExecutionBindingVerdict {
  const found = new Set<ExecutionBindingReason>();
  const { change, workspace, connection, now } = input;

  if (workspace === null) {
    found.add('WORKSPACE_MISSING');
  } else {
    if (workspace.removed_at !== null) found.add('WORKSPACE_REMOVED');
    if (!workspace.enabled) found.add('WORKSPACE_DISABLED');
    // 模式是**执行期**的判据，不是提议期的。一个修改集可以在模式还是
    // 「可提议可应用」时被建立、被批准，然后操作者把工作区改成只读 ——
    // 那正是方案 §8.6 的「暂停立即阻断新调用和排队应用」。
    // 只读意味着不能写，因此这里必须拦，而不是等到写入中途才发现。
    if (workspace.mode !== 'read_propose_apply_with_local_approval') {
      found.add('WORKSPACE_MODE_READ_ONLY');
    }
    if (workspace.generation !== change.root_generation) found.add('GENERATION_CHANGED');
    if (workspace.policy_version !== change.policy_version) found.add('POLICY_VERSION_CHANGED');
  }

  // 契约版本是**全局**的，不是每个工作区一份，因此它与 workspace 是否取到无关。
  // 它的后果与「代次变了」相同：计划必须重新建立。
  if (change.contract_version !== CONTRACT_VERSION) found.add('CONTRACT_VERSION_CHANGED');

  if (connection === null) {
    found.add('OWNER_CONNECTION_MISSING');
  } else if (!connection.enabled) {
    found.add('CONNECTION_DISABLED');
  }

  // 时刻比较用字符串：ISO 8601 的字典序即时间序（见 `@lwb/contracts` 的时间约定）。
  if (change.expires_at <= now) found.add('CHANGE_EXPIRED');

  if (!input.allowed_from.includes(change.state)) found.add('CHANGE_STATE_INVALID');

  const reasons = EXECUTION_BINDING_REASONS.filter((reason) => found.has(reason));
  const primary = reasons[0] ?? null;

  return {
    ok: reasons.length === 0,
    reasons,
    primary,
    code: primary === null ? null : executionBindingErrorCode(primary),
    message: primary === null ? null : executionBindingMessage(primary),
  };
}

// ---------------------------------------------------------------------------
// 三、失效（写）
// ---------------------------------------------------------------------------

export type InvalidationTrigger =
  | 'WORKSPACE_RELOCATED'
  | 'POLICY_CHANGED'
  | 'WORKSPACE_DISABLED'
  | 'WORKSPACE_REMOVED'
  | 'CONNECTION_DISABLED'
  | 'APPROVAL_REVOKED'
  /** 修改集自身超过有效期。走的是 `EXPIRED` 而不是 `INVALIDATED`。 */
  | 'CHANGE_EXPIRED'
  /**
   * 本地服务被操作者**紧急停用**（LWB-034）。
   *
   * 它与 `APPROVAL_REVOKED` 有一个必须说清楚的区别：那一个表达的是
   * 「这一条批准被撤销了」，而本值表达的是「**从现在起**，凡是已经排好队
   * 但还没动笔的，一律作废」—— 撤销的是一批，而触发它的是一次全局动作。
   *
   * 它同样走到 `INVALIDATED`（不是 `EXPIRED`）：有效期还在，
   * 是有人**主动**否掉了它。把紧急停用写成「过期」会让操作者在
   * 失效清单里读到一句关于时间的话，而这件事与时间无关。
   */
  | 'SERVICE_PAUSED';

/** 一次失效**成功**的完整事实。写进审计的就是它。 */
export interface InvalidationOutcome {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly trigger: InvalidationTrigger;
  readonly from: ChangeSetState;
  readonly to: ChangeSetState;
  readonly at: string;
  /** 被一并收掉的那条批准；没有则 `null`。 */
  readonly approval_id: string | null;
  /** 它去了哪里：`REVOKED`（人撤销的）或 `EXPIRED`（自己到期的）。 */
  readonly approval_to: ApprovalState | null;
  /** 被一并收束的那个操作；没有则 `null`。 */
  readonly operation_id: string | null;
  readonly operation_to: OperationState | null;
}

export interface InvalidationSkip {
  readonly change_id: string;
  readonly reason: 'STATE_CHANGED' | 'NOT_FOUND';
  readonly current_state: ChangeSetState | null;
}

export interface InvalidationReport {
  readonly invalidated: readonly InvalidationOutcome[];
  readonly skipped: readonly InvalidationSkip[];
}

/** 操作在「修改集作废、本次写入不会发生」时的收束状态。 */
const OPERATION_ABANDONED: OperationState = 'FAILED_NO_CHANGE';

/** 日志阶段名。`@lwb/executor` 的写入阶段另有一套，本模块只写这一条。 */
export const JOURNAL_STAGE_INVALIDATED = 'invalidated';

/**
 * 让一个**待执行**的修改集失效，并把它名下的未决对象一并收束。
 *
 * 三件事在**一个**短事务里：
 *
 *  1. 撤销仍然 `ACTIVE` 的批准（如果有）；
 *  2. 修改集 `→ INVALIDATED`（或 `EXPIRED`，见 `trigger`）；
 *  3. 如果已经有操作，把它收束为 `FAILED_NO_CHANGE` 并记一条日志。
 *
 * ### 为什么第 3 步不是「操作也跟着变成 INVALIDATED」
 *
 * `OPERATION_TRANSITIONS` 里**没有** `INVALIDATED` 也没有 `EXPIRED` ——
 * 这不是遗漏，是 LWB-022 写下的设计：修改集与操作**可以合法地分叉**
 * （见 `state-machine.ts` 的注释）。一个已经排队的操作要表达的是
 * 「这次写入不会发生」，而操作表里表示这件事的状态是 `FAILED_NO_CHANGE`。
 *
 * 不收束它才是真正的错误：`OperationsRepo.listUnfinished()` 会在每次启动时
 * 把那个操作报成「上一个进程遗留的在途操作」，于是每一次启动都需要一次
 * 人工恢复 —— 而它其实什么也没做。
 *
 * ### 事务边界
 *
 * 上面三件事要么一起发生，要么都不发生。半完成的形态是「批准没了、
 * 修改集还在 APPROVED」：那个组合会让门禁报 `APPROVAL_MISSING`
 * 而不是「这个计划已经被作废了」，而两者对操作者是两句不同的话。
 */
export function invalidateChangeSet(
  repos: Repositories,
  input: {
    readonly change_id: string;
    readonly trigger: InvalidationTrigger;
    readonly now: string;
    /** 显式声明允许的来源状态。省略时用 `INVALIDATABLE_STATES`。 */
    readonly allowed_from?: readonly ChangeSetState[];
  },
): InvalidationOutcome {
  const to: ChangeSetState = input.trigger === 'CHANGE_EXPIRED' ? 'EXPIRED' : 'INVALIDATED';
  const allowedFrom = input.allowed_from ?? (to === 'EXPIRED' ? EXPIRABLE_STATES : INVALIDATABLE_STATES);

  return repos.transaction(() => {
    const change = repos.changes.requireById(input.change_id);
    if (!allowedFrom.includes(change.state)) {
      throw new BridgeError('CHANGE_STATE_INVALID', '修改集当前状态不允许失效。', {
        current_state: change.state,
        allowed_from: allowedFrom.join(','),
      });
    }

    // 1) 批准。先收批准再改状态：反过来的话，一次崩溃会留下
    //    「修改集已作废、批准却还是 ACTIVE」，而那正是门禁最想避免的组合。
    //
    //    到期与撤销分开走两个动作，因为它们是两句不同的话：「你的批准到期了」
    //    与「有人撤销了你的批准」。`CHANGE_TTL_MS`（24 小时）远长于
    //    `APPROVAL_TTL_MS`（10 分钟），因此**绝大多数**过期修改集身上的
    //    批准其实早已到期 —— 一律按 REVOKED 记，会让审计里几乎每一条都
    //    指向一次不存在的撤销。
    const active = repos.approvals.findActive(input.change_id);
    let approvalId: string | null = null;
    let approvalTo: ApprovalState | null = null;
    if (active !== null) {
      const expired = active.expires_at <= input.now;
      if (expired) repos.approvals.expire(active.id, input.now);
      else repos.approvals.revoke(active.id);
      approvalId = active.id;
      approvalTo = expired ? 'EXPIRED' : 'REVOKED';
    }

    // 2) 修改集。条件更新，`from` 里的 `WHERE state IN (…)` 是并发下的保证。
    const transitioned = repos.changes.transition(input.change_id, [change.state], to);

    // 3) 操作。
    let operationId: string | null = null;
    let operationTo: OperationState | null = null;
    const operation = repos.operations.findByChangeId(input.change_id);
    if (operation !== null && EXECUTION_CHANGE_STATES.includes(operation.state)) {
      repos.operations.transition(operation.id, [operation.state], OPERATION_ABANDONED, {
        finished: true,
      });
      repos.journal.append({
        operation_id: operation.id,
        stage: JOURNAL_STAGE_INVALIDATED,
        error_code: 'CHANGE_STATE_INVALID',
        detail: `修改集已作废（${input.trigger}），本次操作没有任何写入动作。`,
      });
      operationId = operation.id;
      operationTo = OPERATION_ABANDONED;
    }

    return {
      change_id: transitioned.id,
      workspace_id: transitioned.workspace_id,
      trigger: input.trigger,
      from: change.state,
      to: transitioned.state,
      at: input.now,
      approval_id: approvalId,
      approval_to: approvalTo,
      operation_id: operationId,
      operation_to: operationTo,
    };
  });
}

/**
 * 撤销一次本地批准。
 *
 * 撤销**同时**使修改集失效，而不是只把批准拿掉。理由是状态机逼出来的：
 * `APPROVED` 没有回到 `PENDING_APPROVAL` 的边，而 `approvals_active_uq`
 * 是 `WHERE state = 'ACTIVE'` 的**部分**唯一索引 —— 也就是说撤销之后
 * **可以**再签一份新批准。只撤销不失效，等于把一次明确的「停」变成
 * 「再点一下就能继续」，而那与操作者按下这个按钮的意图相反。
 *
 * 想继续的话，重新提议即可：那需要重新读取、重新摘要，是**另一次**决定。
 */
export function revokeLocalApproval(
  repos: Repositories,
  input: { readonly change_id: string; readonly now: string },
): InvalidationOutcome {
  return invalidateChangeSet(repos, {
    change_id: input.change_id,
    trigger: 'APPROVAL_REVOKED',
    now: input.now,
  });
}

/**
 * 按工作区批量失效。
 *
 * 作用域来自 `ChangesRepo.listByStates(PENDING_CHANGE_STATES)` —— 一个
 * **结构上有界**的小集合（见 `PENDING_CHANGE_STATES` 的说明），
 * 因此这里可以「一次取完、逐个处理」，不必分页。分页的代价不是性能，
 * 是「游标停在边界上时漏掉一行」这种**静默**的不完整 —— 而一次漏掉的
 * 失效意味着一个本该作废的计划仍然可以执行。
 *
 * 每一个修改集各自一个短事务：一个失效失败（例如它刚被批准、状态已经
 * 前进）不应该回滚其它已经完成的失效。失败的记进 `skipped`，不抛。
 */
export function invalidatePendingForWorkspace(
  repos: Repositories,
  input: {
    readonly workspace_id: string;
    readonly trigger: InvalidationTrigger;
    readonly now: string;
  },
): InvalidationReport {
  return invalidateMany(repos, {
    change_ids: repos.changes
      .listByStates(PENDING_CHANGE_STATES)
      .filter((change) => change.workspace_id === input.workspace_id)
      .map((change) => change.id),
    trigger: input.trigger,
    now: input.now,
  });
}

export function invalidatePendingForConnection(
  repos: Repositories,
  input: {
    readonly connection_id: string;
    readonly trigger: InvalidationTrigger;
    readonly now: string;
  },
): InvalidationReport {
  return invalidateMany(repos, {
    change_ids: repos.changes
      .listByStates(PENDING_CHANGE_STATES)
      .filter((change) => change.owner_connection_id === input.connection_id)
      .map((change) => change.id),
    trigger: input.trigger,
    now: input.now,
  });
}

/**
 * 按**显式的清单**失效，逐个各自一个短事务。
 *
 * 清单由调用方给出而不是在这里现查，是因为「查清单」与「逐条失效」之间
 * 隔着真实的墙钟时间：控制台可能正好在这中间按下批准。那个竞态不能靠
 * 「它不会发生」来处理，只能靠一个明确的容忍分支 —— 而一个只能被
 * 并发触发的分支如果拿不到一个能构造它的接口，它就永远测不到。
 *
 * 失败的两类都记进 `skipped`，都不抛：
 *
 *  - `STATE_CHANGED`：它在我们看过它之后前进了。**这不是错误**，
 *    而且往往正是我们想要的结果（它马上要被写，而写入前的门禁会重新核对）；
 *  - `NOT_FOUND`：它已经不在了。同理。
 *
 * 其余异常照抛 —— 一个「什么都吞掉」的批量操作会把「数据库写不进去」
 * 也记成一条无害的跳过。
 */
export function invalidateMany(
  repos: Repositories,
  input: {
    readonly change_ids: readonly string[];
    readonly trigger: InvalidationTrigger;
    readonly now: string;
  },
): InvalidationReport {
  const invalidated: InvalidationOutcome[] = [];
  const skipped: InvalidationSkip[] = [];

  for (const changeId of input.change_ids) {
    try {
      invalidated.push(invalidateChangeSet(repos, { change_id: changeId, trigger: input.trigger, now: input.now }));
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      if (error.code !== 'CHANGE_STATE_INVALID' && error.code !== 'CHANGE_NOT_FOUND') throw error;
      const current = repos.changes.findById(changeId);
      skipped.push({
        change_id: changeId,
        reason: current === null ? 'NOT_FOUND' : 'STATE_CHANGED',
        current_state: current?.state ?? null,
      });
    }
  }

  return { invalidated, skipped };
}

// ---------------------------------------------------------------------------
// 四、过期清理
// ---------------------------------------------------------------------------

export interface ExpirySweepReport {
  readonly now: string;
  readonly expired_changes: readonly InvalidationOutcome[];
  readonly skipped: readonly InvalidationSkip[];
  /** `ApprovalsRepo.expireDue` 的返回值：被标记为 EXPIRED 的批准条数。 */
  readonly expired_approvals: number;
  /**
   * 被标记为 EXPIRED 的**恢复授权**条数（LWB-030）。
   *
   * 与批准分开计数，因为它们过期的**后果**不同：一条批准过期意味着
   * 「那次写入不能再开始」，而一条恢复授权过期意味着「那堆说不清的字节
   * 还得继续等人处理」—— 后者不改变任何现场，只是让一条授权不再可用。
   * 合成一个计数会让操作者看不出「有没有东西在等着我」。
   */
  readonly expired_recovery_authorizations: number;
}

/**
 * 到期的修改集与批准，一次扫掉。
 *
 * 两步，缺一不可：
 *
 *  1. 逐条让**到期的修改集**过期。`invalidateChangeSet` 顺手收掉挂在它
 *     身上的批准 —— 按到期还是被撤销分别记，见那里。
 *  2. 再跑一次批量的 `ApprovalsRepo.expireDue` 收尾。
 *
 * ### 为什么第 2 步不能省
 *
 * 第 1 步只处理了**挂在过期修改集上**的批准。而一个批准也可能挂在一个
 * **没有** `EXPIRED` 出边的修改集上 —— `VALIDATING` / `APPLYING` /
 * `RECOVERY_REQUIRED`。那几个状态不会过期（转移表如此，它们只能走向
 * APPLIED / ROLLED_BACK），但它们的批准会。那些批准不归第 1 步管，
 * 而让一条已经过期十分钟的批准一直显示为「有效」，正是
 * 「离线前批准、重连后过期」最容易被忽略的那一半。
 *
 * ### 两步的顺序无关，但两条路径的**结论**必须一致
 *
 * 「这条批准为什么不再有效」的答案只有两个来源：`ApprovalsRepo.expire`
 * （单条，到期）与 `revoke`（单条，撤销）。批量那一步走的也是
 * `state = 'EXPIRED'`，与单条那条同一句话。
 */
export function sweepExpired(repos: Repositories, input: { readonly now: string }): ExpirySweepReport {
  const report = invalidateMany(repos, {
    change_ids: repos.changes
      .listByStates(EXPIRABLE_STATES)
      .filter((change) => change.expires_at <= input.now)
      .map((change) => change.id),
    trigger: 'CHANGE_EXPIRED',
    now: input.now,
  });
  const expiredApprovals = repos.approvals.expireDue(input.now);
  // 恢复授权（LWB-030）与批准同一刻扫：两者都是「有效期到了就不再可用」
  // 的一次性凭证，而授权过期**不动现场** —— 见 `ExpirySweepReport` 的说明。
  const expiredRecovery = repos.recovery_authorizations.expireDue(input.now);

  return {
    now: input.now,
    expired_changes: report.invalidated,
    skipped: report.skipped,
    expired_approvals: expiredApprovals,
    expired_recovery_authorizations: expiredRecovery,
  };
}

// ---------------------------------------------------------------------------
// 五、快照保留
// ---------------------------------------------------------------------------

/**
 * 一个快照对象此刻**还不能删**的理由。
 *
 * 前三条逐字对应 LWB-024 验收标准 3 的三个词：**运行中**、**待恢复**、
 * **仍在撤销窗口**。把验收标准的词直接用成枚举值，是为了让「这条断言在
 * 证什么」不需要一次翻译 —— 翻译正是偏离发生的地方。
 */
export type SnapshotProtectionReason =
  /** 运行中：修改集或它的操作处在 QUEUED / VALIDATING / APPLYING。 */
  | 'IN_EXECUTION'
  /** 待恢复：修改集或它的操作处在 RECOVERY_REQUIRED。 */
  | 'AWAITING_RECOVERY'
  /** 仍在撤销窗口内：已终结，但距终结时刻不足 `SNAPSHOT_RETENTION_MS`。 */
  | 'WITHIN_RETENTION_WINDOW'
  /**
   * 尚未终结：还没走到任何终态，因此它的字节还有可能被写出去或被用来比对。
   *
   * 这一格同时是**兜底**：本模块叫不出名字的状态（转移表里没有的那些）
   * 也落在这里。保守方向是对的 —— 多留一份字节的代价是磁盘，认错一次的
   * 代价是回滚时取不到原始字节。刻意**不**为它单开一个枚举值：那会是一个
   * 永远为零的计数，而一个永远为零的类别读起来像「已经想过这种情况了」，
   * 实际上它是一条走不到的分支。
   */
  | 'NOT_TERMINAL';

export const SNAPSHOT_PROTECTION_REASONS: readonly SnapshotProtectionReason[] = [
  'IN_EXECUTION',
  'AWAITING_RECOVERY',
  'WITHIN_RETENTION_WINDOW',
  'NOT_TERMINAL',
];

export interface SnapshotChangeDecision {
  readonly change_id: string;
  readonly state: ChangeSetState;
  /** 进入当前状态的时刻。终态时它就是「终结时刻」，也是保留窗口的起点。 */
  readonly ended_at: string;
  /** 保留窗口的右端（ISO 8601）。未终结的修改集这个值没有意义，等于 `ended_at + retention_ms`。 */
  readonly retain_until: string;
  readonly reason: SnapshotProtectionReason;
}

export interface ProtectedBlob {
  readonly blob_id: string;
  readonly reason: SnapshotProtectionReason;
  /** 是哪些修改集在保护它。排障问的第一个问题就是「谁还在用」。 */
  readonly change_ids: readonly string[];
}

export interface SnapshotRetentionPlan {
  readonly now: string;
  readonly retention_ms: number;
  /**
   * 受保护的修改集，按 `change_id` 排序。
   *
   * **只有受保护的会被列出**，「可以回收」由**不在这个清单里**表达。
   * 反过来把可回收的也列出来需要一次「全部终态且早于窗口」的查询，
   * 而那个集合只增不减（历史上每一次写入都留在里面）—— 它会在几年后
   * 变成一张必须分页的表，于是「扫描漏掉一行」重新变得可能。
   * 保护侧相反：它由「未终结」与「窗口内」两个上界夹住，永远是小集合。
   *
   * 可回收那一侧的可执行形式是 `snapshotGuard(...).protect(blob) === null`。
   */
  readonly protected_changes: readonly SnapshotChangeDecision[];
  /** 受保护的快照，按 `blob_id` 排序。可以回收的**不**在这里列举。 */
  readonly protected_blobs: readonly ProtectedBlob[];
  readonly counts_by_reason: Readonly<Record<SnapshotProtectionReason, number>>;
}

/** 「终结时刻」的取法：`changesets.updated_at` 是这一行进入当前状态的时刻。 */
function endedAtOf(change: ChangeSetRecord): string {
  return change.updated_at;
}

/** 保护理由，或 `null`（本策略不再要求留着它的字节）。 */
function protectionReasonOf(
  change: ChangeSetRecord,
  executionOperationChanges: ReadonlySet<string>,
  recoveryOperationChanges: ReadonlySet<string>,
  now: string,
  retainUntil: string,
): SnapshotProtectionReason | null {
  // 顺序是**保护强度**的次序：先问「有没有人在跑」，再问「有没有人在等恢复」，
  // 最后才问「窗口过没过」。反过来的话，一个正在执行中的修改集会被
  // 报成 NOT_TERMINAL —— 结论相同（都要留），但排障时读到的那行字是错的。
  if (recoveryOperationChanges.has(change.id) || change.state === 'RECOVERY_REQUIRED') {
    return 'AWAITING_RECOVERY';
  }
  if (executionOperationChanges.has(change.id) || EXECUTION_CHANGE_STATES.includes(change.state)) {
    return 'IN_EXECUTION';
  }
  if (!isKnownTerminal(change.state)) {
    // 非终态，但也不是执行中：`PENDING_APPROVAL` / `APPROVED`。它们都没有
    // 终结，因此都必须留。转移表里没有的状态也走到这里 —— 见枚举的说明。
    return 'NOT_TERMINAL';
  }
  if (now < retainUntil) return 'WITHIN_RETENTION_WINDOW';
  return null;
}

/**
 * 终态判定：**由转移表推出**（没有出边的那些），与
 * `state-machine.ts` 的 `TERMINAL_BY_TRANSITION_TABLE` 同源。
 *
 * 不引用 `@lwb/contracts` 的 `TERMINAL_CHANGE_STATES` 是因为这里要的是
 * 「认不出来的一律留着」：契约里的清单是**具名**的集合，而本函数需要一个
 * 对未知输入返回 `false` 的谓词 —— 未知输入在契约那份清单里查不到，
 * 会被当成终态，那正好是反的。
 */
function isKnownTerminal(state: ChangeSetState): boolean {
  const edges: readonly ChangeSetState[] | undefined = CHANGE_TRANSITIONS[state];
  return edges !== undefined && edges.length === 0;
}

function emptyCounts(): Record<SnapshotProtectionReason, number> {
  return {
    IN_EXECUTION: 0,
    AWAITING_RECOVERY: 0,
    WITHIN_RETENTION_WINDOW: 0,
    NOT_TERMINAL: 0,
  };
}

/**
 * 算出此刻哪些快照还不能删。
 *
 * ### 两条来源，都要查
 *
 * 修改集的状态与操作的状态**可以合法地分叉**（见 `state-machine.ts`），
 * 因此只看 `changesets.state` 会漏掉「修改集已经作废、操作却仍在运行」
 * 那种组合。两次读都是全表小集合（操作那一侧被 `OPEN_OPERATION_STATES`
 * 夹住 —— 每个操作最终都会走出这四个状态；修改集那一侧只需要状态与时刻）。
 *
 * ### 时刻
 *
 * 保留窗口的起点是**进入终态的时刻**，取 `changesets.updated_at` ——
 * `ChangesRepo.transition` 每次流转都会把它写成当时的时间，而终态没有出边
 * （由转移表证明），所以一行处在终态时，`updated_at` 就是它**变成**终态的
 * 那一刻。这是推导，不是约定。
 */
export function planSnapshotRetention(
  repos: Repositories,
  input: { readonly now: string; readonly retention_ms?: number },
): SnapshotRetentionPlan {
  const retentionMs = input.retention_ms ?? LIMITS.SNAPSHOT_RETENTION_MS;
  const now = input.now;

  const unfinished = repos.operations.listByStates(OPEN_OPERATION_STATES);
  const inExecution = new Set<string>();
  const inRecovery = new Set<string>();
  for (const operation of unfinished) {
    if (operation.state === 'RECOVERY_REQUIRED') inRecovery.add(operation.change_id);
    else inExecution.add(operation.change_id);
  }

  // 两个**有上界**的查询，合起来覆盖全部需要判定的修改集：
  //  - 尚未终结的（由状态界定，数量被「每个修改集都会离开这些状态」夹住）；
  //  - 窗口之内终结的（由时刻界定，最老的一个也不早于 `now - retention_ms`）。
  // 窗口之外终结的那些不需要被读到 —— 它们全部都是可回收的，
  // 而「可回收」在本计划里由缺席表达。
  const cutoff = new Date(Date.parse(now) - retentionMs).toISOString();
  const changes = [
    ...repos.changes.listByStates(NON_TERMINAL_STATES),
    ...repos.changes.listUpdatedSince(cutoff),
  ];

  const decisions: SnapshotChangeDecision[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.id)) continue;
    seen.add(change.id);
    const endedAt = endedAtOf(change);
    const retainUntil = new Date(Date.parse(endedAt) + retentionMs).toISOString();
    const reason = protectionReasonOf(change, inExecution, inRecovery, now, retainUntil);
    if (reason === null) continue;
    decisions.push({
      change_id: change.id,
      state: change.state,
      ended_at: endedAt,
      retain_until: retainUntil,
      reason,
    });
  }
  decisions.sort((a, b) => (a.change_id < b.change_id ? -1 : a.change_id > b.change_id ? 1 : 0));

  const counts = emptyCounts();
  const protectedChangeIds = new Map<string, SnapshotProtectionReason>();
  for (const decision of decisions) {
    protectedChangeIds.set(decision.change_id, decision.reason);
    counts[decision.reason] += 1;
  }

  // blob → 修改集，**由权威表反查**（`change_items`），不读 `blobs.refcount`。
  const byBlob = new Map<string, { reason: SnapshotProtectionReason; change_ids: Set<string> }>();
  for (const ref of repos.changes.blobReferences()) {
    const reason = protectedChangeIds.get(ref.change_id);
    if (reason === undefined) continue;
    const entry = byBlob.get(ref.blob_id);
    if (entry === undefined) {
      byBlob.set(ref.blob_id, { reason, change_ids: new Set([ref.change_id]) });
      continue;
    }
    entry.change_ids.add(ref.change_id);
    // 一个 blob 被多个修改集引用时取**最强**的那条理由（次序即
    // `SNAPSHOT_PROTECTION_REASONS`）。理由只影响报告里那行字，
    // 不影响「留不留」这个结论 —— 只要有一条说留，就留。
    if (reasonRank(reason) < reasonRank(entry.reason)) entry.reason = reason;
  }

  const protectedBlobs: ProtectedBlob[] = [...byBlob.entries()]
    .map(([blobId, entry]) => ({
      blob_id: blobId,
      reason: entry.reason,
      change_ids: [...entry.change_ids].sort(),
    }))
    .sort((a, b) => (a.blob_id < b.blob_id ? -1 : a.blob_id > b.blob_id ? 1 : 0));

  return {
    now,
    retention_ms: retentionMs,
    protected_changes: decisions,
    protected_blobs: protectedBlobs,
    counts_by_reason: counts,
  };
}

/** 理由的强度次序，数字小的更强。与 `SNAPSHOT_PROTECTION_REASONS` 的排列一致。 */
function reasonRank(reason: SnapshotProtectionReason): number {
  const index = SNAPSHOT_PROTECTION_REASONS.indexOf(reason);
  return index === -1 ? SNAPSHOT_PROTECTION_REASONS.length : index;
}

/** 给 `BlobStore.collectGarbage` 的 `protect` 用的对象形状（结构子集）。 */
export interface ProtectableBlob {
  readonly id: string;
}

export interface SnapshotGuard {
  readonly plan: SnapshotRetentionPlan;
  /**
   * 返回一个**原因字符串**表示「这个对象此刻不能删」，返回 `null` 表示
   * 本判据不保护它。形状与 `BlobStore.collectGarbage` 的 `protect` 一致。
   *
   * 注意 `null` 的含义**不是**「可以删」——`collectGarbage` 还有自己的两个
   * 条件（`pending_gc` + `refcount = 0`）。本判据只回答一个问题：
   * 保留策略这边**是否还要求留着它**。
   */
  readonly protect: (blob: ProtectableBlob) => string | null;
}

const PROTECTION_MESSAGES: Readonly<Record<SnapshotProtectionReason, string>> = {
  IN_EXECUTION: '该快照属于一次正在执行中的写入，回收会让它在半途失去原始字节。',
  AWAITING_RECOVERY: '该快照属于一次待恢复的操作，回收会让回滚取不到原始字节。',
  WITHIN_RETENTION_WINDOW: '该快照仍在撤销窗口内（保留期未满），回收会让操作者无法回退这次写入。',
  NOT_TERMINAL: '该快照所属的修改集尚未终结，回收会让尚未发生的写入失去依据。',
};

/**
 * 把保留计划包成 `BlobStore.collectGarbage` 能用的逐对象判据。
 *
 * ### 为什么不能只用那个全局谓词
 *
 * `collectGarbage` 原本只有一个**全局**的 `isSafeToCollect`：它为假时整个
 * 回收被拒，为真时**所有** `pending_gc` 都被删。两种取值都用不到验收标准 3：
 * 全局为真会删掉撤销窗口内的字节，全局为假则让「清理不会删除…」这句话
 * 空洞地成立（什么都不删，当然什么都没删错）。
 *
 * 逐对象判据是这句话能被**证伪**的前提：同一轮回收里，运行中的那些留下、
 * 窗口已满的那些被删掉 —— 一个既不是「全删」也不是「全不删」的结果。
 */
export function snapshotGuard(
  repos: Repositories,
  input: { readonly now: string; readonly retention_ms?: number },
): SnapshotGuard {
  const plan = planSnapshotRetention(repos, input);
  const byBlob = new Map<string, ProtectedBlob>();
  for (const blob of plan.protected_blobs) byBlob.set(blob.blob_id, blob);

  return {
    plan,
    protect(blob) {
      const entry = byBlob.get(blob.id);
      if (entry === undefined) return null;
      return PROTECTION_MESSAGES[entry.reason];
    },
  };
}

/** Reclaim expired zero-refcount snapshots using the authoritative retention guard. */
export async function collectSnapshotGarbage(
  repos: Repositories,
  blobs: BlobStore,
  input: { readonly now: string; readonly retention_ms?: number },
  options: { readonly isSafeToCollect: () => boolean | Promise<boolean> },
): Promise<GcReport> {
  const guard = snapshotGuard(repos, input);
  return await blobs.collectGarbage({
    isSafeToCollect: options.isSafeToCollect,
    protect: guard.protect,
  });
}

// ---------------------------------------------------------------------------
// 六、审计保留元数据，而不是原文副本
// ---------------------------------------------------------------------------

/**
 * 一个修改集在记录被回收之后**仍然应当留下**的东西。
 *
 * 这是步骤 3 后半句「审计保留必要元数据而非原文副本」的可执行形式：
 * 保留的是**身份与规模**，不是内容，也不是路径。
 *
 * 刻意**不**包含的两项：
 *
 *  - **文件路径。** 路径是「这次改动碰了用户的哪个文件」的答案 ——
 *    它是一条关于用户磁盘的陈述，而不是关于这次操作的陈述。保留它等于
 *    让审计库在修改集被回收之后仍然保留一份工作区结构的摘要，
 *    而那正是「回收」要消除的东西。
 *  - **任何字节。** 快照的字节永远不进入审计：审计库与状态库同文件，
 *    把正文放进去等于把泄漏面扩大一遍（见 `AuditEventInput.metadata`
 *    的约定）。
 *
 * `digest` 是留着的，因为它不可逆且是「这确实是同一份东西」的唯一凭证。
 */
export interface ReclaimedChangeMetadata {
  readonly change_id: string;
  readonly workspace_id: string;
  readonly digest: string;
  readonly state: ChangeSetState;
  readonly created_at: string;
  readonly ended_at: string;
  readonly item_count: number;
  readonly added_lines: number;
  readonly removed_lines: number;
  readonly before_bytes: number;
  readonly after_bytes: number;
}

/**
 * 从落库事实里取出这份元数据。修改集不存在时返回 `null`（不抛：
 * 排障路径上「它已经不在了」是一个正常的答案）。
 */
export function reclaimedChangeMetadata(
  repos: Repositories,
  changeId: string,
): ReclaimedChangeMetadata | null {
  const change = repos.changes.findById(changeId);
  if (change === null) return null;
  const items: readonly ChangeItemRecord[] = repos.changes.items(changeId);

  let addedLines = 0;
  let removedLines = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const item of items) {
    addedLines += item.added_lines;
    removedLines += item.removed_lines;
    beforeBytes += item.old_blob_id === null ? 0 : (repos.blobs.findById(item.old_blob_id)?.size ?? 0);
    afterBytes += repos.blobs.findById(item.new_blob_id)?.size ?? 0;
  }

  return {
    change_id: change.id,
    workspace_id: change.workspace_id,
    digest: change.digest,
    state: change.state,
    created_at: change.created_at,
    ended_at: endedAtOf(change),
    item_count: items.length,
    added_lines: addedLines,
    removed_lines: removedLines,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
  };
}
