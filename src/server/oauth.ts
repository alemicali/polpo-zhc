/**
 * OAuth 2.1 for the MCP connector, so Claude (web, Desktop, mobile), ChatGPT and other clients can
 * connect with a sign-in instead of an API key. Polpo is both the resource (its /mcp endpoint) and
 * the authorization server:
 *
 * - discovery: protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414);
 * - clients: Client ID Metadata Documents (an https client_id whose JSON lists its redirect URIs) or
 *   Dynamic Client Registration (RFC 7591);
 * - authorization code with PKCE S256 only; `iss` in the response (RFC 9207); loopback redirects match
 *   on any port (native clients such as Claude Code);
 * - opaque access tokens (1 hour) and rotating refresh tokens (30 days), stored hashed;
 * - consent: a person signed in to the dashboard, or who enters the server's API key (or MCP key), allows the client;
 * - the endpoints may be public: open registration is capped, and metadata documents are only fetched
 *   from public addresses.
 *
 * State lives in `.polpo/oauth.json` (clients and tokens); authorization codes in memory (10 minutes).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
/** Registered (DCR) clients kept; past it the oldest without live tokens go, so open registration cannot fill the disk. */
const MAX_DCR_CLIENTS = 200;
export const OAUTH_SCOPE = "polpo";

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  /** "cimd": described by its https client_id; "dcr": registered here. */
  source: "cimd" | "dcr";
  created_at: string;
}

interface StoredToken {
  /** sha256 of the token. */
  hash: string;
  kind: "access" | "refresh";
  client_id: string;
  scope: string;
  resource: string;
  /** Who allowed it (an email, "api-key", or "local"). */
  subject: string;
  expires_at: number;
}

interface OAuthState {
  clients: OAuthClient[];
  tokens: StoredToken[];
}

interface PendingCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  subject: string;
  expires_at: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Does a redirect URI match a registered one? Exact, or loopback on any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const r = new URL(registered);
    const q = new URL(requested);
    const loopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    return r.protocol === "http:" && q.protocol === "http:" && loopback(r.hostname) && loopback(q.hostname)
      && r.hostname === q.hostname && r.pathname === q.pathname && r.search === q.search;
  } catch {
    return false;
  }
}

/** Is an address private, loopback, link-local or shared (CGNAT, the tailnet)? */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/** The addresses a host name resolves to. */
export type ResolveHost = (hostname: string) => Promise<string[]>;
const resolveHost: ResolveHost = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/** S256 PKCE check. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return safeEqual(createHash("sha256").update(verifier).digest("base64url"), challenge);
}

export class OAuthServer {
  private codes = new Map<string, PendingCode>();
  private readonly file: string;

  constructor(polpoDir: string, private readonly fetchImpl: typeof fetch = fetch, private readonly resolve: ResolveHost = resolveHost) {
    this.file = join(polpoDir, "oauth.json");
  }

  private read(): OAuthState {
    try {
      const state = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<OAuthState>;
      return { clients: state.clients ?? [], tokens: state.tokens ?? [] };
    } catch {
      return { clients: [], tokens: [] };
    }
  }

  private write(state: OAuthState): void {
    const now = Math.floor(Date.now() / 1000);
    state.tokens = state.tokens.filter((t) => t.expires_at > now);
    if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Dynamic Client Registration (RFC 7591): a public client with its redirect URIs. */
  register(body: { client_name?: unknown; redirect_uris?: unknown }): OAuthClient {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
    for (const uri of uris) {
      let u: URL;
      try { u = new URL(uri); } catch { throw new OAuthError("invalid_redirect_uri", `Invalid redirect URI ${uri}`); }
      const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
        throw new OAuthError("invalid_redirect_uri", "Redirect URIs must be https, or http on a loopback address");
      }
    }
    const client: OAuthClient = {
      client_id: `polpo_client_${randomBytes(12).toString("base64url")}`,
      ...(typeof body.client_name === "string" ? { client_name: body.client_name.slice(0, 200) } : {}),
      redirect_uris: uris.slice(0, 20),
      source: "dcr",
      created_at: new Date().toISOString(),
    };
    const state = this.read();
    state.clients.push(client);
    const inUse = new Set(state.tokens.map((t) => t.client_id));
    let excess = state.clients.filter((c) => c.source === "dcr").length - MAX_DCR_CLIENTS;
    state.clients = state.clients.filter((c) => {
      if (excess <= 0 || c.source !== "dcr" || c === client || inUse.has(c.client_id)) return true;
      excess--;
      return false;
    });
    this.write(state);
    return client;
  }

  /** The client: registered here, or described by its https client_id (Client ID Metadata Document). */
  async client(clientId: string): Promise<OAuthClient> {
    const known = this.read().clients.find((c) => c.client_id === clientId);
    if (known) return known;
    if (!clientId.startsWith("https://")) throw new OAuthError("invalid_client", "Unknown client");
    // the endpoint is public: never fetch an address inside the network this server runs in
    const hostname = new URL(clientId).hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [hostname] : await this.resolve(hostname).catch(() => []);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new OAuthError("invalid_client", "Could not read the client's metadata document");
    const res = await this.fetchImpl(clientId, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" })
      .catch(() => null);
    if (!res || !res.ok) throw new OAuthError("invalid_client", "Could not read the client's metadata document");
    const text = await res.text();
    if (text.length > 20_000) throw new OAuthError("invalid_client", "Could not read the client's metadata document");
    let doc: { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    try { doc = JSON.parse(text); } catch { throw new OAuthError("invalid_client", "Could not read the client's metadata document"); }
    if (doc.client_id !== clientId) throw new OAuthError("invalid_client", "The metadata document's client_id does not match");
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0) throw new OAuthError("invalid_client", "The metadata document lists no redirect_uris");
    return {
      client_id: clientId,
      ...(typeof doc.client_name === "string" ? { client_name: doc.client_name.slice(0, 200) } : {}),
      redirect_uris: uris,
      source: "cimd",
      created_at: new Date().toISOString(),
    };
  }

  /** Checks an authorization request; returns the client to show on the consent page. */
  async checkAuthorizeRequest(q: Record<string, string | undefined>, resource: string): Promise<OAuthClient> {
    if (q.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code");
    if (!q.client_id) throw new OAuthError("invalid_request", "client_id is required");
    const client = await this.client(q.client_id);
    if (!q.redirect_uri || !client.redirect_uris.some((r) => redirectUriMatches(r, q.redirect_uri!))) {
      throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
    }
    if (!q.code_challenge || q.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "PKCE with code_challenge_method=S256 is required");
    if (q.resource && q.resource.replace(/\/+$/, "") !== resource.replace(/\/+$/, "")) throw new OAuthError("invalid_target", "Unknown resource");
    return client;
  }

  /** The person allowed the client: a single-use code for the token endpoint. */
  issueCode(q: Record<string, string | undefined>, resource: string, subject: string): string {
    for (const [k, v] of this.codes) if (v.expires_at < Date.now()) this.codes.delete(k);
    const code = token("polpo_code");
    this.codes.set(code, {
      client_id: q.client_id!,
      redirect_uri: q.redirect_uri!,
      code_challenge: q.code_challenge!,
      scope: OAUTH_SCOPE,
      resource,
      subject,
      expires_at: Date.now() + CODE_TTL_MS,
    });
    return code;
  }

  /** The token endpoint: authorization_code (with PKCE) or refresh_token (rotated). */
  exchange(form: Record<string, string | undefined>): { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string } {
    const state = this.read();
    const now = Math.floor(Date.now() / 1000);
    let grant: { client_id: string; scope: string; resource: string; subject: string };
    if (form.grant_type === "authorization_code") {
      const pending = form.code ? this.codes.get(form.code) : undefined;
      if (form.code) this.codes.delete(form.code); // single use, whatever happens next
      if (!pending || pending.expires_at < Date.now()) throw new OAuthError("invalid_grant", "The code is invalid or expired");
      if (form.client_id && form.client_id !== pending.client_id) throw new OAuthError("invalid_grant", "The code was issued to another client");
      if (form.redirect_uri !== pending.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
      if (!form.code_verifier || !pkceMatches(form.code_verifier, pending.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
      grant = pending;
    } else if (form.grant_type === "refresh_token") {
      const hash = form.refresh_token ? sha256(form.refresh_token) : "";
      const stored = state.tokens.find((t) => t.kind === "refresh" && t.hash === hash);
      if (!stored || stored.expires_at <= now) throw new OAuthError("invalid_grant", "The refresh token is invalid or expired");
      if (form.client_id && form.client_id !== stored.client_id) throw new OAuthError("invalid_grant", "The refresh token was issued to another client");
      // rotation: the old refresh token stops working now
      state.tokens = state.tokens.filter((t) => t !== stored);
      grant = stored;
    } else {
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    const access = token("polpo_at");
    const refresh = token("polpo_rt");
    const base = { client_id: grant.client_id, scope: grant.scope, resource: grant.resource, subject: grant.subject };
    state.tokens.push({ ...base, hash: sha256(access), kind: "access", expires_at: now + ACCESS_TOKEN_TTL_S });
    state.tokens.push({ ...base, hash: sha256(refresh), kind: "refresh", expires_at: now + REFRESH_TOKEN_TTL_S });
    this.write(state);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: grant.scope };
  }

  /** A valid access token for this resource: who allowed it, or null. */
  verifyAccessToken(accessToken: string | undefined, resource: string): { subject: string; client_id: string } | null {
    if (!accessToken) return null;
    const now = Math.floor(Date.now() / 1000);
    const hash = sha256(accessToken);
    const found = this.read().tokens.find((t) => t.kind === "access" && t.hash === hash && t.expires_at > now);
    if (!found || found.resource.replace(/\/+$/, "") !== resource.replace(/\/+$/, "")) return null;
    return { subject: found.subject, client_id: found.client_id };
  }

  /** Revoke a token (RFC 7009): always succeeds. */
  revoke(tokenValue: string | undefined): void {
    if (!tokenValue) return;
    const state = this.read();
    const hash = sha256(tokenValue);
    const found = state.tokens.find((t) => t.hash === hash);
    if (!found) return;
    // revoking one revokes the whole grant of that client for that person
    state.tokens = state.tokens.filter((t) => !(t.client_id === found.client_id && t.subject === found.subject));
    this.write(state);
  }
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Protected resource metadata (RFC 9728) for the MCP endpoint. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Polpo",
  };
}

/** Authorization server metadata (RFC 8414). */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE, "offline_access"],
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The consent page: who asks, where it will go back, and how to allow it. */
export function consentPage(input: {
  client: OAuthClient;
  redirectUri: string;
  params: Record<string, string | undefined>;
  /** How the person proves they may allow it. */
  method: "session" | "api-key" | "open";
  email?: string;
  error?: string;
  loginUrl?: string;
}): string {
  const host = (() => { try { return new URL(input.redirectUri).host; } catch { return input.redirectUri; } })();
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  const hidden = Object.entries(input.params).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v!)}">`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Polpo</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f6f7;color:#18181b}
@media(prefers-color-scheme:dark){body{background:#0b0b0d;color:#e4e4e7}.card{background:#18181b;border-color:#27272a}input{background:#0b0b0d;color:#e4e4e7;border-color:#3f3f46}}
.card{max-width:420px;width:calc(100% - 32px);background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}.muted{color:#71717a;font-size:13px}.warn{color:#b45309;font-size:13px}.err{color:#dc2626;font-size:13px}
input[type=password]{width:100%;box-sizing:border-box;padding:8px;border:1px solid #d4d4d8;border-radius:8px;margin:8px 0}
button{padding:8px 16px;border-radius:8px;border:0;background:#18181b;color:#fff;font-weight:600;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#e4e4e7;color:#18181b}}.row{display:flex;gap:8px;margin-top:16px}.secondary{background:transparent;color:inherit;border:1px solid #d4d4d8}</style></head>
<body><form class="card" method="post" action="authorize">${hidden}
<h1>Connect ${esc(input.client.client_name ?? "an app")} to Polpo</h1>
<p>It will be able to use this Polpo instance on your behalf: ask Polpo, talk to agents, read and change tasks, missions, artifacts and data.</p>
<p class="muted">You will be sent back to <b>${esc(host)}</b>.</p>
${loopback ? `<p class="warn">This is an app on your computer (a local address). Allow it only if you just started the connection yourself.</p>` : ""}
${input.error ? `<p class="err">${esc(input.error)}</p>` : ""}
${input.method === "session" ? `<p class="muted">Signed in as ${esc(input.email ?? "")}.</p>` : ""}
${input.method === "api-key" ? `<label class="muted">Enter this server's API key or MCP key to allow it${input.loginUrl ? `, or <a href="${esc(input.loginUrl)}">sign in to the dashboard</a> first` : ""}:</label><input type="password" name="api_key" autocomplete="off" required>` : ""}
<div class="row"><button type="submit" name="decision" value="allow">Allow</button><button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></div>
</form></body></html>`;
}
