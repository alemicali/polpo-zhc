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

import { join } from "node:path";
import type { DrizzleStores } from "@polpo-ai/drizzle";

export type StorageKind = "file" | "sqlite" | "postgres";

/** Who is opening the database: decides pool size and whether to migrate. */
export type StorageRole = "server" | "cli" | "runner";

export interface OpenStorageOptions {
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
    return { kind: "postgres", stores: createPgStores(db), db, close: () => sql.end({ timeout: 5 }) };
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
    return { kind: "sqlite", stores: createSqliteStores(db), db, close: async () => { client.close(); } };
  }

  return { kind: "file", close: async () => {} };
}
