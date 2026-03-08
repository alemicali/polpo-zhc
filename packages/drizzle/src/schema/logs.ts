import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const logSessionsSqlite = sqliteTable("log_sessions", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
});

export const logEntriesSqlite = sqliteTable("log_entries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => logSessionsSqlite.id, { onDelete: "cascade" }),
  ts: text("ts").notNull(),
  event: text("event").notNull(),
  data: text("data"),
}, (table) => [
  index("idx_log_entries_session").on(table.sessionId),
  index("idx_log_entries_ts").on(table.ts),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const logSessionsPg = pgTable("log_sessions", {
  id: pgText("id").primaryKey(),
  startedAt: pgText("started_at").notNull(),
});

export const logEntriesPg = pgTable("log_entries", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => logSessionsPg.id, { onDelete: "cascade" }),
  ts: pgText("ts").notNull(),
  event: pgText("event").notNull(),
  data: jsonb("data"),
}, (table) => [
  pgIndex("idx_pg_log_entries_session").on(table.sessionId),
  pgIndex("idx_pg_log_entries_ts").on(table.ts),
]);
