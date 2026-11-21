/**
 * The admin toolset (off by default): a read-only fallback to the REST API for what no specific
 * tool covers. Writes are not reachable here: they go through the typed tools, which validate,
 * confirm and attribute them.
 */
import { z } from "zod";
import {
  READ, clip, cursorParam, fail, limitParam, ok, page, pageOutput, BAD_CURSOR,
  type McpDeps, type Register,
} from "./kit.js";

export interface Operation { method: string; path: string; summary: string; tags: string[] }

/** GET routes that stream, return binary data or reveal more than a read should. */
const BLOCKED_GET = [
  /^\/events(\/|$)/, // SSE
  /\/stream(\/|$)/,
  /^\/terminal(\/|$)/,
  /^\/audio(\/|$)/,
  /^\/openapi\.json$/,
  /\/(download|raw|vnc|screenshot|logo|avatar)(\/|$)/,
  /^\/files\/read$/, // polpo_file_read handles files
  /^\/attachments\/[^/]+$/,
];

export function isBlockedGet(path: string): boolean {
  return BLOCKED_GET.some((re) => re.test(path));
}

/** Per route table (the server's app.routes array): the index, built once a minute at most. */
const cache = new WeakMap<object, { at: number; ops: Operation[] }>();

/** The REST operations, from the instance's OpenAPI document plus routes it does not describe (paths relative to /api/v1). */
export async function operations(deps: McpDeps): Promise<Operation[]> {
  const routes = deps.routes?.();
  const cached = routes ? cache.get(routes) : undefined;
  if (cached && Date.now() - cached.at < 60_000) return cached.ops;
  const res = await deps.api("GET", "/api/v1/openapi.json");
  const doc = res.body as { paths?: Record<string, Record<string, { summary?: string; description?: string; tags?: string[] }>> } | null;
  const ops: Operation[] = [];
  for (const [path, methods] of Object.entries(doc?.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      ops.push({
        method: method.toUpperCase(),
        path: path.replace(/^\/api\/v1/, ""),
        summary: (op.summary ?? op.description ?? "").split("\n")[0]!.slice(0, 140),
        tags: op.tags ?? [],
      });
    }
  }
  const known = new Set(ops.map((o) => `${o.method} ${o.path}`));
  for (const route of routes ?? []) {
    const method = route.method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !route.path.startsWith("/api/v1/") || route.path.includes("*")) continue;
    const path = route.path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/+$/, "") || "/";
    const key = `${method} ${path}`;
    if (known.has(key)) continue;
    known.add(key);
    ops.push({ method, path, summary: "", tags: [path.split("/")[1] ?? ""] });
  }
  const sorted = ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  if (routes) cache.set(routes, { at: Date.now(), ops: sorted });
  return sorted;
}

/** Does a concrete path ("/tasks/abc") match a templated one ("/tasks/{taskId}")? */
export function matchesOperationPath(template: string, path: string): boolean {
  const t = template.split("/");
  const p = path.split("/");
  return t.length === p.length && t.every((seg, i) => (/^\{.+\}$/.test(seg) ? p[i]!.length > 0 : seg === p[i]));
}

/** Fill {params} of a template. */
function fillPath(template: string, params: Record<string, string>): { path: string; missing: string[] } {
  const missing: string[] = [];
  const path = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === "") { missing.push(name); return `{${name}}`; }
    return encodeURIComponent(v);
  });
  return { path, missing };
}

const opItem = z.object({ method: z.string(), path: z.string(), summary: z.string(), tags: z.array(z.string()), readable: z.boolean() });

export function registerAdminTools(tool: Register, deps: McpDeps): void {
  tool("admin", "polpo_api_search", {
    title: "Search the REST API",
    description: "Find operations of Polpo's REST API (method, path, summary) by words or tag, for what no specific tool covers. "
      + "GET operations marked readable can be called with polpo_api_get; writes are only possible through the specific tools. "
      + "The API reference is the instance's /api/v1/openapi.json (docs/openapi.json in the repository).",
    inputSchema: {
      q: z.string().optional().describe("Words that must all appear in the path or summary, e.g. 'schedule mission'"),
      tag: z.string().optional().describe("Only operations with this tag, e.g. Tasks"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("Only this method"),
      limit: limitParam(50, 200),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(opItem),
    annotations: READ,
  }, async ({ q, tag, method, limit, cursor }) => {
    const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const ops = (await operations(deps)).filter((o) => (!tag || o.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
      && (!method || o.method === method)
      && words.every((w) => `${o.path} ${o.summary}`.toLowerCase().includes(w)))
      .map((o) => ({ ...o, readable: o.method === "GET" && !isBlockedGet(o.path) }));
    const p = page(ops, limit ?? 50, cursor);
    if (!p) return fail(BAD_CURSOR);
    if (p.total === 0) return ok("No operations match: try fewer or other words.", p);
    return ok(`${p.items.map((o) => `${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ""}${o.method === "GET" && !o.readable ? " (not readable here)" : ""}`).join("\n")}`
      + `${p.next_cursor ? `\n(${p.total} in all; more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("admin", "polpo_api_get", {
    title: "Read from the REST API",
    description: "Read-only: call one GET operation of Polpo's REST API (polpo_api_search finds them) with its path parameters and query. "
      + "Use it only when no specific tool returns what you need. It cannot change anything; streams and binary downloads are not available.",
    inputSchema: {
      path: z.string().min(1).describe("The operation's path relative to /api/v1, as a template (/tasks/{taskId}) or with the values filled in (/tasks/abc123)"),
      params: z.record(z.string(), z.string()).optional().describe("Values for the {placeholders} of a templated path, e.g. { taskId: 'abc123' }"),
      query: z.record(z.string(), z.string()).optional().describe("Query string parameters, e.g. { status: 'done' }"),
    },
    outputSchema: { status: z.number(), path: z.string(), data: z.unknown() },
    annotations: READ,
  }, async ({ path, params, query }) => {
    let clean = `/${path.replace(/^\/?(api\/v1\/?)?/, "")}`.replace(/\/+$/, "") || "/";
    if (clean.includes("..") || clean.includes("?")) return fail("Invalid path: give the path without .. or a query string (use query for parameters).");
    if (/\{[^}]+\}/.test(clean)) {
      const filled = fillPath(clean, params ?? {});
      if (filled.missing.length) return fail(`Missing values for ${filled.missing.map((m) => `{${m}}`).join(", ")}: pass them in params.`);
      clean = filled.path;
    }
    const ops = await operations(deps);
    const matching = ops.filter((o) => matchesOperationPath(o.path, clean));
    if (!matching.some((o) => o.method === "GET")) {
      return fail(matching.length
        ? `${clean} cannot be read here (it accepts ${matching.map((o) => o.method).join(", ")}): changes go through the specific tools (polpo_ask can do anything else).`
        : `No GET operation matches ${clean}: use polpo_api_search to find the right path.`);
    }
    if (isBlockedGet(clean)) return fail(`${clean} streams or returns binary data, which this tool does not read: use the specific tools (e.g. polpo_file_read).`);
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
    const res = await deps.api("GET", `/api/v1${clean}${q}`);
    const body = res.body as { ok?: boolean; data?: unknown; error?: unknown } | null;
    const data = body && typeof body === "object" && "data" in body ? body.data : res.body;
    if (res.status >= 400) return fail(`GET ${clean} failed (HTTP ${res.status}): ${clip(body?.error ?? res.body)}. Check the path and parameters with polpo_api_search.`);
    return ok(clip(data), { status: res.status, path: clean, data });
  });
}
