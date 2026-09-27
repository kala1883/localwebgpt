/**
 * 控制台认证（LWB-012 交付物 `apps/console/auth/`）。
 *
 * ## 这个目录是什么、不是什么
 *
 * 它**是**控制台与控制平面之间那一段认证逻辑：怎么用本地启动命令
 * 换到一个会话、怎么带着会话与 CSRF 令牌调用控制 API、会话过期时怎么表现。
 *
 * 它**不是**控制台界面。按方案 §10.1，界面（六个页面：连接与状态、
 * 工作区、待批准、操作详情、冲突/恢复、历史与审计）属于 LWB-035；
 * 本任务只交付它必须依赖的那一层，且刻意做成**框架无关**的纯 TypeScript ——
 * 于是认证逻辑可以在 node 里直接测试，而不必先跑起一个浏览器。
 *
 * ## 交付物路径与任务书的差异
 *
 * 任务书写 `apps/console/auth/`，实际放在 `apps/console/src/auth/`。
 * 理由与 LWB-008 的偏离项相同（`docs/PROGRESS.md` 偏离项 7）：
 * 仓库的静态检查按 `apps/console/src/` 前缀识别业务包
 * （`scripts/check-fsguard-imports.mjs` 的 `BUSINESS_PREFIXES`），
 * 放在 `src/` 之外会让这层代码**落在两个清单之外**——
 * 既不被允许、也不被检查，而检查器照常打印「未发现违规」
 * （同偏离项 9 的静默盲区）。放在 `src/` 下，它就在检查范围内。
 */

export {
  BOOTSTRAP_FRAGMENT_KEY,
  bootstrapConsoleSession,
  isLoopbackOrigin,
  readBootstrapToken,
  redeemBootstrap,
  stripFragment,
  type BootstrapEnvironment,
  type ConsoleSession,
  type HistoryLike,
  type RedeemDependencies,
} from './bootstrap.ts';

export {
  ControlApiFailure,
  ControlClient,
  digestOfBody,
  type ControlApiError,
  type ControlClientOptions,
} from './client.ts';

export { CONTROL_COOKIE_NAME, CONTROL_CSRF_HEADER } from './constants.ts';
