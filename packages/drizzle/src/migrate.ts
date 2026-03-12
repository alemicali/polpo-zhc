import { sql } from "drizzle-orm";

/**
 * Ensure all PostgreSQL tables exist. Runs CREATE TABLE IF NOT EXISTS for each table.
 * Safe to call on every startup — does nothing if tables already exist.
 *
 * @param db A Drizzle PostgreSQL database instance
 */
export async function ensurePgSchema(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL,
      description           TEXT NOT NULL,
      assign_to             TEXT NOT NULL,
      "group"               TEXT,
      mission_id            TEXT,
      depends_on            JSONB NOT NULL DEFAULT '[]',
      status                VARCHAR(32) NOT NULL DEFAULT 'pending',
      retries               INTEGER NOT NULL DEFAULT 0,
      max_retries           INTEGER NOT NULL DEFAULT 2,
      max_duration          INTEGER,
      retry_policy          JSONB,
      expectations          JSONB NOT NULL DEFAULT '[]',
      metrics               JSONB NOT NULL DEFAULT '[]',
      result                JSONB,
      phase                 VARCHAR(32),
      fix_attempts          INTEGER NOT NULL DEFAULT 0,
      resolution_attempts   INTEGER NOT NULL DEFAULT 0,
      original_description  TEXT,
      session_id            TEXT,
      notifications         JSONB,
      outcomes              JSONB,
      expected_outcomes     JSONB,
      deadline              TEXT,
      priority              TEXT,
      side_effects          INTEGER,
      revision_count        INTEGER,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pg_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_pg_tasks_group ON tasks("group");
    CREATE INDEX IF NOT EXISTS idx_pg_tasks_assign_to ON tasks(assign_to);
    CREATE INDEX IF NOT EXISTS idx_pg_tasks_mission_id ON tasks(mission_id);

    CREATE TABLE IF NOT EXISTS missions (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      data             TEXT NOT NULL,
      prompt           TEXT,
      status           VARCHAR(32) NOT NULL DEFAULT 'draft',
      schedule         TEXT,
      end_date         TEXT,
      quality_threshold TEXT,
      deadline         TEXT,
      notifications    JSONB,
      execution_count  INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pg_missions_status ON missions(status);

    CREATE TABLE IF NOT EXISTS processes (
      agent_name TEXT NOT NULL,
      pid        INTEGER NOT NULL,
      task_id    TEXT NOT NULL,
      started_at TEXT NOT NULL,
      alive      INTEGER NOT NULL DEFAULT 1,
      activity   JSONB NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS runs (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL,
      pid          INTEGER NOT NULL DEFAULT 0,
      agent_name   TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      session_id   TEXT,
      status       VARCHAR(32) NOT NULL DEFAULT 'running',
      started_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      activity     JSONB NOT NULL DEFAULT '{}',
      result       JSONB,
      outcomes     JSONB,
      config_path  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pg_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_pg_runs_task_id ON runs(task_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      agent      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      ts         TEXT NOT NULL,
      tool_calls TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pg_messages_session ON messages(session_id, ts);

    CREATE TABLE IF NOT EXISTS notifications (
      id               TEXT PRIMARY KEY,
      timestamp        TEXT NOT NULL,
      rule_id          TEXT NOT NULL,
      rule_name        TEXT NOT NULL,
      channel          TEXT NOT NULL,
      channel_type     TEXT NOT NULL,
      status           VARCHAR(32) NOT NULL,
      error            TEXT,
      title            TEXT NOT NULL,
      body             TEXT NOT NULL,
      severity         VARCHAR(16) NOT NULL,
      source_event     TEXT NOT NULL,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachment_types JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_pg_notifications_timestamp ON notifications(timestamp);
    CREATE INDEX IF NOT EXISTS idx_pg_notifications_status ON notifications(status);
    CREATE INDEX IF NOT EXISTS idx_pg_notifications_channel ON notifications(channel);
    CREATE INDEX IF NOT EXISTS idx_pg_notifications_rule_id ON notifications(rule_id);

    CREATE TABLE IF NOT EXISTS log_sessions (
      id         TEXT PRIMARY KEY,
      started_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
      ts         TEXT NOT NULL,
      event      TEXT NOT NULL,
      data       JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_pg_log_entries_session ON log_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_pg_log_entries_ts ON log_entries(ts);

    CREATE TABLE IF NOT EXISTS approvals (
      id           TEXT PRIMARY KEY,
      gate_id      TEXT NOT NULL,
      gate_name    TEXT NOT NULL,
      task_id      TEXT,
      mission_id   TEXT,
      status       VARCHAR(32) NOT NULL DEFAULT 'pending',
      payload      JSONB,
      requested_at TEXT NOT NULL,
      resolved_at  TEXT,
      resolved_by  TEXT,
      note         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pg_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_pg_approvals_task_id ON approvals(task_id);

    CREATE TABLE IF NOT EXISTS memory (
      key     TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS peers (
      id            TEXT PRIMARY KEY,
      channel       VARCHAR(32) NOT NULL,
      external_id   TEXT NOT NULL,
      display_name  TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      linked_to     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pg_peers_channel ON peers(channel);
    CREATE INDEX IF NOT EXISTS idx_pg_peers_external_id ON peers(external_id);

    CREATE TABLE IF NOT EXISTS peer_allowlist (
      peer_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS pairing_requests (
      id           TEXT PRIMARY KEY,
      peer_id      TEXT NOT NULL,
      channel      VARCHAR(32) NOT NULL,
      external_id  TEXT NOT NULL,
      display_name TEXT,
      code         TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      resolved     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_pg_pairing_code ON pairing_requests(code);
    CREATE INDEX IF NOT EXISTS idx_pg_pairing_peer ON pairing_requests(peer_id);

    CREATE TABLE IF NOT EXISTS peer_sessions (
      peer_id    TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      name        TEXT PRIMARY KEY,
      description TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      name        TEXT PRIMARY KEY,
      team_name   TEXT NOT NULL,
      config      JSONB NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);
}
