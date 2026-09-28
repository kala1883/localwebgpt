/**
 * `@lwb/approvals` —— 修改集执行授权记录与状态流转（兼容本地复核流程）。
 *
 * ## 这个包为什么存在
 *
 * MCP 模型写入由当前 workspace 的 `propose` grant 授权；工具入口据此创建一条
 * daemon 内部的一次性摘要绑定/执行记录。兼容的本地复核流程也复用这套状态机，
 * 但该记录不再是所有写入都必须等待的人工审批。它值得有一个自己的包，因为：
 *
 *  - `reload.ts` —— **事实**：从状态库重新加载修改集，并由落库的行重算摘要。
 *  - `decide.ts` —— **决定**：记录人工复核或 workspace-grant 授权，并原子排队。
 *  - `gate.ts`   —— **放行**：执行前判定摘要/授权记录及绑定是否仍然有效。**不消费**。
 *
 * 三者分开的理由是它们的**调用时机完全不同**：重载发生在授权/应用入口，
 * 决定可能来自本地复核或已核验的 workspace grant，门禁发生在执行前。
 * 写成一个大函数会让「执行记录会不会被提前消费」这个问题只能靠读实现回答。
 *
 * ## 框架无关
 *
 * 本包不 import 任何 HTTP、IPC、工具面或控制台的东西，也不持有依赖：
 * 所有入参显式传入（`repos` / `now` / `id` 工厂），因此每一条规则都可以
 * 在没有控制平面、没有真实磁盘的情况下被完整测到。
 *
 * 它同样**不**接触文件系统（由 `scripts/check-fsguard-imports.mjs` 强制）：
 * 执行授权记录是关于**状态**的动作，而「要写的内容」在快照库里。
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
