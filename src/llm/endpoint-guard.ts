/**
 * Network policy for custom LLM provider endpoints.
 *
 * - Cloud metadata / link-local targets are ALWAYS blocked.
 * - Private / internal targets (loopback, RFC1918, Tailscale CGNAT, IPv6 ULA) are
 *   blocked unless the provider explicitly sets `allowPrivateNetwork`.
 * - The check runs on the address the socket actually connects to (custom DNS
 *   `lookup` hook), so DNS rebinding between "check" and "connect" is not possible.
 * - Redirects are refused, responses can be size-capped.
 *
 * `createGuardedFetch` returns a WHATWG-compatible `fetch` built on node:http(s) that
 * the OpenAI / Anthropic SDKs (via pi-ai `options.fetch`) use transparently.
 */

import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import * as zlib from "node:zlib";

export type AddressClass = "public" | "private" | "blocked";

export interface EndpointPolicy {
  /** Allow loopback / RFC1918 / CGNAT / ULA targets. Metadata + link-local stay blocked. */
  allowPrivateNetwork?: boolean;
}

export class EndpointBlockedError extends Error {
  readonly code = "ENDPOINT_BLOCKED";
  constructor(message: string, readonly addressClass: Exclude<AddressClass, "public">) {
    super(message);
    this.name = "EndpointBlockedError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

// ── Address classification ─────────────────────────────────────────

function parseIPv4(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const o = Number(p);
    if (o > 255) return undefined;
    n = n * 256 + o;
  }
  return n;
}

function inV4(ip: number, base: string, bits: number): boolean {
  const b = parseIPv4(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(b / size);
}

function classifyV4(ip: number): AddressClass {
  // Always blocked: link-local incl. cloud metadata (169.254.169.254), Alibaba metadata,
  // multicast / reserved / broadcast.
  if (inV4(ip, "169.254.0.0", 16)) return "blocked";
  if (ip === parseIPv4("100.100.100.200")) return "blocked";
  // Azure WireServer / host agent (public range, but only reachable from inside Azure VMs).
  if (ip === parseIPv4("168.63.129.16")) return "blocked";
  if (inV4(ip, "224.0.0.0", 4) || inV4(ip, "240.0.0.0", 4)) return "blocked";
  // Private / internal.
  if (inV4(ip, "0.0.0.0", 8)) return "private";
  if (inV4(ip, "127.0.0.0", 8)) return "private";
  if (inV4(ip, "10.0.0.0", 8)) return "private";
  if (inV4(ip, "172.16.0.0", 12)) return "private";
  if (inV4(ip, "192.168.0.0", 16)) return "private";
  if (inV4(ip, "100.64.0.0", 10)) return "private"; // CGNAT / Tailscale
  if (inV4(ip, "198.18.0.0", 15)) return "private";
  if (inV4(ip, "192.0.0.0", 24)) return "private";
  return "public";
}

/** Expand an IPv6 string to 8 hextets (handles ::, embedded IPv4, zone ids). */
function expandV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === undefined) return undefined;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder, replaced below
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some((n) => Number.isNaN(n))) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return undefined;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  if (tail.length === 2) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

function classifyV6(ip: string): AddressClass {
  const g = expandV6(ip);
  if (!g) return "blocked";
  const embeddedV4 = (hi: number, lo: number) => classifyV4(hi * 65536 + lo);
  // fd00:ec2::254 — AWS IMDS over IPv6.
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return "blocked";
  // fd20:ce::254 — GCP metadata over IPv6.
  if (g[0] === 0xfd20 && g[1] === 0x00ce && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return "blocked";
  // :: (unspecified) and ::1 (loopback)
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return "private";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embeddedV4(g[6], g[7]);
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embeddedV4(g[6], g[7]);
  // 6to4 2002::/16 embeds the IPv4 in hextets 1-2
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]);
  // Link-local fe80::/10, multicast ff00::/8, site-local fec0::/10 (deprecated)
  if ((g[0] & 0xffc0) === 0xfe80) return "blocked";
  if ((g[0] & 0xff00) === 0xff00) return "blocked";
  if ((g[0] & 0xffc0) === 0xfec0) return "private";
  // Unique local fc00::/7 (Tailscale uses fd7a:115c:a1e0::/48)
  if ((g[0] & 0xfe00) === 0xfc00) return "private";
  return "public";
}

/** Classify an IP literal. Non-IP input is "blocked". */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0]);
  if (family === 4) return classifyV4(parseIPv4(bare)!);
  if (family === 6) return classifyV6(bare);
  return "blocked";
}

/** Classify a hostname without DNS (names only — IP literals are classified directly). */
export function classifyHostname(hostname: string): AddressClass | undefined {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(h.split("%")[0])) return classifyAddress(h);
  if (BLOCKED_HOSTNAMES.has(h)) return "blocked";
  if (h === "localhost" || h.endsWith(".localhost")) return "private";
  return undefined;
}

function describe(cls: Exclude<AddressClass, "public">, target: string): string {
  return cls === "blocked"
    ? `Blocked: ${target} is a link-local / cloud-metadata address and can never be used as a provider endpoint`
    : `Blocked: ${target} is a private/internal address. Enable "Allow private network" for this provider to use it`;
}

/** Throw if an address class is not permitted by the policy. */
export function assertAddressAllowed(cls: AddressClass, target: string, policy: EndpointPolicy): void {
  if (cls === "blocked") throw new EndpointBlockedError(describe("blocked", target), "blocked");
  if (cls === "private" && !policy.allowPrivateNetwork) throw new EndpointBlockedError(describe("private", target), "private");
}

// ── DNS-aware checks ──────────────────────────────────────────────

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

let resolverOverride: Resolver | undefined;

/** Test hook: replace DNS resolution (used by the guarded lookup and pre-checks). */
export function setEndpointResolverForTests(resolver: Resolver | undefined): void {
  resolverOverride = resolver;
}

function activeResolver(): Resolver {
  return resolverOverride ?? defaultResolver;
}

export interface EndpointCheck {
  ok: boolean;
  /** Most restrictive class across all resolved addresses. */
  addressClass?: AddressClass;
  addresses?: string[];
  error?: string;
  /** DNS failed — reachability unknown (not a policy violation). */
  unresolved?: boolean;
}

/** Resolve a URL's host and check every address against the policy (pre-flight / save-time). */
export async function checkEndpoint(url: string, policy: EndpointPolicy): Promise<EndpointCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "Only http(s) URLs are allowed" };
  const host = parsed.hostname;
  const byName = classifyHostname(host);
  let addresses: string[] = [];
  let cls: AddressClass = byName ?? "public";
  if (!isIP(host.replace(/^\[|\]$/g, ""))) {
    try {
      const resolved = await activeResolver()(host);
      addresses = resolved.map((a) => a.address);
      for (const a of addresses) cls = worst(cls, classifyAddress(a));
    } catch (err) {
      if (byName && byName !== "public") {
        try { assertAddressAllowed(byName, host, policy); } catch (e) { return { ok: false, addressClass: byName, error: (e as Error).message }; }
      }
      return { ok: true, unresolved: true, addressClass: byName, error: `DNS lookup failed for ${host}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` };
    }
  } else {
    addresses = [host.replace(/^\[|\]$/g, "")];
  }
  try {
    assertAddressAllowed(cls, host, policy);
  } catch (e) {
    return { ok: false, addressClass: cls, addresses, error: (e as Error).message };
  }
  return { ok: true, addressClass: cls, addresses };
}

function worst(a: AddressClass, b: AddressClass): AddressClass {
  const rank = { public: 0, private: 1, blocked: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * `net` lookup hook enforcing the policy on the addresses actually used to connect.
 * Rejects when ANY resolved address is not permitted (no mixed public/private answers).
 */
export function createGuardedLookup(policy: EndpointPolicy): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions | number | undefined, callback: (...args: any[]) => void) => {
    const opts: dns.LookupOptions = typeof options === "number" ? { family: options } : (options ?? {});
    const byName = classifyHostname(hostname);
    activeResolver()(hostname).then((addresses) => {
      try {
        if (byName) assertAddressAllowed(byName, hostname, policy);
        let list = addresses;
        if (opts.family === 4 || opts.family === 6) list = addresses.filter((a) => a.family === opts.family);
        if (list.length === 0) throw Object.assign(new Error(`No usable address for ${hostname}`), { code: "ENOTFOUND" });
        for (const a of list) assertAddressAllowed(classifyAddress(a.address), `${hostname} (${a.address})`, policy);
        if (opts.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      } catch (err) {
        callback(err);
      }
    }, (err) => callback(err));
  }) as LookupFunction;
}

// ── Guarded fetch ─────────────────────────────────────────────────

export interface GuardedFetchOptions extends EndpointPolicy {
  /** Abort the response body once it exceeds this many bytes (decompressed). */
  maxResponseBytes?: number;
  /** Socket idle timeout in ms (default 10 minutes, matching the SDKs). */
  idleTimeoutMs?: number;
}

const agents = new Map<string, http.Agent>();

function agentFor(protocol: string, allowPrivate: boolean): http.Agent {
  const key = `${protocol}|${allowPrivate ? 1 : 0}`;
  let agent = agents.get(key);
  if (!agent) {
    const policy = { allowPrivateNetwork: allowPrivate };
    agent = protocol === "https:"
      ? new https.Agent({ keepAlive: true, lookup: createGuardedLookup(policy) } as https.AgentOptions)
      : new http.Agent({ keepAlive: true, lookup: createGuardedLookup(policy) } as http.AgentOptions);
    agents.set(key, agent);
  }
  return agent;
}

async function bodyToBuffer(body: unknown): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (typeof (body as ReadableStream).getReader === "function") {
    const chunks: Buffer[] = [];
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unsupported request body type for provider endpoint");
}

/**
 * Create a WHATWG `fetch` that enforces the endpoint policy on every connection.
 * Redirects are rejected (unless `redirect: "manual"`, which returns the 3xx as-is).
 */
export function createGuardedFetch(opts: GuardedFetchOptions = {}): typeof fetch {
  const allowPrivate = !!opts.allowPrivateNetwork;
  const policy: EndpointPolicy = { allowPrivateNetwork: allowPrivate };

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url: URL;
    let method = init?.method;
    let headersInit = init?.headers;
    let body: unknown = init?.body;
    let signal = init?.signal ?? undefined;
    const redirectMode = init?.redirect ?? "error";
    if (typeof input === "object" && "url" in input && !(input instanceof URL)) {
      const req = input as Request;
      url = new URL(req.url);
      method ??= req.method;
      headersInit ??= req.headers;
      signal ??= req.signal;
      if (body === undefined && req.body) body = await req.arrayBuffer();
    } else {
      url = new URL(String(input));
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`Unsupported protocol: ${url.protocol}`);
    if (url.username || url.password) throw new TypeError("Credentials in provider URLs are not allowed");

    // IP literals and well-known names never reach the lookup hook — check them here.
    const byName = classifyHostname(url.hostname);
    if (byName) assertAddressAllowed(byName, url.hostname, policy);

    const headers: Record<string, string> = {};
    new Headers(headersInit as HeadersInit | undefined).forEach((value, key) => {
      if (key === "host" || key === "content-length" || key === "connection") return;
      headers[key] = value;
    });
    const payload = await bodyToBuffer(body);
    if (payload) headers["content-length"] = String(payload.length);
    signal?.throwIfAborted();

    return await new Promise<Response>((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(url, {
        method: (method ?? "GET").toUpperCase(),
        headers,
        agent: agentFor(url.protocol, allowPrivate),
        lookup: createGuardedLookup(policy),
      });
      let settled = false;
      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const onAbort = () => {
        const reason = signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
        req.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        fail(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.setTimeout(opts.idleTimeoutMs ?? 600_000, () => req.destroy(new Error("Provider request timed out (socket idle)")));
      req.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        fail(err);
      });
      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectMode !== "manual") {
          res.resume();
          signal?.removeEventListener("abort", onAbort);
          fail(new Error(`Provider endpoint redirected (${status}); redirects are not followed — use the final URL as base URL`));
          return;
        }
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) v.forEach((x) => responseHeaders.append(k, x));
          else responseHeaders.set(k, v);
        }
        let stream: Readable = res;
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        const decoder = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
          : encoding === "deflate" ? zlib.createInflate()
          : encoding === "br" ? zlib.createBrotliDecompress()
          : undefined;
        if (decoder) {
          stream = res.pipe(decoder);
          res.on("error", (e) => decoder.destroy(e));
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        if (opts.maxResponseBytes) {
          let seen = 0;
          const limit = opts.maxResponseBytes;
          const cap = new Transform({
            transform(chunk, _enc, cb) {
              seen += chunk.length;
              if (seen > limit) cb(new Error(`Provider response exceeded ${limit} bytes`));
              else cb(null, chunk);
            },
          });
          const src = stream;
          stream = src.pipe(cap);
          src.on("error", (e) => cap.destroy(e));
        }
        stream.on("close", () => signal?.removeEventListener("abort", onAbort));
        const noBody = method?.toUpperCase() === "HEAD" || status === 204 || status === 304 || status < 200;
        if (noBody) res.resume();
        let response: Response;
        try {
          response = new Response(noBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream), {
            status: status < 200 || status > 599 ? 502 : status,
            statusText: res.statusMessage,
            headers: responseHeaders,
          });
        } catch (err) {
          fail(err);
          return;
        }
        Object.defineProperty(response, "url", { value: url.toString() });
        settled = true;
        resolve(response);
      });
      if (payload) req.end(payload);
      else req.end();
    });
  };
  return guarded as typeof fetch;
}

/** Fetch + parse JSON with a hard size cap and timeout (test / discovery helpers). */
export async function fetchJsonGuarded(
  url: string,
  init: { headers?: Record<string, string>; policy: EndpointPolicy; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch },
): Promise<{ status: number; json?: unknown; text?: string }> {
  const f = init.fetchImpl ?? createGuardedFetch({ ...init.policy, maxResponseBytes: init.maxBytes ?? 4 * 1024 * 1024 });
  const res = await f(url, {
    method: "GET",
    headers: { accept: "application/json", ...init.headers },
    redirect: "error",
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text: text.slice(0, 500) };
  }
}
