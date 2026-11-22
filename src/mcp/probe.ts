/**
 * "How do I connect to this MCP server?" — what Claude's custom connector dialog works out from a
 * URL, server side and read only (the same network rules as icon discovery: https only, no private
 * addresses, short timeouts, small bodies):
 *
 *   1. transport: POST `initialize` (Streamable HTTP); when the endpoint does not take it, GET with
 *      `Accept: text/event-stream` (legacy SSE);
 *   2. auth: `initialize` succeeds → none; 401 / 403 → the `WWW-Authenticate` `resource_metadata`, else the
 *      well-known protected resource metadata (RFC 9728: resource, resource_name, scopes_supported,
 *      authorization_servers), then the authorization server's metadata (RFC 8414 / OpenID Connect:
 *      registration_endpoint → dynamic client registration, client_id_metadata_document_supported → a
 *      Client ID Metadata Document, PKCE methods, token endpoint auth methods). A 401 with no OAuth
 *      metadata at all → a bearer token;
 *   3. who it is: serverInfo (name, title, version, website, icons) and instructions when it answers
 *      without auth, else resource_name; the icon from icon discovery.
 *
 * The result lists the ways to connect, with the recommended one flagged, and the values to prefill
 * (name, transport, scopes). Nothing is stored and no client is registered.
 */
import {
  discoverConnectorIcon, IconFetchError, type FetchedResource, type IconImage, type SafeFetcher,
} from "./icons.js";

export type ProbeAuth = "none" | "oauth-cimd" | "oauth-dcr" | "oauth-preregistered" | "bearer";

export interface ProbeOption {
  auth: ProbeAuth;
  recommended: boolean;
  /** One line on what it means for the person. */
  description: string;
}

export interface ProbeResult {
  /** The URL probed (as given, trimmed). */
  url: string;
  reachable: boolean;
  /** Why it could not be probed (unreachable, not an MCP server, blocked address…). */
  error?: string;
  transport?: "http" | "sse";
  authRequired?: boolean;
  server?: { name?: string; title?: string; version?: string; websiteUrl?: string; instructions?: string; protocolVersion?: string };
  resource?: { resource?: string; resourceName?: string; scopes?: string[]; authorizationServers?: string[]; metadataUrl?: string };
  authorizationServer?: {
    issuer?: string; metadataUrl?: string; registration: boolean; cimd: boolean; pkceMethods: string[];
    tokenAuthMethods: string[]; scopes?: string[];
  };
  options: ProbeOption[];
  recommendation?: {
    transport: "http" | "sse";
    auth: ProbeAuth;
    recommended: true;
    /** Scopes to request, preselected (all the resource supports); empty: the server's default. */
    scopes: string[];
    name?: string;
    /** A preview of the icon (data URI) and where it came from. */
    icon?: { dataUri: string; source: string; src?: string };
    notes: string[];
  };
}

export interface ProbeOptions {
  fetch: SafeFetcher;
  /** The instance can publish a Client ID Metadata Document (its public URL is https). */
  canUseCimd?: boolean;
  /** Also look the icon up (default true). */
  icon?: boolean;
  log?: (message: string) => void;
}

const PROTOCOL_VERSION = "2025-11-25";
const JSON_MAX = 128 * 1024;

const DESCRIPTIONS: Record<ProbeAuth, string> = {
  none: "No sign-in: the server is open to anyone with the URL.",
  "oauth-cimd": "Sign in with OAuth; Polpo identifies itself with its client metadata document (nothing to register).",
  "oauth-dcr": "Sign in with OAuth; Polpo registers itself with the server automatically (dynamic client registration).",
  "oauth-preregistered": "Sign in with OAuth using a client id (and secret) you create in the vendor's developer console.",
  bearer: "Paste an API key or token; Polpo sends it as Authorization: Bearer.",
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The `resource_metadata` parameter of a `WWW-Authenticate: Bearer …` challenge. */
export function resourceMetadataFromChallenge(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/i.exec(header);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** The first JSON-RPC message of a JSON or SSE response body. */
export function firstJsonRpc(body: string, contentType: string): Record<string, unknown> | undefined {
  const parse = (text: string) => {
    try {
      const v = JSON.parse(text) as unknown;
      const msg = Array.isArray(v) ? v[0] : v;
      return msg && typeof msg === "object" && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0" ? msg as Record<string, unknown> : undefined;
    } catch { return undefined; }
  };
  if (/text\/event-stream/.test(contentType)) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      const msg = data && parse(data);
      if (msg) return msg;
    }
    return undefined;
  }
  return parse(body);
}

const stringList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function getJson(fetcher: SafeFetcher, url: string): Promise<{ data: Record<string, unknown>; url: string } | undefined> {
  try {
    const res = await fetcher(url, { maxBytes: JSON_MAX, accept: "application/json" });
    if (res.status !== 200) return undefined;
    const data = JSON.parse(res.body.toString("utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? { data: data as Record<string, unknown>, url: res.url } : undefined;
  } catch {
    return undefined;
  }
}

/** RFC 9728 / RFC 8414 well-known URL: inserted between the origin and the path; then the root. */
function wellKnownUrls(resource: string, suffix: string): string[] {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, "");
  return path ? [`${u.origin}/.well-known/${suffix}${path}`, `${u.origin}/.well-known/${suffix}`] : [`${u.origin}/.well-known/${suffix}`];
}

/** The authorization server's metadata: RFC 8414, then OpenID Connect discovery (both URL forms). */
async function authServerMetadata(fetcher: SafeFetcher, issuer: string) {
  const urls = [...wellKnownUrls(issuer, "oauth-authorization-server").slice(0, 1), ...wellKnownUrls(issuer, "openid-configuration").slice(0, 1)];
  const trimmed = issuer.replace(/\/+$/, "");
  const oidcAppended = `${trimmed}/.well-known/openid-configuration`;
  if (!urls.includes(oidcAppended)) urls.push(oidcAppended);
  for (const url of urls) {
    const found = await getJson(fetcher, url);
    if (found && (str(found.data.authorization_endpoint) || str(found.data.token_endpoint))) return found;
  }
  return undefined;
}

function iconDataUri(image: IconImage): string {
  return `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;
}

/** Probe an MCP server URL (see the module comment). Never throws. */
export async function probeConnector(rawUrl: string, options: ProbeOptions): Promise<ProbeResult> {
  const url = rawUrl.trim();
  const fetcher = options.fetch;
  const result: ProbeResult = { url, reachable: false, options: [] };
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http");
  } catch {
    return { ...result, error: "Not a valid https URL" };
  }

  // 1. Streamable HTTP: POST initialize
  const initialize = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "polpo", version: "1.0.0" } },
  });
  let post: FetchedResource | undefined;
  try {
    post = await fetcher(url, {
      method: "POST", body: initialize, maxBytes: JSON_MAX, truncate: true,
      accept: "application/json, text/event-stream",
      headers: { "content-type": "application/json", "mcp-protocol-version": PROTOCOL_VERSION },
      // a streamed response: stop at the first complete event
      stopWhen: (b) => /\r?\n\r?\n/.test(b.toString("utf8")) && /^data:/m.test(b.toString("utf8")),
    });
  } catch (err) {
    if (err instanceof IconFetchError) return { ...result, error: err.message };
    return { ...result, error: `Could not reach the server: ${errorText(err)}` };
  }
  result.reachable = true;

  let challenge: string | undefined;
  if (post.status === 200) {
    const msg = firstJsonRpc(post.body.toString("utf8"), post.contentType);
    const res = msg?.result as Record<string, unknown> | undefined;
    if (res && typeof res === "object") {
      const info = (res.serverInfo ?? {}) as Record<string, unknown>;
      result.transport = "http";
      result.authRequired = false;
      result.server = {
        ...(str(info.name) ? { name: str(info.name) } : {}), ...(str(info.title) ? { title: str(info.title) } : {}),
        ...(str(info.version) ? { version: str(info.version) } : {}), ...(str(info.websiteUrl) ? { websiteUrl: str(info.websiteUrl) } : {}),
        ...(str(res.instructions) ? { instructions: str(res.instructions)!.slice(0, 2000) } : {}),
        ...(str(res.protocolVersion) ? { protocolVersion: str(res.protocolVersion) } : {}),
      };
      // end the session politely (best effort)
      const session = post.headers["mcp-session-id"];
      if (session) void fetcher(url, { method: "DELETE", maxBytes: 1024, accept: "*/*", headers: { "mcp-session-id": session } }).catch(() => undefined);
      return finish(result, info.icons, options);
    }
    if (msg) {
      // an MCP server that answered with an error (e.g. a protocol version it does not take): no auth needed
      result.transport = "http";
      result.authRequired = false;
      return finish(result, undefined, options);
    }
  }
  if (post.status === 401 || post.status === 403) {
    result.transport = "http";
    result.authRequired = true;
    challenge = post.headers["www-authenticate"];
  } else if (post.status !== 200 || !firstJsonRpc(post.body.toString("utf8"), post.contentType)) {
    // 2. legacy SSE: GET the stream, read the first event
    try {
      const get = await fetcher(url, {
        maxBytes: 8 * 1024, truncate: true, accept: "text/event-stream",
        stopWhen: (b) => /\r?\n\r?\n/.test(b.toString("utf8")),
      });
      if (get.status === 200 && /text\/event-stream/.test(get.contentType)) {
        result.transport = "sse";
        result.authRequired = false;
      } else if ((get.status === 401 || get.status === 403)) {
        result.transport = /text\/event-stream/.test(get.contentType) || post.status === 405 || post.status === 404 ? "sse" : "http";
        result.authRequired = true;
        challenge = get.headers["www-authenticate"];
      }
    } catch { /* not SSE either */ }
    if (!result.transport) {
      return { ...result, error: `This does not look like an MCP server (HTTP ${post.status} to initialize, no event stream)` };
    }
    if (!result.authRequired) return finish(result, undefined, options);
  }

  // 3. OAuth metadata
  const prmUrls = [resourceMetadataFromChallenge(challenge), ...wellKnownUrls(url, "oauth-protected-resource")].filter((x): x is string => !!x);
  let prm: { data: Record<string, unknown>; url: string } | undefined;
  for (const candidate of [...new Set(prmUrls)]) {
    try { new URL(candidate); } catch { continue; }
    prm = await getJson(fetcher, new URL(candidate, url).toString());
    if (prm) break;
  }
  if (prm) {
    result.resource = {
      ...(str(prm.data.resource) ? { resource: str(prm.data.resource) } : {}),
      ...(str(prm.data.resource_name) ? { resourceName: str(prm.data.resource_name) } : {}),
      ...(stringList(prm.data.scopes_supported) ? { scopes: stringList(prm.data.scopes_supported) } : {}),
      ...(stringList(prm.data.authorization_servers) ? { authorizationServers: stringList(prm.data.authorization_servers) } : {}),
      metadataUrl: prm.url,
    };
  }
  // the 2025-03-26 spec: no resource metadata, the authorization server at the MCP server's origin
  const issuer = result.resource?.authorizationServers?.[0] ?? new URL(url).origin;
  const as = await authServerMetadata(fetcher, issuer);
  if (as) {
    result.authorizationServer = {
      ...(str(as.data.issuer) ? { issuer: str(as.data.issuer) } : { issuer }),
      metadataUrl: as.url,
      registration: !!str(as.data.registration_endpoint),
      cimd: as.data.client_id_metadata_document_supported === true,
      pkceMethods: stringList(as.data.code_challenge_methods_supported) ?? [],
      tokenAuthMethods: stringList(as.data.token_endpoint_auth_methods_supported) ?? [],
      ...(stringList(as.data.scopes_supported) ? { scopes: stringList(as.data.scopes_supported) } : {}),
    };
  }
  return finish(result, undefined, options);
}

/** The options, the recommendation and the icon. */
async function finish(result: ProbeResult, serverIcons: unknown, options: ProbeOptions): Promise<ProbeResult> {
  const notes: string[] = [];
  const as = result.authorizationServer;
  let recommended: ProbeAuth;
  let alternatives: ProbeAuth[] = [];
  if (!result.authRequired) {
    recommended = "none";
    alternatives = ["bearer"];
  } else if (as || result.resource?.authorizationServers?.length) {
    if (as?.cimd && options.canUseCimd) recommended = "oauth-cimd";
    else if (as?.registration) recommended = "oauth-dcr";
    else if (as?.cimd) {
      recommended = "oauth-cimd";
      notes.push("The server only accepts a Client ID Metadata Document: this instance needs a public https URL (POLPO_PUBLIC_URL).");
    } else {
      recommended = "oauth-preregistered";
      notes.push("The server does not register clients automatically: create an OAuth client in its developer console and enter its client id (and secret).");
    }
    alternatives = [...new Set<ProbeAuth>([
      ...(as?.cimd && recommended !== "oauth-cimd" ? ["oauth-cimd" as const] : []),
      ...(as?.registration && recommended !== "oauth-dcr" ? ["oauth-dcr" as const] : []),
      "oauth-preregistered", "bearer",
    ])].filter((a) => a !== recommended);
    if (as && as.pkceMethods.length && !as.pkceMethods.includes("S256")) notes.push("The authorization server does not advertise PKCE S256: the sign-in may fail.");
    if (!as) notes.push("The authorization server's metadata could not be read: the sign-in may fail.");
    else notes.push(`Sign-in at ${(() => { try { return new URL(as.issuer ?? "").host; } catch { return as.issuer; } })()}${as.registration ? " (dynamic client registration)" : ""}${as.cimd ? " (client metadata document)" : ""}.`);
  } else {
    recommended = "bearer";
    alternatives = ["oauth-preregistered"];
    notes.push("The server needs authorization but publishes no OAuth metadata: it probably takes an API key or token.");
  }
  if (result.transport === "sse") notes.push("Legacy SSE transport (the server does not take Streamable HTTP requests).");
  result.options = [recommended, ...alternatives].map((auth) => ({ auth, recommended: auth === recommended, description: DESCRIPTIONS[auth] }));

  const host = (() => { try { return new URL(result.url).hostname; } catch { return undefined; } })();
  const name = result.server?.title ?? result.resource?.resourceName ?? result.server?.name ?? host;
  let icon: NonNullable<ProbeResult["recommendation"]>["icon"];
  if (options.icon !== false) {
    try {
      const found = await discoverConnectorIcon({
        serverUrl: result.url,
        ...(serverIcons !== undefined || result.server?.websiteUrl ? { serverInfo: { icons: serverIcons, websiteUrl: result.server?.websiteUrl } } : {}),
        oauth: !!result.authRequired && recommended !== "bearer",
        ...(result.resource?.authorizationServers?.[0] ? { authorizationServer: result.resource.authorizationServers[0] } : {}),
      }, { fetch: options.fetch, budgetMs: 15_000, ...(options.log ? { log: options.log } : {}) });
      if (found) icon = { dataUri: iconDataUri(found.light), source: found.source, ...(found.light.src ? { src: found.light.src } : {}) };
    } catch { /* no icon */ }
  }
  result.recommendation = {
    transport: result.transport ?? "http",
    auth: recommended,
    recommended: true,
    scopes: recommended.startsWith("oauth") ? result.resource?.scopes ?? [] : [],
    ...(name ? { name: name.slice(0, 80) } : {}),
    ...(icon ? { icon } : {}),
    notes,
  };
  return result;
}
