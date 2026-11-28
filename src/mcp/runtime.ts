/**
 * The server's connector manager for an orchestrator, the OAuth redirect URI as people reach this
 * instance, and the prompt lines that tell an agent (or Polpo) which connectors it has.
 */
import {
  NO_PERSON, callerConnectorIdentity, connectorAccountsOf, connectorFallbackOn, connectorGrants, connectorIdentityLabel, isIdentityConnector, ORG_CONNECTOR_IDENTITY,
  type AgentConnectorTools, type ConnectorAccount, type ConnectorChangedEvent, type ConnectorConfig, type PolpoSettings, type VaultStore,
} from "@polpo-ai/core";
import { getConnectorManager, type ConnectorManager } from "./manager.js";
import { currentEventOrigin } from "../core/events.js";
import { connectorLabel } from "./view.js";

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
    autoDiscoverIcons: true,
  });
}

/**
 * The person on whose behalf the code runs, for per-identity connectors' person accounts: the
 * signed-in member chatting with Polpo (the event origin's `by` when it is an email, also "ada@acme.com
 * via Claude" through the MCP connector); undefined when nobody is signed in on the dashboard or API
 * (the shared person of an instance without sign-in); NO_PERSON for anyone else (a channel contact,
 * an MCP key, a schedule…), who never uses a person's accounts.
 */
export function currentConnectorPerson(): string | undefined {
  const origin = currentEventOrigin();
  const by = typeof origin?.by === "string" ? origin.by.trim() : "";
  const email = /^([^\s@:]+@[^\s@:]+\.[^\s@:]+)(\s|$)/.exec(by)?.[1];
  if (email) return email.toLowerCase();
  if (!by && (origin?.source === undefined || origin.source === "api" || origin.source === "polpo")) return undefined;
  return NO_PERSON;
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

/** How an account's state reads in the prompt. */
function accountState(a: ConnectorAccount): string {
  return a.status === "connected" ? "connected"
    : a.status === "needs_auth" || a.status === "needs_reauth" ? "needs to be (re)connected by a person"
    : a.status === "error" ? `unavailable${a.lastError ? `: ${a.lastError.slice(0, 120)}` : ""}`
    : a.status ?? "not connected yet";
}

/**
 * The line of a per-identity connector for its caller: its own accounts (default first, by label),
 * the fallback when it is on, or that it has none and a person connects one.
 */
function identityLine(c: ConnectorConfig, agent: string | undefined, person: string | undefined): string {
  const identity = callerConnectorIdentity(agent, person);
  const own = connectorAccountsOf(c, identity);
  const shared = connectorFallbackOn(c) ? connectorAccountsOf(c, ORG_CONNECTOR_IDENTITY) : [];
  const fmt = (a: ConnectorAccount, extra = "") => `"${a.label}"${a.default && !extra ? " (default)" : ""}${extra}${a.account && a.account !== a.label ? ` = ${a.account}` : ""}: ${accountState(a)}`;
  const head = `- ${connectorLabel(c)} (mcp__${c.id}__*), per identity`;
  if (own.length) {
    return `${head}: your accounts ${own.map((a) => fmt(a)).join("; ")}${shared.length ? `; shared fallback ${shared.map((a) => fmt(a, " (organization)")).join("; ")}` : ""}. `
      + `Its tools use your default account; pass account: "<label>" to use another of yours.`;
  }
  if (shared.length) return `${head}: you have no account of your own, so its tools use the organization's shared account ${shared.map((a) => fmt(a, " (organization)")).join("; ")}.`;
  return `${head}: ${connectorIdentityLabel(identity)} has no account on it yet, so its tools fail until a person connects one (Settings → Connectors → ${c.name} → Accounts).`;
}

/**
 * Prompt lines on the connectors `agent` (undefined: Polpo) may use. `person`: who is chatting with
 * Polpo (per-identity connectors show that person's accounts).
 */
export function connectorsPromptSection(connectors: ConnectorConfig[], agent: string | undefined, notes: string[] = [], connectorTools?: AgentConnectorTools, person?: string): string {
  // a connector the agent (or this task's tool scope) selects no tool of is left out
  const granted = connectors.filter((c) => connectorGrants(c, agent) && !(Array.isArray(connectorTools?.[c.id]) && connectorTools![c.id]!.length === 0));
  if (granted.length === 0 && notes.length === 0) return "";
  const lines = [
    "## Connectors",
    "",
    "External apps connected to this workspace (MCP). Their tools are named mcp__<connector>__<tool>; use them for that app instead of the browser or raw HTTP.",
    ...granted.map((c) => {
      if (isIdentityConnector(c)) return identityLine(c, agent, person);
      const selected = connectorTools?.[c.id];
      const state = c.status === "connected" ? (Array.isArray(selected) ? `${selected.length} selected tools` : `${c.toolCount ?? "?"} tools`)
        : c.status === "needs_auth" || c.status === "needs_reauth" ? "needs to be (re)connected by a person in Settings → Connectors"
        : c.status === "error" ? `unavailable${c.lastError ? `: ${c.lastError.slice(0, 160)}` : ""}`
        : c.status ?? "not connected yet";
      return `- ${connectorLabel(c)} (mcp__${c.id}__*): ${state}`;
    }),
    ...notes.map((n) => `- Note: ${n}`),
  ];
  // several accounts of one app (gmail, gmail-2…): say how to pick
  const byApp = new Map<string, ConnectorConfig[]>();
  for (const c of granted) if (c.catalogId && !isIdentityConnector(c)) byApp.set(c.catalogId, [...(byApp.get(c.catalogId) ?? []), c]);
  for (const group of byApp.values()) {
    if (group.length < 2) continue;
    lines.push(`- ${group.length} accounts of the same app: ${group.map((c) => `${c.id} = ${connectorLabel(c)}`).join("; ")}. `
      + "Use the tools of the account the request is about (mcp__<id>__…); if it is not clear which one, ask.");
  }
  return lines.join("\n");
}
