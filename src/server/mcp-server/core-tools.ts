/**
 * Agents, approvals, artifacts, data and files.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentCardText, buildAgentCard, type AgentCard } from "../mcp-agent-card.js";
import { AGENT_CARD_HTML } from "../mcp-widgets.generated.js";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, WRITE, allowed, apiError, apiGet, apiSend, clip, cursorParam, enc, fail, formatBytes, limitParam,
  looseObject, ok, page, pageOutput, qs, short, unwrap,
  type McpDeps, type McpPrincipal, type Register, type ToolsetName,
} from "./kit.js";

/** Largest image or PDF returned inline by polpo_file_read. */
export const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

/** The agent card's UI (an MCP App): one HTML document, served as a ui:// resource. */
export const AGENT_CARD_URI = "ui://polpo/agent-card.html";
let cardSeq = 0;

type AgentCardAgent = Parameters<typeof buildAgentCard>[0]["agent"];

/** An agent's card from the instance's API (agent, tasks, drive). */
async function loadAgentCard(deps: McpDeps, name: string): Promise<{ ok: true; card: AgentCard } | { ok: false; error: string }> {
  const agents = unwrap(await deps.api("GET", "/api/v1/agents"));
  if (!agents.ok) return agents;
  const list = (agents.data as AgentCardAgent[]) ?? [];
  const agent = list.find((a) => a.name === name) ?? list.find((a) => a.name.toLowerCase() === name.toLowerCase() || a.identity?.displayName?.toLowerCase() === name.toLowerCase());
  if (!agent) return { ok: false, error: `No agent "${name}". Agents: ${list.map((a) => a.name).join(", ") || "none"}` };
  const [tasks, drive] = await Promise.all([
    deps.api("GET", "/api/v1/tasks").then(unwrap),
    deps.api("GET", `/api/v1/drive/${enc(agent.name)}`).then(unwrap),
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

/** The card's main parts (the widget reads the rest). */
const cardOutput = {
  agent: z.object({ name: z.string(), role: z.string().optional() }).passthrough().describe("Who the agent is"),
  current: looseObject.nullable().optional().describe("The task at hand"),
  goal: looseObject.nullable().optional().describe("Its main goal"),
  next: looseObject.nullable().optional().describe("What it plans next"),
};

const cardResult = (card: AgentCard) => ({
  content: [{ type: "text" as const, text: agentCardText(card) }],
  structuredContent: card as unknown as Record<string, unknown>,
});

/** The text of a file, or null when it is binary (NUL bytes, or not UTF-8). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const agentItem = z.object({ name: z.string(), role: z.string().optional(), model: z.string().optional(), title: z.string().optional() }).passthrough();

export function registerAgentTools(tool: Register, deps: McpDeps, server: McpServer, enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal): void {
  tool("core", "polpo_agents_list", {
    title: "List agents",
    description: "The agents of this instance: name, role, model. Use it to find the name to pass to polpo_agent_chat, polpo_agent_show or a task's assignTo.",
    inputSchema: {},
    outputSchema: { items: z.array(agentItem) },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/agents");
    if (!r.ok) return apiError(r, "Listing agents");
    const agents = ((r.data as Array<{ name: string; role?: string; model?: string; identity?: { title?: string } }>) ?? [])
      .map((a) => ({ name: a.name, ...(a.role ? { role: a.role } : {}), ...(a.model ? { model: a.model } : {}), ...(a.identity?.title ? { title: a.identity.title } : {}) }));
    return ok(agents.map((a) => `- ${a.name}${a.role ? `: ${a.role}` : ""}${a.model ? ` (${a.model})` : ""}`).join("\n") || "No agents.", { items: agents });
  });

  // ── The agent card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) ──
  if (!allowed(enabled, principal, "core", READ)) return;

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

  registerAppTool(server, "polpo_agent_show", {
    title: "Show an agent",
    description: "Show one agent's card: whether it is working, the task at hand, today's results, what it plans next "
      + "and its main goal; it opens to its tasks, goals and routine. Use it when the person asks how an agent is doing (polpo_agents_list for names).",
    inputSchema: { agent: z.string().min(1).describe("The agent's name or display name") },
    annotations: { title: "Show an agent", ...READ },
    outputSchema: cardOutput,
    _meta: { ui: { resourceUri: AGENT_CARD_URI } },
  }, async ({ agent }) => {
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : fail(r.error);
  });

  // the card's own tools keep their names: the widget calls them
  registerAppTool(server, "agent_card_refresh", {
    title: "Refresh an agent card",
    description: "The agent card's own refresh (called by its UI).",
    inputSchema: { agent: z.string().min(1).describe("The agent's name") },
    annotations: { title: "Refresh an agent card", ...READ },
    outputSchema: cardOutput,
    _meta: { ui: { resourceUri: AGENT_CARD_URI, visibility: ["app"] } },
  }, async ({ agent }) => {
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : fail(r.error);
  });

  if (!allowed(enabled, principal, "core", DESTRUCTIVE)) return;
  registerAppTool(server, "agent_intention_decide", {
    title: "Confirm or cancel an agent's plan",
    description: "From the agent card: confirm an intention the agent proposed, or cancel one (called by its UI after the person clicked).",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name"),
      id: z.string().min(1).describe("The intention's id"),
      action: z.enum(["confirm", "cancel"]).describe("confirm or cancel"),
    },
    annotations: { title: "Confirm or cancel an agent's plan", ...DESTRUCTIVE },
    outputSchema: cardOutput,
    _meta: { ui: { resourceUri: AGENT_CARD_URI, visibility: ["app"] } },
  }, async ({ agent, id, action }) => {
    const done = await apiSend(deps, "POST", `/drive/${enc(agent)}/intentions/${enc(id)}/${action}`);
    if (!done.ok) return apiError(done, `${action} of ${id}`);
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : ok(`${action}: ${id} done.`, { agent: { name: agent } });
  });
}

const approvalItem = z.object({ id: z.string(), status: z.string().optional(), gateName: z.string().optional(), taskId: z.string().optional() }).passthrough();

export function registerApprovalTools(tool: Register, deps: McpDeps): void {
  tool("core", "polpo_approvals_list", {
    title: "List approvals",
    description: "Requests waiting for a person's decision (default), or past ones by status. Use it before polpo_approval_resolve.",
    inputSchema: {
      status: z.enum(["pending", "approved", "rejected", "timeout"]).optional().describe("Which requests (default pending)"),
      limit: limitParam(),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(approvalItem),
    annotations: READ,
  }, async ({ status, limit, cursor }) => {
    const r = await apiGet(deps, `/approvals${qs({ status: status ?? "pending" })}`);
    if (!r.ok) return apiError(r, "Listing approvals");
    const all = (Array.isArray(r.data) ? r.data : []) as Array<Record<string, unknown>>;
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = p.items.map((a) => `- ${String(a.id)} [${String(a.status ?? "")}] ${short(a.gateName ?? a.title ?? a.hook, 60)}${a.taskId ? ` (task ${String(a.taskId)})` : ""}${a.reason ? `: ${short(a.reason, 160)}` : ""}`);
    return ok(`${lines.join("\n") || "No approvals."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("core", "polpo_approval_resolve", {
    title: "Approve or reject",
    description: "Decide on an approval request (polpo_approvals_list): approve (optional note) or reject (feedback required, the agent gets it). "
      + "The decision is final: make sure it is the person's.",
    inputSchema: {
      id: z.string().min(1).describe("The approval request's id"),
      decision: z.enum(["approve", "reject"]).describe("approve or reject"),
      note: z.string().optional().describe("For approve: an optional note; for reject: the feedback (required)"),
    },
    outputSchema: { id: z.string(), decision: z.string(), request: looseObject.optional() },
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
  }, async ({ id, decision, note }) => {
    if (decision === "reject" && !note?.trim()) return fail("Rejecting needs a note with the feedback for the agent.");
    const by = deps.principal?.actor ?? "mcp";
    const r = await apiSend(deps, "POST", `/approvals/${enc(id)}/${decision}`,
      decision === "approve" ? { resolvedBy: by, ...(note ? { note } : {}) } : { resolvedBy: by, feedback: note });
    if (!r.ok) return apiError(r, `${decision === "approve" ? "Approving" : "Rejecting"} ${id}`, r.status === 404 ? "Check the id with polpo_approvals_list." : undefined);
    return ok(`${decision === "approve" ? "Approved" : "Rejected"} ${id}.`, { id, decision, ...(r.data && typeof r.data === "object" ? { request: r.data as Record<string, unknown> } : {}) });
  });
}

const artifactItem = z.object({ id: z.string(), title: z.string(), type: z.string(), kind: z.string().optional(), createdBy: z.string().optional(), version: z.number().optional() }).passthrough();

export function registerArtifactTools(tool: Register, deps: McpDeps): void {
  tool("artifacts", "polpo_artifacts_list", {
    title: "List artifacts",
    description: "Artifacts (documents, html dashboards and designs, diagrams), newest first. Filter by type or words; polpo_artifact_get reads one.",
    inputSchema: {
      type: z.enum(["doc", "html", "svg", "mermaid", "view"]).optional().describe("Only this type"),
      q: z.string().optional().describe("Words in the title or description"),
      limit: limitParam(),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(artifactItem),
    annotations: READ,
  }, async ({ type, q, limit, cursor }) => {
    const r = await apiGet(deps, `/artifacts${qs({ type, q })}`);
    if (!r.ok) return apiError(r, "Listing artifacts");
    const all = ((r.data as Array<Record<string, unknown>>) ?? []).map(({ content: _c, ...rest }) => rest);
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = (p.items as Array<{ id: string; title: string; type: string; kind?: string; createdBy?: string; version?: number }>)
      .map((a) => `- ${a.id} [${a.type}${a.kind ? `/${a.kind}` : ""}] ${a.title}${a.createdBy ? ` — by ${a.createdBy}` : ""}${a.version ? `, v${a.version}` : ""}`);
    return ok(`${lines.join("\n") || "No artifacts."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("artifacts", "polpo_artifact_get", {
    title: "Get an artifact",
    description: "An artifact's details and content (polpo_artifacts_list for ids).",
    inputSchema: { id: z.string().min(1).describe("The artifact's id") },
    outputSchema: { artifact: looseObject },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, `/artifacts/${enc(id)}`);
    if (!r.ok) return apiError(r, `Reading artifact ${id}`, r.status === 404 ? "Check the id with polpo_artifacts_list." : undefined);
    return ok(clip(r.data), { artifact: r.data as Record<string, unknown> });
  });

  tool("artifacts", "polpo_artifact_create", {
    title: "Create an artifact",
    description: "Make an artifact people open in Polpo: a doc (Markdown), an html page (dashboard, design, report: self-contained; "
      + "it reads data through window.polpo.query/sql), an svg or a mermaid diagram. Each call makes a new artifact.",
    inputSchema: {
      title: z.string().min(1).describe("The title people see"),
      type: z.enum(["doc", "html", "svg", "mermaid"]).describe("doc (Markdown), html, svg or mermaid"),
      content: z.string().min(1).describe("The full content in that format"),
      kind: z.string().optional().describe("For html: dashboard, design, app, report, page"),
      description: z.string().optional().describe("One line on what it is"),
    },
    outputSchema: { artifact: looseObject },
    annotations: WRITE,
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/artifacts", args);
    if (!r.ok) return apiError(r, "Creating the artifact");
    const a = r.data as { id?: string; title?: string };
    return ok(`Created artifact ${a.id}: ${a.title}.`, { artifact: r.data as Record<string, unknown> });
  });
}

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
    const sources = ((r.data as Array<{ id: string; name: string; kind: string; description?: string }>) ?? [])
      .map((s) => ({ id: s.id, name: s.name, kind: s.kind, ...(s.description ? { description: s.description } : {}) }));
    return ok(sources.map((s) => `- ${s.id} ${s.name} (${s.kind})${s.description ? `: ${s.description}` : ""}`).join("\n") || "No data sources.", { items: sources });
  });

  tool("data", "polpo_data_query", {
    title: "Query data",
    description: "Read rows from a data source's dataset: choose fields, filter, sort and limit. polpo_data_sources_list gives the source ids; "
      + "an invalid dataset or field name returns the valid ones.",
    inputSchema: {
      sourceId: z.string().min(1).describe("The data source's id"),
      dataset: z.string().min(1).describe("The dataset (table, collection, sheet…)"),
      fields: z.array(z.string()).optional().describe("Fields to return (default all)"),
      filters: z.array(z.object({
        field: z.string().describe("Field name"),
        operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "in", "isNull"]).describe("Comparison"),
        value: z.unknown().optional().describe("Value (an array for in; omit for isNull)"),
      })).optional().describe("All must match"),
      sort: z.array(z.object({ field: z.string().describe("Field name"), direction: z.enum(["asc", "desc"]).describe("asc or desc") })).optional().describe("Order"),
      limit: z.number().int().min(1).max(1000).optional().describe("Most rows (default the source's, max 1000)"),
    },
    outputSchema: { result: z.unknown() },
    annotations: READ,
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/data/query", args);
    if (!r.ok) return apiError(r, "The query");
    return ok(clip(r.data), { result: r.data });
  });
}

const fileEntry = z.object({ name: z.string(), type: z.string(), size: z.number().optional(), modifiedAt: z.string().optional() }).passthrough();

export function registerFileTools(tool: Register, deps: McpDeps): void {
  tool("files", "polpo_files_list", {
    title: "List files",
    description: "List a folder of the instance (the agents' workspace, .polpo, volumes). Without path: the roots. "
      + "Paths are relative to the workspace (e.g. reports/2026, .polpo/output).",
    inputSchema: {
      path: z.string().optional().describe("Folder; omit for the roots"),
      limit: limitParam(200, 1000),
      cursor: cursorParam(),
    },
    outputSchema: { path: z.string().nullable(), ...pageOutput(fileEntry) },
    annotations: READ,
  }, async ({ path, limit, cursor }) => {
    if (!path) {
      const r = await apiGet(deps, "/files/roots");
      if (!r.ok) return apiError(r, "Listing the roots");
      const roots = ((r.data as { roots?: Array<{ name: string; path: string; description?: string; totalFiles?: number; readOnly?: boolean }> })?.roots) ?? [];
      return ok(roots.map((x) => `- ${x.path}  (${x.name}${x.description ? `: ${x.description}` : ""}${x.totalFiles !== undefined ? `, ${x.totalFiles} files` : ""}${x.readOnly ? ", read-only" : ""})`).join("\n") || "No roots.",
        { path: null, items: roots.map((x) => ({ ...x, type: "root" })), next_cursor: null, total: roots.length });
    }
    const r = await apiGet(deps, `/files/list${qs({ path })}`);
    if (!r.ok) return apiError(r, `Listing ${path}`, r.status === 404 ? "Check the path (polpo_files_list without path shows the roots)." : undefined);
    const data = r.data as { path: string; entries: Array<{ name: string; type: string; size?: number; modifiedAt?: string }> };
    const p = page(data.entries, limit ?? 200, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = p.items.map((e) => e.type === "directory" ? `${e.name}/` : `${e.name}  ${formatBytes(e.size)}${e.modifiedAt ? `  ${e.modifiedAt.slice(0, 16).replace("T", " ")}` : ""}`);
    return ok(`${data.path}/\n${lines.join("\n") || "(empty)"}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, { path: data.path, ...p });
  });

  tool("files", "polpo_files_search", {
    title: "Search files",
    description: "Find files and folders whose name or path contains the words, under a folder (default: the workspace).",
    inputSchema: {
      q: z.string().min(1).describe("Words in the name or path"),
      root: z.string().optional().describe("Folder to search under (default the workspace)"),
      limit: z.number().int().min(1).max(500).optional().describe("Most results (default 100)"),
    },
    outputSchema: { items: z.array(z.object({ path: z.string(), type: z.string() }).passthrough()) },
    annotations: READ,
  }, async ({ q, root, limit }) => {
    const r = await apiGet(deps, `/files/search${qs({ q, root, limit: limit ?? 100 })}`);
    if (!r.ok) return apiError(r, "The search");
    const results = (r.data as { files?: Array<{ path: string; type: string }> })?.files ?? [];
    return ok(results.map((x) => `${x.path}${x.type === "directory" ? "/" : ""}`).join("\n") || "Nothing found.", { items: results });
  });

  tool("files", "polpo_file_read", {
    title: "Read a file",
    description: "Read a file of the instance: text (with a line range for long files), images and PDFs as they are; "
      + "other binary files are described.",
    inputSchema: {
      path: z.string().min(1).describe("The file, relative to the workspace or absolute in a volume"),
      from_line: z.number().int().min(1).optional().describe("First line, for long text files"),
      lines: z.number().int().min(1).max(5000).optional().describe("How many lines (default 2000)"),
    },
    annotations: READ,
  }, async ({ path, from_line, lines }) => {
    const res = await deps.api("GET", `/api/v1/files/read${qs({ path })}`);
    if (res.status >= 400) {
      const u = unwrap(res);
      return apiError(u.ok ? { error: `HTTP ${res.status}`, status: res.status } : u, `Reading ${path}`, res.status === 404 ? "Check the path with polpo_files_search." : undefined);
    }
    const bytes = res.bytes ?? new TextEncoder().encode(typeof res.body === "string" ? res.body : JSON.stringify(res.body));
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    if ((mime.startsWith("image/") && mime !== "image/svg+xml") || mime === "application/pdf") {
      if (bytes.byteLength > MAX_INLINE_FILE_BYTES) return ok(`${path}: ${mime}, ${formatBytes(bytes.byteLength)}: too large to return here (limit ${formatBytes(MAX_INLINE_FILE_BYTES)}).`);
      const data = Buffer.from(bytes).toString("base64");
      return mime === "application/pdf"
        ? { content: [{ type: "resource" as const, resource: { uri: `polpo-file:///${path.replace(/^\/+/, "")}`, mimeType: mime, blob: data } }] }
        : { content: [{ type: "image" as const, data, mimeType: mime }] };
    }
    const decoded = decodeText(bytes);
    if (decoded === null) return ok(`${path}: binary file (${mime}, ${formatBytes(bytes.byteLength)}): not shown as text.`);
    const all = decoded.split("\n");
    const start = (from_line ?? 1) - 1;
    const count = lines ?? 2000;
    const slice = all.slice(start, start + count).join("\n");
    const more = start + count < all.length ? `\n… (lines ${start + 1}-${start + count} of ${all.length}; read on with from_line=${start + count + 1})` : "";
    return ok(clip(slice) + more);
  });

  tool("files", "polpo_file_write", {
    title: "Write a file",
    description: "Create a file of the instance (folders are created), text as is or base64 for binary files. "
      + "An existing file is replaced only with overwrite: true.",
    inputSchema: {
      path: z.string().min(1).describe("e.g. reports/summary.md"),
      content: z.string().describe("The content (text, or base64 with encoding base64)"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("base64 for binary content (default utf8)"),
      overwrite: z.boolean().optional().describe("true to replace a file that already exists (default false)"),
    },
    outputSchema: { path: z.string(), bytes: z.number(), replaced: z.boolean() },
    annotations: { ...DESTRUCTIVE, idempotentHint: true },
  }, async ({ path, content, encoding, overwrite }) => {
    const clean = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    const slash = clean.lastIndexOf("/");
    const dir = slash > 0 ? clean.slice(0, slash) : ".";
    const name = clean.slice(slash + 1);
    if (!name || name === "." || name === "..") return fail("The path must name a file, e.g. reports/summary.md.");
    const data = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    // into its folder when it exists (absolute paths of volumes too), else from the workspace, creating the folders
    const listing = dir === "." ? await deps.api("GET", "/api/v1/files/list?path=.") : await deps.api("GET", `/api/v1/files/list${qs({ path: dir })}`);
    const dirExists = dir === "." || listing.status === 200;
    if (!dirExists && path.startsWith("/")) return fail(`Folder ${dir} not found: absolute paths must be inside an existing volume.`);
    const existing = listing.status === 200 ? (unwrap(listing) as { ok: true; data: { entries?: Array<{ name: string; type: string }> } }).data?.entries?.find((e) => e.name === name) : undefined;
    if (existing?.type === "directory") return fail(`${clean} is a folder: choose a file name.`);
    if (existing && overwrite !== true) return fail(`${clean} already exists: pass overwrite: true to replace it (ask the person if unsure).`);
    const form = new FormData();
    form.append("path", dirExists ? dir : ".");
    form.append("file", new File([data], name));
    form.append("relativePath", dirExists ? name : clean);
    const r = await apiSend(deps, "POST", "/files/upload", form);
    if (!r.ok) return apiError(r, `Writing ${clean}`);
    const done = r.data as { count?: number; excluded?: { count: number; reasons: string[] } };
    if (!done.count) return fail(`Not written: ${done.excluded?.reasons?.join(", ") || "excluded"}. Choose another path.`);
    return ok(`Wrote ${clean} (${formatBytes(data.byteLength)})${existing ? ", replacing the old file" : ""}.`, { path: clean, bytes: data.byteLength, replaced: !!existing });
  });

  tool("files", "polpo_file_manage", {
    title: "Make a folder, rename or delete",
    description: "Make a folder (mkdir), rename a file or folder in place (rename, with new_name), or delete one (delete, with confirm: true; "
      + "a folder that is not empty also needs recursive: true). Deleting cannot be undone.",
    inputSchema: {
      action: z.enum(["mkdir", "rename", "delete"]).describe("mkdir, rename or delete"),
      path: z.string().min(1).describe("The file or folder"),
      new_name: z.string().optional().describe("For rename: the new name, without folders"),
      recursive: z.boolean().optional().describe("For delete: also a folder with contents"),
      confirm: z.boolean().optional().describe("For delete: must be true, after the person agreed"),
    },
    outputSchema: { action: z.string(), path: z.string(), new_name: z.string().optional() },
    annotations: DESTRUCTIVE,
  }, async ({ action, path, new_name, recursive, confirm }) => {
    if (action === "rename" && !new_name) return fail("rename needs new_name (the new name, without folders).");
    if (action === "delete" && confirm !== true) return fail(`Deleting ${path} cannot be undone: ask the person, then call again with confirm: true.`);
    const body = action === "mkdir" ? { path } : action === "rename" ? { path, newName: new_name } : { path, recursive: recursive === true };
    const r = await apiSend(deps, "POST", `/files/${action}`, body);
    if (!r.ok) return apiError(r, `${action} ${path}`);
    return ok(`${action}: ${path}${action === "rename" ? ` → ${new_name}` : ""} done.`, { action, path, ...(new_name ? { new_name } : {}) });
  });
}
