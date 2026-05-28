import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint,
} from "drizzle-orm/pg-core";

/**
 * Web Push subscription store schema — mirrors FilePushSubscriptionStore.
 *
 * - `push_subscriptions` keyed by the browser-issued endpoint URL.
 * - `push_vapid` is a singleton (id = 1) holding the VAPID keypair. Modeled
 *   as its own row rather than a JSON blob in metadata so the subject field
 *   is queryable and the keys never accidentally leak via a metadata dump.
 */

// ── SQLite schema ──────────────────────────────────────────────────────

export const pushSubscriptionsSqlite = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  expirationTime: integer("expiration_time"),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSuccessAt: text("last_success_at"),
  lastFailureAt: text("last_failure_at"),
  failureCount: integer("failure_count").notNull().default(0),
});

export const pushVapidSqlite = sqliteTable("push_vapid", {
  id: integer("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  subject: text("subject").notNull(),
});

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const pushSubscriptionsPg = pgTable("push_subscriptions", {
  endpoint: pgText("endpoint").primaryKey(),
  expirationTime: bigint("expiration_time", { mode: "number" }),
  p256dh: pgText("p256dh").notNull(),
  auth: pgText("auth").notNull(),
  userAgent: pgText("user_agent"),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
  lastSuccessAt: pgText("last_success_at"),
  lastFailureAt: pgText("last_failure_at"),
  failureCount: pgInteger("failure_count").notNull().default(0),
});

export const pushVapidPg = pgTable("push_vapid", {
  id: pgInteger("id").primaryKey(),
  publicKey: pgText("public_key").notNull(),
  privateKey: pgText("private_key").notNull(),
  subject: pgText("subject").notNull(),
});
