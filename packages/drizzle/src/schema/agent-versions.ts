import { sqliteTable, text, index, primaryKey } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex, primaryKey as pgPrimaryKey } from "drizzle-orm/pg-core";

// Agent versions: immutable published snapshots, the draft (working copy), deploy pointers
// (production) and the deploy history. See packages/core/src/agent-versions.ts.

// ── SQLite schema ──────────────────────────────────────────────────────

export const agentVersionsSqlite = sqliteTable("agent_versions", {
  agentName: text("agent_name").notNull(),
  version: text("version").notNull(),
  /** AgentVersion (config snapshot, author, note, bump, changes, skill pins) as JSON. */
  data: text("data").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentName, table.version] }),
]);

export const agentDraftsSqlite = sqliteTable("agent_drafts", {
  agentName: text("agent_name").primaryKey(),
  /** AgentDraft as JSON. */
  data: text("data").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentPointersSqlite = sqliteTable("agent_pointers", {
  agentName: text("agent_name").notNull(),
  pointer: text("pointer").notNull(),
  version: text("version").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentName, table.pointer] }),
]);

export const agentDeploysSqlite = sqliteTable("agent_deploys", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  pointer: text("pointer").notNull(),
  fromVersion: text("from_version"),
  toVersion: text("to_version").notNull(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  note: text("note"),
  at: text("at").notNull(),
}, (table) => [
  index("idx_agent_deploys_agent_at").on(table.agentName, table.at),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const agentVersionsPg = pgTable("agent_versions", {
  agentName: pgText("agent_name").notNull(),
  version: pgText("version").notNull(),
  data: jsonb("data").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgPrimaryKey({ columns: [table.agentName, table.version] }),
]);

export const agentDraftsPg = pgTable("agent_drafts", {
  agentName: pgText("agent_name").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});

export const agentPointersPg = pgTable("agent_pointers", {
  agentName: pgText("agent_name").notNull(),
  pointer: pgText("pointer").notNull(),
  version: pgText("version").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  updatedBy: pgText("updated_by").notNull(),
}, (table) => [
  pgPrimaryKey({ columns: [table.agentName, table.pointer] }),
]);

export const agentDeploysPg = pgTable("agent_deploys", {
  id: pgText("id").primaryKey(),
  agentName: pgText("agent_name").notNull(),
  pointer: pgText("pointer").notNull(),
  fromVersion: pgText("from_version"),
  toVersion: pgText("to_version").notNull(),
  action: pgText("action").notNull(),
  actor: pgText("actor").notNull(),
  note: pgText("note"),
  at: pgText("at").notNull(),
}, (table) => [
  pgIndex("idx_pg_agent_deploys_agent_at").on(table.agentName, table.at),
]);
