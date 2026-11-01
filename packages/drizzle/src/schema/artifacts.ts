import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, jsonb, index as pgIndex } from "drizzle-orm/pg-core";

// Artifacts (documents, dashboards, designs, diagrams): the whole artifact, versions included, is in
// `doc`; the columns used to list and filter are copied next to it.

export const artifactsSqlite = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  createdBy: text("created_by").notNull(),
  sessionId: text("session_id"),
  doc: text("doc").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_artifacts_updated").on(table.updatedAt),
  index("idx_artifacts_session").on(table.sessionId),
]);

export const artifactsPg = pgTable("artifacts", {
  id: pgText("id").primaryKey(),
  type: pgText("type").notNull(),
  createdBy: pgText("created_by").notNull(),
  sessionId: pgText("session_id"),
  doc: jsonb("doc").notNull(),
  createdAt: pgText("created_at").notNull(),
  updatedAt: pgText("updated_at").notNull(),
}, (table) => [
  pgIndex("idx_pg_artifacts_updated").on(table.updatedAt),
  pgIndex("idx_pg_artifacts_session").on(table.sessionId),
]);
