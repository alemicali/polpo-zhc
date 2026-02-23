/**
 * MCP (Model Context Protocol) client manager.
 *
 * Connects to MCP servers (stdio or HTTP), discovers their tools,
 * and bridges them into pi-agent-core's AgentTool format so the
 * built-in engine can use them alongside its native coding tools.
 *
 * Lifecycle:
 *   1. connectAll(mcpServers) — connect to all configured servers
 *   2. getTools() — returns AgentTool[] wrapping all discovered MCP tools
 *   3. close() — disconnect all servers, kill stdio processes
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { McpServerConfig } from "./types.js";
import { mcpSafeEnv } from "../tools/safe-env.js";

// ── MCP server connection ──

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
}

// ── McpClientManager ──

export class McpClientManager {
  private servers: ConnectedServer[] = [];
  private tools: AgentTool[] = [];
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Connect to all configured MCP servers and discover their tools.
   * Servers that fail to connect are logged and skipped (non-fatal).
   *
   * @param mcpServers - Server configurations keyed by server name
   * @param log - Optional log function for status messages
   * @param toolAllowlist - Optional allowlist: keys are server names, values are allowed tool names.
   *   When set for a server, only listed tools are exposed. Unlisted servers are unrestricted.
   */
  async connectAll(
    mcpServers: Record<string, McpServerConfig>,
    log?: (msg: string) => void,
    toolAllowlist?: Record<string, string[]>,
  ): Promise<void> {
    const entries = Object.entries(mcpServers);
    if (entries.length === 0) return;

    const emit = log ?? console.log;

    for (const [name, config] of entries) {
      try {
        const server = await this.connectServer(name, config);
        this.servers.push(server);

        // Discover tools
        const { tools: mcpTools } = await server.client.listTools();
        emit(`[mcp] ${name}: connected, ${mcpTools.length} tool(s) discovered`);

        // Apply tool allowlist filtering for this server
        const allowedNames = toolAllowlist?.[name];
        const filteredTools = allowedNames
          ? mcpTools.filter(t => {
              const allowed = allowedNames.includes(t.name);
              if (!allowed) emit(`[mcp] ${name}: tool "${t.name}" blocked by allowlist`);
              return allowed;
            })
          : mcpTools;

        // Bridge each MCP tool to AgentTool format
        for (const tool of filteredTools) {
          this.tools.push(
            bridgeMcpTool(name, tool, server.client),
          );
        }
      } catch (err) {
        emit(`[mcp] ${name}: failed to connect — ${(err as Error).message}`);
      }
    }
  }

  /** Get all discovered tools as AgentTool[] */
  getTools(): AgentTool[] {
    return this.tools;
  }

  /** Get connected server names */
  getServerNames(): string[] {
    return this.servers.map((s) => s.name);
  }

  /** Close all connections and kill stdio processes */
  async close(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.transport.close();
      } catch {
        // best-effort cleanup
      }
    }
    this.servers = [];
    this.tools = [];
  }

  // ── Private ──

  private async connectServer(
    name: string,
    config: McpServerConfig,
  ): Promise<ConnectedServer> {
    const client = new Client(
      { name: `polpo-${name}`, version: "1.0.0" },
      { capabilities: {} },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

    if ("command" in config) {
      // stdio transport
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: mcpSafeEnv(config.env),
        cwd: this.cwd,
      });
    } else if ("url" in config) {
      const url = new URL(config.url);
      // Build requestInit with configured headers (auth tokens, API keys, etc.)
      const requestInit: RequestInit | undefined = config.headers
        ? { headers: config.headers }
        : undefined;
      if (config.type === "sse") {
        transport = new SSEClientTransport(url, { requestInit });
      } else {
        // Default to streamable HTTP (newer, preferred)
        transport = new StreamableHTTPClientTransport(url, { requestInit });
      }
    } else {
      throw new Error(`Invalid MCP server config for "${name}": must have "command" or "url"`);
    }

    await client.connect(transport);
    return { name, client, transport };
  }
}

// ── Tool bridging ──

/**
 * Convert an MCP Tool into a pi-agent-core AgentTool.
 *
 * MCP tools use JSON Schema for inputSchema.
 * Pi-agent-core tools use TypeBox schemas (which ARE JSON Schema under the hood).
 * We use Type.Unsafe() to wrap the raw JSON Schema so pi-agent-core can use it.
 *
 * The tool name is prefixed with the server name to avoid collisions:
 * e.g. "filesystem:read_file", "github:create_issue"
 */
function bridgeMcpTool(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  client: Client,
): AgentTool<TSchema> {
  // Use the MCP inputSchema as-is via Type.Unsafe()
  // This preserves all JSON Schema properties (type, properties, required, etc.)
  const schema = Type.Unsafe(mcpTool.inputSchema);

  const qualifiedName = `${serverName}:${mcpTool.name}`;

  return {
    name: qualifiedName,
    label: mcpTool.name,
    description: mcpTool.description ?? `MCP tool from ${serverName}`,
    parameters: schema,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ server: string; tool: string }>> {
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await client.callTool(
        { name: mcpTool.name, arguments: args },
        undefined,
        signal ? { signal } : undefined,
      );

      // Convert MCP content to pi-agent-core content format
      const content: AgentToolResult<unknown>["content"] = [];

      if (result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === "text") {
            content.push({ type: "text" as const, text: item.text as string });
          } else if (item.type === "image") {
            content.push({
              type: "image" as const,
              data: item.data as string,
              mimeType: (item.mimeType as string) ?? "image/png",
            });
          } else {
            // resource, resource_link, audio — fallback to text representation
            content.push({ type: "text" as const, text: JSON.stringify(item) });
          }
        }
      }

      // If callTool returned an error, prepend error info
      if (result.isError) {
        content.unshift({
          type: "text" as const,
          text: `[MCP Error] Tool "${mcpTool.name}" returned an error.`,
        });
      }

      // Ensure at least some content
      if (content.length === 0) {
        content.push({ type: "text" as const, text: "(empty result)" });
      }

      return {
        content,
        details: { server: serverName, tool: mcpTool.name },
      };
    },
  };
}
