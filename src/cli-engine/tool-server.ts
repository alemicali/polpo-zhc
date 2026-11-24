/**
 * Polpo's tools for the CLI engine: the same host tools the harness engine gives its runtimes
 * (toHarnessHostTools over buildAgentToolset: connectors with their accounts, register_outcome,
 * artifacts, memory, data, messages, vault-granted tools, the task's tool scope and the agent's
 * allowedTools), served to the official `claude` / `codex` program as an MCP server (streamable
 * HTTP, stateless), one per run, with a per-run token:
 *
 *   - this server: http://127.0.0.1:<port>/mcp, Authorization: Bearer <token> (loopback only);
 *   - a remote computer: <POLPO_PUBLIC_URL>/api/v1/harness-relay/<token>/mcp, the harness model
 *     relay's public route, which pipes the request to the run's unix socket (named by the token's
 *     hash, mode 0700 directory). The VM never holds anything but the run's token, revoked at the
 *     end of the run.
 *
 * Claude Code gets it with --mcp-config (and --strict-mcp-config: the repository's .mcp.json and
 * the account's own MCP servers are not loaded, as with the harness), Codex with
 * `-c mcp_servers.polpo.*` (bearer token from an environment variable, never on the command line).
 * Tool calls run here, in the run's process, with the agent's permissions; approvals follow the
 * host tool's `approval` (chats: side-effect tools ask the person first).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HARNESS_RELAY_PATH, relaySocketDir, relaySocketPath } from "../harness/relay.js";
import type { HarnessHostTool } from "../harness/types.js";

/** The MCP server's name in the CLI: Claude Code names its tools mcp__polpo__<tool>, Codex polpo.<tool>. */
export const CLI_TOOL_SERVER_NAME = "polpo";
/** The environment variable Codex reads the bearer token from. */
export const CLI_TOOL_TOKEN_ENV = "POLPO_MCP_TOKEN";
/** The header the relay route passes the path's token in (relay.ts). */
const RELAY_TOKEN_HEADER = "x-polpo-relay-token";

/** A tool call that needs a person's yes (chats): the tool runs only when it returns true. */
export type CliToolApproval = (call: { toolName: string; toolCallId: string; input: unknown }) => Promise<{
  approved: boolean;
  reason?: string;
  /** Not run, and this is what the program is told instead (a chat's preview: the person sends it). */
  message?: string;
}>;

export interface CliToolCallEvent {
  phase: "start" | "end";
  toolName: string;
  toolCallId: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}

export interface CliToolServerOptions {
  tools: readonly HarnessHostTool[];
  /** This server's loopback (the CLI runs here). */
  loopback?: boolean;
  /** A remote computer reaches it through the relay route: the instance's .polpo dir and POLPO_PUBLIC_URL. */
  relay?: { polpoDir: string; publicUrl: string; env?: NodeJS.ProcessEnv };
  /** Asked for tools whose approval is "user-approval" (default: refused, a task cannot ask). */
  approve?: CliToolApproval;
  /** Every call, before and after (activity, transcript). */
  onCall?: (e: CliToolCallEvent) => void;
}

export interface CliToolServer {
  readonly token: string;
  readonly toolNames: string[];
  /** Where the CLI on this server reaches it (loopback). */
  readonly localUrl?: string;
  /** Where a remote computer reaches it (relay). */
  readonly publicUrl?: string;
  /** Claude Code's --mcp-config for the url. */
  claudeMcpConfig(url: string): string;
  /** Codex `-c` overrides for the url (the token comes from CLI_TOOL_TOKEN_ENV). */
  codexConfigArgs(url: string): string[];
  close(): Promise<void>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(sha(a));
  const y = Buffer.from(sha(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Tool output as MCP content. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** The bare tool name of a CLI's tool call to the Polpo server (mcp__polpo__x, polpo.x, polpo__x), or undefined. */
export function polpoToolName(name: string): string | undefined {
  const m = /^(?:mcp__polpo__|polpo[.:]|polpo__)(.+)$/.exec(name);
  return m?.[1];
}

export async function openCliToolServer(o: CliToolServerOptions): Promise<CliToolServer> {
  const token = randomBytes(32).toString("base64url");
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const servers: HttpServer[] = [];
  let socketPath: string | undefined;

  const mcpServer = () => {
    const server = new Server({ name: CLI_TOOL_SERVER_NAME, title: "Polpo", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: o.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
        ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        // Claude Code loads these with the first request (no tool search round trip), like the harness
        _meta: { "anthropic/alwaysLoad": true },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const name = req.params.name;
      const input = req.params.arguments ?? {};
      const t = byName.get(name);
      const toolCallId = `polpo-${randomBytes(6).toString("hex")}`;
      if (!t) return { content: [{ type: "text" as const, text: `Error: unknown Polpo tool "${name}"` }], isError: true };
      o.onCall?.({ phase: "start", toolName: name, toolCallId, input });
      const end = (text: string, isError: boolean) => {
        o.onCall?.({ phase: "end", toolName: name, toolCallId, input, output: text, isError });
        return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
      };
      if (t.approval === "denied") return end(`Error: ${name} is not allowed here`, true);
      if (t.approval === "user-approval") {
        const answer = o.approve
          ? await o.approve({ toolName: name, toolCallId, input }).catch((err) => ({ approved: false, reason: (err as Error).message }))
          : { approved: false, reason: "This run cannot ask a person" };
        if (!answer.approved) {
          if ("message" in answer && answer.message) return end(answer.message, false);
          return end(`Not sent: the person did not approve ${name}${answer.reason ? ` (${answer.reason})` : ""}.`, true);
        }
      }
      try {
        const out = textOf(await t.execute(input, { toolCallId, abortSignal: extra.signal }));
        return end(out, /^Error: /.test(out));
      } catch (err) {
        return end(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    });
    return server;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, viaRelay: boolean) => {
    const given = viaRelay
      ? String(req.headers[RELAY_TOKEN_HEADER] ?? "")
      : String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!given || !sameToken(given, token)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown or revoked token" }));
      return;
    }
    const path = (req.url ?? "/").split("?")[0]!;
    if (path !== "/mcp" && path !== "/mcp/") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      // stateless: no server-sent stream to resume, no session to delete
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const server = mcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  };

  let localUrl: string | undefined;
  if (o.loopback) {
    const s = createServer((req, res) => { void handle(req, res, false); });
    await new Promise<void>((ok, fail) => { s.once("error", fail); s.listen(0, "127.0.0.1", () => { s.off("error", fail); ok(); }); });
    servers.push(s);
    localUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
  }
  let publicUrl: string | undefined;
  if (o.relay) {
    const dir = relaySocketDir(o.relay.polpoDir, o.relay.env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
    socketPath = relaySocketPath(o.relay.polpoDir, token, o.relay.env);
    rmSync(socketPath, { force: true });
    const s = createServer((req, res) => { void handle(req, res, true); });
    await new Promise<void>((ok, fail) => { s.once("error", fail); s.listen(socketPath, () => { s.off("error", fail); ok(); }); });
    try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }
    servers.push(s);
    publicUrl = `${o.relay.publicUrl.replace(/\/+$/, "")}${HARNESS_RELAY_PATH}/${token}/mcp`;
  }

  return {
    token,
    toolNames: o.tools.map((t) => t.name),
    ...(localUrl ? { localUrl } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    claudeMcpConfig: (url) => JSON.stringify({
      mcpServers: { [CLI_TOOL_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } },
    }),
    codexConfigArgs: (url) => [
      "-c", `mcp_servers.${CLI_TOOL_SERVER_NAME}.url=${JSON.stringify(url)}`,
      "-c", `mcp_servers.${CLI_TOOL_SERVER_NAME}.bearer_token_env_var=${JSON.stringify(CLI_TOOL_TOKEN_ENV)}`,
      // a Polpo tool may take minutes (a browser, a long query): Codex's default is 60 s
      "-c", `mcp_servers.${CLI_TOOL_SERVER_NAME}.tool_timeout_sec=900`,
    ],
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
      if (socketPath) rmSync(socketPath, { force: true });
    },
  };
}
