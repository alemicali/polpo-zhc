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

/** Where a custom connector's icon came from (catalog connectors use their bundled icon instead). */
export type ConnectorIconSource = "mcp" | "oauth" | "website" | "upload" | "url";

/** One stored icon image (the bytes are kept by the server and served at GET /connectors/:id/icon). */
export interface ConnectorIconImage {
  mimeType: string;
  /** Content hash: the ETag, and the cache-busting `v` of the icon URL. */
  hash: string;
  width?: number;
  height?: number;
  /** Where the image was fetched from (absent for uploads and inline data). */
  src?: string;
}

/**
 * A custom connector's icon: discovered (the MCP server's `serverInfo.icons`, the OAuth metadata,
 * the vendor's website) or set by the person (upload / URL, `pinned`: discovery leaves it alone).
 */
export interface ConnectorIconAsset extends ConnectorIconImage {
  source: ConnectorIconSource;
  /** A variant made for dark backgrounds (MCP `theme: "dark"`). */
  dark?: ConnectorIconImage;
  fetchedAt: string;
  pinned?: boolean;
}

/** How the client reaches the MCP server. */
export interface ConnectorTransport {
  /**
   * "http": streamable HTTP, falling back to SSE automatically; "sse": legacy SSE; "stdio": a local process (admin only);
   * "hosted": a custom MCP server Polpo hosts itself (served in process, see docs/custom-mcp-servers.md).
   */
  type: "http" | "sse" | "stdio" | "hosted";
  /** hosted: the hosted server's id. */
  serverId?: string;
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
  /**
   * false: leave out the RFC 8707 `resource` parameter (authorization servers that reject every
   * resource indicator with invalid_target, e.g. Semgrep's). Default: sent, as the MCP spec asks.
   */
  resourceIndicator?: boolean;
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

/**
 * Who a connector belongs to. "org" (the default, also when missing): the organization's; its
 * access decides which agents may use it. "agent": one agent's own (a personal mailbox): only that
 * agent may ever use its tools, whatever its access says (access.agents is [owner] or [], never "*").
 * "identity": defined once for the organization (app, OAuth client, tools, rules), and every
 * identity (an agent, or a person chatting with Polpo) connects its own accounts to it
 * (`ConnectorConfig.accounts`); a caller only ever uses its own accounts (default one, or
 * `account: "<label>"`), plus the org fallback account when `fallback` is on (off by default).
 */
export type ConnectorScope = { kind: "org" } | { kind: "agent"; agent: string } | { kind: "identity"; fallback?: boolean };

/**
 * Who a per-identity connector's account belongs to: "agent:<name>", "person:<email>" (a member of
 * the instance, lowercased; "person:_shared" when there is no sign-in) or "org" (the fallback account).
 */
export type ConnectorIdentity = string;

/** One account connected to a per-identity connector: its own credentials (vault) and connection state. */
export interface ConnectorAccount {
  /** Stable id ("acc-" + 10 hex): the vault service is `<connector id>~<account id>`. */
  id: string;
  /** Whose it is. */
  identity: ConnectorIdentity;
  /** The name the identity picks it by (`account: "sitoinchat"`), unique per identity (case-insensitive). */
  label: string;
  /** The identity's default account (exactly one per identity that has accounts). */
  default?: boolean;
  /** The signed-in account (e.g. an email), when known. */
  account?: string;
  /** The connector this account was imported from (conversion of separate connectors). */
  importedFrom?: string;
  createdAt: string;
  updatedAt?: string;
  /** Cached state (written by the connection manager). */
  status?: ConnectorStatus;
  lastError?: string;
  toolCount?: number;
  lastConnectedAt?: string;
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
  /** Display name. Several accounts of one catalog app tell themselves apart by it ("Gmail – info@acme.com"). */
  name: string;
  /** The signed-in account (e.g. an email), when the sign-in revealed it at no extra cost (an OpenID id_token). */
  account?: string;
  /** Only "mcp" today; kept for forward compatibility. */
  kind: "mcp";
  description?: string;
  transport: ConnectorTransport;
  auth: ConnectorAuth;
  access: ConnectorAccess;
  /** Who it belongs to: missing = { kind: "org" } (every connector made before scopes existed). */
  scope?: ConnectorScope;
  /** scope "identity": the accounts the identities connected (no secrets: they are in the vault, per account). */
  accounts?: ConnectorAccount[];
  enabled: boolean;
  /** Catalog entry it was created from, if any. */
  catalogId?: string;
  /** Icon copied from the catalog entry. */
  icon?: ConnectorIcon;
  /** Custom connectors: the discovered or uploaded icon (catalog connectors keep their bundled one). */
  iconAsset?: ConnectorIconAsset;
  /** Last icon discovery attempt (also when nothing was found), so it is not retried on every list. */
  iconCheckedAt?: string;
  /** Tool call timeout (ms); default 60 000. */
  toolTimeoutMs?: number;
  /** Hosted servers: the version deployed to production (shown as "Hosted by Polpo · v1.2.0"). */
  hostedVersion?: string;
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
  /**
   * An app manifest to create the vendor's OAuth app from (e.g. Slack: JSON with the user scopes),
   * with "<public URL>/api/v1/connectors/oauth/callback" where this instance's redirect URI goes.
   */
  setupManifest?: string;
}

/** Event payload for `connector:changed`. */
export interface ConnectorChangedEvent {
  id: string;
  /** A per-identity connector's account whose state changed. */
  account?: string;
  status: ConnectorStatus;
  action?: "created" | "updated" | "deleted" | "status";
  toolCount?: number;
  error?: string;
}

export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Vault owner for connector secrets (reserved: never exposed to agents). */
export const CONNECTORS_VAULT_OWNER = "$connectors";
export const DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS = 60_000;

/** Whether the connector is per identity (each agent / person connects its own accounts). */
export function isIdentityConnector(connector: Pick<ConnectorConfig, "scope">): boolean {
  return connector.scope?.kind === "identity";
}

/** The agent an agent-scoped connector belongs to; undefined for an org or per-identity connector. */
export function connectorOwner(connector: Pick<ConnectorConfig, "scope">): string | undefined {
  return connector.scope?.kind === "agent" && connector.scope.agent ? connector.scope.agent : undefined;
}

/**
 * Why `access` is not allowed for a connector of `scope` (undefined when it is): an agent-scoped
 * connector can only be enabled for its owner (access.agents [owner] or [], never "*").
 */
export function connectorAccessProblem(scope: ConnectorScope | undefined, access: Pick<ConnectorAccess, "agents">): string | undefined {
  if (scope?.kind !== "agent") return undefined;
  const owner = scope.agent;
  if (access.agents === "*") return `This connector belongs to agent "${owner}": it cannot be enabled for every agent`;
  const others = access.agents.filter((a) => a !== owner);
  if (others.length) return `This connector belongs to agent "${owner}": it cannot be enabled for ${others.map((a) => `"${a}"`).join(", ")}`;
  return undefined;
}

/**
 * Whether the connector is at `agent`'s disposal at all: every org connector, and its own
 * agent-scoped ones. Another agent's personal connector is never shown or offered to it.
 */
export function connectorVisibleTo(connector: Pick<ConnectorConfig, "scope">, agent: string): boolean {
  const owner = connectorOwner(connector);
  return owner === undefined || owner === agent;
}

/**
 * True when the connector's tools may be used by `agent` (or by Polpo when agent is undefined).
 * An agent-scoped connector never grants another agent, even if its access was edited to.
 */
export function connectorGrants(connector: Pick<ConnectorConfig, "access" | "enabled" | "scope">, agent: string | undefined): boolean {
  if (!connector.enabled) return false;
  if (agent === undefined) return !!connector.access?.polpo;
  if (!connectorVisibleTo(connector, agent)) return false;
  const agents = connector.access?.agents;
  return agents === "*" || (Array.isArray(agents) && agents.includes(agent));
}

/**
 * Per-agent selection of a connector's tools, keyed by connector id. A missing key or "*" means every
 * current and future tool of that connector; a list means only those tools (the server's raw tool
 * names, not the prefixed `mcp__…` ones). It narrows what connector access grants; it never grants.
 */
export type AgentConnectorTools = Record<string, "*" | string[]>;

/** Whether `agent.connectorTools` lets the agent use `toolName` of connector `connectorId`. */
export function connectorToolSelected(selection: AgentConnectorTools | undefined, connectorId: string, toolName: string): boolean {
  const entry = selection?.[connectorId];
  if (entry === undefined || entry === "*") return true;
  return Array.isArray(entry) && entry.includes(toolName);
}

/** Problems with a `connectorTools` value (empty when valid). */
export function connectorToolsProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["connectorTools must be an object keyed by connector id"];
  const problems: string[] = [];
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CONNECTOR_ID_PATTERN.test(id)) problems.push(`connectorTools: "${id}" is not a connector id`);
    else if (entry === "*") continue;
    else if (!Array.isArray(entry) || entry.some((t) => typeof t !== "string" || t.trim() === "")) problems.push(`connectorTools.${id} must be "*" or a list of tool names`);
  }
  return problems;
}

/**
 * Tidy a connectorTools value: deduplicated lists, "*" entries dropped (they are the default), an
 * empty object becomes undefined. Lists stay lists, even empty ones (= no tool of that connector).
 */
export function normalizeConnectorTools(value: AgentConnectorTools | undefined | null): AgentConnectorTools | undefined {
  if (!value) return undefined;
  const out: AgentConnectorTools = {};
  for (const [id, entry] of Object.entries(value)) {
    if (entry === "*") continue;
    if (Array.isArray(entry)) out[id] = [...new Set(entry.map((t) => t.trim()).filter(Boolean))];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Slugify a name into a connector id. */
export function connectorSlug(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "connector";
}

// ── Per-identity connectors: accounts ──

/** An account label: what an identity picks an account by ("sitoinchat", "personale", "info@acme.com"). */
export const CONNECTOR_ACCOUNT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,63}$/;
/** The fallback account's identity (an account of the organization, used by identities that have none). */
export const ORG_CONNECTOR_IDENTITY = "org";
/** A person without a sign-in (single-user installs, API keys). */
export const SHARED_PERSON = "_shared";
/** A caller that is no person (a channel contact, an MCP key, a schedule): it never has accounts of its own. */
export const NO_PERSON = "_nobody";

export function agentConnectorIdentity(agent: string): ConnectorIdentity {
  return `agent:${agent}`;
}

/**
 * A person's identity from their email (undefined / empty / not an email: the shared person of an
 * instance without sign-in; NO_PERSON: nobody's, an identity no account can ever belong to).
 */
export function personConnectorIdentity(email: string | undefined | null): ConnectorIdentity {
  const e = email?.trim().toLowerCase();
  if (e === NO_PERSON) return `person:${NO_PERSON}`;
  return `person:${e && e.includes("@") ? e : SHARED_PERSON}`;
}

/** The caller's identity: an agent's, else the person's (Polpo chat). */
export function callerConnectorIdentity(agent: string | undefined, person?: string | null): ConnectorIdentity {
  return agent !== undefined ? agentConnectorIdentity(agent) : personConnectorIdentity(person);
}

export type ParsedConnectorIdentity = { kind: "agent"; agent: string } | { kind: "person"; email: string } | { kind: "org" };

/** "agent:nina" → { kind: "agent", agent: "nina" }; undefined when not an identity. */
export function parseConnectorIdentity(value: unknown): ParsedConnectorIdentity | undefined {
  if (typeof value !== "string") return undefined;
  if (value === ORG_CONNECTOR_IDENTITY) return { kind: "org" };
  const m = /^(agent|person):(.+)$/.exec(value);
  if (!m || !m[2]!.trim() || m[2]!.startsWith("$")) return undefined;
  if (m[1] === "agent") return { kind: "agent", agent: m[2]! };
  const email = m[2]!.trim().toLowerCase();
  return email === SHARED_PERSON || email.includes("@") ? { kind: "person", email } : undefined;
}

/** How an identity reads: "agent nina", "ada@acme.com", "the person (no sign-in)", "the organization (fallback)". */
export function connectorIdentityLabel(identity: ConnectorIdentity): string {
  if (identity === `person:${NO_PERSON}`) return "this caller (not a signed-in person)";
  const p = parseConnectorIdentity(identity);
  if (!p) return identity;
  if (p.kind === "org") return "the organization (fallback)";
  if (p.kind === "agent") return `agent ${p.agent}`;
  return p.email === SHARED_PERSON ? "the person (no sign-in)" : p.email;
}

/** The vault service (owner `$connectors`) of one account's secrets. */
export function connectorAccountService(connectorId: string, accountId: string): string {
  return `${connectorId}~${accountId}`;
}

/** An identity's own accounts on the connector, the default first. */
export function connectorAccountsOf(connector: Pick<ConnectorConfig, "accounts">, identity: ConnectorIdentity): ConnectorAccount[] {
  const own = (connector.accounts ?? []).filter((a) => a.identity === identity);
  return [...own.filter((a) => a.default), ...own.filter((a) => !a.default)];
}

/** Whether the org fallback account is on for this connector. */
export function connectorFallbackOn(connector: Pick<ConnectorConfig, "scope">): boolean {
  return connector.scope?.kind === "identity" && connector.scope.fallback === true;
}

/**
 * Whether `identity` may connect an account to the per-identity connector: an agent the connector's
 * access lists (or every agent with "*"), a person when Polpo may use it (access.polpo), and the
 * organization (the fallback account) always.
 */
export function connectorAccountAllowed(connector: Pick<ConnectorConfig, "access" | "scope">, identity: ConnectorIdentity): boolean {
  if (connector.scope?.kind !== "identity") return false;
  const p = parseConnectorIdentity(identity);
  if (!p) return false;
  if (p.kind === "org") return true;
  if (p.kind === "person") return !!connector.access?.polpo;
  const agents = connector.access?.agents;
  return agents === "*" || (Array.isArray(agents) && agents.includes(p.agent));
}

export type ConnectorAccountResolution =
  | { ok: true; account: ConnectorAccount; fallback: boolean }
  | { ok: false; reason: "no_account" | "unknown_account"; error: string; labels: string[] };

/**
 * Which account a call of `identity` uses on a per-identity connector: `label` when given (one of the
 * identity's own accounts, case-insensitive; the fallback account by its label when the fallback is
 * on), else the identity's default account, else the fallback account when it is on. An identity
 * never reaches another identity's account, whatever label it passes.
 */
export function resolveConnectorAccount(
  connector: Pick<ConnectorConfig, "id" | "name" | "scope" | "accounts">, identity: ConnectorIdentity, label?: string | null,
): ConnectorAccountResolution {
  const own = connectorAccountsOf(connector, identity);
  const fallback = connectorFallbackOn(connector) && identity !== ORG_CONNECTOR_IDENTITY ? connectorAccountsOf(connector, ORG_CONNECTOR_IDENTITY) : [];
  const labels = [...own, ...fallback].map((a) => a.label);
  const who = connectorIdentityLabel(identity);
  const wanted = typeof label === "string" ? label.trim().toLowerCase() : "";
  if (wanted) {
    const mine = own.find((a) => a.label.toLowerCase() === wanted);
    if (mine) return { ok: true, account: mine, fallback: false };
    const shared = fallback.find((a) => a.label.toLowerCase() === wanted);
    if (shared) return { ok: true, account: shared, fallback: true };
    return {
      ok: false, reason: "unknown_account", labels,
      error: `${connector.name} (${connector.id}): ${who} has no account "${label!.trim()}". `
        + (labels.length ? `Its accounts: ${labels.map((l) => `"${l}"`).join(", ")}.` : "It has no account on it: a person connects one in Settings → Connectors."),
    };
  }
  if (own[0]) return { ok: true, account: own[0], fallback: false };
  if (fallback[0]) return { ok: true, account: fallback[0], fallback: true };
  return {
    ok: false, reason: "no_account", labels,
    error: `${connector.name} (${connector.id}) is per identity and ${who} has no account on it. `
      + `A person connects one in Settings → Connectors → ${connector.name} → Accounts (or on the agent's page); then try again.`,
  };
}
