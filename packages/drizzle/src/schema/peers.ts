import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, varchar, index as pgIndex } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const peersSqlite = sqliteTable("peers", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  externalId: text("external_id").notNull(),
  displayName: text("display_name"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  linkedTo: text("linked_to"),
}, (table) => [
  index("idx_peers_channel").on(table.channel),
  index("idx_peers_external_id").on(table.externalId),
]);

export const peerAllowlistSqlite = sqliteTable("peer_allowlist", {
  peerId: text("peer_id").primaryKey(),
});

export const pairingRequestsSqlite = sqliteTable("pairing_requests", {
  id: text("id").primaryKey(),
  peerId: text("peer_id").notNull(),
  channel: text("channel").notNull(),
  externalId: text("external_id").notNull(),
  displayName: text("display_name"),
  code: text("code").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  resolved: integer("resolved").notNull().default(0),
}, (table) => [
  index("idx_pairing_code").on(table.code),
  index("idx_pairing_peer").on(table.peerId),
]);

export const peerSessionsSqlite = sqliteTable("peer_sessions", {
  peerId: text("peer_id").primaryKey(),
  sessionId: text("session_id").notNull(),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const peersPg = pgTable("peers", {
  id: pgText("id").primaryKey(),
  channel: varchar("channel", { length: 32 }).notNull(),
  externalId: pgText("external_id").notNull(),
  displayName: pgText("display_name"),
  firstSeenAt: pgText("first_seen_at").notNull(),
  lastSeenAt: pgText("last_seen_at").notNull(),
  linkedTo: pgText("linked_to"),
}, (table) => [
  pgIndex("idx_pg_peers_channel").on(table.channel),
  pgIndex("idx_pg_peers_external_id").on(table.externalId),
]);

export const peerAllowlistPg = pgTable("peer_allowlist", {
  peerId: pgText("peer_id").primaryKey(),
});

export const pairingRequestsPg = pgTable("pairing_requests", {
  id: pgText("id").primaryKey(),
  peerId: pgText("peer_id").notNull(),
  channel: varchar("channel", { length: 32 }).notNull(),
  externalId: pgText("external_id").notNull(),
  displayName: pgText("display_name"),
  code: pgText("code").notNull().unique(),
  createdAt: pgText("created_at").notNull(),
  expiresAt: pgText("expires_at").notNull(),
  resolved: pgInteger("resolved").notNull().default(0),
}, (table) => [
  pgIndex("idx_pg_pairing_code").on(table.code),
  pgIndex("idx_pg_pairing_peer").on(table.peerId),
]);

export const peerSessionsPg = pgTable("peer_sessions", {
  peerId: pgText("peer_id").primaryKey(),
  sessionId: pgText("session_id").notNull(),
});
