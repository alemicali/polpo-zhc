/**
 * Polpo's model relay: credential brokering for agent harnesses whose computer provider has no
 * native egress transformer (Daytona v0/v2, E2B, …).
 *
 * The AI SDK harness puts a random placeholder in the VM instead of the model key and registers
 * request transformations on the sandbox session ("requests to host H whose x-api-key is the
 * placeholder get x-api-key: <real key>"). Polpo applies them here, outside the VM:
 *
 *   VM ──https──▶ <POLPO_PUBLIC_URL>/api/v1/harness-relay/<token>/v1/messages      (Funnel / proxy)
 *      ──▶ Polpo server (route below; dumb pipe, never sees a key)
 *      ──unix socket──▶ the run's lease (the runner process that holds the key)
 *      ──https──▶ <upstream>/v1/messages  (rules applied: placeholder swapped, gateway headers added)
 *
 * - One lease per harness run: a random 256-bit token in the relay URL (the VM's base URL), a unix
 *   socket named by the token's hash (mode 0700 directory), the session's rules, its upstream.
 *   Revoked when the run ends (or the session is stopped/reset); suspended while the computer
 *   hibernates. Tokens are never logged.
 * - Rule matching follows the AI SDK type exactly (host, path exact/startsWith/regex, method,
 *   queryString and header key/value matchers). The SDK registers its rules for the host of the
 *   base URL it was given (the relay's public host and path); Polpo's own rules (gateway headers)
 *   are for the upstream host. A rule matches when it matches the request as the VM sent it
 *   (relay URL) or as it goes upstream (upstream URL), each view with its own host and path.
 * - Client credentials (authorization, x-api-key, cookie) are always stripped; only rule headers
 *   reach the upstream. A request no credential rule matches (a stale placeholder) is refused.
 * - The upstream is fixed per lease (the configured base URL): the relay is not an open proxy; a
 *   path that escapes the base (.., encoded dots or slashes) is refused; redirects are not followed.
 * - Bodies are streamed both ways untouched (SSE included) with backpressure; anthropic-* and the
 *   other request headers pass through; the client's disconnect aborts the upstream request.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { RequestKeyValueMatcher, RequestMatcher, RequestTransformation } from "./types.js";

/** The relay's route on the Polpo server (public: authenticated by the token in the path). */
export const HARNESS_RELAY_PATH = "/api/v1/harness-relay";
/** The header the server passes the token to the lease with (over the unix socket). */
const TOKEN_HEADER = "x-polpo-relay-token";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** POLPO_PUBLIC_URL without a trailing slash: where VMs reach this instance (undefined: no relay). */
export function harnessRelayPublicUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.POLPO_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  try { new URL(raw); return raw; } catch { return undefined; }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The directory of this instance's relay sockets (short: unix socket paths are limited to ~100 bytes). */
export function relaySocketDir(polpoDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.POLPO_RELAY_SOCKET_DIR?.trim() || (process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir());
  return join(base, `polpo-relay-${sha(resolve(polpoDir)).slice(0, 16)}`);
}

export function relaySocketPath(polpoDir: string, token: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(relaySocketDir(polpoDir, env), `${sha(token).slice(0, 32)}.sock`);
}

// ── Rule matching (the AI SDK's HarnessV1RequestTransformation) ─────────

function matchText(m: RequestMatcher | undefined, value: string, ci = false): boolean {
  if (!m) return true;
  const v = ci ? value.toLowerCase() : value;
  if ("exact" in m) return v === (ci ? m.exact.toLowerCase() : m.exact);
  if ("startsWith" in m) return v.startsWith(ci ? m.startsWith.toLowerCase() : m.startsWith);
  try { return new RegExp(m.regex, ci ? "i" : "").test(value); } catch { return false; }
}

function matchPairs(matchers: ReadonlyArray<RequestKeyValueMatcher> | undefined, pairs: Array<[string, string]>, ciKeys: boolean): boolean {
  if (!matchers?.length) return true;
  return matchers.every((m) => pairs.some(([k, v]) => matchText(m.key, k, ciKeys) && matchText(m.value, v)));
}

/**
 * Whether a rule matches a request. `views`: the request's URL as the VM sent it and as it goes
 * upstream; host and path must match in the same view. Header names compare case-insensitively.
 */
export function ruleMatches(rule: RequestTransformation, req: { method: string; views: URL[]; headers: Headers }): boolean {
  const m = rule.match;
  if (m.method?.length && !m.method.some((x) => x.toUpperCase() === req.method.toUpperCase())) return false;
  const headerPairs: Array<[string, string]> = [];
  req.headers.forEach((v, k) => headerPairs.push([k, v]));
  if (!matchPairs(m.headers, headerPairs, true)) return false;
  return req.views.some((u) => {
    if (u.hostname.toLowerCase() !== m.host.toLowerCase()) return false;
    if (m.path && !matchText(m.path, u.pathname)) return false;
    return matchPairs(m.queryString, [...u.searchParams.entries()], false);
  });
}

/** Set (or, for "", remove) each rule's headers, in order. */
export function applyTransforms(headers: Headers, rules: ReadonlyArray<RequestTransformation>): void {
  for (const r of rules) {
    for (const [k, v] of Object.entries(r.transform.headers)) {
      if (v === "") headers.delete(k); else headers.set(k, v);
    }
  }
}

/**
 * The SDK's credential rules, presented the way the gateway wants the key: the key the rule would
 * inject (x-api-key or Authorization: Bearer) becomes x-api-key, a Bearer token, or nothing.
 * A no-op without a scheme (Anthropic, OpenAI, the Vercel AI Gateway take what the runtime sends).
 */
export function presentCredential(rules: ReadonlyArray<RequestTransformation>, scheme: "x-api-key" | "bearer" | "none" | undefined): RequestTransformation[] {
  if (!scheme) return [...rules];
  return rules.map((r) => {
    const h = Object.fromEntries(Object.entries(r.transform.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const key = h["x-api-key"] ?? (h.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]);
    if (key === undefined) return r;
    const rest = Object.fromEntries(Object.entries(h).filter(([k]) => k !== "x-api-key" && k !== "authorization"));
    const auth = scheme === "x-api-key" ? { "x-api-key": key, authorization: "" }
      : scheme === "bearer" ? { authorization: `Bearer ${key}`, "x-api-key": "" }
      : { authorization: "", "x-api-key": "" };
    return { match: r.match, transform: { headers: { ...rest, ...auth } } };
  });
}

// ── The lease (runner side: holds the rules and the key) ────────────────

/** Request headers never forwarded upstream (hop-by-hop, proxy, client credentials). */
const DROP_REQUEST = /^(host|content-length|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|x-forwarded-.*|forwarded|x-real-ip|cookie|authorization|x-api-key|accept-encoding|tailscale-.*|x-polpo-relay-token|cf-connecting-ip|true-client-ip)$/i;
/** Response headers not passed back (hop-by-hop; the body is re-chunked, possibly decoded). */
const DROP_RESPONSE = /^(connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|content-length|content-encoding|set-cookie)$/i;
/** Response headers some gateways report a request's cost in (USD), best effort. */
const COST_HEADERS = ["x-litellm-response-cost", "x-gateway-cost", "x-ai-gateway-cost", "x-portkey-cost", "x-request-cost"];

export interface RelayLeaseOptions {
  polpoDir: string;
  /** POLPO_PUBLIC_URL (the VM's view of this instance). */
  publicUrl: string;
  /** The upstream base URL the runtime would call (https://api.anthropic.com, a gateway). */
  upstream: string;
  /** Polpo's own headers for the upstream (gateway headers; secret ones resolved from the vault). */
  headers?: Record<string, string>;
  /** How the brokered key must be presented (custom gateways). */
  scheme?: "x-api-key" | "bearer" | "none";
  fetch?: typeof fetch;
  /** Until the upstream answers (default 10 min). */
  headersTimeoutMs?: number;
  /** Between two body chunks (default 5 min; Anthropic pings every few seconds on streams). */
  idleTimeoutMs?: number;
  log?: (line: string) => void;
  /** Listen on the unix socket (default true; tests may call handle() directly). */
  listen?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class HarnessRelayLease {
  readonly token: string;
  /** The base URL the VM gets: <public URL>/api/v1/harness-relay/<token>. */
  readonly baseUrl: string;
  readonly upstream: URL;
  private rules: RequestTransformation[] = [];
  private readonly polpoRules: RequestTransformation[];
  private state: "active" | "suspended" | "revoked" = "active";
  private server?: Server;
  private socketPath?: string;
  private readonly inflight = new Set<AbortController>();
  private readonly fetchImpl: typeof fetch;
  /** Cost the upstream reported in response headers so far (USD; best effort). */
  costUsd = 0;
  /** Requests relayed so far. */
  requests = 0;

  constructor(private readonly o: RelayLeaseOptions) {
    this.token = randomBytes(32).toString("base64url");
    this.baseUrl = `${o.publicUrl.replace(/\/+$/, "")}${HARNESS_RELAY_PATH}/${this.token}`;
    this.upstream = new URL(o.upstream.replace(/\/+$/, "") || o.upstream);
    this.polpoRules = o.headers && Object.keys(o.headers).length
      ? [{ match: { host: this.upstream.hostname }, transform: { headers: { ...o.headers } } }]
      : [];
    this.fetchImpl = o.fetch ?? fetch;
  }

  get status(): "active" | "suspended" | "revoked" { return this.state; }
  /** The rules the runtime registered (tests and diagnostics; they hold the key). */
  get registeredRules(): readonly RequestTransformation[] { return this.rules; }

  /** The sandbox session's addRequestTransformations. */
  addRules(rules: ReadonlyArray<RequestTransformation>): void {
    if (this.state === "revoked") throw new Error("The model relay lease was revoked");
    this.rules.push(...presentCredential(rules, this.o.scheme));
  }

  /** The sandbox session's setRequestTransformations (replaces the runtime's rules; Polpo's stay). */
  setRules(rules: ReadonlyArray<RequestTransformation>): void {
    if (this.state === "revoked") throw new Error("The model relay lease was revoked");
    this.rules = presentCredential(rules, this.o.scheme);
  }

  /** The computer hibernates: refuse requests until resume (in-flight ones are aborted). */
  suspend(): void {
    if (this.state !== "active") return;
    this.state = "suspended";
    this.abortAll("suspended");
  }

  resume(): void { if (this.state === "suspended") this.state = "active"; }

  /** The run is over (or the session stopped / reset): the token stops working for good. */
  async revoke(): Promise<void> {
    if (this.state === "revoked") return;
    this.state = "revoked";
    this.rules = [];
    this.abortAll("revoked");
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (this.socketPath) rmSync(this.socketPath, { force: true });
  }

  private abortAll(reason: string): void {
    for (const ac of this.inflight) ac.abort(new Error(`model relay ${reason}`));
    this.inflight.clear();
  }

  /** Start listening on the lease's unix socket (the server forwards relay requests there). */
  async listen(): Promise<void> {
    const dir = relaySocketDir(this.o.polpoDir, this.o.env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
    const path = relaySocketPath(this.o.polpoDir, this.token, this.o.env);
    rmSync(path, { force: true });
    const server = createServer((req, res) => void this.serveNode(req, res));
    // long streams: no server-side request timeout (the relay has its own)
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(path, () => { server.off("error", fail); ok(); }); });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    this.server = server;
    this.socketPath = path;
  }

  private async serveNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const given = String(req.headers[TOKEN_HEADER] ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "model relay: unknown or revoked token" }));
      return;
    }
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(new Error("client closed")); });
    const url = new URL(req.url ?? "/", "http://relay.local");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) headers.append(k, x); else headers.set(k, v);
    }
    const hasBody = !["GET", "HEAD"].includes((req.method ?? "GET").toUpperCase());
    const request = new Request(url, {
      method: req.method, headers, signal: ac.signal,
      ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, duplex: "half" } : {}),
    } as RequestInit);
    const response = await this.handle(request, url.pathname === "/" ? "" : url.pathname);
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    if (!response.body) { res.end(); return; }
    const body = Readable.fromWeb(response.body as any);
    res.on("close", () => body.destroy());
    body.on("error", () => res.destroy());
    body.pipe(res);
  }

  /**
   * One relayed request. `rest`: the path after the token ("/v1/messages"); the query string is
   * the request's. Never throws: errors are answered as JSON (no secrets in them).
   */
  async handle(req: Request, rest: string): Promise<Response> {
    const json = (status: number, error: string, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify({ type: "error", error: { type: "relay_error", message: `Polpo model relay: ${error}` } }), { status, headers: { "content-type": "application/json", ...extra } });
    if (this.state === "revoked") return json(401, "this run's relay token was revoked (the run ended or its session was stopped)");
    if (this.state === "suspended") return json(503, "the computer is hibernating; the session resumes on its next turn", { "retry-after": "30" });
    if (rest && !rest.startsWith("/")) return json(400, "bad path");
    if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(rest)) return json(400, "the path leaves the upstream base URL");
    const search = new URL(req.url).search;
    let upstreamUrl: URL;
    let vmUrl: URL;
    try {
      upstreamUrl = new URL(`${this.upstream.origin}${this.upstream.pathname.replace(/\/+$/, "")}${rest}${search}`);
      vmUrl = new URL(`${this.baseUrl}${rest}${search}`);
    } catch {
      return json(400, "bad URL");
    }
    const basePath = this.upstream.pathname.replace(/\/+$/, "");
    if (upstreamUrl.origin !== this.upstream.origin || (basePath && upstreamUrl.pathname !== basePath && !upstreamUrl.pathname.startsWith(`${basePath}/`))) {
      return json(403, "only the configured upstream is reachable through the relay");
    }
    const method = req.method.toUpperCase();
    const matched = this.rules.filter((r) => ruleMatches(r, { method, views: [vmUrl, upstreamUrl], headers: req.headers }));
    if (!matched.length) return json(401, "no credential rule of this session matches the request (a stale placeholder, or a request the session did not register)");

    const headers = new Headers();
    req.headers.forEach((v, k) => { if (!DROP_REQUEST.test(k)) headers.set(k, v); });
    headers.set("accept-encoding", "identity");
    applyTransforms(headers, matched);
    applyTransforms(headers, this.polpoRules.filter((r) => ruleMatches(r, { method, views: [upstreamUrl], headers: req.headers })));

    const ac = new AbortController();
    this.inflight.add(ac);
    const onClientAbort = () => ac.abort(new Error("client closed"));
    req.signal.addEventListener("abort", onClientAbort, { once: true });
    const done = () => { this.inflight.delete(ac); req.signal.removeEventListener("abort", onClientAbort); };
    const headersTimer = setTimeout(() => ac.abort(new Error("upstream timeout")), this.o.headersTimeoutMs ?? 600_000);
    let upstream: Response;
    try {
      const hasBody = method !== "GET" && method !== "HEAD" && req.body;
      upstream = await this.fetchImpl(upstreamUrl, {
        method, headers, redirect: "manual", signal: ac.signal,
        ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      } as RequestInit);
    } catch (err) {
      clearTimeout(headersTimer);
      done();
      const why = ac.signal.aborted ? String((ac.signal.reason as Error)?.message ?? "aborted") : (err as Error)?.message ?? "error";
      this.o.log?.(`model relay ${method} ${upstreamUrl.host}${upstreamUrl.pathname}: ${why}`);
      return json(ac.signal.aborted && /timeout/.test(why) ? 504 : 502, `the upstream ${upstreamUrl.host} could not be reached (${why})`);
    }
    clearTimeout(headersTimer);
    this.requests++;
    for (const h of COST_HEADERS) {
      const v = Number(upstream.headers.get(h));
      if (Number.isFinite(v) && v > 0 && v < 1000) { this.costUsd += v; break; }
    }
    this.o.log?.(`model relay ${method} ${upstreamUrl.host}${upstreamUrl.pathname} → ${upstream.status}`);
    const outHeaders = new Headers();
    upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE.test(k)) outHeaders.set(k, v); });
    if (!upstream.body) { done(); return new Response(null, { status: upstream.status, headers: outHeaders }); }

    // pull-based: a chunk is read from the upstream only when the client takes one (backpressure)
    const reader = upstream.body.getReader();
    const idleMs = this.o.idleTimeoutMs ?? 300_000;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        idle = setTimeout(() => ac.abort(new Error("upstream idle timeout")), idleMs);
        try {
          const { done: end, value } = await reader.read();
          clearTimeout(idle);
          if (end) { ctrl.close(); done(); } else ctrl.enqueue(value);
        } catch (err) {
          clearTimeout(idle);
          done();
          ctrl.error(err);
        }
      },
      cancel(reason) {
        clearTimeout(idle);
        ac.abort(reason instanceof Error ? reason : new Error("client closed"));
        void reader.cancel(reason).catch(() => undefined);
        done();
      },
    });
    const status = upstream.status;
    // a null-body status cannot carry a stream
    if (status === 204 || status === 304) { void reader.cancel().catch(() => undefined); done(); return new Response(null, { status, headers: outHeaders }); }
    return new Response(body, { status, headers: outHeaders });
  }
}

/** Open a lease: listening on its unix socket unless `listen: false`. */
export async function openRelayLease(o: RelayLeaseOptions): Promise<HarnessRelayLease> {
  const lease = new HarnessRelayLease(o);
  if (o.listen !== false) await lease.listen();
  return lease;
}

// ── The server side (the public route: a pipe to the lease's socket) ────

/** Request headers the server does not pass to the lease. */
const DROP_FORWARD = /^(host|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|x-polpo-relay-token)$/i;

/**
 * The public route's handler: `path` is the request path from the relay prefix on
 * ("/<token>/v1/messages"). The token selects the lease's socket; the lease checks it again.
 * Unknown, malformed or revoked tokens all get the same 401.
 */
export async function forwardToRelay(o: { polpoDir: string; path: string; request: Request; env?: NodeJS.ProcessEnv }): Promise<Response> {
  const unknown = () => new Response(JSON.stringify({ type: "error", error: { type: "relay_error", message: "Polpo model relay: unknown or revoked token" } }), { status: 401, headers: { "content-type": "application/json" } });
  const m = o.path.match(/^\/([^/]+)(\/.*)?$/);
  const token = m?.[1] ?? "";
  if (!TOKEN_RE.test(token)) return unknown();
  const socketPath = relaySocketPath(o.polpoDir, token, o.env);
  if (!existsSync(socketPath)) return unknown();
  const search = new URL(o.request.url).search;
  const headers: Record<string, string> = {};
  o.request.headers.forEach((v, k) => { if (!DROP_FORWARD.test(k)) headers[k] = v; });
  headers[TOKEN_HEADER] = token;
  const method = o.request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && !!o.request.body;
  if (hasBody) headers["transfer-encoding"] = "chunked";
  return new Promise<Response>((resolveResponse) => {
    const out = httpRequest({ socketPath, method, path: `${m?.[2] || "/"}${search}`, headers }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || /^(connection|keep-alive|transfer-encoding)$/i.test(k)) continue;
        if (Array.isArray(v)) for (const x of v) h.append(k, x); else h.set(k, v);
      }
      const status = res.statusCode ?? 502;
      const nullBody = status === 204 || status === 304 || method === "HEAD";
      if (nullBody) res.resume();
      resolveResponse(new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    out.on("error", (err: NodeJS.ErrnoException) => {
      resolveResponse(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? unknown()
        : new Response(JSON.stringify({ type: "error", error: { type: "relay_error", message: "Polpo model relay: the run's relay did not answer" } }), { status: 502, headers: { "content-type": "application/json" } }));
    });
    o.request.signal?.addEventListener("abort", () => out.destroy(new Error("client closed")), { once: true });
    if (hasBody) {
      const body = Readable.fromWeb(o.request.body as any);
      body.on("error", () => out.destroy());
      body.pipe(out);
    } else {
      out.end();
    }
  });
}
