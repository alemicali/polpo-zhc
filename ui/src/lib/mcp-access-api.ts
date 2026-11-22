/**
 * Polpo's own MCP connector: who may use it (OAuth grants, MCP keys) and with which scopes.
 * Thin client for /api/v1/mcp; same envelope ({ ok, data } / { ok, error }) as the other page-level clients.
 */
import { apiUrl, config } from "@/lib/config";

export interface McpScopeInfo {
  id: string;
  label: string;
  description: string;
}

/** A client allowed by a person (from the consent page). */
export interface McpGrant {
  id: string;
  client_id: string;
  client_name: string;
  /** Who allowed it: an email, "api-key" or "local". */
  subject: string;
  scopes: string[];
  /** Issued with the old all-in-one "polpo" scope (every scope). */
  legacy: boolean;
  created_at: string;
  last_used_at?: string;
  expires_at: string;
}

/** A key that opens /mcp, never with its value. */
export interface McpKeyInfo {
  name: string;
  source: "api-key" | "env" | "settings";
  scopes: string[];
  explicit: boolean;
  ref?: string;
  problem?: string;
}

export interface McpAccess {
  scopes: McpScopeInfo[];
  grants: McpGrant[];
  keys: McpKeyInfo[];
  tools: Array<{ name: string; toolset: string; scope: string; destructive: boolean }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string" ? body.error : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `MCP access request failed (${response.status})`);
  }
  return body.data as T;
}

export const mcpAccessApi = {
  get: () => request<McpAccess>("/mcp/access"),
  revokeGrant: (id: string) => request<{ revoked: string }>(`/mcp/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** "polpo:files" → "Files" (the label from the server's list, else the name without its prefix). */
export function scopeLabel(scope: string, scopes: McpScopeInfo[]): string {
  return scopes.find((s) => s.id === scope)?.label ?? scope.replace(/^polpo:/, "");
}

/** The scopes worth showing: admin alone stands for everything (it includes every other scope). */
export function visibleScopes(granted: string[]): string[] {
  return granted.includes("polpo:admin") ? ["polpo:admin"] : granted;
}

export const KEY_SOURCE_LABEL: Record<McpKeyInfo["source"], string> = {
  "api-key": "Server API key",
  env: "Environment variable",
  settings: "settings.mcp.keys",
};
