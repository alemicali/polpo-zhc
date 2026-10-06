/**
 * Credentials of the remote sandbox providers (Daytona, E2B).
 *
 * Kept in the vault under the reserved owner "$sandbox" (agents can't resolve "$" owners), and
 * cached in memory after load so choosing a provider stays synchronous. APIs only ever say
 * whether a key is set; non-secret fields (API URL, region, template) are returned as is.
 */
import type { VaultStore } from "@polpo-ai/core";

export type RemoteProviderId = "daytona" | "e2b";
export const REMOTE_PROVIDERS: RemoteProviderId[] = ["daytona", "e2b"];
export const SANDBOX_VAULT_OWNER = "$sandbox";

export interface RemoteProviderCredentials {
  apiKey: string;
  /** Daytona: API URL (default https://app.daytona.io/api). */
  apiUrl?: string;
  /** Daytona: region/target (e.g. "eu", "us"). */
  target?: string;
  /** E2B: custom domain (self-hosted). */
  domain?: string;
  /** E2B: default template. */
  template?: string;
}

export interface RemoteProviderStatus {
  id: RemoteProviderId;
  configured: boolean;
  apiKey: "set" | "not set";
  apiUrl?: string;
  target?: string;
  domain?: string;
  template?: string;
  lastTest?: { ok: boolean; at: string; durationMs?: number; error?: string };
}

const PUBLIC_FIELDS = ["apiUrl", "target", "domain", "template"] as const;
const cache = new Map<RemoteProviderId, RemoteProviderCredentials>();
const lastTests = new Map<RemoteProviderId, RemoteProviderStatus["lastTest"]>();
let store: VaultStore | undefined;

const service = (id: RemoteProviderId) => `sandbox-provider:${id}`;

export function isRemoteProvider(id: string): id is RemoteProviderId {
  return (REMOTE_PROVIDERS as string[]).includes(id);
}

/** Load all provider credentials from the vault (server start). */
export async function loadRemoteProviders(vaultStore: VaultStore | undefined): Promise<void> {
  store = vaultStore;
  cache.clear();
  if (!vaultStore) return;
  for (const id of REMOTE_PROVIDERS) {
    const entry = await vaultStore.get(SANDBOX_VAULT_OWNER, service(id)).catch(() => undefined);
    const c = entry?.credentials as Record<string, string> | undefined;
    if (c?.apiKey) cache.set(id, { apiKey: c.apiKey, ...Object.fromEntries(PUBLIC_FIELDS.filter((f) => c[f]).map((f) => [f, c[f]])) });
  }
}

export function remoteProviderCredentials(id: RemoteProviderId): RemoteProviderCredentials | undefined {
  return cache.get(id);
}

export function configuredRemoteProviders(): RemoteProviderId[] {
  return REMOTE_PROVIDERS.filter((id) => !!cache.get(id)?.apiKey);
}

export function remoteProviderStatus(): RemoteProviderStatus[] {
  return REMOTE_PROVIDERS.map((id) => {
    const c = cache.get(id);
    return {
      id,
      configured: !!c?.apiKey,
      apiKey: c?.apiKey ? "set" : "not set",
      ...Object.fromEntries(PUBLIC_FIELDS.filter((f) => c?.[f]).map((f) => [f, c![f]])),
      ...(lastTests.get(id) ? { lastTest: lastTests.get(id) } : {}),
    } as RemoteProviderStatus;
  });
}

/** Save credentials. An empty apiKey keeps the stored one (the UI never sees it). */
export async function saveRemoteProvider(id: RemoteProviderId, input: Partial<RemoteProviderCredentials>): Promise<void> {
  if (!store) throw new Error("The vault is not available");
  const current = cache.get(id);
  const apiKey = input.apiKey?.trim() || current?.apiKey;
  if (!apiKey) throw new Error("The API key is required");
  const next: RemoteProviderCredentials = { apiKey };
  for (const f of PUBLIC_FIELDS) {
    const v = input[f] !== undefined ? input[f]?.trim() : current?.[f];
    if (v) next[f] = v;
  }
  await store.set(SANDBOX_VAULT_OWNER, service(id), {
    type: "api_key",
    label: id === "daytona" ? "Daytona sandboxes" : "E2B sandboxes",
    credentials: next as unknown as Record<string, string>,
  });
  cache.set(id, next);
  lastTests.delete(id);
}

export async function removeRemoteProvider(id: RemoteProviderId): Promise<void> {
  if (store) await store.remove(SANDBOX_VAULT_OWNER, service(id)).catch(() => undefined);
  cache.delete(id);
  lastTests.delete(id);
}

/** Create a throwaway sandbox, run a command, delete it. */
export async function testRemoteProvider(id: RemoteProviderId): Promise<NonNullable<RemoteProviderStatus["lastTest"]>> {
  const { createRemoteWorkspace } = await import("./remote.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "polpo-remote-test-"));
  const t0 = Date.now();
  const ws = createRemoteWorkspace(id, {
    root,
    sandbox: { provider: id, network: { mode: "open" }, resources: { timeoutMin: 5 }, providerOptions: {}, denied: [] },
  });
  let result: NonNullable<RemoteProviderStatus["lastTest"]>;
  try {
    const r = await ws.exec("echo polpo-ok && uname -sm");
    result = r.exitCode === 0 && r.stdout.includes("polpo-ok")
      ? { ok: true, at: new Date().toISOString(), durationMs: Date.now() - t0 }
      : { ok: false, at: new Date().toISOString(), error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit code ${r.exitCode}` };
  } catch (err) {
    result = { ok: false, at: new Date().toISOString(), error: (err as Error).message.slice(0, 300) };
  } finally {
    await ws.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
  lastTests.set(id, result);
  return result;
}
