/**
 * `@lwb/workspaces` —— 工作区登记（LWB-009）。
 *
 * 四块职责：
 *  1. `root-path`  —— 候选根的绝对路径语法（纯函数，不是安全边界）。
 *  2. `screen`     —— 形态/关系筛查（纯函数：给事实、给结论）。
 *  3. `registry`   —— 登记、代次、暂停/恢复/移除/重新验证，以及取用根的**唯一通道**。
 *  4. `environment`—— 读环境变量的唯一位置，让前两块保持纯。
 *
 * 本包不得直接接触文件系统（由 scripts/check-fsguard-imports.mjs 强制）：
 * 所有磁盘事实都通过注入的 `RootProbe`（生产上是 `@lwb/winfs` 后端）获得。
 */

export {
  ancestorPaths,
  isSameOrAncestor,
  isStrictAncestor,
  lastSegment,
  MAX_ROOT_PATH_CHARS,
  parseAbsoluteRoot,
  rootKey,
  type RootPathAccepted,
  type RootPathParse,
  type RootPathRejectReason,
  type RootPathRejected,
} from './root-path.ts';

export {
  isRootRejectedError,
  ROOT_REJECTION_SUMMARIES,
  RootRejectedError,
  type RootRejection,
  type RootRejectionReason,
} from './rejections.ts';

export {
  MAX_ALIAS_CHARS,
  parseRootOrReject,
  screenRoot,
  validateAlias,
  VERIFIED_FILESYSTEMS,
  type AliasCheck,
  type ExistingRoot,
  type RootFacts,
  type ScreenInput,
  type WorkspaceAdminOrigin,
} from './screen.ts';

export {
  collectProtectedRefs,
  protectedStorePaths,
  resolveWorkspaceEnvironment,
  type ResolveWorkspaceEnvironmentOptions,
} from './environment.ts';

export {
  defaultWorkspaceId,
  looksLikeProtectedStore,
  SINGLE_FILE_ROOT_NOTE,
  suggestAlias,
  WorkspaceRegistry,
  type AuthorizedRoot,
  type RegisterWorkspaceInput,
  type ReverifyOutcome,
  type RootIdentityOutcome,
  type RootProbe,
  type WorkspaceEnvironment,
  type WorkspaceRegistryOptions,
} from './registry.ts';
