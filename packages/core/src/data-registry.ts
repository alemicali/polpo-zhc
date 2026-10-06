export type DataSourceKind = "sqlite" | "postgres" | "rest" | "json" | "csv";
export type DataCapability = "read" | "write" | "admin";

export interface DataGrant {
  id: string;
  agent: string;
  capabilities: DataCapability[];
  /** Dataset names or simple prefix patterns such as `sales.*`. */
  datasets: string[];
  excludedFields?: string[];
}

export interface DataSourceConfig {
  /** SQLite/JSON/CSV path, REST base URL, or PostgreSQL host. */
  location: string;
  port?: number;
  database?: string;
  username?: string;
  ssl?: boolean;
  /** Optional default REST path or file label. */
  defaultDataset?: string;
}

export interface DataSource {
  id: string;
  name: string;
  slug: string;
  description?: string;
  kind: DataSourceKind;
  environment: "development" | "staging" | "production";
  config: DataSourceConfig;
  tags: string[];
  grants: DataGrant[];
  createdAt: string;
  updatedAt: string;
}

export type CreateDataSource = Omit<DataSource, "id" | "createdAt" | "updatedAt"> & { id?: string };

export type DataScalar = string | number | boolean | null;

export interface DataColumn {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "datetime" | "json" | "unknown";
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface DataDataset {
  id: string;
  sourceId: string;
  name: string;
  namespace?: string;
  kind: "table" | "view" | "endpoint" | "file";
  columns: DataColumn[];
}

export type DataFilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith" | "in" | "isNull";

export interface DataFilter {
  field: string;
  operator: DataFilterOperator;
  value?: DataScalar | DataScalar[];
}

export interface DataSort {
  field: string;
  direction: "asc" | "desc";
}

export interface DataAggregate {
  field: string;
  operation: "count" | "sum" | "avg" | "min" | "max";
  as?: string;
}

export interface DataQuery {
  sourceId: string;
  dataset: string;
  fields?: string[];
  filters?: DataFilter[];
  sort?: DataSort[];
  groupBy?: string[];
  aggregates?: DataAggregate[];
  limit?: number;
  offset?: number;
}

export interface DataFrame {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  meta: {
    sourceId: string;
    dataset: string;
    queryId: string;
    rowCount: number;
    truncated: boolean;
    durationMs: number;
    fetchedAt: string;
  };
}

export type DataWidgetType =
  | "metric" | "table" | "record" | "bar" | "line" | "area" | "pie"
  | "timeline" | "status" | "markdown" | "list" | "progress" | "gauge"
  | "sparkline" | "comparison" | "ranking" | "scatter" | "donut"
  | "radar" | "heatmap" | "funnel" | "histogram" | "treemap";

export type DataViewBinding =
  | { id: string; query: DataQuery; inline?: never }
  | { id: string; inline: { label?: string; rows: Record<string, unknown>[] }; query?: never };

export interface DataViewWidget {
  id: string;
  type: DataWidgetType;
  title?: string;
  description?: string;
  binding?: string;
  field?: string;
  x?: string;
  y?: string;
  category?: string;
  value?: string;
  aggregate?: "count" | "sum" | "avg" | "min" | "max";
  target?: number;
  min?: number;
  max?: number;
  format?: "number" | "currency" | "percent" | "compact";
  currency?: string;
  showLegend?: boolean;
  markdown?: string;
  width?: 1 | 2 | 3 | 4;
  height?: "compact" | "standard" | "tall";
}

export interface DataView {
  id: string;
  name: string;
  description?: string;
  persistence: "ephemeral" | "saved" | "pinned";
  sessionId?: string;
  createdBy?: string;
  refreshSeconds?: number;
  bindings: DataViewBinding[];
  widgets: DataViewWidget[];
  createdAt: string;
  updatedAt: string;
}

export type CreateDataView = Omit<DataView, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface DataActivity {
  id: string;
  sourceId: string;
  agent?: string;
  action: "test" | "discover" | "query" | "sql" | "mutate";
  dataset?: string;
  status: "succeeded" | "failed";
  rowCount?: number;
  durationMs: number;
  error?: string;
  createdAt: string;
}

export type DataRegistryChangeEvent =
  | { type: "source"; sourceId: string; action: "created" | "updated" | "deleted" | "activity" | "data"; timestamp: string }
  | { type: "view"; viewId: string; action: "created" | "updated" | "deleted"; timestamp: string };

export type DataRegistryChangeEmitter = (event: DataRegistryChangeEvent) => void;

export interface DataRegistryStore {
  listSources(): Promise<DataSource[]>;
  getSource(id: string): Promise<DataSource | null>;
  createSource(input: CreateDataSource): Promise<DataSource>;
  updateSource(id: string, input: Partial<Omit<DataSource, "id" | "createdAt">>): Promise<DataSource | null>;
  deleteSource(id: string): Promise<boolean>;
  listViews(): Promise<DataView[]>;
  getView(id: string): Promise<DataView | null>;
  createView(input: CreateDataView): Promise<DataView>;
  updateView(id: string, input: Partial<Omit<DataView, "id" | "createdAt">>): Promise<DataView | null>;
  deleteView(id: string): Promise<boolean>;
  addActivity(input: Omit<DataActivity, "id" | "createdAt">): Promise<DataActivity>;
  listActivity(sourceId?: string, limit?: number): Promise<DataActivity[]>;
  setEmitter?(emitChange?: DataRegistryChangeEmitter): void;
}

export function normalizeDataTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.toLocaleLowerCase()))].sort();
}
