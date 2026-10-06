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

import { dirname } from "node:path";
import type { TeamStore } from "../core/team-store.js";
import type { AgentStore } from "../core/agent-store.js";
import type { VaultStore } from "../core/vault-store.js";
import type { PlaybookStore } from "../core/playbook-store.js";
import type { SessionStore } from "@polpo-ai/core";
import { loadPolpoConfig } from "../core/config.js";
import { FileTeamStore } from "../stores/file-team-store.js";
import { FileAgentStore } from "../stores/file-agent-store.js";
import { FilePlaybookStore } from "../stores/file-playbook-store.js";
import { FileSessionStore } from "../stores/file-session-store.js";

export interface CliStores {
  teamStore: TeamStore;
  agentStore: AgentStore;
  vaultStore: VaultStore;
  playbookStore: PlaybookStore;
  sessionStore: SessionStore;
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

  if (storage === "postgres" || storage === "sqlite") {
    const { openStorage } = await import("../core/storage.js");
    const opened = await openStorage({ storage, polpoDir, databaseUrl, role: "cli" });
    if (opened.kind !== "file") {
      const stores = opened.stores;
      return {
        teamStore: stores.teamStore,
        agentStore: stores.agentStore,
        vaultStore: stores.vaultStore,
        playbookStore: stores.playbookStore,
        sessionStore: stores.sessionStore,
      };
    }
  }

  // Default: file-based stores
  const cwd = dirname(polpoDir);
  const { EncryptedVaultStore } = await import("../vault/encrypted-store.js");
  return {
    teamStore: new FileTeamStore(polpoDir),
    agentStore: new FileAgentStore(polpoDir),
    vaultStore: new EncryptedVaultStore(polpoDir),
    playbookStore: new FilePlaybookStore(cwd, polpoDir),
    sessionStore: new FileSessionStore(polpoDir),
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
