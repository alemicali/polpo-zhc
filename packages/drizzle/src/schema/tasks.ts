import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, jsonb, varchar, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const tasksSqlite = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  assignTo: text("assign_to").notNull(),
  group: text("group"),
  missionId: text("mission_id"),
  dependsOn: text("depends_on").notNull().default("[]"),
  status: text("status").notNull().default("pending"),
  retries: integer("retries").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(2),
  maxDuration: integer("max_duration"),
  retryPolicy: text("retry_policy"),
  expectations: text("expectations").notNull().default("[]"),
  metrics: text("metrics").notNull().default("[]"),
  result: text("result"),
  phase: text("phase"),
  fixAttempts: integer("fix_attempts").notNull().default(0),
  resolutionAttempts: integer("resolution_attempts").notNull().default(0),
  originalDescription: text("original_description"),
  sessionId: text("session_id"),
  notifications: text("notifications"),
  outcomes: text("outcomes"),
  expectedOutcomes: text("expected_outcomes"),
  deadline: text("deadline"),
  priority: text("priority"),
  sideEffects: integer("side_effects"),
  revisionCount: integer("revision_count"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_tasks_status").on(table.status),
  index("idx_tasks_group").on(table.group),
  index("idx_tasks_assign_to").on(table.assignTo),
  index("idx_tasks_mission_id").on(table.missionId),
]);

export const missionsSqlite = sqliteTable("missions", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  data: text("data").notNull(),
  prompt: text("prompt"),
  status: text("status").notNull().default("draft"),
  schedule: text("schedule"),
  endDate: text("end_date"),
  qualityThreshold: text("quality_threshold"),
  deadline: text("deadline"),
  notifications: text("notifications"),
  executionCount: integer("execution_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_missions_status").on(table.status),
]);

export const metadataSqlite = sqliteTable("metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const processesSqlite = sqliteTable("processes", {
  agentName: text("agent_name").notNull(),
  pid: integer("pid").notNull(),
  taskId: text("task_id").notNull(),
  startedAt: text("started_at").notNull(),
  alive: integer("alive").notNull().default(1),
  activity: text("activity").notNull().default("{}"),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const tasksPg = pgTable("tasks", {
  id: pgText("id").primaryKey(),
  title: pgText("title").notNull(),
  description: pgText("description").notNull(),
  assignTo: pgText("assign_to").notNull(),
  group: pgText("group"),
  missionId: pgText("mission_id"),
  dependsOn: jsonb("depends_on").notNull().default([]),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  retries: pgInteger("retries").notNull().default(0),
  maxRetries: pgInteger("max_retries").notNull().default(2),
  maxDuration: pgInteger("max_duration"),
  retryPolicy: jsonb("retry_policy"),
  expectations: jsonb("expectations").notNull().default([]),
  metrics: jsonb("metrics").notNull().default([]),
  result: jsonb("result"),
  phase: varchar("phase", { length: 32 }),
  fixAttempts: pgInteger("fix_attempts").notNull().default(0),
  resolutionAttempts: pgInteger("resolution_attempts").notNull().default(0),
  originalDescription: pgText("original_description"),
  sessionId: pgText("session_id"),
  notifications: jsonb("notifications"),
  outcomes: jsonb("outcomes"),
  expectedOutcomes: jsonb("expected_outcomes"),
  deadline: pgText("deadline"),
  priority: pgText("priority"),
  sideEffects: pgInteger("side_effects"),
  revisionCount: pgInteger("revision_count"),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_tasks_status").on(table.status),
  pgIndex("idx_pg_tasks_group").on(table.group),
  pgIndex("idx_pg_tasks_assign_to").on(table.assignTo),
  pgIndex("idx_pg_tasks_mission_id").on(table.missionId),
]);

export const missionsPg = pgTable("missions", {
  id: pgText("id").primaryKey(),
  name: pgText("name").notNull().unique(),
  data: pgText("data").notNull(),
  prompt: pgText("prompt"),
  status: varchar("status", { length: 32 }).notNull().default("draft"),
  schedule: pgText("schedule"),
  endDate: pgText("end_date"),
  qualityThreshold: pgText("quality_threshold"),
  deadline: pgText("deadline"),
  notifications: jsonb("notifications"),
  executionCount: pgInteger("execution_count").notNull().default(0),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_missions_status").on(table.status),
]);

export const metadataPg = pgTable("metadata", {
  key: pgText("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const processesPg = pgTable("processes", {
  agentName: pgText("agent_name").notNull(),
  pid: pgInteger("pid").notNull(),
  taskId: pgText("task_id").notNull(),
  startedAt: pgText("started_at").notNull(),
  alive: pgInteger("alive").notNull().default(1),
  activity: jsonb("activity").notNull().default({}),
});
