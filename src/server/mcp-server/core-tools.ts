/**
 * Agents, approvals, artifacts and files (data: data.ts).
 */
import { z } from "zod";
import { ARTIFACT_WORKSPACE_GUIDE, artifactLimits } from "@polpo-ai/core/artifacts";
import { ARTIFACT_OPS_GUIDE } from "../../artifacts/ops.js";
import { fetchPublicBytes } from "./config.js";
import { agentEffectiveModel, agentEngineIdOf, engineTypeText, modelWithEngineText } from "@polpo-ai/core/engine-label";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { agentCardText, buildAgentCard, type AgentCard } from "../mcp-agent-card.js";
import { AGENT_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, WRITE, apiError, apiGet, apiSend, clip, cursorParam, enc, fail, formatBytes, limitParam,
  looseObject, ok, page, pageOutput, qs, short, unwrap,
  type AppRegister, type McpDeps, type Register,
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
  const [tasks, drive, connectors, appearance, detail, lines] = await Promise.all([
    deps.api("GET", "/api/v1/tasks").then(unwrap),
    deps.api("GET", `/api/v1/drive/${enc(agent.name)}`).then(unwrap),
    deps.api("GET", "/api/v1/connectors").then(unwrap),
    cardAppearance(deps),
    // its production version and draft state (agent versions)
    deps.api("GET", `/api/v1/agents/${enc(agent.name)}`).then(unwrap),
    // its communication lines
    deps.api("GET", "/api/v1/agents/lines").then(unwrap),
  ]);
  const versioning = detail.ok ? (detail.data as { versioning?: AgentCardAgent["versioning"] })?.versioning : undefined;
  const card = buildAgentCard({
    agent: versioning ? { ...agent, versioning } : agent,
    tasks: tasks.ok ? (tasks.data as Parameters<typeof buildAgentCard>[0]["tasks"]) ?? [] : [],
    ...(drive.ok ? { drive: drive.data as Parameters<typeof buildAgentCard>[0]["drive"] } : {}),
    ...(lines.ok ? { lines: lines.data as Parameters<typeof buildAgentCard>[0]["lines"] } : {}),
    ...(connectors.ok ? { connectors: (connectors.data as { connectors?: Parameters<typeof buildAgentCard>[0]["connectors"] })?.connectors ?? [] } : {}),
    now: new Date(),
    key: { createdAt: Date.now(), seq: ++cardSeq },
  });
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

/**
 * The card as returned (AgentCard): every field declared, and open to new ones. Clients built on
 * the official MCP SDK validate structuredContent with Ajv, so a closed schema that misses a
 * field breaks the tool for them (seen live: "data must NOT have additional properties").
 */
const cardOutput = z.object({
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional().describe("Orders the cards of one agent: a newer card supersedes older ones"),
  generatedAt: z.string().optional(),
  agent: z.object({ name: z.string(), role: z.string().optional() }).passthrough().describe("Who the agent is"),
  status: z.string().optional().describe("working, waiting, idle…"),
  current: looseObject.nullable().optional().describe("The task at hand (or the last one it finished)"),
  today: z.object({ done: z.number(), failed: z.number(), waiting: z.number() }).passthrough().optional().describe("Today's tasks"),
  next: looseObject.nullable().optional().describe("What it plans next"),
  goal: looseObject.nullable().optional().describe("Its main goal"),
  drive: z.boolean().optional().describe("Whether it has goals and initiative on"),
  portrait: z.string().optional(),
  tasks: z.array(looseObject).optional(),
  goals: z.array(looseObject).optional().describe("Its goals"),
  routine: z.array(looseObject).optional().describe("What it does on a schedule, and what it proposes"),
  journal: z.array(looseObject).optional().describe("Its latest reflections"),
  connectors: z.array(looseObject).optional().describe("The connectors it may use, with their accounts (gmail, gmail-2…) and how many of their tools it gets"),
  lines: looseObject.optional().describe("Its communication lines: mode, whether set, the agents it can talk to, its manager (escalate)"),
}).passthrough();

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

const agentItem = z.object({
  name: z.string(), role: z.string().optional(),
  model: z.string().optional().describe("The model it runs (a harness or CLI engine's own model; absent: the default)"),
  engine: z.string().optional().describe("polpo, claude-code, codex, opencode (harnesses), claude-cli, codex-cli (official CLIs)"),
  engine_label: z.string().optional().describe("Polpo, Claude Code · Harness, Codex · CLI…"),
  title: z.string().optional(),
}).passthrough();

export function registerAgentTools(tool: Register, deps: McpDeps, app: AppRegister): void {
  tool("core", "polpo_agents_list", {
    title: "List agents",
    description: "The agents of this instance: name, role, model. Use it to find the name to pass to polpo_agent_chat, polpo_agent_show or a task's assignTo.",
    inputSchema: {},
    outputSchema: { items: z.array(agentItem) },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/agents");
    if (!r.ok) return apiError(r, "Listing agents");
    // the model it runs and its engine: "claude-sonnet-4-6 (Claude Code · CLI)", "gpt-6 (Polpo)"
    const agents = ((r.data as Array<{ name: string; role?: string; model?: string; engine?: unknown; identity?: { title?: string } }>) ?? [])
      .map((a) => {
        const model = agentEffectiveModel(a);
        const engine = agentEngineIdOf(a.engine);
        return { name: a.name, ...(a.role ? { role: a.role } : {}), ...(model ? { model } : {}), engine, engine_label: engineTypeText(engine), ...(a.identity?.title ? { title: a.identity.title } : {}) };
      });
    return ok(agents.map((a) => `- ${a.name}${a.role ? `: ${a.role}` : ""} (${modelWithEngineText(a.model, a.engine, "default model")})`).join("\n") || "No agents.", { items: agents });
  });

  // ── The agent card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) ──
  const card = app.gate("core", READ, ["polpo_agent_show", "agent_card_refresh"]);

  registerAppResource(card, "Agent card", AGENT_CARD_URI, {
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

  registerAppTool(card, "polpo_agent_show", {
    title: "Show an agent",
    description: "Show one agent's card: whether it is working, its engine (Polpo, Claude Code, Codex, OpenCode) and computer, the task at hand "
      + "(with the engine, model, computer and cost of its latest run, or why it failed), today's results, what it plans next, "
      + "its main goal and the connectors it may use; it opens to its tasks, goals and routine. Use it when the person asks how an agent is doing (polpo_agents_list for names).",
    inputSchema: { agent: z.string().min(1).describe("The agent's name or display name") },
    annotations: { title: "Show an agent", ...READ },
    outputSchema: cardOutput,
    _meta: { ui: { resourceUri: AGENT_CARD_URI } },
  }, async ({ agent }) => {
    const r = await loadAgentCard(deps, agent);
    return r.ok ? cardResult(r.card) : fail(r.error);
  });

  // the card's own tools keep their names: the widget calls them
  registerAppTool(card, "agent_card_refresh", {
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

  const decide = card.gate("core", DESTRUCTIVE, ["agent_intention_decide"]);
  registerAppTool(decide, "agent_intention_decide", {
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

const artifactItem = z.object({
  id: z.string(), title: z.string(), type: z.string(), kind: z.string().optional(), createdBy: z.string().optional(), version: z.number().optional(),
  taskId: z.string().optional(), missionId: z.string().optional(), size: z.number().optional(), updatedAt: z.string().optional(),
}).passthrough();

/** How a model should change artifacts (Claude-artifact style): in every tool that writes one. */
const CHANGE_GUIDE = "Prefer command \"update\" (old_str → new_str; several with updates[]) for any change smaller than most of the content: it is cheap and leaves the rest untouched. "
  + "Use \"rewrite\" (content) only when most of it changes. For a content over a few KB never send it whole: upload it with polpo_artifact_upload_prepare "
  + "({ url } or { path }, or base64 parts) and polpo_artifact_upload_finalize.";

const UPLOAD_HINT = "This content is too large to send in one call: upload it with polpo_artifact_upload_prepare ({ url }, { path } of a file of the instance, or { base64 } in parts with append_to/more) "
  + "then polpo_artifact_upload_finalize (with id to replace this artifact's content), or change only part of it with polpo_artifact_update command update / ops.";

const selector = z.union([z.string(), z.number().int().min(0)]);
const updateItem = z.object({
  old_str: z.string().describe("Exact text in the current content (once, unless replace_all)"),
  new_str: z.string().describe("The replacement (\"\" deletes old_str)"),
  replace_all: z.boolean().optional(),
});
const readOutput = z.object({ text: z.string(), size: z.number(), start: z.number().optional(), end: z.number().optional(), more: z.boolean().optional(), outline: z.string().optional() }).passthrough();
const uploadOutput = { upload_id: z.string(), size: z.number(), complete: z.boolean(), filename: z.string().optional() };

/** "12 earlier versions, 3.1 MB of 1 GB (max 1000)". */
function usageLine(usage: unknown): string {
  const u = usage as { count?: number; bytes?: number; maxBytes?: number; maxCount?: number } | undefined;
  if (!u || typeof u.count !== "number") return "";
  return `${u.count} earlier version${u.count === 1 ? "" : "s"}, ${formatBytes(u.bytes ?? 0)} of ${formatBytes(u.maxBytes ?? 0)} (max ${u.maxCount}; the oldest are pruned first)`;
}

export function registerArtifactTools(tool: Register, deps: McpDeps): void {
  tool("artifacts", "polpo_artifacts_list", {
    title: "List artifacts",
    description: "Artifacts, newest first: docs (Markdown, with tabs, dropdowns and comments), editable workspaces (html with kind slides, sheets, design or motion), "
      + "html dashboards and pages, drawings (svg) and diagrams (mermaid). Filter by type, kind or words; polpo_artifact_get reads one.",
    inputSchema: {
      type: z.enum(["doc", "html", "svg", "mermaid", "view"]).optional().describe("Only this type"),
      kind: z.string().optional().describe("Only this kind: slides, sheets, design, motion, dashboard, app, report, page"),
      q: z.string().optional().describe("Words in the title or description"),
      limit: limitParam(),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(artifactItem),
    annotations: READ,
  }, async ({ type, kind, q, limit, cursor }) => {
    const r = await apiGet(deps, `/artifacts${qs({ type, kind, q })}`);
    if (!r.ok) return apiError(r, "Listing artifacts");
    const all = ((r.data as Array<Record<string, unknown>>) ?? []).map(({ content: _c, ...rest }) => rest);
    const p = page(all, limit ?? 20, cursor);
    if (!p) return fail(BAD_CURSOR);
    const lines = (p.items as Array<{ id: string; title: string; type: string; kind?: string; createdBy?: string; version?: number; taskId?: string; missionId?: string; size?: number; updatedAt?: string }>)
      .map((a) => `- ${a.id} [${artifactLabel(a.type, a.kind)}] ${a.title}${a.createdBy ? ` — by ${a.createdBy}` : ""}${a.version ? `, v${a.version}` : ""}`
        + `${a.taskId ? `, from task ${a.taskId}${a.missionId ? ` (mission ${a.missionId})` : ""}` : ""}`
        + `${typeof a.size === "number" ? `, ${formatBytes(a.size)}` : ""}${a.updatedAt ? `, updated ${a.updatedAt.slice(0, 16).replace("T", " ")}` : ""}`);
    return ok(`${lines.join("\n") || "No artifacts."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("artifacts", "polpo_artifact_get", {
    title: "Get an artifact",
    description: "An artifact's details, versions (with how much of the version limit they use) and content (polpo_artifacts_list for ids). "
      + "A small content comes whole; a large one shows its first 60,000 bytes and its outline (tabs, slides, sheets, artboards, scenes with ids). "
      + "Read more with offset/limit (bytes; continue from the end shown), the outline alone with outline: true, or one part: tab, slide (or slides \"2-5\"), "
      + "sheet (+ range \"A1:D20\"), board, page, scene — by id, name or position from 0. Slides, sheets and motion are JSON; a design is HTML. "
      + "Change it with polpo_artifact_update, passing expectedVersion = its version.",
    inputSchema: {
      id: z.string().min(1).describe("The artifact's id"),
      version: z.number().int().positive().optional().describe("An earlier version"),
      offset: z.number().int().min(0).optional().describe("Byte to start reading from"),
      limit: z.number().int().positive().max(240_000).optional().describe("Bytes to read (default 60,000)"),
      outline: z.boolean().optional().describe("Only the structure"),
      tab: selector.optional().describe("A document's tab"),
      slide: selector.optional().describe("One slide"),
      slides: z.string().optional().describe("Slides by position, e.g. \"2-5\""),
      sheet: selector.optional().describe("A sheet of a workbook"),
      range: z.string().optional().describe("With sheet: cells like A1:D20"),
      board: selector.optional().describe("A design's artboard"),
      page: selector.optional().describe("A design's page"),
      scene: selector.optional().describe("A motion scene"),
    },
    outputSchema: { artifact: looseObject, read: readOutput.optional() },
    annotations: READ,
  }, async ({ id, version, offset, limit, outline, tab, slide, slides, sheet, range, board, page: pageSel, scene }) => {
    const meta = await apiGet(deps, `/artifacts/${enc(id)}?content=none`);
    if (!meta.ok) return apiError(meta, `Reading artifact ${id}`, meta.status === 404 ? "Check the id with polpo_artifacts_list." : undefined);
    const artifact = meta.data as Record<string, any>;
    if (String(id).startsWith("view:")) return ok(clip(artifact), { artifact });
    const r = await apiGet(deps, `/artifacts/${enc(id)}/read${qs({ version, offset, limit, outline: outline ? 1 : undefined, tab, slide, slides, sheet, range, board, page: pageSel, scene })}`);
    if (!r.ok) {
      return apiError(r, `Reading artifact ${id}`, r.status === 413 ? "Read it by byte range (offset/limit) instead of by part." : undefined);
    }
    const read = r.data as { text: string; size: number; start?: number; end?: number; more?: boolean; outline?: string };
    const { content: _content, versions, usage, ...rest } = artifact;
    const whole = read.start === 0 && read.more === false && !version;
    const summary = { ...rest, usage, versions: (versions as Array<Record<string, unknown>> | undefined)?.map(({ content: _c, ...v }) => v), ...(whole ? { content: read.text } : {}) };
    const range_ = read.start !== undefined && (read.start > 0 || read.more) ? ` (bytes ${read.start}–${read.end} of ${read.size}${read.more ? `; more: offset ${read.end}` : ""})` : "";
    const text = [
      `${artifact.id} [${artifactLabel(artifact.type, artifact.kind)}] ${artifact.title} — v${artifact.version}, ${formatBytes(artifact.size)}${artifact.createdBy ? `, by ${artifact.createdBy}` : ""}`,
      artifact.description ? `Description: ${artifact.description}` : "",
      `Versions: v${artifact.version} (current)${(versions as unknown[] | undefined)?.length ? `, ${(versions as Array<{ version: number }>).map((v) => `v${v.version}`).join(", ")}` : ""}${usage ? ` — ${usageLine(usage)}` : ""}`,
      read.outline ? `--- outline ---\n${read.outline}` : "",
      `--- ${version ? `v${version} ` : ""}content${range_} ---`,
      read.text,
    ].filter(Boolean).join("\n");
    return ok(clip(text), { artifact: summary, read });
  });

  tool("artifacts", "polpo_artifact_create", {
    title: "Create an artifact",
    description: "Create an artifact that opens in Polpo. Also supports drawings (svg) and diagrams (mermaid). HTML can read data through window.polpo.query/sql. "
      + "Only for contents of a few KB: for anything larger use polpo_artifact_upload_prepare + polpo_artifact_upload_finalize "
      + "(from a public URL, a file of the instance, or base64 in parts), then change it with polpo_artifact_update command update.\n"
      + ARTIFACT_WORKSPACE_GUIDE,
    inputSchema: {
      title: z.string().min(1).describe("The title people see"),
      type: z.enum(["doc", "html", "svg", "mermaid"]).describe("doc (Markdown), html, svg or mermaid"),
      kind: z.string().optional().describe("For html: slides, sheets, design, motion, dashboard, app, report, page"),
      content: z.string().describe("The full content in that format (a few KB; larger: upload)"),
      description: z.string().optional().describe("One line on what it is"),
    },
    outputSchema: { artifact: looseObject },
    annotations: WRITE,
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/artifacts", args);
    if (!r.ok) return apiError(r, "Creating the artifact", r.status === 413 ? UPLOAD_HINT : undefined);
    const { content: _content, ...a } = r.data as Record<string, any>;
    return ok(`Created artifact ${a.id}: ${a.title} (v1, ${formatBytes(a.size)}).`, { artifact: a });
  });

  tool("artifacts", "polpo_artifact_update", {
    title: "Change an artifact",
    description: "Change an artifact; every change is a new version people can step through and restore. Read it first with polpo_artifact_get and pass expectedVersion "
      + "(refused if someone changed it since: read it again). "
      + "command \"update\" (default with old_str): old_str → new_str, old_str must match the current content exactly once (or replace_all); several: updates [{ old_str, new_str }] "
      + "applied in sequence, all or nothing; a miss shows the closest lines. command \"rewrite\": the whole new content (same format as polpo_artifact_create). "
      + "command \"append\"/\"prepend\" with text. patch: JSON Patch (RFC 6902) on the model (workspace JSON; { pages } of a design; { tabs } of a document). "
      + "ops: per-kind operations.\n" + ARTIFACT_OPS_GUIDE + "\n" + CHANGE_GUIDE + " Also title, description, pin.",
    inputSchema: {
      id: z.string().min(1).describe("The artifact's id (art_…)"),
      expectedVersion: z.number().int().positive().optional().describe("The version you read: refused when it changed since"),
      command: z.enum(["update", "rewrite", "append", "prepend"]).optional().describe("update (default with old_str/updates), rewrite (default with content), append, prepend"),
      old_str: z.string().optional().describe("update: the exact text to replace"),
      new_str: z.string().optional().describe("update: the replacement"),
      replace_all: z.boolean().optional().describe("update: replace every occurrence of old_str"),
      updates: z.array(updateItem).optional().describe("update: several replacements, in sequence"),
      content: z.string().optional().describe("rewrite: the whole new content (only when most of it changes)"),
      text: z.string().optional().describe("append/prepend: the text to add"),
      patch: z.array(z.object({
        op: z.enum(["add", "remove", "replace", "move", "copy", "test"]), path: z.string().describe("JSON pointer, e.g. /slides/2/title"),
        from: z.string().optional(), value: z.unknown().optional(),
      })).optional().describe("JSON Patch on the model"),
      ops: z.array(z.object({ op: z.string() }).passthrough()).optional().describe("Per-kind operations (see the description)"),
      title: z.string().optional().describe("A new title"),
      description: z.string().optional().describe("One line on what it is"),
      pinned: z.boolean().optional().describe("Pin it at the top of the artifacts, or unpin it"),
      note: z.string().optional().describe("What changed, in a few words (shown in the versions)"),
    },
    outputSchema: { artifact: looseObject },
    annotations: WRITE,
  }, async ({ id, expectedVersion, ...patch }) => {
    const r = await apiSend(deps, "PATCH", `/artifacts/${enc(id)}`, { ...patch, ...(expectedVersion ? { expectedVersion } : {}) });
    if (!r.ok) {
      return apiError(r, `Changing artifact ${id}`, r.status === 409 ? "It changed since that version: read it again with polpo_artifact_get and redo the change."
        : r.status === 404 ? "Check the id with polpo_artifacts_list."
        : r.status === 413 ? UPLOAD_HINT
        : /old_str .*not found|found \d+ times/.test(r.error) ? "Copy old_str exactly from polpo_artifact_get (read the part you change), or add context to make it unique." : undefined);
    }
    const { content: _content, versions: _versions, ...a } = r.data as Record<string, any>;
    return ok(`Updated artifact ${a.id} (now v${a.version}${a.change ? `, ${a.change}` : ""}, ${formatBytes(a.size)}): ${a.title}.${a.usage ? ` Versions: ${usageLine(a.usage)}.` : ""}`, { artifact: a });
  });

  tool("artifacts", "polpo_artifact_upload_prepare", {
    title: "Upload an artifact's content",
    description: "Upload a content for an artifact without sending it in a tool call's text — the way to create or replace a large artifact (up to the instance limit, 100 MB by default). "
      + "The content comes from a public https URL, a file of the instance (e.g. a chat attachment or a file an agent wrote: path), or base64 — in parts for large contents: "
      + "the first part without append_to, each next one with append_to = the upload_id and more: true until the last (send it without more). "
      + "Then create the artifact or replace one's content with polpo_artifact_upload_finalize and the upload_id (kept 30 minutes). "
      + "Files: .md doc, .html page or design, .svg, .mmd mermaid, .json slides/sheets/motion workspace (detected unless you give type at finalize).",
    inputSchema: {
      source: z.union([
        z.object({ url: z.string().url().describe("A public https URL of the file") }),
        z.object({ path: z.string().min(1).describe("A file of the instance, e.g. workspace/attachments/…/deck.json or reports/q3.html") }),
        z.object({
          base64: z.string().min(1).describe("The content's bytes (or the next part of them) in base64; parts of up to ~1 MB"),
          filename: z.string().optional().describe("The file name, e.g. report.html (helps detect the type)"),
          append_to: z.string().optional().describe("The upload_id of the previous part"),
          more: z.boolean().optional().describe("true: more parts follow"),
        }),
      ]).describe("{ url } or { path } or { base64, filename?, append_to?, more? }"),
    },
    outputSchema: uploadOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ source }) => {
    const limit = artifactLimits().maxBytes;
    let r;
    if ("url" in source) {
      const got = await fetchPublicBytes(deps, source.url, { maxBytes: limit, urlLabel: "file", sizeLabel: "file" });
      if (!got.ok) return fail(`The file could not be read: ${got.error}. Give another URL, a file of the instance (path) or base64 data.`);
      const filename = decodeURIComponent(new URL(source.url).pathname.split("/").pop() ?? "") || undefined;
      r = await apiSend(deps, "POST", `/artifacts/uploads${qs({ filename })}`, got.bytes);
    } else if ("path" in source) {
      r = await apiSend(deps, "POST", "/artifacts/uploads", { path: source.path });
    } else {
      r = await apiSend(deps, "POST", "/artifacts/uploads", source);
    }
    if (!r.ok) {
      return apiError(r, "Uploading", r.status === 413 ? `The content is over the artifact limit (${formatBytes(limit)}).`
        : /no upload/i.test(r.error) ? "Start again without append_to." : /No file/.test(r.error) ? "Find the file with polpo_files_search." : undefined);
    }
    const d = r.data as { uploadId: string; size: number; complete: boolean; filename?: string };
    const next = d.complete
      ? `Complete: create the artifact (or replace one's content: id) with polpo_artifact_upload_finalize upload_id "${d.uploadId}".`
      : `Send the next part with append_to: "${d.uploadId}" (more: true until the last one).`;
    return ok(`Received ${formatBytes(d.size)}${d.filename ? ` (${d.filename})` : ""}. ${next}`,
      { upload_id: d.uploadId, size: d.size, complete: d.complete, ...(d.filename ? { filename: d.filename } : {}) });
  });

  tool("artifacts", "polpo_artifact_upload_finalize", {
    title: "Create or replace an artifact from an upload",
    description: "Finish an upload made with polpo_artifact_upload_prepare: create a new artifact from it, or replace the content of an existing one (id; the previous content "
      + "becomes a version, pass expectedVersion). The type and kind are detected from the file unless given.",
    inputSchema: {
      upload_id: z.string().min(1).describe("The upload_id from polpo_artifact_upload_prepare"),
      id: z.string().optional().describe("Replace this artifact's content instead of creating one"),
      expectedVersion: z.number().int().positive().optional().describe("With id: the version you read"),
      title: z.string().optional().describe("The title (default: the file name)"),
      type: z.enum(["doc", "html", "svg", "mermaid"]).optional().describe("Default: detected"),
      kind: z.string().optional().describe("For html: slides, sheets, design, motion, dashboard, app, report, page (default: detected)"),
      description: z.string().optional().describe("One line on what it is"),
      note: z.string().optional().describe("What changed (with id)"),
    },
    outputSchema: { artifact: looseObject },
    annotations: WRITE,
  }, async ({ upload_id, ...input }) => {
    const r = await apiSend(deps, "POST", `/artifacts/uploads/${enc(upload_id)}/finalize`, input);
    if (!r.ok) {
      return apiError(r, input.id ? `Replacing the content of ${input.id}` : "Creating the artifact",
        r.status === 404 ? (/Upload/.test(r.error) ? "Upload it again with polpo_artifact_upload_prepare." : "Check the id with polpo_artifacts_list.")
        : r.status === 409 ? "It changed since that version: read it again with polpo_artifact_get." : undefined);
    }
    const { content: _content, versions: _versions, ...a } = r.data as Record<string, any>;
    return ok(`${input.id ? "Replaced the content of" : "Created"} artifact ${a.id}: ${a.title} (v${a.version}, ${formatBytes(a.size)}).${a.usage ? ` Versions: ${usageLine(a.usage)}.` : ""}`, { artifact: a });
  });
}

/** "html/sheets" reads as what it is: a sheets workspace. */
function artifactLabel(type: string, kind?: string): string {
  const workspace: Record<string, string> = { slides: "slides", sheets: "sheets", design: "design", motion: "motion" };
  if (type === "html" && kind && workspace[kind]) return `${workspace[kind]} workspace`;
  return `${type}${kind ? `/${kind}` : ""}`;
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
