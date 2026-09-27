/**
 * @lwb/persistence —— SQLite 状态库。
 *
 * 边界：
 *  - 本包是**状态**的持久化，不是**用户文件**的持久化。
 *    SQLite 的原子提交不扩展到工作区文件（方案 §9），
 *    因此本包不提供、也不暗示跨文件的 ACID。
 *  - 本包持有 `better-sqlite3` 与 `node:fs` 一类能力，属于允许直接接触
 *    文件系统的边界包（见 scripts/check-fsguard-imports.mjs 的允许前缀）；
 *    业务包只能通过这里暴露的接口读写状态。
 *  - 所有 SQL 封在 `repositories.ts` 内部，调用方不写 SQL。
 */

export {
  closeDatabase,
  DEFAULT_BUSY_TIMEOUT_MS,
  openDatabase,
  withImmediateTransaction,
  type OpenDatabaseOptions,
  type OpenDatabaseResult,
  type SqliteDatabase,
} from './database.ts';

export {
  FROZEN_CHANGE_STATES,
  FROZEN_ITEM_RESULT_STATES,
  FROZEN_OPERATION_STATES,
  FROZEN_RECOVERY_DECISIONS,
  FROZEN_TOMBSTONE_CHANGE_STATES,
  KNOWN_SCHEMA_VERSION,
  MIGRATIONS,
  migrationChecksum,
  type Migration,
} from './migrations.ts';

export {
  ApprovalsRepo,
  AuditRepo,
  BlobsRepo,
  ChangesRepo,
  ConnectionsRepo,
  GrantsRepo,
  IdempotencyRepo,
  JournalRepo,
  OperationsRepo,
  RecoveryAuthorizationsRepo,
  Repositories,
  WorkspaceWriteSlotsRepo,
  WorkspacesRepo,
  type ApprovalRecord,
  type ApprovalWithChange,
  type AuditCallRecord,
  type AuditEventInput,
  type AuditFileAccessInput,
  type BlobEnsureOutcome,
  type BlobRecord,
  type ChangeItemInput,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type Clock,
  type ConnectionRecord,
  type CreateChangeSetInput,
  type CreateConnectionInput,
  type CreateRecoveryAuthorizationInput,
  type CreateWorkspaceInput,
  type GrantRecord,
  type IdempotencyOutcome,
  type IdempotencyRecord,
  type JournalAppendInput,
  type OperationCreateOutcome,
  type OperationRecord,
  type PrincipalKind,
  type RecoveryAuthorizationRecord,
  type RecoveryAuthorizationState,
  type RecoveryDecision,
  type SlotClaimInput,
  type WorkspaceKind,
  type WorkspaceRecord,
  type WorkspaceWriteSlotRecord,
} from './repositories.ts';
