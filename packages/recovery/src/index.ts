/**
 * @lwb/recovery —— 启动恢复与未知结果协调（LWB-030）。
 *
 * 边界：
 *  - 本包**不出现在工具面里**，也不接受任何工具参数。它属于本机操作者
 *    那条通道（`apps/daemon/src/runtime/` 装配），模型够不到它 ——
 *    因此 `approved` / `user_id` / `session_id` / `conversation_label`
 *    在这条路径上不存在，而不是「被忽略了」。
 *  - 它**不自己实现写盘**：把基线写回去走 `@lwb/executor` 的
 *    `NativeWriter.restore`，与 `apply.ts` 的有界回滚是同一个函数。
 *    本工程里不允许存在第二条写用户文件的路径。
 *  - 它是业务包：不直接 import `node:fs`，一切文件访问经
 *    `@lwb/winfs` 的受控句柄（见 `scripts/check-fsguard-imports.mjs`）。
 *  - 它**不删除**任何东西；本包的写路径只用于把文件恢复到基线。
 *    独立的 `file_delete` 工具不会从本恢复包调用。
 */

export {
  RecoveryService,
  RECOVERY_STAGE,
  type BlockadeOutcome,
  type Inspection,
  type ItemInspection,
  type ItemReceipt,
  type ReconcileReport,
  type RecoveryDeps,
  type RecoveryRecord,
  type RecoveryStage,
  type StartupRecoveryReport,
} from './service.ts';

export {
  planDigestOf,
  reconciliationOf,
  repairOf,
  type ItemPlan,
  type ManualReason,
  type Reconciliation,
  type RecoveryAction,
  type RecoveryPlan,
  type RepairPlan,
  type RepairRefusal,
} from './plan.ts';

export {
  classifyItem,
  NO_JOURNAL_EVIDENCE,
  observationOf,
  type ItemVerdict,
  type JournalEvidence,
  type Observation,
  type UnknownReason,
} from './verdict.ts';
