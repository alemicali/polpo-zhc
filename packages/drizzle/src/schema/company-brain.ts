import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, jsonb, primaryKey as pgPrimaryKey } from "drizzle-orm/pg-core";

/**
 * Company brain items, one row each: kind is entity | relation | claim | grant | run | activity.
 * `seq` keeps the order of the snapshot arrays (insertion order; runs and activity newest first).
 */
export const brainItemsSqlite = sqliteTable("brain_items", {
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  seq: integer("seq").notNull(),
  doc: text("doc").notNull(),
}, (table) => [
  primaryKey({ columns: [table.kind, table.id] }),
]);

export const brainItemsPg = pgTable("brain_items", {
  kind: pgText("kind").notNull(),
  id: pgText("id").notNull(),
  seq: pgInteger("seq").notNull(),
  doc: jsonb("doc").notNull(),
}, (table) => [
  pgPrimaryKey({ columns: [table.kind, table.id] }),
]);
