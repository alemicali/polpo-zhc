import { sql } from "drizzle-orm";

/**
 * Ensure all PostgreSQL tables exist. Runs CREATE TABLE IF NOT EXISTS for each table.
 * Safe to call on every startup — does nothing if tables already exist.
 *
 * Each statement is executed individually (compatible with both WebSocket and HTTP drivers).
 *
 * @param db A Drizzle PostgreSQL database instance
 */
export async function ensurePgSchema(db: any): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'
  )`);

  // Migrate existing TEXT → JSONB (safe no-op if already JSONB)
  await db.execute(sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'metadata' AND column_name = 'value' AND data_type = 'text'
      ) THEN
        ALTER TABLE metadata ALTER COLUMN value TYPE JSONB USING value::jsonb;
      END IF;
    END $$
  `);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS tasks (
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
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_status ON tasks(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_group ON tasks("group")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_assign_to ON tasks(assign_to)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_mission_id ON tasks(mission_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_tasks_updated_at ON tasks(updated_at DESC)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS missions (
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
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_missions_status ON missions(status)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS processes (
    agent_name TEXT NOT NULL,
    pid        INTEGER NOT NULL,
    task_id    TEXT NOT NULL,
    started_at TEXT NOT NULL,
    alive      INTEGER NOT NULL DEFAULT 1,
    activity   JSONB NOT NULL DEFAULT '{}'
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS runs (
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
    config       JSONB,
    config_path  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_status ON runs(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_task_id ON runs(task_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS task_directions (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    run_id       TEXT,
    mode         VARCHAR(32) NOT NULL,
    message      TEXT NOT NULL,
    status       VARCHAR(32) NOT NULL DEFAULT 'queued',
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    applied_at   TEXT,
    error        TEXT
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_task_directions_task ON task_directions(task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_task_directions_run_status ON task_directions(run_id, status)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS agent_checkpoints (
    task_id    TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL,
    messages   JSONB NOT NULL DEFAULT '[]',
    saved_at   TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    agent      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    starred    BOOLEAN
  )`);

  // Migration: add starred column for sidebar "Starred" section (additive, idempotent).
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'starred'
      ) THEN
        ALTER TABLE sessions ADD COLUMN starred BOOLEAN;
      END IF;
    END $$
  `);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         TEXT NOT NULL,
    tool_calls TEXT,
    segments   TEXT
  )`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS segments TEXT`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_messages_session ON messages(session_id, ts)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_messages_session_id ON messages(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_sessions_updated_at ON sessions(updated_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_sessions_agent ON sessions(agent)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS notifications (
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
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_notifications_timestamp ON notifications(timestamp)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_notifications_status ON notifications(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_notifications_channel ON notifications(channel)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_notifications_rule_id ON notifications(rule_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS log_sessions (
    id         TEXT PRIMARY KEY,
    started_at TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS log_entries (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL,
    event      TEXT NOT NULL,
    data       JSONB
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_session ON log_entries(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_session_id ON log_entries(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_entries_ts ON log_entries(ts)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_runs_task_id_alt ON runs(task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_status_alt ON approvals(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_notifications_rule_id_alt ON notifications(rule_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS approvals (
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
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_status ON approvals(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_approvals_task_id ON approvals(task_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS memory (
    key     TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT ''
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS peers (
    id            TEXT PRIMARY KEY,
    channel       VARCHAR(32) NOT NULL,
    external_id   TEXT NOT NULL,
    display_name  TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    linked_to     TEXT
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_peers_channel ON peers(channel)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_peers_external_id ON peers(external_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS peer_allowlist (
    peer_id TEXT PRIMARY KEY
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS pairing_requests (
    id           TEXT PRIMARY KEY,
    peer_id      TEXT NOT NULL,
    channel      VARCHAR(32) NOT NULL,
    external_id  TEXT NOT NULL,
    display_name TEXT,
    code         TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    resolved     INTEGER NOT NULL DEFAULT 0
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_pairing_code ON pairing_requests(code)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_pairing_peer ON pairing_requests(peer_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS peer_sessions (
    peer_id    TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS teams (
    name        TEXT PRIMARY KEY,
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS agents (
    name        TEXT PRIMARY KEY,
    team_name   TEXT NOT NULL,
    config      JSONB NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS vault (
    agent          TEXT NOT NULL,
    service        TEXT NOT NULL,
    type           TEXT NOT NULL,
    label          TEXT,
    account        TEXT,
    allowed_agents TEXT,
    credentials    TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (agent, service)
  )`);

  // Migration: add account column to existing vault tables (v0.3.x → mailbox grouping).
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vault' AND column_name = 'account'
      ) THEN
        ALTER TABLE vault ADD COLUMN account TEXT;
      END IF;
    END $$;
  `);

  // Migration: add allowed_agents column for shared credentials (v0.3.x → multi-agent sharing).
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vault' AND column_name = 'allowed_agents'
      ) THEN
        ALTER TABLE vault ADD COLUMN allowed_agents TEXT;
      END IF;
    END $$;
  `);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS playbooks (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    mission     JSONB NOT NULL,
    parameters  JSONB,
    version     TEXT,
    author      TEXT,
    tags        JSONB,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    message_id  TEXT,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL,
    path        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_attachments_session_id ON attachments(session_id)`);

  // Migration: add message_id column if missing (added in v0.2.16)
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'attachments' AND column_name = 'message_id'
      ) THEN
        ALTER TABLE attachments ADD COLUMN message_id TEXT;
      END IF;
    END $$
  `);

  // ── New tables added by the file→sqlite migration work (v0.2.14+) ────
  await db.execute(sql`CREATE TABLE IF NOT EXISTS coding_sessions (
    id          TEXT PRIMARY KEY,
    state       JSONB NOT NULL,
    initialized BOOLEAN NOT NULL DEFAULT false,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS expo_tokens (
    token         TEXT PRIMARY KEY,
    platform      TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    disabled      BOOLEAN NOT NULL DEFAULT false
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_expo_tokens_device_id ON expo_tokens(device_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint        TEXT PRIMARY KEY,
    expiration_time BIGINT,
    p256dh          TEXT NOT NULL,
    auth            TEXT NOT NULL,
    user_agent      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_success_at TEXT,
    last_failure_at TEXT,
    failure_count   INTEGER NOT NULL DEFAULT 0
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS push_vapid (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL,
    subject     TEXT NOT NULL
  )`);

  // ── Hot indices added in the post-migration audit pass ─────────────────
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_agents_team_name ON agents(team_name)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_processes_agent_name ON processes(agent_name)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_processes_task_id ON processes(task_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_peer_sessions_session_id ON peer_sessions(session_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_vault_agent ON vault(agent)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pg_log_sessions_started_at ON log_sessions(started_at DESC)`);
}
