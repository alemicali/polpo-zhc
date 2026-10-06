import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, index as pgIndex } from "drizzle-orm/pg-core";
import { sessionsSqlite, sessionsPg } from "./sessions.js";

// Per-session prompt queue: prompts sent one after another when a chat turn completes.

// ── SQLite schema ──────────────────────────────────────────────────────

export const chatQueueItemsSqlite = sqliteTable("chat_queue_items", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  /** Send order (ascending); gaps are fine, ties break on created_at. */
  position: integer("position").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_chat_queue_items_session").on(table.sessionId, table.position),
]);

export const chatQueueSettingsSqlite = sqliteTable("chat_queue_settings", {
  sessionId: text("session_id").primaryKey().references(() => sessionsSqlite.id, { onDelete: "cascade" }),
  autoSend: integer("auto_send", { mode: "boolean" }).notNull(),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const chatQueueItemsPg = pgTable("chat_queue_items", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull().references(() => sessionsPg.id, { onDelete: "cascade" }),
  content: pgText("content").notNull(),
  /** Send order (ascending); gaps are fine, ties break on created_at. */
  position: pgInteger("position").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_chat_queue_items_session").on(table.sessionId, table.position),
]);

export const chatQueueSettingsPg = pgTable("chat_queue_settings", {
  sessionId: pgText("session_id").primaryKey().references(() => sessionsPg.id, { onDelete: "cascade" }),
  autoSend: pgBoolean("auto_send").notNull(),
});
