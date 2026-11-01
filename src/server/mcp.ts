/**
 * Polpo as an MCP server: Claude Code, Codex, Claude, ChatGPT and any MCP client use the instance
 * through a small set of tools designed for what people do (ask Polpo, chat with an agent, tasks,
 * missions, artifacts, data, approvals, files) plus two that reach every REST operation (list_operations,
 * call_operation), instead of one tool per endpoint, which would cost tens of thousands of tokens of
 * definitions and make models choose worse.
 *
 * Streamable HTTP at /mcp, stateless (a server per request, no sessions): every tool calls the
 * instance's own REST API in process, so it follows the same rules as the dashboard.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { agentCardText, buildAgentCard, type AgentCard } from "./mcp-agent-card.js";
import { AGENT_CARD_HTML } from "./mcp-widgets.generated.js";

export interface ApiResponse {
  status: number;
  /** Parsed JSON, or the text when the body is not JSON. */
  body: unknown;
  headers: Headers;
  /** The raw body, for files. */
  bytes?: Uint8Array;
}

export interface McpDeps {
  /** A call to the instance's own HTTP API (a path from the server root, e.g. /api/v1/tasks), in process; a FormData body goes as multipart, anything else as JSON. */
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse>;
  version: string;
  /** Logs one line per MCP message (no contents). */
  log?: (line: string) => void;
  /** Every route the server has registered (method, path with :params): the ones the OpenAPI document does not describe are reachable too. */
  routes?: () => Array<{ method: string; path: string }>;
}

/** Longest tool result returned to the model; the rest is cut with a note. */
export const MAX_RESULT_CHARS = 40_000;
/** Largest image or PDF returned inline by read_file. */
export const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function clip(value: unknown): string {
  const out = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n… (${out.length - MAX_RESULT_CHARS} more characters cut; ask for less)` : out;
}

/** The `data` of an `{ ok, data }` answer, or an error for anything else. */
function unwrap(res: ApiResponse): { ok: true; data: unknown } | { ok: false; error: string } {
  const body = res.body as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (res.status >= 400 || (body && body.ok === false)) {
    const err = body && typeof body === "object" ? (typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? body)) : String(res.body);
    return { ok: false, error: `HTTP ${res.status}: ${err}` };
  }
  return { ok: true, data: body && typeof body === "object" && "data" in body ? body.data : res.body };
}

async function get(deps: McpDeps, path: string) {
  const r = unwrap(await deps.api("GET", `/api/v1${path}`));
  return r.ok ? text(clip(r.data)) : fail(r.error);
}

async function send(deps: McpDeps, method: string, path: string, body?: unknown) {
  const r = unwrap(await deps.api(method, `/api/v1${path}`, body));
  return r.ok ? text(clip(r.data)) : fail(r.error);
}

/** One chat turn with Polpo (no agent) or an agent: the conversation continues with session_id. */
async function chatTurn(deps: McpDeps, message: string, agent: string | undefined, sessionId: string | undefined) {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (sessionId) {
    const r = unwrap(await deps.api("GET", `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`));
    if (!r.ok) return fail(`Could not load session ${sessionId}: ${r.error}`);
    const messages = (Array.isArray(r.data) ? r.data : (r.data as { messages?: unknown[] })?.messages ?? []) as Array<{ role: string; content: unknown }>;
    for (const m of messages) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) history.push({ role: m.role, content: m.content });
    }
  }
  const res = await deps.api("POST", "/v1/chat/completions", {
    stream: false,
    ...(agent ? { agent } : {}),
    messages: [...history, { role: "user", content: message }],
  }, { "x-session-id": sessionId ?? "new" });
  const body = res.body as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string; code?: string } } | null;
  if (res.status === 409) return fail("This conversation is still answering an earlier message: wait and try again, or start a new one (omit session_id).");
  if (res.status >= 400) return fail(`HTTP ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  const reply = body?.choices?.[0]?.message?.content;
  const session = res.headers.get("x-session-id") ?? sessionId ?? "";
  return {
    content: [{ type: "text" as const, text: `${typeof reply === "string" && reply.trim() ? reply : "(no text reply)"}\n\n[session_id: ${session} — pass it to continue this conversation]` }],
    structuredContent: { reply: typeof reply === "string" ? reply : "", session_id: session },
  };
}

/** A size for people: 12 KB, 3.4 MB. */
function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The text of a file, or null when it is binary (NUL bytes, or not UTF-8). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The agent card's UI (an MCP App): one HTML document, served as a ui:// resource. */
export const AGENT_CARD_URI = "ui://polpo/agent-card.html";
let cardSeq = 0;

/** An agent's card from the instance's API (agent, tasks, drive). */
async function loadAgentCard(deps: McpDeps, name: string): Promise<{ ok: true; card: AgentCard } | { ok: false; error: string }> {
  const agents = unwrap(await deps.api("GET", "/api/v1/agents"));
  if (!agents.ok) return agents;
  const list = (agents.data as AgentCardAgent[]) ?? [];
  const agent = list.find((a) => a.name === name) ?? list.find((a) => a.name.toLowerCase() === name.toLowerCase() || a.identity?.displayName?.toLowerCase() === name.toLowerCase());
  if (!agent) return { ok: false, error: `No agent "${name}". Agents: ${list.map((a) => a.name).join(", ") || "none"}` };
  const [tasks, drive] = await Promise.all([
    deps.api("GET", "/api/v1/tasks").then(unwrap),
    deps.api("GET", `/api/v1/drive/${encodeURIComponent(agent.name)}`).then(unwrap),
  ]);
  const card = buildAgentCard({
    agent,
    tasks: tasks.ok ? (tasks.data as Parameters<typeof buildAgentCard>[0]["tasks"]) ?? [] : [],
    ...(drive.ok ? { drive: drive.data as Parameters<typeof buildAgentCard>[0]["drive"] } : {}),
    now: new Date(),
    key: { createdAt: Date.now(), seq: ++cardSeq },
  });
  return { ok: true, card };
}
type AgentCardAgent = Parameters<typeof buildAgentCard>[0]["agent"];

const cardResult = (card: AgentCard) => ({
  content: [{ type: "text" as const, text: agentCardText(card) }],
  structuredContent: card as unknown as Record<string, unknown>,
});

interface Operation { method: string; path: string; summary: string; tags: string[] }

/** The REST operations, from the instance's OpenAPI document (paths relative to /api/v1). */
async function operations(deps: McpDeps): Promise<Operation[]> {
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
  // routes registered without an OpenAPI description (artifacts, drive, learning…)
  const known = new Set(ops.map((o) => `${o.method} ${o.path}`));
  for (const route of deps.routes?.() ?? []) {
    const method = route.method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !route.path.startsWith("/api/v1/") || route.path.includes("*")) continue;
    const path = route.path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/+$/, "") || "/";
    const key = `${method} ${path}`;
    if (known.has(key)) continue;
    known.add(key);
    ops.push({ method, path, summary: "", tags: [path.split("/")[1] ?? ""] });
  }
  return ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Does a concrete path ("/tasks/abc") match a templated one ("/tasks/{taskId}")? */
export function matchesOperationPath(template: string, path: string): boolean {
  const t = template.split("/");
  const p = path.split("/");
  return t.length === p.length && t.every((seg, i) => (/^\{.+\}$/.test(seg) ? p[i]!.length > 0 : seg === p[i]));
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** The MCP server for one request (stateless). */
export function createPolpoMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "polpo", title: "Polpo", version: deps.version },
    {
      instructions: "Polpo orchestrates a team of AI agents (tasks, missions, artifacts, data, approvals, files). "
        + "For anything open-ended, ask_polpo delegates to Polpo itself, which can do everything the instance can. "
        + "Use the specific tools for quick reads and actions, and list_operations / call_operation for any other REST endpoint.",
    },
  );

  server.registerTool("ask_polpo", {
    title: "Ask Polpo",
    description: "Ask Polpo, the orchestrator, in natural language: plan and run work, create tasks or missions, manage agents, "
      + "query data, make artifacts — anything the instance can do. Returns its reply and a session_id to continue the conversation.",
    inputSchema: { message: z.string().min(1), session_id: z.string().optional().describe("Continue an earlier conversation") },
    annotations: { ...writes, openWorldHint: true },
  }, async ({ message, session_id }) => chatTurn(deps, message, undefined, session_id));

  server.registerTool("chat_with_agent", {
    title: "Chat with an agent",
    description: "Send a message to one agent (list_agents) and get its reply; it works with its own tools, memory and skills. "
      + "Returns a session_id to continue the conversation.",
    inputSchema: { agent: z.string().min(1), message: z.string().min(1), session_id: z.string().optional() },
    annotations: { ...writes, openWorldHint: true },
  }, async ({ agent, message, session_id }) => chatTurn(deps, message, agent, session_id));

  server.registerTool("list_agents", {
    title: "List agents",
    description: "The agents of the instance: name, role, model.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const r = unwrap(await deps.api("GET", "/api/v1/agents"));
    if (!r.ok) return fail(r.error);
    const agents = (r.data as Array<{ name: string; role?: string; model?: string; identity?: { title?: string } }>) ?? [];
    return text(agents.map((a) => `- ${a.name}${a.role ? `: ${a.role}` : ""}${a.model ? ` (${a.model})` : ""}`).join("\n") || "No agents.");
  });

  server.registerTool("list_tasks", {
    title: "List tasks",
    description: "Tasks, newest first: id, title, status, agent. Filter by status or agent.",
    inputSchema: {
      status: z.enum(["draft", "pending", "awaiting_approval", "assigned", "in_progress", "review", "done", "failed"]).optional(),
      agent: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: readOnly,
  }, async ({ status, agent, limit }) => {
    const r = unwrap(await deps.api("GET", "/api/v1/tasks"));
    if (!r.ok) return fail(r.error);
    const tasks = ((r.data as Array<{ id: string; title: string; status: string; assignTo: string; group?: string; updatedAt?: string }>) ?? [])
      .filter((t) => (!status || t.status === status) && (!agent || t.assignTo === agent))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, limit ?? 50);
    return text(tasks.map((t) => `- ${t.id} [${t.status}] ${t.title} → ${t.assignTo}${t.group ? ` (${t.group})` : ""}`).join("\n") || "No tasks.");
  });

  server.registerTool("get_task", {
    title: "Get a task",
    description: "A task with its description, status, result and assessment.",
    inputSchema: { id: z.string().min(1) },
    annotations: readOnly,
  }, async ({ id }) => get(deps, `/tasks/${encodeURIComponent(id)}`));

  server.registerTool("create_task", {
    title: "Create a task",
    description: "Give an agent a task: it runs on its own and is assessed when done (get_task to follow it).",
    inputSchema: {
      title: z.string().min(1),
      description: z.string().min(1).describe("What to do and what a good result looks like"),
      assignTo: z.string().min(1).describe("Agent name (list_agents)"),
      dependsOn: z.array(z.string()).optional().describe("Task ids that must finish first"),
    },
    annotations: writes,
  }, async (args) => send(deps, "POST", "/tasks", args));

  server.registerTool("list_missions", {
    title: "List missions",
    description: "Missions (plans of tasks): id, name, status.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const r = unwrap(await deps.api("GET", "/api/v1/missions"));
    if (!r.ok) return fail(r.error);
    const missions = (r.data as Array<{ id: string; name: string; status: string; updatedAt?: string }>) ?? [];
    return text(missions.map((m) => `- ${m.id} [${m.status}] ${m.name}`).join("\n") || "No missions.");
  });

  server.registerTool("get_mission", {
    title: "Get a mission",
    description: "A mission with its plan and status.",
    inputSchema: { id: z.string().min(1) },
    annotations: readOnly,
  }, async ({ id }) => get(deps, `/missions/${encodeURIComponent(id)}`));

  server.registerTool("list_artifacts", {
    title: "List artifacts",
    description: "Artifacts (documents, html dashboards and designs, diagrams), newest first.",
    inputSchema: { type: z.enum(["doc", "html", "svg", "mermaid", "view"]).optional(), q: z.string().optional() },
    annotations: readOnly,
  }, async ({ type, q }) => {
    const params = new URLSearchParams(Object.entries({ type, q }).filter(([, v]) => v) as [string, string][]);
    const r = unwrap(await deps.api("GET", `/api/v1/artifacts${params.size ? `?${params}` : ""}`));
    if (!r.ok) return fail(r.error);
    const items = (r.data as Array<{ id: string; title: string; type: string; kind?: string; createdBy: string; version: number }>) ?? [];
    return text(items.map((a) => `- ${a.id} [${a.type}${a.kind ? `/${a.kind}` : ""}] ${a.title} — by ${a.createdBy}, v${a.version}`).join("\n") || "No artifacts.");
  });

  server.registerTool("get_artifact", {
    title: "Get an artifact",
    description: "An artifact's content and details.",
    inputSchema: { id: z.string().min(1) },
    annotations: readOnly,
  }, async ({ id }) => get(deps, `/artifacts/${encodeURIComponent(id)}`));

  server.registerTool("create_artifact", {
    title: "Create an artifact",
    description: "Make an artifact people open in Polpo: a doc (Markdown), an html page (dashboard, design, report: self-contained; "
      + "it reads data through window.polpo.query/sql), an svg or a mermaid diagram.",
    inputSchema: {
      title: z.string().min(1),
      type: z.enum(["doc", "html", "svg", "mermaid"]),
      content: z.string().min(1),
      kind: z.string().optional().describe("For html: dashboard, design, app, report, page"),
      description: z.string().optional(),
    },
    annotations: writes,
  }, async (args) => send(deps, "POST", "/artifacts", args));

  server.registerTool("list_data_sources", {
    title: "List data sources",
    description: "The structured data sources (databases, APIs, files) the instance can query.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    const r = unwrap(await deps.api("GET", "/api/v1/data"));
    if (!r.ok) return fail(r.error);
    const sources = (r.data as Array<{ id: string; name: string; kind: string; description?: string }>) ?? [];
    return text(sources.map((s) => `- ${s.id} ${s.name} (${s.kind})${s.description ? `: ${s.description}` : ""}`).join("\n") || "No data sources.");
  });

  server.registerTool("query_data", {
    title: "Query data",
    description: "Read rows from a data source's dataset (GET /data/{id}/schema via call_operation lists datasets and fields).",
    inputSchema: {
      sourceId: z.string().min(1),
      dataset: z.string().min(1),
      fields: z.array(z.string()).optional(),
      filters: z.array(z.object({
        field: z.string(),
        operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "in", "isNull"]),
        value: z.unknown().optional(),
      })).optional(),
      sort: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    annotations: readOnly,
  }, async (args) => send(deps, "POST", "/data/query", args));

  server.registerTool("list_approvals", {
    title: "List approvals",
    description: "Requests waiting for a person's decision (or all, with status).",
    inputSchema: { status: z.enum(["pending", "approved", "rejected", "timeout"]).optional() },
    annotations: readOnly,
  }, async ({ status }) => get(deps, `/approvals?status=${status ?? "pending"}`));

  server.registerTool("resolve_approval", {
    title: "Approve or reject",
    description: "Decide on an approval request: approve (optional note) or reject (feedback required).",
    inputSchema: { id: z.string().min(1), decision: z.enum(["approve", "reject"]), note: z.string().optional() },
    annotations: { ...writes, destructiveHint: true },
  }, async ({ id, decision, note }) => {
    if (decision === "reject" && !note?.trim()) return fail("Rejecting needs a note with the feedback.");
    return send(deps, "POST", `/approvals/${encodeURIComponent(id)}/${decision}`,
      decision === "approve" ? { resolvedBy: "mcp", ...(note ? { note } : {}) } : { resolvedBy: "mcp", feedback: note });
  });

  // ── The agent card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) ──

  registerAppResource(server, "Agent card", AGENT_CARD_URI, {
    description: "An agent's card: status, the task at hand, today, what is next, its main goal; full screen, its tasks, goals and routine.",
  }, async () => ({
    contents: [{
      uri: AGENT_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: AGENT_CARD_HTML,
      // everything is in the document; the host's font (Claude) is the only origin it loads from
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(server, "show_agent", {
    title: "Show an agent",
    description: "Show one agent's card: whether it is working, the task at hand, today's results, what it plans next "
      + "and its main goal; it opens to its tasks, goals and routine. Use it when the person asks about an agent (list_agents for names).",
    inputSchema: { agent: z.string().min(1).describe("Agent name") },
    annotations: readOnly,
    _meta: { ui: { resourceUri: AGENT_CARD_URI } },
  }, async ({ agent }) => {
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : fail(r.error);
  });

  registerAppTool(server, "agent_card_refresh", {
    title: "Refresh an agent card",
    description: "The agent card's own refresh (called by its UI).",
    inputSchema: { agent: z.string().min(1) },
    annotations: readOnly,
    _meta: { ui: { resourceUri: AGENT_CARD_URI, visibility: ["app"] } },
  }, async ({ agent }) => {
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : fail(r.error);
  });

  registerAppTool(server, "agent_intention_decide", {
    title: "Confirm or cancel an agent's plan",
    description: "From the agent card: confirm an intention the agent proposed, or cancel one (called by its UI).",
    inputSchema: { agent: z.string().min(1), id: z.string().min(1), action: z.enum(["confirm", "cancel"]) },
    annotations: { ...writes, destructiveHint: true },
    _meta: { ui: { resourceUri: AGENT_CARD_URI, visibility: ["app"] } },
  }, async ({ agent, id, action }) => {
    const done = unwrap(await deps.api("POST", `/api/v1/drive/${encodeURIComponent(agent)}/intentions/${encodeURIComponent(id)}/${action}`));
    if (!done.ok) return fail(done.error);
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : text(`${action}: ${id} done.`);
  });

  // ── Files: the instance's workspace, .polpo and volumes, as in the dashboard's Files page ──

  server.registerTool("list_files", {
    title: "List files",
    description: "List a folder of the instance (the agents' workspace, .polpo, volumes). Without path: the roots. "
      + "Paths are relative to the workspace (e.g. reports/2026, .polpo/output).",
    inputSchema: { path: z.string().optional().describe("Folder; omit for the roots") },
    annotations: readOnly,
  }, async ({ path }) => {
    if (!path) {
      const r = unwrap(await deps.api("GET", "/api/v1/files/roots"));
      if (!r.ok) return fail(r.error);
      const roots = ((r.data as { roots?: Array<{ name: string; path: string; description?: string; totalFiles?: number; readOnly?: boolean }> })?.roots) ?? [];
      return text(roots.map((x) => `- ${x.path}  (${x.name}${x.description ? `: ${x.description}` : ""}${x.totalFiles !== undefined ? `, ${x.totalFiles} files` : ""}${x.readOnly ? ", read-only" : ""})`).join("\n") || "No roots.");
    }
    const r = unwrap(await deps.api("GET", `/api/v1/files/list?path=${encodeURIComponent(path)}`));
    if (!r.ok) return fail(r.error);
    const data = r.data as { path: string; entries: Array<{ name: string; type: string; size?: number; modifiedAt?: string }> };
    const lines = data.entries.map((e) => e.type === "directory" ? `${e.name}/` : `${e.name}  ${formatBytes(e.size)}${e.modifiedAt ? `  ${e.modifiedAt.slice(0, 16).replace("T", " ")}` : ""}`);
    return text(clip(`${data.path}/\n${lines.join("\n") || "(empty)"}`));
  });

  server.registerTool("search_files", {
    title: "Search files",
    description: "Find files and folders whose name or path contains the words, under a folder (default: the workspace).",
    inputSchema: { q: z.string().min(1), root: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: readOnly,
  }, async ({ q, root, limit }) => {
    const params = new URLSearchParams({ q, ...(root ? { root } : {}), limit: String(limit ?? 100) });
    const r = unwrap(await deps.api("GET", `/api/v1/files/search?${params}`));
    if (!r.ok) return fail(r.error);
    const results = (r.data as { files?: Array<{ path: string; type: string }> })?.files ?? [];
    return text(clip(results.map((x) => `${x.path}${x.type === "directory" ? "/" : ""}`).join("\n") || "Nothing found."));
  });

  server.registerTool("read_file", {
    title: "Read a file",
    description: "Read a file of the instance: text (with a line range for long files), images and PDFs as they are; "
      + "other binary files are described.",
    inputSchema: {
      path: z.string().min(1),
      from_line: z.number().int().min(1).optional().describe("First line, for long text files"),
      lines: z.number().int().min(1).max(5000).optional().describe("How many lines (default 2000)"),
    },
    annotations: readOnly,
  }, async ({ path, from_line, lines }) => {
    const res = await deps.api("GET", `/api/v1/files/read?path=${encodeURIComponent(path)}`);
    if (res.status >= 400) return fail(unwrap(res).ok ? `HTTP ${res.status}` : (unwrap(res) as { error: string }).error);
    const bytes = res.bytes ?? new TextEncoder().encode(typeof res.body === "string" ? res.body : JSON.stringify(res.body));
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    if ((mime.startsWith("image/") && mime !== "image/svg+xml") || mime === "application/pdf") {
      if (bytes.byteLength > MAX_INLINE_FILE_BYTES) return text(`${path}: ${mime}, ${formatBytes(bytes.byteLength)}: too large to return here (limit ${formatBytes(MAX_INLINE_FILE_BYTES)}).`);
      const data = Buffer.from(bytes).toString("base64");
      return mime === "application/pdf"
        ? { content: [{ type: "resource" as const, resource: { uri: `polpo-file:///${path.replace(/^\/+/, "")}`, mimeType: mime, blob: data } }] }
        : { content: [{ type: "image" as const, data, mimeType: mime }] };
    }
    const decoded = decodeText(bytes);
    if (decoded === null) return text(`${path}: binary file (${mime}, ${formatBytes(bytes.byteLength)}): not shown as text.`);
    const all = decoded.split("\n");
    const start = (from_line ?? 1) - 1;
    const count = lines ?? 2000;
    const slice = all.slice(start, start + count).join("\n");
    const more = start + count < all.length ? `\n… (lines ${start + 1}-${start + count} of ${all.length}; read on with from_line=${start + count + 1})` : "";
    return text(clip(slice) + more);
  });

  server.registerTool("write_file", {
    title: "Write a file",
    description: "Create or replace a file of the instance (folders are created). Text as is, or base64 for binary files. "
      + "It overwrites an existing file.",
    inputSchema: {
      path: z.string().min(1).describe("e.g. reports/summary.md"),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional().describe("base64 for binary content (default utf8)"),
    },
    annotations: { ...writes, destructiveHint: true },
  }, async ({ path, content, encoding }) => {
    const clean = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    const slash = clean.lastIndexOf("/");
    const dir = slash > 0 ? clean.slice(0, slash) : ".";
    const name = clean.slice(slash + 1);
    if (!name || name === "." || name === "..") return fail("The path must name a file.");
    const data = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    // into its folder when it exists (absolute paths of volumes too), else from the workspace, creating the folders
    const dirExists = dir === "." || (await deps.api("GET", `/api/v1/files/list?path=${encodeURIComponent(dir)}`)).status === 200;
    if (!dirExists && path.startsWith("/")) return fail(`Folder ${dir} not found.`);
    const form = new FormData();
    form.append("path", dirExists ? dir : ".");
    form.append("file", new File([data], name));
    form.append("relativePath", dirExists ? name : clean);
    const r = unwrap(await deps.api("POST", "/api/v1/files/upload", form));
    if (!r.ok) return fail(r.error);
    const done = r.data as { count?: number; excluded?: { count: number; reasons: string[] } };
    if (!done.count) return fail(`Not written: ${done.excluded?.reasons?.join(", ") || "excluded"}`);
    return text(`Wrote ${clean} (${formatBytes(data.byteLength)}).`);
  });

  server.registerTool("manage_file", {
    title: "Make a folder, rename or delete",
    description: "Make a folder (mkdir), rename a file or folder in place (rename, with new_name), or delete one (delete; "
      + "a folder that is not empty needs recursive: true).",
    inputSchema: {
      action: z.enum(["mkdir", "rename", "delete"]),
      path: z.string().min(1),
      new_name: z.string().optional().describe("For rename: the new name, without folders"),
      recursive: z.boolean().optional().describe("For delete: also a folder with contents"),
    },
    annotations: { ...writes, destructiveHint: true },
  }, async ({ action, path, new_name, recursive }) => {
    if (action === "rename" && !new_name) return fail("rename needs new_name.");
    const body = action === "mkdir" ? { path } : action === "rename" ? { path, newName: new_name } : { path, recursive: recursive === true };
    const r = unwrap(await deps.api("POST", `/api/v1/files/${action}`, body));
    return r.ok ? text(`${action}: ${path}${action === "rename" ? ` → ${new_name}` : ""} done.`) : fail(r.error);
  });

  server.registerTool("list_operations", {
    title: "List API operations",
    description: "Every operation of Polpo's REST API (method, path, summary), to use with call_operation. Filter by words or tag.",
    inputSchema: { q: z.string().optional().describe("Words in the path or summary"), tag: z.string().optional() },
    annotations: readOnly,
  }, async ({ q, tag }) => {
    const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const ops = (await operations(deps)).filter((o) => (!tag || o.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
      && words.every((w) => `${o.path} ${o.summary}`.toLowerCase().includes(w)));
    if (ops.length === 0) return text("No operations match.");
    return text(clip(ops.map((o) => `${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ""}`).join("\n")));
  });

  server.registerTool("call_operation", {
    title: "Call an API operation",
    description: "Call any operation of Polpo's REST API (list_operations shows them): method, path relative to /api/v1 "
      + "with the ids filled in (e.g. /tasks/abc123/retry), optional query and JSON body.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().min(1).describe("e.g. /tasks or /missions/{id} with the id filled in"),
      query: z.record(z.string(), z.string()).optional(),
      body: z.unknown().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ method, path, query, body }) => {
    const clean = `/${path.replace(/^\/?(api\/v1\/?)?/, "")}`.replace(/\/+$/, "") || "/";
    if (clean.includes("..")) return fail("Invalid path");
    const ops = await operations(deps);
    if (!ops.some((o) => o.method === method && matchesOperationPath(o.path, clean))) {
      const same = ops.filter((o) => matchesOperationPath(o.path, clean)).map((o) => o.method);
      return fail(same.length ? `${method} is not allowed on ${clean} (allowed: ${same.join(", ")})` : `No operation ${method} ${clean}: use list_operations`);
    }
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
    const res = await deps.api(method, `/api/v1${clean}${qs}`, method === "GET" || method === "DELETE" ? undefined : body);
    const out = clip(res.body);
    return res.status >= 400 ? fail(`HTTP ${res.status}: ${out}`) : text(out);
  });

  return server;
}

/** One line per MCP message, without contents: who connects (and whether it shows apps), which tools and resources it uses. */
export function describeMcpMessages(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const out: string[] = [];
  for (const m of messages as Array<{ method?: unknown; params?: Record<string, unknown> } | null>) {
    if (!m || typeof m.method !== "string" || m.method.startsWith("notifications/")) continue;
    const p = m.params ?? {};
    if (m.method === "initialize") {
      const info = p.clientInfo as { name?: string; version?: string } | undefined;
      const ext = (p.capabilities as { extensions?: Record<string, { mimeTypes?: string[] }> } | undefined)?.extensions?.["io.modelcontextprotocol/ui"];
      out.push(`initialize ${info?.name ?? "?"} ${info?.version ?? ""} (protocol ${String(p.protocolVersion ?? "?")}; apps: ${ext ? (ext.mimeTypes ?? []).join(",") || "yes" : "no"})`);
    } else if (m.method === "tools/call") {
      out.push(`tools/call ${String(p.name)}`);
    } else if (m.method === "resources/read") {
      out.push(`resources/read ${String(p.uri)}`);
    } else {
      out.push(m.method);
    }
  }
  return out;
}

/** Handle one MCP request (Streamable HTTP, stateless, JSON responses). */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  if (deps.log && request.method === "POST") {
    const lines = describeMcpMessages(await request.clone().json().catch(() => null));
    for (const line of lines) deps.log(line);
  }
  const server = createPolpoMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close().catch(() => {});
  }
}
