import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, jsonb, varchar, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const runsSqlite = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  pid: integer("pid").notNull().default(0),
  agentName: text("agent_name").notNull(),
  adapterType: text("adapter_type").notNull(),
  sessionId: text("session_id"),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  activity: text("activity").notNull().default("{}"),
  result: text("result"),
  outcomes: text("outcomes"),
  configPath: text("config_path").notNull(),
}, (table) => [
  index("idx_runs_status").on(table.status),
  index("idx_runs_task_id").on(table.taskId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const runsPg = pgTable("runs", {
  id: pgText("id").primaryKey(),
  taskId: pgText("task_id").notNull(),
  pid: pgInteger("pid").notNull().default(0),
  agentName: pgText("agent_name").notNull(),
  adapterType: pgText("adapter_type").notNull(),
  sessionId: pgText("session_id"),
  status: varchar("status", { length: 32 }).notNull().default("running"),
  startedAt: pgText("started_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  activity: jsonb("activity").notNull().default({}),
  result: jsonb("result"),
  outcomes: jsonb("outcomes"),
  configPath: pgText("config_path").notNull(),
}, (table) => [
  pgIndex("idx_pg_runs_status").on(table.status),
  pgIndex("idx_pg_runs_task_id").on(table.taskId),
]);
