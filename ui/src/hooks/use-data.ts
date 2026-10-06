import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { apiUrl, config } from "@/lib/config";

export type DataSourceKind = "sqlite" | "postgres" | "rest" | "json" | "csv";
export type DataCapability = "read" | "write" | "admin";
export type DataColumn = { name: string; type: "string" | "number" | "boolean" | "date" | "datetime" | "json" | "unknown"; nullable?: boolean; primaryKey?: boolean };
export type DataGrant = { id: string; agent: string; capabilities: DataCapability[]; datasets: string[]; excludedFields?: string[] };
export type DataSource = {
  id: string; name: string; slug: string; description?: string; kind: DataSourceKind;
  environment: "development" | "staging" | "production";
  config: { location: string; port?: number; database?: string; username?: string; ssl?: boolean; defaultDataset?: string };
  tags: string[]; grants: DataGrant[]; createdAt: string; updatedAt: string;
};
export type DataSourceInput = Omit<DataSource, "id" | "createdAt" | "updatedAt"> & { credentials?: Record<string, string> };
export type DataDataset = { id: string; sourceId: string; name: string; namespace?: string; kind: "table" | "view" | "endpoint" | "file"; columns: DataColumn[] };
export type DataFilter = { field: string; operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith" | "in" | "isNull"; value?: unknown };
export type DataQuery = {
  sourceId: string; dataset: string; fields?: string[]; filters?: DataFilter[];
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
  groupBy?: string[]; aggregates?: Array<{ field: string; operation: "count" | "sum" | "avg" | "min" | "max"; as?: string }>;
  limit?: number; offset?: number;
};
export type DataFrame = { columns: DataColumn[]; rows: Record<string, unknown>[]; meta: { sourceId: string; dataset: string; queryId: string; rowCount: number; truncated: boolean; durationMs: number; fetchedAt: string } };
export type DataWidget = {
  id: string; type: "metric" | "table" | "record" | "bar" | "line" | "area" | "pie" | "timeline" | "status" | "markdown" | "list" | "progress" | "gauge" | "sparkline" | "comparison" | "ranking" | "scatter" | "donut" | "radar" | "heatmap" | "funnel" | "histogram" | "treemap";
  title?: string; description?: string; binding?: string; field?: string; x?: string; y?: string;
  category?: string; value?: string; aggregate?: "count" | "sum" | "avg" | "min" | "max"; markdown?: string;
  target?: number; min?: number; max?: number; format?: "number" | "currency" | "percent" | "compact"; currency?: string; showLegend?: boolean;
  width?: 1 | 2 | 3 | 4; height?: "compact" | "standard" | "tall";
};
export type DataView = {
  id: string; name: string; description?: string; persistence: "ephemeral" | "saved" | "pinned";
  sessionId?: string; createdBy?: string; refreshSeconds?: number;
  bindings: Array<{ id: string; query: DataQuery; inline?: never } | { id: string; inline: { label?: string; rows: Record<string, unknown>[] }; query?: never }>; widgets: DataWidget[]; createdAt: string; updatedAt: string;
};
export type DataViewInput = Omit<DataView, "id" | "createdAt" | "updatedAt">;
export type DataActivity = { id: string; sourceId: string; agent?: string; action: string; dataset?: string; status: "succeeded" | "failed"; rowCount?: number; durationMs: number; error?: string; createdAt: string };

async function apiRequest<T>(resource: "data" | "views", path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const response = await fetch(apiUrl(`/api/v1/${resource}${path}`), { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || `Data request failed (${response.status})`);
  return body.data as T;
}

const request = <T,>(path: string, init?: RequestInit) => apiRequest<T>("data", path, init);
const viewRequest = <T,>(path: string, init?: RequestInit) => apiRequest<T>("views", path, init);

export function useDataSources() {
  const { events } = useEvents(["data-source:changed"], 1);
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Only the first load shows the loading state: a background refresh must not unmount the page
  const loadedRef = useRef(false);
  const refetch = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    try {
      setSources(await request<DataSource[]>("")); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { loadedRef.current = true; setLoading(false); }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);
  const latestEvent = events.at(-1);
  const handledEventRef = useRef(latestEvent?.id);
  useEffect(() => {
    if (!latestEvent || handledEventRef.current === latestEvent.id) return;
    handledEventRef.current = latestEvent.id;
    // Every query is logged as "activity" (and rows written as "data"): neither changes the list
    // of sources, and refetching on them looped (query → activity event → refetch → query…).
    const action = (latestEvent.data as { action?: string } | undefined)?.action;
    if (action === "activity" || action === "data") return;
    void refetch();
  }, [latestEvent, refetch]);

  const createSource = useCallback(async (input: DataSourceInput) => {
    const result = await request<DataSource>("", { method: "POST", body: JSON.stringify(input) });
    await refetch(); return result;
  }, [refetch]);
  const updateSource = useCallback(async (id: string, input: DataSourceInput) => {
    const result = await request<DataSource>(`/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
    await refetch(); return result;
  }, [refetch]);
  const deleteSource = useCallback(async (id: string) => { await request(`/${encodeURIComponent(id)}`, { method: "DELETE" }); await refetch(); }, [refetch]);
  const testSource = useCallback((id: string) => request<{ ok: true; latencyMs: number; datasets: number }>(`/${encodeURIComponent(id)}/test`, { method: "POST" }), []);
  const describeSource = useCallback((id: string) => request<DataDataset[]>(`/${encodeURIComponent(id)}/schema`), []);
  const sourceActivity = useCallback((id: string) => request<DataActivity[]>(`/${encodeURIComponent(id)}/activity`), []);
  const query = useCallback((input: DataQuery) => request<DataFrame>("/query", { method: "POST", body: JSON.stringify(input) }), []);
  const rawSql = useCallback((sourceId: string, sql: string) => request<DataFrame>("/sql", { method: "POST", body: JSON.stringify({ sourceId, sql }) }), []);
  const mutate = useCallback((input: { sourceId: string; dataset: string; operation: "insert" | "update" | "delete"; values?: Record<string, unknown>; filters?: DataFilter[] }) => request<{ affectedRows: number }>("/mutate", { method: "POST", body: JSON.stringify(input) }), []);
  return { sources, loading, error, refetch, createSource, updateSource, deleteSource, testSource, describeSource, sourceActivity, query, rawSql, mutate };
}

export function useDataViews() {
  const { events } = useEvents(["data-view:changed"], 1);
  const [views, setViews] = useState<DataView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const refetch = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    try { setViews(await viewRequest<DataView[]>("")); setError(null); }
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
  const createView = useCallback(async (input: DataViewInput) => { const result = await viewRequest<DataView>("", { method: "POST", body: JSON.stringify(input) }); await refetch(); return result; }, [refetch]);
  const updateView = useCallback(async (id: string, input: DataViewInput) => { const result = await viewRequest<DataView>(`/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }); await refetch(); return result; }, [refetch]);
  const deleteView = useCallback(async (id: string) => { await viewRequest(`/${encodeURIComponent(id)}`, { method: "DELETE" }); await refetch(); }, [refetch]);
  return { views, loading, error, refetch, createView, updateView, deleteView };
}

export const dataRequest = request;
export const dataViewRequest = viewRequest;
