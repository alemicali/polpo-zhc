/**
 * Versioned schema migrations for both dialects.
 *
 * The Drizzle schema in src/schema is the single source of truth. `pnpm db:generate` turns
 * changes into SQL files under migrations/{pg,sqlite}, shipped with the package and applied
 * here at startup inside one transaction, in order, exactly once per database.
 *
 * Databases created before versioned migrations (by the old ensurePgSchema/ensureSqliteSchema)
 * are adopted in place: the frozen legacy DDL brings them up to the baseline, the baseline is
 * recorded as applied without running it, and the following migrations run normally. No data
 * is touched.
 */

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate as migrateBetterSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { ensureLegacyPgSchema } from "./legacy/pg-schema.js";
import { ensureLegacySqliteSchema } from "./legacy/sqlite-schema.js";

const folder = (dialect: "pg" | "sqlite") =>
  fileURLToPath(new URL(`../migrations/${dialect}`, import.meta.url));

/** Where the migration journal lives (drizzle's defaults). */
const PG_SCHEMA = "drizzle";
const JOURNAL = "__drizzle_migrations";

export interface MigrationResult {
  /** The database predated versioned migrations and was adopted at the baseline. */
  adoptedLegacy: boolean;
}

// ── PostgreSQL ──────────────────────────────────────────────────────────

/**
 * Bring a PostgreSQL database to the latest schema. Safe to call on every startup and from
 * several processes at once (an advisory lock serializes them).
 */
export async function migratePg(db: any): Promise<MigrationResult> {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  // One migrator at a time per database (the server and a CLI may start together). The lock is
  // session-level, so it is held on a reserved connection while the pool runs the migration.
  const client = db.$client;
  const lockConn = typeof client?.reserve === "function" ? await client.reserve() : null;
  if (lockConn) await lockConn`SELECT pg_advisory_lock(hashtext('polpo:migrations'))`;
  try {
    const rows: any = await db.execute(sql`
      SELECT
        to_regclass('public.tasks') IS NOT NULL AS has_tables,
        to_regclass(${`${PG_SCHEMA}.${JOURNAL}`}) IS NOT NULL AS has_journal
    `);
    const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
    const adoptedLegacy = !!row?.has_tables && !row?.has_journal;
    if (adoptedLegacy) {
      await ensureLegacyPgSchema(db);
      await stampBaselinePg(db);
    }
    await migrate(db, { migrationsFolder: folder("pg"), migrationsSchema: PG_SCHEMA, migrationsTable: JOURNAL });
    return { adoptedLegacy };
  } finally {
    if (lockConn) {
      await lockConn`SELECT pg_advisory_unlock(hashtext('polpo:migrations'))`.catch(() => {});
      lockConn.release();
    }
  }
}

async function stampBaselinePg(db: any): Promise<void> {
  const [baseline] = readMigrationFiles({ migrationsFolder: folder("pg") });
  if (!baseline) return;
  await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${PG_SCHEMA}"`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS "${PG_SCHEMA}"."${JOURNAL}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`));
  await db.execute(sql`INSERT INTO ${sql.raw(`"${PG_SCHEMA}"."${JOURNAL}"`)} ("hash", "created_at") VALUES (${baseline.hash}, ${baseline.folderMillis})`);
}

/** @deprecated Use {@link migratePg}. Kept for callers of the pre-migrations API. */
export async function ensurePgSchema(db: any): Promise<void> {
  await migratePg(db);
}

// ── SQLite ──────────────────────────────────────────────────────────────

/** Bring a SQLite database (Drizzle over better-sqlite3) to the latest schema. Synchronous, like the driver. */
export function migrateSqlite(db: any): MigrationResult {
  const client = db.$client as { exec(sql: string): void; prepare(sql: string): { get(...a: unknown[]): any; run(...a: unknown[]): unknown } };
  const has = (name: string) =>
    !!client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const adoptedLegacy = has("tasks") && !has(JOURNAL);
  if (adoptedLegacy) {
    ensureLegacySqliteSchema(client);
    const [baseline] = readMigrationFiles({ migrationsFolder: folder("sqlite") });
    if (baseline) {
      client.exec(`CREATE TABLE IF NOT EXISTS "${JOURNAL}" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
      client.prepare(`INSERT INTO "${JOURNAL}" ("hash", "created_at") VALUES (?, ?)`).run(baseline.hash, baseline.folderMillis);
    }
  }
  migrateBetterSqlite(db, { migrationsFolder: folder("sqlite"), migrationsTable: JOURNAL });
  return { adoptedLegacy };
}

/** SQLite connection settings Polpo relies on (WAL for concurrent readers, bounded lock waits). */
export function configureSqlite(client: { exec(sql: string): void; pragma?: (s: string) => unknown }): void {
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = NORMAL");
  client.exec("PRAGMA foreign_keys = ON");
  // Runners write to the same file: wait for the lock instead of failing, but not forever
  // (better-sqlite3 blocks the event loop while it waits).
  client.exec("PRAGMA busy_timeout = 2000");
}
