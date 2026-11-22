/**
 * Icon discovery for custom connectors (catalog connectors keep their bundled official icon and are
 * never looked up here), the way a good MCP client does it:
 *
 *   1. the MCP server's own icons: `initialize` → `serverInfo.icons` (MCP 2025-11-25 `Implementation.icons`,
 *      `{ src, mimeType?, sizes?, theme? }`): the best light one (SVG, else the largest ≥ 64 px) and,
 *      when given, a dark-background variant; `serverInfo.websiteUrl` feeds step 3;
 *   2. the OAuth metadata: protected resource metadata (RFC 9728) and the authorization server's
 *      metadata (RFC 8414 / OpenID), when they carry a `logo_uri`;
 *   3. the website: the server's `websiteUrl`, its registrable domain (mcp.example.com → example.com)
 *      and the authorization server's origin: `<link rel="icon" | "apple-touch-icon" | "mask-icon">`,
 *      the web app manifest's icons, then /favicon.ico and /apple-touch-icon.png. Best first: SVG,
 *      then the largest square ≥ 64 px;
 *   4. nothing: the dashboard shows the letter tile.
 *
 * Everything is fetched server side (never hotlinked by the dashboard), over https only, never from a
 * private / loopback / link-local address (checked on the resolved address the socket connects to,
 * so DNS rebinding cannot slip past), with few redirects, short timeouts and a size cap. Images are
 * validated by their bytes (not the Content-Type); SVGs are sanitized (no scripts, event handlers,
 * external references, foreignObject, entities); an ICO that embeds a PNG is converted to that PNG.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { isPrivateAddress } from "../server/oauth.js";
import type { ResolveHost } from "./net.js";

export const ICON_MAX_BYTES = 512 * 1024;
const PAGE_MAX_BYTES = 512 * 1024;
const JSON_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
/** Total time one discovery may take. */
const DISCOVERY_BUDGET_MS = 30_000;
/** Images downloaded per discovery at most (candidates that fail count too). */
const MAX_IMAGE_ATTEMPTS = 8;
const GOOD_SIZE = 64;
const UA = "Mozilla/5.0 (compatible; Polpo connector icons; +https://polpo.sh)";
const IMAGE_ACCEPT = "image/svg+xml,image/png,image/x-icon,image/vnd.microsoft.icon,image/webp,image/*;q=0.8";

// ── network ──

export class IconFetchError extends Error {}

export interface FetchedResource {
  /** The final URL (after redirects). */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** The body was cut at `maxBytes` (only with `truncate`) or by `stopWhen`. */
  truncated: boolean;
  /** Response headers (lower-case names). */
  headers: Record<string, string>;
}

export interface FetchOptions {
  maxBytes: number;
  accept: string;
  /** Keep the first `maxBytes` instead of failing (HTML pages: the icons are in the head). */
  truncate?: boolean;
  /** Default GET. A POST follows only 307 / 308 redirects. */
  method?: "GET" | "POST" | "DELETE";
  body?: string;
  headers?: Record<string, string>;
  /** Stop reading once this is true of what was read (a stream that never ends, e.g. SSE). */
  stopWhen?: (bodySoFar: Buffer) => boolean;
}

export type IconFetcher = (url: string, options: FetchOptions) => Promise<FetchedResource>;
/** The same guarded HTTP client, used by the connection probe too. */
export type SafeFetcher = IconFetcher;

export interface FetchPolicy {
  /** settings.connectors.allowPrivateNetwork: the admin allowed private addresses (and http on localhost) for connectors. */
  allowPrivateNetwork?: boolean;
  resolve?: ResolveHost;
  timeoutMs?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Addresses an icon may never be fetched from: private, loopback, link-local, CGNAT, multicast, reserved… */
export function isBlockedAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 in hex form (::ffff:7f00:1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (isPrivateAddress(ip)) return true;
  const v4 = ip.replace(/^::ffff:/, "");
  if (isIP(v4) === 4) {
    const [a, b, c] = v4.split(".").map(Number);
    return (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (isIP(ip) === 6) {
    // NAT64 / 6to4 / Teredo / documentation / discard prefixes can reach internal IPv4 space
    return /^(64:ff9b:|2002:|2001:0?:|2001:db8:|100::)/.test(ip) || /^::(\d|$)/.test(ip);
  }
  return false;
}

/** Throws when a URL may not be fetched (scheme, credentials, literal private address). */
export function checkIconUrl(raw: string, policy: FetchPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IconFetchError(`Not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.username || url.password) throw new IconFetchError("Icon URLs may not carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol === "http:") {
    if (!policy.allowPrivateNetwork || !LOCAL_HOSTS.has(host)) throw new IconFetchError("Icons are only fetched over https");
  } else if (url.protocol !== "https:") {
    throw new IconFetchError("Icons are only fetched over https");
  }
  if (!policy.allowPrivateNetwork && (LOCAL_HOSTS.has(host) || (isIP(host) && isBlockedAddress(host)))) {
    throw new IconFetchError(`${host} is a private or local address`);
  }
  return url;
}

const defaultResolve: ResolveHost = async (hostname) => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

/** A socket lookup that refuses private addresses: the check is on the address actually connected to. */
function guardedLookup(policy: FetchPolicy): LookupFunction {
  const resolve = policy.resolve ?? defaultResolve;
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then((addresses) => {
      if (addresses.length === 0) return callback(Object.assign(new Error(`Cannot resolve ${hostname}`), { code: "ENOTFOUND" }));
      if (!policy.allowPrivateNetwork && addresses.some(isBlockedAddress)) {
        return callback(Object.assign(new IconFetchError(`${hostname} resolves to a private or local address`), { code: "EBLOCKED" }));
      }
      if (options?.all) return callback(null, addresses.map((address) => ({ address, family: isIP(address) || 4 })));
      return callback(null, addresses[0], isIP(addresses[0]!) || 4);
    }, (err: unknown) => callback(err));
  }) as unknown as LookupFunction;
}

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip());
  if (encoding === "deflate") return res.pipe(createInflate());
  if (encoding === "br") return res.pipe(createBrotliDecompress());
  return res;
}

/** GET with the rules above; follows at most MAX_REDIRECTS redirects, each one checked again. */
export function guardedFetcher(policy: FetchPolicy = {}): IconFetcher {
  const lookup = guardedLookup(policy);
  const timeoutMs = policy.timeoutMs ?? FETCH_TIMEOUT_MS;
  const once = (url: URL, options: FetchOptions) => new Promise<{ res: http.IncomingMessage; body?: Buffer; truncated?: boolean }>((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const req = (url.protocol === "http:" ? http : https).request(url, {
      method: options.method ?? "GET",
      headers: {
        accept: options.accept, "user-agent": UA, "accept-encoding": "gzip, deflate, br", ...options.headers,
        ...(options.body !== undefined ? { "content-length": String(Buffer.byteLength(options.body)) } : {}),
      },
      lookup,
      signal,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ res });
      }
      const length = Number(res.headers["content-length"] ?? 0);
      if (!options.truncate && !res.headers["content-encoding"] && length > options.maxBytes) {
        res.destroy();
        return reject(new IconFetchError(`Too large (${length} bytes)`));
      }
      const stream = decoded(res);
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (truncated: boolean) => {
        if (done) return;
        done = true;
        resolve({ res, body: Buffer.concat(chunks).subarray(0, options.maxBytes), truncated });
      };
      stream.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        chunks.push(chunk);
        if (options.stopWhen?.(Buffer.concat(chunks))) {
          finish(true);
          res.destroy();
          return;
        }
        if (size > options.maxBytes) {
          if (options.truncate) finish(true);
          else {
            done = true;
            reject(new IconFetchError(`Too large (over ${options.maxBytes} bytes)`));
          }
          res.destroy();
        }
      });
      stream.on("end", () => finish(false));
      stream.on("error", (err) => { if (!done) { done = true; reject(err); } });
    });
    req.on("error", reject);
    req.end(options.body);
  });

  return async (raw, options) => {
    let url = checkIconUrl(raw, policy);
    for (let hop = 0; ; hop++) {
      const { res, body, truncated } = await once(url, options);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      const method = options.method ?? "GET";
      if (status >= 300 && status < 400 && location && (method === "GET" || status === 307 || status === 308)) {
        if (hop >= MAX_REDIRECTS) throw new IconFetchError("Too many redirects");
        url = checkIconUrl(new URL(location, url).toString(), policy);
        continue;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      return {
        url: url.toString(), status, contentType: String(res.headers["content-type"] ?? "").toLowerCase(),
        body: body ?? Buffer.alloc(0), truncated: !!truncated, headers,
      };
    }
  };
}

// ── images ──

export interface IconImage {
  bytes: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  /** Where it came from (undefined for inline data). */
  src?: string;
}

const startsWith = (buf: Buffer, bytes: number[], at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type by its bytes (never by the Content-Type), or undefined. */
export function sniffImage(buf: Buffer): "image/png" | "image/x-icon" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml" | undefined {
  if (startsWith(buf, PNG_SIGNATURE)) return "image/png";
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length >= 22) return "image/x-icon";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const head = buf.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head) && !/<html[\s>]/i.test(head)) return "image/svg+xml";
  return undefined;
}

function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (!startsWith(buf, PNG_SIGNATURE) || buf.length < 24 || buf.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * The largest image of an ICO: when it is a PNG (most modern favicons) that PNG, so the icon is
 * stored as a plain PNG; else the ICO itself (browsers render it) with its largest size.
 */
export function unpackIco(buf: Buffer): { bytes: Buffer; mimeType: "image/png" | "image/x-icon"; width?: number; height?: number } {
  const count = buf.readUInt16LE(4);
  let best: { width: number; height: number; size: number; offset: number } | undefined;
  for (let i = 0; i < count && 6 + (i + 1) * 16 <= buf.length; i++) {
    const at = 6 + i * 16;
    const width = buf[at] || 256;
    const height = buf[at + 1] || 256;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + size > buf.length || size === 0) continue;
    if (!best || width * height > best.width * best.height) best = { width, height, size, offset };
  }
  if (!best) throw new IconFetchError("Not a valid ICO file");
  const image = buf.subarray(best.offset, best.offset + best.size);
  const png = pngSize(image);
  if (png) return { bytes: Buffer.from(image), mimeType: "image/png", ...png };
  return { bytes: buf, mimeType: "image/x-icon", width: best.width, height: best.height };
}

const DROPPED_ELEMENTS = [
  "script", "foreignObject", "iframe", "object", "embed", "metadata", "audio", "video", "canvas", "handler", "listener",
  "set", "html", "body", "head", "meta", "link", "base", "form", "input", "textarea", "button",
];
const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const XLINK_NS = "http://www.w3.org/1999/xlink";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Remove an element (self-closing, or with its content) and any stray tag of it. */
function dropElement(text: string, tag: string): string {
  return text
    .replace(new RegExp(`<${tag}(?=[\\s/>])[^>]*\\/>`, "gi"), "")
    .replace(new RegExp(`<${tag}(?=[\\s/>])[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*>`, "gi"), "");
}

function safeReference(value: string): boolean {
  const v = value.trim();
  return v.startsWith("#") || SAFE_DATA_IMAGE.test(v);
}

/** CSS without imports, external url()s, expressions or javascript: (styles inside an SVG). */
function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _q: string, target: string) => (safeReference(target) ? match : "none"))
    .replace(/expression\s*\(/gi, "(")
    .replace(/javascript:/gi, "")
    .replace(/-moz-binding[^;]*;?/gi, "")
    .replace(/behavior\s*:[^;]*;?/gi, "");
}

const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function sanitizeTag(name: string, attrs: string, selfClosing: string): string {
  const kept: string[] = [];
  const lowerName = name.toLowerCase();
  for (const match of attrs.matchAll(ATTRIBUTE)) {
    const attr = match[1]!;
    const lower = attr.toLowerCase();
    const raw = match[2];
    const value = raw === undefined ? "" : raw.replace(/^["']|["']$/g, "");
    if (lower.startsWith("on")) continue; // event handlers
    if (/^(xmlns:)?xlink$/.test(lower) && value !== XLINK_NS) continue;
    if (lower === "href" || lower.endsWith(":href") || lower === "src" || lower === "action" || lower === "formaction") {
      if (!safeReference(value)) continue;
    }
    if (/javascript:|vbscript:|data:text\/html/i.test(value.replace(/\s|&#[0-9]+;|&#x[0-9a-f]+;/gi, ""))) continue;
    if ((lowerName === "animate" || lowerName === "animatemotion" || lowerName === "animatetransform") && lower === "attributename" && /href|^on/i.test(value)) {
      return "";
    }
    if (lower === "style") {
      kept.push(`style="${sanitizeCss(value).replace(/"/g, "&quot;")}"`);
      continue;
    }
    kept.push(raw === undefined ? attr : `${attr}=${raw.startsWith("\"") || raw.startsWith("'") ? raw : `"${raw.replace(/"/g, "&quot;")}"`}`);
  }
  return `<${name}${kept.length ? ` ${kept.join(" ")}` : ""}${selfClosing ? " /" : ""}>`;
}

/**
 * A safe copy of an SVG: no DOCTYPE / entities / processing instructions, no script, foreignObject
 * or other active elements, no event handlers, no external references (href, src, CSS url() and
 * @import: only `#fragment` and inline raster data), and an SVG namespace so browsers render it as
 * an image. Throws when what is left is not an SVG document.
 */
export function sanitizeSvg(input: string): string {
  let text = input.replace(/^﻿/, "");
  // no XML machinery: declarations, processing instructions (xml-stylesheet), doctype + internal subset, entities, comments
  text = text
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROPPED_ELEMENTS) text = dropElement(text, tag);
  // any namespaced element other than svg's own (c2pa:manifest, sodipodi:*, inkscape:* …)
  const prefixed = new Set([...text.matchAll(/<\/?([a-z][\w.-]*:[\w.-]+)/gi)].map((m) => m[1]!).filter((n) => !/^svg:/i.test(n)));
  for (const tag of prefixed) text = dropElement(text, tag.replace(/[.]/g, "\\."));
  // <style> contents
  text = text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open: string, css: string, close: string) => `${open}${sanitizeCss(css)}${close}`);
  // every start tag: attributes filtered
  text = text.replace(/<([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g,
    (_m, name: string, attrs: string, selfClosing: string) => sanitizeTag(name, attrs, selfClosing));
  // a malformed tag the pass above could not parse must not keep a handler or an external reference
  text = text
    .replace(/(<[^>]*?)\son[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
    .replace(/(<[^>]*?\s(?:[\w-]+:)?(?:href|src))\s*=\s*("|')(?!#|data:image\/(?:png|jpeg|gif|webp);)[^"']*\2/gi, "$1=\"#\"");
  text = text.trim();
  if (/<[^>]*\son[a-z-]+\s*=/i.test(text)) throw new IconFetchError("The SVG could not be made safe");
  if (!/^<svg[\s>]/i.test(text) || !/<\/svg\s*>$/i.test(text)) throw new IconFetchError("Not an SVG document");
  if (/<script|javascript:|<foreignObject/i.test(text)) throw new IconFetchError("The SVG could not be made safe");
  // <img> renders an SVG only with its namespace
  if (!/^<svg\b[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(text)) {
    text = text.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
  }
  return `${text}\n`;
}

/** Validate and normalise downloaded bytes into a storable icon (throws when they are not a usable image). */
export function toIconImage(bytes: Buffer, src?: string): IconImage {
  if (bytes.length === 0) throw new IconFetchError("Empty image");
  if (bytes.length > ICON_MAX_BYTES) throw new IconFetchError(`Too large (${bytes.length} bytes)`);
  const type = sniffImage(bytes);
  if (!type) throw new IconFetchError("Not an image (PNG, SVG, ICO, JPEG, GIF or WebP)");
  if (type === "image/svg+xml") {
    const svg = Buffer.from(sanitizeSvg(bytes.toString("utf8")), "utf8");
    if (svg.length > ICON_MAX_BYTES) throw new IconFetchError("Too large");
    return { bytes: svg, mimeType: type, ...(src ? { src } : {}) };
  }
  if (type === "image/x-icon") return { ...unpackIco(bytes), ...(src ? { src } : {}) };
  if (type === "image/png") return { bytes, mimeType: type, ...pngSize(bytes), ...(src ? { src } : {}) };
  if (type === "image/gif" && bytes.length >= 10) return { bytes, mimeType: type, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), ...(src ? { src } : {}) };
  return { bytes, mimeType: type, ...(src ? { src } : {}) };
}

/** Decode a `data:image/…;base64,` URI (MCP icons may be inline). */
export function decodeDataUri(uri: string): Buffer {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(uri.trim());
  if (!m) throw new IconFetchError("Not a data URI");
  if (!/^image\//i.test(m[1] ?? "")) throw new IconFetchError("Not an image data URI");
  const isBase64 = /;base64/i.test(m[2] ?? "");
  // size check before decoding: base64 is 4/3 of the bytes
  if (m[3]!.length > Math.ceil(ICON_MAX_BYTES * 4 / 3) + 4) throw new IconFetchError("Too large");
  return isBase64 ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
}

export const iconHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// ── candidates ──

export type IconCandidateKind = "mcp" | "oauth" | "icon" | "apple-touch-icon" | "mask-icon" | "manifest" | "favicon";

export interface IconCandidate {
  url: string;
  kind: IconCandidateKind;
  /** Declared type (link type, manifest type, MCP mimeType). */
  type?: string;
  /** Largest declared square size; Infinity for "any" (scalable). */
  size?: number;
  theme?: "light" | "dark";
}

/** The largest size in a `sizes` value ("16x16 32x32", "any", ["48x48", "any"]). */
export function parseSizes(sizes: string | string[] | undefined): number | undefined {
  const list = (Array.isArray(sizes) ? sizes.join(" ") : sizes ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  let best: number | undefined;
  for (const s of list) {
    if (s === "any") return Infinity;
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (m) best = Math.max(best ?? 0, Math.min(Number(m[1]), Number(m[2])));
  }
  return best;
}

const isSvgCandidate = (c: IconCandidate) => /svg/i.test(c.type ?? "") || /\.svgz?(\?|#|$)/i.test(c.url) || c.size === Infinity;

/** Rank: SVG, then the largest ≥ 64 px (PNG before others of the same size), then smaller ones; mask icons (monochrome) last. */
export function candidateScore(c: IconCandidate): number {
  if (c.kind === "mask-icon") return 1;
  const svg = isSvgCandidate(c);
  if (svg) return 10_000;
  const assumed = c.size ?? (c.kind === "apple-touch-icon" ? 180 : c.kind === "favicon" ? 32 : 48);
  const png = /png/i.test(c.type ?? "") || /\.png(\?|#|$)/i.test(c.url);
  const size = Math.min(assumed, 1024);
  return (size >= GOOD_SIZE ? 5_000 : 100) + size * 2 + (png ? 1 : 0);
}

export function rankCandidates(list: IconCandidate[]): IconCandidate[] {
  const seen = new Set<string>();
  return list
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .map((c, index) => ({ c, index, score: candidateScore(c) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.c);
}

/** MCP `serverInfo.icons`, split by theme: `light` for light backgrounds (or no theme), `dark` for dark ones. */
export function mcpIconCandidates(icons: unknown, base?: string): { light: IconCandidate[]; dark: IconCandidate[] } {
  const light: IconCandidate[] = [];
  const dark: IconCandidate[] = [];
  if (!Array.isArray(icons)) return { light, dark };
  for (const icon of icons.slice(0, 20)) {
    if (!icon || typeof icon !== "object") continue;
    const { src, mimeType, sizes, theme } = icon as { src?: unknown; mimeType?: unknown; sizes?: unknown; theme?: unknown };
    if (typeof src !== "string" || !src.trim()) continue;
    let url = src.trim();
    if (!url.startsWith("data:")) {
      try { url = new URL(url, base).toString(); } catch { continue; }
    }
    const size = parseSizes(Array.isArray(sizes) ? sizes.filter((x): x is string => typeof x === "string") : typeof sizes === "string" ? sizes : undefined);
    const candidate: IconCandidate = {
      url, kind: "mcp",
      ...(typeof mimeType === "string" ? { type: mimeType } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(theme === "light" || theme === "dark" ? { theme } : {}),
    };
    (theme === "dark" ? dark : light).push(candidate);
  }
  return { light: rankCandidates(light), dark: rankCandidates(dark) };
}

const decodeEntities = (s: string) => s
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));

function tagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([^\s=/<>"']+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return attrs;
}

/**
 * The icons and the manifest a page declares: `<link rel>` with the tokens icon, shortcut icon,
 * apple-touch-icon(-precomposed), mask-icon, manifest. Relative hrefs resolve against `<base href>`
 * or the page URL. Only the document head matters, so a truncated page is fine.
 */
export function parseHtmlIcons(html: string, pageUrl: string): { icons: IconCandidate[]; manifest?: string } {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/i.exec(stripped);
  if (baseTag) {
    const href = tagAttributes(baseTag[0]).href;
    if (href) { try { base = new URL(href, pageUrl).toString(); } catch { /* keep the page URL */ } }
  }
  const icons: IconCandidate[] = [];
  let manifest: string | undefined;
  for (const m of stripped.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = tagAttributes(m[0]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!attrs.href || rel.length === 0) continue;
    let url: string;
    try { url = new URL(attrs.href.trim(), base).toString(); } catch { continue; }
    if (!/^https?:/i.test(url)) continue;
    if (rel.includes("manifest")) { manifest ??= url; continue; }
    const kind: IconCandidateKind | undefined = rel.includes("mask-icon") ? "mask-icon"
      : rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed") ? "apple-touch-icon"
      : rel.includes("icon") ? "icon" : undefined;
    if (!kind) continue;
    const size = parseSizes(attrs.sizes);
    icons.push({ url, kind, ...(attrs.type ? { type: attrs.type } : {}), ...(size !== undefined ? { size } : {}) });
  }
  return { icons, ...(manifest ? { manifest } : {}) };
}

/** A web app manifest's icons (purpose "maskable"-only ones are padded for launchers: skipped when others exist). */
export function parseManifestIcons(text: string, manifestUrl: string): IconCandidate[] {
  let data: { icons?: unknown };
  try { data = JSON.parse(text) as { icons?: unknown }; } catch { return []; }
  if (!Array.isArray(data.icons)) return [];
  const all: Array<IconCandidate & { maskable: boolean }> = [];
  for (const icon of data.icons.slice(0, 50)) {
    if (!icon || typeof icon !== "object") continue;
    const { src, type, sizes, purpose } = icon as { src?: unknown; type?: unknown; sizes?: unknown; purpose?: unknown };
    if (typeof src !== "string" || !src.trim()) continue;
    let url: string;
    try { url = new URL(src.trim(), manifestUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(url)) continue;
    const size = parseSizes(typeof sizes === "string" ? sizes : undefined);
    const purposes = typeof purpose === "string" ? purpose.toLowerCase().split(/\s+/) : ["any"];
    all.push({ url, kind: "manifest", ...(typeof type === "string" ? { type } : {}), ...(size !== undefined ? { size } : {}), maskable: !purposes.includes("any") && purposes.includes("maskable") });
  }
  const usable = all.some((c) => !c.maskable) ? all.filter((c) => !c.maskable) : all;
  return usable.map(({ maskable: _m, ...c }) => c);
}

// ── domains ──

/** Two-label public suffixes (co.uk…) and hosting platforms whose subdomains belong to different owners. */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "com.br", "net.br", "org.br", "com.mx", "com.ar", "com.tr", "com.cn",
  "net.cn", "org.cn", "com.hk", "com.sg", "com.tw", "co.in", "net.in", "org.in", "co.za", "co.il", "com.pl", "co.id", "com.my",
  "com.ph", "com.vn", "com.ua", "com.co", "com.pe", "com.es", "co.at", "or.at", "com.pt", "gv.at",
  "vercel.app", "netlify.app", "herokuapp.com", "github.io", "gitlab.io", "pages.dev", "workers.dev", "fly.dev", "onrender.com",
  "railway.app", "up.railway.app", "deno.dev", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "appspot.com", "web.app",
  "firebaseapp.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "replit.app", "glitch.me", "run.app", "supabase.co",
]);

/** The registrable domain of a host (mcp.example.com → example.com; api.foo.co.uk → foo.co.uk); undefined for IPs and single labels. */
export function registrableDomain(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (isIP(h.replace(/^\[|\]$/g, "")) || !h.includes(".")) return undefined;
  const labels = h.split(".");
  for (let take = Math.min(4, labels.length); take >= 2; take--) {
    const suffix = labels.slice(-take).join(".");
    if (MULTI_LABEL_SUFFIXES.has(suffix)) return labels.length > take ? labels.slice(-(take + 1)).join(".") : undefined;
  }
  return labels.slice(-2).join(".");
}

// ── discovery ──

export interface DiscoveredIcon {
  source: "mcp" | "oauth" | "website";
  light: IconImage;
  dark?: IconImage;
}

export interface DiscoveryInput {
  /** The MCP server URL (none for a local stdio server: only its serverInfo icons count). */
  serverUrl?: string;
  /** `serverInfo` from `initialize`, when connected. */
  serverInfo?: { icons?: unknown; websiteUrl?: unknown };
  /** Look at the OAuth metadata (OAuth connectors). */
  oauth?: boolean;
  /** A configured authorization server (issuer), if any. */
  authorizationServer?: string;
}

export interface DiscoveryOptions {
  fetch: IconFetcher;
  log?: (message: string) => void;
  budgetMs?: number;
}

class Budget {
  private readonly deadline: number;
  attempts = 0;
  constructor(ms: number) { this.deadline = Date.now() + ms; }
  get expired() { return Date.now() > this.deadline; }
}

async function fetchJson(fetcher: IconFetcher, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetcher(url, { maxBytes: JSON_MAX_BYTES, accept: "application/json" });
    if (res.status !== 200) return undefined;
    const data = JSON.parse(res.body.toString("utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Well-known metadata URLs: the path-aware form (RFC 9728 / 8414) first, then the root. */
function wellKnown(resource: string, suffix: string): string[] {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/+$/, "");
  const urls = [`${u.origin}/.well-known/${suffix}${path}`];
  if (path) urls.push(`${u.origin}/.well-known/${suffix}`);
  return urls;
}

/** Download candidates best first; the first SVG or ≥ 64 px image wins, else the largest small one. */
async function pickImage(candidates: IconCandidate[], fetcher: IconFetcher, budget: Budget, log?: (m: string) => void): Promise<IconImage | undefined> {
  let fallback: IconImage | undefined;
  for (const candidate of candidates) {
    if (budget.expired || budget.attempts >= MAX_IMAGE_ATTEMPTS) break;
    budget.attempts++;
    try {
      let image: IconImage;
      if (candidate.url.startsWith("data:")) {
        image = toIconImage(decodeDataUri(candidate.url));
      } else {
        const res = await fetcher(candidate.url, { maxBytes: ICON_MAX_BYTES, accept: IMAGE_ACCEPT });
        if (res.status !== 200) throw new IconFetchError(`HTTP ${res.status}`);
        image = toIconImage(res.body, candidate.url);
      }
      // mask icons are monochrome silhouettes: only when nothing else works
      if (candidate.kind === "mask-icon") { fallback ??= image; continue; }
      const size = Math.min(image.width ?? 0, image.height ?? 0);
      if (image.mimeType === "image/svg+xml" || size >= GOOD_SIZE || (image.width === undefined && (candidate.size ?? 0) >= GOOD_SIZE)) return image;
      if (!fallback || size > Math.min(fallback.width ?? 0, fallback.height ?? 0)) fallback = image;
    } catch (err) {
      log?.(`icon ${candidate.url.startsWith("data:") ? "(inline)" : candidate.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return fallback;
}

/** Where the vendor's website may be: websiteUrl, the server's registrable domain, the authorization server's origin. */
export function websiteOrigins(serverUrl: string, extra: Array<string | undefined>): string[] {
  const pages: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:") return;
      const page = u.pathname === "/" || !u.pathname ? `${u.origin}/` : u.toString();
      if (!pages.includes(page)) pages.push(page);
    } catch { /* not a URL */ }
  };
  for (const url of extra) add(url);
  try {
    const host = new URL(serverUrl).hostname;
    const domain = registrableDomain(host);
    if (domain) add(`https://${domain}/`);
  } catch { /* ignore */ }
  return pages;
}

/** The icons one website offers (page links, manifest, /favicon.ico, /apple-touch-icon.png), ranked. */
async function websiteCandidates(page: string, fetcher: IconFetcher, budget: Budget): Promise<IconCandidate[]> {
  const pageUrl = new URL(page);
  let finalOrigin = pageUrl.origin;
  const candidates: IconCandidate[] = [];
  let html: FetchedResource | undefined;
  // an apex domain without a web server of its own: its www host
  const attempts = pageUrl.pathname === "/" && !pageUrl.hostname.startsWith("www.") ? [page, `https://www.${pageUrl.hostname}/`] : [page];
  for (const url of attempts) {
    if (budget.expired) break;
    html = await fetcher(url, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,application/xhtml+xml", truncate: true }).catch(() => undefined);
    if (html) break;
  }
  if (html && html.status === 200 && /html|xml|^$/.test(html.contentType)) {
    finalOrigin = new URL(html.url).origin;
    const parsed = parseHtmlIcons(html.body.toString("utf8"), html.url);
    candidates.push(...parsed.icons);
    if (parsed.manifest && !budget.expired) {
      try {
        const res = await fetcher(parsed.manifest, { maxBytes: JSON_MAX_BYTES, accept: "application/manifest+json,application/json" });
        if (res.status === 200) candidates.push(...parseManifestIcons(res.body.toString("utf8"), res.url));
      } catch { /* no manifest */ }
    }
  }
  candidates.push({ url: `${finalOrigin}/apple-touch-icon.png`, kind: "apple-touch-icon", type: "image/png" });
  candidates.push({ url: `${finalOrigin}/favicon.ico`, kind: "favicon" });
  return rankCandidates(candidates);
}

/** Run the discovery (see the module comment). Undefined when nothing usable was found. */
export async function discoverConnectorIcon(input: DiscoveryInput, options: DiscoveryOptions): Promise<DiscoveredIcon | undefined> {
  const budget = new Budget(options.budgetMs ?? DISCOVERY_BUDGET_MS);
  const { fetch: fetcher, log } = options;

  // 1. the server's own icons
  const mcp = mcpIconCandidates(input.serverInfo?.icons, input.serverUrl);
  if (mcp.light.length || mcp.dark.length) {
    const light = await pickImage(mcp.light.length ? mcp.light : mcp.dark, fetcher, budget, log);
    const dark = light && mcp.light.length && mcp.dark.length ? await pickImage(mcp.dark, fetcher, budget, log) : undefined;
    if (light) return { source: "mcp", light, ...(dark ? { dark } : {}) };
  }
  const websiteUrl = typeof input.serverInfo?.websiteUrl === "string" ? input.serverInfo.websiteUrl : undefined;
  const serverUrl = input.serverUrl;
  if (!serverUrl) {
    // a local server: only its website, if it named one
    if (!websiteUrl) return undefined;
    for (const page of websiteOrigins(websiteUrl, [websiteUrl]).slice(0, 2)) {
      if (budget.expired) break;
      const light = await pickImage(await websiteCandidates(page, fetcher, budget).catch(() => [] as IconCandidate[]), fetcher, budget, log);
      if (light) return { source: "website", light };
    }
    return undefined;
  }

  // 2. OAuth metadata
  const authServers: string[] = [];
  if (input.authorizationServer) authServers.push(input.authorizationServer);
  if (input.oauth && !budget.expired) {
    const logos: IconCandidate[] = [];
    let prm: Record<string, unknown> | undefined;
    for (const url of wellKnown(serverUrl, "oauth-protected-resource")) {
      prm = await fetchJson(fetcher, url);
      if (prm || budget.expired) break;
    }
    if (typeof prm?.logo_uri === "string") logos.push({ url: prm.logo_uri, kind: "oauth" });
    if (Array.isArray(prm?.authorization_servers)) {
      for (const s of prm.authorization_servers) if (typeof s === "string" && !authServers.includes(s)) authServers.push(s);
    }
    const issuer = authServers[0];
    if (issuer && !budget.expired) {
      try {
        let asMeta: Record<string, unknown> | undefined;
        for (const url of [...wellKnown(issuer, "oauth-authorization-server").slice(0, 1), `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`]) {
          asMeta = await fetchJson(fetcher, url);
          if (asMeta || budget.expired) break;
        }
        if (typeof asMeta?.logo_uri === "string") logos.push({ url: asMeta.logo_uri, kind: "oauth" });
      } catch { /* bad issuer URL */ }
    }
    const resolved = logos.flatMap((c) => { try { return [{ ...c, url: new URL(c.url, serverUrl).toString() }]; } catch { return []; } });
    const light = await pickImage(resolved, fetcher, budget, log);
    if (light) return { source: "oauth", light };
  }

  // 3. the website(s)
  const origins = websiteOrigins(serverUrl, [websiteUrl]);
  for (const s of authServers) {
    try {
      const page = `${new URL(s).origin}/`;
      if (!origins.includes(page)) origins.push(page);
    } catch { /* ignore */ }
  }
  for (const page of origins.slice(0, 3)) {
    if (budget.expired) break;
    const candidates = await websiteCandidates(page, fetcher, budget).catch(() => [] as IconCandidate[]);
    const light = await pickImage(candidates, fetcher, budget, log);
    if (light) return { source: "website", light };
  }
  return undefined;
}
