/**
 * Create all SQLite tables for @polpo-ai/drizzle stores.
 * Equivalent to ensurePgSchema() but for SQLite (uses raw SQL via better-sqlite3).
 */
export function ensureSqliteSchema(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      assign_to TEXT NOT NULL,
      "group" TEXT,
      mission_id TEXT,
      depends_on TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      max_duration INTEGER,
      retry_policy TEXT,
      expectations TEXT NOT NULL DEFAULT '[]',
      metrics TEXT NOT NULL DEFAULT '[]',
      result TEXT,
      phase TEXT,
      fix_attempts INTEGER NOT NULL DEFAULT 0,
      resolution_attempts INTEGER NOT NULL DEFAULT 0,
      original_description TEXT,
      session_id TEXT,
      notifications TEXT,
      outcomes TEXT,
      expected_outcomes TEXT,
      deadline TEXT,
      priority TEXT,
      side_effects INTEGER,
      revision_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks("group");
    CREATE INDEX IF NOT EXISTS idx_tasks_assign_to ON tasks(assign_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_mission_id ON tasks(mission_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);

    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      schedule TEXT,
      end_date TEXT,
      quality_threshold TEXT,
      deadline TEXT,
      notifications TEXT,
      execution_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processes (
      agent_name TEXT NOT NULL,
      pid INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      alive INTEGER NOT NULL DEFAULT 1,
      activity TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      pid INTEGER NOT NULL DEFAULT 0,
      agent_name TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activity TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      outcomes TEXT,
      config TEXT,
      config_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      starred INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts TEXT NOT NULL,
      tool_calls TEXT,
      segments TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT NOT NULL,
      source_event TEXT NOT NULL,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      attachment_types TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON notifications(timestamp);
    CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications(channel);
    CREATE INDEX IF NOT EXISTS idx_notifications_rule_id ON notifications(rule_id);

    CREATE TABLE IF NOT EXISTS log_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_entries_session ON log_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_log_entries_session_id ON log_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_log_entries_ts ON log_entries(ts);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      gate_id TEXT NOT NULL,
      gate_name TEXT NOT NULL,
      task_id TEXT,
      mission_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);

    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      display_name TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      linked_to TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_peers_channel ON peers(channel);
    CREATE INDEX IF NOT EXISTS idx_peers_external_id ON peers(external_id);

    CREATE TABLE IF NOT EXISTS peer_allowlist (
      peer_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS pairing_requests (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      display_name TEXT,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_code ON pairing_requests(code);
    CREATE INDEX IF NOT EXISTS idx_pairing_peer ON pairing_requests(peer_id);

    CREATE TABLE IF NOT EXISTS peer_sessions (
      peer_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      name TEXT PRIMARY KEY,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault (
      agent TEXT NOT NULL,
      service TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      account TEXT,
      allowed_agents TEXT,
      credentials TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent, service)
    );

    CREATE TABLE IF NOT EXISTS playbooks (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      mission TEXT NOT NULL,
      parameters TEXT,
      version TEXT,
      author TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON attachments(session_id);

    CREATE TABLE IF NOT EXISTS coding_sessions (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      initialized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expo_tokens (
      token TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_expo_tokens_device_id ON expo_tokens(device_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      expiration_time INTEGER,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_success_at TEXT,
      last_failure_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS push_vapid (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      subject TEXT NOT NULL
    );
  `);

  // ── Additive index migrations (idempotent) ───────────────────────────
  // These run after the CREATE block so they apply to pre-existing DBs that
  // were built against older schema versions.
  for (const stmt of [
    `CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_log_entries_session_id ON log_entries(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id)`,
    `CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_rule_id ON notifications(rule_id)`,
    // Hot indices added in the post-migration audit pass.
    `CREATE INDEX IF NOT EXISTS idx_agents_team_name ON agents(team_name)`,
    `CREATE INDEX IF NOT EXISTS idx_processes_agent_name ON processes(agent_name)`,
    `CREATE INDEX IF NOT EXISTS idx_processes_task_id ON processes(task_id)`,
    `CREATE INDEX IF NOT EXISTS idx_peer_sessions_session_id ON peer_sessions(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_vault_agent ON vault(agent)`,
    `CREATE INDEX IF NOT EXISTS idx_log_sessions_started_at ON log_sessions(started_at DESC)`,
  ]) {
    try { db.exec(stmt); } catch { /* index already present */ }
  }

  // Additive column migrations for pre-existing databases.
  for (const stmt of [
    `ALTER TABLE sessions ADD COLUMN agent TEXT`,
    `ALTER TABLE sessions ADD COLUMN starred INTEGER`,
  ]) {
    try { db.exec(stmt); } catch { /* column already present */ }
  }

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN segments TEXT;`);
  } catch {
    // Column already exists on databases created after this migration.
  }

  try {
    db.exec(`ALTER TABLE vault ADD COLUMN account TEXT;`);
  } catch {
    // Column already exists on databases created after this migration.
  }

  try {
    db.exec(`ALTER TABLE vault ADD COLUMN allowed_agents TEXT;`);
  } catch {
    // Column already exists on databases created after this migration.
  }

  // ── FTS5 full-text search on tasks ────────────────────────────────────
  // Virtual table mirrors title + description from `tasks`. Triggers keep
  // it in sync on INSERT / UPDATE / DELETE. Backfill is idempotent: the
  // NOT IN subquery skips rows already indexed, so re-running on every
  // boot is cheap (a single index scan).
  //
  // Wrapped in try/catch because some SQLite builds may ship without FTS5.
  // If it fails the rest of the app keeps working — the route falls back to
  // an in-memory LIKE filter when `tasks_fts` is missing.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        title, description,
        content='tasks',
        content_rowid='rowid'
      );
    `);
    db.exec(`
      INSERT INTO tasks_fts(rowid, title, description)
        SELECT rowid, title, description FROM tasks
        WHERE rowid NOT IN (SELECT rowid FROM tasks_fts);
    `);
    // DROP + CREATE so trigger bodies stay up to date if we ever tweak them.
    db.exec(`DROP TRIGGER IF EXISTS tasks_fts_insert;`);
    db.exec(`DROP TRIGGER IF EXISTS tasks_fts_delete;`);
    db.exec(`DROP TRIGGER IF EXISTS tasks_fts_update;`);
    db.exec(`
      CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.rowid, new.title, new.description);
      END;
    `);
    db.exec(`
      CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.rowid, old.title, old.description);
      END;
    `);
    db.exec(`
      CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.rowid, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.rowid, new.title, new.description);
      END;
    `);
  } catch (err) {
    // FTS5 not available — search routes will fall back to in-memory LIKE.
    // eslint-disable-next-line no-console
    console.warn("[sqlite] FTS5 setup failed, search will use fallback:", (err as Error).message);
  }
}
