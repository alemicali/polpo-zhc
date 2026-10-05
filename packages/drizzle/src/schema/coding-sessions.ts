import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import {
  pgTable,
  text as pgText,
  jsonb,
  boolean as pgBoolean,
} from "drizzle-orm/pg-core";

/**
 * Coding-session store schema.
 *
 * The Coding page persists a single per-project workspace/session blob
 * (workspaces[], terminals[], codeServers[], activeId). We model this as a
 * single-row table keyed by a constant id ("default") so the same table can
 * later host multi-user state if/when we need it without a migration.
 */

// ── SQLite schema ──────────────────────────────────────────────────────

export const codingSessionsSqlite = sqliteTable("coding_sessions", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  initialized: integer("initialized", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const codingSessionsPg = pgTable("coding_sessions", {
  id: pgText("id").primaryKey(),
  state: jsonb("state").notNull(),
  initialized: pgBoolean("initialized").notNull().default(false),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});
