import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, varchar, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const approvalsSqlite = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  gateId: text("gate_id").notNull(),
  gateName: text("gate_name").notNull(),
  taskId: text("task_id"),
  missionId: text("mission_id"),
  status: text("status").notNull().default("pending"),
  payload: text("payload"),
  requestedAt: text("requested_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
  note: text("note"),
}, (table) => [
  index("idx_approvals_status").on(table.status),
  index("idx_approvals_task_id").on(table.taskId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const approvalsPg = pgTable("approvals", {
  id: pgText("id").primaryKey(),
  gateId: pgText("gate_id").notNull(),
  gateName: pgText("gate_name").notNull(),
  taskId: pgText("task_id"),
  missionId: pgText("mission_id"),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  payload: jsonb("payload"),
  requestedAt: pgText("requested_at").notNull(),
  resolvedAt: pgText("resolved_at"),
  resolvedBy: pgText("resolved_by"),
  note: pgText("note"),
}, (table) => [
  pgIndex("idx_pg_approvals_status").on(table.status),
  pgIndex("idx_pg_approvals_task_id").on(table.taskId),
]);
