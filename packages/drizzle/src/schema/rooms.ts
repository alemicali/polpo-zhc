import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, index as pgIndex, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core";

// Rooms: group conversations of people and agents (a Telegram group, a group chat on the web),
// one transcript for everyone. See RoomStore in @polpo-ai/core.

// ── SQLite schema ──────────────────────────────────────────────────────

export const roomsSqlite = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  /** JSON: agent names. */
  agents: text("agents").notNull(),
  /** JSON: RoomSettings. */
  settings: text("settings").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_rooms_kind").on(table.kind, table.updatedAt),
]);

export const roomMessagesSqlite = sqliteTable("room_messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => roomsSqlite.id, { onDelete: "cascade" }),
  /** Insertion order within the room (ties on ts are common: several agents at once). */
  seq: integer("seq").notNull(),
  ts: text("ts").notNull(),
  authorKind: text("author_kind").notNull(),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  text: text("text").notNull(),
  externalId: text("external_id"),
  /** JSON: agent names. */
  addressedTo: text("addressed_to"),
  replyToId: text("reply_to_id"),
}, (table) => [
  index("idx_room_messages_room").on(table.roomId, table.seq),
  uniqueIndex("idx_room_messages_external").on(table.roomId, table.externalId),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const roomsPg = pgTable("rooms", {
  id: pgText("id").primaryKey(),
  kind: pgText("kind").notNull(),
  title: pgText("title").notNull(),
  agents: pgText("agents").notNull(),
  settings: pgText("settings").notNull(),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_rooms_kind").on(table.kind, table.updatedAt),
]);

export const roomMessagesPg = pgTable("room_messages", {
  id: pgText("id").primaryKey(),
  roomId: pgText("room_id").notNull().references(() => roomsPg.id, { onDelete: "cascade" }),
  seq: pgInteger("seq").notNull(),
  ts: pgText("ts").notNull(),
  authorKind: pgText("author_kind").notNull(),
  authorId: pgText("author_id").notNull(),
  authorName: pgText("author_name").notNull(),
  text: pgText("text").notNull(),
  externalId: pgText("external_id"),
  addressedTo: pgText("addressed_to"),
  replyToId: pgText("reply_to_id"),
}, (table) => [
  pgIndex("idx_pg_room_messages_room").on(table.roomId, table.seq),
  pgUniqueIndex("idx_pg_room_messages_external").on(table.roomId, table.externalId),
]);
