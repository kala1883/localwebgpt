/**
 * `@lwb/executor` —— 写执行协调器（LWB-026）。
 *
 * ## 这个包为什么是一个包
 *
 * 「一次写入」在本工程里被拆成两件**互不相识**的事，而它们的失效方式
 * 完全不同：
 *
 *  1. **能不能写、谁先写**（本包）。它只读状态库、只写状态库，
 *     全部判定都是纯函数或一个 `BEGIN IMMEDIATE` 事务里的条件写。
 *  2. **怎么写**（LWB-027 及以后，落在 `native/`）。它碰文件、碰句柄、
 *     碰 `FlushFileBuffers`，在**事务之外**跑。
 *
 * 拆开的收益不是「分层好看」，而是一条可以被断言的性质：本包**不接触
 * 文件系统**（由 `scripts/check-fsguard-imports.mjs` 强制 ——
 * `packages/executor/` 在业务前缀清单里）。因此「并发写入」这个最难复现的
 * 问题类别，在这里可以用真 SQLite + 假写盘人来穷尽。
 *
 * ## 三个交付面
 *
 * | 导出 | 它回答的问题 |
 * | --- | --- |
 * | `ExecutionCoordinator` | 谁先写、写完之后是什么状态、什么情况下必须停下来等人 |
 * | `claimForExecution` | 一次性许可：消费批准、认领操作、占住物理工作区 |
 * | `decideSlot` / `orderedForLocking` | 纯判定：这块地能不能占、动文件的次序 |
 *
 * ## 一条贯穿全包的约定
 *
 * **拒绝与阻断是两件事。** 拒绝（`refused`）意味着「现在不行，什么都没变」，
 * 调用方下次再来即可；阻断（`blocked`）意味着「需要人来」，
 * 而它只能由 `clearBlockade` 解除，且前提是导致阻断的操作已经终结。
 * 把它们合成一个「失败」会让「等一会儿重试」与「停下来叫人」变成同一个动作 ——
 * 而后者被重试解开，就等于一个带超时的锁。
 */

export {
  claimForExecution,
  claimRefusalToError,
  type ClaimDeps,
  type ClaimOutcome,
  type ClaimRefusalReason,
  type ExecutionPlan,
} from './claim.ts';

export {
  APPLY_REPORT_KINDS,
  ExecutionCoordinator,
  JOURNAL_STAGE,
  type ApplyReport,
  type CoordinatorNotice,
  type ExecutionApplier,
  type ExecutionCoordinatorOptions,
  type FinishedState,
  type RunOutcome,
} from './coordinator.ts';

export {
  decideSlot,
  describeBlockReason,
  describeSlotRefusal,
  type BlockReason,
  type HolderStatus,
  type SlotDecision,
  type SlotDecisionInput,
  type SlotRefusal,
} from './slot-rules.ts';

export {
  complaintOf,
  createNativeWriter,
  guardFailureFacts,
  guardVerdict,
  guardVerdictClause,
  observationIsComplete,
  restoreComplaint,
  scopeOf,
  type BufferOutcome,
  type GuardFailureFacts,
  type GuardVerdict,
  type NativeApplierDeps,
  type NativeWriter,
  type ReadStateOutcome,
  type RestoreRequest,
  type SnapshotOutcome,
  type VetVerdict,
  type VettedItem,
  type WriteMode,
  type WriteOutcome,
} from './native-adapter.ts';

/** 编排（LWB-029）：`createNativeApplier` 把上面这些拼成一次可执行的应用。 */
export { createNativeApplier } from './apply.ts';

/**
 * 应用服务（LWB-032）：控制台与工具面**共用的**那一个「把这条应用掉」。
 *
 * 它导出的是函数而不是一个类：它没有状态，全部事实来自 `repos` 与
 * 那个被注入的协调器 —— 而协调器是**同一个**那个（见 `ApplyServiceDeps`）。
 */
export {
  applyChange,
  // 「这次调用有没有可能开始一次写入」——工具面与 `applyChange` 必须给出
  // 同一个答案，因此它是导出的、而不是各自实现一遍（见它的说明）。
  canBeginWrite,
  DEFAULT_APPLY_WAIT_MS,
  type ApplyRequest,
  type ApplyServiceDeps,
  type ApplyServiceNotice,
} from './apply-service.ts';

/**
 * 安全暂停与紧急停用（LWB-034）。
 *
 * 它导出的是一个**有状态的类**，与 `applyChange` 那种无状态函数不同：
 * 「这一轮的停止信号是哪一个」必须只有一个地方记着，而
 * 「紧急停用 → 恢复 → 再紧急停用」这条路上，信号每恢复一次就换一个。
 * 因此它是**一个进程一个实例**，且那一个实例要同时交给协调器与控制层。
 */
export {
  PAUSE_ABORT_REASON,
  PauseService,
  type PauseNotice,
  type PauseOutcome,
  type PauseServiceDeps,
  type PauseStatus,
  type PendingAuthorization,
  type RecoveryOperation,
  type StoppingWrite,
} from './pause.ts';

export {
  aggregateOf,
  ALL_ITEM_STAGES,
  appendItemEvent,
  describeOutcomes,
  isItemStage,
  ITEM_STAGE,
  itemOutcomes,
  readItemEvents,
  redactRoot,
  type Aggregate,
  type ItemEvent,
  type ItemEventInput,
  type ItemOutcome,
  type ItemOutcomeKind,
  type ItemStage,
} from './journal.ts';

export { isOrderedForLocking, orderedForLocking } from './ordering.ts';
