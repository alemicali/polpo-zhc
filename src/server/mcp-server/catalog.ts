/**
 * The tool catalog, declared once per process and bound to each request.
 *
 * MCP over HTTP is stateless here: every request gets its own McpServer. Building ~250 tools'
 * zod schemas for each one cost 120–210 ms and ~60 MB of short-lived objects (mostly GC), so the
 * register* modules run once (declareCatalog), against a template server that normalizes the
 * schemas the way the SDK does, and with `requestDeps` in place of a request's dependencies. What
 * they declare (names, descriptions, annotations, schemas, _meta, app gates, resources) is kept;
 * for a request, bindCatalog registers the entries its toolsets and scopes allow on a fresh server,
 * each handler running with that request's deps (withRequestDeps). Nothing a request does is kept:
 * the server, its handlers' bindings and the scope checks are per request, as before.
 */
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, type Tool, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  hasScope, outputObject, requestDeps, scopeFor, withRequestDeps,
  type AppGate, type AppRegister, type McpDeps, type McpPrincipal, type PolpoScope, type Register, type ToolScope, type ToolsetName,
} from "./kit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's callbacks and configs are generic
type Any = any;
type Callback = (...args: Any[]) => unknown;

/** `listing`: the tool as tools/list shows it, made on first use (its JSON Schemas are costly too). */
type Entry =
  /** A tool from a Register: offered when its toolset is on and the principal holds its scope. */
  | { kind: "tool"; name: string; toolset: ToolsetName; scope: PolpoScope; readOnly: boolean; destructive: boolean; config: Any; handler: Callback; listing?: Tool }
  /** An app gate (in declaration order: the scope matrix lists its names where it was declared). */
  | { kind: "gate"; id: number; parent?: number; toolset: ToolsetName; annotations: ToolAnnotations; names: string[] }
  /** An app tool, behind a gate. */
  | { kind: "appTool"; gate: number; name: string; config: Any; handler: Callback; listing?: Tool }
  /** A resource, registered when any of its gates is open. */
  | { kind: "resource"; gates: number[]; name: string; uri: Any; config: Any; read: Callback };

export interface Catalog {
  readonly entries: readonly Entry[];
}

/** Every module's tools, cards and resources, declared with the request's stand-in deps. */
export type Declare = (tool: Register, app: AppRegister, deps: McpDeps) => void;

/** The schemas as the SDK keeps them (a raw shape becomes an object schema), so each request reuses them as they are. */
function normalized(config: Any, registered: RegisteredTool): Any {
  return { ...config, inputSchema: registered.inputSchema, outputSchema: registered.outputSchema };
}

/** Run the declarations once: every toolset, as if every scope were held. */
export function declareCatalog(declare: Declare): Catalog {
  const template = new McpServer({ name: "polpo-catalog", version: "0" });
  const entries: Entry[] = [];
  let gates = 0;

  const tool: Register = (toolset, name, spec, handler) => {
    const config = {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.outputSchema ? { outputSchema: outputObject(spec.outputSchema) } : {}),
      annotations: { title: spec.title, ...spec.annotations },
      ...(spec._meta ? { _meta: spec._meta } : {}),
    };
    const registered = template.registerTool(name, config, handler as Any);
    entries.push({
      kind: "tool", name, toolset, scope: spec.scope ?? scopeFor(toolset, spec.annotations),
      readOnly: !!spec.annotations.readOnlyHint, destructive: !!spec.annotations.destructiveHint,
      config: normalized(config, registered), handler: handler as Callback,
    });
  };

  const registerResource = (ids: number[]) => ((name: string, uri: Any, config: Any, read: Callback) => {
    const registered = template.registerResource(name, uri, config, read as Any);
    entries.push({ kind: "resource", gates: ids, name, uri, config, read });
    return registered;
  }) as Any;

  const gate = (toolset: ToolsetName, annotations: ToolAnnotations, names: string[] = [], parent?: number): AppGate => {
    const id = ++gates;
    entries.push({ kind: "gate", id, ...(parent !== undefined ? { parent } : {}), toolset, annotations, names });
    const g: AppGate & { id: number } = {
      id,
      gate: (t, a, n) => gate(t, a, n, id),
      registerTool: ((name: string, config: Any, handler: Callback) => {
        const registered = template.registerTool(name, config, handler as Any);
        entries.push({ kind: "appTool", gate: id, name, config: normalized(config, registered), handler });
        return registered;
      }) as Any,
      registerResource: registerResource([id]),
    };
    return g;
  };

  const app: AppRegister = {
    gate: (toolset, annotations, names) => gate(toolset, annotations, names),
    anyOf: (...gs) => ({ registerResource: registerResource(gs.map((g) => (g as AppGate & { id: number }).id)) }),
  };

  declare(tool, app, requestDeps);
  void template.close();
  return { entries };
}

/**
 * Register on `server` what the toolsets and the principal allow, each handler bound to `deps`.
 * `catalog`, when given, collects every tool of an enabled toolset with its scope, offered or not
 * (the scope matrix). Handlers that throw become an isError result (the SDK does that), so tools
 * return fail() for expected errors and let unexpected ones surface.
 */
export function bindCatalog(server: McpServer, built: Catalog, deps: McpDeps, enabled: ReadonlySet<ToolsetName>,
  principal: McpPrincipal, catalog?: ToolScope[]): void {
  const bind = (fn: Callback): Any => (...args: unknown[]) => withRequestDeps(deps, () => fn(...args));
  const open = new Map<number, boolean>();
  const offered: Array<{ entry: Extract<Entry, { kind: "tool" | "appTool" }>; registered: RegisteredTool }> = [];
  const register = (entry: Extract<Entry, { kind: "tool" | "appTool" }>) => {
    offered.push({ entry, registered: server.registerTool(entry.name, entry.config, bind(entry.handler)) });
  };
  for (const e of built.entries) {
    switch (e.kind) {
      case "tool": {
        if (!enabled.has(e.toolset)) break;
        catalog?.push({ name: e.name, toolset: e.toolset, scope: e.scope, readOnly: e.readOnly, destructive: e.destructive });
        if (hasScope(principal, e.scope)) register(e);
        break;
      }
      case "gate": {
        // as a chain of `if (!allowed(...)) return;`: a gate under a closed one is closed and lists nothing
        if (e.parent !== undefined && !open.get(e.parent)) { open.set(e.id, false); break; }
        if (!enabled.has(e.toolset)) { open.set(e.id, false); break; }
        const scope = scopeFor(e.toolset, e.annotations);
        for (const name of e.names) {
          catalog?.push({ name, toolset: e.toolset, scope, readOnly: !!e.annotations.readOnlyHint, destructive: !!e.annotations.destructiveHint });
        }
        open.set(e.id, hasScope(principal, scope));
        break;
      }
      case "appTool":
        if (open.get(e.gate)) register(e);
        break;
      case "resource":
        if (e.gates.some((id) => open.get(id))) server.registerResource(e.name, e.uri, e.config, bind(e.read));
        break;
    }
  }
  // tools/list as the SDK answers it, each tool's listing made once per process (the SDK converts every schema to JSON Schema on every call)
  if (offered.length) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: offered.filter((o) => o.registered.enabled).map((o) => (o.entry.listing ??= toolListing(o.entry.name, o.registered))),
    }));
  }
}

const EMPTY_OBJECT_JSON_SCHEMA = { type: "object" as const, properties: {} };

/** One tool in tools/list, built as McpServer's own handler builds it (mcp-catalog.test.ts compares the two). */
function toolListing(name: string, tool: RegisteredTool): Tool {
  const input = normalizeObjectSchema(tool.inputSchema);
  const listing: Tool = {
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: (input ? toJsonSchemaCompat(input, { strictUnions: true, pipeStrategy: "input" }) : EMPTY_OBJECT_JSON_SCHEMA) as Tool["inputSchema"],
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  };
  const output = tool.outputSchema ? normalizeObjectSchema(tool.outputSchema) : undefined;
  if (output) listing.outputSchema = toJsonSchemaCompat(output, { strictUnions: true, pipeStrategy: "output" }) as Tool["outputSchema"];
  return listing;
}
