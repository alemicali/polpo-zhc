import type { VaultEntry } from "./types.js";

/**
 * Persistent store for encrypted agent vault credentials.
 *
 * Each agent can have multiple service entries (SMTP, OAuth, API keys, etc.).
 * All implementations MUST encrypt credentials at rest.
 *
 * Every backend (file/AES-256-GCM, PostgreSQL/pgcrypto, SQLite) must implement
 * this interface.
 */
export interface VaultStore {
  /** Get a single vault entry for an agent + service. */
  get(agent: string, service: string): Promise<VaultEntry | undefined>;

  /** Get all vault entries for an agent. */
  getAllForAgent(agent: string): Promise<Record<string, VaultEntry>>;

  /** Set (add or update) a vault entry. */
  set(agent: string, service: string, entry: VaultEntry): Promise<void>;

  /**
   * Patch (partially update) a vault entry. Merges credentials with existing ones.
   * If the entry doesn't exist, creates it (requires `type`).
   * Returns the merged credential key list.
   */
  patch(
    agent: string,
    service: string,
    partial: { type?: VaultEntry["type"]; label?: string; credentials?: Record<string, string> },
  ): Promise<string[]>;

  /** Remove a vault entry. Returns true if found. */
  remove(agent: string, service: string): Promise<boolean>;

  /** List all services for an agent (metadata only — values masked). */
  list(agent: string): Promise<Array<{
    service: string;
    type: VaultEntry["type"];
    label?: string;
    keys: string[];
  }>>;

  /** Check if an agent has any vault entries. */
  hasEntries(agent: string): Promise<boolean>;

  /** Rename an agent (updates all entries for old name to new name). */
  renameAgent(oldName: string, newName: string): Promise<void>;

  /** Remove all entries for an agent. */
  removeAgent(agent: string): Promise<void>;

  /**
   * Migrate inline vault credentials from agent configs into the store.
   * Strips credential values from the agent configs (keeps type + label).
   * Returns the number of entries migrated.
   */
  migrateFromConfigs(agents: Array<{ name: string; vault?: Record<string, VaultEntry> }>): Promise<number>;
}
