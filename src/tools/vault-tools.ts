/**
 * Vault tools for agents to access their own credentials at runtime.
 *
 * Provides read-only access to the agent's resolved vault:
 * - vault_get: retrieve credentials for a specific service
 * - vault_list: list available services (keys only, values masked)
 *
 * The vault is pre-resolved at spawn time — ${ENV_VAR} references are already
 * replaced with actual values. Agents can only see their own credentials.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResolvedVault } from "../vault/index.js";

// ─── Tool names ───

export const ALL_VAULT_TOOL_NAMES = ["vault_get", "vault_list"] as const;
export type VaultToolName = (typeof ALL_VAULT_TOOL_NAMES)[number];

// ─── Tool: vault_get ───

const VaultGetSchema = Type.Object({
  service: Type.String({ description: "Service name to retrieve credentials for (e.g. 'smtp', 'openai', 'stripe')" }),
});

function createVaultGetTool(vault: ResolvedVault): AgentTool<typeof VaultGetSchema> {
  return {
    name: "vault_get",
    label: "Get Vault Credentials",
    description: "Retrieve credentials for a specific service from your vault. Returns all credential key-value pairs for the requested service. Use vault_list first to see available services.",
    parameters: VaultGetSchema,
    async execute(_toolCallId, params) {
      const creds = vault.get(params.service);
      if (!creds) {
        return {
          content: [{ type: "text", text: `No vault entry found for service "${params.service}". Use vault_list to see available services.` }],
          details: { service: params.service, found: false },
        };
      }
      const lines = Object.entries(creds).map(([key, value]) => `  ${key}: ${value}`);
      return {
        content: [{ type: "text", text: `Credentials for "${params.service}":\n${lines.join("\n")}` }],
        details: { service: params.service, found: true, keys: Object.keys(creds) },
      };
    },
  };
}

// ─── Tool: vault_list ───

const VaultListSchema = Type.Object({});

function createVaultListTool(vault: ResolvedVault): AgentTool<typeof VaultListSchema> {
  return {
    name: "vault_list",
    label: "List Vault Services",
    description: "List all available services in your vault. Shows service names, types, and credential key names (values are not shown). Use vault_get to retrieve actual credential values.",
    parameters: VaultListSchema,
    async execute() {
      const services = vault.list();
      if (services.length === 0) {
        return {
          content: [{ type: "text", text: "No vault entries configured for this agent." }],
          details: { count: 0, services: [] },
        };
      }
      const lines = services.map(s => `  - ${s.service} (${s.type}): keys=[${s.keys.join(", ")}]`);
      return {
        content: [{ type: "text", text: `${services.length} vault service(s):\n${lines.join("\n")}` }],
        details: { count: services.length, services: services.map(s => s.service) },
      };
    },
  };
}

// ─── Factory ───

/**
 * Create vault tools for an agent.
 * Only includes tools that appear in allowedTools (if provided).
 */
export function createVaultTools(vault: ResolvedVault, allowedTools?: string[]): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];
  const allowed = (name: string) => !allowedTools || allowedTools.includes(name);

  if (allowed("vault_get")) tools.push(createVaultGetTool(vault));
  if (allowed("vault_list")) tools.push(createVaultListTool(vault));

  return tools;
}
