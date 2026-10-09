/**
 * Move a project to PostgreSQL without losing anything.
 *
 * 1. The source is copied first: .polpo/state.db through SQLite's backup API (consistent even
 *    while the server runs), or, for projects on files, a fresh SQLite built from them. The
 *    original database and files are never written to.
 * 2. The copy is brought to the latest schema and receives the data still kept in .polpo files
 *    (vault, push, Expo, usage, checkpoints, apps, data registry, brain, WhatsApp).
 * 3. The target database is migrated and must be empty; every table is copied in one
 *    transaction (all or nothing), parents before children.
 * 4. Each table is verified: same row count and same digest of all rows on both sides.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableColumns, sql } from "drizzle-orm";
import { pgSafe } from "@polpo-ai/drizzle";

export interface MoveToPostgresOptions {
  polpoDir: string;
  databaseUrl: string;
  /** Source backend; "file" builds the SQLite copy from the .polpo files. */
  source: "sqlite" | "file";
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface TableReport {
  table: string;
  rows: number;
  verified: boolean;
}

export interface MoveToPostgresResult {
  ok: boolean;
  tables: TableReport[];
  durationMs: number;
}

const BATCH = 1_000;

export async function moveToPostgres(opts: MoveToPostgresOptions): Promise<MoveToPostgresResult> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  nulValues = 0;
  const drizzleMod = await import("@polpo-ai/drizzle");
  const { sqliteSchema, pgSchema, migrateSqlite, migratePg, configureSqlite, createSqliteStores } = drizzleMod;
  const { createRequire } = await import("node:module");
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const { drizzle: sqliteDrizzle } = await import("drizzle-orm/better-sqlite3");
  const { drizzle: pgDrizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;

  // ── 1. Working copy of the source ──────────────────────────────────
  const work = mkdtempSync(join(tmpdir(), "polpo-to-pg-"));
  const copyPath = join(work, "state.db");
  const source = join(opts.polpoDir, "state.db");
  let sqliteClient: any;
  const pg = postgres(opts.databaseUrl, { max: 4, onnotice: () => {} });
  try {
    if (opts.source === "sqlite") {
      if (!existsSync(source)) throw new Error(`No SQLite database at ${source}`);
      const original = new Database(source, { readonly: true, fileMustExist: true });
      await original.backup(copyPath);
      original.close();
      log(`Copied ${source} (backup API) to a working copy.`);
    }
    sqliteClient = new Database(copyPath);
    configureSqlite(sqliteClient);
    const sqliteDb = sqliteDrizzle(sqliteClient);
    migrateSqlite(sqliteDb);
    if (opts.source === "file") {
      const { migrateFileToSqlite } = await import("./file-to-sqlite.js");
      const result = await migrateFileToSqlite(opts.polpoDir, sqliteDb, sqliteSchema, { log: (m) => log(`  ${m}`) });
      if (!result.ok) throw new Error("Reading the .polpo files failed; nothing was written to PostgreSQL.");
    }
    // ── 2. Data still in .polpo files ────────────────────────────────
    const { importFileStores } = await import("../stores/import-file-stores.js");
    await importFileStores({
      polpoDir: opts.polpoDir,
      stores: createSqliteStores(sqliteDb),
      db: sqliteDb,
      schema: sqliteSchema,
      dialect: "sqlite",
      log: (m) => log(`  ${m}`),
    });

    // ── 3. Target ────────────────────────────────────────────────────
    const pgDb = pgDrizzle(pg);
    await migratePg(pgDb);
    const names = Object.keys(sqliteSchema) as Array<keyof typeof sqliteSchema>;
    for (const name of names) {
      const target = (pgSchema as any)[name];
      const [{ n }] = await pgDb.select({ n: sql<number>`count(*)` }).from(target);
      if (Number(n) > 0) {
        throw new Error(`Target table "${tableName(target)}" is not empty: use an empty database (nothing was copied).`);
      }
    }

    const tables: TableReport[] = [];
    if (opts.dryRun) {
      for (const name of names) {
        const [{ n }] = await sqliteDb.select({ n: sql<number>`count(*)` }).from((sqliteSchema as any)[name]);
        tables.push({ table: tableName((sqliteSchema as any)[name]), rows: Number(n), verified: false });
      }
      log("Dry run: PostgreSQL schema created, nothing copied.");
      return { ok: true, tables, durationMs: Date.now() - t0 };
    }

    await pgDb.transaction(async (tx: any) => {
      for (const name of names) {
        const from = (sqliteSchema as any)[name];
        const to = (pgSchema as any)[name];
        const jsonb = jsonbColumns(to);
        let copied = 0;
        for (let offset = 0; ; offset += BATCH) {
          const rows: any[] = await sqliteDb.select().from(from).limit(BATCH).offset(offset);
          if (rows.length === 0) break;
          await tx.insert(to).values(rows.map((row) => toPgRow(row, jsonb)));
          copied += rows.length;
          if (rows.length < BATCH) break;
        }
        if (copied > 0) log(`  ${tableName(to)}: ${copied} row(s)`);
      }
    });

    // ── 4. Verification ──────────────────────────────────────────────
    let ok = true;
    for (const name of names) {
      const from = (sqliteSchema as any)[name];
      const to = (pgSchema as any)[name];
      const jsonb = jsonbColumns(to);
      const [a, b] = await Promise.all([
        digest(await sqliteDb.select().from(from), jsonb),
        digest(await pgDb.select().from(to), jsonb),
      ]);
      const verified = a.rows === b.rows && a.hash === b.hash;
      if (!verified) ok = false;
      tables.push({ table: tableName(to), rows: b.rows, verified });
      if (!verified) log(`  MISMATCH ${tableName(to)}: source ${a.rows} rows, target ${b.rows} rows`);
    }
    if (nulValues > 0) log(`  ${nulValues} value(s) contained characters PostgreSQL cannot store (NUL, broken surrogates), replaced with U+FFFD.`);
    return { ok, tables, durationMs: Date.now() - t0 };
  } finally {
    sqliteClient?.close();
    await pg.end({ timeout: 5 });
    rmSync(work, { recursive: true, force: true });
  }
}

const tableName = (table: any): string => table[Symbol.for("drizzle:Name")] ?? "?";

/** Properties of the PostgreSQL table stored as jsonb (TEXT holding JSON on SQLite). */
function jsonbColumns(table: any): Set<string> {
  return new Set(Object.entries(getTableColumns(table))
    .filter(([, column]) => (column as any).columnType === "PgJsonb")
    .map(([key]) => key));
}

/** Values with characters PostgreSQL cannot store (NUL, broken surrogates), reported at the end. */
let nulValues = 0;

/** Replaces what PostgreSQL rejects with U+FFFD, keeping the rest of the value; counts the changes. */
function pgSafeCounted(value: unknown): unknown {
  const safe = pgSafe(value);
  if (JSON.stringify(safe) !== JSON.stringify(value)) nulValues++;
  return safe;
}

/** SQLite keeps JSON as text: PostgreSQL jsonb wants the value itself. */
function toPgRow(row: Record<string, unknown>, jsonb: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = pgSafeCounted(jsonb.has(key) ? parseJson(value) : value);
  }
  return out;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** Order-independent digest of a table's rows, with JSON compared by value on both sides. */
function digest(rows: Array<Record<string, unknown>>, jsonb: Set<string>): { rows: number; hash: string } {
  // Same transformation as the copy (JSON parsed, NUL replaced), so equal digests mean equal data.
  const canonical = rows.map((row) => stableStringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    pgSafe(jsonb.has(key) ? parseJson(value) : typeof value === "boolean" ? Number(value) : value),
  ])))).sort();
  return { rows: rows.length, hash: createHash("sha256").update(canonical.join("\n")).digest("hex") };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(",")}}`;
}

// Keep the copy helper reachable for tests of the CLI wrapper.
export const __private = { toPgRow, digest, jsonbColumns, copyFileSync };
