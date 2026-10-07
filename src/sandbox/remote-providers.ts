/**
 * Remote sandbox providers (Daytona, E2B).
 *
 * Settings live with the other sandbox settings (settings.sandbox.providers.<id>): the vault entry
 * holding the API key (a reference: owner + service), plus non-secret options (API URL, region,
 * template). The key itself stays in that vault entry and is read when a VM is created.
 */
import type { VaultStore } from "@polpo-ai/core";
import { CREDENTIAL_NAMES, normalizeVaultRef, pickCredential, resolveVaultRef, type VaultRef } from "@polpo-ai/core/vault-ref";

export type RemoteProviderId = "daytona" | "e2b";
export const REMOTE_PROVIDERS: RemoteProviderId[] = ["daytona", "e2b"];

/** settings.sandbox.providers.<id> for a remote provider (no secrets). */
export interface RemoteProviderSettings {
  credential?: VaultRef;
  /** Daytona: API URL (default https://app.daytona.io/api). */
  apiUrl?: string;
  /** Daytona: region/target (e.g. "eu", "us"). */
  target?: string;
  /** E2B: custom domain (self-hosted). */
  domain?: string;
  /** E2B: default template. */
  template?: string;
}

export interface RemoteProviderCredentials extends Omit<RemoteProviderSettings, "credential"> {
  apiKey: string;
}

export interface RemoteProviderStatus extends RemoteProviderSettings {
  id: RemoteProviderId;
  /** A vault entry is chosen. */
  configured: boolean;
  /** The chosen entry exists and holds a key. */
  keyFound: boolean;
  lastTest?: { ok: boolean; at: string; durationMs?: number; error?: string };
}

let store: VaultStore | undefined;
let readSettings: () => Record<string, unknown> | undefined = () => undefined;
const lastTests = new Map<RemoteProviderId, RemoteProviderStatus["lastTest"]>();

export function isRemoteProvider(id: string): id is RemoteProviderId {
  return (REMOTE_PROVIDERS as string[]).includes(id);
}

/** Where to read the provider settings (the instance's settings.sandbox.providers) and keys. */
export function configureRemoteProviders(vaultStore: VaultStore | undefined, providersSettings: () => Record<string, unknown> | undefined): void {
  store = vaultStore;
  readSettings = providersSettings;
}

export function remoteProviderSettings(id: RemoteProviderId): RemoteProviderSettings {
  const raw = (readSettings()?.[id] ?? {}) as Record<string, unknown>;
  const out: RemoteProviderSettings = {};
  const credential = normalizeVaultRef(raw.credential);
  if (credential) out.credential = credential;
  for (const f of ["apiUrl", "target", "domain", "template"] as const) {
    if (typeof raw[f] === "string" && (raw[f] as string).trim()) out[f] = (raw[f] as string).trim();
  }
  return out;
}

/** Providers with a key chosen (synchronous: used when picking where a task runs). */
export function configuredRemoteProviders(): RemoteProviderId[] {
  return REMOTE_PROVIDERS.filter((id) => !!remoteProviderSettings(id).credential);
}

/** The key (from the referenced vault entry) and the options, when a VM is about to be created. */
export async function remoteProviderCredentials(id: RemoteProviderId): Promise<RemoteProviderCredentials | undefined> {
  const { credential, ...options } = remoteProviderSettings(id);
  const apiKey = pickCredential(await resolveVaultRef(store, credential), [...CREDENTIAL_NAMES.apiKey]);
  return apiKey ? { apiKey, ...options } : undefined;
}

export async function remoteProviderStatus(): Promise<RemoteProviderStatus[]> {
  return Promise.all(REMOTE_PROVIDERS.map(async (id) => {
    const settings = remoteProviderSettings(id);
    const keyFound = !!(await remoteProviderCredentials(id));
    return {
      id, ...settings, configured: !!settings.credential, keyFound,
      ...(lastTests.get(id) ? { lastTest: lastTests.get(id) } : {}),
    };
  }));
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
