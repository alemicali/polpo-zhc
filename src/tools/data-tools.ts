import { Type } from "@sinclair/typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { nanoid } from "nanoid";
import { normalizeDataTags, type DataQuery, type DataSource, type DataViewBinding, type DataViewWidget } from "../core/data-registry.js";
import { getDataRegistryRuntime, type DataPrincipal } from "../server/data-runtime.js";
import type { VaultStore } from "../core/vault-store.js";
import type { DataRegistryChangeEmitter } from "../stores/file-data-registry-store.js";

const Filter = Type.Object({
  field: Type.String(),
  operator: Type.Union([
    Type.Literal("eq"), Type.Literal("neq"), Type.Literal("gt"), Type.Literal("gte"), Type.Literal("lt"), Type.Literal("lte"),
    Type.Literal("contains"), Type.Literal("startsWith"), Type.Literal("in"), Type.Literal("isNull"),
  ]),
  value: Type.Optional(Type.Any()),
});

const Query = Type.Object({
  sourceId: Type.String({ description: "Source ID from data_list_sources" }),
  dataset: Type.String({ description: "Dataset name from data_describe" }),
  fields: Type.Optional(Type.Array(Type.String())),
  filters: Type.Optional(Type.Array(Filter)),
  sort: Type.Optional(Type.Array(Type.Object({ field: Type.String(), direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]) }))),
  groupBy: Type.Optional(Type.Array(Type.String())),
  aggregates: Type.Optional(Type.Array(Type.Object({
    field: Type.String(),
    operation: Type.Union([Type.Literal("count"), Type.Literal("sum"), Type.Literal("avg"), Type.Literal("min"), Type.Literal("max")]),
    as: Type.Optional(Type.String()),
  }))),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Number({ minimum: 0 })),
});

const Widget = Type.Object({
  id: Type.Optional(Type.String()),
  type: Type.Union([
    Type.Literal("metric"), Type.Literal("table"), Type.Literal("record"), Type.Literal("bar"), Type.Literal("line"),
    Type.Literal("area"), Type.Literal("pie"), Type.Literal("timeline"), Type.Literal("status"), Type.Literal("markdown"),
    Type.Literal("list"), Type.Literal("progress"), Type.Literal("gauge"), Type.Literal("sparkline"), Type.Literal("comparison"),
    Type.Literal("ranking"), Type.Literal("scatter"), Type.Literal("donut"), Type.Literal("radar"), Type.Literal("heatmap"),
    Type.Literal("funnel"), Type.Literal("histogram"), Type.Literal("treemap"),
  ]),
  title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), binding: Type.Optional(Type.String()),
  field: Type.Optional(Type.String()), x: Type.Optional(Type.String()), y: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()), value: Type.Optional(Type.String()), markdown: Type.Optional(Type.String()),
  aggregate: Type.Optional(Type.Union([Type.Literal("count"), Type.Literal("sum"), Type.Literal("avg"), Type.Literal("min"), Type.Literal("max")])),
  target: Type.Optional(Type.Number()), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()),
  format: Type.Optional(Type.Union([Type.Literal("number"), Type.Literal("currency"), Type.Literal("percent"), Type.Literal("compact")])),
  currency: Type.Optional(Type.String()), showLegend: Type.Optional(Type.Boolean()),
  width: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)])),
  height: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("standard"), Type.Literal("tall")])),
});

const Binding = Type.Union([
  Type.Object({ id: Type.String(), query: Query }),
  Type.Object({ id: Type.String(), inline: Type.Object({ label: Type.Optional(Type.String()), rows: Type.Array(Type.Record(Type.String(), Type.Any()), { maxItems: 500 }) }) }),
]);

const SourceKind = Type.Union([Type.Literal("sqlite"), Type.Literal("postgres"), Type.Literal("rest"), Type.Literal("json"), Type.Literal("csv")]);
const SourceEnvironment = Type.Union([Type.Literal("development"), Type.Literal("staging"), Type.Literal("production")]);
const SourceConfig = Type.Object({
  location: Type.String(), port: Type.Optional(Type.Number()), database: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()), ssl: Type.Optional(Type.Boolean()), defaultDataset: Type.Optional(Type.String()),
});

export const DATA_TOOL_NAMES = [
  "data_list_sources", "data_register_source", "data_update_source", "data_delete_source", "data_test_source", "data_set_source_grant",
  "data_describe", "data_query", "data_sql", "data_mutate",
  "data_list_views", "data_get_view", "data_create_view", "data_update_view", "data_delete_view",
] as const;

export const DATA_ORCHESTRATOR_TOOLS: Tool[] = [
  {
    name: "data_list_sources",
    description: "List registered structured data sources available to you. Use before querying; never guess a source ID.",
    parameters: Type.Object({}),
  },
  {
    name: "data_register_source",
    description: "Register a PostgreSQL, SQLite, REST, JSON, or CSV source. Credentials are stored only in Vault. Agents that register a source receive its admin grant.",
    parameters: Type.Object({
      name: Type.String(), slug: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
      kind: SourceKind, environment: Type.Optional(SourceEnvironment), config: SourceConfig,
      tags: Type.Optional(Type.Array(Type.String())), credentials: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
  },
  {
    name: "data_update_source",
    description: "Update metadata or connection settings for a source you administer. Omitted fields and credentials remain unchanged.",
    parameters: Type.Object({
      sourceId: Type.String(), name: Type.Optional(Type.String()), slug: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
      environment: Type.Optional(SourceEnvironment), config: Type.Optional(Type.Partial(SourceConfig)),
      tags: Type.Optional(Type.Array(Type.String())), credentials: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
  },
  {
    name: "data_delete_source",
    description: "Remove a source registry entry and its stored credentials. This never deletes the underlying database, file, or independent View definitions.",
    parameters: Type.Object({ sourceId: Type.String() }),
  },
  {
    name: "data_test_source",
    description: "Test a source connection and return latency and discovered dataset count.",
    parameters: Type.Object({ sourceId: Type.String() }),
  },
  {
    name: "data_set_source_grant",
    description: "Grant, change, or revoke one agent's scoped access to a source you administer.",
    parameters: Type.Object({
      sourceId: Type.String(), agent: Type.String(), role: Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write"), Type.Literal("admin")]),
      datasets: Type.Optional(Type.Array(Type.String())), excludedFields: Type.Optional(Type.Array(Type.String())),
    }),
  },
  {
    name: "data_describe",
    description: "Discover datasets and typed columns in a registered data source.",
    parameters: Type.Object({ sourceId: Type.String() }),
  },
  {
    name: "data_query",
    description: "Run a bounded, structured read query against any registered source and return a standard DataFrame.",
    parameters: Query,
  },
  {
    name: "data_sql",
    description: "Run one read-only SELECT/WITH/EXPLAIN statement against SQLite or PostgreSQL. Prefer data_query; use this only when the structured query cannot express the analysis.",
    parameters: Type.Object({ sourceId: Type.String(), sql: Type.String() }),
  },
  {
    name: "data_mutate",
    description: "Insert, update, or delete structured records. Updates/deletes require filters. This is a write operation and should only be used when the user asked to change source data.",
    parameters: Type.Object({
      sourceId: Type.String(), dataset: Type.String(),
      operation: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")]),
      values: Type.Optional(Type.Record(Type.String(), Type.Any())), filters: Type.Optional(Type.Array(Filter)),
    }),
  },
  {
    name: "data_list_views",
    description: "List AI-generated and saved data views.",
    parameters: Type.Object({}),
  },
  {
    name: "data_get_view",
    description: "Get a data view specification by ID.",
    parameters: Type.Object({ id: Type.String() }),
  },
  {
    name: "data_create_view",
    description: "Compose a native interactive data screen from live-source query bindings, bounded inline rows, or both. The UI renders this JSON; do not generate HTML.",
    parameters: Type.Object({
      name: Type.String(), description: Type.Optional(Type.String()),
      persistence: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("saved"), Type.Literal("pinned")])),
      sessionId: Type.Optional(Type.String()), refreshSeconds: Type.Optional(Type.Number({ minimum: 5 })),
      bindings: Type.Array(Binding), widgets: Type.Array(Widget),
    }),
  },
  {
    name: "data_update_view",
    description: "Replace the bindings and widgets of an existing data view while preserving its identity.",
    parameters: Type.Object({
      id: Type.String(), name: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
      persistence: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("saved"), Type.Literal("pinned")])),
      refreshSeconds: Type.Optional(Type.Number({ minimum: 5 })),
      bindings: Type.Optional(Type.Array(Binding)), widgets: Type.Optional(Type.Array(Widget)),
    }),
  },
  {
    name: "data_delete_view",
    description: "Delete a generated or saved data view.",
    parameters: Type.Object({ id: Type.String() }),
  },
];

export async function executeDataTool(
  name: string,
  args: Record<string, unknown>,
  polpoDir: string,
  principal: DataPrincipal,
  vaultStore?: VaultStore,
  sessionId?: string,
  emitChange?: DataRegistryChangeEmitter,
): Promise<string> {
  const runtime = getDataRegistryRuntime(polpoDir, vaultStore, emitChange);
  if (name === "data_list_sources") return json(await runtime.listSources(principal));
  if (name === "data_register_source") {
    const sourceName = String(args.name).trim();
    const source = await runtime.store.createSource({
      name: sourceName,
      slug: optionalString(args.slug) ?? slugify(sourceName),
      description: optionalString(args.description),
      kind: args.kind as DataSource["kind"],
      environment: (args.environment as DataSource["environment"] | undefined) ?? "development",
      config: args.config as DataSource["config"],
      tags: normalizeDataTags((args.tags as string[] | undefined) ?? []),
      grants: principal.agent ? [{ id: nanoid(), agent: principal.agent, capabilities: ["admin"], datasets: ["*"] }] : [],
    });
    await saveSourceCredentials(vaultStore, source.id, args.credentials);
    return json(source);
  }
  if (name === "data_update_source") {
    const current = await runtime.getSource(String(args.sourceId), principal, "admin");
    const updated = await runtime.store.updateSource(current.id, {
      ...(args.name !== undefined ? { name: String(args.name).trim() } : {}),
      ...(args.slug !== undefined ? { slug: slugify(String(args.slug)) } : {}),
      ...(args.description !== undefined ? { description: optionalString(args.description) } : {}),
      ...(args.environment !== undefined ? { environment: args.environment as DataSource["environment"] } : {}),
      ...(args.config !== undefined ? { config: { ...current.config, ...(args.config as Partial<DataSource["config"]>) } } : {}),
      ...(args.tags !== undefined ? { tags: normalizeDataTags(args.tags as string[]) } : {}),
    });
    await saveSourceCredentials(vaultStore, current.id, args.credentials);
    return json(updated);
  }
  if (name === "data_delete_source") {
    const current = await runtime.getSource(String(args.sourceId), principal, "admin");
    const deleted = await runtime.store.deleteSource(current.id);
    await vaultStore?.remove("$data", `data:${current.id}`).catch(() => undefined);
    return json({ deleted });
  }
  if (name === "data_test_source") return json(await runtime.test(String(args.sourceId), principal));
  if (name === "data_set_source_grant") {
    const current = await runtime.getSource(String(args.sourceId), principal, "admin");
    const agent = String(args.agent).trim();
    const role = String(args.role);
    const grants = current.grants.filter((grant) => grant.agent !== agent);
    if (role !== "none") grants.push({
      id: current.grants.find((grant) => grant.agent === agent)?.id ?? nanoid(),
      agent,
      capabilities: [role as "read" | "write" | "admin"],
      datasets: (args.datasets as string[] | undefined)?.filter(Boolean) ?? ["*"],
      excludedFields: (args.excludedFields as string[] | undefined)?.filter(Boolean),
    });
    return json(await runtime.store.updateSource(current.id, { grants }));
  }
  if (name === "data_describe") return json(await runtime.discover(String(args.sourceId), principal));
  if (name === "data_query") return json(await runtime.query(args as unknown as DataQuery, principal));
  if (name === "data_sql") return json(await runtime.rawSql(String(args.sourceId), String(args.sql), principal));
  if (name === "data_mutate") return json(await runtime.mutate(args as any, principal));
  if (name === "data_list_views") return json(await visibleViews(runtime, principal));
  if (name === "data_get_view") {
    const view = await runtime.store.getView(String(args.id));
    if (!view) throw new Error(`Data view "${String(args.id)}" not found`);
    await requireVisibleView(runtime, view, principal);
    return json(view);
  }
  if (name === "data_create_view") {
    const bindings = normalizeBindings(args.bindings);
    await validateViewSources(runtime, bindings, principal);
    const view = await runtime.store.createView({
      name: String(args.name), description: optionalString(args.description),
      persistence: (args.persistence as any) ?? "ephemeral",
      sessionId: optionalString(args.sessionId) ?? sessionId,
      createdBy: principal.agent ?? "orchestrator",
      refreshSeconds: optionalNumber(args.refreshSeconds),
      bindings,
      widgets: normalizeWidgets(args.widgets),
    });
    return json({ ...view, openPath: `/views?view=${encodeURIComponent(view.id)}` });
  }
  if (name === "data_update_view") {
    const current = await runtime.store.getView(String(args.id));
    if (!current) throw new Error(`Data view "${String(args.id)}" not found`);
    await requireVisibleView(runtime, current, principal);
    const bindings = args.bindings ? normalizeBindings(args.bindings) : current.bindings;
    await validateViewSources(runtime, bindings, principal);
    const view = await runtime.store.updateView(current.id, {
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.description !== undefined ? { description: optionalString(args.description) } : {}),
      ...(args.persistence !== undefined ? { persistence: args.persistence as any } : {}),
      ...(args.refreshSeconds !== undefined ? { refreshSeconds: optionalNumber(args.refreshSeconds) } : {}),
      ...(args.bindings !== undefined ? { bindings } : {}),
      ...(args.widgets !== undefined ? { widgets: normalizeWidgets(args.widgets) } : {}),
    });
    return json({ ...view, openPath: `/views?view=${encodeURIComponent(current.id)}` });
  }
  if (name === "data_delete_view") {
    const current = await runtime.store.getView(String(args.id));
    if (!current) throw new Error(`Data view "${String(args.id)}" not found`);
    await requireVisibleView(runtime, current, principal);
    return json({ deleted: await runtime.store.deleteView(current.id) });
  }
  throw new Error(`Unknown data tool "${name}"`);
}

async function visibleViews(runtime: ReturnType<typeof getDataRegistryRuntime>, principal: DataPrincipal) {
  if (principal.admin || !principal.agent) return runtime.store.listViews();
  const sources = new Set((await runtime.listSources(principal)).map((source) => source.id));
  return (await runtime.store.listViews()).filter((view) => view.bindings.every((binding) => !binding.query || sources.has(binding.query.sourceId)));
}

async function requireVisibleView(
  runtime: ReturnType<typeof getDataRegistryRuntime>,
  view: Awaited<ReturnType<ReturnType<typeof getDataRegistryRuntime>["store"]["getView"]>> & {},
  principal: DataPrincipal,
): Promise<void> {
  if (principal.admin || !principal.agent) return;
  const sources = new Set((await runtime.listSources(principal)).map((source) => source.id));
  if (!view.bindings.every((binding) => !binding.query || sources.has(binding.query.sourceId))) {
    throw new Error(`Access denied to data view "${view.name}"`);
  }
}

export function createDataAgentTools(
  polpoDir: string,
  agent: string,
  allowedTools: string[] | undefined,
  vaultStore?: VaultStore,
  emitChange?: DataRegistryChangeEmitter,
): AgentTool<any>[] {
  if (!allowedTools?.some((pattern) => pattern === "data_*" || pattern.startsWith("data_"))) return [];
  const definitions = DATA_ORCHESTRATOR_TOOLS.filter((tool) => allowedTools.some((pattern) => pattern === tool.name || (pattern.endsWith("*") && tool.name.startsWith(pattern.slice(0, -1)))));
  return definitions.map((definition) => ({
    ...definition,
    label: definition.name.split("_").slice(1).map(capitalize).join(" "),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const text = await executeDataTool(definition.name, params, polpoDir, { agent }, vaultStore, undefined, emitChange);
        return { content: [{ type: "text" as const, text }], details: { sourceId: params.sourceId, viewId: params.id } };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true } };
      }
    },
  })) as AgentTool<any>[];
}

async function validateViewSources(runtime: ReturnType<typeof getDataRegistryRuntime>, bindings: DataViewBinding[], principal: DataPrincipal): Promise<void> {
  for (const binding of bindings) {
    if (!binding.query) continue;
    const sources = await runtime.listSources(principal);
    if (!sources.some((source) => source.id === binding.query.sourceId || source.slug === binding.query.sourceId)) {
      throw new Error(`Data source "${binding.query.sourceId}" is not available to this agent`);
    }
  }
}

function normalizeBindings(value: unknown): DataViewBinding[] {
  const bindings = Array.isArray(value) ? value : [];
  return bindings.map((raw) => {
    const binding = raw as Record<string, any>;
    const id = String(binding.id ?? "").trim();
    if (!id) throw new Error("Every data view binding requires an ID");
    if (binding.query && binding.inline) throw new Error(`Binding "${id}" cannot be both source-backed and inline`);
    if (binding.query) return { id, query: { ...binding.query } } as DataViewBinding;
    if (!binding.inline || !Array.isArray(binding.inline.rows)) throw new Error(`Binding "${id}" requires query or inline rows`);
    if (binding.inline.rows.length > 500) throw new Error(`Inline binding "${id}" exceeds the 500-row limit`);
    const inline = { label: optionalString(binding.inline.label), rows: binding.inline.rows as Record<string, unknown>[] };
    if (Buffer.byteLength(JSON.stringify(inline), "utf8") > 512 * 1024) throw new Error(`Inline binding "${id}" exceeds the 512 KB limit`);
    return { id, inline } as DataViewBinding;
  });
}

function normalizeWidgets(value: unknown): DataViewWidget[] {
  return (Array.isArray(value) ? value : []).map((widget) => ({ ...(widget as DataViewWidget), id: (widget as DataViewWidget).id ?? nanoid() }));
}
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
async function saveSourceCredentials(vaultStore: VaultStore | undefined, sourceId: string, value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return;
  if (!vaultStore) throw new Error("Vault is unavailable; credentials could not be stored securely");
  const service = `data:${sourceId}`;
  const existing = await vaultStore.get("$data", service);
  await vaultStore.set("$data", service, {
    type: "custom", label: `Data source ${sourceId}`,
    credentials: { ...(existing?.credentials ?? {}), ...(value as Record<string, string>) },
  });
}
function slugify(value: string): string {
  const slug = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Data source slug cannot be empty");
  return slug;
}
function capitalize(value: string): string { return value ? value[0]!.toUpperCase() + value.slice(1) : value; }
function json(value: unknown): string { return JSON.stringify(value, null, 2); }
