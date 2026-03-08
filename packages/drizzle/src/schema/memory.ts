import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const memorySqlite = sqliteTable("memory", {
  key: text("key").primaryKey(),
  content: text("content").notNull().default(""),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const memoryPg = pgTable("memory", {
  key: pgText("key").primaryKey(),
  content: pgText("content").notNull().default(""),
});
