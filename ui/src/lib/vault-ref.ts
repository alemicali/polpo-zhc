/**
 * Vault references: features that need a key (remote sandboxes, buckets, …) store only where the
 * key is — an agent's vault entry (owner + service) — never the key itself. Credentials live in
 * the agents' vaults (Credentials tab), shared with other agents when needed.
 *
 * Mirrors packages/core/src/vault-ref.ts (CREDENTIAL_NAMES must stay in sync).
 */
import { apiUrl, config } from "@/lib/config";

export interface VaultRef {
  owner: string;
  service: string;
}

/** A vault entry a feature can reference (GET /vault-catalog): names only, never values. */
export interface VaultCatalogEntry {
  owner: string;
  service: string;
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  label?: string;
  keys: string[];
  allowedAgents: string[];
}

/** Common key names, so an entry written by a person or an agent works without renaming keys. */
export const CREDENTIAL_NAMES = {
  apiKey: ["apiKey", "api_key", "key", "token", "apiToken", "secret"],
  apiToken: ["apiToken", "api_token", "token", "apiKey", "api_key", "key"],
  accessKeyId: ["accessKeyId", "access_key_id", "aws_access_key_id", "accessKey", "keyId", "key_id", "username", "user"],
  secretAccessKey: ["secretAccessKey", "secret_access_key", "aws_secret_access_key", "secretKey", "secret", "password", "pass"],
  sessionToken: ["sessionToken", "session_token", "aws_session_token"],
} as const;

export type CredentialName = keyof typeof CREDENTIAL_NAMES;

/** Lower case, no separators ("Access-Key_ID" → "accesskeyid"). */
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when one of the entry's key names is an alias of `name`. */
export function hasCredential(keys: string[], name: CredentialName): boolean {
  const wanted = new Set(CREDENTIAL_NAMES[name].map(norm));
  return keys.some((k) => wanted.has(norm(k)));
}

/** The required credentials the entry has no key for (empty = it fits). */
export function missingCredentials(keys: string[], required: CredentialName[] = []): CredentialName[] {
  return required.filter((name) => !hasCredential(keys, name));
}

export function sameVaultRef(a: VaultRef | null | undefined, b: VaultRef | null | undefined): boolean {
  return !!a && !!b && a.owner === b.owner && a.service === b.service;
}

export function vaultRefKey(ref: VaultRef): string {
  return `${ref.owner}\u0000${ref.service}`;
}

export function describeVaultRef(ref: VaultRef | null | undefined): string {
  return ref ? `${ref.owner} · ${ref.service}` : "not set";
}

/** Where a person adds or shares a credential: the owner agent's Credentials tab. */
export function credentialsTabPath(owner: string): string {
  return `/agents/${encodeURIComponent(owner)}?tab=credentials`;
}

/** Entries grouped by owner, owners sorted, entries by service. */
export function groupCatalog(entries: VaultCatalogEntry[]): Array<{ owner: string; entries: VaultCatalogEntry[] }> {
  const groups = new Map<string, VaultCatalogEntry[]>();
  for (const e of entries) {
    if (e.owner.startsWith("$")) continue;
    const list = groups.get(e.owner) ?? [];
    list.push(e);
    groups.set(e.owner, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, list]) => ({ owner, entries: list.sort((a, b) => a.service.localeCompare(b.service)) }));
}

export async function fetchVaultCatalog(): Promise<VaultCatalogEntry[]> {
  const headers = new Headers();
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/v1/vault-catalog"), { headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `Vault catalog request failed (${response.status})`);
  }
  return (body.data as VaultCatalogEntry[]) ?? [];
}
