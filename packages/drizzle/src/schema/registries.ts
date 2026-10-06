import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core";

// Registry entities are documents (their fields evolve with the product): the full object is in
// `doc`, the columns used for lookups, uniqueness and ordering are copied next to it.

// ── Apps ───────────────────────────────────────────────────────────────

export const appsSqlite = sqliteTable("apps", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_apps_slug").on(table.slug),
]);

export const appsPg = pgTable("apps", {
  id: pgText("id").primaryKey(),
  slug: pgText("slug").notNull(),
  name: pgText("name").notNull(),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgUniqueIndex("idx_pg_apps_slug").on(table.slug),
]);

// ── Data registry ──────────────────────────────────────────────────────

export const dataSourcesSqlite = sqliteTable("data_sources", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_data_sources_slug").on(table.slug),
]);

export const dataViewsSqlite = sqliteTable("data_views", {
  id: text("id").primaryKey(),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_data_views_updated_at").on(table.updatedAt),
]);

export const dataActivitySqlite = sqliteTable("data_activity", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_data_activity_created_at").on(table.createdAt),
  index("idx_data_activity_source").on(table.sourceId, table.createdAt),
]);

export const dataSourcesPg = pgTable("data_sources", {
  id: pgText("id").primaryKey(),
  slug: pgText("slug").notNull(),
  name: pgText("name").notNull(),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgUniqueIndex("idx_pg_data_sources_slug").on(table.slug),
]);

export const dataViewsPg = pgTable("data_views", {
  id: pgText("id").primaryKey(),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_data_views_updated_at").on(table.updatedAt),
]);

export const dataActivityPg = pgTable("data_activity", {
  id: pgText("id").primaryKey(),
  sourceId: pgText("source_id").notNull(),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_data_activity_created_at").on(table.createdAt),
  pgIndex("idx_pg_data_activity_source").on(table.sourceId, table.createdAt),
]);
