import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex } from "drizzle-orm/pg-core";

// WhatsApp Business (Meta Cloud API) channels:
// - wabiz_contacts: one row per channel and contact (wa_id), the whole contact in `doc`
//   (window, opt-in, opt-out);
// - wabiz_messages: inbound and outbound messages (wamid, or a queued send's local id) with their
//   status history and pricing, in `doc`; the columns are what queries filter on;
// - wabiz_processed: webhook keys already processed (a message's wamid, a (wamid, status) pair),
//   kept 7 days so Meta's retries are not handled twice.

export const wabizContactsSqlite = sqliteTable("wabiz_contacts", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  waId: text("wa_id").notNull(),
  doc: text("doc").notNull(),
  activityAt: text("activity_at").notNull(),
}, (table) => [
  index("idx_wabiz_contacts_channel").on(table.channel, table.activityAt),
]);

export const wabizMessagesSqlite = sqliteTable("wabiz_messages", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  waId: text("wa_id").notNull(),
  direction: text("direction").notNull(),
  initiated: text("initiated"),
  sentBy: text("sent_by"),
  status: text("status").notNull(),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_wabiz_messages_contact").on(table.channel, table.waId, table.createdAt),
  index("idx_wabiz_messages_created").on(table.channel, table.createdAt),
]);

export const wabizProcessedSqlite = sqliteTable("wabiz_processed", {
  key: text("key").primaryKey(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_wabiz_processed_created").on(table.createdAt),
]);

export const wabizContactsPg = pgTable("wabiz_contacts", {
  id: pgText("id").primaryKey(),
  channel: pgText("channel").notNull(),
  waId: pgText("wa_id").notNull(),
  doc: jsonb("doc").notNull(),
  activityAt: pgText("activity_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_wabiz_contacts_channel").on(table.channel, table.activityAt),
]);

export const wabizMessagesPg = pgTable("wabiz_messages", {
  id: pgText("id").primaryKey(),
  channel: pgText("channel").notNull(),
  waId: pgText("wa_id").notNull(),
  direction: pgText("direction").notNull(),
  initiated: pgText("initiated"),
  sentBy: pgText("sent_by"),
  status: pgText("status").notNull(),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_wabiz_messages_contact").on(table.channel, table.waId, table.createdAt),
  pgIndex("idx_pg_wabiz_messages_created").on(table.channel, table.createdAt),
]);

export const wabizProcessedPg = pgTable("wabiz_processed", {
  key: pgText("key").primaryKey(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_wabiz_processed_created").on(table.createdAt),
]);
