/**
 * `@lwb/changes` —— 修改提议的契约、字节落地与不可变修改集。
 *
 * 八个文件，八件不同的事：
 *
 *  - `edit-contract.ts` —— **提案 vs 票据**：路径、票据、基线声明、行区间
 *                          形状与「同一文件不得出现两次」。
 *  - `text-engine.ts`   —— **提案 vs 基线字节**：逐行精确匹配、按原字节切片
 *                          拼出新内容、重新识别产物并核对不变量。
 *  - `digest.ts`        —— **规范化**：把「这次修改的全部可写效果」变成一串
 *                          无歧义字节并求摘要；另有请求指纹供幂等判定。
 *  - `prepare.ts`       —— **落库**：重读目标、算出最终字节、把旧/新字节送进
 *                          快照库、建立不可变修改集与预览。
 *  - `query.ts`         —— **读取面**：`change_get` / `change_list`。只读状态库
 *                          与快照库，用户工作区一个字节都不碰；差异经出站闸门。
 *  - `revert.ts`        —— **撤销提议**：把一条已应用的修改翻成一份**新的**
 *                          修改集（方案 §8.5：「撤销是新修改集，不是把旧记录
 *                          删除」）。它只读盘、只建提案；旧那条记录一个字节
 *                          都不改，因此「旧回执不可被篡改成『未发生』」与
 *                          「撤销不碰 Git」都是结构性的。
 *  - `single-flight.ts` —— 同进程内的幂等单飞锁（为什么在这里见该文件头）。
 *  - `state-machine.ts` —— 三张状态转移表：谁能变成谁。
 *
 * 前两个是纯函数，进出一律是内存里的值，因此编辑规则可以在没有任何真实
 * 文件的情况下被完整测到。后两个要读磁盘、要写状态库，但不直接碰文件系统
 * （由 `scripts/check-fsguard-imports.mjs` 强制）：所有磁盘访问都经过注入的
 * `WinfsOps`（读取，且只有读取）与 `BlobStore`（快照），状态经 `Repositories`。
 *
 * ## 「prepare / revert 不改用户工作区」是结构性的，不是承诺
 *
 * `prepare.ts` 与 `revert.ts` 里对 `WinfsOps` 的调用只有 `resolvePath` 与
 * `readFileGuarded` 两种。接口上另有 `writeFileGuarded` / `createFileGuarded`，
 * 它们在这两个文件里一次都不出现 —— 于是「提议阶段不写文件」这件事可以被
 * 静态检查，而不必依赖「本模块的作者记得别写」。
 */

export {
  assertDistinctTargets,
  describeTargets,
  isEncodable,
  validateChangeItems,
} from './edit-contract.ts';
export type {
  ChangePlan,
  ChangeTarget,
  ChangeValidationContext,
  ValidatedChangeItem,
  ValidatedCreateText,
  ValidatedEditText,
  ValidatedReplaceText,
} from './edit-contract.ts';

export { applyLineEdits, createTextFile, replaceWholeText } from './text-engine.ts';
export type { AppliedTextChange, ApplyLineEditsInput, CreateTextFileInput, ReplaceWholeTextInput } from './text-engine.ts';

export {
  canonicalizeChangeDigest,
  canonicalChangeDigest,
  changeRequestFingerprint,
  shortCodeOf,
  CHANGE_DIGEST_DOMAIN,
  CHANGE_REQUEST_DOMAIN,
} from './digest.ts';
export type {
  ChangeDigestFile,
  ChangeDigestInput,
  ChangeRequestFingerprintInput,
  RequestCreateTextItem,
  RequestEditTextItem,
  RequestItem,
  RequestReplaceTextItem,
} from './digest.ts';

export {
  changeSetViewOf,
  deriveRisks,
  filePreviewsOf,
  prepareChange,
  CHANGE_PREPARE_TOOL,
  DEFAULT_PREPARE_LIMITS,
  NEXT_ACTION_PENDING_APPROVAL,
} from './prepare.ts';
export type { PrepareChangeArgs, PrepareChangeDeps, PrepareLimits } from './prepare.ts';

export {
  EXECUTION_BINDING_REASONS,
  EXPIRABLE_STATES,
  INVALIDATABLE_STATES,
  JOURNAL_STAGE_INVALIDATED,
  NON_TERMINAL_STATES,
  PENDING_CHANGE_STATES,
  SNAPSHOT_PROTECTION_REASONS,
  executionBindingErrorCode,
  executionBindingMessage,
  invalidateChangeSet,
  invalidateMany,
  invalidatePendingForConnection,
  invalidatePendingForWorkspace,
  planSnapshotRetention,
  reclaimedChangeMetadata,
  revalidateExecutionBindings,
  revokeLocalApproval,
  snapshotGuard,
  sweepExpired,
} from './invalidation.ts';
export type {
  ExecutionBindingInput,
  ExecutionBindingReason,
  ExecutionBindingVerdict,
  ExpirySweepReport,
  InvalidationOutcome,
  InvalidationReport,
  InvalidationSkip,
  InvalidationTrigger,
  ProtectableBlob,
  ProtectedBlob,
  ReclaimedChangeMetadata,
  SnapshotChangeDecision,
  SnapshotGuard,
  SnapshotProtectionReason,
  SnapshotRetentionPlan,
} from './invalidation.ts';

export {
  changeDiffPageOf,
  changeGetDataOf,
  changeListDataOf,
  nextActionFor,
  operationReceiptFor,
  ownedChangeOf,
  DEFAULT_CHANGE_QUERY_LIMITS,
} from './query.ts';
export type { ChangeQueryDeps, ChangeQueryLimits, ChangeReadContext } from './query.ts';

export {
  planRevert,
  prepareRevert,
  CHANGE_REVERT_PREPARE_TOOL,
  REVERTIBLE_CHANGE_STATES,
  REVERT_JOURNAL_STAGES,
} from './revert.ts';
export type {
  LocalRecoveryAction,
  RevertConflictReason,
  RevertItemPlan,
  RevertPlan,
  RevertPrepareArgs,
  RevertPrepareDeps,
  RevertVerdict,
} from './revert.ts';

export {
  inFlightKeyCount,
  withIdempotencyLock,
  type IdempotencyLockScope,
} from './single-flight.ts';

export {
  APPROVAL_TRANSITIONS,
  CHANGE_TRANSITIONS,
  EXECUTION_CHANGE_STATES,
  EXECUTION_OPERATION_STATES,
  OPERATION_TRANSITIONS,
  TERMINAL_APPROVAL_STATES_BY_TRANSITION_TABLE,
  TERMINAL_BY_TRANSITION_TABLE,
  TERMINAL_COUNTS,
  TERMINAL_OPERATION_STATES_BY_TRANSITION_TABLE,
  assertApprovalStateChange,
  assertApprovalTransition,
  assertChangeTransition,
  assertOperationTransition,
  canTransition,
  canTransitionApproval,
  canTransitionOperation,
  isExecutionChangeState,
  reachableChangeStates,
  reachableFromEveryChangeState,
  transitionChange,
  transitionOperation,
  type TransitionRefusal,
} from './state-machine.ts';
