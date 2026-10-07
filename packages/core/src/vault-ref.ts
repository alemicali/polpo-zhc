/**
 * Vault references: features that need a key (remote sandboxes, buckets, …) do not keep keys of
 * their own. A person picks an existing vault entry — an agent's, possibly shared with others —
 * and the feature stores only where it is: owner + service. The secret stays in the vault.
 *
 * Polpo resolves a reference as the system (the person chose it in the settings); agents keep
 * seeing only their own entries and the ones shared with them, as before.
 */
import type { VaultStore } from "./vault-store.js";

export interface VaultRef {
  /** The agent that owns the entry. */
  owner: string;
  /** The entry's service name in that agent's vault. */
  service: string;
}

export function isVaultRef(value: unknown): value is VaultRef {
  return !!value && typeof value === "object"
    && typeof (value as VaultRef).owner === "string" && !!(value as VaultRef).owner.trim()
    && typeof (value as VaultRef).service === "string" && !!(value as VaultRef).service.trim()
    && !(value as VaultRef).owner.trim().startsWith("$");
}

/** Keep only a well-formed reference (system "$" owners are never referenceable). */
export function normalizeVaultRef(value: unknown): VaultRef | undefined {
  return isVaultRef(value) ? { owner: value.owner.trim(), service: value.service.trim() } : undefined;
}

export function describeVaultRef(ref: VaultRef | undefined): string {
  return ref ? `${ref.owner} / ${ref.service}` : "not set";
}

/** The referenced entry's credentials, or undefined when missing. */
export async function resolveVaultRef(store: VaultStore | undefined | null, ref: VaultRef | undefined): Promise<Record<string, string> | undefined> {
  if (!store || !isVaultRef(ref)) return undefined;
  const entry = await store.get(ref.owner, ref.service).catch(() => undefined);
  return entry?.credentials;
}

/** Normalized name: lower case, no separators ("Access-Key_ID" → "accesskeyid"). */
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** First credential whose key matches one of the names (any casing or separators). */
export function pickCredential(credentials: Record<string, string> | undefined, names: string[]): string | undefined {
  if (!credentials) return undefined;
  const wanted = names.map(norm);
  for (const name of wanted) {
    for (const [key, value] of Object.entries(credentials)) {
      if (norm(key) === name && typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/** Common names, so an entry written by a person or an agent works without renaming keys. */
export const CREDENTIAL_NAMES = {
  apiKey: ["apiKey", "api_key", "key", "token", "apiToken", "secret"],
  apiToken: ["apiToken", "api_token", "token", "apiKey", "api_key", "key"],
  accessKeyId: ["accessKeyId", "access_key_id", "aws_access_key_id", "accessKey", "keyId", "key_id", "username", "user"],
  secretAccessKey: ["secretAccessKey", "secret_access_key", "aws_secret_access_key", "secretKey", "secret", "password", "pass"],
  sessionToken: ["sessionToken", "session_token", "aws_session_token"],
} as const;
