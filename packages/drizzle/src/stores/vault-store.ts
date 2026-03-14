import { eq, and } from "drizzle-orm";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { VaultEntry } from "@polpo-ai/core/types";
import { resolveKey, encryptJson, decryptJson } from "@polpo-ai/vault-crypto";

type AnyTable = any;

/**
 * Drizzle ORM implementation of VaultStore with AES-256-GCM encryption at rest.
 *
 * Stores vault entries in a `vault` table with composite PK (agent, service).
 * Credentials are encrypted before writing and decrypted on read using the
 * same key material as EncryptedVaultStore (POLPO_VAULT_KEY env or ~/.polpo/vault.key).
 *
 * The `credentials` column stores a base64-encoded encrypted blob (always TEXT,
 * regardless of dialect). Type and label are stored in cleartext for querying.
 */
export class DrizzleVaultStore implements VaultStore {
  private readonly key: Buffer;

  constructor(
    private db: any,
    private vault: AnyTable,
  ) {
    this.key = resolveKey();
  }

  async get(agent: string, service: string): Promise<VaultEntry | undefined> {
    const rows: any[] = await this.db.select().from(this.vault)
      .where(and(eq(this.vault.agent, agent), eq(this.vault.service, service)));
    if (rows.length === 0) return undefined;
    return this.rowToEntry(rows[0]);
  }

  async getAllForAgent(agent: string): Promise<Record<string, VaultEntry>> {
    const rows: any[] = await this.db.select().from(this.vault)
      .where(eq(this.vault.agent, agent));
    const result: Record<string, VaultEntry> = {};
    for (const row of rows) {
      result[row.service] = this.rowToEntry(row);
    }
    return result;
  }

  async set(agent: string, service: string, entry: VaultEntry): Promise<void> {
    const now = new Date().toISOString();
    const encCreds = encryptJson(entry.credentials, this.key);
    const values = {
      agent,
      service,
      type: entry.type,
      label: entry.label ?? null,
      credentials: encCreds,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(this.vault).values(values)
      .onConflictDoUpdate({
        target: [this.vault.agent, this.vault.service],
        set: {
          type: entry.type,
          label: entry.label ?? null,
          credentials: encCreds,
          updatedAt: now,
        },
      });
  }

  async patch(
    agent: string,
    service: string,
    partial: { type?: VaultEntry["type"]; label?: string; credentials?: Record<string, string> },
  ): Promise<string[]> {
    const existing = await this.get(agent, service);
    if (!existing && !partial.type) {
      throw new Error(`No vault entry "${service}" for agent "${agent}" — type is required to create a new entry.`);
    }
    const merged: VaultEntry = {
      type: partial.type ?? existing?.type ?? "custom",
      ...(partial.label !== undefined ? { label: partial.label } : existing?.label ? { label: existing.label } : {}),
      credentials: { ...(existing?.credentials ?? {}), ...(partial.credentials ?? {}) },
    };
    await this.set(agent, service, merged);
    return Object.keys(merged.credentials);
  }

  async remove(agent: string, service: string): Promise<boolean> {
    const result = await this.db.delete(this.vault)
      .where(and(eq(this.vault.agent, agent), eq(this.vault.service, service)));
    // Drizzle returns { rowsAffected } for SQLite, { rowCount } for PG
    const affected = result?.rowsAffected ?? result?.rowCount ?? result?.changes ?? 0;
    return affected > 0;
  }

  async list(agent: string): Promise<Array<{
    service: string;
    type: VaultEntry["type"];
    label?: string;
    keys: string[];
  }>> {
    const rows: any[] = await this.db.select().from(this.vault)
      .where(eq(this.vault.agent, agent));
    return rows.map((row: any) => {
      const creds = decryptJson<Record<string, string>>(row.credentials as string, this.key, {});
      return {
        service: row.service,
        type: row.type as VaultEntry["type"],
        label: row.label ?? undefined,
        keys: Object.keys(creds),
      };
    });
  }

  async hasEntries(agent: string): Promise<boolean> {
    const rows: any[] = await this.db.select({ service: this.vault.service }).from(this.vault)
      .where(eq(this.vault.agent, agent))
      .limit(1);
    return rows.length > 0;
  }

  async renameAgent(oldName: string, newName: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(this.vault)
      .set({ agent: newName, updatedAt: now })
      .where(eq(this.vault.agent, oldName));
  }

  async removeAgent(agent: string): Promise<void> {
    await this.db.delete(this.vault)
      .where(eq(this.vault.agent, agent));
  }

  async migrateFromConfigs(agents: Array<{ name: string; vault?: Record<string, VaultEntry> }>): Promise<number> {
    let migrated = 0;
    for (const agent of agents) {
      if (!agent.vault) continue;
      for (const [service, entry] of Object.entries(agent.vault)) {
        // Skip if already in store
        const existing = await this.get(agent.name, service);
        if (existing) continue;
        await this.set(agent.name, service, entry);
        migrated++;
      }
      // Strip credential VALUES from the config (keep metadata)
      for (const [service, entry] of Object.entries(agent.vault)) {
        const stripped: Record<string, string> = {};
        for (const key of Object.keys(entry.credentials)) {
          stripped[key] = ""; // Empty string signals "stored in vault"
        }
        agent.vault[service] = { ...entry, credentials: stripped };
      }
    }
    return migrated;
  }

  // ── Internal ──

  private rowToEntry(row: any): VaultEntry {
    const creds = decryptJson<Record<string, string>>(row.credentials as string, this.key, {});
    return {
      type: row.type as VaultEntry["type"],
      ...(row.label ? { label: row.label } : {}),
      credentials: creds,
    };
  }
}
