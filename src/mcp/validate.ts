/**
 * Building and changing connectors from API / Polpo input: validation, catalog defaults, and the
 * split between configuration (connectors.json) and secrets (vault, write-only).
 */
import {
  CONNECTOR_ID_PATTERN, connectorSlug,
  type ConnectorAccess, type ConnectorAuth, type ConnectorAuthType, type ConnectorConfig, type ConnectorOAuthSettings,
  type ConnectorToolPolicy, type ConnectorTransport,
} from "@polpo-ai/core";
import { catalogEntry } from "./catalog.js";
import { checkConnectorUrl, type UrlPolicy } from "./net.js";
import { SECRET_KEYS } from "./secrets.js";

export class ConnectorInputError extends Error {}

/** Write-only secrets a request may carry. */
export interface ConnectorSecretsInput {
  /** auth "bearer": the token. */
  bearerToken?: string;
  /** auth "headers": header name → value. */
  headers?: Record<string, string>;
  /** auth "oauth" with a pre-registered client: its secret. */
  clientSecret?: string;
  /** Named values for `${vault:KEY}` references in stdio env and headers. */
  values?: Record<string, string>;
}

export interface ConnectorInput {
  id?: string;
  name?: string;
  description?: string;
  catalogId?: string;
  /** Shortcut for transport.url. */
  url?: string;
  transport?: Partial<ConnectorTransport>;
  auth?: { type?: ConnectorAuthType; headerNames?: string[]; oauth?: Partial<ConnectorOAuthSettings> };
  access?: Partial<ConnectorAccess>;
  enabled?: boolean;
  toolTimeoutMs?: number;
  toolPolicy?: Record<string, ConnectorToolPolicy>;
  secrets?: ConnectorSecretsInput;
}

export interface ValidateContext extends UrlPolicy {
  /** Local processes (stdio) may be configured: only an authenticated admin API call. */
  allowStdio: boolean;
  existingIds: string[];
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
const SECRET_KEY = /^[A-Za-z0-9_.-]{1,100}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const TRANSPORTS = new Set(["http", "sse", "stdio"]);
const AUTH_TYPES = new Set(["none", "bearer", "headers", "oauth"]);
const POLICIES = new Set(["allow", "ask", "off"]);

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new ConnectorInputError(`${what} must be a list of strings`);
  return value as string[];
}

function stringRecord(value: unknown, what: string, keyPattern: RegExp): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorInputError(`${what} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!keyPattern.test(k)) throw new ConnectorInputError(`${what}: invalid name "${k}"`);
    if (typeof v !== "string") throw new ConnectorInputError(`${what}.${k} must be a string`);
    out[k] = v;
  }
  return out;
}

function normalizeAccess(input: Partial<ConnectorAccess> | undefined, base: ConnectorAccess): ConnectorAccess {
  if (!input) return base;
  const agents = input.agents === undefined ? base.agents
    : input.agents === "*" ? "*"
    : [...new Set(strings(input.agents, "access.agents").map((a) => a.trim()).filter(Boolean))];
  if (Array.isArray(agents) && agents.some((a) => a.startsWith("$"))) throw new ConnectorInputError("access.agents: invalid agent name");
  return { agents, polpo: input.polpo === undefined ? base.polpo : input.polpo === true };
}

function normalizeOAuth(input: Partial<ConnectorOAuthSettings> | undefined, base?: ConnectorOAuthSettings): ConnectorOAuthSettings | undefined {
  if (!input) return base;
  const next: ConnectorOAuthSettings = { ...(base ?? {}) };
  if (input.clientId !== undefined) {
    if (input.clientId) next.clientId = String(input.clientId).trim();
    else delete next.clientId;
  }
  if (input.app !== undefined) {
    if (input.app) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.app)) throw new ConnectorInputError("auth.oauth.app: invalid OAuth app id");
      next.app = input.app;
    } else delete next.app;
  }
  if (input.scopes !== undefined) next.scopes = strings(input.scopes, "auth.oauth.scopes");
  if (input.extraAuthParams !== undefined) next.extraAuthParams = stringRecord(input.extraAuthParams, "auth.oauth.extraAuthParams", /^[A-Za-z0-9_.-]{1,100}$/);
  if (input.authorizationServer !== undefined) {
    if (input.authorizationServer && !/^https:\/\//.test(input.authorizationServer)) throw new ConnectorInputError("auth.oauth.authorizationServer must be an https URL");
    if (input.authorizationServer) next.authorizationServer = input.authorizationServer;
    else delete next.authorizationServer;
  }
  if (input.resourceIndicator !== undefined) {
    if (input.resourceIndicator === false) next.resourceIndicator = false;
    else delete next.resourceIndicator;
  }
  return next;
}

function normalizeToolPolicy(value: unknown): Record<string, ConnectorToolPolicy> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorInputError("toolPolicy must be an object");
  const out: Record<string, ConnectorToolPolicy> = {};
  for (const [tool, policy] of Object.entries(value as Record<string, unknown>)) {
    if (!POLICIES.has(policy as string)) throw new ConnectorInputError(`toolPolicy.${tool} must be "allow", "ask" or "off"`);
    out[tool] = policy as ConnectorToolPolicy;
  }
  return out;
}

async function normalizeTransport(input: Partial<ConnectorTransport>, ctx: ValidateContext): Promise<ConnectorTransport> {
  const type = input.type ?? (input.command ? "stdio" : "http");
  if (!TRANSPORTS.has(type)) throw new ConnectorInputError(`transport.type must be "http", "sse" or "stdio"`);
  if (type === "stdio") {
    if (!ctx.allowStdio) throw new ConnectorInputError("Local (stdio) connectors can only be added by an admin through the API (they run a command on this server)");
    if (!input.command || typeof input.command !== "string") throw new ConnectorInputError("transport.command is required for stdio");
    return {
      type,
      command: input.command,
      ...(input.args !== undefined ? { args: strings(input.args, "transport.args") } : {}),
      ...(input.env !== undefined ? { env: stringRecord(input.env, "transport.env", ENV_NAME) } : {}),
    };
  }
  if (!input.url || typeof input.url !== "string") throw new ConnectorInputError("transport.url (the MCP server URL) is required");
  if (input.url.includes("<") || /\{[^}]*\}/.test(input.url)) {
    throw new ConnectorInputError("This app needs your own URL: replace the {placeholders} with yours (e.g. from your account settings)");
  }
  try {
    await checkConnectorUrl(input.url, ctx);
  } catch (err) {
    throw new ConnectorInputError(err instanceof Error ? err.message : String(err));
  }
  return {
    type,
    url: input.url,
    ...(input.headers !== undefined ? { headers: stringRecord(input.headers, "transport.headers", HEADER_NAME) } : {}),
  };
}

/** The secrets to store: vault key → value (undefined/"" removes). */
function secretValues(input: ConnectorSecretsInput | undefined): { values: Record<string, string | undefined>; headerNames: string[] } {
  const values: Record<string, string | undefined> = {};
  const headerNames: string[] = [];
  if (!input) return { values, headerNames };
  if (input.bearerToken !== undefined) values[SECRET_KEYS.bearer] = String(input.bearerToken).trim();
  if (input.clientSecret !== undefined) values[SECRET_KEYS.clientSecret] = String(input.clientSecret);
  if (input.headers !== undefined) {
    for (const [name, value] of Object.entries(stringRecord(input.headers, "secrets.headers", HEADER_NAME))) {
      values[SECRET_KEYS.header(name)] = value;
      if (value) headerNames.push(name);
    }
  }
  if (input.values !== undefined) {
    for (const [key, value] of Object.entries(stringRecord(input.values, "secrets.values", SECRET_KEY))) values[SECRET_KEYS.secret(key)] = value;
  }
  return { values, headerNames };
}

/** A new connector from input (and its catalog entry). */
export async function buildConnector(input: ConnectorInput, ctx: ValidateContext): Promise<{ connector: ConnectorConfig; secrets: Record<string, string | undefined> }> {
  const entry = input.catalogId ? catalogEntry(input.catalogId) : undefined;
  if (input.catalogId && !entry) throw new ConnectorInputError(`Unknown catalog entry "${input.catalogId}"`);
  let name = (input.name ?? entry?.name ?? "").trim();
  if (!name) throw new ConnectorInputError("name is required");
  let id = (input.id ?? "").trim();
  if (id) {
    if (!CONNECTOR_ID_PATTERN.test(id)) throw new ConnectorInputError("id: use lowercase letters, digits and - (max 40)");
    if (ctx.existingIds.includes(id)) throw new ConnectorInputError(`A connector "${id}" already exists`);
  } else {
    // another account of an app already added: gmail-2, gmail-3… with its own tokens and name
    const base = entry?.id ?? connectorSlug(name);
    id = base;
    let n = 1;
    while (ctx.existingIds.includes(id)) id = `${base.slice(0, 36)}-${++n}`;
    // no name given: "Gmail 2", so the two accounts never share one
    if (n > 1 && !input.name?.trim()) name = `${name} ${n}`;
  }
  const transport = await normalizeTransport({
    ...(entry ? { type: entry.transport, url: entry.url } : {}),
    ...(input.transport ?? {}),
    ...(input.url ? { url: input.url } : {}),
  }, ctx);
  let authType = input.auth?.type ?? (entry ? (entry.auth === "oauth_preregistered" ? "oauth" : entry.auth) : "none");
  if (!AUTH_TYPES.has(authType)) throw new ConnectorInputError(`auth.type must be "none", "bearer", "headers" or "oauth"`);
  if (authType === "oauth" && transport.type === "stdio") throw new ConnectorInputError("OAuth is for remote connectors");
  // a key sent in a vendor header instead of Authorization: Bearer (e.g. Google Maps' X-Goog-Api-Key)
  let secretsInput = input.secrets;
  if (authType === "bearer" && entry?.authHeader) {
    authType = "headers";
    if (secretsInput?.bearerToken !== undefined) {
      const { bearerToken, ...rest } = secretsInput;
      secretsInput = { ...rest, headers: { ...(rest.headers ?? {}), [entry.authHeader]: bearerToken! } };
    }
  }
  const { values, headerNames } = secretValues(secretsInput);
  if (authType === "headers" && entry?.authHeader) headerNames.push(entry.authHeader);
  const auth: ConnectorAuth = { type: authType };
  if (authType === "headers") auth.headerNames = [...new Set([...(input.auth?.headerNames ?? []), ...headerNames])];
  if (authType === "oauth") {
    const oauth = normalizeOAuth(input.auth?.oauth, entry?.oauth ? { ...entry.oauth } : undefined);
    if (oauth && Object.keys(oauth).length) auth.oauth = oauth;
  }
  const connector: ConnectorConfig = {
    id, name, kind: "mcp",
    ...(input.description ?? entry?.description ? { description: input.description ?? entry?.description } : {}),
    transport,
    auth,
    // default: Polpo may use it; agents are granted explicitly
    access: normalizeAccess(input.access, { agents: [], polpo: true }),
    enabled: input.enabled !== false,
    ...(entry ? { catalogId: entry.id } : {}),
    ...(entry?.icon ? { icon: entry.icon } : {}),
    ...(input.toolTimeoutMs !== undefined ? { toolTimeoutMs: timeout(input.toolTimeoutMs) } : {}),
    ...(input.toolPolicy !== undefined ? { toolPolicy: normalizeToolPolicy(input.toolPolicy) } : {}),
    createdAt: new Date().toISOString(),
    status: authType === "oauth" ? "needs_auth" : "disconnected",
  };
  return { connector, secrets: values };
}

function timeout(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1000 || n > 600_000) throw new ConnectorInputError("toolTimeoutMs must be between 1000 and 600000");
  return Math.round(n);
}

/** A change to an existing connector. Returns the patch and the secrets to write. */
export async function applyConnectorPatch(
  current: ConnectorConfig, input: ConnectorInput, ctx: ValidateContext,
): Promise<{ patch: Partial<ConnectorConfig>; secrets: Record<string, string | undefined>; reconnect: boolean }> {
  if (input.id !== undefined && input.id !== current.id) throw new ConnectorInputError("A connector's id cannot change");
  const patch: Partial<ConnectorConfig> = {};
  let reconnect = false;
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new ConnectorInputError("name cannot be empty");
    patch.name = input.name.trim();
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.enabled !== undefined) { patch.enabled = input.enabled === true; reconnect = true; }
  if (input.access !== undefined) patch.access = normalizeAccess(input.access, current.access);
  if (input.toolTimeoutMs !== undefined) patch.toolTimeoutMs = timeout(input.toolTimeoutMs);
  if (input.toolPolicy !== undefined) patch.toolPolicy = normalizeToolPolicy(input.toolPolicy);
  if (input.transport !== undefined || input.url !== undefined) {
    // changing a stdio command, or turning a remote connector into one, needs the admin API
    const next = { ...current.transport, ...(input.transport ?? {}), ...(input.url ? { url: input.url } : {}) };
    patch.transport = await normalizeTransport(next, ctx);
    reconnect = true;
  }
  const { values, headerNames } = secretValues(input.secrets);
  if (input.auth !== undefined || headerNames.length) {
    const type = input.auth?.type ?? current.auth.type;
    if (!AUTH_TYPES.has(type)) throw new ConnectorInputError(`auth.type must be "none", "bearer", "headers" or "oauth"`);
    const auth: ConnectorAuth = { type };
    if (type === "headers") {
      const removed = Object.entries(input.secrets?.headers ?? {}).filter(([, v]) => !v).map(([k]) => k);
      auth.headerNames = [...new Set([...(input.auth?.headerNames ?? current.auth.headerNames ?? []), ...headerNames])].filter((h) => !removed.includes(h));
    }
    if (type === "oauth") {
      const oauth = normalizeOAuth(input.auth?.oauth, current.auth.oauth);
      if (oauth && Object.keys(oauth).length) auth.oauth = oauth;
    }
    patch.auth = auth;
    reconnect = true;
  }
  if (Object.keys(values).length) reconnect = true;
  return { patch, secrets: values, reconnect };
}
