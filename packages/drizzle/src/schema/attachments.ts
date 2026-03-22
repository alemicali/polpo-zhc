import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const attachmentsSqlite = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  messageId: text("message_id"),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_attachments_session_id").on(table.sessionId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const attachmentsPg = pgTable("attachments", {
  id: pgText("id").primaryKey(),
  sessionId: pgText("session_id").notNull(),
  messageId: pgText("message_id"),
  filename: pgText("filename").notNull(),
  mimeType: pgText("mime_type").notNull(),
  size: pgInteger("size").notNull(),
  path: pgText("path").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_attachments_session_id").on(table.sessionId),
]);
