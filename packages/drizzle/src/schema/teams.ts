import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const teamsSqlite = sqliteTable("teams", {
  name: text("name").primaryKey(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentsSqlite = sqliteTable("agents", {
  name: text("name").primaryKey(),
  teamName: text("team_name").notNull(),
  config: text("config").notNull(), // JSON-serialized AgentConfig (minus name)
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const teamsPg = pgTable("teams", {
  name: pgText("name").primaryKey(),
  description: pgText("description"),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});

export const agentsPg = pgTable("agents", {
  name: pgText("name").primaryKey(),
  teamName: pgText("team_name").notNull(),
  config: jsonb("config").notNull(), // AgentConfig (minus name) as JSONB
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});
