import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { VaultStore } from "../core/vault-store.js";
import type {
  DataColumn,
  DataDataset,
  DataFilter,
  DataFrame,
  DataGrant,
  DataQuery,
  DataSource,
  DataCapability,
} from "../core/data-registry.js";
import { FileDataRegistryStore, type DataRegistryChangeEmitter } from "../stores/file-data-registry-store.js";

const require = createRequire(import.meta.url);
const MAX_ROWS = 1_000;
const DEFAULT_ROWS = 100;

export interface DataPrincipal {
  agent?: string;
  /** Missing agent means platform administrator/orchestrator. */
  admin?: boolean;
}

export interface DataMutation {
  sourceId: string;
  dataset: string;
  operation: "insert" | "update" | "delete";
  values?: Record<string, unknown>;
  filters?: DataFilter[];
}

export class DataRuntime {
  readonly store: FileDataRegistryStore;

  constructor(
    readonly polpoDir: string,
    private vaultStore?: VaultStore,
    emitChange?: DataRegistryChangeEmitter,
  ) {
    this.store = new FileDataRegistryStore(polpoDir, emitChange);
  }

  setVaultStore(store?: VaultStore): void {
    this.vaultStore = store;
  }

  setEmitter(emitChange?: DataRegistryChangeEmitter): void {
    this.store.setEmitter(emitChange);
  }

  async listSources(principal: DataPrincipal = { admin: true }): Promise<DataSource[]> {
    const sources = await this.store.listSources();
    return sources.filter((source) => this.hasCapability(source, principal, "read"));
  }

  async getSource(sourceId: string, principal: DataPrincipal, capability: DataCapability = "read"): Promise<DataSource> {
    return this.requireSource(sourceId, principal, capability);
  }

  async test(sourceId: string, principal: DataPrincipal = { admin: true }): Promise<{ ok: true; latencyMs: number; datasets: number }> {
    const started = Date.now();
    const source = await this.requireSource(sourceId, principal, "read");
    try {
      const datasets = await this.discoverSource(source);
      await this.record(source.id, principal, "test", "succeeded", started, { rowCount: datasets.length });
      return { ok: true, latencyMs: Date.now() - started, datasets: datasets.length };
    } catch (error) {
      await this.record(source.id, principal, "test", "failed", started, { error: errorMessage(error) });
      throw error;
    }
  }

  async discover(sourceId: string, principal: DataPrincipal = { admin: true }): Promise<DataDataset[]> {
    const started = Date.now();
    const source = await this.requireSource(sourceId, principal, "read");
    try {
      const result = await this.discoverSource(source);
      await this.record(source.id, principal, "discover", "succeeded", started, { rowCount: result.length });
      return this.applyFieldGrants(source, principal, result);
    } catch (error) {
      await this.record(source.id, principal, "discover", "failed", started, { error: errorMessage(error) });
      throw error;
    }
  }

  async query(query: DataQuery, principal: DataPrincipal = { admin: true }): Promise<DataFrame> {
    const started = Date.now();
    const source = await this.requireSource(query.sourceId, principal, "read", query.dataset);
    const safeQuery = this.restrictQuery(source, principal, query);
    try {
      const rows = await this.querySource(source, safeQuery);
      const requestedLimit = clampLimit(query.limit);
      const truncated = rows.length > requestedLimit;
      const visibleRows = rows.slice(0, requestedLimit);
      const frame: DataFrame = {
        columns: inferColumns(visibleRows),
        rows: visibleRows,
        meta: {
          sourceId: source.id,
          dataset: query.dataset,
          queryId: nanoid(),
          rowCount: visibleRows.length,
          truncated,
          durationMs: Date.now() - started,
          fetchedAt: new Date().toISOString(),
        },
      };
      await this.record(source.id, principal, "query", "succeeded", started, { dataset: query.dataset, rowCount: frame.rows.length });
      return frame;
    } catch (error) {
      await this.record(source.id, principal, "query", "failed", started, { dataset: query.dataset, error: errorMessage(error) });
      throw error;
    }
  }

  async rawSql(sourceId: string, sql: string, principal: DataPrincipal): Promise<DataFrame> {
    const started = Date.now();
    const source = await this.requireSource(sourceId, principal, "read");
    if (source.kind !== "sqlite" && source.kind !== "postgres") throw new Error("Raw SQL is supported only for SQLite and PostgreSQL sources");
    assertReadOnlySql(sql);
    try {
      const rows = await this.executeRaw(source, sql);
      const visibleRows = rows.slice(0, MAX_ROWS);
      const frame: DataFrame = {
        columns: inferColumns(visibleRows),
        rows: visibleRows,
        meta: {
          sourceId: source.id,
          dataset: "raw-sql",
          queryId: nanoid(),
          rowCount: visibleRows.length,
          truncated: rows.length > MAX_ROWS,
          durationMs: Date.now() - started,
          fetchedAt: new Date().toISOString(),
        },
      };
      await this.record(source.id, principal, "sql", "succeeded", started, { rowCount: frame.rows.length });
      return frame;
    } catch (error) {
      await this.record(source.id, principal, "sql", "failed", started, { error: errorMessage(error) });
      throw error;
    }
  }

  async mutate(input: DataMutation, principal: DataPrincipal): Promise<{ affectedRows: number }> {
    const started = Date.now();
    const source = await this.requireSource(input.sourceId, principal, "write", input.dataset);
    if (source.kind !== "sqlite" && source.kind !== "postgres") throw new Error("Mutations are currently supported only for SQLite and PostgreSQL sources");
    if (input.operation !== "insert" && (!input.filters || input.filters.length === 0)) {
      throw new Error(`${input.operation} requires at least one filter`);
    }
    try {
      const affectedRows = await this.executeMutation(source, input);
      await this.record(source.id, principal, "mutate", "succeeded", started, { dataset: input.dataset, rowCount: affectedRows });
      return { affectedRows };
    } catch (error) {
      await this.record(source.id, principal, "mutate", "failed", started, { dataset: input.dataset, error: errorMessage(error) });
      throw error;
    }
  }

  private async requireSource(id: string, principal: DataPrincipal, capability: DataCapability, dataset?: string): Promise<DataSource> {
    const source = await this.store.getSource(id);
    if (!source) throw new Error(`Data source "${id}" not found`);
    if (!this.hasCapability(source, principal, capability, dataset)) throw new Error(`Access denied to ${source.name}${dataset ? ` / ${dataset}` : ""}`);
    return source;
  }

  private hasCapability(source: DataSource, principal: DataPrincipal, capability: DataCapability, dataset?: string): boolean {
    if (principal.admin || !principal.agent) return true;
    return source.grants.some((grant) => grant.agent === principal.agent
      && grantAllows(grant, capability)
      && (!dataset || matchesDataset(grant, dataset)));
  }

  private grantFor(source: DataSource, principal: DataPrincipal): DataGrant | undefined {
    if (principal.admin || !principal.agent) return undefined;
    return source.grants.find((grant) => grant.agent === principal.agent);
  }

  private restrictQuery(source: DataSource, principal: DataPrincipal, query: DataQuery): DataQuery {
    const grant = this.grantFor(source, principal);
    if (!grant?.excludedFields?.length) return { ...query, limit: clampLimit(query.limit) + 1 };
    const blocked = new Set(grant.excludedFields);
    for (const field of [...(query.fields ?? []), ...(query.groupBy ?? []), ...(query.sort ?? []).map((item) => item.field), ...(query.filters ?? []).map((item) => item.field)]) {
      if (blocked.has(field)) throw new Error(`Field "${field}" is excluded by the data grant`);
    }
    return { ...query, fields: query.fields?.filter((field) => !blocked.has(field)), limit: clampLimit(query.limit) + 1 };
  }

  private applyFieldGrants(source: DataSource, principal: DataPrincipal, datasets: DataDataset[]): DataDataset[] {
    const grant = this.grantFor(source, principal);
    if (!grant) return datasets;
    const blocked = new Set(grant.excludedFields ?? []);
    return datasets
      .filter((dataset) => matchesDataset(grant, dataset.name))
      .map((dataset) => ({ ...dataset, columns: dataset.columns.filter((column) => !blocked.has(column.name)) }));
  }

  private async credentials(source: DataSource): Promise<Record<string, string>> {
    const entry = await this.vaultStore?.get("$data", `data:${source.id}`);
    return entry?.credentials ?? {};
  }

  private async discoverSource(source: DataSource): Promise<DataDataset[]> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => discoverSqlite(db, source));
    if (source.kind === "postgres") return this.withPostgres(source, async (sql) => discoverPostgres(sql, source));
    if (source.kind === "rest") {
      const dataset = source.config.defaultDataset ?? "/";
      const rows = await this.queryRest(source, { sourceId: source.id, dataset, limit: 10 });
      return [{ id: `${source.id}:${dataset}`, sourceId: source.id, name: dataset, kind: "endpoint", columns: inferColumns(rows) }];
    }
    const rows = await this.queryFile(source, { sourceId: source.id, dataset: source.config.defaultDataset ?? basename(source.config.location), limit: 10 });
    return [{ id: `${source.id}:file`, sourceId: source.id, name: source.config.defaultDataset ?? basename(source.config.location), kind: "file", columns: inferColumns(rows) }];
  }

  private async querySource(source: DataSource, query: DataQuery): Promise<Record<string, unknown>[]> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => executeSqliteQuery(db, query));
    if (source.kind === "postgres") return this.withPostgres(source, (sql) => executePostgresQuery(sql, query));
    if (source.kind === "rest") return this.queryRest(source, query);
    return this.queryFile(source, query);
  }

  private async executeRaw(source: DataSource, query: string): Promise<Record<string, unknown>[]> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => db.prepare(query).all() as Record<string, unknown>[]);
    return this.withPostgres(source, async (sql) => (await sql.unsafe(query)) as unknown as Record<string, unknown>[]);
  }

  private async executeMutation(source: DataSource, mutation: DataMutation): Promise<number> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => executeSqliteMutation(db, mutation));
    return this.withPostgres(source, (sql) => executePostgresMutation(sql, mutation));
  }

  private async withSqlite<T>(source: DataSource, action: (db: any) => T | Promise<T>): Promise<T> {
    const Database = require("better-sqlite3") as new (path: string, options?: Record<string, unknown>) => any;
    const db = new Database(resolve(source.config.location));
    db.pragma("busy_timeout = 5000");
    try { return await action(db); } finally { db.close(); }
  }

  private async withPostgres<T>(source: DataSource, action: (sql: any) => T | Promise<T>): Promise<T> {
    const postgres = (await import("postgres")).default;
    const credentials = await this.credentials(source);
    const sql = postgres({
      host: source.config.location,
      port: source.config.port ?? 5432,
      database: source.config.database,
      username: source.config.username ?? credentials.username,
      password: credentials.password,
      ssl: source.config.ssl ? "require" : false,
      max: 1,
      connect_timeout: 8,
      idle_timeout: 2,
    });
    try { return await action(sql); } finally { await sql.end({ timeout: 2 }); }
  }

  private async queryRest(source: DataSource, query: DataQuery): Promise<Record<string, unknown>[]> {
    const base = new URL(source.config.location.endsWith("/") ? source.config.location : `${source.config.location}/`);
    const target = new URL(query.dataset.replace(/^\//, ""), base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new Error("REST dataset must stay within the configured base URL");
    for (const filter of query.filters ?? []) {
      if (filter.value !== undefined) target.searchParams.append(`${filter.field}.${filter.operator}`, Array.isArray(filter.value) ? filter.value.join(",") : String(filter.value));
    }
    target.searchParams.set("limit", String(clampLimit(query.limit)));
    if (query.offset) target.searchParams.set("offset", String(Math.max(0, query.offset)));
    const credentials = await this.credentials(source);
    const response = await fetch(target, { headers: credentials, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`REST source returned ${response.status}`);
    const body = await response.json() as unknown;
    return normalizeRows(body);
  }

  private async queryFile(source: DataSource, query: DataQuery): Promise<Record<string, unknown>[]> {
    const text = await readFile(resolve(source.config.location), "utf8");
    const rows = source.kind === "csv" ? parseCsv(text) : normalizeRows(JSON.parse(text));
    return applyInMemoryQuery(rows, query);
  }

  private async record(
    sourceId: string,
    principal: DataPrincipal,
    action: "test" | "discover" | "query" | "sql" | "mutate",
    status: "succeeded" | "failed",
    started: number,
    detail: { dataset?: string; rowCount?: number; error?: string },
  ): Promise<void> {
    await this.store.addActivity({ sourceId, agent: principal.agent, action, status, durationMs: Date.now() - started, ...detail }).catch(() => undefined);
  }
}

const runtimes = new Map<string, DataRuntime>();

export function getDataRegistryRuntime(polpoDir: string, vaultStore?: VaultStore, emitChange?: DataRegistryChangeEmitter): DataRuntime {
  let runtime = runtimes.get(polpoDir);
  if (!runtime) {
    runtime = new DataRuntime(polpoDir, vaultStore, emitChange);
    runtimes.set(polpoDir, runtime);
  } else if (vaultStore) {
    runtime.setVaultStore(vaultStore);
  }
  if (emitChange) runtime.setEmitter(emitChange);
  return runtime;
}

function matchesDataset(grant: DataGrant, dataset: string): boolean {
  return grant.datasets.length === 0 || grant.datasets.some((pattern) => pattern === "*" || pattern === dataset || (pattern.endsWith(".*") && dataset.startsWith(pattern.slice(0, -1))));
}

function clampLimit(limit?: number): number {
  return Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_ROWS), MAX_ROWS));
}

function quoteIdentifier(identifier: string, dialect: "sqlite" | "postgres"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) throw new Error(`Invalid identifier "${identifier}"`);
  return dialect === "postgres" ? `"${identifier.replaceAll('"', '""')}"` : `"${identifier.replaceAll('"', '""')}"`;
}

function splitDataset(dataset: string): { namespace?: string; name: string } {
  const parts = dataset.split(".");
  if (parts.length === 1) return { name: parts[0]! };
  if (parts.length === 2) return { namespace: parts[0], name: parts[1]! };
  throw new Error("Dataset must be a table or schema.table identifier");
}

function tableSql(dataset: string, dialect: "sqlite" | "postgres"): string {
  const { namespace, name } = splitDataset(dataset);
  return namespace ? `${quoteIdentifier(namespace, dialect)}.${quoteIdentifier(name, dialect)}` : quoteIdentifier(name, dialect);
}

function selectSql(query: DataQuery, dialect: "sqlite" | "postgres"): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const param = (value: unknown) => {
    values.push(value);
    return dialect === "postgres" ? `$${values.length}` : "?";
  };
  const group = query.groupBy ?? [];
  const aggregates = query.aggregates ?? [];
  let select = "*";
  if (group.length || aggregates.length) {
    select = [
      ...group.map((field) => quoteIdentifier(field, dialect)),
      ...aggregates.map((aggregate) => {
        const fn = aggregate.operation.toUpperCase();
        const target = aggregate.operation === "count" && aggregate.field === "*" ? "*" : quoteIdentifier(aggregate.field, dialect);
        return `${fn}(${target}) AS ${quoteIdentifier(aggregate.as ?? `${aggregate.operation}_${aggregate.field.replaceAll("*", "all")}`, dialect)}`;
      }),
    ].join(", ");
  } else if (query.fields?.length) {
    select = query.fields.map((field) => quoteIdentifier(field, dialect)).join(", ");
  }
  const where = filterSql(query.filters ?? [], dialect, param);
  const order = (query.sort ?? []).map((item) => `${quoteIdentifier(item.field, dialect)} ${item.direction === "desc" ? "DESC" : "ASC"}`).join(", ");
  const text = [
    `SELECT ${select} FROM ${tableSql(query.dataset, dialect)}`,
    where ? `WHERE ${where}` : "",
    group.length ? `GROUP BY ${group.map((field) => quoteIdentifier(field, dialect)).join(", ")}` : "",
    order ? `ORDER BY ${order}` : "",
    `LIMIT ${param(clampLimit(query.limit))}`,
    query.offset ? `OFFSET ${param(Math.max(0, query.offset))}` : "",
  ].filter(Boolean).join(" ");
  return { text, values };
}

function filterSql(filters: DataFilter[], dialect: "sqlite" | "postgres", param: (value: unknown) => string): string {
  return filters.map((filter) => {
    const field = quoteIdentifier(filter.field, dialect);
    if (filter.operator === "isNull") return `${field} IS NULL`;
    if (filter.operator === "in") {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (values.length === 0) return "1 = 0";
      return `${field} IN (${values.map((value) => param(value)).join(", ")})`;
    }
    if (filter.operator === "contains") return `${field} LIKE ${param(`%${String(filter.value ?? "")}%`)}`;
    if (filter.operator === "startsWith") return `${field} LIKE ${param(`${String(filter.value ?? "")}%`)}`;
    const operators: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    return `${field} ${operators[filter.operator] ?? "="} ${param(filter.value)}`;
  }).join(" AND ");
}

function executeSqliteQuery(db: any, query: DataQuery): Record<string, unknown>[] {
  const compiled = selectSql(query, "sqlite");
  return db.prepare(compiled.text).all(...compiled.values) as Record<string, unknown>[];
}

async function executePostgresQuery(sql: any, query: DataQuery): Promise<Record<string, unknown>[]> {
  const compiled = selectSql(query, "postgres");
  return await sql.unsafe(compiled.text, compiled.values) as Record<string, unknown>[];
}

function executeSqliteMutation(db: any, mutation: DataMutation): number {
  const compiled = mutationSql(mutation, "sqlite");
  return Number(db.prepare(compiled.text).run(...compiled.values).changes ?? 0);
}

async function executePostgresMutation(sql: any, mutation: DataMutation): Promise<number> {
  const compiled = mutationSql(mutation, "postgres");
  const result = await sql.unsafe(compiled.text, compiled.values);
  return Number(result.count ?? result.length ?? 0);
}

function mutationSql(mutation: DataMutation, dialect: "sqlite" | "postgres"): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const param = (value: unknown) => { values.push(value); return dialect === "postgres" ? `$${values.length}` : "?"; };
  const table = tableSql(mutation.dataset, dialect);
  if (mutation.operation === "insert") {
    const entries = Object.entries(mutation.values ?? {});
    if (!entries.length) throw new Error("Insert requires values");
    return {
      text: `INSERT INTO ${table} (${entries.map(([key]) => quoteIdentifier(key, dialect)).join(", ")}) VALUES (${entries.map(([, value]) => param(value)).join(", ")})`,
      values,
    };
  }
  if (mutation.operation === "delete") {
    const where = filterSql(mutation.filters ?? [], dialect, param);
    return { text: `DELETE FROM ${table} WHERE ${where}`, values };
  }
  const entries = Object.entries(mutation.values ?? {});
  if (!entries.length) throw new Error("Update requires values");
  const set = entries.map(([key, value]) => `${quoteIdentifier(key, dialect)} = ${param(value)}`).join(", ");
  const where = filterSql(mutation.filters ?? [], dialect, param);
  return { text: `UPDATE ${table} SET ${set} WHERE ${where}`, values };
}

function grantAllows(grant: DataGrant, capability: DataCapability): boolean {
  if (grant.capabilities.includes("admin")) return true;
  if (capability === "read") return grant.capabilities.includes("read") || grant.capabilities.includes("write");
  return grant.capabilities.includes(capability);
}

function discoverSqlite(db: any, source: DataSource): DataDataset[] {
  const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; type: string }>;
  return tables.map((table) => {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name, "sqlite")})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    return {
      id: `${source.id}:${table.name}`,
      sourceId: source.id,
      name: table.name,
      kind: table.type === "view" ? "view" : "table",
      columns: columns.map((column) => ({ name: column.name, type: sqlType(column.type), nullable: !column.notnull, primaryKey: Boolean(column.pk) })),
    };
  });
}

async function discoverPostgres(sql: any, source: DataSource): Promise<DataDataset[]> {
  const rows = await sql`
    SELECT table_schema, table_name, table_type, column_name, data_type, is_nullable, ordinal_position
    FROM information_schema.columns
    JOIN information_schema.tables USING (table_schema, table_name)
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  ` as Array<Record<string, string>>;
  const grouped = new Map<string, DataDataset>();
  for (const row of rows) {
    const name = `${row.table_schema}.${row.table_name}`;
    const dataset = grouped.get(name) ?? {
      id: `${source.id}:${name}`, sourceId: source.id, namespace: row.table_schema, name,
      kind: row.table_type === "VIEW" ? "view" : "table", columns: [],
    } satisfies DataDataset;
    dataset.columns.push({ name: row.column_name, type: sqlType(row.data_type), nullable: row.is_nullable === "YES" });
    grouped.set(name, dataset);
  }
  return [...grouped.values()];
}

function sqlType(type: string): DataColumn["type"] {
  const value = type.toLowerCase();
  if (/int|decimal|numeric|real|double|float/.test(value)) return "number";
  if (/bool/.test(value)) return "boolean";
  if (/timestamp|datetime/.test(value)) return "datetime";
  if (/date/.test(value)) return "date";
  if (/json/.test(value)) return "json";
  if (/char|text|uuid|enum/.test(value)) return "string";
  return "unknown";
}

function inferColumns(rows: Record<string, unknown>[]): DataColumn[] {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return names.map((name) => ({ name, type: inferType(rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name]), nullable: rows.some((row) => row[name] == null) }));
}

function inferType(value: unknown): DataColumn["type"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") return "json";
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) return "datetime";
  if (typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value)) return "date";
  return typeof value === "string" ? "string" : "unknown";
}

function normalizeRows(value: unknown): Record<string, unknown>[] {
  const candidate = Array.isArray(value) ? value : value && typeof value === "object"
    ? ((value as any).data ?? (value as any).items ?? (value as any).results ?? value)
    : [];
  const rows = Array.isArray(candidate) ? candidate : [candidate];
  return rows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : { value: row });
}

function applyInMemoryQuery(input: Record<string, unknown>[], query: DataQuery): Record<string, unknown>[] {
  let rows = input.filter((row) => (query.filters ?? []).every((filter) => matchFilter(row[filter.field], filter)));
  const sort = query.sort ?? [];
  if (sort.length) rows = [...rows].sort((left, right) => compareRows(left, right, sort));
  if (query.fields?.length) rows = rows.map((row) => Object.fromEntries(query.fields!.map((field) => [field, row[field]])));
  return rows.slice(Math.max(0, query.offset ?? 0), Math.max(0, query.offset ?? 0) + clampLimit(query.limit));
}

function matchFilter(actual: unknown, filter: DataFilter): boolean {
  const expected = filter.value;
  if (filter.operator === "isNull") return actual == null;
  if (filter.operator === "in") return (Array.isArray(expected) ? expected : [expected]).includes(actual as any);
  if (filter.operator === "contains") return String(actual ?? "").toLocaleLowerCase().includes(String(expected ?? "").toLocaleLowerCase());
  if (filter.operator === "startsWith") return String(actual ?? "").toLocaleLowerCase().startsWith(String(expected ?? "").toLocaleLowerCase());
  if (filter.operator === "neq") return actual !== expected;
  if (filter.operator === "gt") return (actual as any) > (expected as any);
  if (filter.operator === "gte") return (actual as any) >= (expected as any);
  if (filter.operator === "lt") return (actual as any) < (expected as any);
  if (filter.operator === "lte") return (actual as any) <= (expected as any);
  return actual === expected;
}

function compareRows(left: Record<string, unknown>, right: Record<string, unknown>, sort: DataQuery["sort"]): number {
  for (const item of sort ?? []) {
    const comparison = String(left[item.field] ?? "").localeCompare(String(right[item.field] ?? ""), undefined, { numeric: true });
    if (comparison) return item.direction === "desc" ? -comparison : comparison;
  }
  return 0;
}

function parseCsv(text: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ",") { row.push(field); field = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); field = "";
      if (row.some((value) => value.length)) records.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field || row.length) { row.push(field); records.push(row); }
  const headers = records.shift()?.map((value, index) => value.trim() || `column_${index + 1}`) ?? [];
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, coerceCsv(values[index] ?? "")])));
}

function coerceCsv(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return value;
}

function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().replace(/^--.*$/gm, "").trim();
  if (!/^(select|with|explain)\b/i.test(normalized)) throw new Error("Only SELECT, WITH, and EXPLAIN statements are allowed");
  if (/;\s*\S/.test(normalized) || /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|truncate|grant|revoke|copy|call|do)\b/i.test(normalized)) {
    throw new Error("Raw SQL must be a single read-only statement");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
