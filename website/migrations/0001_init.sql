-- Ink Registry schema

-- Packages: one row per discovered package
CREATE TABLE packages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,                -- owner/repo
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'unknown', -- playbook | agent | company
  description TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  version    TEXT NOT NULL DEFAULT '0.0.0',
  author     TEXT NOT NULL DEFAULT '',
  installs   INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_installed TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, name)
);

-- Install events: one row per install (for trending/analytics)
CREATE TABLE installs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  installed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for trending queries (installs in last 24h)
CREATE INDEX idx_installs_at ON installs(installed_at);

-- Index for package lookups
CREATE INDEX idx_packages_source_name ON packages(source, name);

-- Index for leaderboard sorting
CREATE INDEX idx_packages_installs ON packages(installs DESC);
