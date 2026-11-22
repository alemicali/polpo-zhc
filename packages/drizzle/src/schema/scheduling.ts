import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex } from "drizzle-orm/pg-core";

// Runtime state of the schedulers, so a restart loses nothing:
// - schedules: per mission, paused or not, next/last run, last outcome, missed runs (the whole state in `doc`);
// - leases: claims shared by every process on the database (one run per schedule occurrence);
// - task_watchers: "when task X reaches a status, do Y" (the whole watcher in `doc`).

export const schedulesSqlite = sqliteTable("schedules", {
  missionId: text("mission_id").primaryKey(),
  doc: text("doc").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const leasesSqlite = sqliteTable("leases", {
  key: text("key").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_leases_expires").on(table.expiresAt),
]);

export const taskWatchersSqlite = sqliteTable("task_watchers", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
});

export const schedulesPg = pgTable("schedules", {
  missionId: pgText("mission_id").primaryKey(),
  doc: jsonb("doc").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});

export const leasesPg = pgTable("leases", {
  key: pgText("key").primaryKey(),
  owner: pgText("owner").notNull(),
  expiresAt: pgText("expires_at").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_leases_expires").on(table.expiresAt),
]);

export const taskWatchersPg = pgTable("task_watchers", {
  id: pgText("id").primaryKey(),
  taskId: pgText("task_id").notNull(),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
});
