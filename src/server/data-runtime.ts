import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { VaultStore } from "../core/vault-store.js";
import type {
  DataColumn,
  DataDataset,
  DataForeignKey,
  DataIndex,
  DataFilter,
  DataFrame,
  DataGrant,
  DataQuery,
  DataSource,
  DataCapability,
} from "@polpo-ai/core/data-registry";
import { FileDataRegistryStore } from "../stores/file-data-registry-store.js";
import type { DataRegistryChangeEmitter, DataRegistryStore } from "@polpo-ai/core/data-registry";
import { databaseStoresFor } from "../core/storage.js";
import { loadPolpoConfig } from "../core/config.js";
import { classifySql, settingNeedsAdmin, sqlTables, tableAllowed, type ClassifiedSql, type SqlDialect } from "./data-sql.js";

const require = createRequire(import.meta.url);
const MAX_ROWS = 1_000;
/** Longest a single statement may run on a PostgreSQL source. */
const PG_STATEMENT_TIMEOUT_MS = 30_000;
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

/** Bounds of data_transaction. */
export const DATA_TX_LIMITS = {
  /** Default and longest time a statement (and the whole transaction) may run. */
  defaultTimeoutMs: 15_000,
  minTimeoutMs: 100,
  maxTimeoutMs: 60_000,
  maxStatements: 50,
  maxSqlLength: 20_000,
  maxParams: 1_000,
  maxSettings: 20,
  maxSettingValueLength: 1_000,
  /** Rows returned per statement (RETURNING / SELECT); the rest is reported as truncated. */
  maxRowsPerStatement: MAX_ROWS,
  /** Rows returned across the whole transaction. */
  maxRowsTotal: 5_000,
} as const;

export type DataTransactionExpectRows = number | { min?: number; max?: number };

export interface DataTransactionStatement {
  sql: string;
  params?: unknown[];
  expectRows?: DataTransactionExpectRows;
}

export interface DataTransactionInput {
  sourceId: string;
  statements: DataTransactionStatement[];
  /** Applied as SET LOCAL (set_config(key, value, true)) before the first statement. */
  settings?: Record<string, string>;
  readOnly?: boolean;
  timeoutMs?: number;
}

export interface DataTransactionStatementResult {
  index: number;
  /** The statement's command (INSERT, UPDATE, SELECT, ...). */
  command: string;
  /** Rows changed (INSERT/UPDATE/DELETE) or returned (SELECT, RETURNING). */
  rowCount: number;
  /** Returned rows (SELECT, RETURNING), bounded; absent for statements that return none. */
  rows?: Record<string, unknown>[];
  truncated?: boolean;
}

export interface DataTransactionResult {
  sourceId: string;
  status: "committed" | "rolled_back";
  readOnly: boolean;
  durationMs: number;
  statements: DataTransactionStatementResult[];
  /** When rolled back: which statement (0-based) failed and why. */
  failed?: { index: number; reason: "error" | "expect_rows" | "timeout"; message: string };
}

/** A failure inside the transaction that rolls it back (thrown to make the driver roll back). */
class TransactionAbort extends Error {
  constructor(readonly index: number, readonly reason: "error" | "expect_rows" | "timeout", message: string) { super(message); }
}

export class DataRuntime {
  readonly store: DataRegistryStore;

  constructor(
    readonly polpoDir: string,
    private vaultStore?: VaultStore,
    emitChange?: DataRegistryChangeEmitter,
  ) {
    // The database when the project has one, the data.json file otherwise.
    this.store = databaseStoresFor(polpoDir)?.dataRegistryStore ?? new FileDataRegistryStore(polpoDir, emitChange);
    this.store.setEmitter?.(emitChange);
  }

  setVaultStore(store?: VaultStore): void {
    this.vaultStore = store;
  }

  setEmitter(emitChange?: DataRegistryChangeEmitter): void {
    this.store.setEmitter?.(emitChange);
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
      const totalCount = query.includeTotal ? await this.countSource(source, safeQuery) : undefined;
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
          ...(totalCount !== undefined ? { totalCount } : {}),
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
    // a grant limited to some datasets: every table the statement reads must be one of them
    this.requireTables(source, principal, () => sqlTables(sql, source.kind as SqlDialect));
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

  /**
   * Several statements in ONE transaction on one connection (PostgreSQL, SQLite): all commit or
   * none do. Settings apply as SET LOCAL; a failing statement or an expectRows mismatch rolls
   * everything back and says which statement and why. Needs the write grant (read for readOnly);
   * DDL and privileged statements need admin; transaction control and identity switches never run.
   */
  async transaction(input: DataTransactionInput, principal: DataPrincipal): Promise<DataTransactionResult> {
    const started = Date.now();
    const readOnly = input.readOnly === true;
    const source = await this.requireSource(input.sourceId, principal, readOnly ? "read" : "write");
    if (source.kind !== "sqlite" && source.kind !== "postgres") throw new Error(`Transactions are not supported for ${source.kind} sources (only PostgreSQL and SQLite)`);
    const dialect = source.kind as SqlDialect;
    const timeoutMs = input.timeoutMs ?? DATA_TX_LIMITS.defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < DATA_TX_LIMITS.minTimeoutMs || timeoutMs > DATA_TX_LIMITS.maxTimeoutMs) {
      throw new Error(`timeoutMs must be an integer between ${DATA_TX_LIMITS.minTimeoutMs} and ${DATA_TX_LIMITS.maxTimeoutMs}`);
    }
    const statements = input.statements ?? [];
    if (!Array.isArray(statements) || statements.length === 0) throw new Error("A transaction needs at least one statement");
    if (statements.length > DATA_TX_LIMITS.maxStatements) throw new Error(`A transaction may hold at most ${DATA_TX_LIMITS.maxStatements} statements`);
    const isAdmin = this.hasCapability(source, principal, "admin");
    const settings = Object.entries(input.settings ?? {});
    if (settings.length > DATA_TX_LIMITS.maxSettings) throw new Error(`At most ${DATA_TX_LIMITS.maxSettings} settings per transaction`);
    if (settings.length && dialect !== "postgres") throw new Error("Transaction settings (SET LOCAL) are supported only for PostgreSQL sources");
    for (const [key, value] of settings) {
      if (typeof value !== "string") throw new Error(`Setting "${key}" must be a string`);
      if (value.length > DATA_TX_LIMITS.maxSettingValueLength) throw new Error(`Setting "${key}" is longer than ${DATA_TX_LIMITS.maxSettingValueLength} characters`);
      if (settingNeedsAdmin(key) && !isAdmin) throw new Error(`Setting "${key}" is a server setting and needs the admin grant; use a custom namespace.name setting`);
    }
    // Validate every statement before opening the transaction
    const classified: ClassifiedSql[] = statements.map((statement, index) => {
      const where = `Statement ${index + 1}`;
      if (!statement || typeof statement.sql !== "string" || !statement.sql.trim()) throw new Error(`${where}: sql is required`);
      if (statement.sql.length > DATA_TX_LIMITS.maxSqlLength) throw new Error(`${where}: sql is longer than ${DATA_TX_LIMITS.maxSqlLength} characters`);
      if (statement.params !== undefined && !Array.isArray(statement.params)) throw new Error(`${where}: params must be an array`);
      if ((statement.params?.length ?? 0) > DATA_TX_LIMITS.maxParams) throw new Error(`${where}: at most ${DATA_TX_LIMITS.maxParams} params`);
      validateExpectRows(statement.expectRows, where);
      let result: ClassifiedSql;
      try { result = classifySql(statement.sql, dialect); } catch (error) { throw new Error(`${where}: ${errorMessage(error)}`); }
      if (result.kind === "admin" && !isAdmin) throw new Error(`${where}: ${result.command} needs the admin grant on ${source.name} (${result.adminReason ?? "privileged statement"})`);
      if (readOnly && result.kind !== "read") throw new Error(`${where}: a readOnly transaction runs only SELECT, WITH, VALUES, TABLE, EXPLAIN and SHOW`);
      try {
        this.requireTables(source, principal, () => result.tables);
      } catch (error) { throw new Error(`${where}: ${errorMessage(error)}`); }
      return result;
    });
    const blocked = new Set(this.grantFor(source, principal)?.excludedFields ?? []);
    const detail = { statementCount: statements.length, dataset: datasetsLabel(classified) };
    try {
      const result = dialect === "postgres"
        ? await this.withPostgres(source, (sql) => runPostgresTransaction(sql, statements, classified, settings, readOnly, timeoutMs, blocked))
        : await this.withSqlite(source, (db) => runSqliteTransaction(db, statements, classified, readOnly, timeoutMs, blocked), { readonly: readOnly });
      const out: DataTransactionResult = { sourceId: source.id, readOnly, durationMs: Date.now() - started, ...result };
      const rowCount = out.statements.reduce((sum, statement) => sum + statement.rowCount, 0);
      if (out.status === "committed") await this.record(source.id, principal, "transaction", "succeeded", started, { ...detail, rowCount, readOnly });
      else await this.record(source.id, principal, "transaction", "failed", started, { ...detail, readOnly, error: `Rolled back at statement ${out.failed!.index + 1}: ${out.failed!.message}` });
      return out;
    } catch (error) {
      await this.record(source.id, principal, "transaction", "failed", started, { ...detail, readOnly, error: errorMessage(error) });
      throw error;
    }
  }

  /** With a grant limited to some datasets, every named table must be one of them. */
  private requireTables(source: DataSource, principal: DataPrincipal, tables: () => string[]): void {
    const grant = this.grantFor(source, principal);
    if (!grant || grant.datasets.length === 0 || grant.datasets.includes("*")) return;
    const dialect = source.kind as SqlDialect;
    for (const table of tables()) {
      if (!tableAllowed(table, dialect, (dataset) => matchesDataset(grant, dataset))) throw new Error(`Access denied to ${source.name} / ${table}: the data grant does not include it`);
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

  /**
   * Every row the query's filters match, ignoring limit and offset (one row per group when it
   * groups). SQL sources count in the database; files count in memory; a REST API cannot: undefined.
   */
  private async countSource(source: DataSource, query: DataQuery): Promise<number | undefined> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => {
      const compiled = countSql(query, "sqlite");
      return Number((db.prepare(compiled.text).get(...compiled.values) as { total?: number | bigint } | undefined)?.total ?? 0);
    });
    if (source.kind === "postgres") return this.withPostgres(source, async (sql) => {
      const compiled = countSql(query, "postgres");
      const rows = await sql.unsafe(compiled.text, compiled.values) as Array<{ total?: string | number }>;
      return Number(rows[0]?.total ?? 0);
    });
    if (source.kind === "rest") return undefined;
    const text = await readFile(this.resolveLocation(source.config.location), "utf8");
    const rows = source.kind === "csv" ? parseCsv(text) : normalizeRows(JSON.parse(text));
    return rows.filter((row) => (query.filters ?? []).every((filter) => matchFilter(row[filter.field], filter))).length;
  }

  /**
   * Raw SQL, enforced read-only by the database itself (the text check before it is only a
   * first filter): a read-only SQLite handle, a READ ONLY PostgreSQL transaction.
   */
  private async executeRaw(source: DataSource, query: string): Promise<Record<string, unknown>[]> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => db.prepare(query).all() as Record<string, unknown>[], { readonly: true });
    return this.withPostgres(source, async (sql) =>
      (await sql.begin("read only", (tx: any) => tx.unsafe(query))) as unknown as Record<string, unknown>[]);
  }

  private async executeMutation(source: DataSource, mutation: DataMutation): Promise<number> {
    if (source.kind === "sqlite") return this.withSqlite(source, (db) => executeSqliteMutation(db, mutation));
    return this.withPostgres(source, (sql) => executePostgresMutation(sql, mutation));
  }

  /**
   * A file location as agents wrote it: absolute, or relative to the agents' working directory
   * (where they create files), then to the project directory. Never the server's own cwd.
   */
  resolveLocation(location: string): string {
    if (isAbsolute(location)) return location;
    const projectDir = dirname(this.polpoDir);
    const workDir = loadPolpoConfig(this.polpoDir)?.settings?.workDir;
    const agentDir = workDir && workDir !== "." ? resolve(projectDir, workDir) : projectDir;
    const candidates = [resolve(agentDir, location), resolve(projectDir, location)];
    return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
  }

  private async withSqlite<T>(source: DataSource, action: (db: any) => T | Promise<T>, opts?: { readonly?: boolean }): Promise<T> {
    const Database = require("better-sqlite3") as new (path: string, options?: Record<string, unknown>) => any;
    // Never create an empty database by opening a wrong path; raw SQL opens it read-only
    const db = new Database(this.resolveLocation(source.config.location), { fileMustExist: true, readonly: !!opts?.readonly });
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
      // A runaway query is cancelled by the server instead of hanging the agent
      connection: { statement_timeout: PG_STATEMENT_TIMEOUT_MS, application_name: "polpo-data" },
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
    const text = await readFile(this.resolveLocation(source.config.location), "utf8");
    const rows = source.kind === "csv" ? parseCsv(text) : normalizeRows(JSON.parse(text));
    return applyInMemoryQuery(rows, query);
  }

  private async record(
    sourceId: string,
    principal: DataPrincipal,
    action: "test" | "discover" | "query" | "sql" | "mutate" | "transaction",
    status: "succeeded" | "failed",
    started: number,
    detail: { dataset?: string; rowCount?: number; error?: string; statementCount?: number; readOnly?: boolean },
  ): Promise<void> {
    await this.store.addActivity({ sourceId, agent: principal.agent, action, status, durationMs: Date.now() - started, ...detail }).catch(() => undefined);
  }
}

const runtimes = new Map<string, DataRuntime>();

export function getDataRegistryRuntime(polpoDir: string, vaultStore?: VaultStore, emitChange?: DataRegistryChangeEmitter): DataRuntime {
  let runtime = runtimes.get(polpoDir);
  // Rebuilt if the project's database was opened (or closed) after the runtime was created.
  if (runtime && (runtime.store === databaseStoresFor(polpoDir)?.dataRegistryStore) !== !!databaseStoresFor(polpoDir)) runtime = undefined;
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

/** SELECT COUNT(*) of what a query matches (its filters and grouping; never its limit or offset). */
function countSql(query: DataQuery, dialect: "sqlite" | "postgres"): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const param = (value: unknown) => {
    values.push(value);
    return dialect === "postgres" ? `$${values.length}` : "?";
  };
  const where = filterSql(query.filters ?? [], dialect, param);
  const group = query.groupBy ?? [];
  const base = [
    `SELECT ${group.length ? group.map((field) => quoteIdentifier(field, dialect)).join(", ") : "1"} FROM ${tableSql(query.dataset, dialect)}`,
    where ? `WHERE ${where}` : "",
    group.length ? `GROUP BY ${group.map((field) => quoteIdentifier(field, dialect)).join(", ")}` : "",
  ].filter(Boolean).join(" ");
  return { text: `SELECT COUNT(*) AS total FROM (${base}) AS counted`, values };
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
    const quoted = quoteSqliteName(table.name);
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>;
    const isView = table.type === "view";
    const indexes: DataIndex[] = [];
    const foreignKeys: DataForeignKey[] = [];
    let rowCount: number | undefined;
    if (!isView) {
      for (const index of db.prepare(`PRAGMA index_list(${quoted})`).all() as Array<{ name: string; unique: number; origin: string }>) {
        const indexColumns = (db.prepare(`PRAGMA index_info(${quoteSqliteName(index.name)})`).all() as Array<{ name: string | null }>).map((column) => column.name ?? "(expression)");
        indexes.push({ name: index.name, columns: indexColumns, unique: Boolean(index.unique), ...(index.origin === "pk" ? { primary: true } : {}) });
      }
      const keys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{ id: number; table: string; from: string; to: string | null; on_update: string; on_delete: string }>;
      const grouped = new Map<number, DataForeignKey>();
      for (const key of keys) {
        const current = grouped.get(key.id) ?? { columns: [], references: { dataset: key.table, columns: [] }, onUpdate: key.on_update, onDelete: key.on_delete };
        current.columns.push(key.from);
        current.references.columns.push(key.to ?? "(primary key)");
        grouped.set(key.id, current);
      }
      foreignKeys.push(...grouped.values());
      try { rowCount = Number((db.prepare(`SELECT COUNT(*) AS total FROM ${quoted}`).get() as { total: number }).total); } catch { /* unreadable table: no count */ }
    }
    return {
      id: `${source.id}:${table.name}`,
      sourceId: source.id,
      name: table.name,
      kind: isView ? "view" : "table",
      columns: columns.map((column) => ({
        name: column.name, type: sqlType(column.type), nullable: !column.notnull, primaryKey: Boolean(column.pk),
        ...(column.type ? { nativeType: column.type } : {}), defaultValue: column.dflt_value,
      })),
      ...(rowCount !== undefined ? { rowCount } : {}),
      ...(!isView ? { indexes, foreignKeys } : {}),
    } satisfies DataDataset;
  });
}

/** A SQLite name in a PRAGMA or FROM (any name the database holds, quotes doubled). */
function quoteSqliteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function discoverPostgres(sql: any, source: DataSource): Promise<DataDataset[]> {
  const rows = await sql`
    SELECT table_schema, table_name, table_type, column_name, data_type, udt_name, character_maximum_length, column_default, is_nullable, ordinal_position
    FROM information_schema.columns
    JOIN information_schema.tables USING (table_schema, table_name)
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  ` as Array<Record<string, string | number | null>>;
  // Keys, indexes, relations and row estimates from the catalog: best effort (a role may not see them)
  const primaryKeys = await sql`
    SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  `.catch(() => []) as Array<{ table_schema: string; table_name: string; column_name: string }>;
  const indexes = await sql`
    SELECT n.nspname AS table_schema, t.relname AS table_name, ic.relname AS index_name, i.indisunique AS is_unique, i.indisprimary AS is_primary,
      array_agg(a.attname ORDER BY k.ord) AS columns
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    GROUP BY n.nspname, t.relname, ic.relname, i.indisunique, i.indisprimary
    ORDER BY ic.relname
  `.catch(() => []) as Array<{ table_schema: string; table_name: string; index_name: string; is_unique: boolean; is_primary: boolean; columns: Array<string | null> }>;
  const foreignKeys = await sql`
    SELECT con.conname AS name, n.nspname AS table_schema, c.relname AS table_name, fn.nspname AS ref_schema, fc.relname AS ref_table,
      con.confupdtype AS on_update, con.confdeltype AS on_delete,
      array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
      array(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class fc ON fc.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE con.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  `.catch(() => []) as Array<{ name: string; table_schema: string; table_name: string; ref_schema: string; ref_table: string; on_update: string; on_delete: string; columns: string[]; ref_columns: string[] }>;
  const estimates = await sql`
    SELECT n.nspname AS table_schema, c.relname AS table_name, c.reltuples::bigint AS estimate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  `.catch(() => []) as Array<{ table_schema: string; table_name: string; estimate: string | number }>;

  const key = (schema: string, table: string) => `${schema}.${table}`;
  const pkColumns = new Set(primaryKeys.map((row) => `${key(row.table_schema, row.table_name)}.${row.column_name}`));
  const grouped = new Map<string, DataDataset>();
  for (const row of rows) {
    const name = key(String(row.table_schema), String(row.table_name));
    const dataset = grouped.get(name) ?? {
      id: `${source.id}:${name}`, sourceId: source.id, namespace: String(row.table_schema), name,
      kind: row.table_type === "VIEW" ? "view" : "table", columns: [],
    } satisfies DataDataset;
    const native = row.data_type === "USER-DEFINED" || row.data_type === "ARRAY" ? String(row.udt_name ?? row.data_type) : String(row.data_type);
    dataset.columns.push({
      name: String(row.column_name), type: sqlType(native), nullable: row.is_nullable === "YES",
      ...(pkColumns.has(`${name}.${row.column_name}`) ? { primaryKey: true } : {}),
      nativeType: row.character_maximum_length ? `${native}(${row.character_maximum_length})` : native,
      defaultValue: row.column_default == null ? null : String(row.column_default),
    });
    grouped.set(name, dataset);
  }
  for (const index of indexes) {
    const dataset = grouped.get(key(index.table_schema, index.table_name));
    if (!dataset) continue;
    (dataset.indexes ??= []).push({ name: index.index_name, columns: index.columns.map((column) => column ?? "(expression)"), unique: index.is_unique, ...(index.is_primary ? { primary: true } : {}) });
  }
  const action: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  for (const fk of foreignKeys) {
    const dataset = grouped.get(key(fk.table_schema, fk.table_name));
    if (!dataset) continue;
    (dataset.foreignKeys ??= []).push({
      name: fk.name, columns: fk.columns, references: { dataset: key(fk.ref_schema, fk.ref_table), columns: fk.ref_columns },
      onUpdate: action[fk.on_update] ?? fk.on_update, onDelete: action[fk.on_delete] ?? fk.on_delete,
    });
  }
  for (const estimate of estimates) {
    const dataset = grouped.get(key(estimate.table_schema, estimate.table_name));
    // -1 (never analyzed) is no estimate
    if (dataset && Number(estimate.estimate) >= 0) dataset.rowCount = Number(estimate.estimate);
  }
  for (const dataset of grouped.values()) {
    if (dataset.kind === "table") { dataset.indexes ??= []; dataset.foreignKeys ??= []; }
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

function validateExpectRows(expect: DataTransactionExpectRows | undefined, where: string): void {
  if (expect === undefined) return;
  const valid = (value: unknown) => value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
  if (typeof expect === "number") { if (!valid(expect)) throw new Error(`${where}: expectRows must be a non-negative integer`); return; }
  if (!expect || typeof expect !== "object" || Array.isArray(expect) || !valid(expect.min) || !valid(expect.max)) {
    throw new Error(`${where}: expectRows must be a number or { min?, max? } with non-negative integers`);
  }
  if (expect.min !== undefined && expect.max !== undefined && expect.min > expect.max) throw new Error(`${where}: expectRows.min is greater than expectRows.max`);
}

/** Why a row count does not meet expectRows, or undefined when it does. */
function expectRowsMismatch(expect: DataTransactionExpectRows | undefined, rowCount: number): string | undefined {
  if (expect === undefined) return undefined;
  if (typeof expect === "number") return rowCount === expect ? undefined : `expected exactly ${expect} row(s), got ${rowCount}`;
  if (expect.min !== undefined && rowCount < expect.min) return `expected at least ${expect.min} row(s), got ${rowCount}`;
  if (expect.max !== undefined && rowCount > expect.max) return `expected at most ${expect.max} row(s), got ${rowCount}`;
  return undefined;
}

/** The tables a transaction touches, for the activity log (never values). */
function datasetsLabel(classified: ClassifiedSql[]): string | undefined {
  const tables = [...new Set(classified.flatMap((item) => item.tables))];
  if (!tables.length) return undefined;
  return tables.slice(0, 8).join(", ") + (tables.length > 8 ? `, +${tables.length - 8}` : "");
}

function stripFields(rows: Record<string, unknown>[], blocked: Set<string>): Record<string, unknown>[] {
  if (!blocked.size) return rows;
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !blocked.has(key))));
}

/** Bounded rows for the result: per statement and across the transaction. */
function boundRows(rows: Record<string, unknown>[], budget: { left: number }, blocked: Set<string>): { rows: Record<string, unknown>[]; truncated: boolean } {
  const take = Math.max(0, Math.min(DATA_TX_LIMITS.maxRowsPerStatement, budget.left));
  budget.left -= Math.min(rows.length, take);
  return { rows: stripFields(rows.slice(0, take), blocked), truncated: rows.length > take };
}

type TxOutcome = Pick<DataTransactionResult, "status" | "statements" | "failed">;

async function runPostgresTransaction(
  sql: any,
  statements: DataTransactionStatement[],
  classified: ClassifiedSql[],
  settings: Array<[string, string]>,
  readOnly: boolean,
  timeoutMs: number,
  blocked: Set<string>,
): Promise<TxOutcome> {
  const results: DataTransactionStatementResult[] = [];
  const deadline = Date.now() + timeoutMs;
  const budget = { left: DATA_TX_LIMITS.maxRowsTotal };
  let index = -1;
  // Belt and braces: if the server does not cancel (statement_timeout) in time, drop the connection;
  // the server then rolls the transaction back.
  let killed = false;
  const hardStop = setTimeout(() => { killed = true; void Promise.resolve(sql.end({ timeout: 0 })).catch(() => undefined); }, timeoutMs * 2 + 2_000);
  const killedAbort = () => new TransactionAbort(Math.max(0, Math.min(index, statements.length - 1)), "timeout", `the transaction ran longer than ${timeoutMs} ms and its connection was closed`);
  try {
    await sql.begin(readOnly ? "read only" : "read write", async (tx: any) => {
      // Settings first, then Polpo's own bounds (so a setting can never lift them)
      for (const [key, value] of settings) await tx.unsafe("SELECT set_config($1, $2, true)", [key, value]);
      await tx.unsafe("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [`${timeoutMs}ms`, `${timeoutMs * 2}ms`]);
      for (index = 0; index < statements.length; index++) {
        if (Date.now() > deadline) throw new TransactionAbort(index, "timeout", `the transaction ran longer than ${timeoutMs} ms`);
        const statement = statements[index]!;
        let result: any;
        try {
          result = await tx.unsafe(statement.sql, (statement.params ?? []).map(toPostgresParam));
        } catch (error) {
          if (killed) throw killedAbort();
          const message = errorMessage(error);
          const timedOut = /statement timeout|lock timeout/i.test(message);
          throw new TransactionAbort(index, timedOut ? "timeout" : "error", message);
        }
        const rows = Array.isArray(result) ? result as Record<string, unknown>[] : [];
        const returnsRows = Array.isArray(result?.columns) && result.columns.length > 0;
        const command = String(result?.command ?? classified[index]!.command).toUpperCase();
        const rowCount = Number(result?.count ?? rows.length ?? 0);
        const mismatch = expectRowsMismatch(statement.expectRows, rowCount);
        if (mismatch) throw new TransactionAbort(index, "expect_rows", mismatch);
        results.push({ index, command, rowCount, ...(returnsRows ? boundRows(rows, budget, blocked) : {}) });
      }
    });
    return { status: "committed", statements: results };
  } catch (caught) {
    const error = killed ? killedAbort() : caught;
    if (error instanceof TransactionAbort) {
      return { status: "rolled_back", statements: results, failed: { index: error.index, reason: error.reason, message: error.message } };
    }
    // Setting a value or BEGIN failed before any statement, or COMMIT itself failed (deferred constraints)
    const at = Math.max(0, Math.min(index, statements.length - 1));
    if (index >= 0) return { status: "rolled_back", statements: results, failed: { index: at, reason: "error", message: errorMessage(error) } };
    throw error;
  } finally {
    clearTimeout(hardStop);
  }
}

function toPostgresParam(value: unknown): unknown {
  // objects and arrays travel as JSON text (cast in SQL: $1::jsonb)
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value;
}

function toSqliteParam(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value === undefined ? null : value;
}

function runSqliteTransaction(
  db: any,
  statements: DataTransactionStatement[],
  classified: ClassifiedSql[],
  readOnly: boolean,
  timeoutMs: number,
  blocked: Set<string>,
): TxOutcome {
  // SQLite cannot cancel a running statement: the timeout bounds lock waits and the transaction between statements
  db.pragma(`busy_timeout = ${Math.floor(timeoutMs)}`);
  const results: DataTransactionStatementResult[] = [];
  const deadline = Date.now() + timeoutMs;
  const budget = { left: DATA_TX_LIMITS.maxRowsTotal };
  const run = db.transaction(() => {
    for (let index = 0; index < statements.length; index++) {
      if (Date.now() > deadline) throw new TransactionAbort(index, "timeout", `the transaction ran longer than ${timeoutMs} ms`);
      const statement = statements[index]!;
      const command = classified[index]!.command;
      let rowCount: number;
      let rows: Record<string, unknown>[] | undefined;
      try {
        const prepared = db.prepare(statement.sql);
        const params = (statement.params ?? []).map(toSqliteParam);
        if (prepared.reader) {
          rows = prepared.all(...params) as Record<string, unknown>[];
          rowCount = rows.length;
        } else {
          rowCount = Number(prepared.run(...params).changes ?? 0);
        }
      } catch (error) {
        throw new TransactionAbort(index, /busy|locked/i.test(errorMessage(error)) ? "timeout" : "error", errorMessage(error));
      }
      const mismatch = expectRowsMismatch(statement.expectRows, rowCount);
      if (mismatch) throw new TransactionAbort(index, "expect_rows", mismatch);
      results.push({ index, command, rowCount, ...(rows ? boundRows(rows, budget, blocked) : {}) });
    }
  });
  try {
    // a read-only handle refuses writes; BEGIN DEFERRED there is fine, IMMEDIATE takes the write lock up front
    if (readOnly) run.deferred(); else run.immediate();
    return { status: "committed", statements: results };
  } catch (error) {
    if (error instanceof TransactionAbort) return { status: "rolled_back", statements: results, failed: { index: error.index, reason: error.reason, message: error.message } };
    throw error;
  }
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
