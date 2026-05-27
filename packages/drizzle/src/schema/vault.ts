import { sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, primaryKey as pgPrimaryKey } from "drizzle-orm/pg-core";

// ── SQLite schema ──────────────────────────────────────────────────────

export const vaultSqlite = sqliteTable("vault", {
  agent: text("agent").notNull(),
  service: text("service").notNull(),
  type: text("type").notNull(),       // "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom"
  label: text("label"),
  // Optional logical account name (groups SMTP+IMAP entries of the same
  // mailbox). When null, the resolver falls back to `service` as account.
  account: text("account"),
  credentials: text("credentials").notNull(), // JSON-serialized Record<string, string>
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.agent, table.service] }),
]);

// ── PostgreSQL schema ──────────────────────────────────────────────────

export const vaultPg = pgTable("vault", {
  agent: pgText("agent").notNull(),
  service: pgText("service").notNull(),
  type: pgText("type").notNull(),
  label: pgText("label"),
  account: pgText("account"),
  credentials: pgText("credentials").notNull(), // AES-256-GCM encrypted, base64-encoded
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgPrimaryKey({ columns: [table.agent, table.service] }),
]);
