/**
 * Polpo as an MCP server: Claude Code, Codex, Claude, ChatGPT and any MCP client use the instance
 * through tools designed for what people do, named polpo_<area>_<verb> and grouped in toolsets
 * (core, tasks, missions, artifacts, data, files, admin…; see mcp-server/kit.ts). An instance chooses
 * its toolsets (settings.mcp.toolsets or POLPO_MCP_TOOLSETS; a connector URL may narrow them with
 * ?toolsets=), and the caller's scopes decide which tools it gets.
 *
 * Streamable HTTP at /mcp, stateless (a server per request, no sessions): every tool calls the
 * instance's own REST API in process, so it follows the same rules as the dashboard, and what it
 * does is recorded as the authenticated principal (deps.principal.actor).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ALL_SCOPES, DEFAULT_SCOPES, FULL_ACCESS, SCOPES, TOOLSETS, TOOLSET_NAMES, hasScope, normalizeScopes, registrar, resolveToolsets,
  type McpDeps, type McpPrincipal, type PolpoScope, type ToolScope, type ToolsetName,
} from "./mcp-server/kit.js";
import { registerConversationTools } from "./mcp-server/conversation.js";
import { registerAgentTools, registerApprovalTools, registerArtifactTools, registerFileTools } from "./mcp-server/core-tools.js";
import { registerDataTools } from "./mcp-server/data.js";
import { registerTaskTools } from "./mcp-server/tasks.js";
import { registerMissionTools } from "./mcp-server/missions.js";
import { registerWorkCards } from "./mcp-server/cards.js";
import { registerAdminTools } from "./mcp-server/admin.js";
import { registerConfigTools } from "./mcp-server/config.js";
import { registerTeamTools } from "./mcp-server/team.js";
import { registerAgentSuiteTools } from "./mcp-server/agent-suites.js";
import { registerSuiteCards } from "./mcp-server/suite-cards.js";
import { registerBenchmarkTools } from "./mcp-server/benchmarks.js";
import { registerRoomTools } from "./mcp-server/rooms.js";
import { registerChatTools } from "./mcp-server/chat.js";
import { registerBrainTools, registerLearningTools, registerMemoryTools } from "./mcp-server/knowledge.js";
import { registerSearchTools } from "./mcp-server/search.js";
import { registerSkillTools } from "./mcp-server/skills.js";
import { registerAutomationTools, registerWatcherTools } from "./mcp-server/automation.js";
import { registerConnectorTools } from "./mcp-server/connectors.js";
import { registerMcpServerTools } from "./mcp-server/mcp-servers.js";
import { registerChannelTools, registerVaultTools } from "./mcp-server/channels.js";
import { registerAppTools } from "./mcp-server/apps.js";
import { registerComputerTools } from "./mcp-server/computers.js";
import { registerWaBusinessTools } from "./mcp-server/whatsapp-business.js";
import { registerHarnessTools } from "./mcp-server/harnesses.js";
import { registerSettingsTools } from "./mcp-server/settings.js";
import { registerChannelSetupTools } from "./mcp-server/channel-setup.js";
import { registerSetupTools } from "./mcp-server/setup.js";

export type { ApiResponse, McpDeps, McpPrincipal, PolpoScope, ToolScope, ToolsetName } from "./mcp-server/kit.js";
export {
  MAX_RESULT_CHARS, TOOLSETS, DEFAULT_TOOLSETS, resolveToolsets, hasScope, scopeFor,
  SCOPES, ALL_SCOPES, DEFAULT_SCOPES, AREA_SCOPES, UMBRELLA_SCOPE, normalizeScopes,
} from "./mcp-server/kit.js";
export { MAX_INLINE_FILE_BYTES, AGENT_CARD_URI } from "./mcp-server/core-tools.js";
export { WORK_CARD_URI } from "./mcp-server/cards.js";
export { matchesOperationPath, isBlockedGet } from "./mcp-server/admin.js";

const INSTRUCTIONS = "Polpo orchestrates a team of AI agents (tasks, missions, artifacts, data, approvals, files, rooms, chats, "
  + "memory, skills, schedules, connectors, channels). Use the specific polpo_* tools for reads and actions: they act directly, "
  + "like the dashboard. For anything open-ended, polpo_ask delegates to Polpo itself, "
  + "which can do everything the instance can; when a turn returns status needs_input (a question or a preview to approve), "
  + "show it to the person and reply with polpo_answer. Long work runs in the background: create it, then follow it with the "
  + "wait and get tools. Destructive actions need confirm: true, given only after the person agreed. "
  + "Secrets (tokens, API keys) never pass through here: when a tool returns setup_url and setup_id, show the person the link "
  + "(next_step says what to paste), call polpo_setup_wait with the setup_id right away, then verify with the area's test tool and continue.";

/** The MCP server for one request (stateless). `catalog` collects every tool of the enabled toolsets with its scope. */
export function createPolpoMcpServer(deps: McpDeps, catalog?: ToolScope[]): McpServer {
  const server = new McpServer({ name: "polpo", title: "Polpo", version: deps.version }, { instructions: INSTRUCTIONS });
  const principal = deps.principal ?? FULL_ACCESS;
  const enabled = new Set<ToolsetName>(deps.toolsets ? resolveToolsets(deps.toolsets) : resolveToolsets());
  const tool = registrar(server, enabled, principal, catalog);

  registerConversationTools(tool, deps);
  registerSearchTools(tool, deps);
  registerAgentTools(tool, deps, server, enabled, principal, catalog);
  registerApprovalTools(tool, deps);
  registerTaskTools(tool, deps);
  registerMissionTools(tool, deps);
  registerWorkCards(server, deps, enabled, principal, catalog);
  registerArtifactTools(tool, deps);
  registerDataTools(tool, deps);
  registerFileTools(tool, deps);
  registerTeamTools(tool, deps);
  registerAgentSuiteTools(tool, deps);
  registerBenchmarkTools(tool, deps);
  registerSuiteCards(server, deps, enabled, principal, catalog);
  registerConfigTools(tool, deps);
  registerSettingsTools(tool, deps);
  registerChannelSetupTools(tool, deps);
  registerSetupTools(tool, deps);
  registerRoomTools(tool, deps);
  registerChatTools(tool, deps);
  registerMemoryTools(tool, deps);
  registerSkillTools(tool, deps);
  registerAutomationTools(tool, deps);
  registerConnectorTools(tool, deps);
  registerMcpServerTools(tool, deps);
  registerChannelTools(tool, deps);
  registerBrainTools(tool, deps);
  registerLearningTools(tool, deps);
  registerWatcherTools(tool, deps);
  registerVaultTools(tool, deps);
  registerAppTools(tool, deps);
  registerComputerTools(tool, deps);
  registerWaBusinessTools(tool, deps);
  registerHarnessTools(tool, deps);
  registerAdminTools(tool, deps);
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

let matrix: ToolScope[] | undefined;
/** Every tool with the toolset it belongs to and the scope it needs (the same for every instance). */
export function toolScopeMatrix(): ToolScope[] {
  if (!matrix) {
    const catalog: ToolScope[] = [];
    const api = async () => ({ status: 503, body: null, headers: new Headers() });
    void createPolpoMcpServer({ api, version: "0", toolsets: TOOLSET_NAMES }, catalog).close();
    matrix = catalog;
  }
  return matrix;
}

/** The scope matrix as a Markdown table (docs/mcp.md), grouped by scope then toolset. */
export function scopeMatrixMarkdown(): string {
  const rows = toolScopeMatrix();
  const lines = ["| Scope | What it allows | Tools |", "| --- | --- | --- |"];
  for (const scope of ALL_SCOPES) {
    const tools = rows.filter((r) => r.scope === scope);
    const text = tools.map((t) => `\`${t.name}\`${t.destructive ? " ⚠" : ""}`).join(", ");
    lines.push(`| \`${scope}\` | ${SCOPES[scope].description} | ${text || "—"} |`);
  }
  return lines.join("\n");
}

/** A tools/call the caller may not make: the tool exists in an enabled toolset, but needs a scope the caller lacks. */
export function deniedToolCall(body: unknown, principal: McpPrincipal, toolsets: readonly ToolsetName[]): { id: unknown; tool: string; scope: PolpoScope } | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages as Array<{ id?: unknown; method?: unknown; params?: { name?: unknown } } | null>) {
    if (!m || m.method !== "tools/call" || typeof m.params?.name !== "string") continue;
    const entry = toolScopeMatrix().find((t) => t.name === m.params!.name && toolsets.includes(t.toolset));
    if (entry && !hasScope(principal, entry.scope)) return { id: m.id ?? null, tool: entry.name, scope: entry.scope };
  }
  return null;
}

/** The scopes to ask for again: what the caller holds plus what it lacks (a client re-authorizes with all of them). */
export function stepUpScopes(principal: McpPrincipal, needed: PolpoScope): PolpoScope[] {
  const held = normalizeScopes(principal.scopes);
  return normalizeScopes([...(held.length ? held : DEFAULT_SCOPES), needed]);
}

/**
 * 403 for a call that needs more scope (MCP authorization, step-up): WWW-Authenticate names the
 * scopes to ask for, and the body is the JSON-RPC error the client shows.
 */
export function insufficientScopeResponse(denied: { id: unknown; tool: string; scope: PolpoScope }, principal: McpPrincipal, resourceMetadataUrl?: string): Response {
  const scopes = stepUpScopes(principal, denied.scope).join(" ");
  const how = principal.kind === "oauth"
    ? "Reconnect the connector and allow it"
    : principal.kind === "key"
      ? `Give this MCP key the scope (settings.mcp.keys or POLPO_MCP_KEY_SCOPES)`
      : "Ask the instance's admin for it";
  const message = `${denied.tool} needs the ${denied.scope} scope (${SCOPES[denied.scope].label}), which this connection was not given. ${how}.`;
  const header = [
    `Bearer error="insufficient_scope"`,
    `scope="${scopes}"`,
    ...(resourceMetadataUrl ? [`resource_metadata="${resourceMetadataUrl}"`] : []),
    `error_description="${message.replace(/"/g, "'")}"`,
  ].join(", ");
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: denied.id,
    error: { code: -32003, message, data: { error: "insufficient_scope", required_scope: denied.scope, scope: scopes, granted_scopes: principal.scopes } },
  }), { status: 403, headers: { "content-type": "application/json", "www-authenticate": header } });
}

/** Does any message of the request ask for progress notifications? */
function wantsProgress(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    const meta = (m as { params?: { _meta?: { progressToken?: unknown } } } | null)?.params?._meta;
    return meta?.progressToken !== undefined;
  });
}

/**
 * Handle one MCP request (Streamable HTTP, stateless). Responses are plain JSON, except when the
 * client asked for progress (a progressToken): then that request answers as an event stream, so
 * the progress notifications reach it before the result.
 */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const body = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
  if (deps.log && request.method === "POST") {
    const who = deps.principal ? ` [${deps.principal.actor}; ${deps.principal.scopes.join(" ")}]` : "";
    for (const line of describeMcpMessages(body)) deps.log(`${line}${who}`);
  }
  // a connector URL may narrow the toolsets: /mcp?toolsets=core,tasks (never beyond the configured ones)
  const requested = new URL(request.url).searchParams.get("toolsets");
  const configured = deps.toolsets ? resolveToolsets(deps.toolsets) : resolveToolsets();
  const narrowed = requested ? resolveToolsets(requested).filter((t) => configured.includes(t)) : configured;
  const toolsets = narrowed.length ? narrowed : configured;
  // a tool the caller's scopes do not cover: 403 with the scopes to ask for (step-up), before any work
  const denied = request.method === "POST" ? deniedToolCall(body, deps.principal ?? FULL_ACCESS, toolsets) : null;
  if (denied) {
    deps.log?.(`tools/call ${denied.tool} refused: needs ${denied.scope}${deps.principal ? ` [${deps.principal.actor}]` : ""}`);
    return insufficientScopeResponse(denied, deps.principal ?? FULL_ACCESS, deps.resourceMetadataUrl);
  }
  const server = createPolpoMcpServer({ ...deps, toolsets });
  const stream = wantsProgress(body);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !stream });
  await server.connect(transport);
  const close = () => { void server.close().catch(() => {}); };
  let res: Response;
  try {
    res = await transport.handleRequest(request);
  } catch (err) {
    close();
    throw err;
  }
  // an event stream is still being written: close the server when it ends
  if (!stream || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    close();
    return res;
  }
  const body2 = res.body.pipeThrough(new TransformStream({ flush: close }));
  return new Response(body2, { status: res.status, headers: res.headers });
}

/** The toolsets, for docs and the dashboard. */
export const MCP_TOOLSETS = TOOLSETS;
