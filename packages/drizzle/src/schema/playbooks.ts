import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const playbooksSqlite = sqliteTable("playbooks", {
  name: text("name").primaryKey(),
  description: text("description").notNull(),
  mission: text("mission").notNull(),       // JSON-serialized mission object
  parameters: text("parameters"),           // JSON-serialized PlaybookParameter[]
  version: text("version"),
  author: text("author"),
  tags: text("tags"),                       // JSON-serialized string[]
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const playbooksPg = pgTable("playbooks", {
  name: pgText("name").primaryKey(),
  description: pgText("description").notNull(),
  mission: jsonb("mission").notNull(),      // mission object as JSONB
  parameters: jsonb("parameters"),          // PlaybookParameter[] as JSONB
  version: pgText("version"),
  author: pgText("author"),
  tags: jsonb("tags"),                      // string[] as JSONB
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});
