/**
 * Opens the configured database for the server, the CLI and agent runners: one place that knows
 * how to connect, configure and migrate each backend.
 *
 * - "postgres": postgres.js pool → Drizzle; schema migrated by the server and the CLI.
 * - "sqlite":   better-sqlite3 on .polpo/state.db (WAL) → Drizzle; same migrations.
 * - "file":     no database; callers fall back to the JSON file stores.
 *
 * Runners never migrate: they are spawned by a server that already did.
 */

import { join, resolve } from "node:path";
import type { DrizzleStores } from "@polpo-ai/drizzle";

export type StorageKind = "file" | "sqlite" | "postgres";

/** Who is opening the database: decides pool size and whether to migrate. */
export type StorageRole = "server" | "cli" | "runner";

export interface OpenStorageOptions {
  /** Import data still in .polpo files into the database once (server only). Default: true. */
  importFiles?: boolean;
  storage: StorageKind | undefined;
  polpoDir: string;
  databaseUrl?: string | undefined;
  role: StorageRole;
  /** Called with progress messages (migrations, legacy adoption). */
  log?: (message: string) => void;
}

export interface DatabaseStorage {
  kind: "sqlite" | "postgres";
  stores: DrizzleStores;
  /** The Drizzle database, for migrations and maintenance tasks. */
  db: any;
  /** Close the connection pool / database file. */
  close(): Promise<void>;
}

export interface FileStorage {
  kind: "file";
  close(): Promise<void>;
}

export type OpenStorage = DatabaseStorage | FileStorage;

/**
 * Database stores of the projects open in this process, by .polpo directory. Code that only knows
 * the project directory (route factories, runtimes, channels) finds the database stores here and
 * falls back to the file stores when the project runs on files.
 */
const openDatabases = new Map<string, DrizzleStores>();

export function databaseStoresFor(polpoDir: string): DrizzleStores | undefined {
  return openDatabases.get(resolve(polpoDir));
}

/** Connections per process: the server serves HTTP and the orchestrator; runners do a few writes. */
const POOL_SIZE: Record<StorageRole, number> = { server: 10, cli: 2, runner: 2 };

export async function openStorage(opts: OpenStorageOptions): Promise<OpenStorage> {
  const log = opts.log ?? (() => {});

  if (opts.storage === "postgres") {
    const url = opts.databaseUrl ?? process.env["DATABASE_URL"];
    if (!url) throw new Error('storage: "postgres" requires a databaseUrl in settings or DATABASE_URL env var');
    const { createPgStores, migratePg } = await import("@polpo-ai/drizzle");
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const sql = postgres(url, {
      max: POOL_SIZE[opts.role],
      idle_timeout: 60,
      connect_timeout: 15,
      onnotice: () => {},
    });
    const db = drizzle(sql);
    if (opts.role !== "runner") {
      const result = await migratePg(db);
      if (result.adoptedLegacy) log("PostgreSQL database predates versioned migrations: adopted at the baseline (no data changed).");
    }
    const stores = createPgStores(db);
    const key = resolve(opts.polpoDir);
    openDatabases.set(key, stores);
    if (opts.role === "server" && opts.importFiles !== false) {
      const { pgSchema } = await import("@polpo-ai/drizzle");
      const { importFileStores } = await import("../stores/import-file-stores.js");
      await importFileStores({ polpoDir: opts.polpoDir, stores, db, schema: pgSchema, dialect: "pg", log });
    }
    return {
      kind: "postgres", stores, db,
      close: async () => {
        if (openDatabases.get(key) === stores) openDatabases.delete(key);
        await sql.end({ timeout: 5 });
      },
    };
  }

  if (opts.storage === "sqlite") {
    const { createSqliteStores, migrateSqlite, configureSqlite } = await import("@polpo-ai/drizzle");
    const { createRequire } = await import("node:module");
    const Database = createRequire(import.meta.url)("better-sqlite3");
    const client = new Database(join(opts.polpoDir, "state.db"));
    configureSqlite(client);
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const db = drizzle(client);
    if (opts.role !== "runner") {
      const result = migrateSqlite(db);
      if (result.adoptedLegacy) log("SQLite database predates versioned migrations: adopted at the baseline (no data changed).");
    }
    const stores = createSqliteStores(db);
    const key = resolve(opts.polpoDir);
    openDatabases.set(key, stores);
    if (opts.role === "server" && opts.importFiles !== false) {
      const { sqliteSchema } = await import("@polpo-ai/drizzle");
      const { importFileStores } = await import("../stores/import-file-stores.js");
      await importFileStores({ polpoDir: opts.polpoDir, stores, db, schema: sqliteSchema, dialect: "sqlite", log });
    }
    return {
      kind: "sqlite", stores, db,
      close: async () => {
        if (openDatabases.get(key) === stores) openDatabases.delete(key);
        client.close();
      },
    };
  }

  return { kind: "file", close: async () => {} };
}
