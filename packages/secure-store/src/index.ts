/**
 * `@lwb/secure-store` —— 受保护存储（LWB-007）。
 *
 * 四块职责，各自有明确的失败模式：
 *
 *  1. `layout` —— 受保护根只有一个定义，避免某处漏掉一个目录。
 *  2. `acl` + `SecureStore.ps1` —— 加固并**回读校验**；不可用即拒绝启动。
 *  3. `credentials` —— DPAPI 保护的凭证，按类别域分离，绝不落明文。
 *  4. `redaction` —— 日志/参数/诊断包出站前的脱敏。
 *
 * `protected-paths` 是第 5 块，单独属于「不得被注册为工作区」这条约束（I13）。
 */

export {
  SecureStoreHelper,
  type AclInspector,
  type AclRule,
  type AclSnapshot,
  type HardenResult,
  type CredentialProtector,
  type HelperError,
  type HelperErrorCode,
  type HelperResult,
  type HelperSuccess,
} from './helper-client.ts';

export {
  ALLOWED_SIDS,
  AclUnavailableError,
  AclViolationError,
  assessAcl,
  hardenStore,
  inspectAndAssess,
  type AclAssessment,
  type AclViolation,
  type AclViolationKind,
  type HardenedStore,
} from './acl.ts';

export {
  CREDENTIAL_CLASSES,
  CredentialCorruptError,
  CredentialStore,
  CredentialUnavailableError,
  fingerprintOf,
  type CredentialClass,
  type CredentialInfo,
  type CredentialStoreOptions,
} from './credentials.ts';

export {
  StoreLayoutError,
  STORE_DIR_NAME,
  STORE_SUBDIRECTORIES,
  describeStoreRoot,
  isInsideStore,
  resolveStoreLayout,
  resolveStoreRoot,
  userHomeDirectory,
  type ResolvedLayout,
  type StoreLayout,
  type StoreSubdirectory,
} from './layout.ts';

export {
  HARD_DENIED_BASENAMES,
  HARD_DENIED_DIRNAMES,
  NOT_AUTO_EXEMPTED,
  assessBroadDirectory,
  findProtectedIdentityMatch,
  isProtectedPathSyntax,
  broadDirectoryProbes,
  type BroadDirectoryOptions,
  type BroadDirectoryVerdict,
  type ProtectedIdentityRef,
  type ProtectedPathMatch,
} from './protected-paths.ts';

export {
  assertNoRegisteredSecret,
  describeRedaction,
  redact,
  redactArgv,
  redactFields,
  type RedactionTarget,
} from './redaction.ts';
