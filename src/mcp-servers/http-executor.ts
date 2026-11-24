/**
 * Declarative HTTP tools, executed in Polpo (no sandbox).
 *
 * - the URL must be https (http only for a localhost the server lists explicitly) and its host one of
 *   the server's allowedDomains; its addresses must be public (no loopback / private / metadata);
 * - secrets are read from the vault for this call only, and only after the destination passed;
 *   redirects are never followed (a redirect could carry the credential elsewhere);
 * - timeout, response size cap, retries on 429 / 5xx (idempotent methods, or when the tool says so),
 *   Retry-After honored (capped);
 * - the request is returned masked (secret values replaced) for the Test section and the logs.
 */
import { authorizeDestination, type Resolver } from "../sandbox/net-proxy.js";
import { mapResponse, renderBody, renderString, renderUrl, truncateText, TemplateError, placeholdersOf } from "./template.js";
import { limitsOf, type MaskedRequest, type McpServerSpec, type McpServerTool, type McpToolCallResult } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpExecOptions {
  /** A secret's value by the server's secret name (undefined: not set). */
  secret: (name: string) => Promise<string | undefined>;
  fetch?: FetchLike;
  resolve?: Resolver;
  signal?: AbortSignal;
  /** Tests: no waiting between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Do not send: return the request that would go out (destructive tools in the Test section). */
  dryRun?: boolean;
}

export class HttpToolError extends Error {}

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const MAX_RETRY_AFTER_MS = 10_000;
const MASK = "••••";

/** Secret names a tool needs: auth plus `{{secrets.X}}` in the server's and tool's headers and query. */
export function secretsNeeded(spec: McpServerSpec, tool: McpServerTool): string[] {
  const names = new Set<string>();
  const auth = spec.auth;
  if (auth.type === "bearer" || auth.type === "header" || auth.type === "query") names.add(auth.secret);
  if (auth.type === "basic") { names.add(auth.usernameSecret); names.add(auth.passwordSecret); }
  if (auth.type === "oauth2_client_credentials") { names.add(auth.clientIdSecret); names.add(auth.clientSecretSecret); }
  for (const p of placeholdersOf([spec.headers ?? {}, tool.http?.headers ?? {}, tool.http?.query ?? {}])) {
    if (p.startsWith("secrets.")) names.add(p.slice("secrets.".length));
  }
  return [...names];
}

function joinUrl(base: string | undefined, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!base) throw new HttpToolError(`The tool URL "${path}" is relative and the server has no baseUrl`);
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Check that a URL may be called: scheme and host against the allowlist, public addresses. */
export async function checkDestination(url: URL, allowedDomains: string[], resolve?: Resolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localExplicit = (host === "localhost" || host === "127.0.0.1") && allowedDomains.some((d) => d.toLowerCase().split(":")[0] === host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localExplicit)) throw new HttpToolError(`Only https URLs may be called (${url.protocol}//${host})`);
  if (url.username || url.password) throw new HttpToolError("Credentials in the URL are not allowed: use the server's auth");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const auth = await authorizeDestination({ mode: "allowlist", allow: allowedDomains }, host, port, resolve);
  if (!auth.ok) {
    if ("reason" in auth && auth.reason === "not-allowed") throw new HttpToolError(`${host} is not one of this server's allowed domains (${allowedDomains.join(", ") || "none"})`);
    if ("reason" in auth) throw new HttpToolError(`${host} resolves to a private or local address, which hosted servers never call`);
    throw new HttpToolError(`Cannot resolve ${host}`);
  }
}

/** Replace every secret value in a text. */
export function masker(values: string[]): (s: string) => string {
  const secrets = values.filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length);
  return (s: string) => {
    let out = s;
    for (const v of secrets) {
      out = out.split(v).join(MASK);
      const enc = encodeURIComponent(v);
      if (enc !== v) out = out.split(enc).join(MASK);
      const b64 = Buffer.from(v).toString("base64");
      if (b64.length >= 6) out = out.split(b64).join(MASK);
    }
    return out;
  };
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text().catch(() => ""), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8"), truncated };
}

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000));
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
  }
  return Math.min(MAX_RETRY_AFTER_MS, 500 * 2 ** attempt);
}

function statusMatches(rule: number | "4xx" | "5xx" | undefined, status: number): boolean {
  if (rule === undefined) return true;
  if (rule === "4xx") return status >= 400 && status < 500;
  if (rule === "5xx") return status >= 500;
  return rule === status;
}

/** Short error detail from a JSON error body (message / error / error.message / detail). */
function errorDetail(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, any>;
    const pick = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : undefined) ?? j?.detail ?? j?.result;
    if (typeof pick === "string" && pick.trim()) return pick.trim().slice(0, 300);
  } catch { /* not JSON */ }
  return text.trim().slice(0, 300);
}

const oauthTokens = new Map<string, { token: string; expiresAt: number }>();

async function clientCredentialsToken(spec: McpServerSpec, auth: Extract<McpServerSpec["auth"], { type: "oauth2_client_credentials" }>,
  opts: HttpExecOptions, fetchImpl: FetchLike): Promise<string> {
  const id = await opts.secret(auth.clientIdSecret);
  const secret = await opts.secret(auth.clientSecretSecret);
  if (!id || !secret) throw new HttpToolError(`The secrets ${auth.clientIdSecret} / ${auth.clientSecretSecret} are not set in the vault`);
  const cacheKey = `${auth.tokenUrl}\0${id}`;
  const cached = oauthTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const url = new URL(auth.tokenUrl);
  await checkDestination(url, spec.allowedDomains, opts.resolve);
  const body = new URLSearchParams({ grant_type: "client_credentials", ...(auth.scopes?.length ? { scope: auth.scopes.join(" ") } : {}) });
  const res = await fetchImpl(url.toString(), {
    method: "POST", body, redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpToolError(`The token endpoint answered ${res.status}: ${masker([id, secret])(errorDetail(text))}`);
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new HttpToolError("The token endpoint returned no access_token");
  oauthTokens.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

/** Run one HTTP tool. Never throws for expected failures: they come back as ok: false with a message. */
export async function executeHttpTool(spec: McpServerSpec, tool: McpServerTool, input: Record<string, unknown>, opts: HttpExecOptions): Promise<McpToolCallResult> {
  const started = Date.now();
  const http = tool.http;
  const limits = limitsOf(spec);
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = (error: string, extra: Partial<McpToolCallResult> = {}): McpToolCallResult => ({ ok: false, text: error, error, ms: Date.now() - started, ...extra });
  if (!http) return fail(`${tool.name} is not an HTTP tool`);

  let url: URL;
  try {
    url = new URL(joinUrl(spec.baseUrl, renderUrl(http.url, { input })));
    await checkDestination(url, spec.allowedDomains, opts.resolve);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // secrets: only now, for an allowed destination, and only the ones this call uses
  const secretValues: Record<string, string> = {};
  for (const name of secretsNeeded(spec, tool)) {
    const value = await opts.secret(name).catch(() => undefined);
    if (value === undefined || value === "") {
      const ref = spec.secrets[name];
      return fail(`The secret "${name}" is not set${ref ? ` (vault entry ${ref.owner}/${ref.service}, field ${ref.key})` : ""}: add it in the vault first`);
    }
    secretValues[name] = value;
  }
  const mask = masker(Object.values(secretValues));

  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  try {
    for (const [name, template] of Object.entries({ ...(spec.headers ?? {}), ...(http.headers ?? {}) })) {
      const v = renderString(template, { input, secrets: secretValues });
      if (v !== undefined && v !== "") headers[name.toLowerCase()] = v;
    }
    for (const [name, template] of Object.entries(http.query ?? {})) {
      const v = renderString(template, { input, secrets: secretValues });
      if (v !== undefined && v !== "") url.searchParams.set(name, v);
    }
    const auth = spec.auth;
    if (auth.type === "bearer") headers.authorization = `Bearer ${secretValues[auth.secret]}`;
    else if (auth.type === "header") headers[auth.header.toLowerCase()] = `${auth.prefix ?? ""}${secretValues[auth.secret]}`;
    else if (auth.type === "query") url.searchParams.set(auth.param, secretValues[auth.secret]!);
    else if (auth.type === "basic") headers.authorization = `Basic ${Buffer.from(`${secretValues[auth.usernameSecret]}:${secretValues[auth.passwordSecret]}`).toString("base64")}`;
    else if (auth.type === "oauth2_client_credentials" && !opts.dryRun) {
      const token = await clientCredentialsToken(spec, auth, { ...opts, secret: async (n) => secretValues[n] }, fetchImpl);
      secretValues.__oauth_token = token;
      headers.authorization = `Bearer ${token}`;
    }
    if (http.body !== undefined && http.method !== "GET") {
      const rendered = renderBody(http.body, { input });
      if (http.bodyType === "form") {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries((rendered ?? {}) as Record<string, unknown>)) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        body = form.toString();
        headers["content-type"] = "application/x-www-form-urlencoded";
      } else {
        body = JSON.stringify(rendered ?? {});
        headers["content-type"] = "application/json";
      }
    }
  } catch (err) {
    return fail(err instanceof TemplateError || err instanceof HttpToolError ? err.message : `Could not build the request: ${err instanceof Error ? err.message : String(err)}`);
  }
  const maskAll = masker(Object.values(secretValues));
  const request: MaskedRequest = {
    method: http.method,
    url: maskAll(url.toString()),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, k === "authorization" || k.includes("key") || k.includes("token") ? MASK : maskAll(v)])),
    ...(body !== undefined ? { body: maskAll(body).slice(0, 20_000) } : {}),
  };
  if (opts.dryRun) return { ok: true, text: "Not sent (dry run): this is the request that would go out.", ms: Date.now() - started, request };

  const retries = http.retries ?? (IDEMPOTENT.has(http.method) ? limits.retries : 0);
  let attempt = 0;
  for (;;) {
    let res: Response;
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    try {
      res = await fetchImpl(url.toString(), { method: http.method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal });
    } catch (err) {
      if (opts.signal?.aborted) return fail("Cancelled", { request, attempts: attempt + 1 });
      const timedOut = timeout.aborted || (err as Error)?.name === "TimeoutError";
      if (!timedOut && attempt < retries) { await sleep(500 * 2 ** attempt); attempt++; continue; }
      return fail(timedOut ? `Timed out after ${limits.timeoutMs} ms` : `Request failed: ${mask((err as Error)?.message ?? String(err))}`, { request, attempts: attempt + 1 });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = retryAfterMs(res, attempt);
      await res.body?.cancel().catch(() => undefined);
      await sleep(wait);
      attempt++;
      continue;
    }
    const { text: raw, truncated } = await readCapped(res, limits.maxResponseBytes);
    const responseText = maskAll(raw);
    if (res.status >= 300 && res.status < 400) {
      return fail(`The service redirected (${res.status}) to ${res.headers.get("location") ?? "another URL"}; redirects are not followed`, { status: res.status, request, response: responseText.slice(0, 4000), attempts: attempt + 1 });
    }
    if (!res.ok) {
      const rule = (http.errors ?? []).find((r) => statusMatches(r.status, res.status) && (!r.match || raw.includes(r.match)));
      const detail = maskAll(errorDetail(raw));
      const message = rule ? `${rule.message}${detail ? ` (${res.status}: ${detail})` : ` (${res.status})`}` : `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
      return fail(message, { status: res.status, request, response: responseText.slice(0, 4000), attempts: attempt + 1 });
    }
    let parsed: unknown = responseText;
    if (!truncated) { try { parsed = JSON.parse(responseText); } catch { /* text */ } }
    let mapped: unknown;
    try {
      mapped = typeof parsed === "string" ? parsed : mapResponse(parsed, http.response);
    } catch (err) {
      return fail(`The response mapping failed: ${(err as Error).message}`, { status: res.status, request, response: responseText.slice(0, 4000) });
    }
    const max = http.response?.maxChars ?? limits.maxResultChars;
    const text = truncateText(typeof mapped === "string" ? mapped : JSON.stringify(mapped ?? null, null, 2), max)
      + (truncated ? `\n\n[the response was larger than ${limits.maxResponseBytes} bytes and was cut]` : "");
    const structured = mapped !== null && typeof mapped === "object" && !Array.isArray(mapped) ? mapped : mapped === undefined ? undefined : { result: mapped };
    return {
      ok: true, text, ...(structured !== undefined && typeof parsed !== "string" ? { structured } : {}),
      status: res.status, ms: Date.now() - started, request, response: responseText.slice(0, 20_000), attempts: attempt + 1,
    };
  }
}
