import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  boolean as pgBoolean,
  index as pgIndex,
} from "drizzle-orm/pg-core";

/**
 * Expo push token store schema — mirrors FileExpoTokenStore.
 *
 * `token` is the natural PK (Expo issues unique tokens per device install).
 * deviceId is non-PK because a single device can rotate tokens; we keep an
 * index on it so token-rotation lookups stay fast.
 */

// ── SQLite schema ──────────────────────────────────────────────────────

export const expoTokensSqlite = sqliteTable("expo_tokens", {
  token: text("token").primaryKey(),
  platform: text("platform").notNull(),
  deviceId: text("device_id").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  failureCount: integer("failure_count").notNull().default(0),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  index("idx_expo_tokens_device_id").on(table.deviceId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const expoTokensPg = pgTable("expo_tokens", {
  token: pgText("token").primaryKey(),
  platform: pgText("platform").notNull(),
  deviceId: pgText("device_id").notNull(),
  createdAt: pgText("created_at").notNull(),
  lastSeenAt: pgText("last_seen_at").notNull(),
  failureCount: pgInteger("failure_count").notNull().default(0),
  disabled: pgBoolean("disabled").notNull().default(false),
}, (table) => [
  pgIndex("idx_pg_expo_tokens_device_id").on(table.deviceId),
]);
