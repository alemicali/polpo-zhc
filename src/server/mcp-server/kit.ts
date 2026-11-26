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
  /** Granted scopes (see SCOPES); "polpo", the old all-in-one scope, still means every scope. */
  scopes: string[];
  /** An MCP key's name (settings.mcp.keys), for the dashboard and logs. */
  keyName?: string;
}

/** A principal that may do everything (tests, local stdio). */
export const FULL_ACCESS: McpPrincipal = { kind: "open", actor: "mcp", scopes: ["polpo:admin"] };

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
  /** The instance's public URL (the API's origin), for links to its files and assets. */
  publicUrl?: string;
  /**
   * The dashboard's public URL (POLPO_DASHBOARD_URL, else POLPO_UI_PUBLIC_URL), for links where a
   * person enters a secret; without it, publicUrl (the dashboard on the API's origin).
   */
  dashboardUrl?: string;
  /** How often wait tools look again (ms, default 1000). */
  pollIntervalMs?: number;
  /** For fetching remote files (logo URLs); default: global fetch. */
  fetch?: typeof fetch;
  /** Name resolution for the private-address guard; default: DNS. */
  resolveHost?: ResolveHost;
  /** Allow fetching from private addresses (tests only). */
  allowPrivateFetch?: boolean;
  /** The protected resource metadata URL, named in the 403 for a missing scope (step-up). */
  resourceMetadataUrl?: string;
}

/** Longest tool result returned to the model; the rest is cut with a note. */
export const MAX_RESULT_CHARS = 40_000;

// ── Toolsets and scopes ──────────────────────────────────────────────

export const TOOLSETS = {
  core: { default: true, description: "Ask Polpo (and answer its questions and previews), chat with agents, agents, approvals" },
  tasks: { default: true, description: "Tasks: list, read, create, update, retry, kill, direct, wait, logs" },
  missions: { default: true, description: "Missions and playbooks: list, read, create, update, run, abort, wait" },
  artifacts: { default: true, description: "Artifacts: documents, html dashboards and designs, diagrams" },
  data: { default: true, description: "Data sources (schema, test, activity, who may use them; changes need admin scope), queries, read-only SQL, row changes, data views" },
  files: { default: true, description: "The instance's files: browse, search, read, write (writes need files scope)" },
  team: { default: true, description: "Agents and teams: read, create, update, delete, avatars (changes need admin scope)" },
  config: { default: true, description: "Settings (general ones too), branding and appearance, providers and models (changes need admin scope)" },
  rooms: { default: true, description: "Group chats of people and agents: rooms, their messages, posting and waiting for replies" },
  chat: { default: true, description: "Chat sessions with Polpo and agents: list, read, rename, star, delete" },
  memory: { default: true, description: "Shared and per-agent memory: read, write, clear" },
  skills: { default: true, description: "Skills: list, read, create, update, install, delete, assign to agents (changes need admin scope)" },
  automation: { default: true, description: "Mission schedules (run now, pause, resume) and recurring checks" },
  connectors: { default: true, description: "Connectors (MCP servers agents use): catalog, add, access, test, OAuth link (changes need connectors scope)" },
  channels: { default: true, description: "Notification channels, rules and history; send a message on any channel (Telegram, WhatsApp, email, Slack, WhatsApp Business, webhook, push) (sending needs messages scope, rules admin scope)" },
  computers: { default: true, description: "Computers (persistent machines agents work on): live status, create, start, stop, reset, delete (changes need computers scope)" },
  coding: { default: true, description: "Coding chats: Claude Code and Codex sessions in a git worktree on the person's own CLI account (list, start, send, stop, approve or deny risky actions, the transcript card)" },
  settings: { default: true, description: "The rest of Configuration: sandbox, policies (approval gates, escalation, SLA), members, MCP access, cloud sync, custom LLM providers, channels end to end (setup with write-only secrets, routes, Telegram invites, pairings and allowlist, WhatsApp sign-in) (changes need admin scope)" },
  brain: { default: false, description: "The company brain: search, read, save and delete entities, relations and claims" },
  learning: { default: false, description: "What agents learned: changes, review now, revert (needs admin scope)" },
  watchers: { default: false, description: "Watchers that act when a task reaches a status" },
  vault: { default: false, description: "Vault entries' names and metadata (never values), delete (needs vault scope)" },
  apps: { default: false, description: "Registered apps (start, stop, restart) and browser profiles" },
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

// ── Scopes ───────────────────────────────────────────────────────────
//
// What a caller may do. Three levels — read ⊂ work ⊂ admin — and five areas a caller with work
// (or less) may be given one by one. admin holds every area; any scope holds read. A tool needs
// exactly one scope (see scopeFor); a destructive tool needs the write scope of its area.

/** The scopes, in the order people see them, with what they allow in plain words. */
export const SCOPES = {
  "polpo:read": { label: "Read", description: "See tasks, missions, artifacts, data, files, agents, rooms, chats, memory, schedules, connectors, computers and settings" },
  "polpo:work": { label: "Work", description: "Ask Polpo and chat with agents; create, change, run and stop tasks, missions, artifacts, data views and rows, rooms, memory, schedules and checks; resolve approvals" },
  "polpo:files": { label: "Files", description: "Write, move and delete the instance's files" },
  "polpo:messages": { label: "Messages", description: "Send messages on any channel (Telegram, WhatsApp, email, Slack, WhatsApp Business, webhooks, push), as Polpo or an agent" },
  "polpo:connectors": { label: "Connectors", description: "Add, change, connect, disconnect and remove connectors (the services agents use)" },
  "polpo:computers": { label: "Computers", description: "Create, start, stop, reset and delete computers (they may cost money)" },
  "polpo:vault": { label: "Vault", description: "See the names of vault entries (never their values) and delete them" },
  "polpo:admin": { label: "Admin", description: "Change the instance itself: agents and teams, settings and branding, data sources and who may use them, skills, channels and their rules, learning, the read-only REST fallback; includes every scope above" },
} as const;

export type PolpoScope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as PolpoScope[];
/** Granted when a client asks for nothing in particular: read and work, not admin. */
export const DEFAULT_SCOPES: PolpoScope[] = ["polpo:read", "polpo:work"];
/** The old all-in-one scope: still accepted (it means every scope), never issued by the consent unless asked for. */
export const UMBRELLA_SCOPE = "polpo";
/** The area scopes: one capability each, on top of work or alone. */
export const AREA_SCOPES: PolpoScope[] = ["polpo:files", "polpo:messages", "polpo:connectors", "polpo:computers", "polpo:vault"];

/**
 * Scopes from a list or a space/comma-separated string: known ones, in order, read added when any
 * is there; the umbrella "polpo" becomes every scope. Unknown names are dropped.
 */
export function normalizeScopes(input: string | readonly string[] | undefined | null): PolpoScope[] {
  const names = (typeof input === "string" ? input.split(/[\s,]+/) : [...(input ?? [])]).map((s) => s.trim()).filter(Boolean);
  const set = new Set<string>();
  for (const n of names) {
    if (n === UMBRELLA_SCOPE) ALL_SCOPES.forEach((s) => set.add(s));
    else if ((ALL_SCOPES as string[]).includes(n)) set.add(n);
  }
  if (set.size > 0) set.add("polpo:read");
  return ALL_SCOPES.filter((s) => set.has(s));
}

/** Toolsets whose writes change the instance itself: they need "polpo:admin". */
const ADMIN_WRITES = new Set<string>(["admin", "config", "settings", "team", "skills", "channels", "learning"]);
/** Toolsets whose writes have a scope of their own (polpo:admin holds them too). */
const AREA_WRITES: Partial<Record<ToolsetName, PolpoScope>> = {
  files: "polpo:files", connectors: "polpo:connectors", computers: "polpo:computers", vault: "polpo:vault",
};
/** Toolsets whose reads too need their scope. */
const SCOPED_READS: Partial<Record<ToolsetName, PolpoScope>> = { admin: "polpo:admin", vault: "polpo:vault" };

/**
 * The scope a tool needs: reads "polpo:read" (the vault's "polpo:vault", the REST fallback's
 * "polpo:admin"); writes their area's scope (files, connectors, computers, vault), "polpo:admin"
 * for the instance's own setup, else "polpo:work". A tool may name another (ToolSpec.scope).
 */
export function scopeFor(toolset: ToolsetName, annotations: ToolAnnotations): PolpoScope {
  const scoped = SCOPED_READS[toolset];
  if (scoped) return scoped;
  if (annotations.readOnlyHint) return "polpo:read";
  return AREA_WRITES[toolset] ?? (ADMIN_WRITES.has(toolset) ? "polpo:admin" : "polpo:work");
}

/** Does a principal hold a scope? "polpo" and "polpo:admin" hold all; admin implies work and every area; any polpo:* implies read. */
export function hasScope(principal: Pick<McpPrincipal, "scopes">, scope: string): boolean {
  const s = new Set(principal.scopes);
  if (s.has(UMBRELLA_SCOPE) || s.has("polpo:admin") || s.has(scope)) return true;
  if (scope === "polpo:read") return [...s].some((x) => x.startsWith("polpo:"));
  return false;
}

/** One line of the tool → scope matrix (docs, the dashboard, the step-up check). */
export interface ToolScope {
  name: string;
  toolset: ToolsetName;
  scope: PolpoScope;
  readOnly: boolean;
  destructive: boolean;
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

/** The orchestrator's display name (settings.orchestratorName) for replies; "Polpo" when unknown. */
export async function orchestratorLabel(deps: McpDeps): Promise<string> {
  const r = await apiGet(deps, "/config/orchestrator").catch(() => undefined);
  const name = r?.ok ? (r.data as { name?: unknown } | undefined)?.name : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : "Polpo";
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

/**
 * One page of a list kept oldest first (a transcript), read from the newest end: the first page is
 * the latest items, next_cursor goes back to older ones.
 */
export function pageBackwards<T>(items: T[], limit: number, cursor: string | undefined): { items: T[]; next_cursor: string | null; total: number } | null {
  const c = decodeCursor(cursor);
  if (!c) return null;
  const skip = c.o ?? 0; // how many of the newest items were already returned
  const end = Math.max(0, items.length - skip);
  const start = Math.max(0, end - limit);
  return { items: items.slice(start, end), next_cursor: start > 0 ? encodeCursor({ o: items.length - start }) : null, total: items.length };
}

/** A link into the dashboard (absolute when the public URL is known). */
export function dashboardLink(deps: McpDeps, path: string): string {
  const base = deps.dashboardUrl || deps.publicUrl;
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
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
  /** The structuredContent's main fields; it is published open (more fields may come: see outputObject). */
  outputSchema?: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** The scope it needs, when not the toolset's rule (e.g. sending a message, in a toolset whose changes need admin, needs polpo:messages). */
  scope?: PolpoScope;
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
 * expected errors and let unexpected ones surface. `catalog`, when given, collects every tool of
 * an enabled toolset with its scope, offered or not (the scope matrix).
 */
export function registrar(server: McpServer, enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal, catalog?: ToolScope[]): Register {
  return (toolset, name, spec, handler) => {
    const scope = spec.scope ?? scopeFor(toolset, spec.annotations);
    if (!enabled.has(toolset)) return;
    catalog?.push({ name, toolset, scope, readOnly: !!spec.annotations.readOnlyHint, destructive: !!spec.annotations.destructiveHint });
    if (!hasScope(principal, scope)) return;
    server.registerTool(name, {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.outputSchema ? { outputSchema: outputObject(spec.outputSchema) } : {}),
      annotations: { title: spec.title, ...spec.annotations },
      ...(spec._meta ? { _meta: spec._meta } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's generic callback type
    }, handler as any);
  };
}

/**
 * A tool's output schema: the declared fields, open to others. A raw shape becomes a closed object
 * (JSON Schema additionalProperties: false), and the official MCP client rejects a result with any
 * field it does not list: one new field on the API would break the tool for every SDK client.
 */
export function outputObject(shape: z.ZodRawShape) {
  return z.object(shape).passthrough();
}

/**
 * Is this tool allowed for the principal and the toolsets (for app tools registered elsewhere)?
 * With `catalog` and the tools' names, they are added to the scope matrix.
 */
export function allowed(enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal, toolset: ToolsetName, annotations: ToolAnnotations,
  catalog?: ToolScope[], names: string[] = []): boolean {
  if (!enabled.has(toolset)) return false;
  const scope = scopeFor(toolset, annotations);
  for (const name of names) catalog?.push({ name, toolset, scope, readOnly: !!annotations.readOnlyHint, destructive: !!annotations.destructiveHint });
  return hasScope(principal, scope);
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
