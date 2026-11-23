/**
 * Catalog OAuth health check: does each catalog entry really connect the way the catalog says?
 * Run server side (scripts/check-connector-catalog.mjs runs it over the whole catalog). It never
 * completes a sign-in and stores nothing; the only write is the dynamic client registration of an
 * "oauth" entry, which it deletes again when the provider supports RFC 7592.
 *
 *   - auth "none": `initialize` succeeds without credentials;
 *   - auth "bearer": the server is reachable and refuses an anonymous `initialize` (401 / 403);
 *   - auth "oauth": RFC 9728 + RFC 8414 / OpenID discovery, then Polpo's real sign-in start (the MCP
 *     SDK's `auth()` with Polpo's OAuth provider, so the registration request and the authorization
 *     URL are exactly the ones a connector sends) against a throwaway redirect URI; the
 *     authorization URL is then fetched without cookies (at most two redirects followed) and the
 *     answer classified: a login page, or an error (invalid_client, redirect_uri mismatch, bad
 *     scope…). A Client ID Metadata Document can't be tested without a public document, so a
 *     CIMD-only entry is "unverified";
 *   - auth "oauth_preregistered": the authorization server's metadata is reachable and has an
 *     authorization endpoint (no client of our own to try).
 */
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ConnectorCatalogEntry, ConnectorConfig } from "@polpo-ai/core";
import { guardedFetcher, type SafeFetcher } from "./icons.js";
import { OAuthHttpError } from "./oauth-errors.js";
import { VaultOAuthProvider } from "./oauth-provider.js";
import { clientMetadataUrlFor } from "./paths.js";
import { authServerMetadata, probeConnector, type ProbeResult } from "./probe.js";
import type { ConnectorSecrets } from "./secrets.js";

/** A redirect URI no browser will ever reach (.invalid never resolves). */
export const CHECK_REDIRECT_URI = "https://example.invalid/api/v1/connectors/oauth/callback";

export type CheckVerdict = "ok" | "fail" | "warn" | "unverified" | "skipped";
export type AuthorizeOutcome = "login" | "error" | "unverified";

export interface CatalogCheckResult {
  id: string;
  name: string;
  auth: ConnectorCatalogEntry["auth"];
  registration?: string | null;
  url?: string;
  verdict: CheckVerdict;
  /** The server answered at all. */
  reachable: boolean | null;
  /** What the server itself advertises (none / bearer / oauth-dcr / oauth-cimd / oauth-preregistered). */
  serverAuth?: string;
  /** Dynamic client registration: null when not tried. */
  registrationOk: boolean | null;
  registrationError?: string;
  /** The test registration was deleted again (RFC 7592), could not be, or the provider offers no delete. */
  cleanup?: "deleted" | "failed" | "unsupported";
  authorize: AuthorizeOutcome | null;
  authorizeDetail?: string;
  /** Why it failed (one line). */
  error?: string;
  notes: string[];
  ms: number;
}

export interface CatalogCheckOptions {
  /** HTTP client for the OAuth steps (default: the global fetch). */
  fetch?: typeof fetch;
  /** Guarded client for the MCP probe (default: guardedFetcher()). */
  fetcher?: SafeFetcher;
  /** Redirect URI registered and sent (default CHECK_REDIRECT_URI). */
  redirectUri?: string;
  /** Per request (default 15 s). */
  requestTimeoutMs?: number;
  /** Per entry (default 60 s). */
  timeoutMs?: number;
  /** Register a client with DCR servers (default true). */
  register?: boolean;
}

// ── the authorization page ──

export interface AuthorizeResponse {
  /** The URL that was fetched. */
  url: string;
  status: number;
  location?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface AuthorizeClassification {
  kind: AuthorizeOutcome | "follow";
  detail: string;
  /** kind "follow": where to go next. */
  next?: string;
}

const OAUTH_ERROR_CODES = /\b(invalid_client|invalid_request|invalid_scope|unauthorized_client|unsupported_response_type|access_denied|invalid_redirect_uri|redirect_uri_mismatch|invalid_target|server_error|temporarily_unavailable)\b/i;
const ERROR_TEXT = [
  OAUTH_ERROR_CODES,
  /redirect[_ ]?ur[il].{0,80}?\b(mismatch|invalid|not (?:be )?(?:allowed|registered|valid|whitelisted|permitted|match\w*)|does not match|isn'?t (?:allowed|valid|registered))/i,
  /\b(?:unknown|invalid|unregistered) (?:client|application|app)\b/i,
  /\bclient(?:_id| id)?\b.{0,40}?\b(?:not found|is invalid|does not exist|unknown|not registered|is not valid)/i,
  /\b(?:invalid|unsupported|unknown) scopes?\b/i,
  /\bscopes?\b.{0,40}?\b(?:is|are) (?:invalid|not (?:valid|allowed|supported))/i,
];
const LOGIN_TEXT = /type\s*=\s*["']?password|\b(?:sign[\s-]?in|log[\s-]?in|login|sign[\s-]?up|continue with|authori[sz]e|consent|e-?mail|username|password)\b/i;
/** Bot walls: a 403 / 503 with these in the page, or a page titled like one. */
const BOT_WALL = /just a moment|challenge-platform|attention required|cf-chl|are you a robot|perimeterx|px-captcha|captcha-delivery|datadome/i;
const BOT_TITLE = /just a moment|attention required|access denied|security check|are you a robot/i;
/** Paths of sign-in pages (a client-side page there is still the login). */
export const LOGIN_PATH = /\/(?:log[-_]?in|sign[-_]?in|signin|sign[-_]?up|signup|users\/sign_in|session\/new|u\/login|auth\/login|identifier)\b/i;

/** Visible text of an HTML page (no scripts, styles or tags), whitespace collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? visibleText(m[1]!).slice(0, 120) || undefined : undefined;
}

function oauthErrorFrom(params: URLSearchParams): string | undefined {
  const error = params.get("error");
  if (!error) return undefined;
  const description = params.get("error_description");
  return description ? `${error}: ${description}` : error;
}

function snippet(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) return text.slice(0, 160);
  const start = Math.max(0, m.index - 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, m.index + m[0].length + 100).trim()}…`;
}

/** What one response of the authorization endpoint says (see the module comment). */
export function classifyAuthorizeResponse(res: AuthorizeResponse, redirectUri: string = CHECK_REDIRECT_URI): AuthorizeClassification {
  const headers = res.headers ?? {};
  const contentType = (res.contentType ?? headers["content-type"] ?? "").toLowerCase();
  const body = res.body ?? "";
  if (res.status >= 300 && res.status < 400) {
    if (!res.location) return { kind: "unverified", detail: `HTTP ${res.status} without a Location` };
    let loc: URL;
    try { loc = new URL(res.location, res.url); } catch { return { kind: "unverified", detail: `HTTP ${res.status} to an invalid Location` }; }
    const back = new URL(redirectUri);
    const params = new URLSearchParams([...loc.searchParams, ...new URLSearchParams(loc.hash.replace(/^#/, ""))]);
    if (loc.origin === back.origin && loc.pathname === back.pathname) {
      const error = oauthErrorFrom(params);
      if (error) return { kind: "error", detail: `redirected back with ${error}` };
      if (params.get("code")) return { kind: "login", detail: "redirected back with a code (no sign-in needed?)" };
      return { kind: "unverified", detail: "redirected back without code or error" };
    }
    const error = oauthErrorFrom(params);
    if (error) return { kind: "error", detail: `redirected to ${loc.host} with ${error}` };
    const path = loc.pathname.toLowerCase();
    if (/\/(error|oops|unavailable)\b/.test(path)) return { kind: "error", detail: `redirected to an error page (${loc.host}${loc.pathname})` };
    return { kind: "follow", detail: `redirect to ${loc.host}${loc.pathname}`, next: loc.toString() };
  }
  if (res.status === 429) return { kind: "unverified", detail: "rate limited (HTTP 429)" };
  const pageTitle = /^\s*</.test(body) ? titleOf(body) : undefined;
  if (headers["cf-mitigated"] || (pageTitle && BOT_TITLE.test(pageTitle)) || ((res.status === 403 || res.status === 503) && BOT_WALL.test(body))) {
    return { kind: "unverified", detail: `bot protection (HTTP ${res.status})` };
  }
  if (/json/.test(contentType) || /^\s*[{[]/.test(body)) {
    let data: unknown;
    try { data = JSON.parse(body); } catch { /* not JSON after all */ }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      const error = typeof d.error === "string" ? d.error : typeof (d.error as { message?: unknown })?.message === "string" ? String((d.error as { message: string }).message) : undefined;
      if (error) {
        const description = typeof d.error_description === "string" ? d.error_description : typeof d.message === "string" ? d.message : undefined;
        return { kind: "error", detail: `HTTP ${res.status} ${description ? `${error}: ${description}` : error}`.slice(0, 300) };
      }
      // a bare 401 is "sign in first" (an API-style authorization endpoint), not a rejected request
      if (res.status === 401) return { kind: "unverified", detail: `HTTP 401 without an OAuth error (needs a session): ${body.replace(/\s+/g, " ").slice(0, 120)}` };
      if (res.status >= 400) return { kind: "error", detail: `HTTP ${res.status} ${body.replace(/\s+/g, " ").slice(0, 200)}` };
      return { kind: "unverified", detail: `HTTP ${res.status} JSON without an error` };
    }
  }
  // consent pages echo the redirect URI (https://example.invalid/…): keep its words out of the error search
  const host = (() => { try { return new URL(redirectUri).host; } catch { return ""; } })();
  const neutral = (t: string) => (host ? t.split(redirectUri).join("[redirect URI]").split(host).join("[redirect host]") : t);
  const text = neutral(/html/.test(contentType) || /^\s*</.test(body) ? visibleText(body) : body.replace(/\s+/g, " ").trim());
  const title = /html/.test(contentType) || /^\s*</.test(body) ? titleOf(body) : undefined;
  const errorRe = ERROR_TEXT.find((re) => re.test(text) || (title !== undefined && re.test(title)));
  if (errorRe) return { kind: "error", detail: `HTTP ${res.status} page: ${snippet(text, errorRe)}`.slice(0, 300) };
  if (res.status >= 500) return { kind: "error", detail: `HTTP ${res.status}${title ? ` (${title})` : ""}` };
  if (res.status >= 400) {
    if (title && /error|not found|invalid|denied|forbidden/i.test(title)) return { kind: "error", detail: `HTTP ${res.status} (${title})` };
    if (LOGIN_TEXT.test(text) || LOGIN_TEXT.test(body)) return { kind: "login", detail: `HTTP ${res.status} login page${title ? ` (${title})` : ""}` };
    if (res.status === 401) return { kind: "unverified", detail: `HTTP 401 without an OAuth error (needs a session)${text ? `: ${text.slice(0, 120)}` : ""}` };
    return { kind: "error", detail: `HTTP ${res.status}${title ? ` (${title})` : text ? `: ${text.slice(0, 160)}` : ""}` };
  }
  if (title && /^(error|oops)\b|\berror\b/i.test(title)) return { kind: "error", detail: `HTTP ${res.status} (${title})` };
  if (LOGIN_TEXT.test(text) || (title && LOGIN_TEXT.test(title))) return { kind: "login", detail: `login page${title ? ` (${title})` : ""}` };
  if (LOGIN_TEXT.test(body)) return { kind: "login", detail: `page rendered client-side${title ? ` (${title})` : ""}, sign-in markup found` };
  return { kind: "unverified", detail: `HTTP ${res.status} page${title ? ` (${title})` : ""}: nothing recognisable (rendered client-side?)` };
}

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Polpo-catalog-check";
const PAGE_MAX = 256 * 1024;

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= max) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** GET the authorization URL (no cookies, at most `maxHops` redirects followed) and classify the answer. */
export async function checkAuthorizationUrl(url: string, options: { fetch: typeof fetch; redirectUri: string; maxHops?: number }): Promise<AuthorizeClassification> {
  let current = url;
  const hops: string[] = [];
  // cookies set during this one walk only (login pages keep their transaction in a cookie); no session
  const jar = new Map<string, Map<string, string>>();
  for (let hop = 0; ; hop++) {
    const host = new URL(current).host;
    const cookies = jar.get(host);
    const res = await options.fetch(current, {
      redirect: "manual",
      headers: {
        // a browser's Accept: some endpoints (Gong) answer a JSON-accepting client with a bare 401
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en", "user-agent": BROWSER_UA,
        ...(cookies?.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      },
    });
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq <= 0) continue;
      const domain = /;\s*domain=\.?([^;]+)/i.exec(line)?.[1]?.toLowerCase();
      const targets = domain ? [...new Set([host, ...[...jar.keys()].filter((h) => h === domain || h.endsWith(`.${domain}`))])] : [host];
      for (const target of targets) {
        if (!jar.has(target)) jar.set(target, new Map());
        jar.get(target)!.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
      }
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const isRedirect = res.status >= 300 && res.status < 400;
    const body = isRedirect ? "" : await readCapped(res, PAGE_MAX);
    if (isRedirect) void res.body?.cancel().catch(() => undefined);
    const verdict = classifyAuthorizeResponse({
      url: current, status: res.status, ...(headers.location ? { location: headers.location } : {}),
      contentType: headers["content-type"] ?? "", body, headers,
    }, options.redirectUri);
    if (verdict.kind !== "follow") {
      // a page rendered client-side at a sign-in path is the login
      const final = verdict.kind === "unverified" && !/bot protection|rate limited/.test(verdict.detail) && LOGIN_PATH.test(new URL(current).pathname)
        ? { kind: "login" as const, detail: `sign-in page at ${new URL(current).host}${new URL(current).pathname}` }
        : verdict;
      return hops.length ? { ...final, detail: `${final.detail} (after ${hops.join(" → ")})` } : final;
    }
    hops.push(verdict.detail.replace(/^redirect to /, ""));
    if (hop >= (options.maxHops ?? 2)) return { kind: "login", detail: `redirects to ${hops.join(" → ")} (sign-in flow)` };
    current = verdict.next!;
  }
}

// ── one entry ──

/** In-memory stand-in for the vault: the check stores nothing. */
function memorySecrets(): ConnectorSecrets {
  const store: Record<string, string> = {};
  return {
    available: true,
    get: async () => ({ ...store }),
    patch: async (_id: string, values: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(values)) { if (v === undefined) delete store[k]; else store[k] = v; }
    },
    unset: async (_id: string, keys: string[]) => { for (const k of keys) delete store[k]; },
    remove: async () => { for (const k of Object.keys(store)) delete store[k]; },
    keys: async () => Object.keys(store),
  } as unknown as ConnectorSecrets;
}

function withTimeout(base: typeof fetch, ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

const errorText = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  // undici's "fetch failed" hides the reason in `cause`
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${message}${cause}`.replace(/\s+/g, " ").trim();
};

function serverAuthOf(probe: ProbeResult): string | undefined {
  if (!probe.reachable || !probe.transport) return undefined;
  if (!probe.authRequired) return "none";
  const as = probe.authorizationServer;
  if (!as && !probe.resource?.authorizationServers?.length) return "bearer";
  const kinds = [as?.registration ? "dcr" : "", as?.cimd ? "cimd" : ""].filter(Boolean);
  return kinds.length ? `oauth-${kinds.join("+")}` : "oauth-preregistered";
}

interface Registration { clientId?: string; registrationClientUri?: string; registrationAccessToken?: string }

/** Check one catalog entry. Never throws. */
export async function probeCatalogEntry(entry: ConnectorCatalogEntry, options: CatalogCheckOptions = {}): Promise<CatalogCheckResult> {
  const started = Date.now();
  const result: CatalogCheckResult = {
    id: entry.id, name: entry.name, auth: entry.auth, registration: entry.oauthRegistration ?? null,
    ...(entry.url ? { url: entry.url } : {}),
    verdict: "ok", reachable: null, registrationOk: null, authorize: null, notes: [], ms: 0,
  };
  const timeoutMs = options.timeoutMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const cleanups: Array<() => Promise<void>> = [];
  try {
    await Promise.race([
      checkEntry(entry, options, result, cleanups),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); timer.unref?.(); }),
    ]);
  } catch (err) {
    result.verdict = "fail";
    result.error = errorText(err);
  } finally {
    clearTimeout(timer);
    // delete the test registration even when the check failed or timed out
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  }
  result.ms = Date.now() - started;
  return result;
}

async function checkEntry(entry: ConnectorCatalogEntry, options: CatalogCheckOptions, result: CatalogCheckResult, cleanups: Array<() => Promise<void>>): Promise<void> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const baseFetch = withTimeout(options.fetch ?? globalThis.fetch, requestTimeoutMs);
  const fetcher = options.fetcher ?? guardedFetcher({ timeoutMs: requestTimeoutMs });
  const redirectUri = options.redirectUri ?? CHECK_REDIRECT_URI;
  const fail = (error: string) => { result.verdict = "fail"; result.error = error; };

  if (!entry.url) {
    result.verdict = "skipped";
    result.error = `per-account URL (${entry.urlTemplate ?? "template"})`;
    // the authorization server is fixed for some templated entries: still check it
    if (entry.auth === "oauth_preregistered" && entry.oauth?.authorizationServer) {
      const as = await authServerMetadata(fetcher, entry.oauth.authorizationServer);
      result.notes.push(as && typeof as.data.authorization_endpoint === "string"
        ? `authorization server ${entry.oauth.authorizationServer} ok`
        : `authorization server ${entry.oauth.authorizationServer}: no metadata`);
    }
    return;
  }

  const probe = await probeConnector(entry.url, { fetch: fetcher, icon: false, canUseCimd: false });
  result.reachable = probe.reachable && !!probe.transport;
  const serverAuth = serverAuthOf(probe);
  if (serverAuth) result.serverAuth = serverAuth;
  if (!result.reachable) return fail(probe.error ?? "unreachable");
  if (probe.transport && probe.transport !== entry.transport) result.notes.push(`server transport is ${probe.transport}, catalog says ${entry.transport}`);

  if (entry.auth === "none") {
    if (probe.authRequired) fail(`the server requires authorization (${serverAuth})`);
    return;
  }
  if (entry.auth === "bearer") {
    if (!probe.authRequired) {
      result.verdict = "warn";
      result.error = "initialize succeeds without a token";
    } else if (serverAuth?.startsWith("oauth") && serverAuth !== "oauth-preregistered") {
      result.notes.push(`the server also offers OAuth (${serverAuth})`);
    }
    return;
  }

  if (!probe.authRequired && entry.auth === "oauth") {
    result.verdict = "warn";
    result.error = "initialize succeeds without authorization";
    return;
  }

  if (entry.auth === "oauth_preregistered") {
    // some servers (Google's) answer initialize anonymously and check the token per call
    if (!probe.authRequired) result.notes.push("initialize answers without authorization (the token is checked per call)");
    const issuer = entry.oauth?.authorizationServer ?? probe.resource?.authorizationServers?.[0] ?? new URL(entry.url).origin;
    const as = await authServerMetadata(fetcher, issuer);
    if (!as) return fail(`no authorization server metadata at ${issuer}`);
    if (typeof as.data.authorization_endpoint !== "string") return fail(`${as.url} has no authorization_endpoint`);
    result.authorizeDetail = `authorization endpoint ${as.data.authorization_endpoint}`;
    if (probe.authorizationServer?.registration) result.notes.push("the server advertises dynamic client registration: check whether it accepts Polpo");
    return;
  }

  // auth "oauth": Polpo's real sign-in start
  const as = probe.authorizationServer;
  if (!as) return fail("no authorization server metadata (RFC 8414 / OpenID)");
  // CIMD when the server offers nothing else, or when the catalog says CIMD is the way (Vercel refuses registrations)
  const cimdOnly = as.cimd && (!as.registration || entry.oauthRegistration === "cimd");
  if (!as.registration && !as.cimd) return fail("the authorization server offers neither dynamic registration nor a client metadata document (needs a pre-registered OAuth app)");
  if (as.cimd && entry.oauthRegistration === "dcr") result.notes.push("the server also accepts a client metadata document (Polpo uses it when its public URL is https)");
  if (!as.cimd && (entry.oauthRegistration === "cimd" || entry.oauthRegistration === "dcr+cimd")) result.notes.push("catalog says CIMD but the server does not advertise it");
  if (as.registration && entry.oauthRegistration === "cimd") result.notes.push("catalog says CIMD only but the server also offers dynamic registration");
  if (!cimdOnly && options.register === false) {
    result.verdict = "unverified";
    result.authorize = "unverified";
    result.authorizeDetail = "registration skipped (--no-register)";
    return;
  }

  const registration: Registration = {};
  const capture: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    if (init?.method === "POST" && typeof init.body === "string" && /"redirect_uris"/.test(init.body) && response.ok) {
      try {
        const data = await response.clone().json() as Record<string, unknown>;
        if (typeof data.client_id === "string") registration.clientId = data.client_id;
        if (typeof data.registration_client_uri === "string") registration.registrationClientUri = data.registration_client_uri;
        if (typeof data.registration_access_token === "string") registration.registrationAccessToken = data.registration_access_token;
      } catch { /* the SDK reports a bad body */ }
      cleanups.push(async () => {
        if (!registration.clientId) return;
        if (!registration.registrationClientUri || !registration.registrationAccessToken) { result.cleanup = "unsupported"; return; }
        try {
          const del = await baseFetch(registration.registrationClientUri, { method: "DELETE", headers: { authorization: `Bearer ${registration.registrationAccessToken}` } });
          void del.body?.cancel().catch(() => undefined);
          result.cleanup = del.ok ? "deleted" : "failed";
          if (!del.ok) result.notes.push(`deleting the test registration: HTTP ${del.status}`);
        } catch (err) {
          result.cleanup = "failed";
          result.notes.push(`deleting the test registration: ${errorText(err)}`);
        }
      });
    }
    return response;
  };

  const connector: ConnectorConfig = {
    id: entry.id, name: entry.name, kind: "mcp",
    transport: { type: entry.transport, url: entry.url },
    auth: { type: "oauth", ...(entry.oauth ? { oauth: { ...entry.oauth } } : {}) },
    access: { agents: [], polpo: false }, enabled: true, createdAt: new Date().toISOString(), status: "needs_auth",
  };
  const metadataUrl = cimdOnly ? clientMetadataUrlFor(redirectUri) : undefined;
  const provider = await new VaultOAuthProvider(connector, memorySecrets(), {
    interactive: true, redirectUrl: redirectUri, fetch: capture,
    ...(metadataUrl ? { clientMetadataUrl: metadataUrl } : {}),
  }).init();
  const scopes = entry.oauth?.scopes;
  try {
    await auth(provider, { serverUrl: entry.url, fetchFn: provider.fetch, ...(scopes?.length ? { scope: scopes.join(" ") } : {}) });
  } catch (err) {
    const failure = err instanceof OAuthHttpError ? err : provider.takeDiscoveryError() ?? err;
    if (!cimdOnly && !registration.clientId && (failure instanceof OAuthHttpError ? failure.step === "registration" : /registration/i.test(errorText(failure)))) {
      result.registrationOk = false;
      // "<name> did not accept the OAuth client registration (invalid_client_metadata: …)." → what is in the brackets
      const message = errorText(failure);
      result.registrationError = /\(([\s\S]*)\)\.?$/.exec(message)?.[1] ?? message;
      return fail(`registration refused: ${result.registrationError}`);
    }
    return fail(errorText(failure));
  }
  if (!cimdOnly) result.registrationOk = !!registration.clientId;
  if (!provider.authorizationUrl) return fail("no authorization URL was built");
  if (cimdOnly) {
    result.verdict = "unverified";
    result.authorize = "unverified";
    result.authorizeDetail = `CIMD${as.registration ? " (as the catalog says)" : " only"}: needs a public client metadata document to test`;
    return;
  }
  let page: AuthorizeClassification;
  try {
    page = await checkAuthorizationUrl(provider.authorizationUrl.toString(), { fetch: baseFetch, redirectUri });
  } catch (err) {
    result.authorize = "unverified";
    result.authorizeDetail = `could not load the authorization page: ${errorText(err)}`;
    result.verdict = "unverified";
    return;
  }
  result.authorize = page.kind === "follow" ? "login" : page.kind;
  result.authorizeDetail = page.detail;
  if (page.kind === "error") fail(`authorization page: ${page.detail}`);
  else if (page.kind === "unverified") result.verdict = "unverified";
}

/** Check many entries, `concurrency` at a time (default 4). */
export async function checkCatalog(
  entries: ConnectorCatalogEntry[],
  options: CatalogCheckOptions & { concurrency?: number; onResult?: (result: CatalogCheckResult) => void } = {},
): Promise<CatalogCheckResult[]> {
  const results: CatalogCheckResult[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await probeCatalogEntry(entries[index]!, options);
      options.onResult?.(results[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, entries.length)) }, worker));
  return results;
}
