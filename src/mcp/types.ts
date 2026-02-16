/**
 * MCP server configuration types.
 */

/** Stdio-based MCP server — spawns a child process */
export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** SSE-based MCP server (legacy, prefer HTTP) */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/** HTTP-based MCP server (streamable HTTP, recommended for remote) */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Union of all supported MCP server configs */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig;
