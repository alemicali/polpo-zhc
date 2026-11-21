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
import { FULL_ACCESS, TOOLSETS, registrar, resolveToolsets, type McpDeps, type ToolsetName } from "./mcp-server/kit.js";
import { registerConversationTools } from "./mcp-server/conversation.js";
import { registerAgentTools, registerApprovalTools, registerArtifactTools, registerDataTools, registerFileTools } from "./mcp-server/core-tools.js";
import { registerTaskTools } from "./mcp-server/tasks.js";
import { registerMissionTools } from "./mcp-server/missions.js";
import { registerAdminTools } from "./mcp-server/admin.js";

export type { ApiResponse, McpDeps, McpPrincipal, ToolsetName } from "./mcp-server/kit.js";
export { MAX_RESULT_CHARS, TOOLSETS, DEFAULT_TOOLSETS, resolveToolsets, hasScope, scopeFor } from "./mcp-server/kit.js";
export { MAX_INLINE_FILE_BYTES, AGENT_CARD_URI } from "./mcp-server/core-tools.js";
export { matchesOperationPath, isBlockedGet } from "./mcp-server/admin.js";

const INSTRUCTIONS = "Polpo orchestrates a team of AI agents (tasks, missions, artifacts, data, approvals, files). "
  + "Use the specific polpo_* tools for reads and actions. For anything open-ended, polpo_ask delegates to Polpo itself, "
  + "which can do everything the instance can; when a turn returns status needs_input (a question or a preview to approve), "
  + "show it to the person and reply with polpo_answer. Long work runs in the background: create it, then follow it with the "
  + "wait and get tools. Destructive actions need confirm: true, given only after the person agreed.";

/** The MCP server for one request (stateless). */
export function createPolpoMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "polpo", title: "Polpo", version: deps.version }, { instructions: INSTRUCTIONS });
  const principal = deps.principal ?? FULL_ACCESS;
  const enabled = new Set<ToolsetName>(deps.toolsets ? resolveToolsets(deps.toolsets) : resolveToolsets());
  const tool = registrar(server, enabled, principal);

  registerConversationTools(tool, deps);
  registerAgentTools(tool, deps, server, enabled, principal);
  registerApprovalTools(tool, deps);
  registerTaskTools(tool, deps);
  registerMissionTools(tool, deps);
  registerArtifactTools(tool, deps);
  registerDataTools(tool, deps);
  registerFileTools(tool, deps);
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
    for (const line of describeMcpMessages(body)) deps.log(`${line}${deps.principal ? ` [${deps.principal.actor}]` : ""}`);
  }
  // a connector URL may narrow the toolsets: /mcp?toolsets=core,tasks (never beyond the configured ones)
  const requested = new URL(request.url).searchParams.get("toolsets");
  const configured = deps.toolsets ? resolveToolsets(deps.toolsets) : resolveToolsets();
  const toolsets = requested ? resolveToolsets(requested).filter((t) => configured.includes(t)) : configured;
  const server = createPolpoMcpServer({ ...deps, toolsets: toolsets.length ? toolsets : configured });
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
