/** v11 is additive to the frozen execution archive v10. No execution journal is rewritten. */
export const CONVERSATION_MANAGEMENT_MIGRATION = {
  version: 11,
  name: 'conversation_management_v1',
  statements: [
    `ALTER TABLE lwb_archive_calls ADD COLUMN workspace_id TEXT`,
    `CREATE INDEX lwb_archive_calls_workspace ON lwb_archive_calls(workspace_id,conversation_id)`,
    `CREATE TABLE lwb_archive_conversation_meta (
      conversation_id TEXT PRIMARY KEY REFERENCES lwb_archive_conversations(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
      tags_json TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN(0,1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
      updated_at TEXT NOT NULL, payload_generation INTEGER NOT NULL DEFAULT 0,
      payloads_cleared_at TEXT
    ) STRICT`,
    `CREATE TABLE lwb_archive_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 3650),
      automatic_retention INTEGER NOT NULL DEFAULT 0 CHECK(automatic_retention IN(0,1)),
      updated_at TEXT NOT NULL
    ) STRICT`,
    `INSERT INTO lwb_archive_settings(singleton,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    `CREATE TABLE lwb_archive_management_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT,
      action TEXT NOT NULL, actor TEXT NOT NULL, observed_at TEXT NOT NULL,
      detail_json TEXT NOT NULL
    ) STRICT`,
    `CREATE INDEX lwb_archive_meta_pinned ON lwb_archive_conversation_meta(pinned,archived,conversation_id)`,
    `CREATE INDEX lwb_archive_management_by_conversation ON lwb_archive_management_events(conversation_id,seq)`,
    `CREATE INDEX lwb_archive_events_job ON lwb_archive_events(job_id,seq)`,
    `CREATE INDEX lwb_archive_events_call ON lwb_archive_events(call_id,seq)`,
    `CREATE INDEX lwb_archive_calls_tool ON lwb_archive_calls(tool,conversation_id)`,
    `CREATE INDEX lwb_archive_jobs_workspace ON lwb_archive_jobs(workspace_id,conversation_id)`,
    `CREATE TRIGGER lwb_archive_management_append_only BEFORE UPDATE ON lwb_archive_management_events
      BEGIN SELECT RAISE(ABORT,'management events are append-only'); END`,
  ],
} as const;
