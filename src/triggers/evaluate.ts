/**
 * The pure parts of a trigger's reception: authentication (generated secret, HMAC, IP allowlist),
 * parsing by content type, the contract (JSON Schema, with the repo's validator), the filter, the
 * dedupe key and the mapping (both with the hosted servers' safe templates — no eval), schema
 * inference from a sample, and the checks on a definition.
 */
import { BlockList, isIP } from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { validateJsonSchema } from "@polpo-ai/core";
import { getPath, matchesFilter, placeholdersOf, renderString, renderValue, TemplateError, type TemplateScope } from "../mcp-servers/template.js";
import type { HttpResponseFilter } from "../mcp-servers/types.js";
import { redactWebhookPayload } from "../sandbox/computer-webhook-events.js";
import {
  TRIGGER_FILTER_OPS, TRIGGER_LIMITS,
  type TriggerContentType, type TriggerContract, type TriggerFileMeta, type TriggerFilter, type TriggerFilterCondition,
  type TriggerHmacConfig, type TriggerSecretRecord,
} from "./types.js";

// ── Secrets ──────────────────────────────────────────────────────────

/** A new generated secret: "pts_" + 32 random bytes (base64url). */
export function generateTriggerSecret(): string {
  return `pts_${randomBytes(32).toString("base64url")}`;
}

export const hashSecret = (secret: string): string => createHash("sha256").update(secret, "utf8").digest("hex");

/** Constant-time comparison of two strings (hashed first, so lengths always match). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** The secret record that matches, among the ones still valid (every record is compared: no early exit). */
export function matchSecret(given: string, records: TriggerSecretRecord[], now: number): TriggerSecretRecord | undefined {
  const h = hashSecret(given);
  let hit: TriggerSecretRecord | undefined;
  for (const r of records) {
    const valid = !r.expiresAt || Date.parse(r.expiresAt) > now;
    const eq = timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(r.hash.padEnd(64, "0").slice(0, 64), "hex"));
    if (eq && valid && !hit) hit = r;
  }
  return hit;
}

/** The secret a request carries, and where. */
export function providedSecret(header: (name: string) => string | undefined, query: URLSearchParams, allowQuery: boolean): { value: string; via: "bearer" | "header" | "query" } | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(header("authorization") ?? "")?.[1]?.trim();
  if (bearer) return { value: bearer, via: "bearer" };
  const h = header("x-polpo-secret")?.trim();
  if (h) return { value: h, via: "header" };
  const q = allowQuery ? query.get("token")?.trim() : undefined;
  if (q) return { value: q, via: "query" };
  return undefined;
}

// ── HMAC ─────────────────────────────────────────────────────────────

/** A timestamp header's value as epoch ms (seconds, ms or ISO), or undefined. */
export function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (/^\d{9,11}(?:\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (/^\d{12,14}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** The signature candidates in a header: the prefix stripped; "t=…,v1=…" and space- or comma-separated lists split. */
function signatureCandidates(value: string, prefix: string | undefined): string[] {
  const parts = value.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts.length ? parts : [value]) {
    let s = p;
    if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
    else if (/^[a-z0-9]+=/i.test(s) && !prefix) s = s.slice(s.indexOf("=") + 1);
    else if (prefix && !s.startsWith(prefix) && /^[a-z0-9]+=/i.test(s)) continue;
    if (s) out.push(s);
  }
  return out;
}

export type HmacOutcome = { ok: true; which: "current" | "previous"; note?: string } | { ok: false; reason: string };

/**
 * Check an HMAC signature over the raw body (byte for byte). `secrets`: the current secret and, during
 * a rotation's overlap, the previous one. Every comparison is constant-time.
 */
export function verifyHmac(cfg: TriggerHmacConfig, raw: Buffer, header: (name: string) => string | undefined, secrets: { current?: string; previous?: string }, now: number): HmacOutcome {
  if (cfg.scheme === "standard-webhooks") return verifyStandardWebhook(cfg, raw, header, secrets, now);
  const sigHeader = header(cfg.header.toLowerCase());
  if (!sigHeader) return { ok: false, reason: `Missing signature header ${cfg.header}` };
  let timestamp: string | undefined;
  if (cfg.timestampHeader) {
    timestamp = header(cfg.timestampHeader.toLowerCase())?.trim();
    const at = parseTimestamp(timestamp);
    if (at === undefined) return { ok: false, reason: `Missing or unreadable timestamp header ${cfg.timestampHeader}` };
    const tolerance = (cfg.toleranceSeconds ?? TRIGGER_LIMITS.defaultToleranceSeconds) * 1000;
    if (Math.abs(now - at) > tolerance) return { ok: false, reason: `Timestamp outside the tolerance (${cfg.toleranceSeconds ?? TRIGGER_LIMITS.defaultToleranceSeconds}s): a replay or a clock skew` };
  }
  const template = cfg.signedPayload?.trim() || "{body}";
  const [before, after] = splitOnce(template, "{body}");
  const fill = (s: string) => s.replace(/\{timestamp\}/g, timestamp ?? "");
  const signed = after === undefined ? Buffer.from(fill(template), "utf8") : Buffer.concat([Buffer.from(fill(before), "utf8"), raw, Buffer.from(fill(after), "utf8")]);
  const candidates = signatureCandidates(sigHeader.trim(), cfg.prefix);
  if (candidates.length === 0) return { ok: false, reason: `Empty signature in ${cfg.header}` };
  const check = (secret: string | undefined) => {
    if (!secret) return false;
    const expected = createHmac(cfg.algorithm, secret).update(signed).digest();
    let match = false;
    for (const c of candidates) {
      const given = decodeSignature(c, cfg.encoding);
      if (given && given.length === expected.length && timingSafeEqual(given, expected)) match = true;
    }
    return match;
  };
  if (!secrets.current && !secrets.previous) return { ok: false, reason: "The HMAC secret is not set" };
  const current = check(secrets.current);
  const previous = check(secrets.previous);
  if (current) return { ok: true, which: "current" };
  if (previous) return { ok: true, which: "previous" };
  return { ok: false, reason: "Invalid signature" };
}

/** The key of a Standard Webhooks secret: "whsec_<base64>" (or bare base64) decoded; anything else as UTF-8 bytes. */
export function standardWebhookKey(secret: string): Buffer {
  const s = secret.trim().replace(/^whsec_/, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) {
    const key = Buffer.from(s, "base64");
    if (key.length > 0) return key;
  }
  return Buffer.from(secret, "utf8");
}

/**
 * Standard Webhooks: HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{raw body}", base64, compared in
 * constant time with every "v1,<sig>" of webhook-signature (space-separated, e.g. during a rotation);
 * timestamps (unix seconds) outside the tolerance are refused.
 */
function verifyStandardWebhook(cfg: TriggerHmacConfig, raw: Buffer, header: (name: string) => string | undefined, secrets: { current?: string; previous?: string }, now: number): HmacOutcome {
  const id = header("webhook-id")?.trim();
  const ts = header("webhook-timestamp")?.trim();
  const sigs = header("webhook-signature")?.trim();
  if (!id) return { ok: false, reason: "Missing header webhook-id" };
  if (!ts || !/^\d+$/.test(ts)) return { ok: false, reason: "Missing or unreadable header webhook-timestamp" };
  if (!sigs) return { ok: false, reason: "Missing header webhook-signature" };
  const tolerance = cfg.toleranceSeconds ?? TRIGGER_LIMITS.defaultToleranceSeconds;
  if (Math.abs(now - Number(ts) * 1000) > tolerance * 1000) return { ok: false, reason: `Timestamp outside the tolerance (${tolerance}s): a replay or a clock skew` };
  const candidates = sigs.split(/\s+/).filter((s) => s.startsWith("v1,")).map((s) => Buffer.from(s.slice(3), "base64"));
  if (candidates.length === 0) return { ok: false, reason: "No v1 signature in webhook-signature" };
  const signed = Buffer.concat([Buffer.from(`${id}.${ts}.`, "utf8"), raw]);
  // The spec's key is the decoded base64 after "whsec_"; some senders sign with the secret as text
  // (whole, or without the prefix): accept those too, and say so on the delivery.
  const keys = (secret: string): Array<{ key: Buffer; as: string }> => {
    const out = [{ key: standardWebhookKey(secret), as: "decoded" }];
    const t = secret.trim();
    for (const [k, as] of [[t, "text"], [t.replace(/^whsec_/, ""), "text without whsec_"]] as const) {
      const b = Buffer.from(k, "utf8");
      if (!out.some((o) => o.key.equals(b))) out.push({ key: b, as });
    }
    return out;
  };
  const check = (secret: string | undefined): string | undefined => {
    if (!secret) return undefined;
    for (const { key, as } of keys(secret)) {
      const expected = createHmac("sha256", key).update(signed).digest();
      for (const given of candidates) if (given.length === expected.length && timingSafeEqual(given, expected)) return as;
    }
    return undefined;
  };
  if (!secrets.current && !secrets.previous) return { ok: false, reason: "The HMAC secret is not set" };
  const cur = check(secrets.current);
  if (cur) return { ok: true, which: "current", ...(cur !== "decoded" ? { note: `signed with the secret as ${cur}` } : {}) };
  const prev = check(secrets.previous);
  if (prev) return { ok: true, which: "previous", ...(prev !== "decoded" ? { note: `signed with the secret as ${prev}` } : {}) };
  const sec = (secrets.current ?? secrets.previous ?? "").trim();
  const fmt = /^whsec_/.test(sec) ? `whsec_ + ${standardWebhookKey(sec).length}-byte key` : `no whsec_ prefix (${sec.length} characters)`;
  return { ok: false, reason: `Invalid signature (${candidates.length} v1 signature(s), ${raw.length}-byte body, stored secret: ${fmt}) — is the secret the one of this webhook?` };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + sep.length)];
}

function decodeSignature(s: string, encoding: "hex" | "base64"): Buffer | undefined {
  if (encoding === "hex") return /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? Buffer.from(s, "hex") : undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return undefined;
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Sign a body the way a trigger expects (tests, "send a test delivery" with HMAC, docs examples). */
export function signHmac(cfg: TriggerHmacConfig, raw: Buffer | string, secret: string, timestamp?: string): string {
  const body = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const template = cfg.signedPayload?.trim() || "{body}";
  const [before, after] = splitOnce(template, "{body}");
  const fill = (s: string) => s.replace(/\{timestamp\}/g, timestamp ?? "");
  const signed = after === undefined ? Buffer.from(fill(template), "utf8") : Buffer.concat([Buffer.from(fill(before), "utf8"), body, Buffer.from(fill(after), "utf8")]);
  return `${cfg.prefix ?? ""}${createHmac(cfg.algorithm, secret).update(signed).digest(cfg.encoding)}`;
}

// ── IP allowlist ─────────────────────────────────────────────────────

function normalizeIp(ip: string): string {
  const v = ip.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  return mapped ? mapped[1]! : v;
}

/** A CIDR or a single address, or an error. */
export function parseCidr(entry: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | string {
  const [addr, bits] = entry.trim().split("/");
  const address = normalizeIp(addr ?? "");
  const v = isIP(address);
  if (!v) return `"${entry}" is not an IP address or CIDR`;
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return `"${entry}": the prefix must be 0–${max}`;
  return { address, prefix, family: v === 4 ? "ipv4" : "ipv6" };
}

/** Is this address in the allowlist? An empty list allows any. */
export function ipAllowed(ip: string | undefined, allowlist: string[] | undefined): boolean {
  if (!allowlist?.length) return true;
  if (!ip) return false;
  const address = normalizeIp(ip);
  const family = isIP(address);
  if (!family) return false;
  const list = new BlockList();
  for (const e of allowlist) {
    const c = parseCidr(e);
    if (typeof c === "string") continue;
    list.addSubnet(c.address, c.prefix, c.family);
  }
  return list.check(address, family === 4 ? "ipv4" : "ipv6");
}

const PRIVATE_SOCKET = /^(?:127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fd|fc)/i;

/**
 * The sender's address: behind a local proxy (Tailscale serve / Funnel, a reverse proxy on a private
 * address), the last X-Forwarded-For entry — the one the nearest proxy added, which the sender
 * cannot forge; otherwise the socket's.
 */
export function senderIp(socketIp: string | undefined, forwardedFor: string | undefined): string | undefined {
  const socket = socketIp ? normalizeIp(socketIp) : undefined;
  if (forwardedFor && (!socket || PRIVATE_SOCKET.test(socket))) {
    const last = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return normalizeIp(last);
  }
  return socket;
}

// ── Parsing ──────────────────────────────────────────────────────────

/** The content kind of a Content-Type header. */
export function contentKind(contentType: string | undefined): TriggerContentType | undefined {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (ct === "application/json" || ct.endsWith("+json")) return "json";
  if (ct === "application/x-www-form-urlencoded") return "form";
  if (ct === "multipart/form-data") return "multipart";
  if (ct.startsWith("text/") || ct === "") return "text";
  return undefined;
}

export class TriggerParseError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) { super(message); }
}

/** Fields of a form: a repeated name becomes a list. */
function addField(out: Record<string, unknown>, name: string, value: unknown): void {
  if (!(name in out)) out[name] = value;
  else if (Array.isArray(out[name])) (out[name] as unknown[]).push(value);
  else out[name] = [out[name], value];
}

/** Parse a raw body by its kind; multipart files become metadata (their content is not kept). */
export async function parseBody(raw: Buffer, kind: TriggerContentType, contentType: string, maxFileBytes: number): Promise<{ body: unknown; files?: TriggerFileMeta[] }> {
  if (kind === "json") {
    if (raw.length === 0) throw new TriggerParseError("Empty JSON body", 400);
    try { return { body: JSON.parse(raw.toString("utf8")) }; } catch { throw new TriggerParseError("Invalid JSON body", 400); }
  }
  if (kind === "text") return { body: raw.toString("utf8") };
  if (kind === "form") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) addField(out, k, v);
    return { body: out };
  }
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new TriggerParseError("Invalid multipart body", 400);
  }
  const out: Record<string, unknown> = {};
  const files: TriggerFileMeta[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") { addField(out, name, value); continue; }
    if (value.size > maxFileBytes) throw new TriggerParseError(`File "${value.name}" is too large (${value.size} bytes; at most ${maxFileBytes})`, 413);
    const bytes = Buffer.from(await value.arrayBuffer());
    const meta: TriggerFileMeta = { field: name, filename: value.name || "file", contentType: value.type || "application/octet-stream", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    files.push(meta);
    addField(out, name, { filename: meta.filename, contentType: meta.contentType, size: meta.size });
  }
  return { body: out, files };
}

// ── Redaction for storage ────────────────────────────────────────────

const SECRET_HEADER = /authori[sz]ation|cookie|secret|token|signature|api[-_]?key|password|credential/i;

/** Headers to store: secret ones (and the trigger's own signature header) replaced, each capped, at most 60. */
export function storableHeaders(headers: Headers | Record<string, string>, extraSecret: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const extra = new Set(extraSecret.map((h) => h.toLowerCase()));
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [rawName, value] of entries.slice(0, 60)) {
    const name = rawName.toLowerCase();
    out[name] = SECRET_HEADER.test(name) || extra.has(name) ? "[redacted]" : String(value).slice(0, 500);
  }
  return out;
}

/** The query string to store (token removed), repeated keys as lists. */
export function storableQuery(query: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of query) {
    const value = k === "token" || SECRET_HEADER.test(k) ? "[redacted]" : v.slice(0, 500);
    if (!(k in out)) out[k] = value;
    else out[k] = Array.isArray(out[k]) ? [...(out[k] as string[]), value] : [out[k] as string, value];
  }
  return out;
}

/** The body to store: secret-looking keys redacted, capped (a truncated text when too large). */
export function storableBody(body: unknown, max: number = TRIGGER_LIMITS.storedBodyBytes): { body?: unknown; truncated?: boolean } {
  if (body === undefined) return {};
  const redacted = redactWebhookPayload(body);
  const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  if (Buffer.byteLength(text) <= max) return { body: redacted };
  return { body: `${Buffer.from(text).subarray(0, max).toString("utf8")}…`, truncated: true };
}

// ── Templates, filter, dedupe, mapping ───────────────────────────────

/** The roots templates and filters read. */
export const TEMPLATE_ROOTS = ["body", "headers", "query"] as const;

export interface DeliveryScope {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
}

const scopeOf = (s: DeliveryScope): TemplateScope => ({ input: {}, vars: { body: s.body, headers: s.headers, query: s.query } });

/** A hosted-server filter rule (its comparisons: equals and contains case-insensitive, in, gte / lte numeric). */
const rule = (path: string, match: NonNullable<HttpResponseFilter["match"]>, value: unknown): HttpResponseFilter =>
  ({ path, match, value: value as HttpResponseFilter["value"] });

/** Does one condition hold? Paths read body / headers / query. */
export function conditionHolds(c: TriggerFilterCondition, s: DeliveryScope): boolean {
  const root = { body: s.body, headers: s.headers, query: s.query };
  const actual = getPath(root, c.path);
  switch (c.op) {
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "not_exists": return actual === undefined || actual === null || actual === "";
    case "not_equals": return !matchesFilter(root, rule(c.path, "equals", c.value), {});
    default: {
      if (c.value === undefined || c.value === null || c.value === "") return actual !== undefined && actual !== null && actual !== "";
      return matchesFilter(root, rule(c.path, c.op, c.value), {});
    }
  }
}

/** Does the delivery pass the filter? No filter (or no conditions): yes. */
export function filterMatches(filter: TriggerFilter | undefined, s: DeliveryScope): boolean {
  if (!filter?.conditions?.length) return true;
  const results = filter.conditions.map((c) => conditionHolds(c, s));
  return (filter.mode ?? "all") === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** The dedupe key's value; undefined when its values are missing (then no dedupe). */
export function dedupeKeyOf(template: string, s: DeliveryScope): string | undefined {
  try { return renderString(template, scopeOf(s)) || undefined; } catch { return undefined; }
}

export const dedupeHash = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);

/** The mapping's values (a template that is one placeholder keeps its JSON type). */
export function applyMapping(mapping: Record<string, string> | undefined, s: DeliveryScope): { mapped?: Record<string, unknown>; errors?: string[] } {
  if (!mapping || Object.keys(mapping).length === 0) return {};
  const mapped: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [name, template] of Object.entries(mapping)) {
    try {
      const v = renderValue(template, scopeOf(s));
      mapped[name] = v === undefined ? null : v;
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { mapped: redactWebhookPayload(mapped) as Record<string, unknown>, ...(errors.length ? { errors } : {}) };
}

/** Contract errors for a parsed body (JSON Schema). */
export function contractErrors(contract: TriggerContract, body: unknown): string[] {
  if (!contract.schema) return [];
  return validateJsonSchema(contract.schema, body, "body").slice(0, 50);
}

// ── Schema inference ─────────────────────────────────────────────────

const FORMATS: Array<[string, RegExp]> = [
  ["date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["uri", /^https?:\/\/\S+$/],
];

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.type === "object" && b.type === "object") {
    const pa = (a.properties ?? {}) as Record<string, Record<string, unknown>>;
    const pb = (b.properties ?? {}) as Record<string, Record<string, unknown>>;
    const props: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) props[k] = pa[k] && pb[k] ? merge(pa[k]!, pb[k]!) : (pa[k] ?? pb[k]);
    const ra = new Set((a.required ?? []) as string[]);
    const required = ((b.required ?? []) as string[]).filter((k) => ra.has(k));
    return { type: "object", properties: props, ...(required.length ? { required } : {}) };
  }
  if (a.type === "array" && b.type === "array") return { type: "array", ...(a.items && b.items ? { items: merge(a.items as Record<string, unknown>, b.items as Record<string, unknown>) } : { items: a.items ?? b.items }) };
  if ((a.type === "integer" && b.type === "number") || (a.type === "number" && b.type === "integer")) return { type: "number" };
  if (a.type === b.type) {
    const { format: _fa, ...ra } = a;
    return ra;
  }
  const types = [...new Set([a.type, b.type].flat())].filter(Boolean) as string[];
  return { type: types };
}

/** A JSON Schema describing a sample (every key present is required; lists' items merged). */
export function inferJsonSchema(sample: unknown, depth = 0): Record<string, unknown> {
  if (depth > 20) return {};
  if (sample === null) return { type: "null" };
  if (Array.isArray(sample)) {
    if (!sample.length) return { type: "array" };
    return { type: "array", items: sample.slice(0, 50).map((x) => inferJsonSchema(x, depth + 1)).reduce(merge) };
  }
  switch (typeof sample) {
    case "string": {
      const f = FORMATS.find(([, re]) => re.test(sample));
      return { type: "string", ...(f ? { format: f[0] } : {}) };
    }
    case "number": return { type: Number.isInteger(sample) ? "integer" : "number" };
    case "boolean": return { type: "boolean" };
    case "object": {
      const entries = Object.entries(sample as Record<string, unknown>).slice(0, 200);
      return {
        type: "object",
        properties: Object.fromEntries(entries.map(([k, v]) => [k, inferJsonSchema(v, depth + 1)])),
        ...(entries.length ? { required: entries.filter(([, v]) => v !== null && v !== undefined).map(([k]) => k) } : {}),
      };
    }
    default: return {};
  }
}

// ── Checks on a definition ───────────────────────────────────────────

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/** Problems with templates: unknown roots (body, headers, query only) and bad syntax. */
export function templateProblems(where: string, template: string, roots: readonly string[] = TEMPLATE_ROOTS, maxChars = 500): string[] {
  const problems: string[] = [];
  if (typeof template !== "string" || !template.trim()) return [`${where}: an empty template`];
  if (template.length > maxChars) problems.push(`${where}: longer than ${maxChars} characters`);
  if (!/\{\{/.test(template)) return problems; // a literal
  try {
    for (const p of placeholdersOf(template)) {
      const root = p.split(/[.[]/)[0];
      if (!roots.includes(root ?? "")) {
        const names = roots.map((r) => `${r}.*`);
        problems.push(`${where}: {{${p}}} — use ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]}`);
      }
    }
    renderValue(template, { input: {}, vars: Object.fromEntries(roots.map((r) => [r, {}])) });
  } catch (err) {
    problems.push(`${where}: ${err instanceof TemplateError || err instanceof Error ? err.message : String(err)}`);
  }
  return problems;
}

export function hmacProblems(h: TriggerHmacConfig): string[] {
  const p: string[] = [];
  if (h.scheme !== undefined && h.scheme !== "standard-webhooks") p.push("hmac.scheme: standard-webhooks (or absent for the generic HMAC)");
  if (h.scheme === "standard-webhooks") {
    if (h.toleranceSeconds !== undefined && (!Number.isInteger(h.toleranceSeconds) || h.toleranceSeconds < 1 || h.toleranceSeconds > 86_400)) p.push("hmac.toleranceSeconds: 1–86400");
    return p;
  }
  if (!HEADER_NAME.test(h.header ?? "")) p.push("hmac.header: a header name (e.g. x-hub-signature-256)");
  if (h.algorithm !== "sha256" && h.algorithm !== "sha1") p.push("hmac.algorithm: sha256 or sha1");
  if (h.encoding !== "hex" && h.encoding !== "base64") p.push("hmac.encoding: hex or base64");
  if (h.prefix !== undefined && (typeof h.prefix !== "string" || h.prefix.length > 40)) p.push("hmac.prefix: at most 40 characters");
  if (h.timestampHeader !== undefined && !HEADER_NAME.test(h.timestampHeader)) p.push("hmac.timestampHeader: a header name");
  if (h.toleranceSeconds !== undefined && (!Number.isInteger(h.toleranceSeconds) || h.toleranceSeconds < 1 || h.toleranceSeconds > 86_400)) p.push("hmac.toleranceSeconds: 1–86400");
  if (h.signedPayload !== undefined) {
    if (typeof h.signedPayload !== "string" || h.signedPayload.length > 200 || !h.signedPayload.includes("{body}")) p.push("hmac.signedPayload: a template with {body} (and {timestamp}), e.g. {timestamp}.{body}");
    else if (h.signedPayload.includes("{timestamp}") && !h.timestampHeader) p.push("hmac.signedPayload uses {timestamp}: set hmac.timestampHeader");
  }
  return p;
}

export function filterProblems(f: TriggerFilter): string[] {
  const p: string[] = [];
  if (f.mode !== undefined && f.mode !== "all" && f.mode !== "any") p.push("filter.mode: all or any");
  if (!Array.isArray(f.conditions)) return [...p, "filter.conditions: a list"];
  if (f.conditions.length > TRIGGER_LIMITS.maxFilterConditions) p.push(`filter: at most ${TRIGGER_LIMITS.maxFilterConditions} conditions`);
  f.conditions.forEach((c, i) => {
    if (!TRIGGER_FILTER_OPS.includes(c.op)) p.push(`filter.conditions[${i}].op: one of ${TRIGGER_FILTER_OPS.join(", ")}`);
    const root = (c.path ?? "").split(/[.[]/)[0];
    if (!(TEMPLATE_ROOTS as readonly string[]).includes(root ?? "")) p.push(`filter.conditions[${i}].path: starts with body, headers or query (e.g. body.status)`);
    if (["gte", "lte"].includes(c.op) && (c.value === undefined || Number.isNaN(Number(c.value)))) p.push(`filter.conditions[${i}].value: a number for ${c.op}`);
    if (c.op === "in" && !Array.isArray(c.value)) p.push(`filter.conditions[${i}].value: a list for in`);
  });
  return p;
}

export function contractProblems(c: TriggerContract): string[] {
  const p: string[] = [];
  if (!Array.isArray(c.contentTypes) || c.contentTypes.length === 0) p.push("contract.contentTypes: at least one of json, form, multipart, text");
  else for (const t of c.contentTypes) if (!["json", "form", "multipart", "text"].includes(t)) p.push(`contract.contentTypes: "${t}" is not json, form, multipart or text`);
  if (!Number.isInteger(c.maxBodyBytes) || c.maxBodyBytes < 1 || c.maxBodyBytes > TRIGGER_LIMITS.maxBodyBytes) p.push(`contract.maxBodyBytes: 1–${TRIGGER_LIMITS.maxBodyBytes}`);
  if (c.maxFileBytes !== undefined && (!Number.isInteger(c.maxFileBytes) || c.maxFileBytes < 1 || c.maxFileBytes > TRIGGER_LIMITS.maxBodyBytes)) p.push(`contract.maxFileBytes: 1–${TRIGGER_LIMITS.maxBodyBytes}`);
  if (c.schema !== undefined && (typeof c.schema !== "object" || c.schema === null || Array.isArray(c.schema))) p.push("contract.schema: a JSON Schema object");
  else if (c.schema && JSON.stringify(c.schema).length > 200_000) p.push("contract.schema: too large (200 KB at most)");
  return p;
}
