import { eq, and, like, ne } from "drizzle-orm";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { VaultEntry } from "@polpo-ai/core/types";
import { resolveKey, encryptJson, decryptJson } from "@polpo-ai/vault-crypto";

type AnyTable = any;

/** Robust parser for the `allowed_agents` column. We store a JSON-encoded
 *  string[] but the column is TEXT and old rows may have been written
 *  before this feature existed (null) — be defensive. */
function parseAllowedAgents(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function serializeAllowedAgents(list?: string[]): string | null {
  if (!list || list.length === 0) return null;
  // Stable order so equal sets produce equal storage (helps LIKE matching).
  const unique = Array.from(new Set(list.filter(s => typeof s === "string" && s.length > 0)));
  unique.sort();
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

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
    // UNION two reads:
    //   1) Owner-private + shared entries OWNED by `agent` (the standard
    //      per-agent vault).
    //   2) Shared entries owned by OTHER agents where `allowed_agents`
    //      includes `agent` — LIKE filter narrows the candidate set, then
    //      we parse the JSON column in JS to confirm membership (cheap,
    //      no FTS needed on a vault rarely larger than ~hundreds of rows).
    //
    // Conflict policy: per-agent wins. If an owned entry exists with the
    // same `service` key as a shared one, the owned one shadows it —
    // implemented by inserting owned rows first, then skipping shared
    // duplicates.
    const ownedRows: any[] = await this.db.select().from(this.vault)
      .where(eq(this.vault.agent, agent));
    const sharedCandidateRows: any[] = await this.db.select().from(this.vault)
      .where(and(ne(this.vault.agent, agent), like(this.vault.allowedAgents, `%${agent}%`)));

    const result: Record<string, VaultEntry> = {};
    for (const row of ownedRows) {
      result[row.service] = this.rowToEntry(row);
    }
    for (const row of sharedCandidateRows) {
      const allowed = parseAllowedAgents(row.allowed_agents ?? row.allowedAgents);
      if (!allowed.includes(agent)) continue; // LIKE matched on substring, JSON didn't confirm
      if (result[row.service]) continue;       // owner has its own → wins
      result[row.service] = this.rowToEntry(row);
    }
    return result;
  }

  async set(agent: string, service: string, entry: VaultEntry): Promise<void> {
    const now = new Date().toISOString();
    const encCreds = encryptJson(entry.credentials, this.key);
    const allowedAgentsJson = serializeAllowedAgents(entry.allowedAgents);
    const values = {
      agent,
      service,
      type: entry.type,
      label: entry.label ?? null,
      account: entry.account ?? null,
      allowedAgents: allowedAgentsJson,
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
          account: entry.account ?? null,
          allowedAgents: allowedAgentsJson,
          credentials: encCreds,
          updatedAt: now,
        },
      });
  }

  async patch(
    agent: string,
    service: string,
    partial: { type?: VaultEntry["type"]; label?: string; account?: string; allowedAgents?: string[]; credentials?: Record<string, string> },
  ): Promise<string[]> {
    const existing = await this.get(agent, service);
    if (!existing && !partial.type) {
      throw new Error(`No vault entry "${service}" for agent "${agent}" — type is required to create a new entry.`);
    }
    const merged: VaultEntry = {
      type: partial.type ?? existing?.type ?? "custom",
      ...(partial.label !== undefined ? { label: partial.label } : existing?.label ? { label: existing.label } : {}),
      ...(partial.account !== undefined ? { account: partial.account } : existing?.account ? { account: existing.account } : {}),
      ...(partial.allowedAgents !== undefined ? { allowedAgents: partial.allowedAgents } : existing?.allowedAgents ? { allowedAgents: existing.allowedAgents } : {}),
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
    account?: string;
    allowedAgents?: string[];
    /** Set when the row is inherited via shared. */
    sharedFrom?: string;
    /** True when the row is inherited (sharedFrom set). */
    readOnly?: boolean;
    keys: string[];
  }>> {
    // Same UNION semantics as getAllForAgent — owned entries first, then
    // shared inherited from other agents. Inherited rows carry sharedFrom
    // metadata so the UI can render a "shared from X" badge.
    const ownedRows: any[] = await this.db.select().from(this.vault)
      .where(eq(this.vault.agent, agent));
    const sharedRows: any[] = await this.db.select().from(this.vault)
      .where(and(ne(this.vault.agent, agent), like(this.vault.allowedAgents, `%${agent}%`)));

    const seen = new Set<string>();
    const out: Array<any> = [];
    for (const row of ownedRows) {
      const creds = decryptJson<Record<string, string>>(row.credentials as string, this.key, {});
      const allowed = parseAllowedAgents(row.allowed_agents ?? row.allowedAgents);
      out.push({
        service: row.service,
        type: row.type as VaultEntry["type"],
        label: row.label ?? undefined,
        account: row.account ?? undefined,
        ...(allowed.length > 0 ? { allowedAgents: allowed } : {}),
        keys: Object.keys(creds),
      });
      seen.add(row.service);
    }
    for (const row of sharedRows) {
      const allowed = parseAllowedAgents(row.allowed_agents ?? row.allowedAgents);
      if (!allowed.includes(agent)) continue;
      if (seen.has(row.service)) continue; // owned wins
      const creds = decryptJson<Record<string, string>>(row.credentials as string, this.key, {});
      out.push({
        service: row.service,
        type: row.type as VaultEntry["type"],
        label: row.label ?? undefined,
        account: row.account ?? undefined,
        allowedAgents: allowed,
        sharedFrom: row.agent,
        readOnly: true,
        keys: Object.keys(creds),
      });
    }
    return out;
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
    // Cascade: rewrite oldName → newName in allowed_agents of OTHER agents'
    // entries (shared credentials). LIKE narrows the candidate set; we
    // JSON-parse + re-serialize to preserve order/uniqueness.
    const sharedRows: any[] = await this.db.select().from(this.vault)
      .where(like(this.vault.allowedAgents, `%${oldName}%`));
    for (const row of sharedRows) {
      const allowed = parseAllowedAgents(row.allowed_agents ?? row.allowedAgents);
      const idx = allowed.indexOf(oldName);
      if (idx < 0) continue;
      allowed[idx] = newName;
      const updated = serializeAllowedAgents(allowed);
      await this.db.update(this.vault)
        .set({ allowedAgents: updated, updatedAt: now })
        .where(and(eq(this.vault.agent, row.agent), eq(this.vault.service, row.service)));
    }
  }

  async removeAgent(agent: string): Promise<void> {
    await this.db.delete(this.vault)
      .where(eq(this.vault.agent, agent));
    // Cascade: scrub the deleted agent's name from any other entry's
    // allowed_agents list. If the list ends up empty, store NULL.
    const now = new Date().toISOString();
    const sharedRows: any[] = await this.db.select().from(this.vault)
      .where(like(this.vault.allowedAgents, `%${agent}%`));
    for (const row of sharedRows) {
      const allowed = parseAllowedAgents(row.allowed_agents ?? row.allowedAgents);
      const filtered = allowed.filter(n => n !== agent);
      if (filtered.length === allowed.length) continue;
      const updated = serializeAllowedAgents(filtered);
      await this.db.update(this.vault)
        .set({ allowedAgents: updated, updatedAt: now })
        .where(and(eq(this.vault.agent, row.agent), eq(this.vault.service, row.service)));
    }
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
    const allowed = parseAllowedAgents(row.allowed_agents ?? row.allowedAgents);
    return {
      type: row.type as VaultEntry["type"],
      ...(row.label ? { label: row.label } : {}),
      ...(row.account ? { account: row.account } : {}),
      ...(allowed.length > 0 ? { allowedAgents: allowed } : {}),
      credentials: creds,
    };
  }
}
