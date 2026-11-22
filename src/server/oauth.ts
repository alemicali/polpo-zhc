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
 * - consent: a person signed in to the dashboard, or who enters the server's API key (or MCP key), allows the client,
 *   and chooses its scopes (see SCOPES in mcp-server/kit.ts): read always, work, the areas, admin; a client that
 *   asks for none gets read and work. The old all-in-one scope "polpo" is still accepted (every scope);
 * - grants (a client allowed by a person) are listed with their scopes and last use, and revoked, from the dashboard;
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
import { ALL_SCOPES, DEFAULT_SCOPES, SCOPES, UMBRELLA_SCOPE, normalizeScopes, type PolpoScope } from "./mcp-server/kit.js";

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 10 * 60_000;
/** Registered (DCR) clients kept; past it the oldest without live tokens go, so open registration cannot fill the disk. */
const MAX_DCR_CLIENTS = 200;
/** How often a grant's last use is written down (verifying a token happens on every MCP request). */
const LAST_USED_RESOLUTION_MS = 60_000;
/** The scopes in metadata documents (what a client may ask for). */
export const OAUTH_SCOPES_SUPPORTED: readonly string[] = ALL_SCOPES;
/** What a client gets when it names no scope, and what the first 401 suggests. */
export const OAUTH_DEFAULT_SCOPE = DEFAULT_SCOPES.join(" ");

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

/** When a grant (a client allowed by a person) was made and last used. */
interface GrantMeta {
  created_at: string;
  last_used_at?: string;
}

interface OAuthState {
  clients: OAuthClient[];
  tokens: StoredToken[];
  /** By grant id (see grantId). */
  grants?: Record<string, GrantMeta>;
}

/** A client allowed by a person, as the dashboard shows it. */
export interface OAuthGrant {
  id: string;
  client_id: string;
  client_name: string;
  /** Who allowed it: an email, "api-key" or "local". */
  subject: string;
  /** Granted scopes ("polpo", the old all-in-one scope, shows as every scope, and legacy is true). */
  scopes: PolpoScope[];
  legacy: boolean;
  created_at: string;
  last_used_at?: string;
  /** When its last token runs out (a client that stops refreshing loses it then). */
  expires_at: string;
}

/** One grant per client and person: revoking it ends every token that client holds for that person. */
const grantId = (clientId: string, subject: string) => createHash("sha256").update(`${clientId}\n${subject}`).digest("hex").slice(0, 16);

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
      return { clients: state.clients ?? [], tokens: state.tokens ?? [], grants: state.grants ?? {} };
    } catch {
      return { clients: [], tokens: [], grants: {} };
    }
  }

  private write(state: OAuthState): void {
    const now = Math.floor(Date.now() / 1000);
    state.tokens = state.tokens.filter((t) => t.expires_at > now);
    // a grant's dates go with its last token
    const live = new Set(state.tokens.map((t) => grantId(t.client_id, t.subject)));
    state.grants = Object.fromEntries(Object.entries(state.grants ?? {}).filter(([id]) => live.has(id)));
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

  /**
   * The scopes a client asks for (its `scope` parameter), as the consent page offers them: known
   * ones (the umbrella "polpo" is every scope); read and work when it names none we know.
   */
  requestedScopes(scope: string | undefined): PolpoScope[] {
    const asked = normalizeScopes(scope);
    return asked.length ? asked : [...DEFAULT_SCOPES];
  }

  /** The person allowed the client, with these scopes (default: what it asked for): a single-use code for the token endpoint. */
  issueCode(q: Record<string, string | undefined>, resource: string, subject: string, scopes?: readonly string[]): string {
    for (const [k, v] of this.codes) if (v.expires_at < Date.now()) this.codes.delete(k);
    const code = token("polpo_code");
    this.codes.set(code, {
      client_id: q.client_id!,
      redirect_uri: q.redirect_uri!,
      code_challenge: q.code_challenge!,
      scope: (scopes ? normalizeScopes(scopes) : this.requestedScopes(q.scope)).join(" ") || DEFAULT_SCOPES.join(" "),
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
      // a refresh may ask for less, never more (RFC 6749 §6)
      let scope = stored.scope;
      if (form.scope) {
        const held = normalizeScopes(stored.scope);
        const asked = normalizeScopes(form.scope);
        if (asked.length === 0 || asked.some((s) => !held.includes(s))) throw new OAuthError("invalid_scope", "A refresh cannot ask for scopes the grant does not have");
        scope = asked.join(" ");
      }
      // rotation: the old refresh token stops working now
      state.tokens = state.tokens.filter((t) => t !== stored);
      grant = { ...stored, scope };
    } else {
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    const access = token("polpo_at");
    const refresh = token("polpo_rt");
    const base = { client_id: grant.client_id, scope: grant.scope, resource: grant.resource, subject: grant.subject };
    state.tokens.push({ ...base, hash: sha256(access), kind: "access", expires_at: now + ACCESS_TOKEN_TTL_S });
    state.tokens.push({ ...base, hash: sha256(refresh), kind: "refresh", expires_at: now + REFRESH_TOKEN_TTL_S });
    const id = grantId(grant.client_id, grant.subject);
    state.grants = { ...state.grants, [id]: { ...state.grants?.[id], created_at: state.grants?.[id]?.created_at ?? new Date().toISOString() } };
    this.write(state);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: grant.scope };
  }

  /** A valid access token for this resource: who allowed it, or null. */
  verifyAccessToken(accessToken: string | undefined, resource: string): { subject: string; client_id: string; scope: string } | null {
    if (!accessToken) return null;
    const now = Math.floor(Date.now() / 1000);
    const hash = sha256(accessToken);
    const found = this.read().tokens.find((t) => t.kind === "access" && t.hash === hash && t.expires_at > now);
    if (!found || found.resource.replace(/\/+$/, "") !== resource.replace(/\/+$/, "")) return null;
    this.touch(grantId(found.client_id, found.subject));
    return { subject: found.subject, client_id: found.client_id, scope: found.scope };
  }

  private lastTouched = new Map<string, number>();
  /** Note a grant's use, at most once a minute. */
  private touch(id: string): void {
    const now = Date.now();
    if (now - (this.lastTouched.get(id) ?? 0) < LAST_USED_RESOLUTION_MS) return;
    this.lastTouched.set(id, now);
    try {
      const state = this.read();
      state.grants = { ...state.grants, [id]: { created_at: state.grants?.[id]?.created_at ?? new Date(now).toISOString(), last_used_at: new Date(now).toISOString() } };
      this.write(state);
    } catch { /* a missed last-use date is not worth failing a request */ }
  }

  /** The grants that still hold a token: who allowed which client, with which scopes, since when. */
  listGrants(): OAuthGrant[] {
    const state = this.read();
    const now = Math.floor(Date.now() / 1000);
    const byId = new Map<string, StoredToken[]>();
    for (const t of state.tokens) {
      if (t.expires_at <= now) continue;
      const id = grantId(t.client_id, t.subject);
      byId.set(id, [...(byId.get(id) ?? []), t]);
    }
    const grants: OAuthGrant[] = [];
    for (const [id, tokens] of byId) {
      const first = tokens[0]!;
      const raw = tokens.flatMap((t) => t.scope.split(/\s+/).filter(Boolean));
      const meta = state.grants?.[id];
      const latest = Math.max(...tokens.map((t) => t.expires_at));
      // grants from before dates were kept: their oldest token tells when they were made, near enough
      const derived = Math.min(...tokens.map((t) => t.expires_at - (t.kind === "refresh" ? REFRESH_TOKEN_TTL_S : ACCESS_TOKEN_TTL_S)));
      grants.push({
        id,
        client_id: first.client_id,
        client_name: this.clientName(first.client_id),
        subject: first.subject,
        scopes: normalizeScopes(raw),
        legacy: raw.includes(UMBRELLA_SCOPE),
        created_at: meta?.created_at ?? new Date(derived * 1000).toISOString(),
        ...(meta?.last_used_at ? { last_used_at: meta.last_used_at } : {}),
        expires_at: new Date(latest * 1000).toISOString(),
      });
    }
    return grants.sort((a, b) => (b.last_used_at ?? b.created_at).localeCompare(a.last_used_at ?? a.created_at));
  }

  /** Revoke a grant from the dashboard: every token of that client for that person. False when there is none. */
  revokeGrant(id: string): boolean {
    const state = this.read();
    const before = state.tokens.length;
    state.tokens = state.tokens.filter((t) => grantId(t.client_id, t.subject) !== id);
    if (state.tokens.length === before) return false;
    this.write(state);
    return true;
  }

  /** A client's name for people: its registered name, else the host of its metadata URL, else its id. */
  clientName(clientId: string): string {
    const known = this.read().clients.find((c) => c.client_id === clientId);
    if (known?.client_name) return known.client_name;
    if (clientId.startsWith("https://")) {
      try { return new URL(clientId).hostname; } catch { /* not a URL */ }
    }
    return clientId;
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
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
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
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED, "offline_access"],
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The name of the consent form's scope checkboxes. */
export const CONSENT_SCOPE_FIELD = "grant_scope";

/**
 * The scopes the person allowed on the consent page: the boxes they left checked, read always.
 * They may narrow what the client asked for, or add to it.
 */
export function consentScopes(checked: unknown): PolpoScope[] {
  const values = (Array.isArray(checked) ? checked : [checked]).filter((v): v is string => typeof v === "string");
  // the umbrella never comes from the form: only explicit scopes, each one a box the person saw
  return normalizeScopes(["polpo:read", ...values.filter((v) => v !== UMBRELLA_SCOPE)]);
}

/** The consent page: who asks, what it may do (scopes to narrow), where it will go back, and how to allow it. */
export function consentPage(input: {
  client: OAuthClient;
  redirectUri: string;
  params: Record<string, string | undefined>;
  /** The scopes the client asked for: checked; the others are offered unchecked. */
  requested?: readonly PolpoScope[];
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
  const requested = new Set<string>(input.requested ?? DEFAULT_SCOPES);
  const scopeRows = ALL_SCOPES.map((scope) => {
    const info = SCOPES[scope];
    const always = scope === "polpo:read";
    const id = `scope-${scope.replace(":", "-")}`;
    return `<label class="scope${scope === "polpo:admin" ? " admin" : ""}" for="${id}"><input type="checkbox" id="${id}" name="${CONSENT_SCOPE_FIELD}" value="${scope}"`
      + `${always || requested.has(scope) ? " checked" : ""}${always ? " disabled" : ""}>`
      + `<span><b>${esc(info.label)}</b>${always ? ' <span class="muted">(always)</span>' : ""}${!always && !requested.has(scope) ? ' <span class="muted">(not asked for)</span>' : ""}`
      + `<br><span class="muted">${esc(info.description)}</span></span></label>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Polpo</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f6f7;color:#18181b}
@media(prefers-color-scheme:dark){body{background:#0b0b0d;color:#e4e4e7}.card{background:#18181b;border-color:#27272a}input{background:#0b0b0d;color:#e4e4e7;border-color:#3f3f46}}
.card{max-width:420px;width:calc(100% - 32px);background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}.muted{color:#71717a;font-size:13px}.warn{color:#b45309;font-size:13px}.err{color:#dc2626;font-size:13px}
input[type=password]{width:100%;box-sizing:border-box;padding:8px;border:1px solid #d4d4d8;border-radius:8px;margin:8px 0}
fieldset{border:0;padding:0;margin:12px 0}legend{font-weight:600;margin-bottom:4px}.scope{display:flex;gap:8px;align-items:flex-start;padding:6px 0;line-height:1.35}
.scope input{margin-top:3px}.scope.admin{border-top:1px solid #e4e4e7;margin-top:4px;padding-top:10px}
button{padding:8px 16px;border-radius:8px;border:0;background:#18181b;color:#fff;font-weight:600;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#e4e4e7;color:#18181b}}.row{display:flex;gap:8px;margin-top:16px}.secondary{background:transparent;color:inherit;border:1px solid #d4d4d8}</style></head>
<body><form class="card" method="post" action="authorize">${hidden}
<h1>Connect ${esc(input.client.client_name ?? "an app")} to Polpo</h1>
<p>It will be able to use this Polpo instance on your behalf, with what you allow here.</p>
<fieldset><legend>What it may do</legend><input type="hidden" name="${CONSENT_SCOPE_FIELD}" value="polpo:read">${scopeRows}
<p class="muted">Uncheck what it should not do; it can ask again later if it needs more. Admin includes every other box.</p></fieldset>
<p class="muted">You will be sent back to <b>${esc(host)}</b>.</p>
${loopback ? `<p class="warn">This is an app on your computer (a local address). Allow it only if you just started the connection yourself.</p>` : ""}
${input.error ? `<p class="err">${esc(input.error)}</p>` : ""}
${input.method === "session" ? `<p class="muted">Signed in as ${esc(input.email ?? "")}.</p>` : ""}
${input.method === "api-key" ? `<label class="muted">Enter this server's API key or MCP key to allow it${input.loginUrl ? `, or <a href="${esc(input.loginUrl)}">sign in to the dashboard</a> first` : ""}:</label><input type="password" name="api_key" autocomplete="off" required>` : ""}
<div class="row"><button type="submit" name="decision" value="allow">Allow</button><button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></div>
</form></body></html>`;
}
