/**
 * The Data area as direct tools: data sources (read, create, change, test, delete, who may use
 * them), their schema and activity, queries, read-only SQL, row changes, transactions, and data views.
 *
 * Connection secrets (a database password, a REST API's Authorization header) never pass through
 * MCP: a source that needs one returns the hand-off (setup_url on the Data page, setup_id
 * data:<source>:<field>, next_step), and polpo_setup_wait waits for it. Locations are returned with
 * any password or token in them masked, and a location that carries one is refused.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, WRITE, apiError, apiGet, apiSend, clip, confirmParam, cursorParam, dashboardLink, enc, fail, limitParam,
  looseObject, ok, page, pageOutput, qs, short,
  type McpDeps, type Register, type Unwrapped,
} from "./kit.js";
import { setupHandoff, type SetupHandoff } from "./setup.js";

/** Most rows a read returns in structuredContent (and as text); the rest is left out with a note. */
export const MAX_DATA_ROWS = 1000;
/** Rows kept until their JSON is this long; the rest is left out with a note. */
export const MAX_DATA_CHARS = 200_000;
/** Most datasets polpo_data_source_get lists with their columns. */
const MAX_SCHEMA_DATASETS = 200;

const KINDS = ["sqlite", "postgres", "rest", "json", "csv"] as const;
const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "in", "isNull"] as const;
const SECRET_PARAM = /^(password|passwd|pwd|pass|secret|token|access[_-]?token|api[_-]?key|apikey|key|auth|authorization|signature|sig|client[_-]?secret)$/i;

interface Grant { id?: string; agent: string; capabilities: string[]; datasets?: string[]; excludedFields?: string[] }
interface Source {
  id: string; name: string; slug: string; description?: string; kind: string; environment: string;
  config: { location: string; port?: number; database?: string; username?: string; ssl?: boolean; defaultDataset?: string };
  tags: string[]; grants: Grant[]; createdAt?: string; updatedAt?: string; credentialKeys?: string[];
}
interface View {
  id: string; name: string; description?: string; persistence: string; sessionId?: string; createdBy?: string; refreshSeconds?: number;
  bindings: Array<{ id: string; query?: { sourceId?: string; dataset?: string }; sql?: { sourceId?: string; statement?: string }; inline?: { rows?: unknown[] } }>;
  widgets: Array<Record<string, unknown>>; createdAt?: string; updatedAt?: string;
}
interface Frame { columns: Array<Record<string, unknown>>; rows: Array<Record<string, unknown>>; meta?: Record<string, unknown> }

// ── Secrets in locations ─────────────────────────────────────────────

/** A location (path, URL, host, DSN) with any password or token in it replaced by ***. */
export function maskLocation(location: string): string {
  let out = location;
  try {
    const url = new URL(location);
    let changed = false;
    if (url.password) { url.password = "***"; changed = true; }
    for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) { url.searchParams.set(key, "***"); changed = true; }
    if (changed) out = url.toString().replace(/%2A%2A%2A/g, "***");
  } catch { /* not a URL */ }
  return maskSecretsInText(out);
}

/** Free text (errors, DSNs) with passwords in URLs and key=value pairs masked. */
export function maskSecretsInText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi, "$1***@")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token)(\s*[=:]\s*)(?!\*\*\*)[^\s&;,'"]+/gi, "$1$2***");
}

/** Does a location carry a secret (a URL password, a token parameter, password=…)? */
export function locationHasSecret(location: string): boolean {
  try {
    const url = new URL(location);
    if (url.password) return true;
    if ([...url.searchParams.keys()].some((k) => SECRET_PARAM.test(k))) return true;
  } catch { /* not a URL */ }
  return /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token)\s*=/i.test(location);
}

/** A source as returned to the client: location masked, credentials as field names only. */
function publicSource(deps: McpDeps, s: Source): Record<string, unknown> {
  const { credentialKeys, ...rest } = s;
  return {
    ...rest,
    config: { ...s.config, location: maskLocation(s.config.location) },
    credentials: { stored: credentialKeys ?? [] },
    url: dashboardLink(deps, `/data?${new URLSearchParams({ tab: "sources", source: s.id })}`),
  };
}

/** The secret a source needs (postgres: password; rest: the Authorization header, when asked for). */
function secretField(kind: string, requiresAuth?: boolean): { field: string; what: string } | null {
  if (kind === "postgres") return { field: "password", what: "database password" };
  if (kind === "rest" && requiresAuth) return { field: "authorization", what: "Authorization header value (e.g. Bearer …)" };
  return null;
}

/** The hand-off when the source's secret is not stored yet. */
function missingSecret(deps: McpDeps, s: Source, requiresAuth?: boolean): SetupHandoff | null {
  const need = secretField(s.kind, requiresAuth ?? (s.kind === "rest" ? (s.credentialKeys ?? []).length > 0 : undefined));
  if (!need || (s.credentialKeys ?? []).includes(need.field)) return null;
  return setupHandoff(deps, { kind: "data", item: s.id, field: need.field }, `${need.what} for ${s.name}`);
}

/** A source by id, slug or name. */
async function findSource(deps: McpDeps, ref: string): Promise<{ ok: true; source: Source } | { ok: false; result: ReturnType<typeof fail> }> {
  const direct = await apiGet(deps, `/data/${enc(ref)}`);
  if (direct.ok) return { ok: true, source: direct.data as Source };
  if (direct.status !== 404) return { ok: false, result: apiError(direct, `Reading data source ${ref}`) };
  const list = await apiGet(deps, "/data");
  if (!list.ok) return { ok: false, result: apiError(list, "Listing data sources") };
  const sources = (list.data as Source[]) ?? [];
  const match = sources.find((s) => s.slug === ref) ?? sources.find((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (!match) return { ok: false, result: fail(`There is no data source "${ref}". Sources: ${sources.map((s) => `${s.id} (${s.name})`).join(", ") || "none"}.`) };
  const full = await apiGet(deps, `/data/${enc(match.id)}`);
  return full.ok ? { ok: true, source: full.data as Source } : { ok: false, result: apiError(full, `Reading data source ${ref}`) };
}

/** Rows kept within MAX_DATA_ROWS / max and MAX_DATA_CHARS. */
function capRows(rows: Array<Record<string, unknown>>, max: number): { rows: Array<Record<string, unknown>>; cut: boolean } {
  const out: Array<Record<string, unknown>> = [];
  let size = 2;
  for (const row of rows) {
    if (out.length >= max) return { rows: out, cut: true };
    size += JSON.stringify(row).length + 1;
    if (size > MAX_DATA_CHARS && out.length > 0) return { rows: out, cut: true };
    out.push(row);
  }
  return { rows: out, cut: false };
}

const frameOutput = {
  columns: z.array(looseObject).describe("Column names and types"),
  rows: z.array(looseObject),
  row_count: z.number().int().describe("Rows returned here"),
  truncated: z.boolean().describe("More rows exist than returned: narrow the query or lower the size"),
  note: z.string().optional(),
  meta: looseObject.optional(),
};

function frameResult(frame: Frame, max: number, label: string) {
  const { rows, cut } = capRows(frame.rows ?? [], max);
  const truncated = cut || !!frame.meta?.truncated;
  const note = truncated ? `Showing ${rows.length} rows; there are more (${cut ? "cut to fit" : "the source has more"}): add filters or a smaller limit.` : undefined;
  return ok(`${label}: ${rows.length} rows${truncated ? " (truncated)" : ""}.\n${clip(rows)}`, {
    columns: frame.columns ?? [], rows, row_count: rows.length, truncated, ...(note ? { note } : {}), ...(frame.meta ? { meta: frame.meta } : {}),
  });
}

const filterInput = z.array(z.object({
  field: z.string().min(1).describe("Field name"),
  operator: z.enum(OPERATORS).describe("Comparison"),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]).optional()
    .describe("Value (an array for in; omit for isNull)"),
}));

const grantInput = z.object({
  agent: z.string().min(1).describe("The agent's name"),
  capabilities: z.array(z.enum(["read", "write", "admin"])).min(1).describe("read (queries), write (row changes), admin"),
  datasets: z.array(z.string().min(1)).optional().describe("Datasets it may use (names or prefixes like sales.*; default all: *)"),
  excluded_fields: z.array(z.string().min(1)).optional().describe("Fields it never sees"),
});

const sourceOutput = z.object({ id: z.string(), name: z.string(), kind: z.string() }).passthrough();

function viewSummary(deps: McpDeps, v: View) {
  const sources = [...new Set(v.bindings.map((b) => b.query?.sourceId ?? b.sql?.sourceId).filter((x): x is string => !!x))];
  return {
    id: v.id, name: v.name, ...(v.description ? { description: v.description } : {}), persistence: v.persistence,
    widgets: v.widgets.length, bindings: v.bindings.length, sources, ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}),
    url: dashboardLink(deps, `/views?view=${enc(v.id)}`),
  };
}

const viewItem = z.object({ id: z.string(), name: z.string(), persistence: z.string(), widgets: z.number(), bindings: z.number(), url: z.string() }).passthrough();

export function registerDataTools(tool: Register, deps: McpDeps): void {
  tool("data", "polpo_data_sources_list", {
    title: "List data sources",
    description: "The structured data sources (databases, APIs, files) the instance can query, with their ids for polpo_data_query.",
    inputSchema: {},
    outputSchema: { items: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), description: z.string().optional() }).passthrough()) },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/data");
    if (!r.ok) return apiError(r, "Listing data sources");
    const sources = ((r.data as Source[]) ?? [])
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind, ...(s.description ? { description: s.description } : {}), ...(s.environment ? { environment: s.environment } : {}), agents: [...new Set((s.grants ?? []).map((g) => g.agent))] }));
    return ok(sources.map((s) => `- ${s.id} ${s.name} (${s.kind})${s.description ? `: ${s.description}` : ""}`).join("\n") || "No data sources.", { items: sources });
  });

  tool("data", "polpo_data_query", {
    title: "Query data",
    description: "Read rows from a data source's dataset: choose fields, filter, sort, limit and page (offset; includeTotal counts every matching row "
      + "as meta.totalCount). polpo_data_sources_list gives the source ids; an invalid dataset or field name returns the valid ones.",
    inputSchema: {
      sourceId: z.string().min(1).describe("The data source's id"),
      dataset: z.string().min(1).describe("The dataset (table, collection, sheet…)"),
      fields: z.array(z.string()).optional().describe("Fields to return (default all)"),
      filters: z.array(z.object({
        field: z.string().describe("Field name"),
        operator: z.enum(OPERATORS).describe("Comparison"),
        value: z.unknown().optional().describe("Value (an array for in; omit for isNull)"),
      })).optional().describe("All must match"),
      sort: z.array(z.object({ field: z.string().describe("Field name"), direction: z.enum(["asc", "desc"]).describe("asc or desc") })).optional().describe("Order"),
      limit: z.number().int().min(1).max(1000).optional().describe("Most rows (default the source's, max 1000)"),
      offset: z.number().int().min(0).optional().describe("Rows to skip first (paging)"),
      includeTotal: z.boolean().optional().describe("Also count every row the filters match (meta.totalCount; not for REST sources)"),
    },
    outputSchema: { result: z.unknown() },
    annotations: READ,
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/data/query", args);
    if (!r.ok) return apiError(r, "The query");
    return ok(clip(r.data), { result: r.data });
  });

  tool("data", "polpo_data_source_get", {
    title: "Get a data source",
    description: "One data source: its connection settings (any password or token in the location masked), which credentials are stored "
      + "(field names, never values), which agents may use it (grants), and its schema: datasets with their columns (types, primary keys, defaults), "
      + "row counts and, for SQL sources, indexes and foreign keys. "
      + "When a secret is missing it returns setup_url for the person.",
    inputSchema: {
      id: z.string().min(1).describe("The source's id, slug or name"),
      schema: z.boolean().optional().describe("Include the datasets and columns (default true; it connects to the source)"),
      schema_limit: z.number().int().min(1).max(MAX_SCHEMA_DATASETS).optional().describe(`Most datasets to list (default 50, max ${MAX_SCHEMA_DATASETS})`),
    },
    outputSchema: {
      source: sourceOutput,
      schema: z.object({ datasets: z.array(looseObject), total: z.number().int(), truncated: z.boolean() }).passthrough().optional(),
      schema_error: z.string().optional(),
      setup_url: z.string().optional(), setup_id: z.string().optional(), next_step: z.string().optional(),
    },
    annotations: { ...READ, openWorldHint: true },
  }, async ({ id, schema, schema_limit }) => {
    const found = await findSource(deps, id);
    if (!found.ok) return found.result;
    const s = found.source;
    const out: Record<string, unknown> = { source: publicSource(deps, s) };
    const lines = [`${s.name} (${s.id}, ${s.kind}, ${s.environment}): ${maskLocation(s.config.location)}`,
      `Agents: ${s.grants.map((g) => `${g.agent} [${g.capabilities.join(", ")}]${g.datasets?.length && !g.datasets.includes("*") ? ` on ${g.datasets.join(", ")}` : ""}`).join("; ") || "none (only Polpo)"}`];
    if (schema !== false) {
      const r = await apiGet(deps, `/data/${enc(s.id)}/schema`);
      if (r.ok) {
        const all = (r.data as Array<{ name: string; columns?: Array<{ name: string; type?: string }> }>) ?? [];
        const max = schema_limit ?? 50;
        out.schema = { datasets: all.slice(0, max), total: all.length, truncated: all.length > max };
        lines.push(`Datasets (${all.length}${all.length > max ? `, first ${max}` : ""}):`, ...all.slice(0, max).map((d) => `- ${d.name}: ${(d.columns ?? []).map((c) => `${c.name}${c.type ? ` ${c.type}` : ""}`).join(", ")}`));
      } else {
        out.schema_error = maskSecretsInText(r.error);
        lines.push(`Schema unavailable: ${maskSecretsInText(r.error)}`);
      }
    }
    const handoff = missingSecret(deps, s);
    if (handoff) { Object.assign(out, handoff); lines.push(handoff.next_step); }
    return ok(lines.join("\n"), out);
  });

  tool("data", "polpo_data_source_save", {
    title: "Create or change a data source",
    description: "Connect a data source (PostgreSQL, SQLite, REST API, JSON or CSV file) or change one (pass id; only the fields given change). "
      + "grants decide which agents may use it (they replace the list). Secrets never go here: a password or token in the location is refused; "
      + "the result returns setup_url, setup_id and next_step for the person to enter it on the Data page — show the link, call polpo_setup_wait, "
      + "then polpo_data_source_test.",
    inputSchema: {
      id: z.string().min(1).optional().describe("The source to change (id, slug or name); omit to create one"),
      name: z.string().trim().min(1).optional().describe("Its name (required to create)"),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional().describe("Short id (lowercase, dashes); default from the name"),
      description: z.string().optional().describe("What it contains"),
      kind: z.enum(KINDS).optional().describe("sqlite, postgres, rest, json or csv (required to create)"),
      environment: z.enum(["development", "staging", "production"]).optional().describe("Default development"),
      location: z.string().trim().min(1).optional().describe("PostgreSQL host, REST base URL, or file path (required to create); never with a password or token"),
      port: z.number().int().min(1).max(65535).optional().describe("PostgreSQL port (default 5432)"),
      database: z.string().optional().describe("PostgreSQL database"),
      username: z.string().optional().describe("PostgreSQL user (the password is entered by the person at setup_url)"),
      ssl: z.boolean().optional().describe("PostgreSQL over TLS"),
      default_dataset: z.string().optional().describe("REST default endpoint (e.g. /customers) or a file's dataset label"),
      requires_auth: z.boolean().optional().describe("REST: the API needs an Authorization header (the person enters it at setup_url)"),
      tags: z.array(z.string()).optional().describe("Categories (replace the list)"),
      grants: z.array(grantInput).optional().describe("Which agents may use it and how (replace the list; [] leaves it to Polpo only)"),
    },
    outputSchema: {
      source: sourceOutput, created: z.boolean(),
      setup_url: z.string().optional(), setup_id: z.string().optional(), next_step: z.string().optional(),
    },
    annotations: { ...WRITE, openWorldHint: false },
    scope: "polpo:admin",
  }, async (args) => {
    if (args.location && locationHasSecret(args.location)) {
      return fail("The location carries a password or token: secrets never go through MCP. Save the location without it; the person enters the secret on the Data page (setup_url in the result).");
    }
    let current: Source | undefined;
    if (args.id) {
      const found = await findSource(deps, args.id);
      if (!found.ok) return found.result;
      current = found.source;
    } else {
      const missing = (["name", "kind", "location"] as const).filter((k) => !args[k]);
      if (missing.length) return fail(`To create a data source give ${missing.join(", ")} (or id to change one: polpo_data_sources_list).`);
    }
    const kind = args.kind ?? current!.kind;
    const name = args.name ?? current!.name;
    const config = {
      ...(current?.config ?? {}),
      ...(args.location !== undefined ? { location: args.location } : {}),
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.database !== undefined ? { database: args.database } : {}),
      ...(args.username !== undefined ? { username: args.username } : {}),
      ...(args.ssl !== undefined ? { ssl: args.ssl } : {}),
      ...(args.default_dataset !== undefined ? { defaultDataset: args.default_dataset } : {}),
    } as Source["config"];
    if (kind === "postgres" && config.port === undefined) config.port = 5432;
    const body = {
      name,
      slug: args.slug ?? current?.slug ?? slugify(name),
      ...(args.description !== undefined ? { description: args.description } : current?.description ? { description: current.description } : {}),
      kind,
      environment: args.environment ?? current?.environment ?? "development",
      config,
      tags: args.tags ?? current?.tags ?? [],
      grants: args.grants
        ? args.grants.map((g) => {
          const prev = current?.grants.find((x) => x.agent === g.agent);
          return { ...(prev?.id ? { id: prev.id } : {}), agent: g.agent, capabilities: g.capabilities, datasets: g.datasets ?? ["*"], ...(g.excluded_fields ? { excludedFields: g.excluded_fields } : {}) };
        })
        : current?.grants ?? [],
    };
    const r: Unwrapped = current ? await apiSend(deps, "PUT", `/data/${enc(current.id)}`, body) : await apiSend(deps, "POST", "/data", body);
    if (!r.ok) return apiError(r, current ? `Changing ${current.name}` : "Creating the data source");
    const savedId = (r.data as Source).id;
    const reread = await apiGet(deps, `/data/${enc(savedId)}`);
    const saved = (reread.ok ? reread.data : r.data) as Source;
    const handoff = missingSecret(deps, saved, args.requires_auth);
    const verb = current ? "Changed" : "Created";
    return ok(`${verb} data source ${saved.name} (${saved.id}).${handoff ? ` ${handoff.next_step}` : " Check it with polpo_data_source_test."}`,
      { source: publicSource(deps, saved), created: !current, ...(handoff ?? {}) });
  });

  tool("data", "polpo_data_source_test", {
    title: "Test a data source",
    description: "Connect to a data source and count its datasets: says whether it works and how fast. On failure, says what to fix "
      + "(a missing password comes with setup_url).",
    inputSchema: { id: z.string().min(1).describe("The source's id, slug or name") },
    outputSchema: { id: z.string(), ok: z.boolean(), latency_ms: z.number().optional(), datasets: z.number().optional(), error: z.string().optional(),
      setup_url: z.string().optional(), setup_id: z.string().optional(), next_step: z.string().optional() },
    annotations: { ...READ, openWorldHint: true },
  }, async ({ id }) => {
    const found = await findSource(deps, id);
    if (!found.ok) return found.result;
    const s = found.source;
    const r = await apiSend(deps, "POST", `/data/${enc(s.id)}/test`);
    if (r.ok) {
      const d = r.data as { latencyMs?: number; datasets?: number };
      return ok(`${s.name} works: ${d.datasets ?? 0} datasets, ${d.latencyMs ?? "?"} ms.`, { id: s.id, ok: true, latency_ms: d.latencyMs, datasets: d.datasets });
    }
    const error = maskSecretsInText(r.error);
    const handoff = missingSecret(deps, s);
    return { ...ok(`${s.name} does not work: ${error}.${handoff ? ` ${handoff.next_step}` : " Check its settings with polpo_data_source_get and fix them with polpo_data_source_save."}`,
      { id: s.id, ok: false, error, ...(handoff ?? {}) }), isError: true };
  });

  tool("data", "polpo_data_source_delete", {
    title: "Delete a data source",
    description: "Remove a data source and its stored credentials; agents lose access and views that read it stop working (the data itself "
      + "stays where it is). Needs confirm: true; without it, says what would break.",
    inputSchema: { id: z.string().min(1).describe("The source's id, slug or name"), confirm: confirmParam("delete the data source") },
    outputSchema: { id: z.string(), deleted: z.boolean(), affected_views: z.array(z.string()) },
    annotations: DESTRUCTIVE,
    scope: "polpo:admin",
  }, async ({ id, confirm }) => {
    const found = await findSource(deps, id);
    if (!found.ok) return found.result;
    const s = found.source;
    const views = await apiGet(deps, "/views");
    const affected = views.ok ? ((views.data as View[]) ?? []).filter((v) => v.bindings.some((b) => b.query?.sourceId === s.id)).map((v) => `${v.name} (${v.id})`) : [];
    if (confirm !== true) {
      return fail(`Deleting ${s.name} (${s.id}) removes its connection and stored credentials${s.grants.length ? `, ${s.grants.length} agent grant(s)` : ""}`
        + `${affected.length ? ` and breaks ${affected.length} view(s): ${affected.join(", ")}` : ""}. Ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "DELETE", `/data/${enc(s.id)}`);
    if (!r.ok) return apiError(r, `Deleting ${s.name}`);
    return ok(`Deleted data source ${s.name}.${affected.length ? ` These views no longer load: ${affected.join(", ")}.` : ""}`, { id: s.id, deleted: true, affected_views: affected });
  });

  tool("data", "polpo_data_activity", {
    title: "Data source activity",
    description: "Recent use of a data source, newest first: tests, schema reads, queries, SQL and row changes, by whom (an agent or Polpo), "
      + "with rows, duration and errors.",
    inputSchema: { sourceId: z.string().min(1).describe("The source's id, slug or name"), limit: limitParam(20, 100), cursor: cursorParam() },
    outputSchema: pageOutput(looseObject),
    annotations: READ,
  }, async ({ sourceId, limit, cursor }) => {
    const found = await findSource(deps, sourceId);
    if (!found.ok) return found.result;
    const r = await apiGet(deps, `/data/${enc(found.source.id)}/activity${qs({ limit: 500 })}`);
    if (!r.ok) return apiError(r, "Reading the activity");
    const all = ((r.data as Array<Record<string, unknown>>) ?? []).map((a) => typeof a.error === "string" ? { ...a, error: maskSecretsInText(a.error) } : a);
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = p.items.map((a) => `- ${String(a.createdAt ?? "").slice(0, 19).replace("T", " ")} ${a.action} ${a.status}${a.agent ? ` by ${a.agent}` : ""}`
      + `${a.dataset ? ` on ${a.dataset}` : ""}${a.rowCount !== undefined ? `, ${a.rowCount} rows` : ""}${a.error ? `: ${short(a.error, 160)}` : ""}`);
    return ok(`${lines.join("\n") || "No activity yet."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("data", "polpo_data_sql", {
    title: "Run read-only SQL",
    description: "Run one read-only SQL statement (SELECT, WITH or EXPLAIN) on a PostgreSQL or SQLite source and get the rows. "
      + "Statements that change data are refused: use polpo_data_mutate for inserts, updates and deletes (schema changes such as DROP are not possible here).",
    inputSchema: {
      sourceId: z.string().min(1).describe("The source's id, slug or name"),
      sql: z.string().min(1).max(20_000).describe("One SELECT, WITH or EXPLAIN statement"),
      max_rows: z.number().int().min(1).max(MAX_DATA_ROWS).optional().describe(`Most rows to return (default 200, max ${MAX_DATA_ROWS})`),
    },
    outputSchema: frameOutput,
    annotations: { ...READ, openWorldHint: true },
  }, async ({ sourceId, sql, max_rows }) => {
    const stripped = sql.replace(/^\s*(--[^\n]*\n\s*)*/g, "").trim();
    if (!/^(select|with|explain)\b/i.test(stripped)) {
      return fail("polpo_data_sql only reads (SELECT, WITH, EXPLAIN). To insert, update or delete rows use polpo_data_mutate; schema changes (CREATE, ALTER, DROP, TRUNCATE) are not possible through Polpo.");
    }
    const found = await findSource(deps, sourceId);
    if (!found.ok) return found.result;
    const r = await apiSend(deps, "POST", "/data/sql", { sourceId: found.source.id, sql });
    if (!r.ok) return apiError({ ...r, error: maskSecretsInText(r.error) }, "The SQL", "Fix the statement (it must be a single read-only one) and try again; polpo_data_source_get shows the tables and columns.");
    return frameResult(r.data as Frame, max_rows ?? 200, "SQL");
  });

  tool("data", "polpo_data_mutate", {
    title: "Change rows",
    description: "Insert, update or delete rows in a PostgreSQL or SQLite dataset. update and delete need filters (all must match) and confirm: true; "
      + "without confirm they say how many rows would change. insert adds one row from values.",
    inputSchema: {
      sourceId: z.string().min(1).describe("The source's id, slug or name"),
      dataset: z.string().min(1).describe("The table"),
      operation: z.enum(["insert", "update", "delete"]).describe("insert, update or delete"),
      values: z.record(z.string(), z.unknown()).optional().describe("Field values (insert: the new row; update: the fields to set)"),
      filters: filterInput.optional().describe("Which rows (update and delete; all must match)"),
      confirm: confirmParam("update or delete rows"),
    },
    outputSchema: { source_id: z.string(), dataset: z.string(), operation: z.string(), affected_rows: z.number().int() },
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
  }, async ({ sourceId, dataset, operation, values, filters, confirm }) => {
    if (operation !== "delete" && (!values || Object.keys(values).length === 0)) return fail(`${operation} needs values: the fields to ${operation === "insert" ? "insert" : "set"}.`);
    if (operation !== "insert" && (!filters || filters.length === 0)) return fail(`${operation} needs filters that pick the rows (changing a whole table is not allowed).`);
    const found = await findSource(deps, sourceId);
    if (!found.ok) return found.result;
    const s = found.source;
    if (operation !== "insert" && confirm !== true) {
      const q = await apiSend(deps, "POST", "/data/query", { sourceId: s.id, dataset, filters, limit: 1000 });
      const n = q.ok ? ((q.data as Frame).rows ?? []).length : undefined;
      const more = q.ok && (q.data as Frame).meta?.truncated;
      return fail(`This ${operation} on ${s.name} / ${dataset} would change ${n === undefined ? "the matching rows" : `${more ? "at least " : ""}${n} row(s)`}${operation === "delete" ? " and cannot be undone" : ""}. `
        + "Ask the person, then call again with confirm: true.");
    }
    const r = await apiSend(deps, "POST", "/data/mutate", { sourceId: s.id, dataset, operation, ...(values ? { values } : {}), ...(filters ? { filters } : {}) });
    if (!r.ok) return apiError({ ...r, error: maskSecretsInText(r.error) }, `The ${operation}`);
    const affected = (r.data as { affectedRows?: number }).affectedRows ?? 0;
    return ok(`${operation}: ${affected} row(s) in ${s.name} / ${dataset}.`, { source_id: s.id, dataset, operation, affected_rows: affected });
  });

  tool("data", "polpo_data_transaction", {
    title: "Run a data transaction",
    description: "Run several SQL statements in ONE transaction on a PostgreSQL or SQLite source: all commit, or any failing statement (or an expect_rows "
      + "mismatch) rolls everything back and says which statement and why. For writes that must succeed together, idempotent inserts "
      + "(INSERT ... ON CONFLICT DO NOTHING) and conditional updates (UPDATE ... WHERE id = $1 AND state = $2 with expect_rows: 1). Values go in params "
      + "($1, $2 on PostgreSQL; ? on SQLite), never in the SQL text. One statement per sql; BEGIN/COMMIT/SAVEPOINT/SET are refused: settings are applied "
      + "as SET LOCAL (PostgreSQL, keys namespace.name). Writes need confirm: true (read_only does not).",
    inputSchema: {
      sourceId: z.string().min(1).describe("The source's id, slug or name"),
      statements: z.array(z.object({
        sql: z.string().min(1).max(20_000).describe("One SQL statement with placeholders"),
        params: z.array(z.unknown()).max(1000).optional().describe("Bind parameters in placeholder order"),
        expect_rows: z.union([z.number().int().min(0), z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() })]).optional()
          .describe("Rows it must change or return: exactly n, or { min, max }; otherwise everything rolls back"),
      })).min(1).max(50).describe("The statements, run in order"),
      settings: z.record(z.string(), z.string().max(1000)).optional().describe("PostgreSQL: settings applied with SET LOCAL, e.g. { \"app.author\": \"Ada\" } for a trigger"),
      read_only: z.boolean().optional().describe("Run READ ONLY (only SELECT-like statements)"),
      timeout_ms: z.number().int().min(100).max(60_000).optional().describe("Statement and lock timeout, and the longest the transaction may run (default 15000, max 60000)"),
      max_rows: z.number().int().min(1).max(MAX_DATA_ROWS).optional().describe(`Most rows to return per statement (default 200, max ${MAX_DATA_ROWS})`),
      confirm: confirmParam("change rows"),
    },
    outputSchema: {
      source_id: z.string(), status: z.enum(["committed", "rolled_back"]), read_only: z.boolean(),
      statements: z.array(z.object({ index: z.number().int(), command: z.string(), row_count: z.number().int(), rows: z.array(looseObject).optional(), truncated: z.boolean().optional() })),
      failed: z.object({ index: z.number().int(), reason: z.string(), message: z.string() }).optional(),
    },
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
  }, async ({ sourceId, statements, settings, read_only, timeout_ms, max_rows, confirm }) => {
    const found = await findSource(deps, sourceId);
    if (!found.ok) return found.result;
    const s = found.source;
    if (!read_only && confirm !== true) {
      return fail(`This transaction runs ${statements.length} statement(s) on ${s.name} and may change rows. Ask the person, then call again with confirm: true `
        + "(or read_only: true when it only reads).");
    }
    const r = await apiSend(deps, "POST", `/data/${enc(s.id)}/transaction`, {
      statements: statements.map((st) => ({ sql: st.sql, ...(st.params ? { params: st.params } : {}), ...(st.expect_rows !== undefined ? { expectRows: st.expect_rows } : {}) })),
      ...(settings ? { settings } : {}), ...(read_only ? { readOnly: true } : {}), ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
    });
    if (!r.ok) return apiError({ ...r, error: maskSecretsInText(r.error) }, "The transaction", "Fix the statements and try again; nothing was changed.");
    const tx = r.data as { status: "committed" | "rolled_back"; readOnly: boolean; statements: Array<{ index: number; command: string; rowCount: number; rows?: Array<Record<string, unknown>>; truncated?: boolean }>; failed?: { index: number; reason: string; message: string } };
    const out = tx.statements.map((st) => {
      if (!st.rows) return { index: st.index, command: st.command, row_count: st.rowCount };
      const capped = capRows(st.rows, max_rows ?? 200);
      return { index: st.index, command: st.command, row_count: st.rowCount, rows: capped.rows, truncated: capped.cut || !!st.truncated };
    });
    const structured = { source_id: s.id, status: tx.status, read_only: !!tx.readOnly, statements: out, ...(tx.failed ? { failed: { ...tx.failed, message: maskSecretsInText(tx.failed.message) } } : {}) };
    const lines = out.map((st) => `${st.index + 1}. ${st.command}: ${st.row_count} row(s)${st.rows ? `\n${clip(st.rows)}` : ""}`);
    if (tx.status === "rolled_back") {
      const f = structured.failed!;
      return { ...fail(`Rolled back: statement ${f.index + 1} failed (${f.reason}): ${short(f.message, 400)}. Nothing was changed.${lines.length ? `\nBefore it:\n${lines.join("\n")}` : ""}`), structuredContent: structured };
    }
    return ok(`Committed ${out.length} statement(s) on ${s.name}.\n${lines.join("\n")}`, structured);
  });

  tool("data", "polpo_data_views_list", {
    title: "List data views",
    description: "Data views (live dashboards of widgets bound to queries or inline rows): name, how many widgets, which sources they read, link.",
    inputSchema: { limit: limitParam(20, 100), cursor: cursorParam() },
    outputSchema: pageOutput(viewItem),
    annotations: READ,
  }, async ({ limit, cursor }) => {
    const r = await apiGet(deps, "/views");
    if (!r.ok) return apiError(r, "Listing data views");
    const p = page(((r.data as View[]) ?? []).map((v) => viewSummary(deps, v)), limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map((v) => `- ${v.id} ${v.name} (${v.persistence}, ${v.widgets} widgets${v.sources.length ? `, ${v.sources.join(", ")}` : ""})`).join("\n") || "No data views."}`
      + `${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("data", "polpo_data_view_get", {
    title: "Get a data view",
    description: "One data view in full: its bindings (queries or inline rows) and widgets, as polpo_data_view_save takes them.",
    inputSchema: { id: z.string().min(1).describe("The view's id") },
    outputSchema: { view: z.object({ id: z.string(), name: z.string() }).passthrough(), url: z.string() },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, `/views/${enc(id)}`);
    if (!r.ok) return apiError(r, `Reading view ${id}`, r.status === 404 ? "List them with polpo_data_views_list." : undefined);
    const v = r.data as View;
    const url = dashboardLink(deps, `/views?view=${enc(v.id)}`);
    return ok(`${v.name} (${v.id}): ${v.widgets.length} widgets, ${v.bindings.length} bindings. ${url}\n${clip(v)}`, { view: v as unknown as Record<string, unknown>, url });
  });

  tool("data", "polpo_data_view_save", {
    title: "Create or change a data view",
    description: "Make a data view (a live dashboard) or change one (pass id; only the fields given change, a list given replaces it). "
      + "bindings: { id, query: { sourceId, dataset, fields, filters, sort, groupBy, aggregates, limit } }, { id, sql: { sourceId, statement } } "
      + "(one read-only SELECT/WITH on SQLite or PostgreSQL, run live) or { id, inline: { rows } } (at most 500 rows). "
      + "widgets: { type (metric, table, bar, line, pie, …), title, binding (a binding id), field, x, y, category, value, aggregate, format, width 1-4 }.",
    inputSchema: {
      id: z.string().min(1).optional().describe("The view to change; omit to create one"),
      name: z.string().trim().min(1).optional().describe("Its name (required to create)"),
      description: z.string().optional().describe("What it shows"),
      persistence: z.enum(["ephemeral", "saved", "pinned"]).optional().describe("saved (default), pinned, or ephemeral"),
      refresh_seconds: z.number().int().min(5).max(86400).optional().describe("Reload every N seconds"),
      bindings: z.array(looseObject).optional().describe("The data the widgets read (replaces the list)"),
      widgets: z.array(looseObject).optional().describe("The widgets (replaces the list)"),
    },
    outputSchema: { view: z.object({ id: z.string(), name: z.string() }).passthrough(), created: z.boolean(), url: z.string() },
    annotations: WRITE,
  }, async (args) => {
    let current: View | undefined;
    if (args.id) {
      const r = await apiGet(deps, `/views/${enc(args.id)}`);
      if (!r.ok) return apiError(r, `Reading view ${args.id}`, r.status === 404 ? "List them with polpo_data_views_list, or omit id to create one." : undefined);
      current = r.data as View;
    } else if (!args.name) return fail("To create a view give name (and bindings and widgets), or id to change one.");
    const body = {
      name: args.name ?? current!.name,
      ...(args.description !== undefined ? { description: args.description } : current?.description ? { description: current.description } : {}),
      persistence: args.persistence ?? current?.persistence ?? "saved",
      ...(args.refresh_seconds !== undefined ? { refreshSeconds: args.refresh_seconds } : current?.refreshSeconds ? { refreshSeconds: current.refreshSeconds } : {}),
      ...(current?.sessionId ? { sessionId: current.sessionId } : {}),
      createdBy: current?.createdBy ?? "mcp",
      bindings: args.bindings ?? current?.bindings ?? [],
      widgets: args.widgets ?? current?.widgets ?? [],
    };
    const r = current ? await apiSend(deps, "PUT", `/views/${enc(current.id)}`, body) : await apiSend(deps, "POST", "/views", body);
    if (!r.ok) return apiError(r, current ? `Changing view ${current.name}` : "Creating the view");
    const v = r.data as View;
    const url = dashboardLink(deps, `/views?view=${enc(v.id)}`);
    return ok(`${current ? "Changed" : "Created"} view ${v.name} (${v.id}): ${url}`, { view: v as unknown as Record<string, unknown>, created: !current, url });
  });

  tool("data", "polpo_data_view_delete", {
    title: "Delete a data view",
    description: "Delete a data view (the data it reads stays). Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The view's id"), confirm: confirmParam("delete the view") },
    outputSchema: { id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const cur = await apiGet(deps, `/views/${enc(id)}`);
    if (!cur.ok) return apiError(cur, `Reading view ${id}`, cur.status === 404 ? "List them with polpo_data_views_list." : undefined);
    const v = cur.data as View;
    if (confirm !== true) return fail(`Deleting the view ${v.name} (${v.id}, ${v.widgets.length} widgets) cannot be undone. Ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/views/${enc(v.id)}`);
    if (!r.ok) return apiError(r, `Deleting view ${v.name}`);
    return ok(`Deleted view ${v.name}.`, { id: v.id, deleted: true });
  });
}

function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "source";
}
