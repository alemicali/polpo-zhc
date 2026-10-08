import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { apiUrl, config } from "@/lib/config";
import type { VaultRef } from "@/lib/vault-ref";

export type StorageAccess = "read" | "write";
export type StorageDriver = "rclone" | "mountpoint-s3";
export type StorageGrant = { id?: string; agent: string; access: StorageAccess; prefix?: string; writeBack?: "auto" | "manual" };
/** Sandbox volume (open Polpo): the bucket at /volumes/<slug> in the sandboxes that select it. */
export type StorageVolume = { enabled?: boolean; strategy: "mounted" | "hydrated"; access: "read-only" | "read-write"; writeBack?: "auto" | "manual"; label?: string };
export type StorageImportJob = { id: string; entry: string; source: string; target: string; state: "running" | "done" | "failed"; files?: number; error?: string; startedAt: string; finishedAt?: string };
export type MountState = "unmounted" | "mounting" | "mounted" | "error";
export type MountStatus = { entryId: string; slug: string; state: MountState; path: string; error?: string; since: string; restarts: number; pid?: number };
export type KeyStatus = "set" | "not set";

/** Per-run temporary keys for remote sandboxes (the R2 API token is in a referenced vault entry). */
export type StorageTemporarySettings =
  | { kind: "r2"; accountId: string; parentAccessKeyId: string; token?: VaultRef }
  | { kind: "sts"; roleArn: string; endpoint?: string };

/**
 * An entry as the API returns it: keys stay in agents' vault entries, the entry references them
 * (owner + service); `keys` says whether each reference resolves, never the values.
 */
export type StorageEntry = {
  id: string; name: string; slug: string; description?: string;
  /** "s3": a bucket (S3, R2…); "local": a folder of this server inside the project. */
  provider: "s3" | "local";
  /** Local volumes: the folder on this server (absolute). */
  path?: string;
  endpoint?: string; region?: string; bucket: string; prefix?: string; pathStyle?: boolean;
  driver: StorageDriver; readOnly: boolean; enabled: boolean;
  cache?: { mode?: "writes" | "full"; maxSizeMb?: number; maxAgeHours?: number };
  grants: StorageGrant[];
  /** Vault entry with the main keys (access key id + secret). */
  credentials?: VaultRef;
  /** Vault entry with limited keys for remote sandboxes. */
  sandboxCredentials?: VaultRef;
  temporaryCredentials?: StorageTemporarySettings;
  volume?: StorageVolume;
  keys: { credentials: KeyStatus; sandboxCredentials: KeyStatus; temporaryToken: KeyStatus };
  mount: MountStatus;
  createdAt: string; updatedAt: string;
};

/** Create/update body (PUT replaces the entry: references left out or null are cleared). */
export type StorageEntryInput = Omit<StorageEntry, "id" | "credentials" | "sandboxCredentials" | "temporaryCredentials" | "volume" | "keys" | "mount" | "createdAt" | "updatedAt" | "provider"> & {
  provider?: "s3" | "local";
  credentials?: VaultRef | null;
  sandboxCredentials?: VaultRef | null;
  /** null = the fixed sandbox key. */
  temporaryCredentials?: StorageTemporarySettings | null;
  /** null = not a sandbox volume. */
  volume?: StorageVolume | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const response = await fetch(apiUrl(`/api/v1/storage${path}`), { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || `Storage request failed (${response.status})`);
  return body.data as T;
}

const at = (id: string, suffix = "") => `/${encodeURIComponent(id)}${suffix}`;

export function useStorage() {
  const { events } = useEvents(["storage:changed"], 1);
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Only the first load shows the loading state: a background refresh must not unmount the page
  const loadedRef = useRef(false);
  const refetch = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    try { setEntries(await request<StorageEntry[]>("")); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { loadedRef.current = true; setLoading(false); }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);
  const latestEvent = events.at(-1);
  const handledEventRef = useRef(latestEvent?.id);
  useEffect(() => {
    if (!latestEvent || handledEventRef.current === latestEvent.id) return;
    handledEventRef.current = latestEvent.id;
    void refetch();
  }, [latestEvent, refetch]);

  const createEntry = useCallback(async (input: StorageEntryInput) => {
    const result = await request<StorageEntry>("", { method: "POST", body: JSON.stringify(input) });
    await refetch(); return result;
  }, [refetch]);
  const updateEntry = useCallback(async (id: string, input: StorageEntryInput) => {
    const result = await request<StorageEntry>(at(id), { method: "PUT", body: JSON.stringify(input) });
    await refetch(); return result;
  }, [refetch]);
  const deleteEntry = useCallback(async (id: string) => { await request(at(id), { method: "DELETE" }); await refetch(); }, [refetch]);
  const testEntry = useCallback((id: string) => request<{ ok: true; latencyMs: number; sampleKey?: string }>(at(id, "/test"), { method: "POST" }), []);
  const mountEntry = useCallback(async (id: string) => {
    try { return await request<MountStatus>(at(id, "/mount"), { method: "POST" }); }
    finally { await refetch(); }
  }, [refetch]);
  const unmountEntry = useCallback(async (id: string) => {
    try { return await request<MountStatus>(at(id, "/unmount"), { method: "POST" }); }
    finally { await refetch(); }
  }, [refetch]);
  const importFolder = useCallback((id: string, source: string, target?: string) =>
    request<StorageImportJob>(at(id, "/import"), { method: "POST", body: JSON.stringify({ source, ...(target ? { target } : {}) }) }), []);
  const importStatus = useCallback((id: string, job: string) => request<StorageImportJob>(at(id, `/import/${encodeURIComponent(job)}`)), []);
  return { entries, loading, error, refetch, createEntry, updateEntry, deleteEntry, testEntry, mountEntry, unmountEntry, importFolder, importStatus };
}

/** The editable fields of an entry, for PUT (which replaces them, vault references included). */
export function storageEntryInput(entry: StorageEntry, override?: Partial<StorageEntryInput>): StorageEntryInput {
  return {
    name: entry.name, slug: entry.slug, description: entry.description, provider: entry.provider, path: entry.path, endpoint: entry.endpoint, region: entry.region,
    bucket: entry.bucket, prefix: entry.prefix, pathStyle: entry.pathStyle, driver: entry.driver, readOnly: entry.readOnly,
    enabled: entry.enabled, cache: entry.cache, grants: entry.grants,
    credentials: entry.credentials ?? null, sandboxCredentials: entry.sandboxCredentials ?? null,
    temporaryCredentials: entry.temporaryCredentials ?? null, volume: entry.volume ?? null, ...override,
  };
}
