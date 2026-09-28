/**
 * 状态库测试（LWB-006）。
 *
 * 覆盖的不是「CRUD 能跑」，而是方案里那些**必须由数据库本身兜底**的性质：
 * 内容不可变、终态墓碑、一个修改集一个操作、幂等键冲突不覆盖、
 * 迁移失败不产生可用空库、模式版本过新拒绝启动、WAL/同步级别的**实测值**。
 *
 * 约定：断言失败信息里带上实际值，避免"assert 失败但不知道实际是什么"。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  CHANGE_STATE_LABELS,
  TERMINAL_CHANGE_STATES,
  BridgeError,
  type ChangeSetState,
} from '@lwb/contracts';
import {
  FROZEN_CHANGE_STATES,
  FROZEN_ITEM_RESULT_STATES,
  FROZEN_OPERATION_STATES,
  FROZEN_TOMBSTONE_CHANGE_STATES,
  KNOWN_SCHEMA_VERSION,
  MIGRATIONS,
  Repositories,
  closeDatabase,
  migrationChecksum,
  openDatabase,
  withImmediateTransaction,
  type OpenDatabaseResult,
  type SqliteDatabase,
} from '@lwb/persistence';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const HEX64 = 'a'.repeat(64);

function expectBridgeError(code: string, fn: () => unknown, hint = ''): BridgeError {
  try {
    fn();
  } catch (cause) {
    assert.ok(cause instanceof BridgeError, `${hint} 应抛 BridgeError，实际：${String(cause)}`);
    assert.equal(cause.code, code, `${hint} 的错误码：${cause.code}`);
    return cause;
  }
  assert.fail(`${hint} 应当抛出 ${code}，但没有抛错`);
}

/** 建立一套最小可用的前置数据：连接 + 工作区 + 两个 blob + 一个修改集。 */
function seed(repos: Repositories, opts: { expiresAt?: string; paths?: string[] } = {}) {
  const connection = repos.connections.create({
    id: 'conn_test',
    principal_kind: 'model_surface',
    principal_id: 'principal_test',
    alias: 'test',
    enabled: true,
  });

  const workspace = repos.workspaces.create({
    id: 'ws_test',
    alias: 'fixtures',
    kind: 'directory',
    canonical_root: 'D:\\fixtures',
    volume_id: '1a2b3c4d',
    root_file_id: '0123456789abcdef',
    policy_version: 1,
    mode: 'read_propose_apply_with_local_approval',
  });

  const oldBlob = repos.blobs.ensure({
    id: 'blob_old',
    sha256: 'b'.repeat(64),
    size: 10,
    storage_ref: 'blobs/bb/bbbb',
  });
  const newBlob = repos.blobs.ensure({
    id: 'blob_new',
    sha256: 'c'.repeat(64),
    size: 20,
    storage_ref: 'blobs/cc/cccc',
  });

  const paths = opts.paths ?? ['src/main.ts'];
  const change = repos.changes.create({
    id: 'chg_test',
    owner_connection_id: connection.id,
    workspace_id: workspace.id,
    root_generation: workspace.generation,
    policy_version: workspace.policy_version,
    contract_version: '0.1.0',
    digest: HEX64,
    summary: '测试修改集',
    expires_at: opts.expiresAt ?? '2099-01-01T00:00:00.000Z',
    items: paths.map((p, i) => ({
      id: `item_${i}`,
      path: p,
      op: 'edit_text' as const,
      base_file_id: '0123456789abcdef',
      base_sha256: 'b'.repeat(64),
      target_sha256: 'c'.repeat(64),
      old_blob_id: oldBlob.blob.id,
      new_blob_id: newBlob.blob.id,
      encoding: 'utf-8' as const,
      bom: false,
      newline: 'lf' as const,
      added_lines: 1,
      removed_lines: 2,
    })),
  });

  return { connection, workspace, change, oldBlob: oldBlob.blob, newBlob: newBlob.blob };
}

describe('LWB-006 冻结枚举与契约一致', () => {
  it('冻结的修改集状态集合等于契约当前定义', () => {
    const contractStates = Object.keys(CHANGE_STATE_LABELS).sort();
    assert.deepEqual([...FROZEN_CHANGE_STATES].sort(), contractStates);
  });

  it('冻结的终态集合等于契约的终态定义', () => {
    assert.deepEqual(
      [...FROZEN_TOMBSTONE_CHANGE_STATES].sort(),
      [...TERMINAL_CHANGE_STATES].sort(),
    );
  });

  it('操作状态与逐文件结果状态都被冻结，且逐文件结果含 UNKNOWN', () => {
    assert.ok(FROZEN_OPERATION_STATES.length > 0);
    assert.ok(
      FROZEN_ITEM_RESULT_STATES.includes('UNKNOWN'),
      '未知结果必须可表达，不能并入成功',
    );
  });
});

describe('LWB-006 打开与迁移', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-persistence-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('内存库：迁移成功、实测 PRAGMA 生效、重复打开不重复应用', () => {
    const opened = openDatabase({ path: ':memory:' });
    try {
      assert.equal(opened.schema_version, KNOWN_SCHEMA_VERSION);
      assert.deepEqual(
        opened.applied_migrations,
        MIGRATIONS.map((m) => m.version),
        '空库必须把所有迁移按序应用一遍',
      );
      assert.equal(opened.pragmas['foreign_keys'], 1, '外键必须真的开启');
      assert.equal(opened.pragmas['synchronous'], 2, 'synchronous 必须是 FULL');
      // 内存库没有 WAL：这里断言的是**实测值**，而不是我们设了什么。
      assert.equal(opened.pragmas['journal_mode'], 'memory');
      assert.equal(opened.pragmas['busy_timeout'], 5000);

      const again = openDatabase({ path: ':memory:' });
      closeDatabase(again.db);
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('文件库：实际进入 WAL 模式', () => {
    const file = path.join(dir, 'wal.db');
    const opened = openDatabase({ path: file });
    try {
      assert.equal(opened.pragmas['journal_mode'], 'wal', '文件库必须真的进入 WAL');
      assert.equal(opened.schema_version, KNOWN_SCHEMA_VERSION);
    } finally {
      closeDatabase(opened.db);
    }

    // 第二次打开：不重复应用迁移，也不因校验和比对而失败。
    const reopened = openDatabase({ path: file });
    try {
      assert.deepEqual(reopened.applied_migrations, [], '已应用的迁移不得重复执行');
      assert.equal(reopened.schema_version, KNOWN_SCHEMA_VERSION);
    } finally {
      closeDatabase(reopened.db);
    }

    // 内存库在 `:memory:` 之外也必须走真实文件，这里确认文件确实被创建。
    const raw = new Database(file, { readonly: true });
    const versions = raw
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    raw.close();
    assert.deepEqual(
      versions.map((v) => v.version),
      MIGRATIONS.map((m) => m.version),
    );
  });

  it('v1 → v2 表重建：既有数据必须逐列存活，外键不得悬空', () => {
    // 这是 v2 唯一真正危险的地方。SQLite 改不了 CHECK 约束，只能
    // 建新表 → 复制 → 删旧表 → 改名。任何一步写错都会**静默丢数据**，
    // 而且因为外键在重建期间是关闭的，数据库自己不会报错。
    // 因此必须用一个真的 v1 库（含跨表引用的行）来验，而不是验空库升级。
    const file = path.join(dir, 'upgrade-v1.db');
    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    const v1 = MIGRATIONS.find((m) => m.version === 1);
    assert.ok(v1, '必须存在 v1 迁移');
    for (const statement of v1.statements) raw.exec(statement);
    raw
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)')
      .run(1, v1.name, migrationChecksum(v1), new Date().toISOString());

    // 用 v1 的列集合写入一行工作区，以及引用它的连接 / 授权 / 修改集。
    raw
      .prepare(
        `INSERT INTO workspaces (id, alias, kind, canonical_root, volume_id, root_file_id,
                                 generation, policy_version, mode, enabled, created_at, updated_at)
         VALUES ('ws_v1','旧库','directory','D:\\old','aabbccdd','1122334455667788',
                 3, 2, 'read_only', 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO connections (id, principal_kind, principal_id, alias, enabled, generation,
                                  credential_ref, created_at, updated_at)
         VALUES ('conn_1','console','user:owner','c1',1,1,NULL,
                 '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO grants (id, connection_id, workspace_id, capabilities, enabled, created_at, updated_at)
         VALUES ('g1','conn_1','ws_v1','["read"]',1,
                 '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    raw.close();

    const opened = openDatabase({ path: file });
    try {
      // 期望值**从 MIGRATIONS 推导**，不写死版本号：写死的版本号会在每次
      // 新增迁移时被顺手改成新数字，而这条断言真正要证明的是
      // 「只补应用缺的那些，且一个不漏」—— 它不该需要有人去改它。
      const afterV1 = MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version);
      assert.equal(opened.schema_version, KNOWN_SCHEMA_VERSION);
      assert.deepEqual(opened.applied_migrations, afterV1, '只应补应用 v1 之后的迁移');
      assert.equal(opened.pragmas['foreign_keys'], 1, '迁移结束后外键必须重新开启');

      const repos = new Repositories(opened.db);
      const ws = repos.workspaces.requireById('ws_v1');
      // 逐字段比对，而不是只比 id —— 列错位正是 `SELECT *` 复制会犯的错。
      assert.deepEqual(
        {
          alias: ws.alias,
          kind: ws.kind,
          canonical_root: ws.canonical_root,
          volume_id: ws.volume_id,
          root_file_id: ws.root_file_id,
          generation: ws.generation,
          policy_version: ws.policy_version,
          mode: ws.mode,
          enabled: ws.enabled,
          created_at: ws.created_at,
          updated_at: ws.updated_at,
        },
        {
          alias: '旧库',
          kind: 'directory',
          canonical_root: 'D:\\old',
          volume_id: 'aabbccdd',
          root_file_id: '1122334455667788',
          generation: 3,
          policy_version: 2,
          mode: 'read_only',
          enabled: true,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      );

      // 跨表引用必须仍然有效（重建期间外键是关的，只有 foreign_key_check 能发现悬空）。
      const raw2 = new Database(file, { readonly: true });
      const violations = raw2.pragma('foreign_key_check') as unknown[];
      raw2.close();
      assert.deepEqual(violations, [], '重建后不得有悬空引用');

      // 唯一索引必须被重建，否则「同一物理目录登记两次」会静默成功。
      assert.throws(() =>
        repos.workspaces.create({
          id: 'ws_dup2',
          alias: '另一个',
          kind: 'directory',
          canonical_root: 'D:\\OLD',
          volume_id: 'ffffffff',
          root_file_id: 'ffffffffffffffff',
          policy_version: 1,
          mode: 'read_only',
        }),
      );

      // 而现在 'file' 必须被接受 —— 这正是 v2 存在的理由。
      const single = repos.workspaces.create({
        id: 'ws_file',
        alias: '单文件',
        kind: 'file',
        canonical_root: 'D:\\old\\only.txt',
        volume_id: 'aabbccdd',
        root_file_id: '99aabbccddeeff00',
        policy_version: 1,
        mode: 'read_only',
      });
      assert.equal(single.kind, 'file');
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('v1 模式下 kind 只接受 directory（v2 的约束确实收紧了范围）', () => {
    // 反向确认：CHECK 约束不是摆设。写一个非法 kind 必须被数据库拒绝，
    // 而不是被应用层的 TypeScript 类型挡住就以为安全了 ——
    // 类型在运行时不存在，数据库约束才是最后一道。
    const opened = openDatabase({ path: ':memory:' });
    try {
      const raw = opened.db as unknown as {
        prepare(sql: string): { run(...args: unknown[]): unknown };
      };
      assert.throws(
        () =>
          raw
            .prepare(
              `INSERT INTO workspaces (id, alias, kind, canonical_root, volume_id, root_file_id,
                                       generation, policy_version, mode, enabled, created_at, updated_at)
               VALUES ('x','x','socket','D:\\x','v','f',1,1,'read_only',1,'t','t')`,
            )
            .run(),
        /CHECK constraint failed|constraint/i,
      );
    } finally {
      closeDatabase(opened.db);
    }
  });

  it('既有表却缺少迁移记录：拒绝打开，而不是当成空库', () => {
    const file = path.join(dir, 'foreign.db');
    const raw = new Database(file);
    raw.exec('CREATE TABLE somebody_elses_table (x INTEGER)');
    raw.close();

    expectBridgeError(
      'STORAGE_UNAVAILABLE',
      () => openDatabase({ path: file }),
      '外来库',
    );
  });

  it('已应用迁移的文本被改动（校验和不符）：拒绝打开', () => {
    const file = path.join(dir, 'tampered.db');
    const first = openDatabase({ path: file });
    closeDatabase(first.db);

    const raw = new Database(file);
    raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('0'.repeat(64));
    raw.close();

    const error = expectBridgeError(
      'STORAGE_UNAVAILABLE',
      () => openDatabase({ path: file }),
      '校验和被篡改',
    );
    assert.match(String(error.details?.['computed_checksum']), /^[0-9a-f]{64}$/);
  });

  it('模式版本高于本程序：拒绝打开且逐字节保留（旧程序不得对着新库跑）', async () => {
    const file = path.join(dir, 'newer.db');
    const first = openDatabase({ path: file });
    closeDatabase(first.db);

    const raw = new Database(file);
    raw.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(99, 'from_the_future', 'f'.repeat(64), new Date().toISOString());
    raw.close();

    const before = await readFile(file);
    expectBridgeError('STORAGE_UNAVAILABLE', () => openDatabase({ path: file }), '未来版本库');
    const after = await readFile(file);
    assert.deepEqual(after, before, '拒绝启动不得迁移、截断或重建较新版本的状态库');
  });

  it('迁移中途失败：整体回滚，不留下半截模式', () => {
    const file = path.join(dir, 'halfmigrated.db');
    // 构造一个「迁移记录表存在但为空，且 v1 要建的某张表已存在」的库：
    // v1 在第 2 条语句就会撞上已存在的表而失败。
    const raw = new Database(file);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    raw.exec('CREATE TABLE connections (id TEXT PRIMARY KEY)');
    raw.close();

    expectBridgeError('STORAGE_UNAVAILABLE', () => openDatabase({ path: file }), '迁移失败');

    const verify = new Database(file, { readonly: true });
    const tables = (
      verify
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
    const appliedCount = (
      verify.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }
    ).n;
    verify.close();

    // 失败发生在 connections 之后：若没有回滚，blobs 等后续表会残留。
    assert.deepEqual(tables, ['connections', 'schema_migrations'], '失败后不得残留半截模式');
    assert.equal(appliedCount, 0, '失败的迁移不得留下版本记录');
  });

  it('busy_timeout 是有界的：另一个连接持写锁时不做无限等待', () => {
    const file = path.join(dir, 'busy.db');
    const holder = openDatabase({ path: file, busyTimeoutMs: 200 });
    const contender = openDatabase({ path: file, busyTimeoutMs: 200 });

    try {
      holder.db.exec('BEGIN IMMEDIATE');
      holder.db.prepare('INSERT INTO audit_events (subject, action, outcome, timestamp) VALUES (?, ?, ?, ?)').run(
        'busy',
        'test',
        'allow',
        new Date().toISOString(),
      );

      const repos = new Repositories(contender.db);
      const started = Date.now();
      // 断言错误**码**而不是错误文本：better-sqlite3 的 message 是
      // 「database is locked」，只有 code 才是稳定的 SQLITE_BUSY。
      assert.throws(
        () => repos.audit.append({ subject: 'busy', action: 'contender', outcome: 'allow' }),
        (cause: unknown) => (cause as { code?: string }).code === 'SQLITE_BUSY',
      );
      const elapsed = Date.now() - started;

      assert.ok(elapsed >= 150, `应至少等待一个 busy_timeout，实际 ${elapsed}ms`);
      assert.ok(elapsed < 5_000, `等待必须有界，实际 ${elapsed}ms`);

      holder.db.exec('COMMIT');
      // 释放后同一连接立刻可写：证明等待是「有界」而不是「永久锁死」。
      repos.audit.append({ subject: 'busy', action: 'after_release', outcome: 'allow' });
    } finally {
      closeDatabase(holder.db);
      closeDatabase(contender.db);
    }
  });

  it('已提交数据在进程被强制结束后仍然存在（synchronous=FULL）', () => {
    const file = path.join(dir, 'crash.db');
    const script = `
      const { openDatabase, Repositories } = await import('@lwb/persistence');
      const { db } = openDatabase({ path: ${JSON.stringify(file)} });
      const repos = new Repositories(db);
      repos.audit.append({ subject: 'crash-child', action: 'commit_then_die', outcome: 'allow' });
      // 刻意不 close、不做任何清理：模拟 daemon 被任务管理器结束。
      process.exit(70);
    `;

    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(child.status, 70, `子进程应被强制结束：${child.stdout}${child.stderr}`);

    const reopened = openDatabase({ path: file });
    try {
      const repos = new Repositories(reopened.db);
      const events = repos.audit.list();
      assert.equal(events.length, 1, '已提交的审计事件必须存活');
      assert.equal(events[0]?.subject, 'crash-child');
    } finally {
      closeDatabase(reopened.db);
    }
  });
});

describe('LWB-006 事务边界：SQLite 的原子提交不扩展到工作区文件', () => {
  let dir: string;
  const WORKSPACE_FILE = 'workspace-file.txt';

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lwb-txn-boundary-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * 这条用例把话说死：在 SQLite 事务里改文件，回滚**不会**撤销文件改动。
   * 它存在的意义是防止后续有人把「BEGIN IMMEDIATE」当成跨文件事务用。
   */
  it('回滚 SQLite 事务不会撤销已经落盘的文件改动', async () => {
    const dbFile = path.join(dir, 'state.db');
    const target = path.join(dir, WORKSPACE_FILE);
    await writeFile(target, '原始内容\n', 'utf8');

    const { db } = openDatabase({ path: dbFile });
    try {
      const repos = new Repositories(db);
      assert.throws(() =>
        withImmediateTransaction(db, () => {
          repos.audit.append({ subject: 'txn', action: 'write_then_abort', outcome: 'allow' });
          // 模拟「在事务里改了工作区文件」——这正是**禁止**的用法。
          writeFileSync(target, '事务中被改写的内容\n', 'utf8');
          throw new Error('模拟事务中途失败');
        }),
      );
    } finally {
      closeDatabase(db);
    }

    const reopened = openDatabase({ path: dbFile });
    try {
      const repos = new Repositories(reopened.db);
      assert.equal(repos.audit.list().length, 0, '数据库写入必须已回滚');
    } finally {
      closeDatabase(reopened.db);
    }

    assert.equal(
      await readFile(target, 'utf8'),
      '事务中被改写的内容\n',
      '文件的改动没有被、也不可能被 SQLite 回滚 —— 跨文件 ACID 不存在',
    );
  });
});

describe('LWB-006 修改集不可变与终态墓碑', () => {
  let opened: OpenDatabaseResult;
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    opened = openDatabase({ path: ':memory:' });
    db = opened.db;
    repos = new Repositories(db);
    seed(repos);
  });
  after(() => closeDatabase(db));

  it('修改集内容不可变：改摘要直接失败', () => {
    assert.throws(
      () => db.prepare('UPDATE changesets SET digest = ? WHERE id = ?').run('d'.repeat(64), 'chg_test'),
      /不可变/,
    );
  });

  it('只有状态可以流转，且流转必须声明合法来源', () => {
    const approved = repos.changes.transition('chg_test', ['PENDING_APPROVAL'], 'APPROVED');
    assert.equal(approved.state, 'APPROVED');

    expectBridgeError(
      'CHANGE_STATE_INVALID',
      () => repos.changes.transition('chg_test', ['PENDING_APPROVAL'], 'REJECTED'),
      '从错误来源状态流转',
    );

    expectBridgeError(
      'CHANGE_NOT_FOUND',
      () => repos.changes.transition('chg_missing', ['PENDING_APPROVAL'], 'APPROVED'),
      '不存在的修改集',
    );
  });

  it('终态修改集不得删除（终态墓碑）', () => {
    repos.changes.transition('chg_test', ['APPROVED'], 'REJECTED');
    assert.throws(
      () => repos.changes.deleteNonTerminal('chg_test'),
      /终态/,
      '终态修改集被删除了：旧的 change_id 会变成可再次执行的任务',
    );
    assert.ok(repos.changes.findById('chg_test'), '终态修改集必须仍然存在');
  });

  it('修改集条目不可变', () => {
    assert.throws(
      () => db.prepare('UPDATE change_items SET target_sha256 = ? WHERE id = ?').run(HEX64, 'item_0'),
      /不可变/,
    );
  });
});

describe('LWB-006 修改集条目的形状约束', () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    db = openDatabase({ path: ':memory:' }).db;
    repos = new Repositories(db);
    seed(repos, { paths: ['src/main.ts'] });
  });
  after(() => closeDatabase(db));

  it('同一物理文件在一次修改集里只能出现一次（大小写不敏感）', () => {
    const bob = repos.blobs.ensure({
      id: 'blob_old2',
      sha256: 'b'.repeat(64),
      size: 10,
      storage_ref: 'blobs/bb/bbbb',
    });
    assert.throws(
      () =>
        repos.changes.create({
          id: 'chg_dup',
          owner_connection_id: 'conn_test',
          workspace_id: 'ws_test',
          root_generation: 1,
          policy_version: 1,
          contract_version: '0.1.0',
          digest: HEX64,
          summary: '重复路径',
          expires_at: '2099-01-01T00:00:00.000Z',
          items: [
            { id: 'dup_0', path: 'src/main.ts', op: 'edit_text', base_file_id: 'f', base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64), new_blob_id: bob.blob.id, encoding: 'utf-8', bom: false, newline: 'lf', added_lines: 1, removed_lines: 2 },
            { id: 'dup_1', path: 'SRC\\Main.TS', op: 'edit_text', base_file_id: 'f', base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64), new_blob_id: bob.blob.id, encoding: 'utf-8', bom: false, newline: 'lf', added_lines: 1, removed_lines: 2 },
          ],
        }),
      /UNIQUE|constraint/i,
    );
    assert.equal(repos.changes.findById('chg_dup'), null, '失败的修改集不得部分写入');
  });

  it('create_text 不得携带基线；edit_text 必须有基线', () => {
    const bob = repos.blobs.ensure({
      id: 'blob_old3',
      sha256: 'b'.repeat(64),
      size: 10,
      storage_ref: 'blobs/bb/bbbb',
    });
    const base = {
      owner_connection_id: 'conn_test',
      workspace_id: 'ws_test',
      root_generation: 1,
      policy_version: 1,
      contract_version: '0.1.0',
      digest: HEX64,
      expires_at: '2099-01-01T00:00:00.000Z',
    };

    assert.throws(
      () =>
        repos.changes.create({
          ...base,
          id: 'chg_create_bad',
          summary: '创建却带基线',
          items: [
            { id: 'cb_0', path: 'new.txt', op: 'create_text', base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64), new_blob_id: bob.blob.id, encoding: 'utf-8', bom: false, newline: 'lf', added_lines: 1, removed_lines: 2 },
          ],
        }),
      /create_text/,
    );

    assert.throws(
      () =>
        repos.changes.create({
          ...base,
          id: 'chg_edit_bad',
          summary: '编辑却没有基线',
          items: [
            { id: 'eb_0', path: 'src/main.ts', op: 'edit_text', target_sha256: 'c'.repeat(64), new_blob_id: bob.blob.id, encoding: 'utf-8', bom: false, newline: 'lf', added_lines: 1, removed_lines: 2 },
          ],
        }),
      /基线/,
    );
  });

  it('unknown 编码只能作为 delete_file 的快照元数据写进修改集', () => {
    const bob = repos.blobs.ensure({
      id: 'blob_old4',
      sha256: 'b'.repeat(64),
      size: 10,
      storage_ref: 'blobs/bb/bbbb',
    });
    assert.throws(
      () =>
        repos.changes.create({
          id: 'chg_unknown_enc',
          owner_connection_id: 'conn_test',
          workspace_id: 'ws_test',
          root_generation: 1,
          policy_version: 1,
          contract_version: '0.1.0',
          digest: HEX64,
          summary: '未知编码',
          expires_at: '2099-01-01T00:00:00.000Z',
          items: [
            {
              id: 'unk_0',
              path: 'src/main.ts',
              op: 'edit_text',
              base_file_id: 'f',
              base_sha256: 'b'.repeat(64),
              target_sha256: 'c'.repeat(64),
              new_blob_id: bob.blob.id,
              encoding: 'unknown' as never,
              bom: false,
              newline: 'lf',
              added_lines: 1,
              removed_lines: 2,
            },
          ],
        }),
      /CHECK|constraint|unknown 编码/i,
    );

    const empty = repos.blobs.ensure({
      id: 'blob_empty_delete',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      size: 0,
      storage_ref: 'blobs/e3/empty',
    });
    const deleted = repos.changes.create({
      id: 'chg_delete_binary',
      owner_connection_id: 'conn_test',
      workspace_id: 'ws_test',
      root_generation: 1,
      policy_version: 1,
      contract_version: '0.1.0',
      digest: 'd'.repeat(64),
      summary: '删除一个二进制文件',
      expires_at: '2099-01-01T00:00:00.000Z',
      items: [{
        id: 'delete_0',
        path: 'assets/image.bin',
        op: 'delete_file',
        base_file_id: 'f',
        base_sha256: 'b'.repeat(64),
        target_sha256: empty.blob.sha256,
        old_blob_id: bob.blob.id,
        new_blob_id: empty.blob.id,
        encoding: 'unknown',
        bom: false,
        newline: 'none',
        added_lines: 0,
        removed_lines: 0,
      }],
    });
    assert.equal(repos.changes.items(deleted.id)[0]?.op, 'delete_file');
  });

  it('未通过路径语法校验的路径不得进入基线表', () => {
    const bob = repos.blobs.ensure({
      id: 'blob_old5',
      sha256: 'b'.repeat(64),
      size: 10,
      storage_ref: 'blobs/bb/bbbb',
    });
    const error = expectBridgeError(
      'PATH_UNSAFE',
      () =>
        repos.changes.create({
          id: 'chg_escape',
          owner_connection_id: 'conn_test',
          workspace_id: 'ws_test',
          root_generation: 1,
          policy_version: 1,
          contract_version: '0.1.0',
          digest: HEX64,
          summary: '越权路径',
          expires_at: '2099-01-01T00:00:00.000Z',
          items: [
            { id: 'esc_0', path: '../outside.txt', op: 'edit_text', base_file_id: 'f', base_sha256: 'b'.repeat(64), target_sha256: 'c'.repeat(64), new_blob_id: bob.blob.id, encoding: 'utf-8', bom: false, newline: 'lf', added_lines: 1, removed_lines: 2 },
          ],
        }),
      '上跳路径',
    );
    assert.match(String(error.message), /PATH_UNSAFE|不合法/);
  });
});

describe('LWB-006 一个修改集最多一个操作', () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    db = openDatabase({ path: ':memory:' }).db;
    repos = new Repositories(db);
    seed(repos);
  });
  after(() => closeDatabase(db));

  it('换了幂等键也只会得到同一个操作，不会产生第二个', () => {
    const first = repos.operations.create({
      id: 'op_1',
      change_id: 'chg_test',
      idempotency_key: 'key-A',
    });
    assert.equal(first.kind, 'created');

    const second = repos.operations.create({
      id: 'op_2',
      change_id: 'chg_test',
      idempotency_key: 'key-B',
    });
    assert.equal(second.kind, 'exists', '第二个操作必须被拒绝，而不是新建');
    assert.equal(second.operation.id, 'op_1', '必须返回同一个操作');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM operations WHERE change_id = ?').get('chg_test') as { n: number }).n,
      1,
    );
  });

  it('操作记录不得删除', () => {
    assert.throws(
      () => db.prepare('DELETE FROM operations WHERE id = ?').run('op_1'),
      /不得删除/,
    );
  });

  it('日志是追加写：序号递增，且不得删除', () => {
    const seq0 = repos.journal.append({ operation_id: 'op_1', stage: 'INTENT', item_id: 'item_0' });
    const seq1 = repos.journal.append({ operation_id: 'op_1', stage: 'RESULT', item_id: 'item_0' });
    assert.deepEqual([seq0, seq1], [0, 1]);
    assert.throws(() => db.prepare('DELETE FROM journal_entries WHERE operation_id = ?').run('op_1'), /追加/);
  });

  it('逐文件结果可以表达「未知」，且不会被并入成功', () => {
    repos.operations.setItemResult({
      operation_id: 'op_1',
      item_id: 'item_0',
      state: 'UNKNOWN',
      error_code: 'RECOVERY_REQUIRED',
    });
    const results = repos.operations.itemResults('op_1');
    assert.equal(results.length, 1);
    assert.equal(results[0]?.state, 'UNKNOWN');

    // 同一 (operation, item) 再写是更新而不是插入第二条。
    repos.operations.setItemResult({ operation_id: 'op_1', item_id: 'item_0', state: 'VERIFIED' });
    assert.equal(repos.operations.itemResults('op_1').length, 1);
  });

  it('未完成的操作可以被列出，但不会被自动推进', () => {
    const unfinished = repos.operations.listUnfinished();
    assert.deepEqual(
      unfinished.map((o) => o.id),
      ['op_1'],
    );
    assert.equal(unfinished[0]?.recovered, false, '列出不等于已经恢复');
  });
});

describe('LWB-006 幂等记录', () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    db = openDatabase({ path: ':memory:' }).db;
    repos = new Repositories(db);
  });
  after(() => closeDatabase(db));

  const base = { principal_id: 'p1', tool: 'lwb_change_prepare', key: 'k1', request_hash: 'a'.repeat(64) };

  it('首次是新请求，同键同内容为重放，同键不同内容为冲突', () => {
    const first = repos.idempotency.begin({ id: 'idem_1', ...base });
    assert.equal(first.kind, 'new');

    const replay = repos.idempotency.begin({ id: 'idem_2', ...base });
    assert.equal(replay.kind, 'replay', '同键同内容必须是重放');

    const conflict = repos.idempotency.begin({
      id: 'idem_3',
      ...base,
      request_hash: 'b'.repeat(64),
    });
    assert.equal(conflict.kind, 'conflict', '同键不同请求内容必须报冲突，不能覆盖');
    assert.equal(conflict.record.request_hash, 'a'.repeat(64), '旧记录不得被覆盖');
  });

  it('幂等记录的键与请求哈希不可变', () => {
    assert.throws(
      () => db.prepare('UPDATE idempotency_records SET request_hash = ? WHERE id = ?').run('c'.repeat(64), 'idem_1'),
      /不可变/,
    );
  });

  it('不同主体/工具使用同一把键互不影响', () => {
    const other = repos.idempotency.begin({ id: 'idem_4', ...base, principal_id: 'p2' });
    assert.equal(other.kind, 'new', 'principal 不同就不算重放');
  });

  it('完成后记录结果引用，供重放直接返回', () => {
    repos.idempotency.complete('p1', base.tool, base.key, 'chg_test');
    const replay = repos.idempotency.begin({ id: 'idem_5', ...base });
    assert.equal(replay.kind, 'replay');
    assert.equal(replay.record.result_ref, 'chg_test');
  });
});

describe('LWB-006 批准的一次性与绑定', () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    db = openDatabase({ path: ':memory:' }).db;
    repos = new Repositories(db);
    seed(repos);
  });
  after(() => closeDatabase(db));

  it('批准摘要必须与修改集摘要一致', () => {
    expectBridgeError(
      'CHANGE_STATE_INVALID',
      () =>
        repos.approvals.create({
          id: 'apr_bad',
          change_id: 'chg_test',
          digest: 'e'.repeat(64),
          actor: 'local-user',
          expires_at: '2099-01-01T00:00:00.000Z',
        }),
      '摘要不符的批准',
    );
  });

  it('同一修改集同时只能有一个有效批准', () => {
    repos.approvals.create({
      id: 'apr_1',
      change_id: 'chg_test',
      digest: HEX64,
      actor: 'local-user',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    expectBridgeError(
      'CHANGE_STATE_INVALID',
      () =>
        repos.approvals.create({
          id: 'apr_2',
          change_id: 'chg_test',
          digest: HEX64,
          actor: 'local-user',
          expires_at: '2099-01-01T00:00:00.000Z',
        }),
      '第二个有效批准',
    );
  });

  it('摘要不符的消费被拒绝，且状态不因失败而改变', () => {
    repos.operations.create({ id: 'op_a', change_id: 'chg_test' });
    expectBridgeError(
      'APPROVAL_EXPIRED',
      () =>
        repos.approvals.consume({
          approval_id: 'apr_1',
          digest: 'e'.repeat(64),
          operation_id: 'op_a',
          now: '2026-01-01T00:00:00.000Z',
        }),
      '摘要不符',
    );
    assert.equal(repos.approvals.findById('apr_1')?.state, 'ACTIVE', '失败的消费不得改变状态');
  });

  it('过期批准不能被执行（时间在写入时判定，不是先读后判）', () => {
    expectBridgeError(
      'APPROVAL_EXPIRED',
      () =>
        repos.approvals.consume({
          approval_id: 'apr_1',
          digest: HEX64,
          operation_id: 'op_a',
          now: '2099-06-01T00:00:00.000Z',
        }),
      '过期后消费',
    );
    assert.equal(repos.approvals.findById('apr_1')?.state, 'ACTIVE');
  });

  it('批准只能消费一次，且不能退回 ACTIVE', () => {
    const consumed = repos.approvals.consume({
      approval_id: 'apr_1',
      digest: HEX64,
      operation_id: 'op_a',
      now: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(consumed.state, 'CONSUMED');
    assert.equal(consumed.consumed_by, 'op_a');

    expectBridgeError(
      'APPROVAL_EXPIRED',
      () =>
        repos.approvals.consume({
          approval_id: 'apr_1',
          digest: HEX64,
          operation_id: 'op_a',
          now: '2026-01-01T00:00:00.000Z',
        }),
      '重复消费',
    );

    assert.throws(
      () => db.prepare("UPDATE approvals SET state = 'ACTIVE' WHERE id = ?").run('apr_1'),
      /退回 ACTIVE/,
    );
  });

  it('expireDue 只影响已过期的有效批准', () => {
    repos.changes.create({
      id: 'chg_2',
      owner_connection_id: 'conn_test',
      workspace_id: 'ws_test',
      root_generation: 1,
      policy_version: 1,
      contract_version: '0.1.0',
      digest: '1'.repeat(64),
      summary: '第二个修改集',
      expires_at: '2099-01-01T00:00:00.000Z',
      items: [
        {
          id: 'item_2',
          path: 'src/other.ts',
          op: 'edit_text',
          base_file_id: 'f',
          base_sha256: 'b'.repeat(64),
          target_sha256: 'c'.repeat(64),
          new_blob_id: 'blob_new',
          encoding: 'utf-8',
          bom: false,
          newline: 'lf',
          added_lines: 1,
          removed_lines: 2,
        },
      ],
    });
    repos.approvals.create({
      id: 'apr_2',
      change_id: 'chg_2',
      digest: '1'.repeat(64),
      actor: 'local-user',
      expires_at: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(repos.approvals.expireDue('2026-06-01T00:00:00.000Z'), 1);
    assert.equal(repos.approvals.findById('apr_2')?.state, 'EXPIRED');
  });
});

describe('LWB-006 工作区与授权', () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    db = openDatabase({ path: ':memory:' }).db;
    repos = new Repositories(db);
    seed(repos);
  });
  after(() => closeDatabase(db));

  it('同一物理目录不能登记两次（换大小写也算同一个）', () => {
    assert.throws(
      () =>
        repos.workspaces.create({
          id: 'ws_dup',
          alias: 'other',
          kind: 'directory',
          canonical_root: 'd:\\FIXTURES',
          volume_id: 'ffffffff',
          root_file_id: 'ffffffffffffffff',
          policy_version: 1,
          mode: 'read_only',
        }),
      /UNIQUE|constraint/i,
    );
  });

  it('代次递增使旧票据与批准失效（此处验证代次确实变化）', () => {
    const before = repos.workspaces.requireById('ws_test');
    const after = repos.workspaces.bumpGeneration('ws_test', 2);
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.policy_version, 2);
  });

  it('停用连接或工作区都会立刻收回能力', () => {
    repos.grants.put({
      id: 'grant_1',
      connection_id: 'conn_test',
      workspace_id: 'ws_test',
      capabilities: ['read', 'list', 'search', 'change_prepare'],
    });
    assert.equal(repos.grants.hasCapability('conn_test', 'ws_test', 'read'), true);
    assert.equal(repos.grants.hasCapability('conn_test', 'ws_test', 'change_apply'), false);

    repos.connections.setEnabled('conn_test', false);
    assert.equal(
      repos.grants.hasCapability('conn_test', 'ws_test', 'read'),
      false,
      '连接被停用后能力必须立即消失',
    );

    repos.connections.setEnabled('conn_test', true);
    repos.workspaces.setEnabled('ws_test', false);
    assert.equal(
      repos.grants.hasCapability('conn_test', 'ws_test', 'read'),
      false,
      '工作区被停用后能力必须立即消失',
    );
  });

  it('授权内容损坏时显式失败，而不是退化成空权限集', () => {
    repos.workspaces.setEnabled('ws_test', true);
    db.prepare('UPDATE grants SET capabilities = ? WHERE id = ?').run('{ not json', 'grant_1');
    expectBridgeError('STORAGE_UNAVAILABLE', () => repos.grants.listByConnection('conn_test'), '损坏的授权');
  });
});

describe('LWB-006 blob 引用计数', () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  before(() => {
    db = openDatabase({ path: ':memory:' }).db;
    repos = new Repositories(db);
  });
  after(() => closeDatabase(db));

  it('同内容只登记一份，重复登记只是加引用', () => {
    const first = repos.blobs.ensure({ id: 'b1', sha256: 'd'.repeat(64), size: 5, storage_ref: 'r1' });
    assert.equal(first.kind, 'created');

    const second = repos.blobs.ensure({ id: 'b2', sha256: 'd'.repeat(64), size: 5, storage_ref: 'r1' });
    assert.equal(second.kind, 'existing');
    assert.equal(second.blob.id, 'b1');
    assert.equal(second.blob.refcount, 2);
  });

  it('引用归零不立即删除，而是进入待回收', () => {
    repos.blobs.releaseRef('b1');
    repos.blobs.releaseRef('b1');
    const blob = repos.blobs.requireById('b1');
    assert.equal(blob.refcount, 0);
    assert.equal(blob.retention_state, 'pending_gc', '归零必须进入待回收，不能立刻消失');

    repos.blobs.markDeleted('b1');
    assert.equal(repos.blobs.requireById('b1').retention_state, 'deleted');
  });

  it('引用已删除的对象会被拒绝', () => {
    expectBridgeError('STORAGE_UNAVAILABLE', () => repos.blobs.addRef('b1'), '引用已删除的 blob');
  });
});
