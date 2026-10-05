/**
 * Encrypted vault store — AES-256-GCM encrypted credential storage.
 *
 * File-based implementation of VaultStore.
 * Stores agent vault credentials in `.polpo/vault.enc` (per-project).
 * Encryption key sourced from:
 *   1. POLPO_VAULT_KEY env var (hex-encoded 32 bytes) — for CI/Docker
 *   2. ~/.polpo/vault.key file (auto-generated on first use) — for local dev
 *
 * File format: 12-byte IV | 16-byte auth tag | ciphertext
 * Plaintext is JSON: Record<agentName, Record<serviceName, VaultEntry>>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { VaultEntry } from "../core/types.js";
import type { VaultStore } from "../core/vault-store.js";
import { resolveKey, encrypt, decrypt } from "@polpo-ai/vault-crypto";

// ── Constants ──

const VAULT_FILENAME = "vault.enc";

// ── Internal types ──

/** Full vault data structure: agent → service → entry */
type VaultData = Record<string, Record<string, VaultEntry>>;

// ── EncryptedVaultStore ──

export class EncryptedVaultStore implements VaultStore {
  private readonly vaultPath: string;
  private readonly key: Buffer;
  private data: VaultData;

  constructor(polpoDir: string) {
    this.vaultPath = join(polpoDir, VAULT_FILENAME);
    this.key = resolveKey();
    this.data = this.loadFromDisk();
  }

  // ── VaultStore implementation ──

  async get(agent: string, service: string): Promise<VaultEntry | undefined> {
    return this.data[agent]?.[service];
  }

  async getAllForAgent(agent: string): Promise<Record<string, VaultEntry>> {
    // Owner entries (this agent's own), then merge-in entries from OTHER
    // agents whose `allowedAgents` includes this agent. Conflict policy:
    // per-agent wins over shared (already in result before merge).
    const result: Record<string, VaultEntry> = { ...(this.data[agent] ?? {}) };
    for (const [owner, ownerEntries] of Object.entries(this.data)) {
      if (owner === agent) continue;
      for (const [service, entry] of Object.entries(ownerEntries)) {
        if (!entry.allowedAgents || !entry.allowedAgents.includes(agent)) continue;
        if (result[service]) continue; // owned by current agent → wins
        result[service] = entry;
      }
    }
    return result;
  }

  async set(agent: string, service: string, entry: VaultEntry): Promise<void> {
    if (!this.data[agent]) this.data[agent] = {};
    this.data[agent][service] = entry;
    this.persist();
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
    if (!this.data[agent]?.[service]) return false;
    delete this.data[agent][service];
    if (Object.keys(this.data[agent]).length === 0) {
      delete this.data[agent];
    }
    this.persist();
    return true;
  }

  async list(agent: string): Promise<Array<{
    service: string;
    type: VaultEntry["type"];
    label?: string;
    account?: string;
    allowedAgents?: string[];
    sharedFrom?: string;
    readOnly?: boolean;
    keys: string[];
  }>> {
    // Owned entries first (no sharedFrom). Then inherited shared from
    // other agents. Conflict policy: owned wins.
    const out: Array<any> = [];
    const seen = new Set<string>();
    for (const [service, entry] of Object.entries(this.data[agent] ?? {})) {
      out.push({
        service,
        type: entry.type,
        label: entry.label,
        account: entry.account,
        ...(entry.allowedAgents && entry.allowedAgents.length > 0 ? { allowedAgents: entry.allowedAgents } : {}),
        keys: Object.keys(entry.credentials),
      });
      seen.add(service);
    }
    for (const [owner, ownerEntries] of Object.entries(this.data)) {
      if (owner === agent) continue;
      for (const [service, entry] of Object.entries(ownerEntries)) {
        if (!entry.allowedAgents || !entry.allowedAgents.includes(agent)) continue;
        if (seen.has(service)) continue;
        out.push({
          service,
          type: entry.type,
          label: entry.label,
          account: entry.account,
          allowedAgents: entry.allowedAgents,
          sharedFrom: owner,
          readOnly: true,
          keys: Object.keys(entry.credentials),
        });
      }
    }
    return out;
  }

  async hasEntries(agent: string): Promise<boolean> {
    return !!this.data[agent] && Object.keys(this.data[agent]).length > 0;
  }

  async migrateFromConfigs(agents: Array<{ name: string; vault?: Record<string, VaultEntry> }>): Promise<number> {
    let migrated = 0;
    for (const agent of agents) {
      if (!agent.vault) continue;
      for (const [service, entry] of Object.entries(agent.vault)) {
        // Skip if already in encrypted store
        if (this.data[agent.name]?.[service]) continue;
        // Move to encrypted store
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

  async renameAgent(oldName: string, newName: string): Promise<void> {
    let dirty = false;
    if (this.data[oldName]) {
      this.data[newName] = this.data[oldName];
      delete this.data[oldName];
      dirty = true;
    }
    // Cascade: rewrite oldName → newName inside any allowedAgents list of
    // other agents' shared entries.
    for (const [owner, ownerEntries] of Object.entries(this.data)) {
      if (owner === newName) continue;
      for (const entry of Object.values(ownerEntries)) {
        if (!entry.allowedAgents) continue;
        const idx = entry.allowedAgents.indexOf(oldName);
        if (idx < 0) continue;
        entry.allowedAgents = entry.allowedAgents.slice();
        entry.allowedAgents[idx] = newName;
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  async removeAgent(agent: string): Promise<void> {
    let dirty = false;
    if (this.data[agent]) {
      delete this.data[agent];
      dirty = true;
    }
    // Cascade: scrub the deleted agent's name from any allowedAgents list.
    for (const ownerEntries of Object.values(this.data)) {
      for (const entry of Object.values(ownerEntries)) {
        if (!entry.allowedAgents) continue;
        const filtered = entry.allowedAgents.filter(n => n !== agent);
        if (filtered.length === entry.allowedAgents.length) continue;
        entry.allowedAgents = filtered.length > 0 ? filtered : undefined;
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  // ── Internal ──

  private loadFromDisk(): VaultData {
    if (!existsSync(this.vaultPath)) return {};
    try {
      const blob = readFileSync(this.vaultPath);
      const plain = decrypt(blob, this.key);
      return JSON.parse(plain.toString("utf-8")) as VaultData;
    } catch (err) {
      // If decryption fails (wrong key, corrupted), start fresh but warn
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vault] Failed to decrypt ${this.vaultPath}: ${msg}. Starting with empty vault.`);
      return {};
    }
  }

  private persist(): void {
    const json = JSON.stringify(this.data, null, 2);
    const plain = Buffer.from(json, "utf-8");
    const blob = encrypt(plain, this.key);
    // Ensure directory exists
    const dir = this.vaultPath.replace(/[/\\][^/\\]+$/, "");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.vaultPath, blob);
    // Restrictive permissions
    try {
      chmodSync(this.vaultPath, 0o600);
    } catch {
      // chmod may fail on Windows — non-fatal
    }
  }
}
