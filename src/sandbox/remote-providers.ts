/**
 * Remote sandbox providers (Daytona, E2B).
 *
 * Settings live with the other sandbox settings (settings.sandbox.providers.<id>): the vault entry
 * holding the API key (a reference: owner + service), plus non-secret options (API URL, region,
 * template). The key itself stays in that vault entry and is read when a VM is created.
 */
import type { VaultStore } from "@polpo-ai/core";
import { DAYTONA_V2_RUNNER_IMAGE, DAYTONA_V2_SANDBOX_CLASS, daytonaV2HibernateSettings, daytonaV2MaxTimeoutSeconds, type DaytonaApiVersion, type DaytonaV2HibernateSettings } from "@polpo-ai/core/sandbox";
import { CREDENTIAL_NAMES, normalizeVaultRef, pickCredential, resolveVaultRef, type VaultRef } from "@polpo-ai/core/vault-ref";

export type RemoteProviderId = "daytona" | "e2b";
export const REMOTE_PROVIDERS: RemoteProviderId[] = ["daytona", "e2b"];

/** settings.sandbox.providers.<id> for a remote provider (no secrets). */
export interface RemoteProviderSettings {
  credential?: VaultRef;
  /**
   * Daytona: which service. "v0" (default): app.daytona.io (organization key, snapshots). "v2":
   * Daytona's new service (project API key, images, Linux VMs that cannot pause: computers
   * hibernate as memory and disk snapshots).
   */
  api?: DaytonaApiVersion;
  /** Daytona v0: API URL (default https://app.daytona.io/api). Not accepted with v2. */
  apiUrl?: string;
  /** Daytona v0: region/target (e.g. "eu", "us"). */
  target?: string;
  /** Daytona v2: region for new sandboxes (default: the project's). */
  region?: string;
  /** Daytona v0: the snapshot new sandboxes are created from. */
  snapshot?: string;
  /** Daytona: image (v2: a registered image name or id, default the Polpo runner image; v0: a Docker image). */
  image?: string;
  /** Daytona v2: the longest wall clock a sandbox may get (the plan's maximum; default 86400 s). */
  maxTimeoutSeconds?: number;
  /** Daytona v2: how computers hibernate (snapshots kept, safety snapshots, wall-clock rotation). */
  hibernate?: DaytonaV2HibernateSettings;
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
  /**
   * Daytona: the class of the machines it creates ("linux-vm" on v2; on v0 it comes with the
   * snapshot, container or linux-vm, so it is not known here).
   */
  vmClass?: string;
  /** Daytona v2: the image new sandboxes come from (the setting, else the runner image). */
  effectiveImage?: string;
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
  const fields = id === "daytona" ? (["apiUrl", "target", "region", "snapshot", "image"] as const) : (["domain", "template"] as const);
  for (const f of fields) {
    if (typeof raw[f] === "string" && (raw[f] as string).trim()) out[f] = (raw[f] as string).trim();
  }
  if (id === "daytona" && raw.api === "v2") out.api = "v2";
  if (id === "daytona" && raw.maxTimeoutSeconds !== undefined) out.maxTimeoutSeconds = daytonaV2MaxTimeoutSeconds(raw);
  if (id === "daytona" && raw.hibernate !== undefined) out.hibernate = daytonaV2HibernateSettings(raw);
  return out;
}

/** Providers with a key chosen (synchronous: used when picking where a task runs). */
export function configuredRemoteProviders(): RemoteProviderId[] {
  return REMOTE_PROVIDERS.filter((id) => !!remoteProviderSettings(id).credential);
}

/** The key (from the referenced vault entry) and the options, when a VM is about to be created. */
export async function remoteProviderCredentials(id: RemoteProviderId): Promise<RemoteProviderCredentials | undefined> {
  const { credential, ...options } = remoteProviderSettings(id);
  // v2 never sees v0's URL or region (the settings validation refuses an apiUrl with v2)
  if (options.api === "v2") { delete options.apiUrl; delete options.target; }
  const apiKey = pickCredential(await resolveVaultRef(store, credential), [...CREDENTIAL_NAMES.apiKey]);
  return apiKey ? { apiKey, ...options } : undefined;
}

export async function remoteProviderStatus(): Promise<RemoteProviderStatus[]> {
  return Promise.all(REMOTE_PROVIDERS.map(async (id) => {
    const settings = remoteProviderSettings(id);
    const keyFound = !!(await remoteProviderCredentials(id));
    const daytonaV2 = id === "daytona" && settings.api === "v2";
    return {
      id, ...settings, configured: !!settings.credential, keyFound,
      ...(id === "daytona" ? { api: settings.api ?? "v0" } : {}),
      ...(daytonaV2 ? { vmClass: DAYTONA_V2_SANDBOX_CLASS, effectiveImage: settings.image ?? DAYTONA_V2_RUNNER_IMAGE } : {}),
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
