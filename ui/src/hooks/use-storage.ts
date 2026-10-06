import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { apiUrl, config } from "@/lib/config";

export type StorageAccess = "read" | "write";
export type StorageDriver = "rclone" | "mountpoint-s3";
export type StorageGrant = { id?: string; agent: string; access: StorageAccess; prefix?: string };
export type MountState = "unmounted" | "mounting" | "mounted" | "error";
export type MountStatus = { entryId: string; slug: string; state: MountState; path: string; error?: string; since: string; restarts: number; pid?: number };
export type StorageCredentialsInput = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** An entry as the API returns it: credentials are only "set" / "not set", never their values. */
export type StorageEntry = {
  id: string; name: string; slug: string; description?: string; provider: "s3";
  endpoint?: string; region?: string; bucket: string; prefix?: string; pathStyle?: boolean;
  driver: StorageDriver; readOnly: boolean; enabled: boolean;
  cache?: { mode?: "writes" | "full"; maxSizeMb?: number; maxAgeHours?: number };
  grants: StorageGrant[];
  credentials: "set" | "not set"; sandboxCredentials: "set" | "not set";
  mount: MountStatus;
  createdAt: string; updatedAt: string;
};

export type StorageEntryInput = Omit<StorageEntry, "id" | "credentials" | "sandboxCredentials" | "mount" | "createdAt" | "updatedAt" | "provider"> & {
  provider?: "s3";
  /** Write-only. Omit to keep the stored ones. */
  credentials?: StorageCredentialsInput;
  /** Write-only. Omit to keep, null to remove. */
  sandboxCredentials?: StorageCredentialsInput | null;
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
  return { entries, loading, error, refetch, createEntry, updateEntry, deleteEntry, testEntry, mountEntry, unmountEntry };
}

/** The editable fields of an entry, for PUT (which replaces them). */
export function storageEntryInput(entry: StorageEntry, override?: Partial<StorageEntryInput>): StorageEntryInput {
  return {
    name: entry.name, slug: entry.slug, description: entry.description, endpoint: entry.endpoint, region: entry.region,
    bucket: entry.bucket, prefix: entry.prefix, pathStyle: entry.pathStyle, driver: entry.driver, readOnly: entry.readOnly,
    enabled: entry.enabled, cache: entry.cache, grants: entry.grants, ...override,
  };
}
