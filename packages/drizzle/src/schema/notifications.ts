import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, jsonb, varchar, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const notificationsSqlite = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  ruleId: text("rule_id").notNull(),
  ruleName: text("rule_name").notNull(),
  channel: text("channel").notNull(),
  channelType: text("channel_type").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  severity: text("severity").notNull(),
  sourceEvent: text("source_event").notNull(),
  attachmentCount: integer("attachment_count").notNull().default(0),
  attachmentTypes: text("attachment_types"),
  /** Who sent it (an agent with its task / chat), JSON; null for rules. */
  origin: text("origin"),
}, (table) => [
  index("idx_notifications_timestamp").on(table.timestamp),
  index("idx_notifications_status").on(table.status),
  index("idx_notifications_channel").on(table.channel),
  index("idx_notifications_rule_id").on(table.ruleId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const notificationsPg = pgTable("notifications", {
  id: pgText("id").primaryKey(),
  timestamp: pgText("timestamp").notNull(),
  ruleId: pgText("rule_id").notNull(),
  ruleName: pgText("rule_name").notNull(),
  channel: pgText("channel").notNull(),
  channelType: pgText("channel_type").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  error: pgText("error"),
  title: pgText("title").notNull(),
  body: pgText("body").notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  sourceEvent: pgText("source_event").notNull(),
  attachmentCount: pgInteger("attachment_count").notNull().default(0),
  attachmentTypes: jsonb("attachment_types"),
  /** Who sent it (an agent with its task / chat); null for rules. */
  origin: jsonb("origin"),
}, (table) => [
  pgIndex("idx_pg_notifications_timestamp").on(table.timestamp),
  pgIndex("idx_pg_notifications_status").on(table.status),
  pgIndex("idx_pg_notifications_channel").on(table.channel),
  pgIndex("idx_pg_notifications_rule_id").on(table.ruleId),
]);
