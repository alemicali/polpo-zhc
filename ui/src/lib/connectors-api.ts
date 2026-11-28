/**
 * Connectors (external apps over MCP) — thin client for /api/v1/connectors plus the pure helpers
 * the Connectors page and the agent page share (catalog search, card state, access toggles,
 * custom connector validation, the OAuth popup flow).
 *
 * Same envelope ({ ok, data } / { ok, error }) and auth as the other page clients: the API key
 * goes in the Authorization header, never in a URL. Secrets are write-only: the server only says
 * which ones are set.
 */
import { apiUrl, config } from "@/lib/config";
import { CONNECTOR_ICON_FILES } from "@/generated/connector-icons";

// ── Types (mirror @polpo-ai/core connectors.ts and src/mcp/view.ts) ─────────

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "needs_auth" | "needs_reauth" | "error" | "disabled";
export type ConnectorToolPolicy = "allow" | "ask" | "off";
export type ConnectorAuthType = "none" | "bearer" | "headers" | "oauth";

export interface ConnectorIconRef {
  simpleIcons?: string | null;
  svg?: string | null;
  png?: string | null;
  color?: string;
}

/** One stored icon image of a custom connector. */
export interface ConnectorIconImage {
  mimeType: string;
  hash: string;
  width?: number;
  height?: number;
  src?: string;
}

/** A custom connector's discovered or uploaded icon (catalog connectors keep their bundled one). */
export interface ConnectorIconAsset extends ConnectorIconImage {
  source: "mcp" | "oauth" | "website" | "upload" | "url";
  dark?: ConnectorIconImage;
  fetchedAt: string;
  pinned?: boolean;
}

export interface ConnectorAccess {
  /** Agent names, or "*" for every agent. */
  agents: string[] | "*";
  polpo: boolean;
}

/**
 * The organization's (its access decides which agents use it), one agent's own (only that agent), or
 * per identity (defined once; each agent / person connects its own accounts; `fallback`: identities
 * without one use the organization's shared account).
 */
export type ConnectorScope = { kind: "org" } | { kind: "agent"; agent: string } | { kind: "identity"; fallback?: boolean };

/** The three kinds of connector, as the type selector names them. */
export type ConnectorKind = ConnectorScope["kind"];

/**
 * Whose an account of a per-identity connector is: "agent:<name>", "person:<email>" (a member;
 * "person:_shared" without sign-in) or "org" (the shared fallback account).
 */
export type ConnectorIdentity = string;

/** One account of a per-identity connector (mirrors src/mcp/view.ts PublicConnectorAccount). */
export interface ConnectorAccount {
  /** "acc-…" */
  id: string;
  identity: ConnectorIdentity;
  /** "agent nina", "ada@acme.com", "the organization (fallback)". */
  identityLabel?: string;
  /** What its owner picks it by (`account: "sitoinchat"` on any of the connector's tools). */
  label: string;
  /** Its identity's default account. */
  default?: boolean;
  /** The signed-in account (e.g. an email), when known. */
  account?: string;
  /** The connector it was imported from. */
  importedFrom?: string;
  status?: ConnectorStatus;
  lastError?: string;
  toolCount?: number;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt?: string;
  secrets: { bearerToken: boolean; headers: string[]; oauth: { authorized: boolean; pending: boolean } };
}

/** POST /connectors/:id/accounts (token / headers are write-only). */
export interface ConnectorAccountInput {
  /** "agent:<name>", "person:<email>", "org" or "me" (the signed-in person). */
  identity: ConnectorIdentity | "me";
  label: string;
  default?: boolean;
  secrets?: { bearerToken?: string; headers?: Record<string, string> };
}

export interface ConnectorAccountImportInput {
  from: string;
  identity?: ConnectorIdentity | "me";
  label?: string;
  default?: boolean;
  /** false: turn the source off instead of deleting it (default true). */
  removeSource?: boolean;
}

export interface ConnectorAccountImportResult {
  account: ConnectorAccount;
  source: { id: string; removed: boolean; disabled: boolean };
  renamed: { from: string; to: string };
  connector: Connector;
}

export interface ConnectorOAuthSettings {
  clientId?: string;
  app?: string;
  scopes?: string[];
  extraAuthParams?: Record<string, string>;
  authorizationServer?: string;
}

export interface Connector {
  id: string;
  name: string;
  /** The signed-in account (e.g. an email), when the sign-in revealed it (an OpenID id_token). */
  account?: string;
  kind: "mcp";
  description?: string;
  transport: { type: "http" | "sse" | "stdio" | "hosted"; url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; serverId?: string };
  /** Hosted servers: the version in production ("Hosted by Polpo · v1.2.0"). */
  hostedVersion?: string;
  auth: { type: ConnectorAuthType; headerNames?: string[]; oauth?: ConnectorOAuthSettings };
  access: ConnectorAccess;
  /** Who it belongs to; missing = the organization. An agent's own is only ever enabled for that agent. */
  scope?: ConnectorScope;
  /** scope "identity": every identity's accounts (which secrets are set, never their values). */
  accounts?: ConnectorAccount[];
  enabled: boolean;
  catalogId?: string;
  icon?: ConnectorIconRef;
  /** Custom connectors: the discovered / uploaded icon's metadata. */
  iconAsset?: ConnectorIconAsset;
  iconCheckedAt?: string;
  /** Where the icon is served: /connector-icons/… (catalog) or /api/v1/connectors/<id>/icon?v=… (custom). */
  iconUrl?: string;
  /** A custom connector's variant for dark backgrounds. */
  iconDarkUrl?: string;
  toolTimeoutMs?: number;
  toolPolicy?: Record<string, ConnectorToolPolicy>;
  createdAt: string;
  updatedAt?: string;
  status?: ConnectorStatus;
  lastError?: string;
  toolCount?: number;
  lastConnectedAt?: string;
  secrets: {
    bearerToken: boolean;
    headers: string[];
    clientSecret: boolean;
    values: string[];
    oauth: { authorized: boolean; clientRegistered: boolean; pending: boolean };
  };
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  url?: string;
  urlTemplate?: string;
  variants?: Array<{ label: string; url: string }>;
  transport: "http" | "sse";
  auth: "oauth" | "oauth_preregistered" | "bearer" | "none";
  oauthRegistration?: "dcr" | "cimd" | "dcr+cimd" | "preregistered" | null;
  authHeader?: string;
  authNotes?: string;
  oauth?: Omit<ConnectorOAuthSettings, "clientId">;
  inClaudeDirectory?: boolean;
  inLovable?: boolean;
  docs?: string;
  domain?: string;
  icon?: ConnectorIconRef;
  verified: boolean;
  setup?: string;
  /** App manifest to create the vendor's OAuth app from, with the redirect URI as a placeholder. */
  setupManifest?: string;
}

export interface OAuthApp {
  id: string;
  name?: string;
  clientId: string;
  hasSecret: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  redirectUri: string;
  oauthApps: OAuthApp[];
}

export interface ConnectorTool {
  name: string;
  title?: string;
  description?: string;
  policy: ConnectorToolPolicy;
}

export interface ConnectorTestResult {
  ok: boolean;
  /** A per-identity connector: the account that was tested. */
  account?: string;
  error?: string;
  status?: ConnectorStatus;
  tools?: Array<{ name: string; title?: string; description?: string }>;
  connector: Connector;
}

/** The ways to sign in a probe can recommend (POST /connectors/discover). */
export type DetectedAuth = "none" | "oauth-cimd" | "oauth-dcr" | "oauth-preregistered" | "bearer";

/** How to connect to an MCP server, as the server worked it out from its URL (mirrors src/mcp/probe.ts). */
export interface ConnectorDiscovery {
  url: string;
  reachable: boolean;
  error?: string;
  transport?: "http" | "sse";
  authRequired?: boolean;
  server?: { name?: string; title?: string; version?: string; websiteUrl?: string; instructions?: string };
  resource?: { resource?: string; resourceName?: string; scopes?: string[]; authorizationServers?: string[] };
  authorizationServer?: { issuer?: string; registration: boolean; cimd: boolean; pkceMethods: string[]; tokenAuthMethods: string[]; scopes?: string[] };
  options: Array<{ auth: DetectedAuth; recommended: boolean; description: string }>;
  recommendation?: {
    transport: "http" | "sse";
    auth: DetectedAuth;
    recommended: true;
    scopes: string[];
    name?: string;
    icon?: { dataUri: string; source: string; src?: string };
    notes: string[];
  };
}

/** What POST / PATCH accept (secrets are write-only). */
export interface ConnectorInput {
  id?: string;
  name?: string;
  description?: string;
  catalogId?: string;
  url?: string;
  transport?: Partial<Connector["transport"]>;
  auth?: { type?: ConnectorAuthType; headerNames?: string[]; oauth?: Partial<ConnectorOAuthSettings> };
  access?: Partial<ConnectorAccess>;
  scope?: ConnectorScope;
  enabled?: boolean;
  toolTimeoutMs?: number;
  toolPolicy?: Record<string, ConnectorToolPolicy>;
  secrets?: { bearerToken?: string; headers?: Record<string, string>; clientSecret?: string; values?: Record<string, string> };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export class ConnectorRequestError extends Error {
  readonly oauthApp?: string;

  constructor(message: string, oauthApp?: string) {
    super(message);
    this.oauthApp = oauthApp;
  }
}

async function request<T>(path: string, init?: RequestInit, base = "/api/v1/connectors"): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`${base}${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown; oauthApp?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string" ? body.error : (body?.error as { message?: string } | undefined)?.message;
    throw new ConnectorRequestError(error || `Connectors request failed (${response.status})`,
      typeof body?.oauthApp === "string" ? body.oauthApp : undefined);
  }
  return body.data as T;
}

const at = (id: string) => `/${encodeURIComponent(id)}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const connectorsApi = {
  list: () => request<{ connectors: Connector[] }>("").then((d) => d.connectors),
  catalog: () => request<Catalog>("/catalog"),
  get: (id: string) => request<Connector>(at(id)),
  create: (input: ConnectorInput) => request<Connector>("", json("POST", input)),
  update: (id: string, patch: ConnectorInput) => request<Connector>(at(id), json("PATCH", patch)),
  remove: (id: string) => request<{ removed: boolean }>(at(id), json("DELETE")),
  test: (id: string) => request<ConnectorTestResult>(`${at(id)}/test`, json("POST")),
  tools: (id: string, refresh = false) => request<{ tools: ConnectorTool[] }>(`${at(id)}/tools${refresh ? "?refresh=1" : ""}`).then((d) => d.tools),
  startOAuth: (id: string) => request<{ authorizationUrl?: string; authorized?: boolean; redirectUri: string }>(`${at(id)}/oauth/start`, json("POST")),
  disconnect: (id: string) => request<Connector>(`${at(id)}/disconnect`, json("POST")),
  oauthApps: () => request<{ apps: OAuthApp[]; redirectUri: string }>("/oauth-apps"),
  saveOAuthApp: (app: string, input: { clientId: string; clientSecret?: string; name?: string }) =>
    request<OAuthApp>(`/oauth-apps/${encodeURIComponent(app)}`, json("PUT", input)),
  removeOAuthApp: (app: string) => request<{ removed: boolean }>(`/oauth-apps/${encodeURIComponent(app)}`, json("DELETE")),
  /** How to connect to an MCP server URL (transport, sign-in options, scopes, name, icon); nothing is stored. */
  discover: (url: string, init?: { signal?: AbortSignal }) => request<ConnectorDiscovery>("/discover", { ...json("POST", { url }), ...(init?.signal ? { signal: init.signal } : {}) }),
  refreshIcon: (id: string) => request<Connector>(`${at(id)}/icon/refresh`, json("POST")),
  setIcon: (id: string, icon: { url: string } | { dataUri: string }) => request<Connector>(`${at(id)}/icon`, json("PUT", icon)),
  resetIcon: (id: string) => request<Connector>(`${at(id)}/icon`, json("DELETE")),
};

const acc = (id: string, account: string) => `${at(id)}/accounts/${encodeURIComponent(account)}`;

/** A per-identity connector's accounts. Every mutation returns the updated connector too. */
export const connectorAccountsApi = {
  list: (id: string, identity?: ConnectorIdentity | "me") =>
    request<{ accounts: ConnectorAccount[]; fallback: boolean }>(`${at(id)}/accounts${identity ? `?identity=${encodeURIComponent(identity)}` : ""}`),
  add: (id: string, input: ConnectorAccountInput) => request<{ account: ConnectorAccount; connector: Connector }>(`${at(id)}/accounts`, json("POST", input)),
  update: (id: string, account: string, patch: { label?: string; default?: true; secrets?: ConnectorAccountInput["secrets"] }) =>
    request<{ account: ConnectorAccount; connector: Connector }>(acc(id, account), json("PATCH", patch)),
  remove: (id: string, account: string) => request<{ removed: boolean; connector: Connector }>(acc(id, account), json("DELETE")),
  startOAuth: (id: string, account: string) => request<{ authorizationUrl?: string; authorized?: boolean; redirectUri: string }>(`${acc(id, account)}/oauth/start`, json("POST")),
  test: (id: string, account: string) => request<ConnectorTestResult>(`${acc(id, account)}/test`, json("POST")),
  disconnect: (id: string, account: string) => request<Connector>(`${acc(id, account)}/disconnect`, json("POST")),
  import: (id: string, input: ConnectorAccountImportInput) => request<ConnectorAccountImportResult>(`${at(id)}/accounts/import`, json("POST", input)),
};

/** Largest icon a person can upload (the server's limit). */
export const MAX_ICON_BYTES = 512 * 1024;

/** Where a custom connector's icon came from, in words. */
export function iconSourceLabel(asset: ConnectorIconAsset | undefined): string {
  if (!asset) return "No icon found: the first letter is shown";
  const host = (() => { try { return asset.src ? new URL(asset.src).hostname : undefined; } catch { return undefined; } })();
  switch (asset.source) {
    case "mcp": return "From the MCP server";
    case "oauth": return `From the sign-in metadata${host ? ` (${host})` : ""}`;
    case "website": return `From ${host ?? "the website"}`;
    case "upload": return "Uploaded";
    case "url": return `From ${host ?? "a URL"}`;
  }
}

/** Save an agent's per-connector tool selection (null: every tool of every granted connector). */
export function saveAgentConnectorTools(agent: string, connectorTools: AgentConnectorTools | null): Promise<{ connectorTools?: AgentConnectorTools } | null> {
  return request(`/${encodeURIComponent(agent)}`, json("PATCH", { connectorTools, publish: false }), "/api/v1/agents");
}

// ── Catalog search ───────────────────────────────────────────────────────────

/** Categories in catalog order of first appearance, with counts. */
export function catalogCategories(entries: CatalogEntry[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Entries matching every word of `query` (name, description, category, domain) and `category`. Name matches first. */
export function filterCatalog(entries: CatalogEntry[], { query = "", category }: { query?: string; category?: string | null }): CatalogEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matched = entries.filter((e) => {
    if (category && e.category !== category) return false;
    if (words.length === 0) return true;
    const hay = fold(`${e.name} ${e.description} ${e.category} ${e.domain ?? ""} ${e.id}`);
    return words.every((w) => hay.includes(w));
  });
  if (words.length === 0) return matched;
  const nameHit = (e: CatalogEntry) => words.every((w) => fold(e.name).includes(w));
  return [...matched.filter(nameHit), ...matched.filter((e) => !nameHit(e))];
}

/** Configured connectors matching `query` (name, id, description, URL). */
export function filterConnectors(connectors: Connector[], query: string): Connector[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return connectors;
  return connectors.filter((c) => {
    const hay = fold(`${c.name} ${c.id} ${c.account ?? ""} ${c.description ?? ""} ${c.transport.url ?? c.transport.command ?? ""}`);
    return words.every((w) => hay.includes(w));
  });
}

// ── State ────────────────────────────────────────────────────────────────────

/** What a catalog card / connector row shows and offers. */
export type ConnectorCardState =
  | "connect"        // not added
  | "needs_setup"    // pre-registered OAuth app missing
  | "connected"
  | "needs_auth"     // added, sign-in never finished
  | "needs_reauth"
  | "error"
  | "disabled"
  | "not_connected"; // added (token / no auth), not connected yet

/** The shared OAuth app a catalog entry needs, when it is not configured yet. */
/** The error says the vendor refused Polpo's dynamic client registration: the next step is an OAuth app. */
export function registrationRefused(message: string | null | undefined): boolean {
  return !!message && /pre-registered client in Connectors → OAuth apps|did not accept the OAuth client registration|does not offer dynamic OAuth client registration/i.test(message);
}

/** The OAuth app a connector whose registration was refused should use (the catalog's shared app, else its own). */
export function oauthAppFor(connector: Connector, entry?: CatalogEntry): string {
  return connector.auth.oauth?.app ?? entry?.oauth?.app ?? connector.catalogId ?? connector.id;
}

export function missingOAuthApp(entry: CatalogEntry, apps: OAuthApp[], connector?: Connector): string | undefined {
  if (entry.auth !== "oauth_preregistered") return undefined;
  const appId = entry.oauth?.app ?? entry.id;
  const oauth = connector?.auth.oauth;
  if (connector && (connector.auth.type !== "oauth" || oauth?.clientId || (oauth?.app && oauth.app !== appId))) return undefined;
  const app = apps.find((a) => a.id === appId);
  return app?.clientId && (appId !== "google" || app.hasSecret) ? undefined : appId;
}

export function connectorState(connector: Connector): Exclude<ConnectorCardState, "connect" | "needs_setup"> {
  if (!connector.enabled || connector.status === "disabled") return "disabled";
  if (isIdentityConnector(connector)) return identityConnectorState(connector);
  switch (connector.status) {
    case "connected": return "connected";
    case "needs_auth": return "needs_auth";
    case "needs_reauth": return "needs_reauth";
    case "error": return "error";
    default: return connector.auth.type === "oauth" && !connector.secrets.oauth.authorized ? "needs_auth" : "not_connected";
  }
}

export function catalogCardState(entry: CatalogEntry, connectors: Connector[], apps: OAuthApp[]): { state: ConnectorCardState; connector?: Connector; accounts: Connector[] } {
  const accounts = catalogAccounts(entry.id, connectors);
  const connector = accounts[0];
  if (connector) {
    const state = connectorState(connector);
    return { state: !isIdentityConnector(connector) && (state === "needs_auth" || state === "needs_reauth" || state === "error")
      && missingOAuthApp(entry, apps, connector) ? "needs_setup" : state, connector, accounts };
  }
  return { state: missingOAuthApp(entry, apps) ? "needs_setup" : "connect", accounts };
}

// ── Several accounts of one catalog app (gmail, gmail-2…) ────────────────────

/** The connectors added from one catalog entry: its accounts, in list order. */
export function catalogAccounts(entryId: string, connectors: Connector[]): Connector[] {
  return connectors.filter((c) => c.catalogId === entryId);
}

/** A free default name for another account of `entry`: "Gmail 2", "Gmail 3"… */
export function nextAccountName(entry: { id: string; name: string }, connectors: Connector[]): string {
  const taken = new Set(connectors.map((c) => c.name.trim().toLowerCase()));
  let n = catalogAccounts(entry.id, connectors).length + 1;
  while (taken.has(`${entry.name} ${n}`.toLowerCase())) n++;
  return `${entry.name} ${n}`;
}

/**
 * What tells this connector apart from the other accounts of the same app: the signed-in account
 * when its name does not say it already, else its id when there are other accounts.
 */
export function accountLabel(connector: Connector, connectors: Connector[]): string | undefined {
  if (isIdentityConnector(connector)) return undefined; // its accounts are listed on their own
  const account = connector.account?.trim();
  if (account && !connector.name.toLowerCase().includes(account.toLowerCase())) return account;
  if (connector.catalogId && catalogAccounts(connector.catalogId, connectors).length > 1) return connector.id;
  return undefined;
}

/** After sign-in revealed the account: a name that says it ("Gmail – info@acme.com"), if the name does not yet. */
export function suggestedAccountName(connector: Connector, entryName?: string): string | undefined {
  const account = connector.account?.trim();
  if (!account || connector.name.toLowerCase().includes(account.toLowerCase())) return undefined;
  const base = entryName ?? connector.name.replace(/\s+\d+$/, "");
  return `${base} – ${account}`;
}

/**
 * The Connected list: connectors in order, accounts of the same app kept together under one group
 * ("Gmail · 2 accounts") when there are several.
 */
export function groupConnectors(connectors: Connector[]): Array<{ key: string; catalogId?: string; connectors: Connector[] }> {
  const groups: Array<{ key: string; catalogId?: string; connectors: Connector[] }> = [];
  const byApp = new Map<string, { key: string; catalogId?: string; connectors: Connector[] }>();
  for (const c of connectors) {
    // a per-identity connector holds its accounts itself: never grouped with separate connectors
    const app = c.catalogId && !isIdentityConnector(c) ? c.catalogId : undefined;
    const existing = app ? byApp.get(app) : undefined;
    if (existing) { existing.connectors.push(c); continue; }
    const group = { key: app ? `app:${app}` : `id:${c.id}`, ...(app ? { catalogId: app } : {}), connectors: [c] };
    if (app) byApp.set(app, group);
    groups.push(group);
  }
  return groups;
}

export const STATE_LABEL: Record<ConnectorCardState, string> = {
  connect: "Connect",
  needs_setup: "Needs setup",
  connected: "Connected",
  needs_auth: "Sign-in needed",
  needs_reauth: "Needs re-auth",
  error: "Error",
  disabled: "Disabled",
  not_connected: "Not connected",
};

/** Short auth label for a catalog entry. */
export function authLabel(entry: CatalogEntry): string {
  switch (entry.auth) {
    case "oauth": return "OAuth";
    case "oauth_preregistered": return "OAuth app";
    case "bearer": return "API key";
    default: return "No auth";
  }
}

/** The redirect URI and setup steps with the placeholder filled in. */
export function setupSteps(entry: CatalogEntry, redirectUri: string): string[] {
  return (entry.setup ?? "")
    .split("\n")
    .map((l) => l.replace(/<public URL>\/api\/v1\/connectors\/oauth\/callback/g, redirectUri).trim())
    .filter(Boolean);
}

/** The app manifest with this instance's redirect URI filled in (undefined when the entry has none). */
export function setupManifest(entry: CatalogEntry, redirectUri: string): string | undefined {
  return entry.setupManifest?.replace(/<public URL>\/api\/v1\/connectors\/oauth\/callback/g, redirectUri);
}

/** Placeholders of a URL template ("https://mcp.dev.azure.com/{organization}" → ["organization"]). */
export function templateFields(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!))];
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, k: string) => encodeURIComponent((values[k] ?? "").trim()));
}

// ── Access ───────────────────────────────────────────────────────────────────

export function agentHasAccess(access: ConnectorAccess, agent: string): boolean {
  return access.agents === "*" || access.agents.includes(agent);
}

/** The agent an agent-scoped connector belongs to; undefined for an org or per-identity connector. */
export function connectorOwner(connector: Pick<Connector, "scope">): string | undefined {
  return connector.scope?.kind === "agent" ? connector.scope.agent : undefined;
}

/** At `agent`'s disposal at all: every org and per-identity connector and its own ones (never another agent's own). */
export function connectorVisibleTo(connector: Pick<Connector, "scope">, agent: string): boolean {
  const owner = connectorOwner(connector);
  return owner === undefined || owner === agent;
}

/** Enabled for `agent` (the server's rule: another agent's own connector never is, whatever its access says). */
export function connectorEnabledFor(connector: Pick<Connector, "scope" | "access">, agent: string): boolean {
  return connectorVisibleTo(connector, agent) && agentHasAccess(connector.access, agent);
}

// ── Per-identity connectors ──────────────────────────────────────────────────

/** Whether each agent / person connects its own accounts to the connector. */
export function isIdentityConnector(connector: Pick<Connector, "scope">): boolean {
  return connector.scope?.kind === "identity";
}

/** "org", "agent" or "identity" (missing scope = org). */
export function connectorKind(connector: Pick<Connector, "scope">): ConnectorKind {
  return connector.scope?.kind ?? "org";
}

/** Whether identities without an account of their own use the organization's shared one. */
export function fallbackOn(connector: Pick<Connector, "scope">): boolean {
  return connector.scope?.kind === "identity" && connector.scope.fallback === true;
}

export const ORG_IDENTITY = "org";
export const agentIdentity = (agent: string): ConnectorIdentity => `agent:${agent}`;

export type ParsedIdentity = { kind: "agent"; agent: string } | { kind: "person"; email: string } | { kind: "org" };

export function parseIdentity(identity: ConnectorIdentity): ParsedIdentity | undefined {
  if (identity === ORG_IDENTITY) return { kind: "org" };
  const m = /^(agent|person):(.+)$/.exec(identity);
  if (!m) return undefined;
  return m[1] === "agent" ? { kind: "agent", agent: m[2]! } : { kind: "person", email: m[2]! };
}

/** How an identity reads in the dashboard: an agent's display name, a person's email, "Organization (fallback)". */
export function identityName(identity: ConnectorIdentity, agentLabel: (name: string) => string = (n) => n): string {
  const p = parseIdentity(identity);
  if (!p) return identity;
  if (p.kind === "org") return "Organization (fallback)";
  if (p.kind === "agent") return agentLabel(p.agent);
  return p.email === "_shared" ? "You (no sign-in)" : p.email;
}

/** An identity's own accounts on the connector, the default first. */
export function accountsOf(connector: Pick<Connector, "accounts">, identity: ConnectorIdentity): ConnectorAccount[] {
  const own = (connector.accounts ?? []).filter((a) => a.identity === identity);
  return [...own.filter((a) => a.default), ...own.filter((a) => !a.default)];
}

/** Every identity with accounts, in order: agents, people, then the organization's fallback. */
export function accountIdentities(connector: Pick<Connector, "accounts">): ConnectorIdentity[] {
  const seen = [...new Set((connector.accounts ?? []).map((a) => a.identity))];
  const rank = (i: string) => (i.startsWith("agent:") ? 0 : i.startsWith("person:") ? 1 : 2);
  return seen.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Whether `identity` may connect accounts: an agent with access, a person when Polpo may use it, the organization always. */
export function identityMayConnect(connector: Pick<Connector, "access" | "scope">, identity: ConnectorIdentity): boolean {
  if (!isIdentityConnector(connector)) return false;
  const p = parseIdentity(identity);
  if (!p) return false;
  if (p.kind === "org") return true;
  if (p.kind === "person") return connector.access.polpo;
  return agentHasAccess(connector.access, p.agent);
}

/** One account's state, like a connector's. */
export function accountState(account: ConnectorAccount, connector: Pick<Connector, "enabled" | "auth">): Exclude<ConnectorCardState, "connect" | "needs_setup"> {
  if (!connector.enabled) return "disabled";
  switch (account.status) {
    case "connected": return "connected";
    case "needs_reauth": return "needs_reauth";
    case "error": return "error";
    case "needs_auth": return "needs_auth";
    default: return connector.auth.type === "oauth" && !account.secrets.oauth.authorized ? "needs_auth" : "not_connected";
  }
}

/** A per-identity connector as a whole: connected when an account is, an error when one failed, else not connected. */
function identityConnectorState(connector: Connector): "connected" | "error" | "not_connected" {
  const states = (connector.accounts ?? []).map((a) => accountState(a, connector));
  if (states.includes("connected")) return "connected";
  if (states.includes("error") || states.includes("needs_reauth")) return "error";
  return "not_connected";
}

/** "2 accounts · 1 connected" */
export function accountsSummary(connector: Pick<Connector, "accounts" | "enabled" | "auth">): string {
  const accounts = connector.accounts ?? [];
  if (!accounts.length) return "No accounts yet";
  const connected = accounts.filter((a) => accountState(a, connector) === "connected").length;
  return `${accounts.length} account${accounts.length === 1 ? "" : "s"}${connected ? ` · ${connected} connected` : ""}`;
}

/** Another connector of the same app that can become an account (same catalog entry or URL, same sign-in). */
export function importCandidates(target: Connector, connectors: Connector[]): Connector[] {
  return connectors.filter((c) => c.id !== target.id && !isIdentityConnector(c)
    && c.transport.type !== "hosted" && c.transport.type !== "stdio"
    && ((!!target.catalogId && c.catalogId === target.catalogId) || (!!target.transport.url && c.transport.url === target.transport.url))
    && c.auth.type === target.auth.type);
}

/** The per-identity connector of the same app a separate connector can be imported into, if any. */
export function identityTargetFor(source: Connector, connectors: Connector[]): Connector | undefined {
  if (isIdentityConnector(source)) return undefined;
  return connectors.find((c) => isIdentityConnector(c) && importCandidates(c, [source]).length > 0);
}

/** Whose account an imported connector becomes by default: its owner, else its only agent, else the organization. */
export function importIdentity(source: Connector): ConnectorIdentity {
  const owner = connectorOwner(source);
  if (owner) return agentIdentity(owner);
  if (Array.isArray(source.access.agents) && source.access.agents.length === 1) return agentIdentity(source.access.agents[0]!);
  return ORG_IDENTITY;
}

export const ACCOUNT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@+-]{0,63}$/;

/** An account label the server accepts ("sitoinchat", "info@acme.com"): `text` made to fit. */
export function accountLabelFrom(text: string): string {
  const cleaned = text.trim().replace(/[^A-Za-z0-9 ._@+-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.slice(0, 64).trim() || "account";
}

/** Grant / revoke one agent. Revoking from "every agent" keeps every other known agent. */
export function toggleAgentAccess(access: ConnectorAccess, agent: string, on: boolean, allAgents: string[]): ConnectorAccess {
  if (on) {
    if (access.agents === "*" || access.agents.includes(agent)) return access;
    return { ...access, agents: [...access.agents, agent] };
  }
  const current = access.agents === "*" ? allAgents : access.agents;
  return { ...access, agents: current.filter((a) => a !== agent) };
}

// ── Per-agent tool selection ─────────────────────────────────────────────────

/** agent.connectorTools: { <connector id>: "*" | [raw tool names] }; a missing key = every tool. */
export type AgentConnectorTools = Record<string, "*" | string[]>;

/** The agent's selection for one connector: "*" (all tools, current and future) or the chosen names. */
export function connectorToolsEntry(selection: AgentConnectorTools | undefined, connectorId: string): "*" | string[] {
  const entry = selection?.[connectorId];
  return Array.isArray(entry) ? entry : "*";
}

/** The whole selection with one connector's entry replaced ("*" drops the key); null when nothing is left. */
export function withConnectorToolsEntry(selection: AgentConnectorTools | undefined, connectorId: string, entry: "*" | string[]): AgentConnectorTools | null {
  const next: AgentConnectorTools = { ...(selection ?? {}) };
  if (entry === "*") delete next[connectorId];
  else next[connectorId] = [...new Set(entry)];
  return Object.keys(next).length ? next : null;
}

/** Selected names the connector does not list (any more): kept, shown as stale. */
export function staleConnectorTools(entry: "*" | string[], tools: Array<{ name: string }> | null): string[] {
  if (entry === "*" || !tools) return [];
  const known = new Set(tools.map((t) => t.name));
  return entry.filter((name) => !known.has(name));
}

/** Tools whose name, title or description contains every word of `query`. */
export function filterConnectorTools<T extends { name: string; title?: string; description?: string }>(tools: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return tools;
  return tools.filter((t) => {
    const text = fold(`${t.name} ${t.title ?? ""} ${t.description ?? ""}`);
    return words.every((w) => text.includes(w));
  });
}

/**
 * True when an agent's `allowedTools` (if any) lets it use the connector's tools:
 * `mcp__*`, `mcp__<id>__*`, or at least one exact `mcp__<id>__<tool>`.
 */
export function allowedToolsCoverConnector(allowedTools: string[] | undefined, connectorId: string): boolean {
  if (!allowedTools || allowedTools.length === 0) return true;
  const prefix = `mcp__${connectorId}__`;
  return allowedTools.some((t) => t === "*" || t === "mcp__*" || t.startsWith(prefix));
}

// ── Custom connector form ────────────────────────────────────────────────────

export type CustomAuthChoice = "oauth" | "bearer" | "headers" | "none";

export interface CustomConnectorForm {
  name: string;
  /** "remote": an MCP server URL; "stdio": a local command (admin only). */
  kind: "remote" | "stdio";
  url: string;
  /** Detected (or chosen) transport; undefined: guessed from the path (/sse → SSE). */
  transport?: "http" | "sse";
  auth: CustomAuthChoice;
  /** The detected sign-in option picked, when the URL was probed. */
  detected?: DetectedAuth;
  bearerToken: string;
  headers: Array<{ name: string; value: string }>;
  clientId: string;
  clientSecret: string;
  scopes: string;
  command: string;
  args: string;
  /** Who it belongs to (default: the organization). Per identity: the token / header values go with each account. */
  scope?: ConnectorScope;
}

export const EMPTY_CUSTOM_FORM: CustomConnectorForm = {
  name: "", kind: "remote", url: "", auth: "oauth", bearerToken: "", headers: [{ name: "", value: "" }],
  clientId: "", clientSecret: "", scopes: "", command: "", args: "",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

/** Field → message. Empty when the form can be submitted. */
export function validateCustomConnector(form: CustomConnectorForm): Partial<Record<keyof CustomConnectorForm, string>> {
  const errors: Partial<Record<keyof CustomConnectorForm, string>> = {};
  if (!form.name.trim()) errors.name = "Give the connector a name";
  if (form.kind === "stdio") {
    if (!form.command.trim()) errors.command = "Enter the command to run";
    return errors;
  }
  const raw = form.url.trim();
  if (!raw) errors.url = "Enter the MCP server URL";
  else {
    let url: URL | undefined;
    try { url = new URL(raw); } catch { errors.url = "Enter a full URL, e.g. https://mcp.example.com/mcp"; }
    if (url && url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
      errors.url = "Use an https:// URL";
    }
  }
  const perIdentity = form.scope?.kind === "identity";
  if (form.auth === "bearer" && !perIdentity && !form.bearerToken.trim()) errors.bearerToken = "Paste the token";
  if (form.auth === "headers") {
    const rows = form.headers.filter((h) => h.name.trim() || h.value);
    if (rows.length === 0) errors.headers = "Add at least one header";
    else if (rows.some((h) => !HEADER_NAME.test(h.name.trim()))) errors.headers = "Header names: letters, digits and - only";
    else if (!perIdentity && rows.some((h) => !h.value)) errors.headers = "Every header needs a value";
  }
  if (form.scope?.kind === "agent" && !form.scope.agent) errors.scope = "Pick the agent it belongs to";
  if (form.auth === "oauth" && form.clientSecret.trim() && !form.clientId.trim()) errors.clientId = "A client secret needs its client id";
  if (form.auth === "oauth" && form.detected === "oauth-preregistered" && !form.clientId.trim()) errors.clientId = "Enter the client id of the OAuth client you created";
  return errors;
}

/** Split a command-line-ish string into arguments ("a 'b c' d" → ["a", "b c", "d"]). */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export function customConnectorInput(form: CustomConnectorForm): ConnectorInput {
  const input = baseCustomInput(form);
  if (!form.scope || form.scope.kind === "org") return input;
  if (form.scope.kind === "agent") return { ...input, scope: form.scope };
  // per identity: no token of its own (each account brings its own); header names are kept
  const { secrets, ...rest } = input;
  return { ...rest, ...(secrets?.clientSecret ? { secrets: { clientSecret: secrets.clientSecret } } : {}), scope: form.scope };
}

function baseCustomInput(form: CustomConnectorForm): ConnectorInput {
  const name = form.name.trim();
  if (form.kind === "stdio") {
    const [command = "", ...inline] = splitArgs(form.command.trim());
    return { name, transport: { type: "stdio", command, args: [...inline, ...splitArgs(form.args)] }, auth: { type: "none" } };
  }
  const url = form.url.trim();
  const transport = { type: form.transport ?? (/\/sse\/?(\?.*)?$/.test(new URL(url).pathname) ? "sse" as const : "http" as const), url };
  switch (form.auth) {
    case "bearer":
      return { name, transport, auth: { type: "bearer" }, secrets: { bearerToken: form.bearerToken.trim() } };
    case "headers": {
      const headers = Object.fromEntries(form.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
      return { name, transport, auth: { type: "headers", headerNames: Object.keys(headers) }, secrets: { headers } };
    }
    case "oauth": {
      const scopes = form.scopes.split(/[\s,]+/).filter(Boolean);
      const oauth: Partial<ConnectorOAuthSettings> = {
        ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
        ...(scopes.length ? { scopes } : {}),
      };
      return {
        name, transport,
        auth: { type: "oauth", ...(Object.keys(oauth).length ? { oauth } : {}) },
        ...(form.clientSecret.trim() ? { secrets: { clientSecret: form.clientSecret.trim() } } : {}),
      };
    }
    default:
      return { name, transport, auth: { type: "none" } };
  }
}

/** The form's auth for a detected option. */
export function authForDetected(auth: DetectedAuth): CustomAuthChoice {
  return auth === "none" ? "none" : auth === "bearer" ? "bearer" : "oauth";
}

/**
 * Prefill the form from a probe: the recommended sign-in, the transport, all the scopes, and the
 * name unless the person typed one (`autoName`: the name the last detection filled in).
 */
export function applyDiscovery(form: CustomConnectorForm, discovery: ConnectorDiscovery, autoName?: string): CustomConnectorForm {
  const rec = discovery.recommendation;
  if (!rec) return form;
  const keepName = form.name.trim() && form.name !== autoName;
  return {
    ...form,
    ...(keepName || !rec.name ? {} : { name: rec.name }),
    transport: rec.transport,
    auth: authForDetected(rec.auth),
    detected: rec.auth,
    scopes: rec.scopes.join(" "),
  };
}

/** One line for each detected way of signing in. */
export const DETECTED_AUTH_LABELS: Record<DetectedAuth, string> = {
  none: "No sign-in",
  "oauth-cimd": "OAuth (client metadata document)",
  "oauth-dcr": "OAuth (automatic registration)",
  "oauth-preregistered": "OAuth with your own client",
  bearer: "API key / bearer token",
};

// ── OAuth popup ──────────────────────────────────────────────────────────────

export const OAUTH_MESSAGE_TYPE = "polpo:connector-oauth";

/**
 * Open the sign-in window synchronously (inside the click handler, so popup blockers allow it);
 * it is pointed at the authorization URL once the server returns it. Null when blocked.
 */
export function openAuthWindow(): Window | null {
  const width = 520;
  const height = 720;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  try {
    return window.open("about:blank", "polpo-connector-signin", `popup,width=${width},height=${height},left=${left},top=${top}`);
  } catch {
    return null;
  }
}

/** How long to wait, after sign-in, for the server's first connection to a connector. */
const FIRST_CONNECTION_GRACE_MS = 30_000;

export type OAuthOutcome =
  | { kind: "connected"; connector: Connector }
  | { kind: "authorized_with_error"; connector: Connector; error: string }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

/**
 * Wait for the person to finish signing in: the callback page posts a message to the opener
 * (same origin only), and the connector is polled (works across origins, and when the popup was
 * replaced by a tab). Resolves when the pending state is gone, the window closes without it, or
 * the 10-minute state expires.
 */
export function waitForOAuth(
  id: string,
  popup: Window | null,
  { signal, intervalMs = 1500, timeoutMs = 10 * 60_000, account }: {
    signal?: AbortSignal; intervalMs?: number; timeoutMs?: number;
    /** A per-identity connector: the account signing in (its own state is watched). */
    account?: string;
  } = {},
): Promise<OAuthOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let closedPolls = 0;
    const started = Date.now();
    // signed in but not connected yet: the server is still making the first connection
    let authorizedAt: number | undefined;
    const finish = (outcome: OAuthOutcome) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const check = async () => {
      if (done) return;
      try {
        const c = await connectorsApi.get(id);
        if (done) return;
        const a = account ? c.accounts?.find((x) => x.id === account) : undefined;
        if (account && !a) return finish({ kind: "failed", error: "The account was removed" });
        const s = a ?? { status: c.status, lastError: c.lastError, secrets: c.secrets };
        if (!s.secrets.oauth.pending) {
          if (s.status === "connected") return finish({ kind: "connected", connector: c });
          if (s.secrets.oauth.authorized) {
            // the tokens land before the first connection finishes: wait for it (or its error)
            if (s.lastError) return finish({ kind: "authorized_with_error", connector: c, error: s.lastError });
            authorizedAt ??= Date.now();
            if (Date.now() - authorizedAt > FIRST_CONNECTION_GRACE_MS) {
              return finish({ kind: "authorized_with_error", connector: c, error: "The first connection failed" });
            }
            return;
          }
          if (s.lastError) return finish({ kind: "failed", error: s.lastError });
        }
      } catch { /* keep waiting */ }
      if (Date.now() - started > timeoutMs) return finish({ kind: "failed", error: "The sign-in link expired. Try again." });
      // the window is closed and nothing came back after a couple more checks: cancelled
      if (popup?.closed && ++closedPolls >= 3) finish({ kind: "cancelled" });
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; ok?: boolean; id?: string | null; account?: string } | null;
      if (!data || data.type !== OAUTH_MESSAGE_TYPE) return;
      if (data.id && data.id !== id) return;
      if (account && data.account && data.account !== account) return;
      void check();
    };
    const onAbort = () => finish({ kind: "cancelled" });
    const timer = setInterval(() => void check(), intervalMs);
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort);
  });
}

/** The bundled official icon for a catalog id (ui/public/connector-icons), if any. */
export function connectorIconSrc(catalogId: string | undefined): string | undefined {
  const ext = catalogId ? CONNECTOR_ICON_FILES[catalogId] : undefined;
  return ext ? `${import.meta.env.BASE_URL ?? "/"}connector-icons/${catalogId}.${ext}`.replace(/\/{2,}/g, "/") : undefined;
}

/** Tool name for display: the server's title, else its name. */
export function toolLabel(tool: { name: string; title?: string }): string {
  return tool.title?.trim() || tool.name;
}
