/**
 * Vault tools for agents to access their own credentials at runtime.
 *
 * Provides read-only access to the agent's resolved vault:
 * - vault_get: retrieve credentials for a specific service
 * - vault_list: list available services (keys only, values masked)
 *
 * The vault is pre-resolved at spawn time — ${ENV_VAR} references are already
 * replaced with actual values. Agents can only see their own credentials.
 *
 * Sandboxed runs (any provider but "local"): vault_get does not return secret values. It shows
 * the entry's type, label, key names and the non-secret fields (NON_SECRET_VAULT_FIELDS), and
 * points to bash's env_from_vault, which hands the values to one command and masks them in its
 * output. Tools that use the vault internally (email, image, storage…) are unaffected.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResolvedVault } from "../vault/index.js";
import { isNonSecretVaultField, suggestedEnvVarName, SECRET_MASK } from "../vault/env-from-vault.js";

export interface VaultToolsOptions {
  /**
   * The effective sandbox provider of the run. Anything but "local" (bwrap, docker, daytona, e2b)
   * hides secret values from vault_get. Undefined = no sandbox (as "local").
   */
  sandboxProvider?: string;
}

/** True when secrets reach commands only through env_from_vault (sandboxed runs). */
export function vaultSecretsHidden(sandboxProvider: string | undefined): boolean {
  return !!sandboxProvider && sandboxProvider !== "local";
}

// ─── Tool names ───

export const ALL_VAULT_TOOL_NAMES = ["vault_get", "vault_list"] as const;
export type VaultToolName = (typeof ALL_VAULT_TOOL_NAMES)[number];

// ─── Tool: vault_get ───

const VaultGetSchema = Type.Object({
  service: Type.String({ description: "Service name to retrieve credentials for (e.g. 'smtp', 'openai', 'stripe')" }),
});

function createVaultGetTool(vault: ResolvedVault, opts: VaultToolsOptions = {}): AgentTool<typeof VaultGetSchema> {
  const hidden = vaultSecretsHidden(opts.sandboxProvider);
  return {
    name: "vault_get",
    label: "Get Vault Credentials",
    description: hidden
      ? "Describe a service in your vault: its type, label, credential key names and non-secret fields (host, port, user…). "
        + "Secret values are not returned in this sandbox: to use them in a command, pass them to bash with env_from_vault "
        + "(e.g. {\"GITHUB_TOKEN\": \"github.token\"}) and reference $GITHUB_TOKEN in the command. Use vault_list first to see available services."
      : "Retrieve credentials for a specific service from your vault. Returns all credential key-value pairs for the requested service. Use vault_list first to see available services.",
    parameters: VaultGetSchema,
    async execute(_toolCallId, params) {
      const creds = vault.get(params.service);
      if (!creds) {
        return {
          content: [{ type: "text", text: `No vault entry found for service "${params.service}". Use vault_list to see available services.` }],
          details: { service: params.service, found: false },
        };
      }
      if (hidden) {
        const info = vault.list().find((s) => s.service === params.service);
        const secretKeys: string[] = [];
        const lines = Object.entries(creds).map(([key, value]) => {
          if (isNonSecretVaultField(key, value)) return `  ${key}: ${value}`;
          secretKeys.push(key);
          return `  ${key}: ${SECRET_MASK}`;
        });
        const example = secretKeys[0] ?? Object.keys(creds)[0];
        const header = `Vault entry "${params.service}" (${info?.type ?? "custom"}${info?.label ? `, label: ${info.label}` : ""}):`;
        const hint = example
          ? `Secret values are not shown in sandboxed runs. To use one in a command, call bash with env_from_vault, e.g. `
            + `{"${suggestedEnvVarName(params.service, example)}": "${params.service}.${example}"}, and reference $${suggestedEnvVarName(params.service, example)} in the command: `
            + `the value exists only in that command's environment and appears as ${SECRET_MASK} in its output. Do not write it to files.`
          : "";
        return {
          content: [{ type: "text", text: [header, ...lines, ...(hint ? ["", hint] : [])].join("\n") }],
          details: { service: params.service, found: true, keys: Object.keys(creds), secretsHidden: true },
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

function createVaultListTool(vault: ResolvedVault, opts: VaultToolsOptions = {}): AgentTool<typeof VaultListSchema> {
  const hidden = vaultSecretsHidden(opts.sandboxProvider);
  return {
    name: "vault_list",
    label: "List Vault Services",
    description: hidden
      ? "List all available services in your vault. Shows service names, types, and credential key names (values are not shown). In this sandbox, commands get secret values through bash's env_from_vault (\"service.key\")."
      : "List all available services in your vault. Shows service names, types, and credential key names (values are not shown). Use vault_get to retrieve actual credential values.",
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
      const hint = hidden ? `\nSecret values reach commands only through bash's env_from_vault, e.g. {"VAR": "service.key"}.` : "";
      return {
        content: [{ type: "text", text: `${services.length} vault service(s):\n${lines.join("\n")}${hint}` }],
        details: { count: services.length, services: services.map(s => s.service) },
      };
    },
  };
}

// ─── Factory ───

/**
 * Create vault tools (core — always included when vault is available).
 * Vault tools are core tools: they are always available to every agent
 * that has a resolved vault, regardless of allowedTools configuration.
 */
export function createVaultToolsCore(vault: ResolvedVault, opts: VaultToolsOptions = {}): AgentTool<any>[] {
  return [createVaultGetTool(vault, opts), createVaultListTool(vault, opts)];
}

/**
 * Create vault tools for an agent, filtered by allowedTools.
 * @deprecated Use createVaultToolsCore() — vault tools are now core tools (always available).
 */
export function createVaultTools(vault: ResolvedVault, allowedTools?: string[], opts: VaultToolsOptions = {}): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];
  const allowed = (name: string) => !allowedTools || allowedTools.includes(name);

  if (allowed("vault_get")) tools.push(createVaultGetTool(vault, opts));
  if (allowed("vault_list")) tools.push(createVaultListTool(vault, opts));

  return tools;
}
