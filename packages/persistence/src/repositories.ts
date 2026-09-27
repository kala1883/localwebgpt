/**
 * 仓储层（LWB-006）。所有 SQL 封在本文件内，调用方不写 SQL。
 *
 * 设计原则：
 *
 *  1. **不可满足即失败**：会话层要区分「新建 / 重放 / 冲突」「新建 / 已存在」这类
 *     结果，不用异常表达正常分支；而越权、状态非法这类**不可继续**的情况才抛错。
 *  2. **约束由数据库兜底**：即使调用方逻辑写错，唯一索引与触发器仍然拦得住。
 *     例如「一个修改集只能有一个操作」不靠调用方自觉，靠 UNIQUE(change_id)。
 *  3. **时间由外部注入**：便于测试构造过期/未过期，而不是让测试去 sleep。
 */

import { BridgeError, validateRelativePath, type ApprovalState, type ChangeOp, type ChangeSetState, type FileEncoding, type NewlineStyle, type OperationState, type WorkspaceKind, type WorkspaceMode } from '@lwb/contracts';

import { withImmediateTransaction, type SqliteDatabase } from './database.ts';
import { FROZEN_RECOVERY_DECISIONS } from './migrations.ts';

const isoNow = (): string => new Date().toISOString();
export type Clock = () => string;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new BridgeError('INTERNAL_ERROR', `状态库记录缺失：${what}`);
  }
  return value;
}

function bool(value: number): boolean {
  return value === 1;
}

function toBoolInt(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * 唯一索引冲突判定。
 *
 * better-sqlite3 把 SQLite 错误暴露为带 `code` 的异常。只有**唯一性**
 * 被违反时才允许当作「已存在」处理；其它错误（磁盘满、库损坏、
 * 触发器拒绝）必须原样上抛，不能被误判成正常分支。
 *
 * ## 为什么前缀匹配 `SQLITE_CONSTRAINT` 是错的
 *
 * 那个前缀覆盖的**不止**唯一性。SQLite 的约束错误码至少有
 * `_UNIQUE` / `_PRIMARYKEY` / `_CHECK` / `_FOREIGNKEY` / `_NOTNULL` /
 * `_TRIGGER` 六类，而本函数的五个调用点**全部**把 `true` 解释成
 * 「已存在，去读那一行」。前缀匹配会让一次 `CHECK` 失败（比如摘要不是
 * 64 位十六进制）被报成「该修改集已存在有效批准」—— 一句与实际原因
 * 无关的话，而排障的人会照着它去查一个并不存在的问题。
 *
 * 这个缺陷是 LWB-030 写恢复授权表的测试时撞出来的（构造一条畸形摘要，
 * 期待 `CHECK constraint failed`，拿到的却是「已存在有效恢复授权」）。
 * 收窄之后，畸形输入以 `SQLITE_CONSTRAINT_CHECK` 原样上抛 —— 那是一条
 * **内部不变量被破坏**的信号，它不该被任何调用点当成一个正常分支吃掉。
 *
 * `_PRIMARYKEY` 一并收进来：`INSERT` 撞主键与撞唯一索引对调用方是同一件事
 * （「这一行已经有了」），而 `INTEGER PRIMARY KEY` 与 `UNIQUE` 的报码
 * 在 SQLite 里并不总是同一个。
 */
function isUniqueViolation(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

export type PrincipalKind = 'model_surface' | 'console' | 'runtime';

export interface ConnectionRecord {
  readonly id: string;
  readonly principal_kind: PrincipalKind;
  readonly principal_id: string;
  readonly alias: string;
  readonly enabled: boolean;
  readonly generation: number;
  readonly credential_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ConnectionRow {
  id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  alias: string;
  enabled: number;
  generation: number;
  credential_ref: string | null;
  created_at: string;
  updated_at: string;
}

function toConnection(row: ConnectionRow): ConnectionRecord {
  return { ...row, enabled: bool(row.enabled) };
}

export interface CreateConnectionInput {
  readonly id: string;
  readonly principal_kind: PrincipalKind;
  readonly principal_id: string;
  readonly alias: string;
  readonly credential_ref?: string | null;
  /** 新建连接默认**停用**：授权必须由本地操作者显式打开。 */
  readonly enabled?: boolean;
}

export class ConnectionsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  create(input: CreateConnectionInput): ConnectionRecord {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO connections
           (id, principal_kind, principal_id, alias, enabled, generation, credential_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.principal_kind,
        input.principal_id,
        input.alias,
        toBoolInt(input.enabled ?? false),
        input.credential_ref ?? null,
        now,
        now,
      );
    return this.requireById(input.id);
  }

  findById(id: string): ConnectionRecord | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | ConnectionRow
      | undefined;
    return row ? toConnection(row) : null;
  }

  requireById(id: string): ConnectionRecord {
    return required(this.findById(id) ?? undefined, `connections.id=${id}`);
  }

  findByAlias(alias: string): ConnectionRecord | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE alias = ?').get(alias) as
      | ConnectionRow
      | undefined;
    return row ? toConnection(row) : null;
  }

  list(): ConnectionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM connections ORDER BY created_at ASC, id ASC')
      .all() as ConnectionRow[];
    return rows.map(toConnection);
  }

  /**
   * 启停连接，**并递增代次**。
   *
   * 代次变化使**这次状态变化本身可被复查发现**：守卫在返回前比一次代次
   * （调用进行中被暂停/恢复会当场命中），停用则让新请求在「解析连接」时止步。
   *
   * **它不会使此前签发的读取票据与游标失效** —— 那些绑的是**工作区**代次，
   * 不是连接代次（偏离项 61：连接暂停→恢复后，暂停前签发的游标仍可用）。
   * 把这句写成「此前签发的票据与批准全部失效」会让读到这里的人以为
   * 连接侧的撤权已经闭合，而它没有。
   */
  setEnabled(id: string, enabled: boolean): ConnectionRecord {
    const result = this.db
      .prepare(
        'UPDATE connections SET enabled = ?, generation = generation + 1, updated_at = ? WHERE id = ?',
      )
      .run(toBoolInt(enabled), this.clock(), id);
    if (result.changes === 0) {
      throw new BridgeError('NOT_AUTHORIZED', '连接不存在。');
    }
    return this.requireById(id);
  }
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

/**
 * 工作区根的形态：目录或**单个文件**。
 *
 * 类型定义在 `@lwb/contracts`（`version.ts`），这里只做再导出：
 * 两处各写一份会漂移，而漂移的后果是持久化层接受的形态与契约层宣称的不同。
 */
export type { WorkspaceKind };

export interface WorkspaceRecord {
  readonly id: string;
  readonly alias: string;
  readonly kind: WorkspaceKind;
  readonly canonical_root: string;
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly generation: number;
  readonly policy_version: number;
  readonly mode: WorkspaceMode;
  readonly enabled: boolean;
  /**
   * 移除时间；`null` 表示在册。
   *
   * 移除是**软**移除，因为 `changesets.workspace_id` 是 `ON DELETE RESTRICT`
   * 且终态修改集不得删除：历史必须继续指向一个真实存在的行。
   * 移除同时递增 generation，因此移除前签发的票据、游标与修改集全部失效。
   */
  readonly removed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface WorkspaceRow extends Omit<WorkspaceRecord, 'enabled'> {
  enabled: number;
}

function toWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return { ...row, enabled: bool(row.enabled) };
}

/** 在册（未被移除）且启用。用于所有「这条工作区现在还能用吗」的判定。 */
function isUsable(record: WorkspaceRecord): boolean {
  return record.removed_at === null && record.enabled;
}

export interface CreateWorkspaceInput {
  readonly id: string;
  readonly alias: string;
  /**
   * 根对象的类型。
   *
   * `'file'`（单文件授权）时 `canonical_root` 是**那个文件**的路径、
   * `root_file_id` 是**该文件**的 128 位身份，而不是它所在目录的。
   * 这样「暴露父目录」在结构上不可能：文件没有子项可列。
   */
  readonly kind: WorkspaceKind;
  readonly canonical_root: string;
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly policy_version: number;
  readonly mode: WorkspaceMode;
}

export class WorkspacesRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  create(input: CreateWorkspaceInput): WorkspaceRecord {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, alias, kind, canonical_root, volume_id, root_file_id,
            generation, policy_version, mode, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.id,
        input.alias,
        input.kind,
        input.canonical_root,
        input.volume_id,
        input.root_file_id,
        input.policy_version,
        input.mode,
        now,
        now,
      );
    return this.requireById(input.id);
  }

  findById(id: string): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | WorkspaceRow
      | undefined;
    return row ? toWorkspace(row) : null;
  }

  requireById(id: string): WorkspaceRecord {
    return required(this.findById(id) ?? undefined, `workspaces.id=${id}`);
  }

  findByAlias(alias: string): WorkspaceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE alias = ? AND removed_at IS NULL')
      .get(alias) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  /**
   * 按真实卷与文件身份查找：用于识别「同一物理目录被重复登记」。
   *
   * 只查在册工作区。已移除的工作区不该再占住一个物理对象，
   * 否则本地操作者移除后无法重新登记同一目录。
   */
  findByIdentity(volumeId: string, rootFileId: string): WorkspaceRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM workspaces WHERE volume_id = ? AND root_file_id = ? AND removed_at IS NULL',
      )
      .get(volumeId, rootFileId) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  /**
   * 在册工作区列表。
   *
   * 默认**不含**已移除的行，也不含已停用的行：默认视图就是「现在还能用哪些」。
   * 需要完整历史（审计、诊断）时显式打开开关——把「默认排除」写在这里，
   * 是为了让忘记传参的调用方拿到安全的那一侧，而不是拿到全部。
   */
  list(
    options: { readonly include_disabled?: boolean; readonly include_removed?: boolean } = {},
  ): WorkspaceRecord[] {
    const where: string[] = [];
    if (options.include_removed !== true) where.push('removed_at IS NULL');
    if (options.include_disabled !== true) where.push('enabled = 1');
    const sql =
      `SELECT * FROM workspaces` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at ASC, id ASC';
    const rows = this.db.prepare(sql).all() as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  /**
   * 取一条**现在可用**的工作区（在册且启用）。
   *
   * 存在但不可用时抛 `WORKSPACE_NOT_GRANTED` 而不是 `NOT_FOUND`：
   * 「这条工作区已被移除」与「这条工作区从来不存在」对本地操作者
   * 是完全不同的两件事，合并会让排障时看不到真实原因。
   */
  requireUsableById(id: string): WorkspaceRecord {
    const record = this.requireById(id);
    if (!isUsable(record)) {
      throw new BridgeError('WORKSPACE_NOT_GRANTED', '该工作区已被移除或停用。', {
        removed: record.removed_at !== null,
        enabled: record.enabled,
      });
    }
    return record;
  }

  /**
   * 软移除：打上 `removed_at`、停用，并**递增 generation**。
   *
   * 递增代次是这一步的关键：移除前签发的读取票据、游标与修改集都绑定了
   * 旧代次，代次一变它们全部失效 —— 而且这个失效不依赖任何人记得去查
   * `removed_at`，对已经拿在调用方手里的票据同样成立。
   */
  markRemoved(id: string): WorkspaceRecord {
    const result = this.db
      .prepare(
        `UPDATE workspaces
            SET removed_at = ?, enabled = 0, generation = generation + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL`,
      )
      .run(this.clock(), this.clock(), id);
    if (result.changes === 0) {
      const current = this.findById(id);
      if (!current) throw new BridgeError('NOT_FOUND', '工作区不存在。');
      throw new BridgeError('CHANGE_STATE_INVALID', '该工作区已经被移除。');
    }
    return this.requireById(id);
  }

  /**
   * 递增工作区代次。
   *
   * 必须调用它的场合：根被重新授权、模式或策略变化、根的物理身份改变。
   * 代次一旦变化，旧的读取票据、修改集与批准全部失效（方案 §5.3）。
   */
  bumpGeneration(id: string, policyVersion?: number): WorkspaceRecord {
    const result = this.db
      .prepare(
        `UPDATE workspaces
            SET generation = generation + 1,
                policy_version = COALESCE(?, policy_version),
                updated_at = ?
          WHERE id = ? AND removed_at IS NULL`,
      )
      .run(policyVersion ?? null, this.clock(), id);
    if (result.changes === 0) this.#writeMiss(id, '工作区已被移除，不能递增代次。');
    return this.requireById(id);
  }

  /**
   * 启停工作区，**两个方向都递增代次**。
   *
   * 只在停用时递增是不够的：停用期间签发的任何东西都该在重新启用时失效，
   * 否则「先停用改权限、再启用」会留下一个跨越权限变更仍然有效的旧票据。
   * 重新启用本身就是一次重新授权（方案 §5.3），因此它同样改变代次。
   */
  setEnabled(id: string, enabled: boolean): WorkspaceRecord {
    const result = this.db
      .prepare(
        `UPDATE workspaces
            SET enabled = ?, generation = generation + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL`,
      )
      .run(toBoolInt(enabled), this.clock(), id);
    if (result.changes === 0) this.#writeMiss(id, '工作区已被移除，不能改变启用状态。');
    return this.requireById(id);
  }

  setMode(id: string, mode: WorkspaceMode): WorkspaceRecord {
    const result = this.db
      .prepare(
        `UPDATE workspaces
            SET mode = ?, generation = generation + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL`,
      )
      .run(mode, this.clock(), id);
    if (result.changes === 0) this.#writeMiss(id, '工作区已被移除，不能改变访问模式。');
    return this.requireById(id);
  }

  /**
   * 重定位：把该工作区指向**另一个物理对象**。
   *
   * 路径与身份必须一起换掉，不能只换路径字符串 —— 只换字符串会让
   * 「登记的还是旧对象、访问的却是新对象」。调用方（packages/workspaces）
   * 必须在调用本方法之前对新根做完完整的登记筛查。
   *
   * 唯一索引 `(volume_id, root_file_id) WHERE removed_at IS NULL` 是这里的
   * 最后一道保险：把工作区重定位到一个已经登记的物理对象上会被数据库拒绝。
   */
  relocate(
    id: string,
    next: { readonly canonical_root: string; readonly volume_id: string; readonly root_file_id: string },
  ): WorkspaceRecord {
    const result = this.db
      .prepare(
        `UPDATE workspaces
            SET canonical_root = ?, volume_id = ?, root_file_id = ?,
                generation = generation + 1, updated_at = ?
          WHERE id = ? AND removed_at IS NULL`,
      )
      .run(next.canonical_root, next.volume_id, next.root_file_id, this.clock(), id);
    if (result.changes === 0) this.#writeMiss(id, '工作区已被移除，不能重定位。');
    return this.requireById(id);
  }

  /** 写操作未命中的统一归因：不存在 vs 已移除，两者必须能分辨。 */
  #writeMiss(id: string, removedMessage: string): never {
    const current = this.findById(id);
    if (!current) throw new BridgeError('NOT_FOUND', '工作区不存在。');
    throw new BridgeError('WORKSPACE_NOT_GRANTED', removedMessage, { removed: true });
  }
}

// ---------------------------------------------------------------------------
// 授权
// ---------------------------------------------------------------------------

export interface GrantRecord {
  readonly id: string;
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

interface GrantRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  capabilities: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toGrant(row: GrantRow): GrantRecord {
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(row.capabilities);
  } catch {
    // 授权内容损坏时**不**降级为空数组（那等于悄悄扩大或缩小权限），
    // 而是显式失败，由本地操作者修复。
    throw new BridgeError('STORAGE_UNAVAILABLE', '授权记录内容损坏，已拒绝使用。');
  }
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string')) {
    throw new BridgeError('STORAGE_UNAVAILABLE', '授权记录内容不是字符串数组，已拒绝使用。');
  }
  return {
    id: row.id,
    connection_id: row.connection_id,
    workspace_id: row.workspace_id,
    capabilities: capabilities as string[],
    enabled: bool(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class GrantsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /** 同一 (连接, 工作区) 只保留一条授权；重复授予是**替换**而不是叠加。 */
  put(input: {
    readonly id: string;
    readonly connection_id: string;
    readonly workspace_id: string;
    readonly capabilities: readonly string[];
    readonly enabled?: boolean;
  }): GrantRecord {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO grants (id, connection_id, workspace_id, capabilities, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, workspace_id) DO UPDATE SET
           capabilities = excluded.capabilities,
           enabled      = excluded.enabled,
           updated_at   = excluded.updated_at`,
      )
      .run(
        input.id,
        input.connection_id,
        input.workspace_id,
        JSON.stringify([...input.capabilities]),
        toBoolInt(input.enabled ?? true),
        now,
        now,
      );
    return required(
      this.find(input.connection_id, input.workspace_id) ?? undefined,
      'grants 刚写入的记录',
    );
  }

  find(connectionId: string, workspaceId: string): GrantRecord | null {
    const row = this.db
      .prepare('SELECT * FROM grants WHERE connection_id = ? AND workspace_id = ?')
      .get(connectionId, workspaceId) as GrantRow | undefined;
    return row ? toGrant(row) : null;
  }

  listByConnection(connectionId: string): GrantRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM grants WHERE connection_id = ? ORDER BY workspace_id ASC')
      .all(connectionId) as GrantRow[];
    return rows.map(toGrant);
  }

  /**
   * 判定某连接对某工作区是否具备某项能力。
   *
   * 覆盖了连接停用与工作区停用两种情况——这两者都必须立即剥夺能力，
   * 因此判定必须同时读三张表，不能只看 grants。
   */
  hasCapability(connectionId: string, workspaceId: string, capability: string): boolean {
    const row = this.db
      .prepare(
        `SELECT g.capabilities AS capabilities
           FROM grants g
           JOIN connections c ON c.id = g.connection_id AND c.enabled = 1
           JOIN workspaces  w ON w.id = g.workspace_id  AND w.enabled = 1
          WHERE g.connection_id = ? AND g.workspace_id = ? AND g.enabled = 1`,
      )
      .get(connectionId, workspaceId) as { capabilities: string } | undefined;
    if (!row) return false;
    const grant = toGrant({
      id: '',
      connection_id: connectionId,
      workspace_id: workspaceId,
      capabilities: row.capabilities,
      enabled: 1,
      created_at: '',
      updated_at: '',
    });
    return grant.capabilities.includes(capability);
  }
}

// ---------------------------------------------------------------------------
// blob
// ---------------------------------------------------------------------------

export interface BlobRecord {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly storage_ref: string;
  readonly refcount: number;
  readonly retention_state: 'active' | 'pending_gc' | 'deleted';
  readonly created_at: string;
  readonly last_verified_at: string | null;
}

export type BlobEnsureOutcome =
  | { readonly kind: 'created'; readonly blob: BlobRecord }
  | { readonly kind: 'existing'; readonly blob: BlobRecord };

export class BlobsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 登记一个已持久化并通过校验的 blob，并占用一个引用。
   *
   * 前提：字节**已经**落到 `storage_ref`。本方法只写元数据；
   * 它不校验磁盘内容（那是 blob-store 的职责），因此调用次序不能颠倒——
   * 先落盘、后登记，否则会出现「登记了却取不到字节」的悬空引用。
   */
  ensure(input: {
    readonly id: string;
    readonly sha256: string;
    readonly size: number;
    readonly storage_ref: string;
  }): BlobEnsureOutcome {
    const existing = this.findByContent(input.sha256, input.size);
    if (existing) {
      this.addRef(existing.id);
      return { kind: 'existing', blob: this.requireById(existing.id) };
    }

    const now = this.clock();
    try {
      this.db
        .prepare(
          `INSERT INTO blobs (id, sha256, size, storage_ref, refcount, retention_state, created_at, last_verified_at)
           VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
        )
        .run(input.id, input.sha256, input.size, input.storage_ref, now, now);
    } catch (cause) {
      // 并发插入同一内容：唯一索引会挡住，此时按「已存在」处理并加引用。
      if (!isUniqueViolation(cause)) throw cause;
      const raced = required(
        this.findByContent(input.sha256, input.size) ?? undefined,
        'blobs 唯一冲突后的记录',
      );
      this.addRef(raced.id);
      return { kind: 'existing', blob: this.requireById(raced.id) };
    }
    return { kind: 'created', blob: this.requireById(input.id) };
  }

  findById(id: string): BlobRecord | null {
    const row = this.db.prepare('SELECT * FROM blobs WHERE id = ?').get(id) as
      | BlobRecord
      | undefined;
    return row ?? null;
  }

  requireById(id: string): BlobRecord {
    return required(this.findById(id) ?? undefined, `blobs.id=${id}`);
  }

  findByContent(sha256: string, size: number): BlobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM blobs WHERE sha256 = ? AND size = ?')
      .get(sha256, size) as BlobRecord | undefined;
    return row ?? null;
  }

  addRef(id: string): void {
    const result = this.db
      .prepare("UPDATE blobs SET refcount = refcount + 1 WHERE id = ? AND retention_state <> 'deleted'")
      .run(id);
    if (result.changes === 0) {
      throw new BridgeError('STORAGE_UNAVAILABLE', '引用了已删除或不存在的快照对象。');
    }
  }

  /**
   * 释放一个引用。
   * 引用归零**不**立即删除字节：置为 `pending_gc`，由 GC 在确认无操作在途后再清理，
   * 否则正在恢复中的操作会取不到回滚所需的原始字节。
   */
  releaseRef(id: string): void {
    const result = this.db
      .prepare(
        `UPDATE blobs
            SET refcount = refcount - 1,
                retention_state = CASE WHEN refcount - 1 <= 0 THEN 'pending_gc' ELSE retention_state END
          WHERE id = ? AND refcount > 0`,
      )
      .run(id);
    if (result.changes === 0) {
      throw new BridgeError('INTERNAL_ERROR', '释放了不存在的快照引用。');
    }
  }

  markVerified(id: string): void {
    this.db
      .prepare('UPDATE blobs SET last_verified_at = ? WHERE id = ?')
      .run(this.clock(), id);
  }

  listPendingGc(): BlobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM blobs WHERE retention_state = 'pending_gc' AND refcount = 0")
      .all() as BlobRecord[];
    return rows;
  }

  /** 仅在确认字节已从磁盘移除后调用。 */
  markDeleted(id: string): void {
    const result = this.db
      .prepare(
        "UPDATE blobs SET retention_state = 'deleted' WHERE id = ? AND refcount = 0 AND retention_state = 'pending_gc'",
      )
      .run(id);
    if (result.changes === 0) {
      throw new BridgeError('INTERNAL_ERROR', '只能删除引用已归零且待回收的快照对象。');
    }
  }
}

// ---------------------------------------------------------------------------
// 修改集与条目
// ---------------------------------------------------------------------------

export interface ChangeSetRecord {
  readonly id: string;
  readonly owner_connection_id: string;
  readonly workspace_id: string;
  readonly root_generation: number;
  readonly policy_version: number;
  readonly contract_version: string;
  readonly digest: string;
  readonly summary: string;
  readonly state: ChangeSetState;
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChangeItemRecord {
  readonly id: string;
  readonly change_id: string;
  readonly seq: number;
  readonly op: ChangeOp;
  readonly canonical_path: string;
  readonly canonical_path_key: string;
  readonly base_file_id: string | null;
  readonly base_sha256: string | null;
  readonly target_sha256: string;
  readonly old_blob_id: string | null;
  readonly new_blob_id: string;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  /** 引擎按**操作语义**给出的增量行数；见迁移 v4。 */
  readonly added_lines: number;
  readonly removed_lines: number;
  readonly created_at: string;
}

interface ChangeItemRow extends Omit<ChangeItemRecord, 'bom'> {
  bom: number;
}

function toChangeItem(row: ChangeItemRow): ChangeItemRecord {
  return { ...row, bom: bool(row.bom) };
}

export interface ChangeItemInput {
  readonly id: string;
  /** 工作区内相对路径，必须通过 `validateRelativePath`。 */
  readonly path: string;
  readonly op: ChangeOp;
  /** 编辑/整文件替换的基线文件身份；create_text 必须为 null。 */
  readonly base_file_id?: string | null;
  readonly base_sha256?: string | null;
  readonly target_sha256: string;
  readonly old_blob_id?: string | null;
  readonly new_blob_id: string;
  readonly encoding: FileEncoding;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  /** 引擎按**操作语义**给出的增量行数；见迁移 v4 的说明。 */
  readonly added_lines: number;
  readonly removed_lines: number;
}

export interface CreateChangeSetInput {
  readonly id: string;
  readonly owner_connection_id: string;
  readonly workspace_id: string;
  readonly root_generation: number;
  readonly policy_version: number;
  readonly contract_version: string;
  readonly digest: string;
  readonly summary: string;
  readonly expires_at: string;
  readonly items: readonly ChangeItemInput[];
}

export class ChangesRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 原子地写入一个修改集及其全部条目。
   *
   * 用立即事务：修改集与条目必须同时存在或同时不存在，
   * 半写入的修改集会让批准绑定到一个不完整的对象上。
   */
  create(input: CreateChangeSetInput): ChangeSetRecord {
    if (input.items.length === 0) {
      throw new BridgeError('INVALID_ARGUMENT', '修改集至少要包含一个条目。');
    }
    const now = this.clock();

    const run = this.db.transaction((value: CreateChangeSetInput) => {
      this.db
        .prepare(
          `INSERT INTO changesets
             (id, owner_connection_id, workspace_id, root_generation, policy_version,
              contract_version, digest, summary, state, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?, ?)`,
        )
        .run(
          value.id,
          value.owner_connection_id,
          value.workspace_id,
          value.root_generation,
          value.policy_version,
          value.contract_version,
          value.digest,
          value.summary,
          value.expires_at,
          now,
          now,
        );

      const insertItem = this.db.prepare(
        `INSERT INTO change_items
           (id, change_id, seq, op, canonical_path, canonical_path_key,
            base_file_id, base_sha256, target_sha256, old_blob_id, new_blob_id,
            encoding, bom, newline, added_lines, removed_lines, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      value.items.forEach((item, seq) => {
        const validation = validateRelativePath(item.path);
        if (!validation.ok) {
          // 语法校验在持久化入口再跑一次：任何绕过契约层校验的调用方
          // 都不应该能把一个未规范化的路径写进基线表。
          throw new BridgeError('PATH_UNSAFE', `修改集条目路径不合法：${validation.reason}`);
        }
        insertItem.run(
          item.id,
          value.id,
          seq,
          item.op,
          validation.normalized,
          validation.normalized.toLowerCase(),
          item.base_file_id ?? null,
          item.base_sha256 ?? null,
          item.target_sha256,
          item.old_blob_id ?? null,
          item.new_blob_id,
          item.encoding,
          toBoolInt(item.bom),
          item.newline,
          item.added_lines,
          item.removed_lines,
          now,
        );
      });
    });

    run.immediate(input);
    return this.requireById(input.id);
  }

  findById(id: string): ChangeSetRecord | null {
    const row = this.db.prepare('SELECT * FROM changesets WHERE id = ?').get(id) as
      | ChangeSetRecord
      | undefined;
    return row ?? null;
  }

  requireById(id: string): ChangeSetRecord {
    const row = this.findById(id);
    if (!row) throw new BridgeError('CHANGE_NOT_FOUND', '修改集不存在。');
    return row;
  }

  items(changeId: string): ChangeItemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM change_items WHERE change_id = ? ORDER BY seq ASC')
      .all(changeId) as ChangeItemRow[];
    return rows.map(toChangeItem);
  }

  /**
   * 状态流转。
   *
   * `from` 是**允许的来源状态**，写在 UPDATE 的 WHERE 里，
   * 因此检查与写入是同一个原子操作：两个进程同时尝试流转时，
   * 只有一个能把状态从合法来源改走，另一个会看到 0 行受影响而失败。
   * 若改成「先 SELECT 检查、再 UPDATE」，这个保证就没了。
   */
  transition(changeId: string, from: readonly ChangeSetState[], to: ChangeSetState): ChangeSetRecord {
    if (from.length === 0) {
      throw new BridgeError('INTERNAL_ERROR', '状态流转必须声明合法的来源状态。');
    }
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE changesets SET state = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(to, this.clock(), changeId, ...from);

    if (result.changes === 0) {
      const current = this.findById(changeId);
      if (!current) throw new BridgeError('CHANGE_NOT_FOUND', '修改集不存在。');
      throw new BridgeError('CHANGE_STATE_INVALID', '修改集当前状态不允许该操作。', {
        current_state: current.state,
        allowed_from: from.join(','),
      });
    }
    return this.requireById(changeId);
  }

  /**
   * 倒序分页列出修改集（`change_list` 的底座）。
   *
   * ## 游标是**复合**的：`(created_at, id)`
   *
   * 排序键是 `created_at DESC, id DESC`，因此只用 `created_at < ?` 做游标
   * 会在**同一毫秒**建立的两条记录上出错：它们分属两页时，第二条既不满足
   * `< 边界` 也不曾被返回 —— 一次静默的漏行。列表工具漏行是最难发现的一类
   * 错误：调用方拿到的是一份看起来完整的清单，而它据此判断「没有那个修改集」。
   *
   * `before_id` 省略时用 `'￿'`：它大于任何 id 的字符，
   * 于是同毫秒的其余行都被包含进来 —— 这正是「按时间翻页」应有的行为。
   *
   * ## `owner_connection_id` 在 SQL 里过滤，不在调用方过滤
   *
   * `change_list` 只列**本连接自己**建立的修改集。若先按 `limit` 取一页、
   * 再由调用方筛掉别人的，那一页会短一截甚至为空，而 `truncated` 的判断
   * 同时失真 —— 结果是一个「你的修改集很少」的假象。过滤必须在分页之前。
   */
  list(
    options: {
      readonly workspace_id?: string;
      readonly owner_connection_id?: string;
      readonly limit?: number;
      readonly before?: string;
      readonly before_id?: string;
    } = {},
  ): ChangeSetRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const before = options.before ?? null;
    const beforeId = options.before_id ?? '￿';
    return this.db
      .prepare(
        `SELECT * FROM changesets
          WHERE (? IS NULL OR workspace_id = ?)
            AND (? IS NULL OR owner_connection_id = ?)
            AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        options.workspace_id ?? null,
        options.workspace_id ?? null,
        options.owner_connection_id ?? null,
        options.owner_connection_id ?? null,
        before,
        before,
        before,
        beforeId,
        limit,
      ) as ChangeSetRecord[];
  }

  /**
   * 处在给定状态集合里的全部修改集（LWB-024）。
   *
   * **不设 `limit`，这是刻意的。** 调用方是失效与过期清理，而它们的正确性
   * 要求「一条不漏」：漏掉的一条意味着一个本该作废的计划仍然可以执行，
   * 或者一个已经过期的计划仍然显示为待批准。分页在这里的代价不是性能，
   * 是一处**静默**的不完整。
   *
   * 不设限的前提是集合本身有上界：调用方传进来的都是「尚未终结」的状态，
   * 而每个修改集最终都会离开它们。把 `list()` 那样的分页接口用在这里
   * 反而会引入一个新的失败形态 —— 游标停在边界上时漏掉一行。
   */
  listByStates(states: readonly ChangeSetState[]): ChangeSetRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM changesets WHERE state IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
      .all(...states) as ChangeSetRecord[];
  }

  /**
   * `updated_at >= since` 的全部修改集（LWB-024 的保留窗口扫描）。
   *
   * 用 `updated_at` 而不是 `created_at`：快照保留窗口的起点是**进入当前状态**
   * 的时刻，而那正是每次流转写入 `updated_at` 的值。对已终结的修改集而言
   * 两者不等 —— 一个 23 小时前建立、刚刚才被拒绝的修改集，它的撤销窗口
   * 从**拒绝那一刻**开始，不是从建立那一刻。
   */
  listUpdatedSince(since: string): ChangeSetRecord[] {
    return this.db
      .prepare('SELECT * FROM changesets WHERE updated_at >= ? ORDER BY updated_at ASC, id ASC')
      .all(since) as ChangeSetRecord[];
  }

  /**
   * 快照引用：`blob_id ←→ change_id`（LWB-024）。
   *
   * 由 `change_items` 反查，**不**读 `blobs.refcount`。两者回答的是不同的问题：
   * 引用计数说「有几个引用」，而回收要问的是「**谁**还可能需要这些字节」。
   * 计数为零而字节仍被需要的组合是可以存在的（见
   * `@lwb/changes` 的 `invalidation.ts`），反查不会漏掉它。
   *
   * 返回的是**全部**引用对，调用方自行按状态与时刻过滤。把过滤下推到 SQL
   * 需要把保留策略的时间窗口也写进 SQL —— 那会让策略有两个家。
   */
  blobReferences(): { blob_id: string; change_id: string }[] {
    return this.db
      .prepare(
        `SELECT old_blob_id AS blob_id, change_id FROM change_items WHERE old_blob_id IS NOT NULL
         UNION
         SELECT new_blob_id AS blob_id, change_id FROM change_items`,
      )
      .all() as { blob_id: string; change_id: string }[];
  }

  /** 只用于测试与本地人工清理：终态修改集会被触发器拦住，这是设计如此。 */
  deleteNonTerminal(changeId: string): void {
    this.db.prepare('DELETE FROM changesets WHERE id = ?').run(changeId);
  }
}

// ---------------------------------------------------------------------------
// 操作与逐文件结果
// ---------------------------------------------------------------------------

export interface OperationRecord {
  readonly id: string;
  readonly change_id: string;
  readonly state: ChangeSetState;
  readonly idempotency_key: string | null;
  readonly worker_instance: string | null;
  readonly recovered: boolean;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly created_at: string;
}

interface OperationRow extends Omit<OperationRecord, 'recovered'> {
  recovered: number;
}

function toOperation(row: OperationRow): OperationRecord {
  return { ...row, recovered: bool(row.recovered) };
}

/**
 * 创建操作的结果。
 *
 * 「已存在」是正常返回值而不是异常：调用方换了幂等键重试时**必须**拿到
 * 同一个操作，而不是报错，也不是新建第二个。
 */
export type OperationCreateOutcome =
  | { readonly kind: 'created'; readonly operation: OperationRecord }
  | { readonly kind: 'exists'; readonly operation: OperationRecord };

export class OperationsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  create(input: {
    readonly id: string;
    readonly change_id: string;
    readonly idempotency_key?: string | null;
    readonly worker_instance?: string | null;
    readonly recovered?: boolean;
  }): OperationCreateOutcome {
    const now = this.clock();
    try {
      this.db
        .prepare(
          `INSERT INTO operations
             (id, change_id, state, idempotency_key, worker_instance, recovered, started_at, created_at)
           VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.change_id,
          input.idempotency_key ?? null,
          input.worker_instance ?? null,
          toBoolInt(input.recovered ?? false),
          now,
          now,
        );
    } catch (cause) {
      if (!isUniqueViolation(cause)) throw cause;
      return { kind: 'exists', operation: this.requireByChangeId(input.change_id) };
    }
    return { kind: 'created', operation: this.requireById(input.id) };
  }

  findById(id: string): OperationRecord | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as
      | OperationRow
      | undefined;
    return row ? toOperation(row) : null;
  }

  requireById(id: string): OperationRecord {
    return required(this.findById(id) ?? undefined, `operations.id=${id}`);
  }

  findByChangeId(changeId: string): OperationRecord | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE change_id = ?').get(changeId) as
      | OperationRow
      | undefined;
    return row ? toOperation(row) : null;
  }

  requireByChangeId(changeId: string): OperationRecord {
    return required(this.findByChangeId(changeId) ?? undefined, `operations.change_id=${changeId}`);
  }

  transition(
    operationId: string,
    from: readonly ChangeSetState[],
    to: ChangeSetState,
    options: { readonly recovered?: boolean; readonly finished?: boolean } = {},
  ): OperationRecord {
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE operations
            SET state = ?,
                recovered = COALESCE(?, recovered),
                finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
          WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(
        to,
        options.recovered === undefined ? null : toBoolInt(options.recovered),
        toBoolInt(options.finished ?? false),
        this.clock(),
        operationId,
        ...from,
      );

    if (result.changes === 0) {
      const current = this.findById(operationId);
      if (!current) throw new BridgeError('CHANGE_NOT_FOUND', '操作不存在。');
      throw new BridgeError('CHANGE_STATE_INVALID', '操作当前状态不允许该流转。', {
        current_state: current.state,
        allowed_from: from.join(','),
      });
    }
    return this.requireById(operationId);
  }

  /** 启动时发现的上一个进程遗留的操作：一律标为需要恢复，绝不自动重放。 */
  listUnfinished(): OperationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM operations
          WHERE state IN ('QUEUED','VALIDATING','APPLYING')
          ORDER BY created_at ASC`,
      )
      .all() as OperationRow[];
    return rows.map(toOperation);
  }

  /**
   * 按状态取操作（LWB-024）。
   *
   * 与上面的 `listUnfinished` 差在**问题不同**：那个问的是「上一个进程
   * 留下了什么」，因此只认三个执行状态 —— 一个 `RECOVERY_REQUIRED` 的操作
   * 不属于「遗留」，它已经被人接手了。保留策略问的是另一个问题：
   * 「这些字节还有人在等吗」—— 而等待恢复的操作恰恰是最需要原始字节的那个。
   *
   * 两个问题混用一个查询，表现是「待恢复的快照被回收了」，而那一刻
   * 回滚取不到原始字节。因此宁可多一个入口，也不让一个方法回答两件事。
   *
   * 与 `ChangesRepo.listByStates` 同样刻意**没有** `limit`：调用方的正确性
   * 依赖「一条不漏」。
   */
  listByStates(states: readonly OperationState[]): OperationRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM operations WHERE state IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
      )
      .all(...states) as OperationRow[];
    return rows.map(toOperation);
  }

  /**
   * 历史页使用的有限最近列表。与 `listUnfinished` 不同，这里包含终态；
   * 这是展示数据库真实历史，不是启动恢复的输入，因此有界 limit 是合适的。
   */
  listRecent(limit = 100): OperationRecord[] {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const rows = this.db
      .prepare('SELECT * FROM operations ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(bounded) as OperationRow[];
    return rows.map(toOperation);
  }

  /**
   * 某个工作区里**等待人工恢复**的操作（LWB-030）。
   *
   * 它问的是「这块地现在有没有说不清的字节」，因此认的是 `RECOVERY_REQUIRED`
   * 一个状态 —— **不是**「有没有操作在跑」。这一点值得写下来，因为
   * `NOT IN (终态)` 那个更省事的写法会把 `QUEUED` / `VALIDATING` / `APPLYING`
   * 也收进来，而它们的意思是「正在写」，不是「写坏了」。混进来之后，
   * 一次正常进行中的写入会让整个工作区在工具面上显示成「等待人工恢复」，
   * 于是这个标志从「有事要你处理」退化成「有活在干」。二者的差别正是
   * 操作者会不会去看它。
   *
   * 崩溃遗留的操作要到这一步**之前**才变成 `RECOVERY_REQUIRED`
   * （启动恢复的第一步，见 `@lwb/recovery` 的 `sweepStartup`），
   * 而装配根保证那一步在工具面建立之前跑完 —— 因此窗口是关着的，
   * 不是漏着的。
   */
  listRecoveryRequiredByWorkspace(workspaceId: string): OperationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT o.* FROM operations o
           JOIN changesets c ON c.id = o.change_id
          WHERE c.workspace_id = ? AND o.state = 'RECOVERY_REQUIRED'
          ORDER BY o.created_at ASC, o.id ASC`,
      )
      .all(workspaceId) as OperationRow[];
    return rows.map(toOperation);
  }

  setItemResult(input: {
    readonly operation_id: string;
    readonly item_id: string;
    readonly state: 'PENDING' | 'VERIFIED' | 'CONFLICT' | 'FAILED' | 'RECOVERED_TARGET' | 'RECOVERED_ORIGINAL' | 'UNKNOWN';
    readonly before_sha256?: string | null;
    readonly after_sha256?: string | null;
    readonly error_code?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO operation_item_results
           (operation_id, item_id, state, before_sha256, after_sha256, error_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(operation_id, item_id) DO UPDATE SET
           state         = excluded.state,
           before_sha256 = excluded.before_sha256,
           after_sha256  = excluded.after_sha256,
           error_code    = excluded.error_code,
           updated_at    = excluded.updated_at`,
      )
      .run(
        input.operation_id,
        input.item_id,
        input.state,
        input.before_sha256 ?? null,
        input.after_sha256 ?? null,
        input.error_code ?? null,
        this.clock(),
      );
  }

  /**
   * 一次执行的逐条目回执。
   *
   * `updated_at`（LWB-030 起一并读出）是**这条回执被写下的时刻**，
   * 由本进程的时钟给出。它与 §8.4 那句「不编造执行归属或时间」不冲突：
   * 那句话禁止的是把「文件是什么时候变成这样的」当成已知，而这里记的是
   * 「我们什么时候记的这笔账」—— 一件我们确实拥有的、可以拿日志对质的
   * 事实。恢复记录里没有它的话，「这些回执是刚刚判的还是三天前判的」
   * 就无法回答，而那是操作者读记录时的第一个问题。
   */
  itemResults(operationId: string): {
    item_id: string;
    state: string;
    before_sha256: string | null;
    after_sha256: string | null;
    error_code: string | null;
    updated_at: string;
  }[] {
    return this.db
      .prepare(
        `SELECT item_id, state, before_sha256, after_sha256, error_code, updated_at
           FROM operation_item_results WHERE operation_id = ? ORDER BY id ASC`,
      )
      .all(operationId) as {
      item_id: string;
      state: string;
      before_sha256: string | null;
      after_sha256: string | null;
      error_code: string | null;
      updated_at: string;
    }[];
  }
}

// ---------------------------------------------------------------------------
// 写执行槽（LWB-026）
// ---------------------------------------------------------------------------

/**
 * 一块「正在被写」的物理地的记录。主键是 `(volume_id, root_file_id)`。
 *
 * 为什么要落库、为什么主键是身份而不是 `workspace_id`，见迁移 v6 的说明。
 * 这里只重复一句**本类型刻意没有的东西**：它没有 `is_locked: boolean`。
 * 「有没有人在写」由 `blocked_at`、`expires_at` 与持有者进程的存活三件事
 * 共同回答，压成一个布尔值会让「过期了但持有者还活着」这个**必须区别对待**
 * 的情形无处表达 —— 而那正是验收标准 3 的全部内容。
 */
export interface WorkspaceWriteSlotRecord {
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly workspace_id: string;
  readonly operation_id: string;
  readonly executor_id: string;
  readonly fencing_token: number;
  readonly holder_pid: number;
  readonly holder_started_at: string | null;
  readonly acquired_at: string;
  readonly heartbeat_at: string;
  readonly expires_at: string;
  readonly blocked_at: string | null;
  readonly blocked_reason: string | null;
}

type WorkspaceWriteSlotRow = WorkspaceWriteSlotRecord;

function toWriteSlot(row: WorkspaceWriteSlotRow): WorkspaceWriteSlotRecord {
  return { ...row };
}

export interface SlotClaimInput {
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly workspace_id: string;
  readonly operation_id: string;
  readonly executor_id: string;
  readonly fencing_token: number;
  readonly holder_pid: number;
  readonly holder_started_at: string | null;
  readonly expires_at: string;
}

/**
 * 写执行槽仓储。
 *
 * ## 它**不做**判定
 *
 * 「这块地能不能接管」是一个需要问系统（持有者进程还在不在）的决定，
 * 而仓储层不接触进程（`packages/persistence/` 在 FsGuard 的允许清单里，
 * 但那是为了文件系统，不是为了进程）。因此本仓储提供的是**动作**：
 * 落一条槽、续一次心跳、放掉、阻断。判定在 `@lwb/executor` 里，
 * 而它必须在**一个立即事务**里完成「读槽 → 判定 → 写槽」——
 * `Repositories.transaction` 就是那个事务，`BEGIN IMMEDIATE` 让
 * 两个并发认领者不可能同时读到「没人在写」。
 *
 * ## 条件写不返回布尔值，而是返回**当前那一行**
 *
 * `heartbeat` 与 `release` 都会因为「我已经不是持有者了」而失败
 * （被接管、被阻断、被别人放掉）。返回 `null` 与返回旧行是两件不同的事：
 * 前者意味着「你的令牌已经不作数了，必须停下来」，后者意味着操作成功。
 * 用一个 `boolean` 会丢掉「现在是谁拿着」这个排障必需的信息。
 */
export class WorkspaceWriteSlotsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  find(volumeId: string, rootFileId: string): WorkspaceWriteSlotRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workspace_write_slots WHERE volume_id = ? AND root_file_id = ?')
      .get(volumeId, rootFileId) as WorkspaceWriteSlotRow | undefined;
    return row ? toWriteSlot(row) : null;
  }

  findByOperation(operationId: string): WorkspaceWriteSlotRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workspace_write_slots WHERE operation_id = ?')
      .get(operationId) as WorkspaceWriteSlotRow | undefined;
    return row ? toWriteSlot(row) : null;
  }

  /** 全部占用地。启动恢复与排障用；**没有** `limit`，理由同 `listByStates`。 */
  list(): WorkspaceWriteSlotRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_write_slots ORDER BY acquired_at ASC, workspace_id ASC')
      .all() as WorkspaceWriteSlotRow[];
    return rows.map(toWriteSlot);
  }

  /**
   * 占用一块地。
   *
   * 只有两种情形可以调用它，且都由调用方在**同一个事务里**判定过：
   * 该身份上**没有行**（`kind: 'created'`），或该身份上那一行是
   * **可接管的**（`kind: 'taken_over'`，栅栏令牌必须严格更大）。
   *
   * 因此这里用 `INSERT … ON CONFLICT DO UPDATE … WHERE` 把「可接管」
   * 这件事写成 **SQL 里的条件**，而不是靠调用方记得先 `find` 一下：
   * 触发器式的保证比纪律可靠。条件是 `blocked_at IS NULL`
   * ——被阻断的行**永远**不会被这条语句改写。
   */
  claim(input: SlotClaimInput): WorkspaceWriteSlotRecord {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO workspace_write_slots
           (volume_id, root_file_id, workspace_id, operation_id, executor_id,
            fencing_token, holder_pid, holder_started_at, acquired_at,
            heartbeat_at, expires_at, blocked_at, blocked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(volume_id, root_file_id) DO UPDATE SET
           workspace_id      = excluded.workspace_id,
           operation_id      = excluded.operation_id,
           executor_id       = excluded.executor_id,
           fencing_token     = excluded.fencing_token,
           holder_pid        = excluded.holder_pid,
           holder_started_at = excluded.holder_started_at,
           acquired_at       = excluded.acquired_at,
           heartbeat_at      = excluded.heartbeat_at,
           expires_at        = excluded.expires_at
         WHERE workspace_write_slots.blocked_at IS NULL
           AND workspace_write_slots.fencing_token < excluded.fencing_token`,
      )
      .run(
        input.volume_id,
        input.root_file_id,
        input.workspace_id,
        input.operation_id,
        input.executor_id,
        input.fencing_token,
        input.holder_pid,
        input.holder_started_at,
        now,
        now,
        input.expires_at,
      );

    const row = this.find(input.volume_id, input.root_file_id);
    // 条件不成立时（被阻断、或被更大的令牌抢了先）上面那条语句**什么都不做**，
    // 于是这里读到的不是我们写的那一行。把它报出来，而不是返回一个
    // 看起来成功的旧行 —— 静默返回旧行会让调用方以为自己拿到了租约。
    if (row === null || row.operation_id !== input.operation_id || row.fencing_token !== input.fencing_token) {
      throw new BridgeError('WORKSPACE_BUSY', '写执行槽未按预期占用：该身份已被阻断或被更大的栅栏令牌接管。', {
        reason: 'SLOT_CLAIM_REJECTED',
        volume_id: input.volume_id,
        root_file_id: input.root_file_id,
        observed_operation: row?.operation_id ?? null,
        observed_blocked: row?.blocked_at ?? null,
      });
    }
    return row;
  }

  /** 持有者放掉自己那块地。返回 `null` 表示「你已不是持有者」。 */
  release(input: { readonly operation_id: string; readonly executor_id: string }): WorkspaceWriteSlotRecord | null {
    const before = this.findByOperation(input.operation_id);
    if (before === null) return null;
    const result = this.db
      .prepare('DELETE FROM workspace_write_slots WHERE operation_id = ? AND executor_id = ?')
      .run(input.operation_id, input.executor_id);
    if (result.changes === 0) return null;
    return before;
  }

  /**
   * 续约。
   *
   * 条件里带 `operation_id` **与** `executor_id`：令牌相同但 executor 不同
   * 意味着这块地已经换了主人（同一个 executor 只会续自己那一次），
   * 而让一个被取代的执行器续约成功，等于给它继续写下去的许可。
   */
  heartbeat(input: {
    readonly operation_id: string;
    readonly executor_id: string;
    readonly fencing_token: number;
    readonly expires_at: string;
  }): WorkspaceWriteSlotRecord | null {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE workspace_write_slots
            SET heartbeat_at = ?, expires_at = ?
          WHERE operation_id = ? AND executor_id = ? AND fencing_token = ?
            AND blocked_at IS NULL`,
      )
      .run(now, input.expires_at, input.operation_id, input.executor_id, input.fencing_token);

    const row = this.findByOperation(input.operation_id);
    // 被阻断的行**不续约**，而且要把这一点说清楚：续约的含义是「我还在写」，
    // 而一条阻断记录的含义是「这里必须停下来」。准许续约等于让一个已经
    // 被判定为不该继续的执行器，靠继续心跳把自己留在地里。
    //
    // 条件写在 WHERE 里而不是读出来再判断：那一步判断与 UPDATE 之间的空隙
    // 正是阻断能插进来的地方。返回 `null`（而不是那一行）让调用方
    // **只能**把它读成「你已经不是持有者了」。
    if (row === null || row.blocked_at !== null) return null;
    return row;
  }

  /**
   * 阻断一块地（LWB-026 步骤 3）。
   *
   * **不清空持有者信息**：排障要问的第一个问题是「是谁留下的」，
   * 而那一刻恰好是唯一会用到这些字段的时候。因此阻断是「加两个字段」，
   * 不是「删一行再插一行」。
   *
   * 阻断是**幂等**的：第二次阻断不会把第一次的时刻与原因覆盖掉 ——
   * 第一个原因才是「这里为什么会不通」的答案。
   */
  /**
   * 解除阻断（LWB-026）。
   *
   * **只清两个字段，不删行。** 删行会把栅栏令牌一起丢掉，于是下一次占用
   * 从 1 重新开始 —— 而「令牌只增不减」正是「一个已经失去资格的执行器
   * 写不进去」这件事的**全部**依据。留下行、只清标记，接管路径就会
   * 照常把令牌加一（`decideSlot` 对已终结的上一操作返回 `claim`）。
   *
   * 覆盖原因还是保留？**覆盖并清空**。`block` 的幂等是「为什么这里不通」
   * 那个问题的答案；而一旦解除，「为什么当初不通」已经由审计与操作日志
   * 回答过了，继续留着会让下一次阻断读到一个陈年原因。
   *
   * 调用方（执行协调器的 `clearBlockade`）负责判定**此刻**该不该解除 ——
   * 本仓储只提供动作，不做判定，理由同 `claim`。
   *
   * @returns 解除后的行；该身份上没有行时为 `null`。
   */
  unblock(input: {
    readonly volume_id: string;
    readonly root_file_id: string;
  }): WorkspaceWriteSlotRecord | null {
    this.db
      .prepare(
        `UPDATE workspace_write_slots
            SET blocked_at = NULL, blocked_reason = NULL
          WHERE volume_id = ? AND root_file_id = ?`,
      )
      .run(input.volume_id, input.root_file_id);
    return this.find(input.volume_id, input.root_file_id);
  }

  block(input: {
    readonly volume_id: string;
    readonly root_file_id: string;
    readonly reason: string;
  }): WorkspaceWriteSlotRecord | null {
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE workspace_write_slots
            SET blocked_at = COALESCE(blocked_at, ?),
                blocked_reason = COALESCE(blocked_reason, ?)
          WHERE volume_id = ? AND root_file_id = ?`,
      )
      .run(now, input.reason, input.volume_id, input.root_file_id);
    return this.find(input.volume_id, input.root_file_id);
  }
}

// ---------------------------------------------------------------------------
// 全局暂停
// ---------------------------------------------------------------------------

/**
 * 全局暂停的当前状态。**没有行**与**暂停中**是两件事，见 `current()`。
 *
 * `updated_at` 为 `null` 的唯一情形是「这台机器从来没有被暂停过」——
 * 也就是表里没有行。一次恢复会留下它，因此「暂停过又恢复了」与
 * 「从没暂停过」在读出来的值上**不同**，而界面需要能说出这个差别。
 */
export interface ServicePauseRecord {
  readonly paused: boolean;
  readonly paused_at: string | null;
  readonly updated_at: string | null;
}

/** 没有行时的回答。**冻结成常量**，免得两处各造一份「看起来一样」的空值。 */
const NEVER_PAUSED: ServicePauseRecord = {
  paused: false,
  paused_at: null,
  updated_at: null,
};

/**
 * `service_pause` 单行表（LWB-034）。
 *
 * ## 为什么这个仓储**不抛**「没有行」
 *
 * 本工程其余仓储在找不到行时返回 `null`，让调用方决定那是什么意思。
 * 这一张不一样：它有一个**明确**的缺席含义（「从来没有暂停过」），
 * 而且那个含义是安全的 —— 一个没有暂停记录的服务，就是不处于暂停状态。
 *
 * 把它做成 `null` 会让每一个调用点各自处理一次「没有行」，
 * 而其中必有一处会把它读成「我不知道」并因此拒绝对外服务 ——
 * 一个「读不出暂停状态就不许读文件」的实现看起来更保守，
 * 实际上是把一次查询失败升级成整机不可用，而它保护的正是这一格里
 * 最不需要保护的东西（另见 `guard.ts` 对同一取舍的相反选择：
 * 那里读不出**授权**就真的不能放行，因为它是安全性判据）。
 *
 * ## 两个动作都是**幂等**的
 *
 * 重复暂停不报错（保持第一次的 `paused_at`），重复恢复也不报错。
 * 理由是这两个动作的调用方是**人**：双击、网络重发、控制台重试都会产生
 * 第二次调用，而一次「你已经在暂停中了」的错误会让操作者以为没生效，
 * 然后去点第三次。它们各自仍然写一行审计 —— 那是「谁在什么时候按过」，
 * 与「状态变没变」是两个问题。
 */
export class ServicePauseRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 当前状态。**一次主键查。**
   *
   * 工具面的每一次调用都要读它（全局暂停是工具调用第 1 步的判据），
   * 因此它被写成一条单行主键查而不是一次聚合查询 —— 这条路径上的
   * 每一个字节都乘以调用次数。
   */
  current(): ServicePauseRecord {
    const row = this.db.prepare('SELECT * FROM service_pause WHERE id = 1').get() as
      | { paused: number; paused_at: string | null; updated_at: string }
      | undefined;
    if (row === undefined) return NEVER_PAUSED;
    return {
      paused: bool(row.paused),
      paused_at: row.paused_at,
      updated_at: row.updated_at,
    };
  }

  /** 只有这一个问题：现在停着吗。工具面每一步都问它。 */
  isPaused(): boolean {
    const row = this.db.prepare('SELECT paused FROM service_pause WHERE id = 1').get() as
      | { paused: number }
      | undefined;
    return row === undefined ? false : bool(row.paused);
  }

  /**
   * 进入暂停。已经在暂停中时**保持**原来的起始时刻。
   *
   * `COALESCE` 而不是无条件覆盖：第二次调用多半是重试，而把起始时刻
   * 推后会让「停多久了」这个读数变成「最后一次点它是在多久之前」——
   * 排障时问的恰恰是前者。
   */
  engage(): ServicePauseRecord {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO service_pause (id, paused, paused_at, updated_at)
         VALUES (1, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           paused     = 1,
           paused_at  = COALESCE(service_pause.paused_at, excluded.paused_at),
           updated_at = excluded.updated_at`,
      )
      .run(now, now);
    return this.current();
  }

  /**
   * 退出暂停。**`paused_at` 一起清掉**，因为它描述的是「当前这一次暂停」，
   * 而它已经结束了；上一次暂停的起始时刻留在审计里。
   *
   * 那条 CHECK 让「忘了清」这件事在数据库层就写不进去 —— 见迁移 v8 的说明。
   */
  release(): ServicePauseRecord {
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO service_pause (id, paused, paused_at, updated_at)
         VALUES (1, 0, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           paused     = 0,
           paused_at  = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(now);
    return this.current();
  }
}

// ---------------------------------------------------------------------------
// 追加日志
// ---------------------------------------------------------------------------

export interface JournalAppendInput {
  readonly operation_id: string;
  readonly item_id?: string | null;
  readonly stage: string;
  readonly observed_file_id?: string | null;
  readonly observed_sha256?: string | null;
  readonly target_sha256?: string | null;
  readonly error_code?: string | null;
  readonly detail?: string | null;
}

export class JournalRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 追加一条日志。
   *
   * 序号在写入时按 `MAX(seq)+1` 取，并用 UNIQUE(operation_id, seq) 兜底：
   * 并发追加会撞唯一索引而失败，而不是静默产生乱序日志——
   * 恢复流程依赖日志的**顺序**来表达「先意图、后结果」。
   */
  append(input: JournalAppendInput): number {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM journal_entries WHERE operation_id = ?')
      .get(input.operation_id) as { seq: number };

    this.db
      .prepare(
        `INSERT INTO journal_entries
           (operation_id, seq, item_id, stage, observed_file_id, observed_sha256, target_sha256, error_code, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.operation_id,
        next.seq,
        input.item_id ?? null,
        input.stage,
        input.observed_file_id ?? null,
        input.observed_sha256 ?? null,
        input.target_sha256 ?? null,
        input.error_code ?? null,
        input.detail ?? null,
        this.clock(),
      );
    return next.seq;
  }

  list(operationId: string): {
    seq: number;
    item_id: string | null;
    stage: string;
    observed_file_id: string | null;
    observed_sha256: string | null;
    target_sha256: string | null;
    error_code: string | null;
    detail: string | null;
    created_at: string;
  }[] {
    return this.db
      .prepare('SELECT * FROM journal_entries WHERE operation_id = ? ORDER BY seq ASC')
      .all(operationId) as {
      seq: number;
      item_id: string | null;
      stage: string;
      observed_file_id: string | null;
      observed_sha256: string | null;
      target_sha256: string | null;
      error_code: string | null;
      detail: string | null;
      created_at: string;
    }[];
  }
}

// ---------------------------------------------------------------------------
// 批准
// ---------------------------------------------------------------------------

export interface ApprovalRecord {
  readonly id: string;
  readonly change_id: string;
  readonly digest: string;
  /**
   * 本地审批身份。V1 没有账号体系，因此它就是**作出决定的控制台会话**
   * （`console:<session_id>`）—— 「哪个本机会话点了批准」是这个问题在本机
   * 单用户前提下能被回答的全部。`actor_kind` 另行钉死它是人而不是模型。
   */
  readonly actor: string;
  readonly actor_kind: 'local_operator';
  readonly expires_at: string;
  readonly state: ApprovalState;
  readonly consumed_by: string | null;
  readonly created_at: string;
  readonly consumed_at: string | null;
  /**
   * 批准所绑定的资源根代次与策略版本（迁移 v5）。
   *
   * **是抄本**：真值在 `changesets` 里，且已被 `digest` 覆盖。抄错写不进来
   * （`approvals_binding_matches_change` 触发器），来源不可变（内容触发器），
   * 因此不存在漂移。存在它们的理由是可读与可查 —— 见迁移 v5 的说明。
   */
  readonly root_generation: number;
  readonly policy_version: number;
}

/** 一条批准记录，连带它绑定的修改集**当前**的状态。 */
export interface ApprovalWithChange {
  readonly approval: ApprovalRecord;
  readonly change_state: ChangeSetState;
}

export class ApprovalsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 记录一次本地批准。
   *
   * 摘要必须与修改集当前的 digest 一致：不一致说明批准的对象已经不是
   * 待执行的那个对象，此时写入会把「批准 A、执行 B」变成可能。
   * 同一修改集已有有效批准时，唯一索引会拒绝第二条（而非覆盖）。
   *
   * ## 摘要比较写在 WHERE 里，不是先读后比
   *
   * 写法是 `INSERT … SELECT … FROM changesets WHERE id = ? AND digest = ?`：
   * 存在性与摘要比对**与插入同属一条语句**。先 SELECT 再 INSERT 也能得到
   * 正确的结论，但那是两次读之间的一个窗口 —— 而 `changesets` 不可变，
   * 窗口今天关着，明天未必。把条件放进 WHERE 让它不依赖那个不变量。
   *
   * 资源根代次与策略版本由**同一条语句**从 `changesets` 抄过来，
   * 而不是由调用方传进来：传进来的值只可能与真值不一致，
   * 而一致的时候它也是多余的。
   */
  create(input: {
    readonly id: string;
    readonly change_id: string;
    readonly digest: string;
    readonly actor: string;
    readonly expires_at: string;
  }): ApprovalRecord {
    const now = this.clock();

    let inserted: number;
    try {
      inserted = this.db
        .prepare(
          `INSERT INTO approvals
             (id, change_id, digest, actor, actor_kind, expires_at, state,
              root_generation, policy_version, created_at)
           SELECT ?, ?, digest, ?, 'local_operator', ?, 'ACTIVE',
                  root_generation, policy_version, ?
             FROM changesets WHERE id = ? AND digest = ?`,
        )
        .run(
          input.id,
          input.change_id,
          input.actor,
          input.expires_at,
          now,
          input.change_id,
          input.digest,
        ).changes;
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new BridgeError('CHANGE_STATE_INVALID', '该修改集已存在有效批准。');
      }
      throw cause;
    }

    if (inserted === 0) {
      // 两种原因共用一个 0 行结果，因此这里要分辨它们：把「修改集不存在」
      // 报成「摘要不符」会让排障的人去查摘要，而真正的问题是没有这条记录。
      const change = this.db.prepare('SELECT digest FROM changesets WHERE id = ?').get(input.change_id) as
        | { digest: string }
        | undefined;
      if (!change) throw new BridgeError('CHANGE_NOT_FOUND', '修改集不存在。');
      throw new BridgeError('CHANGE_STATE_INVALID', '批准摘要与修改集摘要不一致，已拒绝写入。');
    }

    return this.requireById(input.id);
  }

  findById(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRecord
      | undefined;
    return row ?? null;
  }

  requireById(id: string): ApprovalRecord {
    return required(this.findById(id) ?? undefined, `approvals.id=${id}`);
  }

  findActive(changeId: string): ApprovalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE change_id = ? AND state = 'ACTIVE'")
      .get(changeId) as ApprovalRecord | undefined;
    return row ?? null;
  }

  /** 某个修改集上的全部批准记录（含已消费/已撤销/已过期），最新的在前。 */
  listForChange(changeId: string): ApprovalRecord[] {
    return this.db
      .prepare('SELECT * FROM approvals WHERE change_id = ? ORDER BY created_at DESC, id DESC')
      .all(changeId) as ApprovalRecord[];
  }

  /**
   * 本机最近给出的批准，最新在前。**连带回报修改集当前的状态**。
   *
   * 为什么要连修改集一起读：一条 `ACTIVE` 的批准与一个已进入终态的修改集
   * 放在一起是排障时最先要看到的组合（「批准还在，但目标已经失效了」），
   * 而分两次查意味着这个组合要靠调用方自己拼 —— 那就多了一处可以拼错的地方。
   *
   * 这里**不**做状态归一化（不调用 `expireDue`）：那是一次写。只读接口
   * 触发的写会让「为什么只读接口也要一次性 nonce」这个问题没有答案。
   * 有效状态由读取方按 `expires_at` 投影，见 `@lwb/approvals` 的
   * `effectiveApprovalState`。
   */
  listRecent(limit = 50): ApprovalWithChange[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare(
        `SELECT a.*, c.state AS change_state
           FROM approvals a JOIN changesets c ON c.id = a.change_id
          ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
      )
      .all(bounded) as (ApprovalRecord & { change_state: ChangeSetState })[];
    return rows.map((row) => {
      const { change_state, ...approval } = row;
      return { approval, change_state };
    });
  }

  /**
   * 消费批准。
   *
   * `now` 与 `digest` 都参与 WHERE：
   *  - 过期批准不能被执行（时间在写入时判定，不是先读后判）；
   *  - 摘要不符的批准不能被执行。
   * 因此「批准过期后仍被执行」这个竞态在数据库层就被排除了。
   */
  consume(input: {
    readonly approval_id: string;
    readonly digest: string;
    readonly operation_id: string;
    readonly now: string;
  }): ApprovalRecord {
    const result = this.db
      .prepare(
        `UPDATE approvals
            SET state = 'CONSUMED', consumed_by = ?, consumed_at = ?
          WHERE id = ? AND state = 'ACTIVE' AND digest = ? AND expires_at > ?`,
      )
      .run(input.operation_id, input.now, input.approval_id, input.digest, input.now);

    if (result.changes === 0) {
      const current = this.findById(input.approval_id);
      if (!current) throw new BridgeError('APPROVAL_REQUIRED', '批准不存在。');
      if (current.state !== 'ACTIVE') {
        throw new BridgeError('APPROVAL_EXPIRED', '批准已被使用或撤销。');
      }
      throw new BridgeError('APPROVAL_EXPIRED', '批准已过期或与当前摘要不符。');
    }
    return this.requireById(input.approval_id);
  }

  /** 撤销仍未使用的批准。已消费的批准不可能被撤销（状态机不允许）。 */
  revoke(approvalId: string): ApprovalRecord {
    const result = this.db
      .prepare("UPDATE approvals SET state = 'REVOKED' WHERE id = ? AND state = 'ACTIVE'")
      .run(approvalId);
    if (result.changes === 0) {
      throw new BridgeError('APPROVAL_EXPIRED', '只有有效批准才能撤销。');
    }
    return this.requireById(approvalId);
  }

  /**
   * 把**一条**已到期的 ACTIVE 批准标记为 `EXPIRED`（LWB-024）。
   *
   * 与 `revoke` 成对，区分的是两件对操作者**不同**的事：批准是自己到期的，
   * 还是被人撤销的。没有这个入口时，唯一能表达「这条批准不再有效」的动作
   * 是 `revoke`，于是每一次到期都会被记成一次撤销 —— 排障的人会去查
   * 「谁撤销的」，而答案是「没有人」。
   *
   * 条件写在 WHERE 里：未到期或已离开 ACTIVE 的行不会被改，调用方拿到异常。
   */
  expire(approvalId: string, now: string): ApprovalRecord {
    const result = this.db
      .prepare("UPDATE approvals SET state = 'EXPIRED' WHERE id = ? AND state = 'ACTIVE' AND expires_at <= ?")
      .run(approvalId, now);
    if (result.changes === 0) {
      const current = this.findById(approvalId);
      if (!current) throw new BridgeError('APPROVAL_REQUIRED', '批准不存在。');
      throw new BridgeError(
        'APPROVAL_EXPIRED',
        current.state === 'ACTIVE' ? '该批准尚未到期。' : '只有有效批准才能标记为已过期。',
      );
    }
    return this.requireById(approvalId);
  }

  /** 把已过期的 ACTIVE 批准标记为 EXPIRED；返回处理条数。 */
  expireDue(now: string): number {
    return this.db
      .prepare("UPDATE approvals SET state = 'EXPIRED' WHERE state = 'ACTIVE' AND expires_at <= ?")
      .run(now).changes;
  }
}

// ---------------------------------------------------------------------------
// 本地恢复授权（LWB-030）
// ---------------------------------------------------------------------------

/**
 * 恢复可以请求的写入动作。**只有一条**，理由见迁移 v7 的说明：
 * 另一个方向（把目标字节补写进没写到的文件）就是重放旧批准。
 */
export type RecoveryDecision = (typeof FROZEN_RECOVERY_DECISIONS)[number];

export type RecoveryAuthorizationState = 'ACTIVE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';

export interface RecoveryAuthorizationRecord {
  readonly id: string;
  readonly operation_id: string;
  readonly workspace_id: string;
  /** 授权所绑定的**物理**工作区身份（不是路径）。 */
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly decision: RecoveryDecision;
  /**
   * 恢复计划摘要 —— 由**刚刚观测到的磁盘状态**算出，见 `@lwb/recovery` 的
   * `planDigestOf`。它与 `approvals.digest` 的区别是这一句：
   * **磁盘一变，摘要就变，这条授权立刻失效。**
   */
  readonly digest: string;
  readonly actor: string;
  readonly actor_kind: 'local_operator';
  readonly expires_at: string;
  readonly state: RecoveryAuthorizationState;
  readonly consumed_at: string | null;
  readonly created_at: string;
}

export interface CreateRecoveryAuthorizationInput {
  readonly id: string;
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly volume_id: string;
  readonly root_file_id: string;
  readonly decision: RecoveryDecision;
  readonly digest: string;
  readonly actor: string;
  readonly expires_at: string;
}

/**
 * 恢复授权仓储。
 *
 * 与 `ApprovalsRepo` 的形状刻意相同（`create` 条件插入 / `consume`
 * 带条件 UPDATE / `revoke` / `expireDue`），因为两者要保证的性质是同一组：
 * 一次性、有期限、绑定唯一摘要。差别只在**摘要绑定的是什么** ——
 * 那边是修改集摘要，这边是恢复计划摘要。
 */
export class RecoveryAuthorizationsRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 签发一条恢复授权。
   *
   * 与 `ApprovalsRepo.create` 同样把存在性与不等式放进**同一条语句**：
   * `INSERT … SELECT … FROM operations WHERE id = ? AND workspace_id = ?`。
   * 先读后写也能得到正确结论，但那多了一个窗口 —— 而这里要核的是
   * 「这个操作确实属于这个工作区」，一件不该靠两次读之间没人动过才成立的事。
   */
  create(input: CreateRecoveryAuthorizationInput): RecoveryAuthorizationRecord {
    const now = this.clock();
    let inserted: number;
    try {
      inserted = this.db
        .prepare(
          `INSERT INTO recovery_authorizations
             (id, operation_id, workspace_id, volume_id, root_file_id,
              decision, digest, actor, actor_kind, expires_at, state, consumed_at, created_at)
           SELECT ?, o.id, c.workspace_id, ?, ?, ?, ?, ?, 'local_operator', ?, 'ACTIVE', NULL, ?
             FROM operations o
             JOIN changesets c ON c.id = o.change_id
            WHERE o.id = ? AND c.workspace_id = ?`,
        )
        .run(
          input.id,
          input.volume_id,
          input.root_file_id,
          input.decision,
          input.digest,
          input.actor,
          input.expires_at,
          now,
          input.operation_id,
          input.workspace_id,
        ).changes;
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new BridgeError('CHANGE_STATE_INVALID', '该操作已存在有效恢复授权。');
      }
      throw cause;
    }

    if (inserted === 0) {
      throw new BridgeError('CHANGE_NOT_FOUND', '恢复授权指向的操作不存在，或它不属于该工作区。');
    }
    return this.requireById(input.id);
  }

  findById(id: string): RecoveryAuthorizationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM recovery_authorizations WHERE id = ?')
      .get(id) as RecoveryAuthorizationRecord | undefined;
    return row ?? null;
  }

  requireById(id: string): RecoveryAuthorizationRecord {
    return required(this.findById(id) ?? undefined, `recovery_authorizations.id=${id}`);
  }

  findActive(operationId: string): RecoveryAuthorizationRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM recovery_authorizations WHERE operation_id = ? AND state = 'ACTIVE' ORDER BY created_at DESC, id DESC",
      )
      .get(operationId) as RecoveryAuthorizationRecord | undefined;
    return row ?? null;
  }

  /** 某个操作上的全部授权记录（含已消费/已撤销/已过期），最新的在前。 */
  listForOperation(operationId: string): RecoveryAuthorizationRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM recovery_authorizations WHERE operation_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(operationId) as RecoveryAuthorizationRecord[];
  }

  listRecent(limit = 50): RecoveryAuthorizationRecord[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    return this.db
      .prepare(
        'SELECT * FROM recovery_authorizations ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(bounded) as RecoveryAuthorizationRecord[];
  }

  /**
   * 消费授权。**三条条件同时进 WHERE**：状态、摘要、有效期。
   *
   * 与 `ApprovalsRepo.consume` 同一句道理：过期授权不得被执行、
   * 摘要不符的授权不得被执行，而这两件事在数据库层就被排除，
   * 不依赖调用方先读过一遍再下结论。
   *
   * `digest` 由调用方**在执行的瞬间重新算出**（见 `@lwb/recovery` 的
   * `authorizeAndRepair`）：把授权签发时那个值原样传回来，
   * 等于把「磁盘没变过」这件事变成一句假设，而它正是这条授权要钉住的。
   */
  consume(input: {
    readonly authorization_id: string;
    readonly digest: string;
    readonly now: string;
  }): RecoveryAuthorizationRecord {
    const result = this.db
      .prepare(
        `UPDATE recovery_authorizations
            SET state = 'CONSUMED', consumed_at = ?
          WHERE id = ? AND state = 'ACTIVE' AND digest = ? AND expires_at > ?`,
      )
      .run(input.now, input.authorization_id, input.digest, input.now);

    if (result.changes === 0) {
      const current = this.findById(input.authorization_id);
      if (!current) throw new BridgeError('APPROVAL_REQUIRED', '恢复授权不存在。');
      if (current.state !== 'ACTIVE') {
        throw new BridgeError('APPROVAL_EXPIRED', '恢复授权已被使用或撤销。');
      }
      throw new BridgeError(
        'APPROVAL_EXPIRED',
        '恢复授权已过期，或与当前磁盘状态算出的计划摘要不符（磁盘在授权之后被改动过）。',
      );
    }
    return this.requireById(input.authorization_id);
  }

  revoke(authorizationId: string): RecoveryAuthorizationRecord {
    const result = this.db
      .prepare("UPDATE recovery_authorizations SET state = 'REVOKED' WHERE id = ? AND state = 'ACTIVE'")
      .run(authorizationId);
    if (result.changes === 0) {
      throw new BridgeError('APPROVAL_EXPIRED', '只有有效恢复授权才能撤销。');
    }
    return this.requireById(authorizationId);
  }

  /** 把已过期的 ACTIVE 授权标记为 EXPIRED；返回处理条数。 */
  expireDue(now: string): number {
    return this.db
      .prepare(
        "UPDATE recovery_authorizations SET state = 'EXPIRED' WHERE state = 'ACTIVE' AND expires_at <= ?",
      )
      .run(now).changes;
  }
}

// ---------------------------------------------------------------------------
// 幂等
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  readonly id: string;
  readonly principal_id: string;
  readonly tool: string;
  readonly key: string;
  readonly request_hash: string;
  readonly result_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * 幂等判定的三种结果。
 *
 * `conflict` 是**必须显式暴露**的分支：同一个幂等键配上不同的请求内容，
 * 说明调用方复用了键，此时返回旧结果会让调用方以为新请求成功了。
 */
export type IdempotencyOutcome =
  | { readonly kind: 'new'; readonly record: IdempotencyRecord }
  | { readonly kind: 'replay'; readonly record: IdempotencyRecord }
  | { readonly kind: 'conflict'; readonly record: IdempotencyRecord };

export class IdempotencyRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  find(principalId: string, tool: string, key: string): IdempotencyRecord | null {
    const row = this.db
      .prepare('SELECT * FROM idempotency_records WHERE principal_id = ? AND tool = ? AND key = ?')
      .get(principalId, tool, key) as IdempotencyRecord | undefined;
    return row ?? null;
  }

  /**
   * 开始一次幂等操作。
   *
   * 不用「先查后插」的裸逻辑：两次调用之间可能有并发。
   * 这里直接尝试插入，靠 UNIQUE(principal_id, tool, key) 判定归属——
   * 插入成功即本次是新请求，冲突则回查已有记录再比对请求哈希。
   */
  begin(input: {
    readonly id: string;
    readonly principal_id: string;
    readonly tool: string;
    readonly key: string;
    readonly request_hash: string;
  }): IdempotencyOutcome {
    const now = this.clock();
    try {
      this.db
        .prepare(
          `INSERT INTO idempotency_records
             (id, principal_id, tool, key, request_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.principal_id, input.tool, input.key, input.request_hash, now, now);
      return { kind: 'new', record: required(this.find(input.principal_id, input.tool, input.key) ?? undefined, 'idempotency 刚写入的记录') };
    } catch (cause) {
      if (!isUniqueViolation(cause)) throw cause;
      const existing = required(
        this.find(input.principal_id, input.tool, input.key) ?? undefined,
        'idempotency 唯一冲突后的记录',
      );
      return existing.request_hash === input.request_hash
        ? { kind: 'replay', record: existing }
        : { kind: 'conflict', record: existing };
    }
  }

  /** 记录已完成，供后续同键请求直接返回同一结果。 */
  complete(principalId: string, tool: string, key: string, resultRef: string): IdempotencyRecord {
    const result = this.db
      .prepare(
        `UPDATE idempotency_records SET result_ref = ?, updated_at = ?
          WHERE principal_id = ? AND tool = ? AND key = ?`,
      )
      .run(resultRef, this.clock(), principalId, tool, key);
    if (result.changes === 0) {
      throw new BridgeError('INTERNAL_ERROR', '完成了一个不存在的幂等记录。');
    }
    return required(this.find(principalId, tool, key) ?? undefined, 'idempotency 完成后的记录');
  }
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/**
 * 被本次调用触及的**一个文件**（LWB-018）。
 *
 * `path` 是**工作区内相对路径**，与 `AuditEventInput.metadata` 的约束同源 ——
 * 见迁移 v3 的说明。
 */
export interface AuditFileAccessInput {
  readonly path: string;
  /** 可选的 1 起算行区间；列举/状态类结果没有行区间。 */
  readonly start_line?: number | null;
  readonly end_line?: number | null;
  /** 见迁移 v3：1 = 确实出站了，0 = 是目标但什么都没出去。 */
  readonly delivered: boolean;
}

export interface AuditEventInput {
  readonly subject: string;
  readonly action: string;
  readonly outcome: 'allow' | 'deny' | 'error';
  readonly workspace_id?: string | null;
  readonly connection_id?: string | null;
  readonly change_id?: string | null;
  readonly error_code?: string | null;
  /** 本次 IPC 请求的关联 ID（`req_…`）。工具调用审计的主查询键。 */
  readonly request_id?: string | null;
  /** 工具名原样记录（不是分类名）：调查时问的是「谁调了 file_read」。 */
  readonly tool?: string | null;
  /** 实际出站的内容字节数。见 `apps/daemon/src/tools/guard.ts` 的取值说明。 */
  readonly bytes_out?: number | null;
  /** 本次调用读取/返回的文件与范围。见迁移 v3。 */
  readonly file_access?: readonly AuditFileAccessInput[];
  /**
   * 结构化补充信息。**不得**包含源码正文、凭证或本机绝对路径：
   * 审计库与状态库同文件，泄漏面等于整个状态库。
   */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | null;
}

/** 按 `request_id` 反查时返回的完整记录：事件 + 它的文件访问行。 */
export interface AuditCallRecord {
  readonly id: number;
  readonly request_id: string | null;
  readonly tool: string | null;
  readonly subject: string;
  readonly action: string;
  readonly outcome: 'allow' | 'deny' | 'error';
  readonly connection_id: string | null;
  readonly workspace_id: string | null;
  readonly error_code: string | null;
  readonly bytes_out: number | null;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly file_access: readonly (AuditFileAccessInput & { readonly delivered: boolean })[];
}

interface AuditEventRow {
  id: number;
  request_id: string | null;
  tool: string | null;
  subject: string;
  action: string;
  outcome: 'allow' | 'deny' | 'error';
  connection_id: string | null;
  workspace_id: string | null;
  error_code: string | null;
  bytes_out: number | null;
  timestamp: string;
  metadata: string | null;
}

interface AuditFileAccessRow {
  path: string;
  start_line: number | null;
  end_line: number | null;
  delivered: number;
}

export class AuditRepo {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = isoNow,
  ) {}

  /**
   * 追加一条审计事件，**连同它的文件访问行**。
   *
   * 两件事同一个事务：一条声称「读了 3 个文件」却没有行的审计记录，
   * 与一条行存在、事件却不存在的记录，是两种不同的谎言。
   * 原子写入让「事件与它的范围永远同时存在」成为结构性质。
   */
  append(input: AuditEventInput): number {
    const write = this.db.transaction((value: AuditEventInput): number => {
      const info = this.db
        .prepare(
          `INSERT INTO audit_events
             (subject, action, workspace_id, connection_id, change_id, outcome, error_code,
              metadata, timestamp, request_id, tool, bytes_out)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.subject,
          value.action,
          value.workspace_id ?? null,
          value.connection_id ?? null,
          value.change_id ?? null,
          value.outcome,
          value.error_code ?? null,
          value.metadata ? JSON.stringify(value.metadata) : null,
          this.clock(),
          value.request_id ?? null,
          value.tool ?? null,
          value.bytes_out ?? null,
        );
      const eventId = Number(info.lastInsertRowid);
      this.#insertFileAccess(eventId, value.file_access ?? []);
      return eventId;
    });
    return write.immediate(input);
  }

  #insertFileAccess(eventId: number, rows: readonly AuditFileAccessInput[]): void {
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO audit_file_access (event_id, path, path_key, start_line, end_line, delivered)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        eventId,
        row.path,
        row.path.toLowerCase(),
        row.start_line ?? null,
        row.end_line ?? null,
        toBoolInt(row.delivered),
      );
    }
  }

  /**
   * 按 `request_id` 反查一次工具调用（LWB-018 第一条验收标准）。
   *
   * 返回**全部**匹配（而不是第一条）：见迁移 v3 里关于「不是唯一索引」的说明 ——
   * 重复本身是要被看见的事实，不是要被查询掩盖的意外。
   */
  findByRequestId(requestId: string): AuditCallRecord[] {
    const events = this.db
      .prepare('SELECT * FROM audit_events WHERE request_id = ? ORDER BY id ASC')
      .all(requestId) as AuditEventRow[];
    return events.map((row) => this.#toCallRecord(row));
  }

  /** 一条事件的文件访问行。导出给「事件已知、只缺范围」的调用方。 */
  fileAccessForEvent(eventId: number): (AuditFileAccessInput & { readonly delivered: boolean })[] {
    const rows = this.db
      .prepare('SELECT path, start_line, end_line, delivered FROM audit_file_access WHERE event_id = ? ORDER BY id ASC')
      .all(eventId) as AuditFileAccessRow[];
    return rows.map((row) => ({
      path: row.path,
      start_line: row.start_line,
      end_line: row.end_line,
      delivered: bool(row.delivered),
    }));
  }

  /**
   * 已经交出去、因此**收不回来**的文件访问行有多少（LWB-034 步骤 3）。
   *
   * ## 这个数要回答的是什么
   *
   * 「停用后阻止未发出的工具结果；**记录已返回给 ChatGPT 的内容无法撤回**」。
   * 前半句是拒绝，后半句是**记账** —— 而记账要有一个可核对的读数，
   * 否则「无法撤回」就只是一句安慰话。这个数就是那个读数：
   * 有多少条「某个文件的某个范围」已经离开本进程。
   *
   * ## 边界说清楚：`delivered` 的尽头是本进程
   *
   * `delivered = 1` 的含义是「这一行所属的那次调用**把结果交回给了调用方**」
   * （见迁移 v3 对 `delivered` 的定义）。调用方是适配器进程，
   * 而适配器之后还要经过隧道才到 ChatGPT。因此严格地讲，这个数说的是
   * 「已经离开守护进程」，比「已经到达 ChatGPT」**更大**（中途可能失败）。
   *
   * 取这个更大的数是有意的，而且是安全的那一侧：本进程无法知道隧道那一端
   * 收到了什么，因此凡是有可能已经出去的都算作已经出去。反过来
   * （只数「确认到达」的）会让这个读数**偏小**，而一个偏小的
   * 「收不回来」读数，会让人以为没漏那么多。
   *
   * ## 它是一次全表扫，而且刻意不加索引
   *
   * `delivered` 的取值只有 0 与 1，而这里的判据又恰好是「取 1 的那些」——
   * SQLite 在这种情况下仍然会走全表扫，一个布尔列上的索引也帮不上忙
   * （选择性太差，规划器多半直接忽略它）。这张表按本工程的用量是
   * 每台机器几千行量级，一次 scan 是微秒级，而它属于**诊断**路径
   * （暂停时、看状态时），不是每一次工具调用都会走到。
   *
   * 真到需要更快的那一天，正确的做法是维护一个计数器，
   * 而不是给一个两值列加索引 —— 那只会让人以为它变快了。
   */
  countDeliveredFileAccess(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM audit_file_access WHERE delivered = 1')
      .get() as { n: number };
    return row.n;
  }

  /** 按路径反查「哪些调用碰过这个文件」。同样是索引查，不是全表扫。 */
  eventsTouchingPath(path: string, options: { readonly limit?: number } = {}): number[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const rows = this.db
      .prepare(
        `SELECT DISTINCT event_id FROM audit_file_access
          WHERE path_key = ? ORDER BY event_id DESC LIMIT ?`,
      )
      .all(path.toLowerCase(), limit) as { event_id: number }[];
    return rows.map((row) => row.event_id);
  }

  #toCallRecord(row: AuditEventRow): AuditCallRecord {
    let metadata: Readonly<Record<string, string | number | boolean | null>> | null = null;
    if (row.metadata !== null) {
      try {
        const parsed: unknown = JSON.parse(row.metadata);
        // 解析失败**不**假装是空对象：那会让一条内容损坏的记录看起来像
        // 「这条调用没有补充信息」。损坏就是损坏，交给调用方处置。
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, string | number | boolean | null>;
        }
      } catch {
        metadata = { metadata_unparsable: true };
      }
    }
    return {
      id: row.id,
      request_id: row.request_id,
      tool: row.tool,
      subject: row.subject,
      action: row.action,
      outcome: row.outcome,
      connection_id: row.connection_id,
      workspace_id: row.workspace_id,
      error_code: row.error_code,
      bytes_out: row.bytes_out,
      timestamp: row.timestamp,
      metadata,
      file_access: this.fileAccessForEvent(row.id),
    };
  }

  list(options: { readonly limit?: number } = {}): {
    id: number;
    subject: string;
    action: string;
    outcome: string;
    error_code: string | null;
    timestamp: string;
  }[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    return this.db
      .prepare(
        'SELECT id, subject, action, outcome, error_code, timestamp FROM audit_events ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as {
      id: number;
      subject: string;
      action: string;
      outcome: string;
      error_code: string | null;
      timestamp: string;
    }[];
  }
}

// ---------------------------------------------------------------------------
// 聚合入口
// ---------------------------------------------------------------------------

/**
 * 状态库的全部仓储。
 *
 * 聚合而不是散装导出，是为了让「一个数据库连接对应一套仓储」这件事显式化：
 * 仓储不能跨连接混用，否则事务边界会静默失效。
 */
export class Repositories {
  readonly connections: ConnectionsRepo;
  readonly workspaces: WorkspacesRepo;
  readonly grants: GrantsRepo;
  readonly blobs: BlobsRepo;
  readonly changes: ChangesRepo;
  readonly operations: OperationsRepo;
  readonly journal: JournalRepo;
  readonly approvals: ApprovalsRepo;
  readonly recovery_authorizations: RecoveryAuthorizationsRepo;
  readonly idempotency: IdempotencyRepo;
  readonly audit: AuditRepo;
  readonly write_slots: WorkspaceWriteSlotsRepo;
  readonly service_pause: ServicePauseRepo;
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase, clock: Clock = isoNow) {
    this.#db = db;
    this.connections = new ConnectionsRepo(db, clock);
    this.workspaces = new WorkspacesRepo(db, clock);
    this.grants = new GrantsRepo(db, clock);
    this.blobs = new BlobsRepo(db, clock);
    this.changes = new ChangesRepo(db, clock);
    this.operations = new OperationsRepo(db, clock);
    this.journal = new JournalRepo(db, clock);
    this.approvals = new ApprovalsRepo(db, clock);
    this.recovery_authorizations = new RecoveryAuthorizationsRepo(db, clock);
    this.idempotency = new IdempotencyRepo(db, clock);
    this.audit = new AuditRepo(db, clock);
    this.write_slots = new WorkspaceWriteSlotsRepo(db, clock);
    this.service_pause = new ServicePauseRepo(db, clock);
  }

  /**
   * 跨仓储的立即事务（LWB-020）。
   *
   * 只有一处需要它，而那一处非它不可：prepare 必须在同一个原子单元里
   * **建立修改集**并**标记幂等键已完成**。半完成的那个状态 —— 修改集已经
   * 存在、幂等记录却仍指向空 —— 会让一次崩溃之后的重试无法判断
   * 「上次到底成没成」：重试会第二次建立修改集（同一个键对应两个修改集），
   * 而放弃重试则让调用方永远拿不到那次已经算出来的结果。
   *
   * 嵌套是允许的：`ChangesRepo.create` 自己也要一个事务，better-sqlite3
   * 在已有事务内改用 SAVEPOINT，因此这里的单元仍然是全或无。
   *
   * 不暴露连接本身：SQL 属于本模块（见包说明），调用方只表达
   * 「这几件事一起发生」。
   */
  transaction<T>(fn: () => T): T {
    return withImmediateTransaction(this.#db, fn);
  }
}
