import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

/**
 * Memory table — stores persistent memory documents.
 * Key convention:
 *   "default"         → shared memory (visible to all agents)
 *   "agent:<name>"    → per-agent private memory
 */
export const memorySqlite = sqliteTable("memory", {
  key: text("key").primaryKey(),
  content: text("content").notNull().default(""),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

/** @see memorySqlite for key convention docs */
export const memoryPg = pgTable("memory", {
  key: pgText("key").primaryKey(),
  content: pgText("content").notNull().default(""),
});
