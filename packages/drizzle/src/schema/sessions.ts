import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, boolean as pgBoolean, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const sessionsSqlite = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  agent: text("agent"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  starred: integer("starred", { mode: "boolean" }),
});

export const messagesSqlite = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  ts: text("ts").notNull(),
  toolCalls: text("tool_calls"),
  segments: text("segments"),
}, (table) => [
  index("idx_messages_session").on(table.sessionId, table.ts),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const sessionsPg = pgTable("sessions", {
  id: pgText("id").primaryKey(),
  title: pgText("title"),
  agent: pgText("agent"),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  starred: pgBoolean("starred"),
});

export const messagesPg = pgTable("messages", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => sessionsPg.id, { onDelete: "cascade" }),
  role: pgText("role").notNull(),
  content: pgText("content").notNull(),
  ts: pgText("ts").notNull(),
  toolCalls: pgText("tool_calls"),
  segments: pgText("segments"),
}, (table) => [
  pgIndex("idx_pg_messages_session").on(table.sessionId, table.ts),
]);
