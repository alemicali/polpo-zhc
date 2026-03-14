/**
 * Shared CLI store factory.
 *
 * Reads the `storage` setting from `.polpo/polpo.json` and returns the correct
 * TeamStore / AgentStore / VaultStore based on the configured backend
 * (file, sqlite, postgres).
 *
 * This ensures CLI commands respect the storage backend, instead of always
 * falling back to file-based stores.
 */

import { join, dirname } from "node:path";
import type { TeamStore } from "../core/team-store.js";
import type { AgentStore } from "../core/agent-store.js";
import type { VaultStore } from "../core/vault-store.js";
import type { PlaybookStore } from "../core/playbook-store.js";
import { loadPolpoConfig } from "../core/config.js";
import { FileTeamStore } from "../stores/file-team-store.js";
import { FileAgentStore } from "../stores/file-agent-store.js";
import { FilePlaybookStore } from "../stores/file-playbook-store.js";

export interface CliStores {
  teamStore: TeamStore;
  agentStore: AgentStore;
  vaultStore: VaultStore;
  playbookStore: PlaybookStore;
}

/**
 * Resolve the storage backend from polpo.json settings and create the
 * appropriate stores. Falls back to file-based stores when the config
 * doesn't specify a storage backend or when config is missing.
 */
export async function createCliStores(polpoDir: string): Promise<CliStores> {
  const config = loadPolpoConfig(polpoDir);
  const storage = (config?.settings as Record<string, unknown> | undefined)?.storage as string | undefined;
  const databaseUrl = (config?.settings as Record<string, unknown> | undefined)?.databaseUrl as string | undefined
    ?? process.env.DATABASE_URL;

  if (storage === "postgres" && databaseUrl) {
    const { createPgStores, ensurePgSchema } = await import("@polpo-ai/drizzle");
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const sql = postgres(databaseUrl);
    const db = drizzle(sql);
    await ensurePgSchema(db);
    const stores = createPgStores(db);
    return {
      teamStore: stores.teamStore,
      agentStore: stores.agentStore,
      vaultStore: stores.vaultStore,
      playbookStore: stores.playbookStore,
    };
  }

  if (storage === "sqlite") {
    const { createSqliteStores } = await import("@polpo-ai/drizzle");
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const Database = req("better-sqlite3");
    const dbPath = join(polpoDir, "state.db");
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const { ensureSqliteSchema } = await import("../core/drizzle-sqlite-schema.js");
    ensureSqliteSchema(sqlite);
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const db = drizzle(sqlite);
    const stores = createSqliteStores(db);
    return {
      teamStore: stores.teamStore,
      agentStore: stores.agentStore,
      vaultStore: stores.vaultStore,
      playbookStore: stores.playbookStore,
    };
  }

  // Default: file-based stores
  const cwd = dirname(polpoDir);
  const { EncryptedVaultStore } = await import("../vault/encrypted-store.js");
  return {
    teamStore: new FileTeamStore(polpoDir),
    agentStore: new FileAgentStore(polpoDir),
    vaultStore: new EncryptedVaultStore(polpoDir),
    playbookStore: new FilePlaybookStore(cwd, polpoDir),
  };
}

/**
 * Convenience: create only the agent store (most common CLI need).
 * Respects the configured storage backend.
 */
export async function createCliAgentStore(polpoDir: string): Promise<AgentStore> {
  const stores = await createCliStores(polpoDir);
  return stores.agentStore;
}

/**
 * Convenience: create team + agent stores.
 */
export async function createCliTeamAndAgentStores(polpoDir: string): Promise<{ teamStore: TeamStore; agentStore: AgentStore }> {
  const stores = await createCliStores(polpoDir);
  return { teamStore: stores.teamStore, agentStore: stores.agentStore };
}
