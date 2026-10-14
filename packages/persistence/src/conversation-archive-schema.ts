/** Frozen v10 migration. Do not change these statements after deployment. */
export const CONVERSATION_ARCHIVE_MIGRATION = {
  version: 10,
  name: 'conversation_execution_archive_v1',
  statements: [
    `CREATE TABLE lwb_archive_config (
       singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
       correlation_key TEXT NOT NULL,
       event_bytes INTEGER NOT NULL DEFAULT 0 CHECK(event_bytes >= 0),
       event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0)
     ) STRICT`,
    `CREATE TABLE lwb_archive_conversations (
       id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, connection_id TEXT NOT NULL,
       session_digest TEXT, attribution TEXT NOT NULL CHECK(attribution IN
         ('client_meta','unassigned_missing','unassigned_invalid','unassigned_legacy')),
       local_title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'generated_local',
       created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
       UNIQUE(principal_id, connection_id, session_digest)
     ) STRICT`,
    `CREATE TABLE lwb_archive_calls (
       id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL
         REFERENCES lwb_archive_conversations(id) ON DELETE CASCADE,
       instance_id TEXT NOT NULL, request_id TEXT NOT NULL, tool TEXT NOT NULL,
       received_at TEXT NOT NULL, completed_at TEXT,
       phase TEXT NOT NULL CHECK(phase IN ('received','returned','threw','interrupted')),
       target_job_id TEXT, result_kind TEXT,
       delivery TEXT NOT NULL DEFAULT 'not_confirmed' CHECK(delivery = 'not_confirmed')
     ) STRICT`,
    `CREATE TABLE lwb_archive_jobs (
       id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL
         REFERENCES lwb_archive_conversations(id) ON DELETE CASCADE,
       origin_call_id TEXT REFERENCES lwb_archive_calls(id) ON DELETE SET NULL,
       principal_id TEXT NOT NULL, connection_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
       state TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot_signature TEXT NOT NULL,
       output_capture TEXT NOT NULL DEFAULT 'not_captured'
         CHECK(output_capture IN ('not_captured','captured'))
     ) STRICT`,
    `CREATE TABLE lwb_archive_events (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       conversation_id TEXT NOT NULL REFERENCES lwb_archive_conversations(id) ON DELETE CASCADE,
       call_id TEXT REFERENCES lwb_archive_calls(id) ON DELETE CASCADE,
       job_id TEXT REFERENCES lwb_archive_jobs(id) ON DELETE CASCADE,
       kind TEXT NOT NULL, observed_at TEXT NOT NULL, payload_json TEXT NOT NULL,
       original_bytes INTEGER NOT NULL, retained_bytes INTEGER NOT NULL,
       redacted INTEGER NOT NULL CHECK(redacted IN (0,1)),
       truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
       capture_policy TEXT NOT NULL DEFAULT 'redacted-v1'
     ) STRICT`,
    `CREATE INDEX lwb_archive_calls_conversation ON lwb_archive_calls(conversation_id,received_at,id)`,
    `CREATE INDEX lwb_archive_events_conversation ON lwb_archive_events(conversation_id,seq)`,
    `CREATE INDEX lwb_archive_jobs_conversation ON lwb_archive_jobs(conversation_id)`,
    `CREATE INDEX lwb_archive_conversations_activity ON lwb_archive_conversations(last_activity_at,id)`,
    `CREATE TRIGGER lwb_archive_events_append_only BEFORE UPDATE ON lwb_archive_events
       BEGIN SELECT RAISE(ABORT,'archive events are append-only'); END`,
    `CREATE TRIGGER lwb_archive_events_insert AFTER INSERT ON lwb_archive_events
       BEGIN UPDATE lwb_archive_config SET event_bytes=event_bytes+NEW.retained_bytes,
         event_count=event_count+1 WHERE singleton=1; END`,
    `CREATE TRIGGER lwb_archive_events_delete AFTER DELETE ON lwb_archive_events
       BEGIN UPDATE lwb_archive_config SET event_bytes=event_bytes-OLD.retained_bytes,
         event_count=event_count-1 WHERE singleton=1; END`
  ],
} as const;
