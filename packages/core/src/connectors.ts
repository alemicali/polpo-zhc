/**
 * Connectors: workspace-level links to external tools over the Model Context Protocol (MCP), like
 * Claude's connectors. A connector is configured once (Settings → Connectors, the API or Polpo),
 * and the agents it grants (and Polpo itself) get its tools as `mcp__<connector>__<tool>`.
 *
 * Config lives in `.polpo/connectors.json`. Secrets (bearer tokens, header values, OAuth tokens,
 * client secrets, registered client info, PKCE verifier and state) live ONLY in the vault under
 * the reserved owner `$connectors` (service = connector id, or `oauth-app:<id>` for a shared
 * OAuth app), never in the config file and never in an API response.
 */

/** A vendor icon: a simple-icons slug, an inline SVG or PNG (data or bundled path), and a brand color. */
export interface ConnectorIcon {
  simpleIcons?: string | null;
  svg?: string | null;
  png?: string | null;
  color?: string;
}

/** How the client reaches the MCP server. */
export interface ConnectorTransport {
  /** "http": streamable HTTP, falling back to SSE automatically; "sse": legacy SSE; "stdio": a local process (admin only). */
  type: "http" | "sse" | "stdio";
  /** Remote server URL (http, sse). */
  url?: string;
  /** stdio: command and arguments. */
  command?: string;
  args?: string[];
  /** stdio: extra environment. Values may reference the connector's vault secrets as `${vault:KEY}`. */
  env?: Record<string, string>;
  /** Non-secret extra headers (http, sse). Secret ones go through auth "headers". */
  headers?: Record<string, string>;
}

export type ConnectorAuthType = "none" | "bearer" | "headers" | "oauth";

/** OAuth settings (no secrets here: the client secret and tokens are in the vault). */
export interface ConnectorOAuthSettings {
  /** Pre-registered client id (servers without dynamic client registration). The secret is write-only, in the vault. */
  clientId?: string;
  /** Shared OAuth app (`ConnectorOAuthApp.id`): one client set up once, reused by several connectors (e.g. "google"). */
  app?: string;
  /** Scopes to request; default: what the server advertises. */
  scopes?: string[];
  /** Extra authorization request parameters, e.g. { access_type: "offline", prompt: "consent" } for Google. */
  extraAuthParams?: Record<string, string>;
  /** Authorization server (issuer) when the MCP server publishes no protected-resource metadata, e.g. https://accounts.google.com. */
  authorizationServer?: string;
}

export interface ConnectorAuth {
  type: ConnectorAuthType;
  /** auth "headers": the names of the secret headers (values in the vault). */
  headerNames?: string[];
  oauth?: ConnectorOAuthSettings;
}

/** Who may use the connector's tools. */
export interface ConnectorAccess {
  /** Agent names, or "*" for every agent. */
  agents: string[] | "*";
  /** Polpo (the orchestrator chat) gets the tools too. */
  polpo: boolean;
}

/** Per-tool policy: "off" hides the tool, "ask" needs the person's approval before it runs (chat), "allow" (default) runs it. */
export type ConnectorToolPolicy = "allow" | "ask" | "off";

export type ConnectorStatus =
  | "disconnected"   // never connected, or disconnected by the person
  | "connecting"
  | "connected"
  | "needs_auth"     // OAuth connector that was never authorized
  | "needs_reauth"   // tokens expired / revoked and refresh failed
  | "error"          // last attempt failed (network, server error…)
  | "disabled";

export interface ConnectorConfig {
  /** Slug: [a-z0-9][a-z0-9-]{0,39}. Used in tool names (mcp__<id>__<tool>) and as the vault service. */
  id: string;
  name: string;
  /** Only "mcp" today; kept for forward compatibility. */
  kind: "mcp";
  description?: string;
  transport: ConnectorTransport;
  auth: ConnectorAuth;
  access: ConnectorAccess;
  enabled: boolean;
  /** Catalog entry it was created from, if any. */
  catalogId?: string;
  /** Icon copied from the catalog entry. */
  icon?: ConnectorIcon;
  /** Tool call timeout (ms); default 60 000. */
  toolTimeoutMs?: number;
  /** Per-tool policy keyed by the server's tool name (not the prefixed one). Missing = "allow". */
  toolPolicy?: Record<string, ConnectorToolPolicy>;
  createdAt: string;
  updatedAt?: string;
  /** Cached state (written by the connection manager). */
  status?: ConnectorStatus;
  lastError?: string;
  toolCount?: number;
  lastConnectedAt?: string;
}

/** A shared OAuth app (client id here; the client secret in the vault, `$connectors` / `oauth-app:<id>`). */
export interface ConnectorOAuthApp {
  id: string;
  name?: string;
  clientId: string;
  createdAt: string;
  updatedAt?: string;
}

/** What `.polpo/connectors.json` holds. */
export interface ConnectorsFile {
  connectors: ConnectorConfig[];
  oauthApps?: ConnectorOAuthApp[];
}

/** Catalog of well-known remote MCP servers. */
export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Fixed endpoint. */
  url?: string;
  /** Per-account / per-tenant endpoint the person fills in, e.g. "https://mcp.dev.azure.com/{organization}". */
  urlTemplate?: string;
  /** Region / environment endpoints to pick from (the first is the default). */
  variants?: Array<{ label: string; url: string }>;
  transport: "http" | "sse";
  /** "oauth": DCR / CIMD; "oauth_preregistered": needs a client id/secret (a shared `oauth.app`); "bearer": a token; "none". */
  auth: "oauth" | "oauth_preregistered" | "bearer" | "none";
  /** How the OAuth client is registered with the server. */
  oauthRegistration?: "dcr" | "cimd" | "dcr+cimd" | "preregistered" | null;
  /** auth "bearer" sent in this header instead of Authorization: Bearer (e.g. X-Goog-Api-Key). */
  authHeader?: string;
  authNotes?: string;
  oauth?: Omit<ConnectorOAuthSettings, "clientId">;
  inClaudeDirectory?: boolean;
  inLovable?: boolean;
  docs?: string;
  domain?: string;
  /** The vendor's official icon (bundled by the UI; no hotlinking). */
  icon?: ConnectorIcon;
  /** The endpoint was checked against the vendor's documentation. */
  verified: boolean;
  /** Setup steps shown before connecting (e.g. Google: create a Web OAuth client…). */
  setup?: string;
}

/** Event payload for `connector:changed`. */
export interface ConnectorChangedEvent {
  id: string;
  status: ConnectorStatus;
  action?: "created" | "updated" | "deleted" | "status";
  toolCount?: number;
  error?: string;
}

export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Vault owner for connector secrets (reserved: never exposed to agents). */
export const CONNECTORS_VAULT_OWNER = "$connectors";
export const DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS = 60_000;

/** True when the connector's tools may be used by `agent` (or by Polpo when agent is undefined). */
export function connectorGrants(connector: Pick<ConnectorConfig, "access" | "enabled">, agent: string | undefined): boolean {
  if (!connector.enabled) return false;
  if (agent === undefined) return !!connector.access?.polpo;
  const agents = connector.access?.agents;
  return agents === "*" || (Array.isArray(agents) && agents.includes(agent));
}

/** Slugify a name into a connector id. */
export function connectorSlug(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "connector";
}
