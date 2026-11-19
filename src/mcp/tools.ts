/**
 * MCP tools as pi-agent-core AgentTools: names, schemas, results, and the allowedTools filter.
 *
 * - name: `mcp__<connectorId>__<toolName>`, sanitized to [a-zA-Z0-9_-] and at most 64 characters
 *   (a short hash suffix keeps truncated names unique);
 * - parameters: the server's JSON Schema, passed through (Type.Unsafe) so the model sees the real params;
 * - results: text, images, embedded resources, resource links, structuredContent and isError, with
 *   text capped at MAX_RESULT_TEXT (the rest is cut with a note).
 */
import { createHash } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { matchToolPattern } from "../tools/system-tools.js";

export const MCP_TOOL_PREFIX = "mcp__";
export const MAX_TOOL_NAME = 64;
export const MAX_RESULT_TEXT = 100 * 1024;

/** The tool's name for the model: mcp__<connector>__<tool>. */
export function mcpToolName(connectorId: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `${MCP_TOOL_PREFIX}${clean(connectorId)}__${clean(toolName)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash("sha256").update(`${connectorId}\0${toolName}`).digest("hex").slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Whether an agent's allowedTools lets it use a connector tool. No list: every tool of the
 * connectors granted to it. With a list: exact names or patterns (`mcp__*`, `mcp__linear__*`, `*`).
 */
export function connectorToolAllowed(allowedTools: string[] | undefined, toolName: string): boolean {
  if (!allowedTools) return true;
  return allowedTools.some((pattern) => matchToolPattern(pattern, toolName));
}

/** A tool as listed by an MCP server. */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** The parameters schema for the model: the server's JSON Schema, always an object. */
export function toolParameters(inputSchema: Record<string, unknown> | undefined): TSchema {
  const schema = inputSchema && typeof inputSchema === "object" ? { ...inputSchema } : {};
  if (schema.type !== "object") return Type.Unsafe({ type: "object", properties: {}, ...schema, ...(schema.type ? {} : { type: "object" }) });
  if (!schema.properties) schema.properties = {};
  return Type.Unsafe(schema);
}

type Content = AgentToolResult<unknown>["content"][number];

function truncate(text: string, budget: { left: number }): string {
  if (text.length <= budget.left) {
    budget.left -= text.length;
    return text;
  }
  const kept = text.slice(0, Math.max(0, budget.left));
  const cut = text.length - kept.length;
  budget.left = 0;
  return `${kept}\n\n[truncated: ${cut} more characters were cut — ask for less (filters, pagination)]`;
}

/** Convert an MCP CallToolResult into AgentTool content. */
export function convertToolResult(result: Record<string, unknown>, label: string): { content: Content[]; isError: boolean } {
  const budget = { left: MAX_RESULT_TEXT };
  const content: Content[] = [];
  const pushText = (text: string) => {
    if (budget.left <= 0) return;
    content.push({ type: "text", text: truncate(text, budget) });
  };
  const items = Array.isArray(result.content) ? result.content as Array<Record<string, any>> : [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        pushText(String(item.text ?? ""));
        break;
      case "image":
        if (typeof item.data === "string" && item.data.length <= 5 * 1024 * 1024) {
          content.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
        } else pushText(`[image ${item.mimeType ?? ""} too large to show]`);
        break;
      case "audio":
        pushText(`[audio ${item.mimeType ?? ""}, ${typeof item.data === "string" ? Math.round(item.data.length * 0.75) : 0} bytes — not shown]`);
        break;
      case "resource": {
        const r = item.resource ?? {};
        if (typeof r.text === "string") pushText(`[resource ${r.uri ?? ""}${r.mimeType ? ` (${r.mimeType})` : ""}]\n${r.text}`);
        else if (typeof r.blob === "string" && typeof r.mimeType === "string" && r.mimeType.startsWith("image/") && r.blob.length <= 5 * 1024 * 1024) {
          content.push({ type: "image", data: r.blob, mimeType: r.mimeType });
        } else pushText(`[resource ${r.uri ?? ""}${r.mimeType ? ` (${r.mimeType})` : ""}, binary — not shown]`);
        break;
      }
      case "resource_link":
        pushText(`[link] ${item.name ?? item.title ?? ""} ${item.uri ?? ""}${item.description ? ` — ${item.description}` : ""}${item.mimeType ? ` (${item.mimeType})` : ""}`.trim());
        break;
      default:
        pushText(JSON.stringify(item));
    }
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const json = JSON.stringify(result.structuredContent);
    // servers usually mirror structured output as text: add it only when it says something new
    const textSoFar = content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    if (!textSoFar.includes(json.slice(0, 200))) pushText(`structuredContent: ${json}`);
  }
  // legacy servers return { toolResult }
  if (items.length === 0 && result.toolResult !== undefined) pushText(typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult));
  const isError = result.isError === true;
  if (isError) content.unshift({ type: "text", text: `[${label} returned an error]` });
  if (content.length === 0) content.push({ type: "text", text: "(empty result)" });
  return { content, isError };
}

/** What an MCP-backed AgentTool calls. */
export type McpToolCaller = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;

export interface McpAgentToolDetails {
  connector: string;
  tool: string;
  isError: boolean;
}

/** Bridge one MCP tool into an AgentTool. */
export function bridgeMcpTool(connectorId: string, connectorName: string, tool: McpToolInfo, call: McpToolCaller): AgentTool<TSchema, McpAgentToolDetails> {
  const name = mcpToolName(connectorId, tool.name);
  const label = `${connectorName}: ${tool.title ?? tool.name}`;
  const description = `[${connectorName}] ${tool.description?.trim() || tool.title || tool.name}`.slice(0, 1024);
  return {
    name,
    label,
    description,
    parameters: toolParameters(tool.inputSchema),
    async execute(_id, params, signal) {
      const raw = await call(tool.name, (params ?? {}) as Record<string, unknown>, signal);
      const { content, isError } = convertToolResult(raw, label);
      return { content, details: { connector: connectorId, tool: tool.name, isError }, ...(isError ? { isError: true } : {}) };
    },
  };
}

/** A tool result as one string (chat executors): images and binaries become a short note. */
export function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content.map((c: any) => c.type === "text" ? c.text : c.type === "image" ? `[image ${c.mimeType}]` : "").join("\n");
}
