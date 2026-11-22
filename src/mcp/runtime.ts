/**
 * The server's connector manager for an orchestrator, the OAuth redirect URI as people reach this
 * instance, and the prompt lines that tell an agent (or Polpo) which connectors it has.
 */
import { connectorGrants, type AgentConnectorTools, type ConnectorChangedEvent, type ConnectorConfig, type PolpoSettings, type VaultStore } from "@polpo-ai/core";
import { getConnectorManager, type ConnectorManager } from "./manager.js";

import { CONNECTOR_OAUTH_CALLBACK_PATH } from "./paths.js";
export { CONNECTOR_OAUTH_CALLBACK_PATH, CONNECTOR_CLIENT_METADATA_PATH, clientMetadataDocument, clientMetadataUrlFor } from "./paths.js";

export interface ConnectorHost {
  getPolpoDir(): string;
  getVaultStore?(): VaultStore | undefined;
  getConfig?(): { settings?: PolpoSettings } | null | undefined;
  emit(event: "connector:changed", payload: ConnectorChangedEvent): unknown;
}

/** The (per .polpo dir) connector manager of a running orchestrator. */
export function connectorManagerFor(host: ConnectorHost): ConnectorManager {
  return getConnectorManager({
    polpoDir: host.getPolpoDir(),
    vaultStore: host.getVaultStore?.(),
    settings: () => host.getConfig?.()?.settings ?? undefined,
    emit: (event) => { host.emit("connector:changed", event); },
  });
}

let notedOrigin: string | undefined;

/** Remember the public origin of the last API request (Polpo's tools have no request at hand). */
export function notePublicOrigin(origin: string | undefined): void {
  if (origin) notedOrigin = origin.replace(/\/+$/, "");
}

/** The public origin: POLPO_PUBLIC_URL, else the origin the dashboard or API was last reached at. */
export function knownPublicOrigin(): string | undefined {
  return configuredPublicUrl() || notedOrigin;
}

/** POLPO_PUBLIC_URL (no trailing slash), when set. */
function configuredPublicUrl(): string | undefined {
  return process.env.POLPO_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
}

/**
 * The base of every URL a third-party OAuth provider must reach (redirect URI, Client ID Metadata
 * Document): POLPO_PUBLIC_URL whenever it is set, whatever host the request came through (the
 * dashboard may call the API on a private port), else the request's public origin.
 */
export function connectorPublicBase(requestOrigin: string): string {
  return configuredPublicUrl() ?? requestOrigin.replace(/\/+$/, "");
}

/** Where the browser goes back after the OAuth callback: the dashboard (POLPO_DASHBOARD_URL, POLPO_UI_PUBLIC_URL), else `fallback`. */
export function connectorDashboardBase(fallback: string): string {
  return (process.env.POLPO_DASHBOARD_URL?.trim() || process.env.POLPO_UI_PUBLIC_URL?.trim() || fallback).replace(/\/+$/, "");
}

/** The OAuth redirect URI: POLPO_PUBLIC_URL, else the origin the dashboard was last reached at. */
export function connectorRedirectUri(): string | undefined {
  const base = configuredPublicUrl() || notedOrigin;
  return base ? `${base}${CONNECTOR_OAUTH_CALLBACK_PATH}` : undefined;
}

/** Prompt lines on the connectors `agent` (undefined: Polpo) may use. */
export function connectorsPromptSection(connectors: ConnectorConfig[], agent: string | undefined, notes: string[] = [], connectorTools?: AgentConnectorTools): string {
  // a connector the agent (or this task's tool scope) selects no tool of is left out
  const granted = connectors.filter((c) => connectorGrants(c, agent) && !(Array.isArray(connectorTools?.[c.id]) && connectorTools![c.id]!.length === 0));
  if (granted.length === 0 && notes.length === 0) return "";
  const lines = [
    "## Connectors",
    "",
    "External apps connected to this workspace (MCP). Their tools are named mcp__<connector>__<tool>; use them for that app instead of the browser or raw HTTP.",
    ...granted.map((c) => {
      const selected = connectorTools?.[c.id];
      const state = c.status === "connected" ? (Array.isArray(selected) ? `${selected.length} selected tools` : `${c.toolCount ?? "?"} tools`)
        : c.status === "needs_auth" || c.status === "needs_reauth" ? "needs to be (re)connected by a person in Settings → Connectors"
        : c.status === "error" ? `unavailable${c.lastError ? `: ${c.lastError.slice(0, 160)}` : ""}`
        : c.status ?? "not connected yet";
      return `- ${c.name} (mcp__${c.id}__*): ${state}`;
    }),
    ...notes.map((n) => `- Note: ${n}`),
  ];
  return lines.join("\n");
}
