/**
 * @polpo-ai/vault-crypto — AES-256-GCM encryption helpers for Polpo vault stores.
 *
 * Shared by EncryptedVaultStore (file-based) and DrizzleVaultStore (database-backed).
 * Single source of truth for vault encryption logic.
 *
 * Key resolution:
 *   1. POLPO_VAULT_KEY env var (hex-encoded 32 bytes) — for CI/Docker
 *   2. ~/.polpo/vault.key file (auto-generated on first use) — for local dev
 *
 * Wire format: 12-byte IV | 16-byte auth tag | ciphertext (all as a single Buffer).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Constants ──

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const GLOBAL_KEY_DIR = join(homedir(), ".polpo");
const GLOBAL_KEY_FILE = join(GLOBAL_KEY_DIR, "vault.key");

// ── Key Management ──

/**
 * Resolve the encryption key from env var or key file.
 * Auto-generates key file on first use.
 */
export function resolveKey(): Buffer {
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

// ── Low-level encrypt / decrypt ──

/**
 * Encrypt a buffer with AES-256-GCM.
 * Returns: IV (12 bytes) | auth tag (16 bytes) | ciphertext.
 */
export function encrypt(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer previously encrypted with `encrypt()`.
 * Expects the same wire format: IV | auth tag | ciphertext.
 */
export function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Vault data is corrupted (too short).");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── JSON convenience helpers ──

/**
 * Encrypt a JSON-serializable value. Returns a base64-encoded string
 * suitable for storage in a TEXT/VARCHAR column.
 */
export function encryptJson(value: unknown, key: Buffer): string {
  const json = JSON.stringify(value);
  const plain = Buffer.from(json, "utf-8");
  const blob = encrypt(plain, key);
  return blob.toString("base64");
}

/**
 * Decrypt a base64-encoded string back to a parsed JSON value.
 * Returns the fallback if decryption or parsing fails.
 */
export function decryptJson<T>(encoded: string, key: Buffer, fallback: T): T {
  try {
    const blob = Buffer.from(encoded, "base64");
    const plain = decrypt(blob, key);
    return JSON.parse(plain.toString("utf-8")) as T;
  } catch {
    return fallback;
  }
}
