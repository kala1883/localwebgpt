/**
 * `apps/console/src/setup/` —— 首次配置页与工作区页的视图模型（LWB-035）。
 *
 * 六个文件，对应三条验收标准与三个执行步骤：
 *
 *  - `readings.ts`     —— 地基：**读数与时刻**。验收标准 3 要的
 *                        「停机/睡眠/断网不显示成正常在线」没有它就无从判定，
 *                        因为一个只有 `value` 的界面分不清「读到一个值」
 *                        与「这个值还算数」。
 *  - `platform.ts`     —— 执行步骤 2：**四条腿**（daemon / 适配器 / 隧道 /
 *                        账号验收）与那一句「平台能不能被调用」。
 *  - `capabilities.ts` —— 验收标准 2：**四个门禁格与控制台自己再与一遍**，
 *                        以及登记表单的那四个字段。
 *  - `pause.ts`        —— 执行步骤 3 的「一键暂停」：按下去之后**必须说出来
 *                        的五件事**，以及按下与恢复的不对称判据。
 *  - `diagnostic.ts`   —— 执行步骤 3 的「脱敏诊断」：三层擦洗 + 一次终检，
 *                        终检的对象是**最终要复制出去的那串字节**。
 *  - `help.ts`         —— 执行步骤 3 的「本地启动帮助」：按处境挑选，
 *                        而没有处境时**一条都不显示**。
 *
 * ## 为什么这一层是纯 TypeScript，不写在 `.vue` 里
 *
 * 与 `src/changes/`（偏离项 18）同一条理由：仓库的 tsconfig 只有
 * `lib: ["ES2023"]`、**没有 DOM**，因此这一层不可能依赖 `window`、`document`，
 * 于是能在 node 里被直接测到。三条验收标准里能判定的部分全都在这里，
 * `.vue` 只负责把它们摆到屏幕上 —— 一份只能在「我先在浏览器里点一遍」
 * 的条件下成立的验收，等于没有验收。
 *
 * 上一级目录的 `views/` 是那些 `.vue` 文件：`SetupView.vue`（首次配置与
 * 连接状态）与 `WorkspacesView.vue`（哪些目录正在暴露）。
 */

export {
  DEFAULT_STALE_AFTER_MS,
  describeFreshness,
  freshnessOf,
  looksLikeStatus,
  parseConnections,
  parsePauseOutcome,
  parsePauseStatus,
  parseStatusReading,
  parseWorkspaces,
  parseWorkspaceAccess,
} from './readings.ts';
export type {
  ConnectionRow,
  Freshness,
  Gates,
  MachineIdentity,
  PauseOutcomeReading,
  PauseStatusReading,
  PendingRow,
  Reading,
  RecoveryRow,
  StatusReading,
  StoppingRow,
  TunnelReading,
  WorkspaceKind,
  WorkspaceMode,
  WorkspaceRow,
  WorkspaceAccessRow,
  ModelWorkspaceCapability,
} from './readings.ts';

export { machineLine, platformVerdict } from './platform.ts';
export type {
  LegId,
  LegState,
  LegView,
  PlatformVerdict,
  PlatformVerdictInput,
} from './platform.ts';

export {
  describeWorkspace,
  exposureSummary,
  modeOffers,
  registerRequest,
  validateRegister,
  writeGate,
} from './capabilities.ts';
export type {
  ExposureSummary,
  ModeOffer,
  RegisterDraft,
  RegisterValidation,
  WriteGate,
} from './capabilities.ts';

export { pauseOutcomeReport, pauseView } from './pause.ts';
export type {
  PauseBlockedReason,
  PauseOutcomeReport,
  PauseOutcomeSeverity,
  PauseView,
  PauseViewInput,
  ResumeBlockedReason,
} from './pause.ts';

export {
  redactedDiagnostic,
  scanForLeaks,
  scrub,
  toDiagnosticWorkspaces,
} from './diagnostic.ts';
export type {
  DiagnosticInput,
  DiagnosticWorkspaceRow,
  RedactedDiagnostic,
  ScrubResult,
} from './diagnostic.ts';

export { applicableHelp, localStartHelp } from './help.ts';
export type { HelpEntry, HelpId, HelpSituation } from './help.ts';
