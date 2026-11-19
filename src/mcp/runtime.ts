/**
 * The server's connector manager for an orchestrator, the OAuth redirect URI as people reach this
 * instance, and the prompt lines that tell an agent (or Polpo) which connectors it has.
 */
import { connectorGrants, type ConnectorChangedEvent, type ConnectorConfig, type PolpoSettings, type VaultStore } from "@polpo-ai/core";
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

/** The OAuth redirect URI: POLPO_PUBLIC_URL, else the origin the dashboard was last reached at. */
export function connectorRedirectUri(): string | undefined {
  const base = process.env.POLPO_PUBLIC_URL?.replace(/\/+$/, "") || notedOrigin;
  return base ? `${base}${CONNECTOR_OAUTH_CALLBACK_PATH}` : undefined;
}

/** Prompt lines on the connectors `agent` (undefined: Polpo) may use. */
export function connectorsPromptSection(connectors: ConnectorConfig[], agent: string | undefined, notes: string[] = []): string {
  const granted = connectors.filter((c) => connectorGrants(c, agent));
  if (granted.length === 0 && notes.length === 0) return "";
  const lines = [
    "## Connectors",
    "",
    "External apps connected to this workspace (MCP). Their tools are named mcp__<connector>__<tool>; use them for that app instead of the browser or raw HTTP.",
    ...granted.map((c) => {
      const state = c.status === "connected" ? `${c.toolCount ?? "?"} tools`
        : c.status === "needs_auth" || c.status === "needs_reauth" ? "needs to be (re)connected by a person in Settings → Connectors"
        : c.status === "error" ? `unavailable${c.lastError ? `: ${c.lastError.slice(0, 160)}` : ""}`
        : c.status ?? "not connected yet";
      return `- ${c.name} (mcp__${c.id}__*): ${state}`;
    }),
    ...notes.map((n) => `- Note: ${n}`),
  ];
  return lines.join("\n");
}
