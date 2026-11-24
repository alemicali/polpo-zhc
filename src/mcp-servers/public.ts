/**
 * The public endpoint: POLPO_PUBLIC_URL/mcp/servers/<id>, Streamable HTTP (stateless, JSON
 * responses), MCP compliant (initialize, tools/list with annotations and outputSchema, tools/call
 * with structured content, resources for MCP Apps widgets).
 *
 * Anyone with the URL may call it, and calls run with the instance's credentials, so:
 * - only servers marked public, deployed and not switched off answer (others: 404, the same as a
 *   server that does not exist);
 * - destructive / approval tools are neither listed nor callable unless the tool says publicCallable;
 * - per-IP and global rate limits (requests per minute; 429 with Retry-After);
 * - every tool call is logged with the caller's address; request bodies are capped.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHostedMcpServer, type HostedRuntimeDeps } from "./runtime.js";
import { McpServerStore } from "./store.js";
import { DEFAULT_RATE_LIMITS, MCP_SERVER_ID_PATTERN, type PublicRateLimits } from "./types.js";

export const PUBLIC_MCP_SERVERS_PATH = "/mcp/servers";
const MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_MS = 60_000;

/** Sliding one-minute windows per key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Record a hit when under `limit`; else the ms until the next one is allowed. */
  take(key: string, limit: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return { ok: false, retryAfterMs: Math.max(1, WINDOW_MS - (t - list[0]!)) };
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < WINDOW_MS)) this.hits.delete(k);
    return { ok: true };
  }
}

export interface PublicMcpOptions {
  serverId: string;
  ip: string;
  deps: HostedRuntimeDeps;
  limiter: RateLimiter;
  log?: (line: string) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function rpcError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { jsonrpc: "2.0", error: { code: status === 429 ? -32029 : -32000, message }, id: null }, headers);
}

export async function handlePublicMcpRequest(request: Request, opts: PublicMcpOptions): Promise<Response> {
  const { serverId, ip, deps, limiter } = opts;
  const store = new McpServerStore(deps.polpoDir);
  const meta = MCP_SERVER_ID_PATTERN.test(serverId) ? store.meta(serverId) : undefined;
  // a private server does not exist from the outside
  if (!meta || meta.visibility !== "public") return rpcError(404, "No such MCP server");
  if (meta.disabled) return rpcError(503, "This MCP server is switched off");
  if (request.method === "GET" || request.method === "DELETE") {
    // stateless: no server-initiated stream, no sessions to end
    return rpcError(405, "Method not allowed: POST JSON-RPC messages to this endpoint", { allow: "POST" });
  }
  if (request.method !== "POST") return rpcError(405, "Method not allowed", { allow: "POST" });
  const limits: PublicRateLimits = meta.rateLimits ?? DEFAULT_RATE_LIMITS;
  for (const [key, limit] of [[`ip:${serverId}:${ip}`, limits.perIpPerMinute], [`all:${serverId}`, limits.globalPerMinute]] as const) {
    const r = limiter.take(key, limit);
    if (!r.ok) {
      opts.log?.(`public ${serverId}: rate limited ${ip} (${key.startsWith("ip:") ? "per IP" : "global"})`);
      return rpcError(429, "Too many requests: slow down", { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
    }
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return rpcError(413, "Request too large");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return rpcError(413, "Request too large");
  const server = createHostedMcpServer({ serverId, source: "public", ip }, deps);
  if (!server) return rpcError(404, "No such MCP server");
  opts.log?.(`public ${serverId} ${ip}: ${describe(body)}`);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body });
    return await transport.handleRequest(forwarded);
  } finally {
    void server.close().catch(() => undefined);
  }
}

function describe(body: string): string {
  try {
    const msgs = ([] as Array<{ method?: string; params?: { name?: string } }>).concat(JSON.parse(body));
    return msgs.map((m) => (m.method === "tools/call" ? `tools/call ${m.params?.name ?? "?"}` : m.method ?? "response")).join(", ");
  } catch { return "invalid JSON"; }
}
