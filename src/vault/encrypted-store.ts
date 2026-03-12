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

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { VaultEntry } from "../core/types.js";
import type { VaultStore } from "../core/vault-store.js";

// ── Constants ──

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const VAULT_FILENAME = "vault.enc";
const GLOBAL_KEY_DIR = join(homedir(), ".polpo");
const GLOBAL_KEY_FILE = join(GLOBAL_KEY_DIR, "vault.key");

// ── Internal types ──

/** Full vault data structure: agent → service → entry */
type VaultData = Record<string, Record<string, VaultEntry>>;

// ── Key Management ──

/**
 * Resolve the encryption key from env var or key file.
 * Auto-generates key file on first use.
 */
function resolveKey(): Buffer {
  // 1. Check env var first (CI/Docker override)
  const envKey = process.env.POLPO_VAULT_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "hex");
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `POLPO_VAULT_KEY must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes). Got ${envKey.length} characters.`,
      );
    }
    return buf;
  }

  // 2. Read or generate key file
  if (existsSync(GLOBAL_KEY_FILE)) {
    const raw = readFileSync(GLOBAL_KEY_FILE);
    // Key file can be raw bytes or hex-encoded
    if (raw.length === KEY_LENGTH) return raw;
    const hex = raw.toString("utf-8").trim();
    const buf = Buffer.from(hex, "hex");
    if (buf.length === KEY_LENGTH) return buf;
    throw new Error(`Invalid vault key file: ${GLOBAL_KEY_FILE}. Expected ${KEY_LENGTH} bytes.`);
  }

  // Auto-generate
  if (!existsSync(GLOBAL_KEY_DIR)) {
    mkdirSync(GLOBAL_KEY_DIR, { recursive: true });
  }
  const key = randomBytes(KEY_LENGTH);
  writeFileSync(GLOBAL_KEY_FILE, key);
  // Set restrictive permissions (owner-only)
  try {
    chmodSync(GLOBAL_KEY_FILE, 0o600);
  } catch {
    // chmod may fail on Windows — non-fatal
  }
  return key;
}

// ── Encryption / Decryption ──

function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: IV | auth tag | ciphertext
  return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Vault file is corrupted (too short).");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

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
    return this.data[agent] ?? {};
  }

  async set(agent: string, service: string, entry: VaultEntry): Promise<void> {
    if (!this.data[agent]) this.data[agent] = {};
    this.data[agent][service] = entry;
    this.persist();
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
    if (!this.data[agent]?.[service]) return false;
    delete this.data[agent][service];
    if (Object.keys(this.data[agent]).length === 0) {
      delete this.data[agent];
    }
    this.persist();
    return true;
  }

  async list(agent: string): Promise<Array<{ service: string; type: VaultEntry["type"]; label?: string; keys: string[] }>> {
    const entries = this.data[agent];
    if (!entries) return [];
    return Object.entries(entries).map(([service, entry]) => ({
      service,
      type: entry.type,
      label: entry.label,
      keys: Object.keys(entry.credentials),
    }));
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
    if (!this.data[oldName]) return;
    this.data[newName] = this.data[oldName];
    delete this.data[oldName];
    this.persist();
  }

  async removeAgent(agent: string): Promise<void> {
    if (!this.data[agent]) return;
    delete this.data[agent];
    this.persist();
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
