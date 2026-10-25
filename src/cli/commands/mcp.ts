/**
 * `polpo mcp` — Polpo as a local MCP server over stdio, for clients that start a process instead of
 * connecting to a URL. It forwards everything to a running Polpo server's /mcp endpoint, so the
 * tools are exactly the server's and follow its rules.
 *
 *   polpo mcp --url https://polpo.example.com --api-key <key>
 *   (or POLPO_URL / POLPO_API_KEY in the environment)
 *
 * stdout carries the protocol only: every message for people goes to stderr.
 */
import { Command } from "commander";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { POLPO_PACKAGE_VERSION } from "../../core/version.js";

/** The /mcp endpoint of a server URL (given as the server, or already as its /mcp). */
export function mcpEndpoint(url: string): URL {
  const u = new URL(url);
  if (!u.pathname.replace(/\/+$/, "").endsWith("/mcp")) u.pathname = `${u.pathname.replace(/\/+$/, "")}/mcp`;
  return u;
}

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Run Polpo as a local MCP server (stdio) for Claude Desktop, Codex and other MCP clients, forwarding to a Polpo server")
    .option("--url <url>", "The Polpo server (or its /mcp URL)", process.env.POLPO_URL ?? "http://127.0.0.1:3000")
    .option("--api-key <key>", "The server's API key (or POLPO_API_KEY)", process.env.POLPO_API_KEY)
    .action(async (opts: { url: string; apiKey?: string }) => {
      const endpoint = mcpEndpoint(opts.url);
      const upstream = new Client({ name: "polpo-mcp-stdio", version: POLPO_PACKAGE_VERSION });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} },
      });
      try {
        await upstream.connect(transport);
      } catch (err) {
        console.error(`polpo mcp: cannot reach ${endpoint.href}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const info = upstream.getServerVersion();
      const server = new Server(
        { name: info?.name ?? "polpo", title: "Polpo", version: info?.version ?? POLPO_PACKAGE_VERSION },
        { capabilities: { tools: {} }, instructions: upstream.getInstructions() },
      );
      server.setRequestHandler(ListToolsRequestSchema, async (request) => upstream.listTools(request.params));
      server.setRequestHandler(CallToolRequestSchema, async (request) => upstream.callTool(request.params));
      await server.connect(new StdioServerTransport());
      console.error(`polpo mcp: forwarding to ${endpoint.href}`);
    });
}
