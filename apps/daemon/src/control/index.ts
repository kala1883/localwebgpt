/**
 * `@lwb/daemon` 的控制平面（LWB-012）。
 *
 * 这里是 daemon 面向**人**的那一侧：操作者通过本地控制台注册工作区、
 * 审核差异、批准修改。它与面向模型的 MCP 侧是两条独立的通道，
 * 凭证不同、能力不同，且**不可互换** —— 后者由 `packages/ipc` 的
 * audience 分离与 `packages/policy` 的五层判定保证，前者由本目录的
 * 路由注册期断言保证。
 *
 * 目录职责：
 *
 * | 文件 | 职责 |
 * | --- | --- |
 * | `origin.ts` | 请求来源判定（Host / Origin / Sec-Fetch-Site / 请求目标形态） |
 * | `tokens.ts` | 凭证生成与常数时间比较 |
 * | `session.ts` | 会话、CSRF、一次性操作 nonce |
 * | `routes.ts` | 路由表与「模型可达的控制路由注册不出来」这条断言 |
 * | `server.ts` | HTTP 服务本身（回环绑定、逐道门、响应头） |
 * | `control-plane.ts` | 装配：由能力表推导出控制平面有哪些接口 |
 * | `workspaces.ts` | 工作区控制操作（LWB-009） |
 * | `connections.ts` | 连接控制操作（LWB-018 步骤 3） |
 * | `approvals.ts` | 批准控制操作（LWB-021） |
 * | `pause.ts` | 紧急停用控制操作（LWB-034） |
 * | `changes.ts` | 修改集的复核读取（LWB-036） |
 * | `recovery.ts` | 冲突/恢复的本地操作（LWB-037） |
 * | `history.ts` | 执行终态与审计历史（LWB-037） |
 */

export {
  BOOTSTRAP_TTL_MS,
  CONTROL_BIND_HOST,
  CONTROL_COOKIE_NAME,
  CONTROL_CSRF_HEADER,
  MAX_BODY_BYTES,
  NONCE_TTL_MS,
  SESSION_TTL_MS,
} from './constants.ts';

export {
  checkHost,
  checkJsonContentType,
  checkOrigin,
  checkRequestTarget,
  checkSecFetchSite,
  consoleOrigin,
  contentTypeOf,
  parseAuthority,
  type Authority,
  type Reject,
  type RejectReason,
} from './origin.ts';

export { constantTimeEquals, hashToken, newControlToken } from './tokens.ts';

export {
  clearCookieHeader,
  ControlSessionStore,
  cookieAttributes,
  readSessionCookie,
  setCookieHeader,
  type BootstrapTicket,
  type ControlSession,
  type IssuedNonce,
  type IssuedSession,
  type NonceBinding,
  type NonceRejection,
  type SessionStoreOptions,
} from './session.ts';

export {
  ControlRouteTable,
  registerOperationRoutes,
  UNAUTHENTICATED_ROUTES,
  type ControlRoute,
  type ControlRouteContext,
  type ControlRouteHandler,
  type OperationRouteOptions,
} from './routes.ts';

export {
  bodyDigest,
  ControlServer,
  type ControlEvent,
  type ControlServerOptions,
  type StaticControlAsset,
} from './server.ts';

export {
  controlOperationNames,
  createControlPlane,
  MUTATING_OPERATIONS,
  READ_ONLY_OPERATIONS,
  type ControlPlane,
  type ControlPlaneOptions,
} from './control-plane.ts';

export {
  registerWorkspaceOperations,
  WORKSPACES_MANAGE_CAPABILITY,
} from './workspaces.ts';

export {
  MODEL_WORKSPACE_CAPABILITIES,
  registerWorkspaceAccessOperations,
  type ModelWorkspaceCapability,
  type WorkspaceAccessOperationsDeps,
} from './workspace-access.ts';

export {
  CONNECTIONS_MANAGE_CAPABILITY,
  registerConnectionOperations,
  type ConnectionOperationsDeps,
} from './connections.ts';

export {
  APPROVALS_DECIDE_CAPABILITY,
  APPROVAL_OPERATION_NAMES,
  registerApprovalOperations,
  type ApprovalOperationsDeps,
} from './approvals.ts';

export {
  registerPauseOperations,
  SERVICE_CONTROL_CAPABILITY,
  type PauseOperationsDeps,
} from './pause.ts';

export {
  CHANGE_OPERATION_NAMES,
  CHANGES_READ_CAPABILITY,
  registerChangeOperations,
  type ChangeOperationDeps,
  type ContentGateView,
} from './changes.ts';

export {
  RECOVERY_OPERATION_NAMES,
  RECOVERY_READ_CAPABILITY,
  RECOVERY_WRITE_CAPABILITY,
  registerRecoveryOperations,
  type RecoveryOperationsDeps,
} from './recovery.ts';

export {
  HISTORY_READ_CAPABILITY,
  registerHistoryOperations,
} from './history.ts';

/**
 * 本目录**不做**什么：
 *
 *  - 不实现控制台界面（那是 `apps/console/`，LWB-035）。
 *    这里只提供它需要的接口与会话机制。
 *  - 不做审批**状态机**的全部分支（LWB-022 补齐状态机的显式转换表）。
 *    本目录落地的三件事是：一次性 nonce 这个**机制**、由落库事实重载并重算
 *    摘要后的**决定**（LWB-021）、以及执行前的**门禁**（`@lwb/approvals`）。
 *    nonce 目前仍由控制台显式申请，因此它证明的是「一次性与内容绑定」，
 *    而**不**证明「操作者确实看过这份内容」—— 后者要求 nonce 由渲染审核页的
 *    那次读取一并签发。这条边界写在 `session.ts` 的文件头，不要在别处
 *    把它读成「审批链路已经完备」。
 *  - 不执行写入（LWB-026）。`approvals.approve_and_apply` 只排队，
 *    真正写盘的是执行协调器，而它在开始前会再跑一次同一个门禁。
 *  - 不写审计存储（LWB-018）。本层只发结构化事件，由装配方决定写到哪里。
 */
