/**
 * 模式与迁移（方案 §7、§7.1、§7.2、LWB-006）。
 *
 * 迁移以**代码内常量**而不是外部 .sql 文件保存：
 * 本工程没有构建步骤（tsc 只做类型检查、不产出），运行的是 TS 源文件，
 * 若迁移放在外部文件里，打包与部署时极易漏带，而漏带迁移的后果是
 * 在用户机器上创建一个空库继续服务 —— 这正是方案明令禁止的。
 *
 * ## 为什么这里的枚举值是**字面量**，而不是从 @lwb/contracts 引用
 *
 * 已发布的迁移必须是**不可变文本**：它的 sha256 在首次应用时落库，
 * 之后每次打开都重新计算比对。如果迁移 SQL 里插入了来自契约文件的活值，
 * 那么将来契约新增一个状态，v1 的迁移文本就变了，所有既有数据库都会
 * 在启动时因校验和不符而被拒绝 —— 一个纯类型层面的改动会变成数据不可用。
 *
 * 因此本文件冻结字面量，另用测试（tests/unit/persistence.test.ts）
 * 断言这些冻结集合与契约当前定义一致：漂移由测试发现，而不是由用户发现。
 */

import { createHash } from 'node:crypto';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** 按顺序执行的 SQL 语句；每条只执行一次。 */
  readonly statements: readonly string[];
  /**
   * 本迁移是否要求在整个执行期间关闭外键约束。
   *
   * 仅表重建（SQLite 改不了 CHECK 约束，只能重建表）需要它：
   * `DROP TABLE` 在外键开启时等价于删除全表行，父表被引用时会被
   * `ON DELETE RESTRICT` 直接中止。而 `PRAGMA foreign_keys` 在事务内**无效**，
   * 所以只能在事务之外切换 —— 这就是本字段必须存在的原因，
   * 它让运行器知道要提前把关。
   */
  readonly requires_foreign_keys_off?: true;
}

/**
 * 冻结于迁移 v1 的修改集状态集合（方案 §8.1，13 个）。
 * 与 `@lwb/contracts` 的 `CHANGE_STATE_LABELS` 的键集合必须一致。
 */
export const FROZEN_CHANGE_STATES = [
  'PENDING_APPROVAL',
  'REJECTED',
  'EXPIRED',
  'INVALIDATED',
  'APPROVED',
  'QUEUED',
  'VALIDATING',
  'CONFLICT',
  'FAILED_NO_CHANGE',
  'APPLYING',
  'APPLIED',
  'ROLLED_BACK',
  'RECOVERY_REQUIRED',
] as const;

/**
 * 冻结于迁移 v1 的终态集合。进入终态的修改集**不得删除**：
 * 否则同一个 change_id 会重新变成可用的新任务，历史操作记录也会失去指向。
 * 冻结理由见文件头。
 */
export const FROZEN_TOMBSTONE_CHANGE_STATES = [
  'REJECTED',
  'EXPIRED',
  'INVALIDATED',
  'APPLIED',
  'ROLLED_BACK',
  'FAILED_NO_CHANGE',
  'CONFLICT',
] as const;

/** 冻结于迁移 v1 的操作状态集合。 */
export const FROZEN_OPERATION_STATES = [
  'QUEUED',
  'VALIDATING',
  'APPLYING',
  'APPLIED',
  'FAILED_NO_CHANGE',
  'ROLLED_BACK',
  'CONFLICT',
  'RECOVERY_REQUIRED',
] as const;

/** 冻结于迁移 v1 的逐文件结果状态（含「未知」——未知必须可表达，不能并入成功）。 */
export const FROZEN_ITEM_RESULT_STATES = [
  'PENDING',
  'VERIFIED',
  'CONFLICT',
  'FAILED',
  'RECOVERED_TARGET',
  'RECOVERED_ORIGINAL',
  'UNKNOWN',
] as const;

/**
 * 恢复可以请求的**写入**动作（迁移 v7 起）。
 *
 * 只有一条，而这不是「暂时只有一条」：另一个方向 —— 把目标字节补写进
 * 那些还没写到的文件 —— 就是**重放一次旧批准**，§8.4 明令禁止
 * （「不重放旧批准」）。因此这张表在可预见的将来只有一个取值，
 * 而它写成一个集合而不是一个 CHECK 里的字面量，是为了让「为什么只有一条」
 * 这件事有一个可以被读到的位置。
 */
export const FROZEN_RECOVERY_DECISIONS = ['ROLLBACK_TO_BASELINE'] as const;

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         checksum   TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,

      // --- 连接：身份来自认证 IPC，绝不来自模型输入 -------------------------
      `CREATE TABLE connections (
         id             TEXT PRIMARY KEY,
         principal_kind TEXT NOT NULL CHECK (principal_kind IN ('model_surface','console','runtime')),
         principal_id   TEXT NOT NULL,
         alias          TEXT NOT NULL,
         enabled        INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
         generation     INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
         credential_ref TEXT,
         created_at     TEXT NOT NULL,
         updated_at     TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX connections_alias_uq ON connections(alias)`,
      `CREATE INDEX connections_principal_idx ON connections(principal_kind, principal_id)`,

      // --- 工作区：以真实卷与文件身份标识，而不是靠路径字符串 ----------------
      `CREATE TABLE workspaces (
         id             TEXT PRIMARY KEY,
         alias          TEXT NOT NULL,
         kind           TEXT NOT NULL CHECK (kind IN ('directory')),
         canonical_root TEXT NOT NULL,
         volume_id      TEXT NOT NULL,
         root_file_id   TEXT NOT NULL,
         generation     INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
         policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
         mode           TEXT NOT NULL CHECK (mode IN ('read_only','read_propose_apply_with_local_approval')),
         enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
         created_at     TEXT NOT NULL,
         updated_at     TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX workspaces_alias_uq ON workspaces(alias)`,
      // 同一物理目录不能被登记两次，即使换了写法或大小写。
      `CREATE UNIQUE INDEX workspaces_root_uq ON workspaces(canonical_root COLLATE NOCASE)`,
      // 「同名路径换对象」：根被删除后重建的目录是不同的 file_id，必须能区分。
      `CREATE UNIQUE INDEX workspaces_identity_uq ON workspaces(volume_id, root_file_id)`,

      `CREATE TABLE grants (
         id            TEXT PRIMARY KEY,
         connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
         workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
         capabilities  TEXT NOT NULL,
         enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
         created_at    TEXT NOT NULL,
         updated_at    TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX grants_uq ON grants(connection_id, workspace_id)`,

      // --- blob：必须先持久化并校验，才能被引用进入可执行计划 -----------------
      `CREATE TABLE blobs (
         id               TEXT PRIMARY KEY,
         sha256           TEXT NOT NULL CHECK (length(sha256) = 64),
         size             INTEGER NOT NULL CHECK (size >= 0),
         storage_ref      TEXT NOT NULL,
         refcount         INTEGER NOT NULL DEFAULT 0 CHECK (refcount >= 0),
         retention_state  TEXT NOT NULL DEFAULT 'active'
                          CHECK (retention_state IN ('active','pending_gc','deleted')),
         created_at       TEXT NOT NULL,
         last_verified_at TEXT
       )`,
      `CREATE UNIQUE INDEX blobs_content_uq ON blobs(sha256, size)`,

      // --- 修改集：内容不可变（由触发器强制）--------------------------------
      `CREATE TABLE changesets (
         id                  TEXT PRIMARY KEY,
         owner_connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
         workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
         root_generation     INTEGER NOT NULL,
         policy_version      INTEGER NOT NULL,
         contract_version    TEXT NOT NULL,
         digest              TEXT NOT NULL CHECK (length(digest) = 64),
         summary             TEXT NOT NULL,
         state               TEXT NOT NULL CHECK (state IN (${sqlList(FROZEN_CHANGE_STATES)})),
         expires_at          TEXT NOT NULL,
         created_at          TEXT NOT NULL,
         updated_at          TEXT NOT NULL
       )`,
      `CREATE INDEX changesets_owner_idx ON changesets(owner_connection_id, created_at)`,
      `CREATE INDEX changesets_workspace_idx ON changesets(workspace_id, created_at)`,

      `CREATE TABLE change_items (
         id                 TEXT PRIMARY KEY,
         change_id          TEXT NOT NULL REFERENCES changesets(id) ON DELETE RESTRICT,
         seq                INTEGER NOT NULL CHECK (seq >= 0),
         op                 TEXT NOT NULL CHECK (op IN ('edit_text','create_text','replace_text')),
         canonical_path     TEXT NOT NULL,
         canonical_path_key TEXT NOT NULL,
         base_file_id       TEXT,
         base_sha256        TEXT,
         target_sha256      TEXT NOT NULL CHECK (length(target_sha256) = 64),
         old_blob_id        TEXT REFERENCES blobs(id) ON DELETE RESTRICT,
         new_blob_id        TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
         -- 不可编辑的编码（unknown / 二进制）不得进入可执行计划，因此在模式层就写不进来。
         encoding           TEXT NOT NULL CHECK (encoding IN ('utf-8','utf-8-bom')),
         bom                INTEGER NOT NULL DEFAULT 0 CHECK (bom IN (0,1)),
         newline            TEXT NOT NULL CHECK (newline IN ('lf','crlf','mixed','none')),
         created_at         TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX change_items_seq_uq ON change_items(change_id, seq)`,
      // 同一物理文件在一次修改集里只能被操作一次（方案 §7 关键约束）。
      // 用规范化小写键比较，因为 Windows 路径大小写不敏感。
      `CREATE UNIQUE INDEX change_items_path_uq ON change_items(change_id, canonical_path_key)`,
      // 创建操作不得带基线；编辑/整文件替换必须有基线身份与哈希。
      `CREATE TRIGGER change_items_create_has_no_base
         BEFORE INSERT ON change_items
         WHEN NEW.op = 'create_text' AND (NEW.base_file_id IS NOT NULL OR NEW.base_sha256 IS NOT NULL)
         BEGIN
           SELECT RAISE(ABORT, 'create_text 不得携带基线身份或基线哈希');
         END`,
      `CREATE TRIGGER change_items_edit_requires_base
         BEFORE INSERT ON change_items
         WHEN NEW.op <> 'create_text' AND (NEW.base_file_id IS NULL OR NEW.base_sha256 IS NULL)
         BEGIN
           SELECT RAISE(ABORT, 'edit_text / replace_text 必须携带基线身份与基线哈希');
         END`,

      // --- 操作：一个修改集最多一个操作 -------------------------------------
      // 注意顺序：approvals.consumed_by 与 operation_item_results 都指向本表。
      `CREATE TABLE operations (
         id              TEXT PRIMARY KEY,
         change_id       TEXT NOT NULL REFERENCES changesets(id) ON DELETE RESTRICT,
         state           TEXT NOT NULL CHECK (state IN (${sqlList(FROZEN_OPERATION_STATES)})),
         idempotency_key TEXT,
         worker_instance TEXT,
         recovered       INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0,1)),
         started_at      TEXT,
         finished_at     TEXT,
         created_at      TEXT NOT NULL
       )`,
      // 方案 §7：UNIQUE(change_id)。即使调用方换了幂等键，也不能产生第二个操作。
      `CREATE UNIQUE INDEX operations_change_uq ON operations(change_id)`,

      `CREATE TABLE operation_item_results (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         operation_id  TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
         item_id       TEXT NOT NULL REFERENCES change_items(id) ON DELETE RESTRICT,
         state         TEXT NOT NULL CHECK (state IN (${sqlList(FROZEN_ITEM_RESULT_STATES)})),
         before_sha256 TEXT,
         after_sha256  TEXT,
         error_code    TEXT,
         updated_at    TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX operation_item_results_uq ON operation_item_results(operation_id, item_id)`,

      // --- 批准：精确绑定摘要、一次性消费 -----------------------------------
      `CREATE TABLE approvals (
         id          TEXT PRIMARY KEY,
         change_id   TEXT NOT NULL REFERENCES changesets(id) ON DELETE RESTRICT,
         digest      TEXT NOT NULL CHECK (length(digest) = 64),
         actor       TEXT NOT NULL,
         actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('local_operator')),
         expires_at  TEXT NOT NULL,
         state       TEXT NOT NULL CHECK (state IN ('ACTIVE','CONSUMED','REVOKED','EXPIRED')),
         consumed_by TEXT REFERENCES operations(id) ON DELETE RESTRICT,
         created_at  TEXT NOT NULL,
         consumed_at TEXT
       )`,
      // 同一个修改集同时只能存在一个有效批准。
      `CREATE UNIQUE INDEX approvals_active_uq ON approvals(change_id) WHERE state = 'ACTIVE'`,

      `CREATE TABLE journal_entries (
         id               INTEGER PRIMARY KEY AUTOINCREMENT,
         operation_id     TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
         seq              INTEGER NOT NULL CHECK (seq >= 0),
         item_id          TEXT REFERENCES change_items(id) ON DELETE RESTRICT,
         stage            TEXT NOT NULL,
         observed_file_id TEXT,
         observed_sha256  TEXT,
         target_sha256    TEXT,
         error_code       TEXT,
         detail           TEXT,
         created_at       TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX journal_entries_seq_uq ON journal_entries(operation_id, seq)`,

      `CREATE TABLE idempotency_records (
         id           TEXT PRIMARY KEY,
         principal_id TEXT NOT NULL,
         tool         TEXT NOT NULL,
         key          TEXT NOT NULL,
         request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
         result_ref   TEXT,
         created_at   TEXT NOT NULL,
         updated_at   TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX idempotency_uq ON idempotency_records(principal_id, tool, key)`,

      // --- 审计：不得含源码正文或凭证（内容约束在 audit 包，这里只保证结构）--
      `CREATE TABLE audit_events (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         subject       TEXT NOT NULL,
         action        TEXT NOT NULL,
         workspace_id  TEXT,
         connection_id TEXT,
         change_id     TEXT,
         outcome       TEXT NOT NULL CHECK (outcome IN ('allow','deny','error')),
         error_code    TEXT,
         metadata      TEXT,
         timestamp     TEXT NOT NULL
       )`,
      `CREATE INDEX audit_events_time_idx ON audit_events(timestamp)`,

      // --- 不可变性与终态墓碑 ------------------------------------------------
      // 修改集的内容字段一旦写入就不能改；只有 state / updated_at 可流转。
      `CREATE TRIGGER changesets_content_immutable
         BEFORE UPDATE ON changesets
         WHEN NEW.id <> OLD.id
           OR NEW.owner_connection_id <> OLD.owner_connection_id
           OR NEW.workspace_id <> OLD.workspace_id
           OR NEW.root_generation <> OLD.root_generation
           OR NEW.policy_version <> OLD.policy_version
           OR NEW.contract_version <> OLD.contract_version
           OR NEW.digest <> OLD.digest
           OR NEW.created_at <> OLD.created_at
         BEGIN
           SELECT RAISE(ABORT, '修改集内容不可变：只有状态可以流转');
         END`,

      // 终态修改集不得被删除：否则旧 change_id 会变成可再次执行的任务。
      `CREATE TRIGGER changesets_terminal_tombstone
         BEFORE DELETE ON changesets
         WHEN OLD.state IN (${sqlList(FROZEN_TOMBSTONE_CHANGE_STATES)})
         BEGIN
           SELECT RAISE(ABORT, '已进入终态的修改集不得删除（终态墓碑）');
         END`,

      `CREATE TRIGGER change_items_immutable
         BEFORE UPDATE ON change_items
         BEGIN
           SELECT RAISE(ABORT, '修改集条目不可变');
         END`,

      `CREATE TRIGGER operations_no_delete
         BEFORE DELETE ON operations
         BEGIN
           SELECT RAISE(ABORT, '操作记录不得删除：它是幂等与恢复判定的事实来源');
         END`,

      `CREATE TRIGGER journal_no_delete
         BEFORE DELETE ON journal_entries
         BEGIN
           SELECT RAISE(ABORT, '日志为追加写，不得删除');
         END`,

      // 已消费的批准不得退回 ACTIVE，避免「一次批准用两次」。
      `CREATE TRIGGER approvals_no_reactivate
         BEFORE UPDATE ON approvals
         WHEN OLD.state <> 'ACTIVE' AND NEW.state = 'ACTIVE'
         BEGIN
           SELECT RAISE(ABORT, '批准不得从非 ACTIVE 状态退回 ACTIVE');
         END`,

      `CREATE TRIGGER approvals_immutable_binding
         BEFORE UPDATE ON approvals
         WHEN NEW.change_id <> OLD.change_id
           OR NEW.digest <> OLD.digest
           OR NEW.actor <> OLD.actor
           OR NEW.created_at <> OLD.created_at
         BEGIN
           SELECT RAISE(ABORT, '批准的绑定字段不可变：批准与摘要必须精确绑定');
         END`,

      `CREATE TRIGGER idempotency_immutable_key
         BEFORE UPDATE ON idempotency_records
         WHEN NEW.principal_id <> OLD.principal_id
           OR NEW.tool <> OLD.tool
           OR NEW.key <> OLD.key
           OR NEW.request_hash <> OLD.request_hash
         BEGIN
           SELECT RAISE(ABORT, '幂等记录的键与请求哈希不可变：同键不同请求必须报冲突，而不是覆盖');
         END`,
    ],
  },
  {
    version: 2,
    name: 'workspace_kind_allows_single_file',
    requires_foreign_keys_off: true,

    /**
     * v1 把工作区限定为目录（`kind IN ('directory')`），而 LWB-009 要求
     * **单文件授权**，且验收标准明确要求「单文件授权不会顺带暴露其整个父目录」。
     *
     * 两种表示法之间选择了「根就是那个文件本身」：
     *
     *  - 若把根设为父目录、另用一张 scope 表列出允许的单个文件，
     *    `kind` 保持 `'directory'` 就不用迁移。但那要求**每一次**路径解析
     *    都记得去查 scope 表 —— 忘掉一次就把整个父目录暴露了。
     *  - 根 = 文件本身时，文件没有子项，暴露父目录在**结构上不可能**，
     *    不依赖任何人记得做检查。
     *
     * 本工程在别处一律选「结构性不可能」而不是「记得检查」，这里同理。
     * 代价就是这一条迁移：SQLite 改不了 CHECK 约束，只能重建表。
     *
     * ## `removed_at` 与三个**部分**唯一索引
     *
     * 「移除工作区」不能是 `DELETE`：`changesets.workspace_id` 是
     * `ON DELETE RESTRICT`，而终态修改集又被触发器钉住不得删除 ——
     * 历史操作记录必须继续指向一个真实存在的行。因此移除是软移除，
     * 用 `removed_at` 标记（NULL = 在册）。
     *
     * 随之而来的一点很容易漏：三个唯一索引必须**只约束在册工作区**，
     * 否则移除过的别名与根路径会被永久占用，本地操作者再也无法用同一个
     * 名字或同一个目录重新登记 —— 一个纯粹由索引造成的死锁。
     */
    statements: [
      `CREATE TABLE workspaces_v2 (
         id             TEXT PRIMARY KEY,
         alias          TEXT NOT NULL,
         kind           TEXT NOT NULL CHECK (kind IN ('directory','file')),
         canonical_root TEXT NOT NULL,
         volume_id      TEXT NOT NULL,
         root_file_id   TEXT NOT NULL,
         generation     INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
         policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
         mode           TEXT NOT NULL CHECK (mode IN ('read_only','read_propose_apply_with_local_approval')),
         enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
         removed_at     TEXT,
         created_at     TEXT NOT NULL,
         updated_at     TEXT NOT NULL
       )`,

      // 逐列复制而不是 `SELECT *`：列序一旦与上方不一致，`SELECT *` 会静默错位。
      // v1 的行一律是在册的，因此 removed_at 取 NULL。
      `INSERT INTO workspaces_v2
         (id, alias, kind, canonical_root, volume_id, root_file_id,
          generation, policy_version, mode, enabled, removed_at, created_at, updated_at)
       SELECT id, alias, kind, canonical_root, volume_id, root_file_id,
              generation, policy_version, mode, enabled, NULL, created_at, updated_at
         FROM workspaces`,

      // 外键约束已由运行器在事务外关闭（requires_foreign_keys_off）。
      // 重建后由 PRAGMA foreign_key_check 复验，见 database.ts。
      `DROP TABLE workspaces`,
      `ALTER TABLE workspaces_v2 RENAME TO workspaces`,

      // 索引随旧表被 DROP 一并删除，必须重建。
      `CREATE UNIQUE INDEX workspaces_alias_uq ON workspaces(alias) WHERE removed_at IS NULL`,
      `CREATE UNIQUE INDEX workspaces_root_uq ON workspaces(canonical_root COLLATE NOCASE) WHERE removed_at IS NULL`,
      `CREATE UNIQUE INDEX workspaces_identity_uq ON workspaces(volume_id, root_file_id) WHERE removed_at IS NULL`,
    ],
  },
  {
    version: 3,
    name: 'audit_tool_calls',

    /**
     * LWB-018 的第一条验收标准是「可回答某次工具调用读取和返回了哪些文件范围」。
     *
     * 这句话只有在一个**能按调用反查**的查询上才成立。v1 的 `audit_events`
     * 已经有 `connection_id` / `workspace_id` / `error_code`，缺的正是
     * 「哪一次调用」（`request_id`）与「哪些文件、哪几行」（子表）。
     *
     * ## 为什么范围要单独一张表，而不是塞进 `metadata` 的 JSON
     *
     * 塞进 JSON 是零成本的（那一列本来就在），但它会让这条验收标准退化成
     * 「把整张审计表捞出来、在内存里解析每一行的 JSON、再筛」——
     * 也就是说，问题**能不能被回答**取决于审计表有多大。而调查者问这个问题
     * 的场合恰恰是「已经出了事、库里有几十万条记录」。子表让它是两次索引查。
     *
     * `metadata` 仍然承担**其余**的描述性事实（工作区代次、是否截断、
     * 游标摘要等）：那些不是查询键，加列只会让模式随每次需求漂移。
     * 分界线是「调查时会不会拿它当筛选条件」，不是「它重不重要」。
     *
     * ## 路径是**工作区内相对路径**
     *
     * `AuditEventInput.metadata` 的约束（不得含本机绝对路径）在这里同样成立，
     * 而且更强：这一列是**路径**本身，写进去的东西必须假定它会被导出、
     * 被贴进工单。相对路径足以回答「读了工作区里的哪个文件」，
     * 而绝对路径会顺带泄漏用户名与目录结构 —— 两者回答的是同一个问题，
     * 因此没有理由选信息更多的那一个。
     *
     * `path_key` 是小写副本，只为大小写不敏感的比较（Windows 的路径语义）；
     * 它与 `changesets.canonical_path_key` 是同一种做法的同一种理由。
     */
    statements: [
      `ALTER TABLE audit_events ADD COLUMN request_id TEXT`,
      `ALTER TABLE audit_events ADD COLUMN tool TEXT`,
      `ALTER TABLE audit_events ADD COLUMN bytes_out INTEGER`,
      // 反查主字段。**不是**唯一索引：同一条 IPC 请求只该产生一条记录，
      // 但「只该」是一个由调用方保证的性质，而唯一索引会让它的
      // 一次违约变成**写不进去**（于是那条调用彻底没有审计记录）。
      // 宁可留下两条可以被人看见的重复，也不要一条静默丢失的记录。
      `CREATE INDEX audit_events_request_idx ON audit_events(request_id)`,
      `CREATE INDEX audit_events_tool_idx ON audit_events(tool, timestamp)`,

      `CREATE TABLE audit_file_access (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         event_id   INTEGER NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
         path       TEXT NOT NULL,
         path_key   TEXT NOT NULL,
         start_line INTEGER CHECK (start_line IS NULL OR start_line >= 1),
         end_line   INTEGER CHECK (end_line   IS NULL OR end_line   >= 1),
         -- 1 = 这个文件的内容/条目确实随本次结果出站了；
         -- 0 = 它是本次调用的目标，但什么都没出去（被拒绝、被拦下、失败）。
         -- 两行同形而不是「只记成功」，因为调查者问「读了什么」时
         -- 「被拒绝的读取」和「没有这次调用」是两个不同的答案。
         delivered  INTEGER NOT NULL CHECK (delivered IN (0,1))
       )`,
      `CREATE INDEX audit_file_access_event_idx ON audit_file_access(event_id)`,
      `CREATE INDEX audit_file_access_path_idx ON audit_file_access(path_key)`,
    ],
  },

  {
    version: 4,
    name: 'change_item_line_counts',

    /**
     * LWB-020 的第三条验收标准是「预览显示的最终字节与待应用 blob 一致」。
     *
     * 预览（`ChangeFilePreview`）里有两类字段。一类是**可从既有事实重建**的：
     * 路径、哈希、尺寸、编码、换行、BOM —— 它们要么本来就在 `change_items`
     * 里，要么能从 `blobs` 的 `size` 读到。另一类是**增量行数**
     * （`added_lines` / `removed_lines`）：它既不在条目里，也不在任何一个
     * blob 里 —— 它是**两份字节之间的关系**。
     *
     * ## 为什么不是「看的时候现算」
     *
     * 现算意味着把旧 blob 与新 blob 都读出来做一次差分。两个问题：
     *
     *  1. **算不准。** 引擎给出的增量是**按操作语义**算的：`edit_text` 把
     *     `|old_lines|` 记为删除、`|new_lines|` 记为新增（一次「把第 3 行换成
     *     它自己」的编辑是 +1/−1，而不是 0/0）；`replace_text` 记的是整文件
     *     行数之差；`create_text` 的删除数是 0。一条通用行差分给不出这些数字，
     *     于是「批准时看到的 +3/−1」与「查询时看到的 +0/−0」会不一致 ——
     *     而这两个界面显示的是同一个修改集。
     *  2. **算得贵。** `change_list` 一次列 200 条，每条都要读两个 blob。
     *
     * 因此这两个数字属于**建立修改集那一刻的事实**，与哈希、尺寸同类，
     * 应当落库。默认值 0 只为历史行（V1 尚无生产数据）—— 新写入的行
     * 一律由 `ChangesRepo` 显式提供。
     *
     * ## 为什么风险提示**没有**跟着落库
     *
     * 同一批字段里，「风险」与「事实」的分界线是：风险是**对事实的解释**
     * （删多增少、整文件替换、路径含双向控制符），而解释必须能随事实一起
     * 被复核。存一份文案，就存在「文案与它所解释的事实漂移」的可能；
     * 从落库的事实确定性推导，则每次看到的都与事实一致。
     * 见 `@lwb/changes` 的 `deriveRisks`。
     */
    statements: [
      `ALTER TABLE change_items ADD COLUMN added_lines INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE change_items ADD COLUMN removed_lines INTEGER NOT NULL DEFAULT 0`,
    ],
  },

  {
    version: 5,
    name: 'approval_binding_columns',

    /**
     * LWB-021 步骤 2 要求一次本地批准记录「本地审批身份、连接、资源根代次、
     * 策略版本、摘要、有效期和一次性状态」。七项里已有四项（`actor`、`digest`、
     * `expires_at`、`state`），本迁移补上缺的两项：**资源根代次**与**策略版本**。
     *
     * ## 这两列是「抄了一份」，而抄本为什么仍然值得落库
     *
     * `changesets` 是不可变的（`changesets_content_immutable` 触发器），而
     * `approvals.digest` 已经在密码学意义上覆盖了这两项 —— `canonicalizeChangeDigest`
     * 里就有 `root_generation` 与 `policy_version`。因此**不能**说这两列增加了
     * 防护强度：它们没有。多一层绑定检查不会让摘要更强。
     *
     * 它们的价值是**可读**与**可查**：
     *
     *  - 「这次批准是在哪个根代次、哪个策略版本下给出的」应当是一次主键查能
     *    回答的问题，而不是「先重算一次摘要再比对」才能回答的问题。审计的
     *    读者是排障的人，不是摘要函数。
     *  - 重算摘要需要读到 `blobs.size`（摘要覆盖了 `before_size` / `after_size`）。
     *    今天被修改集引用的 blob 不可能被回收（`change_items.new_blob_id` 是
     *    `ON DELETE RESTRICT`，且引用计数非零时 `markDeleted` 会拒绝），因此
     *    重算**目前**总是可行 —— 但这条可行性依赖 blob 回收策略的实现细节，
     *    而一份「批准绑定」的记录不该建立在另一个子系统的不变量上。
     *
     * 代价是一项新的失配可能：抄本与来源漂移。这一项由**触发器**消除，
     * 而不是由「写入方记得抄对」消除 —— 见下面的
     * `approvals_binding_matches_change`：抄错的批准根本写不进来。
     * 来源侧不可变（触发器钉住），因此不存在「抄的时候对、后来变了」。
     *
     * ## 默认值 0 的含义
     *
     * `ALTER TABLE ADD COLUMN` 要求一个常量默认值。0 不是合法代次
     * （`workspaces.generation` 有 `CHECK (generation >= 1)`），因此它
     * 只可能出现在「本迁移之前写入的行」上 —— 而 V1 尚无生产数据，
     * 唯一可能存在的是测试库里的行。**新写入的行一律由 `ApprovalsRepo`
     * 从 `changesets` 取真值**，抄错会被触发器拒绝。
     *
     * ## 为什么连 `approvals_immutable_binding` 一起重建
     *
     * 旧版的不可变清单里没有这两列，于是「写入后改掉代次」是一条通路。
     * SQLite 不支持修改触发器，只能删了重建 —— 这一条与 v2 重建 `workspaces`
     * 是同一类动作（模式变更只能靠重建表达），只是粒度小得多。
     */
    statements: [
      `ALTER TABLE approvals ADD COLUMN root_generation INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE approvals ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 0`,

      // 绑定字段的不可变清单随新列一起扩充：漏掉一列，那条通路就是打开的。
      `DROP TRIGGER approvals_immutable_binding`,
      `CREATE TRIGGER approvals_immutable_binding
         BEFORE UPDATE ON approvals
         WHEN NEW.change_id <> OLD.change_id
           OR NEW.digest <> OLD.digest
           OR NEW.actor <> OLD.actor
           OR NEW.root_generation <> OLD.root_generation
           OR NEW.policy_version <> OLD.policy_version
           OR NEW.created_at <> OLD.created_at
         BEGIN
           SELECT RAISE(ABORT, '批准的绑定字段不可变：批准与摘要必须精确绑定');
         END`,

      // 抄本必须等于来源。用 `IS NOT` 而不是 `<>`：修改集不存在时子查询是 NULL，
      // 而 `5 <> NULL` 是 NULL（不触发），`5 IS NOT NULL` 是真（触发）。
      // 也就是说这一条同时挡住了「绑一个不存在的修改集」。
      `CREATE TRIGGER approvals_binding_matches_change
         BEFORE INSERT ON approvals
         WHEN NEW.digest          IS NOT (SELECT digest          FROM changesets WHERE id = NEW.change_id)
           OR NEW.root_generation IS NOT (SELECT root_generation FROM changesets WHERE id = NEW.change_id)
           OR NEW.policy_version  IS NOT (SELECT policy_version  FROM changesets WHERE id = NEW.change_id)
         BEGIN
           SELECT RAISE(ABORT, '批准必须精确绑定修改集当时的摘要、资源根代次与策略版本');
         END`,
    ],
  },
  {
    version: 6,
    name: 'workspace_write_slots',

    /**
     * 写执行槽（LWB-026 步骤 1）。
     *
     * ## 主键是**物理身份**，不是 workspace_id、别名或路径
     *
     * 验收标准 2 的原文是「不同连接的任务也共享物理工作区执行约束」。
     * 这句话规定的是**约束的键**：它必须由「这是哪一块盘上的哪一个目录对象」
     * 决定，而不是由「谁在写」或「登记时叫什么」决定。
     *
     * 因此主键是 `(volume_id, root_file_id)` —— 两者都由
     * `GetFileInformationByHandle` 类的系统调用得来（见 I05/I03：
     * 路径字符串不是身份）。三个后果值得写下来：
     *
     *  - 两个连接、两份授权、甚至两行工作区记录，只要指向同一个物理目录，
     *    就撞同一个主键。**约束不按连接分裂**，这正是验收标准 2 要的性质。
     *  - 换名字、改大小写、把 `workspace_id` 换个写法，主键都不动 ——
     *    因为这些都不是身份。
     *  - `workspace_id` 仍然落库，但它只是**可读性**：排障时想知道
     *    「这块地被谁占着」不必再查一次工作区表。它**不参与**唯一性。
     *
     * `workspaces` 表本已有 `workspaces_identity_uq (volume_id, root_file_id)`，
     * 也就是说同一物理目录不可能有两行工作区。那么本表的主键是不是多余的？
     * 不是：**唯一索引保证的是「不会有第二行工作区」，本表保证的是
     * 「不会有第二次同时进行的写入」**。即便将来工作区记录可以被重定位或
     * 一目录多记录，本表这一条仍然成立。
     *
     * ## 为什么槽要**落库**，而不是一个进程内的 `Map`
     *
     * 验收标准 3 问的是「旧执行器**未退出**时，心跳超时能不能启动新执行器」。
     * 这个问题只在**进程重启**之后才有意义 —— 一个进程内 `Map` 在重启时
     * 连同答案一起消失，于是新进程看到的永远是「没有人在写」。
     * 心跳超时因此必须有一个**比进程活得久**的记录，才能被判定为
     * 「超时了，但持有者是不是真的没了」。
     *
     * ## 租约字段与「阻断」字段的区别
     *
     * `expires_at` 只表示「这段时间内没有收到续约」，**不表示**持有者已死
     * （见 `packages/ipc/src/lease.ts` 里的完整理由）。因此判定接管还要
     * 用 `holder_pid` + `holder_started_at` 去问系统。
     *
     * 判定不出「确定已经退出」时，本行**留在表里**并带上 `blocked_at`：
     * 这就是 LWB-026 步骤 3 的「原生进程状态不明时先阻断工作区」。
     * 阻断行不会被接管（只有 `blocked_at IS NULL` 的行才会被改写），
     * 只能由恢复流程（LWB-030）或持有者自己正常收尾来解除 ——
     * 而**不是**由「等一会儿再试一次」解除。
     *
     * ## 两个约束的用途
     *
     * - `workspace_write_slots_operation_uq`：一次操作只占一块地。少了它，
     *   同一个操作可以被认领两次，而两次认领的栅栏令牌不同 ——
     *   现象是执行器自己把自己判成「已被接管」。
     * - 阻断字段的成对 CHECK：只有原因没有时刻（或反过来）是一行
     *   说不清来历的记录，而它恰恰是排障时最需要说清的那一行。
     */
    statements: [
      `CREATE TABLE workspace_write_slots (
         volume_id         TEXT NOT NULL,
         root_file_id      TEXT NOT NULL,
         workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
         operation_id      TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
         executor_id       TEXT NOT NULL,
         fencing_token     INTEGER NOT NULL CHECK (fencing_token >= 1),
         holder_pid        INTEGER NOT NULL CHECK (holder_pid > 0),
         holder_started_at TEXT,
         acquired_at       TEXT NOT NULL,
         heartbeat_at      TEXT NOT NULL,
         expires_at        TEXT NOT NULL,
         blocked_at        TEXT,
         blocked_reason    TEXT,
         CHECK ((blocked_at IS NULL) = (blocked_reason IS NULL)),
         PRIMARY KEY (volume_id, root_file_id)
       )`,

      // 一次操作只占一块地。见上方说明。
      `CREATE UNIQUE INDEX workspace_write_slots_operation_uq
         ON workspace_write_slots(operation_id)`,

      // 「现在有哪些地正被占着 / 被阻断」是启动恢复与排障最常问的一句，
      // 而它按主键查不到（主键要从工作区行反推）。这一条让它变成一次索引扫。
      `CREATE INDEX workspace_write_slots_blocked_idx
         ON workspace_write_slots(blocked_at)`,
    ],
  },
  {
    version: 7,
    name: 'recovery_authorizations',

    /**
     * 本地恢复授权（LWB-030 步骤 4：「恢复写入需要本地恢复授权」）。
     *
     * ## 为什么**不**复用 `approvals`
     *
     * 两者都是「一次性、有期限、绑定唯一摘要」的本地操作者决定，形状相同。
     * 但它们的**摘要绑定的对象不同**，而那个差别正是各自的安全性质：
     *
     *  - 批准绑定的是**修改集摘要** —— 「我同意把这组改动应用上去」。
     *    它在写入**之前**签发，其摘要由计划内容算出，与磁盘当前状态无关。
     *  - 恢复授权绑定的是**恢复计划摘要** —— 「我同意把现在这些字节收回去」。
     *    它在写入**之前**签发，其摘要由**刚刚观测到的磁盘状态**算出
     *    （逐条目的 `observed_file_id` / `observed_sha256` 与判定结果）。
     *
     * 后者的意义在于：**磁盘一变，摘要就变，授权立刻失去效力。** 这是
     * 「授权之后、执行之前，用户又编辑了那个文件」这一格的防线，而它
     * 恰恰不能靠复用一个按计划内容算摘要的表来得到。
     *
     * 复用还会在 `approvals` 上引入第二种 `change_id` 语义，而
     * `approvals_active_uq`（同一个修改集同时只有一个有效批准）是照着
     * 单一语义写的。宁多一张表，不把两个问题塞进同一个唯一索引。
     *
     * ## `volume_id` / `root_file_id` 为什么落在授权行上
     *
     * 授权要能独立地说明「它授权的是哪一块物理工作区」。从 `operation_id`
     * 反推要经过 `changesets`，而那一刻我们想要的是一个**可以在执行时
     * 重新核对**的身份 —— 路径字符串不是身份（I05/I03），因此这里存的是
     * 物理身份，执行前与 `workspace_write_slots` 的主键比对。
     *
     * ## `actor_kind` 只有一个取值
     *
     * 与 `approvals` 同一条：恢复授权**只能**由本机操作者签发。
     * 一个 CHECK 而不是一句注释，是因为将来有人加第二个取值时，
     * 应当是一次编译/迁移上的有意决定，而不是一次静默的放宽。
     */
    statements: [
      `CREATE TABLE recovery_authorizations (
         id           TEXT PRIMARY KEY,
         operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
         workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
         volume_id    TEXT NOT NULL,
         root_file_id TEXT NOT NULL,
         decision     TEXT NOT NULL CHECK (decision IN (${sqlList(FROZEN_RECOVERY_DECISIONS)})),
         digest       TEXT NOT NULL CHECK (length(digest) = 64),
         actor        TEXT NOT NULL,
         actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('local_operator')),
         expires_at   TEXT NOT NULL,
         state        TEXT NOT NULL CHECK (state IN ('ACTIVE','CONSUMED','REVOKED','EXPIRED')),
         consumed_at  TEXT,
         created_at   TEXT NOT NULL
       )`,

      // 同一个操作同时只能存在一个有效授权。与 `approvals_active_uq` 同形，
      // 防的也是同一件事：一次授权被两个执行者各用一次。
      `CREATE UNIQUE INDEX recovery_authorizations_active_uq
         ON recovery_authorizations(operation_id) WHERE state = 'ACTIVE'`,

      // 排障与启动清理问的是「现在还有哪些有效授权」。
      `CREATE INDEX recovery_authorizations_state_idx
         ON recovery_authorizations(state, expires_at)`,

      `CREATE TRIGGER recovery_authorizations_no_reactivate
         BEFORE UPDATE ON recovery_authorizations
         WHEN OLD.state <> 'ACTIVE' AND NEW.state = 'ACTIVE'
         BEGIN
           SELECT RAISE(ABORT, '恢复授权不得从非 ACTIVE 状态退回 ACTIVE');
         END`,

      `CREATE TRIGGER recovery_authorizations_immutable_binding
         BEFORE UPDATE ON recovery_authorizations
         WHEN NEW.operation_id <> OLD.operation_id
           OR NEW.workspace_id <> OLD.workspace_id
           OR NEW.volume_id <> OLD.volume_id
           OR NEW.root_file_id <> OLD.root_file_id
           OR NEW.decision <> OLD.decision
           OR NEW.digest <> OLD.digest
           OR NEW.actor <> OLD.actor
           OR NEW.created_at <> OLD.created_at
         BEGIN
           SELECT RAISE(ABORT, '恢复授权的绑定字段不可变：授权必须精确绑定到操作、物理工作区与计划摘要');
         END`,
    ],
  },
  {
    version: 8,
    name: 'service_pause',

    /**
     * 全局暂停的**唯一持久事实**（LWB-034 步骤 1、3）。
     *
     * ## 为什么它必须落库，而不是一个进程内的布尔值
     *
     * 「紧急停用」是操作者在认定出问题的那一刻按下的。如果它只活在内存里，
     * 那么一次崩溃重启就会把它**静默地**清掉 —— 操作者以为服务停着，
     * 而它已经可以接受新读取与新应用了。那是这一格最坏的失效方向：
     * 一个**忘记自己停过**的安全动作，比没有这个动作更危险，
     * 因为它会让人以为已经按过了。
     *
     * 落库还让「谁在报告暂停」只有一个来源。工具面的 `bridge_status`
     * 与控制台的暂停状态如果各读各的（一个读内存、一个读库），
     * 两者迟早会在某一格上分叉，而分叉的那一格正好是操作者去看答案的那一格。
     *
     * ## 为什么是单行表，而 `id = 1` 是一个 CHECK
     *
     * 这里存的是**当前状态**，不是历史 —— 每一次暂停与恢复的完整记录在
     * `audit_events` 里（`service.pause` / `service.resume`），那里有序列、
     * 有主体、有结果。把历史也放进这张表会造出第二份「发生过什么」，
     * 而两份记录一定会在某一天不一致。
     *
     * `CHECK (id = 1)` 让「第二行」在**数据库层**就是写不进去的。
     * 一个靠「代码里只 INSERT 一次」维持的单行表，会在某个恢复脚本里
     * 长出第二行，而那时读它的人拿到哪一行取决于 `ORDER BY`。
     *
     * ## 行可以不存在，而且「不存在」有确切含义
     *
     * 这台机器从来没有被暂停过 —— 与「暂停过、已恢复」不同（那一行会留下
     * `updated_at`）。迁移**不播种**初始行：一条播种用的语句需要一个时间戳，
     * 而迁移文本是冻结的（它的 sha256 存在 `schema_migrations` 里、
     * 每次打开都要比对），把某个具体时刻冻进迁移里会是一句关于这台机器的
     * 假话。因此「没有行」就是它的初值，由 `ServicePauseRepo.current()` 表达。
     *
     * ## 那个 CHECK 说的是「两个字段要么一起有、要么一起没有」
     *
     * `(paused = 1) = (paused_at IS NOT NULL)`：暂停中必定有一个起始时刻，
     * 而没有起始时刻就必定不在暂停中。它挡的是最容易被顺手写出来的那一种
     * 半成品 —— 把 `paused` 置 0 却忘了清 `paused_at`，
     * 于是界面上显示「未暂停，上次暂停于 …」，而那个时刻是上一次的。
     *
     * ## 只有四列，而且每一列都有人读
     *
     * 最初这里还有一个 `reason TEXT`（「操作者为什么按它」）。它被删掉了，
     * 理由值得写下来，因为那一列看起来完全无害：
     *
     *  - **没有判据读它。** 暂停的判据是 `paused` 一个布尔值；
     *    「为什么」不影响任何一次放行或阻断。一个不影响判据、只在界面上
     *    好看的字段，是下一处「保留着吧，说不定有用」的开始。
     *  - **它是自由文本，而这张表与审计同文件。** 操作者在紧急时刻写的
     *    多半正是「D:\work\foo.ts 被写坏了」—— 也就是一条本机绝对路径。
     *    本工程其余所有写进这个库的字符串都过一道筛查（`screenMetadata`），
     *    而一个「只有人看、不参与判定」的字段最容易逃过那道筛查。
     *    与其给它加一道筛查，不如不要它。
     *  - **它会让紧急按钮变慢。** 一个输入框意味着操作者要先把字打完。
     *    要记「为什么」，审计里有序列、有主体、有结果的记录，
     *    而那是操作者事后写下的话，不是按下按钮前必须填的一栏。
     *
     * `updated_at` 留下的是「这张表最后一次被写的时刻」，
     * 它与 `paused_at` 不同：一次恢复会把 `paused_at` 清成 `NULL`
     * 而把 `updated_at` 推进，于是「从来没过暂停」与「暂停过又恢复了」
     * 在读出来的值上**不同** —— 界面需要能说出这个差别（见 `ServicePauseRepo`）。
     */
    statements: [
      `CREATE TABLE service_pause (
         id         INTEGER PRIMARY KEY CHECK (id = 1),
         paused     INTEGER NOT NULL CHECK (paused IN (0, 1)),
         paused_at  TEXT,
         updated_at TEXT NOT NULL,
         CHECK ((paused = 1) = (paused_at IS NOT NULL))
       )`,
    ],
  },
];

/** 本程序能理解的最高模式版本。高于它的数据库必须被拒绝打开。 */
export const KNOWN_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * 迁移文本的校验和。
 *
 * 覆盖版本、名称与全部语句：只要已发布的迁移被改动一个字符，
 * 既有数据库在下次打开时就会因校验和不符而被拒绝，
 * 而不是带着不确定的模式继续跑。
 */
export function migrationChecksum(migration: Migration): string {
  const payload = `${migration.version}\u0000${migration.name}\u0000${migration.statements.join('\u0000')}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
