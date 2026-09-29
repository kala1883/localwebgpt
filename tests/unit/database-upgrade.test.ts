import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import {
  KNOWN_SCHEMA_VERSION,
  MIGRATIONS,
  backupDatabaseBeforeMigration,
  closeDatabase,
  migrationChecksum,
  openDatabase,
} from '@lwb/persistence';
import Database from 'better-sqlite3';

function createV1Database(file: string, withPendingOperation = false): void {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  const v1 = MIGRATIONS.find((migration) => migration.version === 1);
  assert.ok(v1);
  const apply = db.transaction(() => {
    for (const statement of v1.statements) db.exec(statement);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(v1.version, v1.name, migrationChecksum(v1), '2026-01-01T00:00:00.000Z');
    db.prepare(
      'INSERT INTO audit_events (subject, action, outcome, timestamp) VALUES (?, ?, ?, ?)',
    ).run('upgrade-test', 'fixture', 'allow', '2026-01-01T00:00:00.000Z');

    if (withPendingOperation) {
      db.prepare(
        `INSERT INTO workspaces (id, alias, kind, canonical_root, volume_id, root_file_id,
                                 generation, policy_version, mode, enabled, created_at, updated_at)
         VALUES (?, ?, 'directory', ?, ?, ?, 1, 1, 'read_propose_apply_with_local_approval', 1, ?, ?)`,
      ).run(
        'ws_upgrade',
        'upgrade',
        'D:\\upgrade-test',
        'aabbccdd',
        '1122334455667788',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
      db.prepare(
        `INSERT INTO connections (id, principal_kind, principal_id, alias, enabled, generation,
                                  created_at, updated_at)
         VALUES (?, 'model_surface', ?, ?, 1, 1, ?, ?)`,
      ).run(
        'conn_upgrade',
        'principal_upgrade',
        'upgrade',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
      db.prepare(
        `INSERT INTO changesets (id, owner_connection_id, workspace_id, root_generation,
                                 policy_version, contract_version, digest, summary, state,
                                 expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, '0.1.0', ?, ?, 'RECOVERY_REQUIRED', ?, ?, ?)`,
      ).run(
        'change_upgrade',
        'conn_upgrade',
        'ws_upgrade',
        'a'.repeat(64),
        'upgrade fixture',
        '2030-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
      db.prepare(
        `INSERT INTO operations (id, change_id, state, recovered, created_at)
         VALUES (?, ?, 'RECOVERY_REQUIRED', 0, ?)`,
      ).run('operation_upgrade', 'change_upgrade', '2026-01-01T00:00:00.000Z');
    }
  });
  try {
    apply.immediate();
  } finally {
    db.close();
  }
}

describe('database upgrade preflight', () => {
  it('makes a verified SQLite snapshot before migrating an older schema', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lwb-db-upgrade-'));
    const file = path.join(directory, 'bridge.sqlite');
    let writerClosed = true;
    let writer: InstanceType<typeof Database> | null = null;
    try {
      createV1Database(file);
      writer = new Database(file);
      writerClosed = false;
      assert.equal(writer.pragma('journal_mode = WAL', { simple: true }), 'wal');
      writer.pragma('wal_autocheckpoint = 0');
      writer
        .prepare('INSERT INTO audit_events (subject, action, outcome, timestamp) VALUES (?, ?, ?, ?)')
        .run('upgrade-wal', 'committed-in-wal', 'allow', '2026-01-02T00:00:00.000Z');
      const walFile = `${file}-wal`;
      assert.ok(existsSync(walFile) && statSync(walFile).size > 0, 'fixture must contain committed WAL pages');
      const before = readFileSync(file);

      const backup = await backupDatabaseBeforeMigration(file);

      assert.ok(backup);
      assert.equal(backup.from_version, 1);
      assert.equal(backup.to_version, KNOWN_SCHEMA_VERSION);
      assert.deepEqual(readFileSync(file), before, 'snapshotting must not mutate the source database');
      assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.partial')), []);
      assert.equal(
        (writer.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version,
        1,
        'source connection remains unmigrated',
      );

      const backupPath = path.join(directory, backup.file_name);
      const snapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(snapshot.pragma('quick_check', { simple: true }), 'ok');
        assert.equal(
          (snapshot.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version,
          1,
          'backup must retain the pre-migration schema version',
        );
        assert.equal(
          (snapshot.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count,
          2,
          'backup must retain existing user state',
        );
        assert.equal(
          (snapshot.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE subject = ?').get('upgrade-wal') as { count: number }).count,
          1,
          'backup must include committed content that was still in the WAL',
        );
      } finally {
        snapshot.close();
      }

      writer.close();
      writerClosed = true;
      const migrated = openDatabase({ path: file });
      try {
        assert.equal(migrated.schema_version, KNOWN_SCHEMA_VERSION);
        assert.equal(
          (migrated.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count,
          2,
        );
      } finally {
        closeDatabase(migrated.db);
      }

      const retainedSnapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(
          (retainedSnapshot.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version,
          1,
          'migration must not alter the retained pre-upgrade snapshot',
        );
      } finally {
        retainedSnapshot.close();
      }
    } finally {
      if (!writerClosed) writer?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks migration before creating a backup when an operation needs local recovery', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lwb-db-upgrade-pending-'));
    const file = path.join(directory, 'bridge.sqlite');
    try {
      createV1Database(file, true);
      const before = readFileSync(file);

      await assert.rejects(
        () => backupDatabaseBeforeMigration(file),
        (error: unknown) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(error.code, 'STORAGE_UNAVAILABLE');
          assert.equal(error.details?.['pending_operation_count'], 1);
          return true;
        },
      );

      assert.deepEqual(readFileSync(file), before, 'blocked upgrades must leave the source database byte-identical');
      assert.equal(readdirSync(directory).some((name) => name.includes('.pre-migration-')), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('skips snapshots for a missing or already-current database', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lwb-db-upgrade-current-'));
    const missing = path.join(directory, 'missing.sqlite');
    const current = path.join(directory, 'current.sqlite');
    try {
      assert.equal(await backupDatabaseBeforeMigration(missing), null);
      const opened = openDatabase({ path: current });
      closeDatabase(opened.db);
      assert.equal(await backupDatabaseBeforeMigration(current), null);
      assert.deepEqual(readdirSync(directory).filter((name) => name.includes('.pre-migration-')), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a database from a newer runtime without mutating it', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lwb-db-upgrade-future-'));
    const file = path.join(directory, 'bridge.sqlite');
    try {
      const initialized = openDatabase({ path: file });
      closeDatabase(initialized.db);

      const futureVersion = KNOWN_SCHEMA_VERSION + 1;
      const writer = new Database(file);
      try {
        writer.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(futureVersion, 'future-schema', 'f'.repeat(64), '2026-01-03T00:00:00.000Z');
      } finally {
        writer.close();
      }
      const before = readFileSync(file);

      assert.throws(
        () => openDatabase({ path: file }),
        (error: unknown) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(error.code, 'STORAGE_UNAVAILABLE');
          assert.equal(error.details?.['found_version'], futureVersion);
          assert.equal(error.details?.['supported_version'], KNOWN_SCHEMA_VERSION);
          return true;
        },
      );

      assert.deepEqual(readFileSync(file), before, 'an older runtime must not mutate a newer schema database');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
