/**
 * Custom LLM providers / AI gateways — shared zod schemas and validation.
 *
 * Used by the config parser and the server routes. Secrets are never part of these
 * shapes: keys and secret headers live in the vault (owner "$providers", service =
 * provider id). Pure helpers and presets live in `provider-presets` (re-exported here).
 */

import { z } from "zod";
import type { CustomModelDef, ProviderAuthConfig, ProviderConfig } from "./types.js";
import {
  ENV_VAR_RE,
  HEADER_NAME_RE,
  PROVIDER_APIS,
  defaultAuthFor,
  envVarPolicyError,
  normalizeBaseUrl,
  sanitizeCompat,
} from "./provider-presets.js";

export * from "./provider-presets.js";

// ── Zod schemas ─────────────────────────────────────────────────────

/**
 * Headers that can never be configured (static or secret): transport headers Polpo manages,
 * and cloud-metadata request headers (IMDSv2 / GCP / Azure) that only make sense for SSRF.
 */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "content-type",
  "metadata-flavor", "metadata", "x-google-metadata-request",
  "x-aws-ec2-metadata-token", "x-aws-ec2-metadata-token-ttl-seconds", "x-identity-header",
]);

export function isReservedHeader(name: string): boolean {
  return RESERVED_HEADERS.has(name.toLowerCase());
}

export const providerApiSchema = z.enum(PROVIDER_APIS);

export const providerAuthSchema = z.object({
  type: z.enum(["none", "bearer", "x-api-key", "header"]),
  headerName: z.string().regex(HEADER_NAME_RE, "invalid header name").optional(),
  prefix: z.string().max(40).regex(/^[^\r\n]*$/, "invalid prefix").optional(),
  envVar: z.string().regex(ENV_VAR_RE, "invalid environment variable name").optional(),
}).refine((a) => a.type !== "header" || !!a.headerName, { message: "headerName is required for header auth", path: ["headerName"] });

export const headerMapSchema = z.record(
  z.string().regex(HEADER_NAME_RE, "invalid header name").refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), "reserved header"),
  z.string().max(4096).regex(/^[^\r\n]*$/, "header values cannot contain newlines"),
);

const costSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).default(0),
  cacheWrite: z.number().min(0).default(0),
});

export const customModelSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[^\s]+$/, "model id cannot contain whitespace"),
  name: z.string().min(1).max(200).optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).optional(),
  cost: costSchema.optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  maxTokens: z.number().int().positive().max(10_000_000).optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
});

/** Full custom-provider definition as accepted by the API / stored in polpo.json. */
export const customProviderSchema = z.object({
  label: z.string().max(80).optional(),
  preset: z.string().max(40).optional(),
  proxyFor: z.string().max(60).optional(),
  api: providerApiSchema.default("openai-completions"),
  baseUrl: z.string().min(1).max(2048),
  auth: providerAuthSchema.optional(),
  headers: headerMapSchema.optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  models: z.array(customModelSchema).max(2000).optional(),
});

export type CustomProviderInput = z.input<typeof customProviderSchema>;

/** Secret material accepted (write-only) alongside a provider definition. */
export const providerSecretsSchema = z.object({
  /** New API key. Empty string removes the stored key; undefined keeps it. */
  apiKey: z.string().max(8192).regex(/^[^\r\n]*$/, "key cannot contain newlines").optional(),
  /** Secret headers. A null/empty value removes that header. */
  secretHeaders: z.record(
    z.string().regex(HEADER_NAME_RE, "invalid header name").refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), "reserved header"),
    z.string().max(4096).regex(/^[^\r\n]*$/, "header values cannot contain newlines").nullable(),
  ).optional(),
});

export function validateCustomProvider(
  input: unknown,
  opts: { confirmedBuiltinReuse?: boolean } = {},
): { ok: true; config: ProviderConfig } | { ok: false; errors: string[] } {
  const parsed = customProviderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "provider"}: ${i.message}`) };
  }
  const p = parsed.data;
  const api = p.api;
  const base = normalizeBaseUrl(p.baseUrl, api);
  if (base.error || !base.url) return { ok: false, errors: [`baseUrl: ${base.error ?? "invalid"}`] };
  if (p.auth && p.auth.type !== "none") {
    const envError = envVarPolicyError(p.auth.envVar, { baseUrl: base.url, proxyFor: p.proxyFor }, opts);
    if (envError) return { ok: false, errors: [`auth.envVar: ${envError}`] };
  }
  const seen = new Set<string>();
  const models: CustomModelDef[] = [];
  for (const m of p.models ?? []) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const def: CustomModelDef = { id: m.id, name: m.name?.trim() || m.id };
    if (m.reasoning !== undefined) def.reasoning = m.reasoning;
    if (m.input) def.input = [...new Set(m.input)];
    if (m.cost) def.cost = { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead ?? 0, cacheWrite: m.cost.cacheWrite ?? 0 };
    if (m.contextWindow) def.contextWindow = m.contextWindow;
    if (m.maxTokens) def.maxTokens = m.maxTokens;
    const compat = sanitizeCompat(api, m.compat);
    if (compat) def.compat = compat;
    models.push(def);
  }
  const config: ProviderConfig = { api, baseUrl: base.url };
  if (p.label?.trim()) config.label = p.label.trim();
  if (p.preset) config.preset = p.preset;
  if (p.proxyFor) config.proxyFor = p.proxyFor;
  config.auth = p.auth ? cleanAuth(p.auth) : defaultAuthFor(api);
  if (p.headers && Object.keys(p.headers).length > 0) config.headers = p.headers;
  const compat = sanitizeCompat(api, p.compat);
  if (compat) config.compat = compat;
  if (p.allowPrivateNetwork) config.allowPrivateNetwork = true;
  if (p.timeoutMs !== undefined) config.timeoutMs = p.timeoutMs;
  if (p.maxRetries !== undefined) config.maxRetries = p.maxRetries;
  config.models = models;
  return { ok: true, config };
}

function cleanAuth(a: z.infer<typeof providerAuthSchema>): ProviderAuthConfig {
  const out: ProviderAuthConfig = { type: a.type };
  if (a.type === "header") {
    out.headerName = a.headerName;
    if (a.prefix) out.prefix = a.prefix;
  }
  if (a.type !== "none" && a.envVar) out.envVar = a.envVar;
  return out;
}

/**
 * Lenient parse of a stored provider entry (polpo.json). Unknown keys are dropped,
 * invalid optional fields are ignored instead of failing the whole config.
 */
export function parseStoredProvider(raw: unknown): ProviderConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const pc: ProviderConfig = {};
  if (typeof c.label === "string" && c.label.trim()) pc.label = c.label.trim().slice(0, 80);
  if (typeof c.preset === "string") pc.preset = c.preset;
  if (typeof c.proxyFor === "string") pc.proxyFor = c.proxyFor;
  if (typeof c.baseUrl === "string") pc.baseUrl = c.baseUrl;
  const api = providerApiSchema.safeParse(c.api);
  if (api.success) pc.api = api.data;
  if (c.auth !== undefined) {
    const auth = providerAuthSchema.safeParse(c.auth);
    if (auth.success) pc.auth = cleanAuth(auth.data);
  }
  if (c.headers !== undefined) {
    const headers = headerMapSchema.safeParse(c.headers);
    if (headers.success && Object.keys(headers.data).length > 0) pc.headers = headers.data;
  }
  const effectiveApi = pc.api ?? "openai-completions";
  const compat = sanitizeCompat(effectiveApi, c.compat);
  if (compat) pc.compat = compat;
  // Keep an explicit `false` (e.g. Ink-imported providers): it must never be upgraded by the
  // legacy "hand-written entry" rule at runtime.
  if (typeof c.allowPrivateNetwork === "boolean") pc.allowPrivateNetwork = c.allowPrivateNetwork;
  if (typeof c.timeoutMs === "number" && c.timeoutMs >= 1_000 && c.timeoutMs <= 3_600_000) pc.timeoutMs = Math.floor(c.timeoutMs);
  if (typeof c.maxRetries === "number" && c.maxRetries >= 0 && c.maxRetries <= 10) pc.maxRetries = Math.floor(c.maxRetries);
  if (Array.isArray(c.models)) {
    const models: CustomModelDef[] = [];
    for (const m of c.models) {
      const r = customModelSchema.safeParse(m);
      if (!r.success) continue;
      const def: CustomModelDef = { ...r.data, name: r.data.name ?? r.data.id } as CustomModelDef;
      const mc = sanitizeCompat(effectiveApi, r.data.compat);
      if (mc) def.compat = mc; else delete def.compat;
      models.push(def);
    }
    pc.models = models;
  }
  return Object.keys(pc).length > 0 ? pc : undefined;
}

