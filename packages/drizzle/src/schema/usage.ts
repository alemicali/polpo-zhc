import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, doublePrecision, jsonb, index as pgIndex } from "drizzle-orm/pg-core";

// ── Token usage (one row per model call) ───────────────────────────────

export const tokenUsageSqlite = sqliteTable("token_usage", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  source: text("source").notNull(),
  provider: text("provider"),
  model: text("model"),
  sessionId: text("session_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  cost: real("cost").notNull().default(0),
}, (table) => [
  index("idx_token_usage_timestamp").on(table.timestamp),
]);

export const tokenUsagePg = pgTable("token_usage", {
  id: pgText("id").primaryKey(),
  timestamp: pgText("timestamp").notNull(),
  source: pgText("source").notNull(),
  provider: pgText("provider"),
  model: pgText("model"),
  sessionId: pgText("session_id"),
  inputTokens: pgInteger("input_tokens").notNull().default(0),
  outputTokens: pgInteger("output_tokens").notNull().default(0),
  cacheReadTokens: pgInteger("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: pgInteger("cache_write_tokens").notNull().default(0),
  totalTokens: pgInteger("total_tokens").notNull().default(0),
  cost: doublePrecision("cost").notNull().default(0),
}, (table) => [
  pgIndex("idx_pg_token_usage_timestamp").on(table.timestamp),
]);

// ── Context checkpoints (one per chat session) ─────────────────────────

export const contextCheckpointsSqlite = sqliteTable("context_checkpoints", {
  sessionId: text("session_id").primaryKey(),
  revision: text("revision").notNull(),
  checkpoint: text("checkpoint").notNull(), // JSON ContextCheckpoint
  updatedAt: text("updated_at").notNull(),
});

export const contextCheckpointsPg = pgTable("context_checkpoints", {
  sessionId: pgText("session_id").primaryKey(),
  revision: pgText("revision").notNull(),
  checkpoint: jsonb("checkpoint").notNull(),
  updatedAt: pgText("updated_at").notNull(),
});
