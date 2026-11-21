/**
 * Shared pieces of Polpo's MCP server: the dependencies a tool gets, the authenticated principal,
 * toolsets and scopes, result builders, pagination cursors and API helpers.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";

export interface ApiResponse {
  status: number;
  /** Parsed JSON, or the text when the body is not JSON. */
  body: unknown;
  headers: Headers;
  /** The raw body, for files. */
  bytes?: Uint8Array;
}

/**
 * Who is calling, as authenticated at /mcp. `actor` is what events, approvals and artifacts record
 * (`by`, `resolvedBy`, `createdBy`); `scopes` decide which tools are offered (see `scopeFor`).
 */
export interface McpPrincipal {
  kind: "oauth" | "key" | "session" | "open";
  /** e.g. "ada@example.com via Claude", "Claude (MCP)", "mcp-key", "ada@example.com", "mcp". */
  actor: string;
  /** The person who allowed an OAuth client, or signed in (an email, "api-key" or "local"). */
  subject?: string;
  /** The OAuth client's name. */
  client?: string;
  /** Granted scopes: "polpo" is everything; else "polpo:read", "polpo:work", "polpo:admin". */
  scopes: string[];
}

/** A principal that may do everything (tests, local stdio). */
export const FULL_ACCESS: McpPrincipal = { kind: "open", actor: "mcp", scopes: ["polpo"] };

/** The addresses a host name resolves to. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export interface McpDeps {
  /** A call to the instance's own HTTP API (a path from the server root, e.g. /api/v1/tasks), in process; a FormData or binary body goes as is, anything else as JSON. */
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse>;
  version: string;
  /** Logs one line per MCP message (no contents). */
  log?: (line: string) => void;
  /** Every route the server has registered (method, path with :params), for polpo_api_search. */
  routes?: () => Array<{ method: string; path: string }>;
  /** Who calls (default: full access, actor "mcp"). */
  principal?: McpPrincipal;
  /** The toolsets this instance offers (settings.mcp.toolsets / POLPO_MCP_TOOLSETS); default: every toolset that is on by default. */
  toolsets?: readonly string[];
  /** The dashboard's public URL, for links (e.g. where to enter a secret). */
  publicUrl?: string;
  /** How often wait tools look again (ms, default 1000). */
  pollIntervalMs?: number;
  /** For fetching remote files (logo URLs); default: global fetch. */
  fetch?: typeof fetch;
  /** Name resolution for the private-address guard; default: DNS. */
  resolveHost?: ResolveHost;
  /** Allow fetching from private addresses (tests only). */
  allowPrivateFetch?: boolean;
}

/** Longest tool result returned to the model; the rest is cut with a note. */
export const MAX_RESULT_CHARS = 40_000;

// ── Toolsets and scopes ──────────────────────────────────────────────

export const TOOLSETS = {
  core: { default: true, description: "Ask Polpo (and answer its questions and previews), chat with agents, agents, approvals" },
  tasks: { default: true, description: "Tasks: list, read, create, update, retry, kill, direct, wait, logs" },
  missions: { default: true, description: "Missions and playbooks: list, read, create, update, run, abort, wait" },
  artifacts: { default: true, description: "Artifacts: documents, html dashboards and designs, diagrams" },
  data: { default: true, description: "Structured data sources and queries" },
  files: { default: true, description: "The instance's files: browse, search, read, write" },
  team: { default: true, description: "Agents' configuration: read, create, update (changes need admin scope)" },
  config: { default: true, description: "Settings, branding, providers and models (changes need admin scope)" },
  admin: { default: false, description: "Read-only REST fallback: polpo_api_search, polpo_api_get" },
} as const;

export type ToolsetName = keyof typeof TOOLSETS;
export const TOOLSET_NAMES = Object.keys(TOOLSETS) as ToolsetName[];
export const DEFAULT_TOOLSETS: ToolsetName[] = TOOLSET_NAMES.filter((n) => TOOLSETS[n].default);

/**
 * The toolsets to offer: a configured list (names, "all", "default"), else the defaults. Unknown
 * names are ignored; a list that names none falls back to the defaults.
 */
export function resolveToolsets(...sources: Array<string | readonly string[] | undefined | null>): ToolsetName[] {
  for (const source of sources) {
    if (source === undefined || source === null) continue;
    const names = (typeof source === "string" ? source.split(",") : [...source]).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (names.length === 0) continue;
    const out = new Set<ToolsetName>();
    for (const name of names) {
      if (name === "all") TOOLSET_NAMES.forEach((n) => out.add(n));
      else if (name === "default") DEFAULT_TOOLSETS.forEach((n) => out.add(n));
      else if ((TOOLSET_NAMES as string[]).includes(name)) out.add(name as ToolsetName);
    }
    if (out.size > 0) return TOOLSET_NAMES.filter((n) => out.has(n));
  }
  return [...DEFAULT_TOOLSETS];
}

/** Toolsets whose writes change the instance itself: they need "polpo:admin". */
const ADMIN_WRITES = new Set<string>(["admin", "config", "team"]);

/** The scope a tool needs: reads "polpo:read" (the admin toolset "polpo:admin"), writes "polpo:work" or, for the instance's own setup, "polpo:admin". */
export function scopeFor(toolset: ToolsetName, annotations: ToolAnnotations): string {
  if (toolset === "admin") return "polpo:admin";
  if (annotations.readOnlyHint) return "polpo:read";
  return ADMIN_WRITES.has(toolset) ? "polpo:admin" : "polpo:work";
}

/** Does a principal hold a scope? "polpo" holds all; admin implies work; any polpo:* implies read. */
export function hasScope(principal: McpPrincipal, scope: string): boolean {
  const s = new Set(principal.scopes);
  if (s.has("polpo") || s.has(scope)) return true;
  if (scope === "polpo:work" && s.has("polpo:admin")) return true;
  if (scope === "polpo:read") return [...s].some((x) => x.startsWith("polpo:"));
  return false;
}

// ── Results ──────────────────────────────────────────────────────────

/** A result with a short text for the model and the same data as structured content. */
export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: clip(text) }], ...(structured ? { structuredContent: structured } : {}) };
}

/** An error the model can act on: say what went wrong and what to do next. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function clip(value: unknown): string {
  const out = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n… (${out.length - MAX_RESULT_CHARS} more characters cut; ask for less)` : out;
}

/** Shorten a string for one-line listings. */
export function short(s: unknown, n = 120): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A size for people: 12 KB, 3.4 MB. */
export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── API helpers ──────────────────────────────────────────────────────

export type Unwrapped = { ok: true; data: unknown; status: number } | { ok: false; error: string; status: number; code?: string };

/** The `data` of an `{ ok, data }` answer, or an error for anything else. */
export function unwrap(res: ApiResponse): Unwrapped {
  const body = res.body as { ok?: boolean; data?: unknown; error?: unknown; code?: unknown } | null;
  if (res.status >= 400 || (body && typeof body === "object" && body.ok === false)) {
    const raw = body && typeof body === "object"
      ? (typeof body.error === "string" ? body.error : (body.error as { message?: string } | undefined)?.message ?? JSON.stringify(body.error ?? body))
      : String(res.body);
    return { ok: false, error: raw, status: res.status, ...(typeof body?.code === "string" ? { code: body.code } : {}) };
  }
  return { ok: true, data: body && typeof body === "object" && "data" in body ? body.data : res.body, status: res.status };
}

/** GET /api/v1{path}. */
export async function apiGet(deps: McpDeps, path: string): Promise<Unwrapped> {
  return unwrap(await deps.api("GET", `/api/v1${path}`));
}

/** A write to /api/v1{path}. */
export async function apiSend(deps: McpDeps, method: string, path: string, body?: unknown): Promise<Unwrapped> {
  return unwrap(await deps.api(method, `/api/v1${path}`, body));
}

/** An API error as a message with a next step. */
export function apiError(r: { error: string; status: number }, what: string, hint?: string): CallToolResult {
  const next = hint ?? (r.status === 404 ? "Check the id or name (list it first)." : r.status === 401 || r.status === 403 ? "This connection is not allowed to do this." : r.status >= 500 ? "The server failed: try again later." : "Fix the input and try again.");
  return fail(`${what} failed (HTTP ${r.status}): ${r.error}. ${next}`);
}

/** A query string from defined values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const enc = encodeURIComponent;

// ── Pagination ───────────────────────────────────────────────────────

export const limitParam = (def = 20, max = 100) => z.number().int().min(1).max(max).optional()
  .describe(`How many items per page (default ${def}, max ${max})`);
export const cursorParam = () => z.string().optional()
  .describe("Pass next_cursor from the previous page to get the next one; omit for the first page");

/** An opaque cursor for a position (offset or a server cursor). */
export function encodeCursor(value: { o?: number; u?: string }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { o?: number; u?: string } | null {
  if (!cursor) return {};
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown; u?: unknown };
    const out: { o?: number; u?: string } = {};
    if (typeof v.o === "number" && Number.isInteger(v.o) && v.o >= 0) out.o = v.o;
    if (typeof v.u === "string") out.u = v.u;
    return out;
  } catch {
    return null;
  }
}

export const BAD_CURSOR = "That cursor is not valid: pass next_cursor exactly as returned, or omit it for the first page.";

/** One page of an in-memory list. */
export function page<T>(items: T[], limit: number, cursor: string | undefined): { items: T[]; next_cursor: string | null; total: number } | null {
  const c = decodeCursor(cursor);
  if (!c) return null;
  const start = c.o ?? 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? encodeCursor({ o: start + limit }) : null;
  return { items: slice, next_cursor: next, total: items.length };
}

/** Output schema pieces. */
export const pageOutput = <T extends z.ZodTypeAny>(item: T) => ({
  items: z.array(item),
  next_cursor: z.string().nullable().describe("Pass it as cursor for the next page; null when this is the last page"),
  total: z.number().int().optional().describe("How many items match, when known"),
});

// ── Registration ─────────────────────────────────────────────────────

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolSpec<I extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: I;
  outputSchema?: z.ZodRawShape;
  annotations: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export type Register = <I extends z.ZodRawShape>(
  toolset: ToolsetName,
  name: string,
  spec: ToolSpec<I>,
  handler: (args: z.infer<z.ZodObject<I>>, extra: ToolExtra) => Promise<CallToolResult>,
) => void;

/**
 * A registrar that adds a tool only when its toolset is on and the principal holds its scope.
 * Handlers that throw become an isError result (the SDK does that), so tools return fail() for
 * expected errors and let unexpected ones surface.
 */
export function registrar(server: McpServer, enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal): Register {
  return (toolset, name, spec, handler) => {
    if (!enabled.has(toolset) || !hasScope(principal, scopeFor(toolset, spec.annotations))) return;
    server.registerTool(name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      annotations: { title: spec.title, ...spec.annotations },
      ...(spec._meta ? { _meta: spec._meta } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's generic callback type
    }, handler as any);
  };
}

/** Is this tool allowed for the principal and the toolsets (for app tools registered elsewhere)? */
export function allowed(enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal, toolset: ToolsetName, annotations: ToolAnnotations): boolean {
  return enabled.has(toolset) && hasScope(principal, scopeFor(toolset, annotations));
}

// Annotation presets (every tool also gets its title)
export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

// ── Progress and waiting ─────────────────────────────────────────────

/** Send a progress notification when the client asked for it (a progressToken). */
export async function progress(extra: ToolExtra | undefined, value: number, total: number | undefined, message: string): Promise<void> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken: token, progress: value, ...(total !== undefined ? { total } : {}), message },
  }).catch(() => {});
}

/** Sleep, cut short when the request is cancelled. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Most a wait tool blocks, so it stays under clients' tool timeouts (60 s is common). */
export const MAX_WAIT_SECONDS = 55;

export const confirmParam = (what: string) => z.boolean().optional()
  .describe(`Must be true to ${what}: ask the person first, then call again with confirm: true`);

/** Shared zod pieces. */
export const looseObject = z.object({}).passthrough();

export type { CallToolResult };
