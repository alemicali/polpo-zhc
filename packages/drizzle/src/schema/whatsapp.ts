import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, bigint, boolean as pgBoolean, index as pgIndex } from "drizzle-orm/pg-core";

// WhatsApp messages and contacts seen by the channel (timestamps are Unix seconds, as WhatsApp sends them).

export const whatsappMessagesSqlite = sqliteTable("whatsapp_messages", {
  id: text("id").primaryKey(),
  chatJid: text("chat_jid").notNull(),
  senderJid: text("sender_jid").notNull(),
  senderName: text("sender_name"),
  text: text("text").notNull(),
  fromMe: integer("from_me", { mode: "boolean" }).notNull().default(false),
  timestamp: integer("timestamp").notNull(),
  mediaType: text("media_type"),
  mediaPath: text("media_path"),
  mimeType: text("mime_type"),
  fileName: text("file_name"),
  mediaSize: integer("media_size"),
  readAt: integer("read_at"),
}, (table) => [
  index("idx_whatsapp_messages_chat").on(table.chatJid, table.timestamp),
  index("idx_whatsapp_messages_ts").on(table.timestamp),
]);

export const whatsappContactsSqlite = sqliteTable("whatsapp_contacts", {
  jid: text("jid").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  lastSeen: integer("last_seen").notNull().default(0),
}, (table) => [
  index("idx_whatsapp_contacts_phone").on(table.phone),
  index("idx_whatsapp_contacts_last_seen").on(table.lastSeen),
]);

export const whatsappMessagesPg = pgTable("whatsapp_messages", {
  id: pgText("id").primaryKey(),
  chatJid: pgText("chat_jid").notNull(),
  senderJid: pgText("sender_jid").notNull(),
  senderName: pgText("sender_name"),
  text: pgText("text").notNull(),
  fromMe: pgBoolean("from_me").notNull().default(false),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  mediaType: pgText("media_type"),
  mediaPath: pgText("media_path"),
  mimeType: pgText("mime_type"),
  fileName: pgText("file_name"),
  mediaSize: bigint("media_size", { mode: "number" }),
  readAt: bigint("read_at", { mode: "number" }),
}, (table) => [
  pgIndex("idx_pg_whatsapp_messages_chat").on(table.chatJid, table.timestamp.desc()),
  pgIndex("idx_pg_whatsapp_messages_ts").on(table.timestamp.desc()),
]);

export const whatsappContactsPg = pgTable("whatsapp_contacts", {
  jid: pgText("jid").primaryKey(),
  name: pgText("name").notNull(),
  phone: pgText("phone").notNull(),
  lastSeen: bigint("last_seen", { mode: "number" }).notNull().default(0),
}, (table) => [
  pgIndex("idx_pg_whatsapp_contacts_phone").on(table.phone),
  pgIndex("idx_pg_whatsapp_contacts_last_seen").on(table.lastSeen.desc()),
]);
