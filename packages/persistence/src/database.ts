/**
 * 数据库打开与迁移运行器（LWB-006）。
 *
 * 本文件承担的是**失败即拒绝**的职责：
 *
 *  - 迁移失败绝不返回一个「空但可用」的库；
 *  - 库的模式版本高于本程序所知时拒绝打开（旧程序不得对着新库跑）；
 *  - 已应用迁移的校验和必须与当前代码一致；
 *  - PRAGMA 生效值必须**实测核对**，而不是"设了就算"。
 *
 * 关于事务边界（方案 §9）：
 * 下面的 `withImmediateTransaction` 只覆盖 SQLite 自身的原子提交，
 * **不**扩展到用户工作区文件。跨文件写入不是 ACID，任何 API 命名都不得暗示相反。
 */

import { BridgeError } from '@lwb/contracts';
import Database from 'better-sqlite3';

import { KNOWN_SCHEMA_VERSION, MIGRATIONS, migrationChecksum, type Migration } from './migrations.ts';

/** better-sqlite3 以 `export =` 导出类；用实例类型而不是命名空间查询，避免导入形态依赖。 */
export type SqliteDatabase = InstanceType<typeof Database>;

/** `PRAGMA synchronous` 的数值编码。 */
const SYNCHRONOUS_FULL = 2;

export interface OpenDatabaseOptions {
  /** 文件路径；测试可用 `:memory:`。 */
  readonly path: string;
  /**
   * 忙等上限（毫秒）。有界：超时后返回 SQLITE_BUSY，
   * 由上层转成 WORKSPACE_BUSY / STORAGE_UNAVAILABLE，
   * 而不是无限等待把 daemon 挂死。
   */
  readonly busyTimeoutMs?: number;
  readonly readonly?: boolean;
  /** 仅供测试：允许在 `:memory:` 之外的库上跳过 WAL 断言。 */
  readonly allowNonWal?: boolean;
}

export interface OpenDatabaseResult {
  readonly db: SqliteDatabase;
  /** 本次打开实际应用的模式版本。 */
  readonly schema_version: number;
  readonly applied_migrations: readonly number[];
  /** 实测 PRAGMA 生效值，便于审计与排障。 */
  readonly pragmas: Readonly<Record<string, string | number>>;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** 迁移/打开阶段的故障统一归类为「存储不可用」，语义是停止写入并保留现场。 */
function storageError(message: string, details?: Record<string, string | number | boolean | null>): BridgeError {
  return new BridgeError('STORAGE_UNAVAILABLE', message, details);
}

function isMemory(path: string): boolean {
  return path === ':memory:' || path.startsWith('file::memory:');
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

function readAppliedMigrations(db: SqliteDatabase): AppliedMigrationRow[] {
  return db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
    .all() as AppliedMigrationRow[];
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

/** 除 SQLite 自身的表之外，库里是否已有任何用户表。 */
function existingUserTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function assertAppliedChecksums(applied: readonly AppliedMigrationRow[]): void {
  const known = new Map(MIGRATIONS.map((m) => [m.version, m]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      // 库里有本程序不认识的版本：旧程序不得对着新库跑。
      throw storageError('数据库包含本程序未知的模式版本，已拒绝打开。', {
        found_version: row.version,
        supported_version: KNOWN_SCHEMA_VERSION,
      });
    }
    const expected = migrationChecksum(migration);
    if (expected !== row.checksum) {
      throw storageError('已应用的迁移文本与当前程序不一致，已拒绝打开以免模式漂移。', {
        version: row.version,
        recorded_checksum: row.checksum,
        computed_checksum: expected,
      });
    }
  }
}

/**
 * 逐条应用未执行的迁移。
 *
 * 每条迁移在**自己的事务**中执行：SQLite 的 DDL 是事务性的，
 * 因此失败会整体回滚，不会留下「表建了一半」的模式。
 * 任一条失败即抛出，调用方不得继续使用该连接。
 */
function runMigrations(db: SqliteDatabase, applied: readonly AppliedMigrationRow[]): number[] {
  const done = new Set(applied.map((r) => r.version));
  const executed: number[] = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;

    const apply = db.transaction((m: Migration) => {
      for (const statement of m.statements) {
        db.exec(statement);
      }

      // 表重建期间外键是关闭的，没人替我们检查引用是否还成立。
      // 这条复验**必须在事务内**：放到事务外的话，抛错时迁移已经提交，
      // 回滚不了 —— 那就成了「报了错但库已经坏了」。
      if (m.requires_foreign_keys_off === true) {
        const orphans = db.pragma('foreign_key_check') as unknown[];
        if (orphans.length > 0) {
          throw new Error(`表重建后外键复验发现 ${orphans.length} 条悬空引用，拒绝提交该迁移。`);
        }
      }

      // 记录语句必须在语句执行**之后**才准备：
      // v1 的第一条语句才创建 schema_migrations，提前 prepare 会直接抛错。
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.version, m.name, migrationChecksum(m), new Date().toISOString());
    });

    // `PRAGMA foreign_keys` 在事务内是静默无效的，因此必须在事务**外**切换。
    // 表重建（DROP + RENAME）在没有这一步时会被 `ON DELETE RESTRICT` 中止 ——
    // 而且中止发生在迁移中途，只留下一条回滚记录，原因不容易看出来。
    const needsForeignKeysOff = migration.requires_foreign_keys_off === true;
    if (needsForeignKeysOff) db.pragma('foreign_keys = OFF');

    try {
      apply.immediate(migration);
    } catch (cause) {
      throw storageError(`迁移 v${migration.version} (${migration.name}) 执行失败，已回滚。`, {
        version: migration.version,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (needsForeignKeysOff) db.pragma('foreign_keys = ON');
    }
    executed.push(migration.version);
  }

  return executed;
}

// ---------------------------------------------------------------------------
// PRAGMA 核对
// ---------------------------------------------------------------------------

function pragmaValue(db: SqliteDatabase, name: string): string | number {
  const row = db.pragma(name, { simple: true }) as string | number;
  return row;
}

/**
 * 设置并**实测**关键 PRAGMA。
 *
 * 只设置不核对是不够的：例如 WAL 在不支持它的文件系统上会被静默忽略、
 * 连接仍是 delete 日志模式，而调用方以为已经拿到了 WAL 的并发与耐久语义。
 */
function configurePragmas(
  db: SqliteDatabase,
  opts: Required<Pick<OpenDatabaseOptions, 'busyTimeoutMs' | 'readonly' | 'allowNonWal'>>,
  memory: boolean,
): Record<string, string | number> {
  const observed: Record<string, string | number> = {};

  // 外键是**每连接**设置，且默认关闭。不设置则所有 REFERENCES 形同注释。
  // 只读连接同样要开：读路径也要能发现被破坏的引用。
  db.pragma('foreign_keys = ON');
  observed.foreign_keys = pragmaValue(db, 'foreign_keys');
  if (observed.foreign_keys !== 1) {
    throw storageError('无法启用外键约束（foreign_keys 未生效），已拒绝打开。', {
      foreign_keys: observed.foreign_keys,
    });
  }

  // WAL 在只读连接上无法切换，此时只读取实际值。
  if (!opts.readonly) {
    try {
      db.pragma('journal_mode = WAL');
    } catch (cause) {
      throw storageError('无法切换到 WAL 日志模式。', {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  observed.journal_mode = String(pragmaValue(db, 'journal_mode')).toLowerCase();
  const expectedJournal = memory ? 'memory' : 'wal';
  if (!opts.allowNonWal && observed.journal_mode !== expectedJournal) {
    throw storageError(
      memory
        ? '内存库的日志模式异常。'
        : '该路径不支持 WAL 日志模式（可能是网络盘或非 NTFS 卷），已拒绝打开。',
      { journal_mode: observed.journal_mode, expected: expectedJournal },
    );
  }

  // synchronous=FULL：WAL 下每次提交都对 WAL 做 fsync。
  // 状态库承载批准与操作日志，"断电后丢了已提交的批准"是不可接受的失败模式，
  // 因此这里不接受 NORMAL 的性能换耐久折中。
  if (!opts.readonly) db.pragma('synchronous = FULL');
  observed.synchronous = pragmaValue(db, 'synchronous');
  if (observed.synchronous !== SYNCHRONOUS_FULL) {
    throw storageError('synchronous 未达到 FULL，已拒绝打开。', {
      synchronous: observed.synchronous,
    });
  }

  db.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
  observed.busy_timeout = pragmaValue(db, 'busy_timeout');
  if (observed.busy_timeout !== opts.busyTimeoutMs) {
    throw storageError('busy_timeout 未生效，已拒绝打开（不接受无限等待）。', {
      busy_timeout: observed.busy_timeout,
      expected: opts.busyTimeoutMs,
    });
  }

  return observed;
}

// ---------------------------------------------------------------------------
// 打开
// ---------------------------------------------------------------------------

/**
 * 打开状态库并把模式迁移到本程序已知的版本。
 *
 * 失败一律抛 BridgeError(STORAGE_UNAVAILABLE)，**不返回任何可用的连接**。
 * 上层收到该错误时必须停止写入并保留现场，而不是新建一个空库继续服务。
 */
export function openDatabase(options: OpenDatabaseOptions): OpenDatabaseResult {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const readonly = options.readonly ?? false;
  const allowNonWal = options.allowNonWal ?? false;
  const memory = isMemory(options.path);
  const settings = { busyTimeoutMs, readonly, allowNonWal };

  let db: SqliteDatabase;
  try {
    db = new Database(options.path, { readonly });
  } catch (cause) {
    throw storageError('无法打开状态库。', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }

  try {
    if (!readonly) {
      // 先设忙等：迁移本身也可能与另一个进程竞争。
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      db.pragma('foreign_keys = ON');
    }

    const hasMigrationTable = tableExists(db, 'schema_migrations');
    const userTables = existingUserTables(db);

    if (!hasMigrationTable && userTables.length > 0) {
      // 有表却没有迁移记录：这不是本程序的库，或迁移记录被破坏。
      // 两种情况都不能"自动修复"，那等于猜用户的数据。
      throw storageError('状态库中已有表但缺少迁移记录，已拒绝打开。', {
        tables: userTables.join(','),
      });
    }

    const applied = hasMigrationTable ? readAppliedMigrations(db) : [];
    assertAppliedChecksums(applied);

    const executed = runMigrations(db, applied);
    const currentVersion = Math.max(0, ...readAppliedMigrations(db).map((r) => r.version));

    if (currentVersion > KNOWN_SCHEMA_VERSION) {
      throw storageError('状态库的模式版本高于本程序支持的版本，已拒绝打开。', {
        found_version: currentVersion,
        supported_version: KNOWN_SCHEMA_VERSION,
      });
    }

    const pragmas = configurePragmas(db, settings, memory);

    return {
      db,
      schema_version: currentVersion,
      applied_migrations: executed,
      pragmas,
    };
  } catch (cause) {
    try {
      db.close();
    } catch {
      // 关闭失败不覆盖原始错误：原始错误才是可行动的信息。
    }
    // readonly 连接不写盘；仅当确认是本程序可识别的空库时也不删除文件——
    // 删除用户数据文件是比"留下一个空库"严重得多的错误。
    throw cause instanceof BridgeError
      ? cause
      : storageError('状态库初始化失败。', {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
  }
}

/**
 * 在**立即**事务中执行 fn。
 *
 * 立即（`BEGIN IMMEDIATE`）而不是默认的延迟事务：延迟事务在第一次写之前
 * 只持有读锁，两个进程可能同时读到旧值、随后在升级写锁时死锁或得到 SQLITE_BUSY。
 * 状态库里"先读再写"的判定（例如批准是否仍有效、操作是否已存在）必须原子，
 * 因此从一开始就拿写锁。
 *
 * **边界**：本事务只覆盖 SQLite 的提交，不覆盖用户工作区文件。
 * 函数在事务内做文件写入不会因为 SQLite 回滚而撤销，这种用法是禁止的。
 */
export function withImmediateTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  const run = db.transaction(fn);
  return run.immediate();
}

/** 关闭连接；幂等。 */
export function closeDatabase(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // 已关闭的连接再关一次不应让调用方崩溃。
  }
}
