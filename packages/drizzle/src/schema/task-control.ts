import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { index as pgIndex, integer as pgInteger, jsonb, pgTable, text as pgText, varchar } from "drizzle-orm/pg-core";

export const taskDirectionsSqlite = sqliteTable("task_directions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  runId: text("run_id"),
  mode: text("mode").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("queued"),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at"),
  appliedAt: text("applied_at"),
  error: text("error"),
}, (table) => [
  index("idx_task_directions_task").on(table.taskId),
  index("idx_task_directions_run_status").on(table.runId, table.status),
]);

export const agentCheckpointsSqlite = sqliteTable("agent_checkpoints", {
  taskId: text("task_id").primaryKey(),
  runId: text("run_id").notNull(),
  messages: text("messages").notNull().default("[]"),
  savedAt: text("saved_at").notNull(),
  turnCount: integer("turn_count").notNull().default(0),
});

export const backgroundWaitsSqlite = sqliteTable("background_waits", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  sessionId: text("session_id").notNull(),
  targetStatus: text("target_status"),
  state: text("state").notNull().default("waiting"),
  lastTaskStatus: text("last_task_status"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  triggeredAt: text("triggered_at"),
  completedAt: text("completed_at"),
  error: text("error"),
}, (table) => [
  index("idx_background_waits_session_state").on(table.sessionId, table.state),
  index("idx_background_waits_task_state").on(table.taskId, table.state),
]);

export const taskDirectionsPg = pgTable("task_directions", {
  id: pgText("id").primaryKey(),
  taskId: pgText("task_id").notNull(),
  runId: pgText("run_id"),
  mode: varchar("mode", { length: 32 }).notNull(),
  message: pgText("message").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("queued"),
  createdAt: pgText("created_at").notNull(),
  deliveredAt: pgText("delivered_at"),
  appliedAt: pgText("applied_at"),
  error: pgText("error"),
}, (table) => [
  pgIndex("idx_pg_task_directions_task").on(table.taskId),
  pgIndex("idx_pg_task_directions_run_status").on(table.runId, table.status),
]);

export const agentCheckpointsPg = pgTable("agent_checkpoints", {
  taskId: pgText("task_id").primaryKey(),
  runId: pgText("run_id").notNull(),
  messages: jsonb("messages").notNull().default([]),
  savedAt: pgText("saved_at").notNull(),
  turnCount: pgInteger("turn_count").notNull().default(0),
});

export const backgroundWaitsPg = pgTable("background_waits", {
  id: pgText("id").primaryKey(),
  taskId: pgText("task_id").notNull(),
  sessionId: pgText("session_id").notNull(),
  targetStatus: pgText("target_status"),
  state: varchar("state", { length: 32 }).notNull().default("waiting"),
  lastTaskStatus: pgText("last_task_status"),
  attempts: pgInteger("attempts").notNull().default(0),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  triggeredAt: pgText("triggered_at"),
  completedAt: pgText("completed_at"),
  error: pgText("error"),
}, (table) => [
  pgIndex("idx_pg_background_waits_session_state").on(table.sessionId, table.state),
  pgIndex("idx_pg_background_waits_task_state").on(table.taskId, table.state),
]);
