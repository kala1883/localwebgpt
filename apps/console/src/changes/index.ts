/**
 * `apps/console/src/changes/` —— 待批准页面的视图模型（LWB-023 与 LWB-036）。
 *
 * 七个文件。前三个对应 LWB-023 的三条验收标准：
 *
 *  - `facts.ts`     —— 验收标准 1：**系统事实与模型的话分区**。事实区的
 *                      每一个字段都只从落库事实推导，摘要不参与任何一次计算。
 *  - `suspicious.ts`—— 验收标准 2：**不可见与方向控制字符**的检出与可视化。
 *                      防的是「屏幕上看到的」与「批准绑定的字节」不是同一个东西。
 *  - `approval.ts`  —— 验收标准 3：**批准入口**的可见性与理由。
 *
 * 后三个对应 LWB-036：
 *
 *  - `review.ts`    —— 验收标准 1：**复核覆盖**。没看全的文件会让批准入口
 *                      消失（`approvalAffordance` 的 `coverage` 是必填输入，
 *                      因此「能不能批准」必然经过「全都看过没有」）。
 *  - `paging.ts`    —— 步骤 1：逐文件翻页与键盘映射。方向只有一处，
 *                      按钮与键盘都走它。
 *  - `refresh.ts`   —— 步骤 2 与验收标准 2：刷新的节奏（只走本地认证接口、
 *                      终态即停、后台暂停）与在途请求的合并。
 *
 * 另有一个 `detail.ts` 不直接对应某一条标准：它把 `changes.get` 的响应
 * 解析成类型正确的对象（缺字段落到 `null`，唯独内容闸门落到**拒绝**）。
 * 它与 LWB-035 的 `src/setup/readings.ts` 是同一层。
 *
 * ## 为什么这一层是纯 TypeScript，不写在 `.vue` 里
 *
 * 与 `apps/console/src/auth/` 同一条理由（偏离项 18）：仓库的 tsconfig
 * 只有 `lib: ["ES2023"]`、**没有 DOM**，因此这一层不可能依赖 `window`、
 * `document` 之类的全局，于是能在 node 里被直接测到。
 *
 * 三条验收标准里，能判定的部分全都在这里 —— `.vue` 文件只负责把它们
 * 摆到屏幕上。这个分法的价值不在于「解耦」这种泛泛的好处，而在于
 * **每条验收标准都有一份不依赖浏览器也能跑的断言**：一份只能在
 * 「我先在浏览器里点一遍」的条件下成立的验收，等于没有验收。
 *
 * 上一级目录的 `views/` 与 `components/` 是那些 `.vue` 文件，
 * 它们由 `vue-tsc` 检查类型、由 vitest 在 happy-dom 里渲染。
 */

export {
  breakdownOf,
  describeChange,
  expiryOf,
  formatBytes,
  formatLineDelta,
} from './facts.ts';
export type {
  ChangeDescription,
  ChangeFacts,
  ChangeTotals,
  ExpiryCountdown,
  ModelProse,
  RiskBreakdown,
} from './facts.ts';

export {
  countByCategory,
  findSuspicious,
  hasSuspicious,
  segmentText,
  visualizeSuspicious,
} from './suspicious.ts';
export type {
  Segment,
  SuspiciousCategory,
  SuspiciousEntry,
  SuspiciousRange,
  SuspiciousSegment,
  TextSegment,
} from './suspicious.ts';

export { approvalAffordance, approvalIdempotencyKey } from './approval.ts';
export type {
  ApprovalAffordance,
  ApprovalBlockedReason,
  ApprovalGateInput,
  SessionPresence,
} from './approval.ts';

export {
  appendDiffPage,
  CHANGE_STATE_WHITELIST,
  parseChangeDetail,
  progressFromTexts,
} from './detail.ts';
export type {
  ChangeDetail,
  DetailApproval,
  DetailDiffPage,
  DetailWorkspace,
  FileText,
} from './detail.ts';

export { recordFullTexts, recordPage, reviewCoverageOf } from './review.ts';
export type {
  ContentGate,
  DiffProgress,
  FileCoverageEntry,
  FileUncoveredReason,
  ReviewCoverage,
  ReviewStatus,
} from './review.ts';

export { actionFor, clampIndex, positionLabel, REVIEW_KEYMAP, stepFile } from './paging.ts';
export type { KeyBinding, KeyboardAction } from './paging.ts';

export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  EXECUTING_INTERVAL_MS,
  REFRESH_ENDPOINT,
  refreshDecisionOf,
  SingleFlight,
  WATCHING_INTERVAL_MS,
} from './refresh.ts';
export type { RefreshDecision, RefreshInput, RefreshReason } from './refresh.ts';
