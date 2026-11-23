/**
 * Helpers for the Data area (sources → workspace → tables, schema, SQL, views, access, activity,
 * settings): value formatting and coercion, row identity for edits, filter operators, URL tabs,
 * SQL history, and a small loader hook. Kept out of the component files (react-refresh).
 */
import { useCallback, useEffect, useState } from "react";
import type { DataColumn, DataDataset, DataFilter, DataSource, DataSourceInput, DataSourceKind, DataView } from "@/hooks/use-data";

// ── Workspace tabs and URL ─────────────────────────────────────────────

export const WORKSPACE_TABS = ["tables", "schema", "sql", "views", "access", "activity", "settings"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/**
 * The workspace tab a URL asks for. Old links keep working: ?tab=sources&source=<id> (MCP, setup
 * links) opens the source, ?tab=explore opens its tables, and a setup link (setup=data:…) opens Settings.
 */
export function workspaceTab(params: URLSearchParams, source?: DataSource): WorkspaceTab {
  if (params.get("setup")?.startsWith("data:")) return "settings";
  const tab = params.get("tab");
  if (tab && (WORKSPACE_TABS as readonly string[]).includes(tab)) {
    if (tab === "sql" && source && !isSqlSource(source)) return "tables";
    return tab as WorkspaceTab;
  }
  return "tables";
}

export function isSqlSource(source: Pick<DataSource, "kind">): boolean {
  return source.kind === "sqlite" || source.kind === "postgres";
}

/** Sources whose rows Polpo can insert, update and delete. */
export const canMutate = isSqlSource;

export const SOURCE_KINDS: Array<{ kind: DataSourceKind; label: string; description: string }> = [
  { kind: "postgres", label: "PostgreSQL", description: "Live relational database" },
  { kind: "sqlite", label: "SQLite", description: "Local database file" },
  { kind: "rest", label: "REST API", description: "JSON HTTP endpoint" },
  { kind: "json", label: "JSON", description: "Local structured file" },
  { kind: "csv", label: "CSV", description: "Local tabular file" },
];

export function kindLabel(kind: DataSourceKind): string {
  return SOURCE_KINDS.find((item) => item.kind === kind)?.label ?? kind;
}

/** Where a source lives, never with a secret in it (credentials are in the Vault, not in the config). */
export function sourceLocation(source: DataSource): string {
  if (source.kind === "postgres") return `${source.config.location}:${source.config.port ?? 5432}${source.config.database ? `/${source.config.database}` : ""}`;
  return maskUrlSecrets(source.config.location);
}

function maskUrlSecrets(location: string): string {
  try {
    const url = new URL(location);
    if (url.password) url.password = "***";
    for (const key of [...url.searchParams.keys()]) if (/^(password|secret|token|api[_-]?key|key|auth|authorization)$/i.test(key)) url.searchParams.set(key, "***");
    return url.toString().replace(/%2A%2A%2A/g, "***");
  } catch { return location; }
}

// ── Values ─────────────────────────────────────────────────────────────

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function formatCount(count: number | undefined, unit = "row"): string {
  if (count === undefined) return `— ${unit}s`;
  return `${count.toLocaleString()} ${unit}${count === 1 ? "" : "s"}`;
}

/** A form value as the column wants it: numbers, booleans and JSON parsed, "" as NULL when the column allows it. */
export function coerceValue(raw: string, column: Pick<DataColumn, "type" | "nullable">, isNull: boolean): unknown {
  if (isNull) return null;
  if (column.type === "number") {
    if (raw.trim() === "") return column.nullable ? null : raw;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number`);
    return value;
  }
  if (column.type === "boolean") {
    if (/^(true|1|yes)$/i.test(raw.trim())) return true;
    if (/^(false|0|no)$/i.test(raw.trim())) return false;
    if (raw.trim() === "" && column.nullable) return null;
    throw new Error(`"${raw}" is not true or false`);
  }
  if (column.type === "json") {
    if (raw.trim() === "") return column.nullable ? null : raw;
    try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON"); }
  }
  return raw;
}

/** A value as it goes in a form field. */
export function editableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

// ── Row identity ───────────────────────────────────────────────────────

export interface RowIdentity {
  /** primary-key: the row by its key; all-columns: every value must match (a table without a key). */
  by: "primary-key" | "all-columns";
  filters: DataFilter[];
}

/** The filters that pick exactly this row for an update or delete. */
export function rowIdentity(row: Record<string, unknown>, columns: DataColumn[]): RowIdentity {
  const keys = columns.filter((column) => column.primaryKey);
  if (keys.length) return { by: "primary-key", filters: keys.map((column) => valueFilter(column.name, row[column.name])) };
  const comparable = columns.filter((column) => column.type !== "json" && column.name in row);
  return { by: "all-columns", filters: comparable.map((column) => valueFilter(column.name, row[column.name])) };
}

function valueFilter(field: string, value: unknown): DataFilter {
  return value === null || value === undefined ? { field, operator: "isNull" } : { field, operator: "eq", value };
}

export function rowKey(row: Record<string, unknown>, columns: DataColumn[], index: number): string {
  const keys = columns.filter((column) => column.primaryKey);
  return keys.length ? keys.map((column) => formatCell(row[column.name])).join("\u0001") : `#${index}`;
}

// ── Filters (Lumea's filter builder, on Polpo's operators) ─────────────

export type FilterOperator = DataFilter["operator"];

export const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string; needsValue: boolean }> = [
  { value: "eq", label: "equals", needsValue: true },
  { value: "neq", label: "not equals", needsValue: true },
  { value: "gt", label: "greater than", needsValue: true },
  { value: "gte", label: "greater or equal", needsValue: true },
  { value: "lt", label: "less than", needsValue: true },
  { value: "lte", label: "less or equal", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "startsWith", label: "starts with", needsValue: true },
  { value: "in", label: "is one of (a, b, c)", needsValue: true },
  { value: "isNull", label: "is null", needsValue: false },
];

export interface FilterDraft { field: string; operator: FilterOperator; value: string }

/** The drafts as query filters: values typed by column, incomplete rows left out. */
export function toQueryFilters(drafts: FilterDraft[], columns: DataColumn[]): DataFilter[] {
  return drafts.flatMap((draft): DataFilter[] => {
    const column = columns.find((item) => item.name === draft.field);
    if (!column) return [];
    if (draft.operator === "isNull") return [{ field: draft.field, operator: "isNull" as const }];
    if (draft.value.trim() === "") return [];
    const typed = (raw: string) => {
      if (column.type === "number" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
      if (column.type === "boolean" && /^(true|false)$/i.test(raw.trim())) return raw.trim().toLowerCase() === "true";
      return raw;
    };
    if (draft.operator === "in") return [{ field: draft.field, operator: "in" as const, value: draft.value.split(",").map((part) => typed(part.trim())) }];
    if (draft.operator === "contains" || draft.operator === "startsWith") return [{ field: draft.field, operator: draft.operator, value: draft.value }];
    return [{ field: draft.field, operator: draft.operator, value: typed(draft.value) }];
  });
}

export function describeFilters(filters: DataFilter[]): string {
  return filters.map((filter) => {
    const op = FILTER_OPERATORS.find((item) => item.value === filter.operator)?.label ?? filter.operator;
    return filter.operator === "isNull" ? `${filter.field} is null` : `${filter.field} ${op} ${Array.isArray(filter.value) ? filter.value.join(", ") : formatCell(filter.value)}`;
  }).join(" and ");
}

// ── Datasets ───────────────────────────────────────────────────────────

/** A dataset's name without its schema (public.orders → orders) when the schema is the default one. */
export function datasetLabel(dataset: Pick<DataDataset, "name" | "namespace">): string {
  return dataset.namespace === "public" ? dataset.name.slice("public.".length) : dataset.name;
}

/** Where a saved data view opens (Artifacts, type view). */
export function viewLink(id: string): string {
  return `/artifacts/${encodeURIComponent(`view:${id}`)}`;
}

/** Views whose bindings read this source. */
export function viewsOfSource(views: DataView[], sourceId: string): DataView[] {
  return views.filter((view) => view.bindings.some((binding) => (binding.query?.sourceId ?? binding.sql?.sourceId) === sourceId));
}

// ── SQL history (per source, this browser) ─────────────────────────────

const HISTORY_LIMIT = 30;
export interface SqlHistoryEntry { sql: string; at: string; rows?: number; error?: string }

function historyKey(sourceId: string) { return `polpo:data-sql-history:${sourceId}`; }

export function readSqlHistory(sourceId: string): SqlHistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey(sourceId)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is SqlHistoryEntry => !!entry && typeof (entry as SqlHistoryEntry).sql === "string") : [];
  } catch { return []; }
}

export function pushSqlHistory(sourceId: string, entry: SqlHistoryEntry): SqlHistoryEntry[] {
  const next = [entry, ...readSqlHistory(sourceId).filter((item) => item.sql.trim() !== entry.sql.trim())].slice(0, HISTORY_LIMIT);
  try { localStorage.setItem(historyKey(sourceId), JSON.stringify(next)); } catch { /* storage full or off */ }
  return next;
}

// ── Misc ───────────────────────────────────────────────────────────────

/** A source as the update API takes it, with some fields changed. */
export function sourceInput(source: DataSource, override?: Partial<DataSourceInput>): DataSourceInput {
  return { name: source.name, slug: source.slug, description: source.description, kind: source.kind, environment: source.environment, config: source.config, tags: source.tags, grants: source.grants, ...override };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function slugify(value: string): string {
  return value.toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `source-${Date.now()}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Data loaded for a key (null: nothing to load). `loading` is true until the current key's data or
 * error arrives; `reload()` fetches it again, keeping the data meanwhile (and so does a new key with
 * `keepPrevious`: the grid keeps its rows while the next page or sort loads). No state is set
 * synchronously inside the effect.
 */
export function useLoader<T>(key: string | null, load: () => Promise<T>, options?: { keepPrevious?: boolean }) {
  const [nonce, setNonce] = useState(0);
  const full = key === null ? null : `${key}#${nonce}`;
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string }>({ key: null });
  useEffect(() => {
    if (full === null) return;
    let cancelled = false;
    load().then(
      (data) => { if (!cancelled) setState({ key: full, data }); },
      (error: unknown) => { if (!cancelled) setState((current) => ({ key: full, data: current.data, error: errorMessage(error) })); },
    );
    return () => { cancelled = true; };
    // `load` is read when the key changes; callers put what it depends on in the key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const fresh = state.key === full;
  return {
    data: fresh || options?.keepPrevious || (state.key?.startsWith(`${key}#`) ?? false) ? state.data : undefined,
    error: fresh ? state.error : undefined,
    loading: full !== null && !fresh,
    reload,
  };
}
