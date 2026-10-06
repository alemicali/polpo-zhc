/**
 * Instance-wide secrets for custom providers, stored encrypted in the vault under the
 * reserved owner "$providers" (service = provider id).
 *
 * Credential layout of the vault entry:
 *   apiKey            → provider API key
 *   header:<Name>     → secret header value (e.g. "header:OpenAI-Organization")
 *
 * "$providers" is a reserved system owner (`isReservedVaultOwner`): the public /vault routes,
 * agent vault tools and onboarding refuse it, so it is written only from this module.
 */

import { isReservedVaultOwner, type VaultStore } from "@polpo-ai/core/vault-store";
import { PROVIDER_VAULT_HEADER_PREFIX, PROVIDER_VAULT_KEY, PROVIDER_VAULT_OWNER } from "@polpo-ai/core/provider-config";

// Provider secrets must live in a reserved namespace — never in an agent-addressable owner.
if (!isReservedVaultOwner(PROVIDER_VAULT_OWNER)) {
  throw new Error(`Provider vault owner "${PROVIDER_VAULT_OWNER}" must be a reserved vault owner`);
}

export interface ProviderSecrets {
  apiKey?: string;
  /** Secret headers (name → value). */
  headers: Record<string, string>;
}

export interface ProviderSecretStatus {
  hasKey: boolean;
  /** Last 4 characters of the stored key (only for keys >= 16 chars). */
  keyHint?: string;
  secretHeaderNames: string[];
}

export async function readProviderSecrets(vault: VaultStore | undefined, id: string): Promise<ProviderSecrets | undefined> {
  if (!vault) return undefined;
  const entry = await vault.get(PROVIDER_VAULT_OWNER, id);
  if (!entry) return undefined;
  const headers: Record<string, string> = {};
  let apiKey: string | undefined;
  for (const [k, v] of Object.entries(entry.credentials ?? {})) {
    if (typeof v !== "string" || v === "") continue;
    if (k === PROVIDER_VAULT_KEY) apiKey = v;
    else if (k.startsWith(PROVIDER_VAULT_HEADER_PREFIX)) headers[k.slice(PROVIDER_VAULT_HEADER_PREFIX.length)] = v;
  }
  return { apiKey, headers };
}

export function secretStatusOf(secrets: ProviderSecrets | undefined): ProviderSecretStatus {
  const key = secrets?.apiKey;
  return {
    hasKey: !!key,
    keyHint: key && key.length >= 16 ? key.slice(-4) : undefined,
    secretHeaderNames: Object.keys(secrets?.headers ?? {}).sort(),
  };
}

/**
 * Apply a write-only secrets patch.
 * - apiKey: undefined keeps, "" removes, otherwise replaces
 * - secretHeaders: value null/"" removes that header, otherwise sets it
 */
export async function writeProviderSecrets(
  vault: VaultStore | undefined,
  id: string,
  patch: { apiKey?: string; secretHeaders?: Record<string, string | null> },
): Promise<ProviderSecretStatus> {
  const touchesSecrets = patch.apiKey !== undefined || (patch.secretHeaders && Object.keys(patch.secretHeaders).length > 0);
  if (!vault) {
    if (touchesSecrets) throw new Error("Vault is unavailable; provider secrets cannot be stored securely");
    return secretStatusOf(undefined);
  }
  const current = await vault.get(PROVIDER_VAULT_OWNER, id);
  const credentials: Record<string, string> = { ...(current?.credentials ?? {}) };
  if (patch.apiKey !== undefined) {
    const key = patch.apiKey.trim();
    if (key) credentials[PROVIDER_VAULT_KEY] = key;
    else delete credentials[PROVIDER_VAULT_KEY];
  }
  for (const [name, value] of Object.entries(patch.secretHeaders ?? {})) {
    // Header names are case-insensitive: drop any existing spelling first.
    for (const existing of Object.keys(credentials)) {
      if (existing.toLowerCase() === `${PROVIDER_VAULT_HEADER_PREFIX}${name}`.toLowerCase()) delete credentials[existing];
    }
    if (value) credentials[`${PROVIDER_VAULT_HEADER_PREFIX}${name}`] = value;
  }
  if (Object.keys(credentials).length === 0) {
    if (current) await vault.remove(PROVIDER_VAULT_OWNER, id);
    return secretStatusOf(undefined);
  }
  if (touchesSecrets || !current) {
    await vault.set(PROVIDER_VAULT_OWNER, id, { type: "api_key", label: `LLM provider ${id}`, credentials });
  }
  return secretStatusOf(await readProviderSecrets(vault, id));
}

export async function removeProviderSecrets(vault: VaultStore | undefined, id: string): Promise<void> {
  await vault?.remove(PROVIDER_VAULT_OWNER, id).catch(() => false);
}

/** Copy secrets when a provider is renamed. */
export async function moveProviderSecrets(vault: VaultStore | undefined, fromId: string, toId: string): Promise<void> {
  if (!vault || fromId === toId) return;
  const entry = await vault.get(PROVIDER_VAULT_OWNER, fromId);
  if (!entry) return;
  await vault.set(PROVIDER_VAULT_OWNER, toId, { ...entry, label: `LLM provider ${toId}` });
  await vault.remove(PROVIDER_VAULT_OWNER, fromId);
}
