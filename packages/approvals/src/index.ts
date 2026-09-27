/**
 * `@lwb/approvals` —— 本地批准的决定层（LWB-021）。
 *
 * ## 这个包为什么存在
 *
 * 「本地操作者批准了一次修改」是本工程里**唯一**能授权写入用户文件的事实。
 * 它值得有一个自己的包，因为它的每一条规则都与别的模块正交：
 *
 *  - `reload.ts` —— **事实**：从状态库重新加载修改集，并由落库的行重算摘要。
 *  - `decide.ts` —— **决定**：批准、拒绝、批准并应用；以及这三件事各自
 *                  必须与哪些状态流转同属一个事务。
 *  - `gate.ts`   —— **放行**：执行前判定批准是否仍然有效。**不消费**。
 *
 * 三者分开的理由是它们的**调用时机完全不同**：重载发生在人点击时，
 * 决定发生在人点击后，门禁发生在执行前（可能是很久以后，甚至跨进程）。
 * 写成一个大函数会让「门禁会不会顺手把批准用掉」这个问题只能靠读实现回答。
 *
 * ## 框架无关
 *
 * 本包不 import 任何 HTTP、IPC、工具面或控制台的东西，也不持有依赖：
 * 所有入参显式传入（`repos` / `now` / `id` 工厂），因此每一条规则都可以
 * 在没有控制平面、没有真实磁盘的情况下被完整测到。
 *
 * 它同样**不**接触文件系统（由 `scripts/check-fsguard-imports.mjs` 强制）：
 * 批准是关于**状态**的动作，而「要写的内容」在快照库里。
 *
 * ## 本包**不做**什么
 *
 *  - **不消费批准**。消费属于执行协调器（LWB-026），必须与「认领操作」
 *    在同一个短事务里（方案 §7.2）。本包提供 `evaluateApplyGate` 回答
 *    「能不能」，把「占用」留给唯一那个会真正写盘的地方。
 *  - **不写审计**。审计的写入口在 `@lwb/audit`，由控制层在状态变更之后
 *    调用 —— 与 `apps/daemon/src/control/connections.ts` 同一种次序与同一种
 *    理由（两步各在自己的事务里，窗口的后果可自证）。
 *  - **不做过期清理**。`ApprovalsRepo.expireDue` 是写入方的动作；
 *    本包的 `effectiveApprovalState` 只做**读取时的投影**，
 *    让「只读路径不写库」这条规则不被一个顺手的 UPDATE 破坏。
 */

export {
  isAwaitingDecision,
  reloadChangeSet,
  type ReloadedChangeSet,
  type ReloadFailure,
} from './reload.ts';

export {
  APPLY_ENTRY_STATES,
  EXECUTION_STATES,
  effectiveApprovalState,
  evaluateApplyGate,
  gateRefusalToError,
  type ApplyGateInput,
  type ApplyGateReason,
  type ApplyGateVerdict,
} from './gate.ts';

export {
  approveAndQueue,
  approveChange,
  rejectChange,
  type ApproveAndQueueInput,
  type ApproveAndQueueResult,
  type DecisionActor,
  type DecisionInput,
} from './decide.ts';
