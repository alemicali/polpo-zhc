/**
 * Connector secrets in the vault, under the reserved owner `$connectors` (never exposed to agents,
 * never returned by the API):
 *
 *   service <connector id>        bearer_token, header:<Name>, secret:<KEY> (for ${vault:KEY} in stdio env / headers),
 *                                 oauth_client_secret (pre-registered client), oauth_client_info (DCR, JSON),
 *                                 oauth_tokens (JSON), oauth_code_verifier, oauth_state, oauth_state_expires,
 *                                 oauth_discovery (JSON), oauth_redirect_uri
 *   service oauth-app:<app id>    client_secret (a shared OAuth app, e.g. Google)
 */
import type { VaultStore } from "@polpo-ai/core";
import { CONNECTORS_VAULT_OWNER } from "@polpo-ai/core";

export const SECRET_KEYS = {
  bearer: "bearer_token",
  header: (name: string) => `header:${name}`,
  secret: (key: string) => `secret:${key}`,
  clientSecret: "oauth_client_secret",
  clientInfo: "oauth_client_info",
  tokens: "oauth_tokens",
  verifier: "oauth_code_verifier",
  state: "oauth_state",
  stateExpires: "oauth_state_expires",
  discovery: "oauth_discovery",
  redirectUri: "oauth_redirect_uri",
} as const;

export const OAUTH_KEYS = [
  SECRET_KEYS.clientInfo, SECRET_KEYS.tokens, SECRET_KEYS.verifier, SECRET_KEYS.state, SECRET_KEYS.stateExpires,
  SECRET_KEYS.discovery, SECRET_KEYS.redirectUri,
];

const appService = (appId: string) => `oauth-app:${appId}`;

export class ConnectorSecrets {
  constructor(private readonly vault: VaultStore | undefined) {}

  get available(): boolean {
    return !!this.vault;
  }

  private store(): VaultStore {
    if (!this.vault) throw new Error("The vault is not available: connector secrets cannot be stored");
    return this.vault;
  }

  async get(id: string): Promise<Record<string, string>> {
    const entry = await this.vault?.get(CONNECTORS_VAULT_OWNER, id).catch(() => undefined);
    return { ...(entry?.credentials ?? {}) };
  }

  /** Merge keys in (empty string values remove the key). */
  async patch(id: string, values: Record<string, string | undefined>): Promise<void> {
    const store = this.store();
    const current = await this.get(id);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === "") delete current[key];
      else current[key] = value;
    }
    if (Object.keys(current).length === 0) {
      await store.remove(CONNECTORS_VAULT_OWNER, id).catch(() => false);
      return;
    }
    await store.set(CONNECTORS_VAULT_OWNER, id, { type: "custom", label: `Connector ${id}`, credentials: current });
  }

  async unset(id: string, keys: string[]): Promise<void> {
    if (!this.vault) return;
    await this.patch(id, Object.fromEntries(keys.map((k) => [k, undefined])));
  }

  async remove(id: string): Promise<void> {
    await this.vault?.remove(CONNECTORS_VAULT_OWNER, id).catch(() => false);
  }

  /** Which secret keys are set (names only, for status displays). */
  async keys(id: string): Promise<string[]> {
    return Object.keys(await this.get(id));
  }

  async appSecret(appId: string): Promise<string | undefined> {
    const entry = await this.vault?.get(CONNECTORS_VAULT_OWNER, appService(appId)).catch(() => undefined);
    return entry?.credentials?.client_secret || undefined;
  }

  async setAppSecret(appId: string, secret: string | undefined): Promise<void> {
    if (!secret) {
      await this.vault?.remove(CONNECTORS_VAULT_OWNER, appService(appId)).catch(() => false);
      return;
    }
    await this.store().set(CONNECTORS_VAULT_OWNER, appService(appId), { type: "oauth", label: `OAuth app ${appId}`, credentials: { client_secret: secret } });
  }
}

/** Replace `${vault:KEY}` references with the connector's `secret:KEY` values (missing → empty). */
export function resolveSecretRefs(value: string, secrets: Record<string, string>): string {
  return value.replace(/\$\{vault:([A-Za-z0-9_.-]+)\}/g, (_m, key: string) => secrets[SECRET_KEYS.secret(key)] ?? "");
}
