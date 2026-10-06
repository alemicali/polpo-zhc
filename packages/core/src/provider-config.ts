/**
 * Custom LLM providers / AI gateways — shared schema, presets and helpers.
 *
 * Pure module (zod only): used by the config parser, the server routes and the web UI
 * (`@polpo-ai/core/provider-config`). Secrets are never part of these shapes: keys and
 * secret headers live in the vault (owner "$providers", service = provider id).
 */

import { z } from "zod";
import type { CustomModelDef, ProviderApi, ProviderAuthConfig, ProviderConfig } from "./types.js";

// ── Identifiers ─────────────────────────────────────────────────────

/** Custom provider ids: lowercase slug, 2-41 chars. Used as the model-spec prefix ("<id>:<model>"). */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Reserved vault owner holding instance-wide provider secrets. */
export const PROVIDER_VAULT_OWNER = "$providers";

/** Vault credential key for the provider API key. */
export const PROVIDER_VAULT_KEY = "apiKey";

/** Vault credential key prefix for secret headers (`header:<Header-Name>`). */
export const PROVIDER_VAULT_HEADER_PREFIX = "header:";

export const PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "azure-openai-responses",
] as const satisfies readonly ProviderApi[];

export const PROVIDER_API_LABELS: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI-compatible (Chat Completions)",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic-compatible (Messages)",
  "azure-openai-responses": "Azure OpenAI (Responses)",
};

// ── Compatibility flags (whitelisted per API) ──────────────────────

/** Compat flags accepted for each API. Anything else is dropped on save. */
export const COMPAT_FLAGS: Record<ProviderApi, Record<string, "boolean" | readonly string[]>> = {
  "openai-completions": {
    supportsStore: "boolean",
    supportsDeveloperRole: "boolean",
    supportsReasoningEffort: "boolean",
    supportsUsageInStreaming: "boolean",
    supportsFinishReason: "boolean",
    supportsStrictMode: "boolean",
    requiresToolResultName: "boolean",
    requiresAssistantAfterToolResult: "boolean",
    requiresThinkingAsText: "boolean",
    maxTokensField: ["max_completion_tokens", "max_tokens"],
    thinkingFormat: ["openai", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template", "string-thinking"],
  },
  "openai-responses": {
    supportsDeveloperRole: "boolean",
    supportsStrictMode: "boolean",
    supportsLongCacheRetention: "boolean",
    supportsMaxOutputTokens: "boolean",
  },
  "azure-openai-responses": {
    supportsDeveloperRole: "boolean",
    supportsStrictMode: "boolean",
    supportsMaxOutputTokens: "boolean",
  },
  "anthropic-messages": {
    supportsEagerToolInputStreaming: "boolean",
    supportsLongCacheRetention: "boolean",
    supportsCacheControlOnTools: "boolean",
    supportsTemperature: "boolean",
    supportsStrictTools: "boolean",
    forceAdaptiveThinking: "boolean",
  },
};

/** Human description of each compat flag (UI). */
export const COMPAT_FLAG_HELP: Record<string, string> = {
  supportsStore: "Send `store: false` (OpenAI only — most proxies reject it)",
  supportsDeveloperRole: "Use the `developer` role for system prompts (else `system`)",
  supportsReasoningEffort: "Send `reasoning_effort`",
  supportsUsageInStreaming: "Request token usage in streamed responses",
  supportsFinishReason: "Stream includes `finish_reason`",
  supportsStrictMode: "Send `strict` on tool definitions",
  requiresToolResultName: "Tool results need the `name` field",
  requiresAssistantAfterToolResult: "Insert an assistant turn between tool results and user messages",
  requiresThinkingAsText: "Replay thinking blocks as plain text",
  maxTokensField: "Field used for the output token cap",
  thinkingFormat: "How reasoning/thinking is requested",
  supportsLongCacheRetention: "Long prompt-cache retention",
  supportsMaxOutputTokens: "Send `max_output_tokens`",
  supportsEagerToolInputStreaming: "Per-tool eager input streaming",
  supportsCacheControlOnTools: "`cache_control` on tool definitions",
  supportsTemperature: "Send `temperature`",
  supportsStrictTools: "Strict tool schemas",
  forceAdaptiveThinking: "Force adaptive thinking format",
};

/** Keep only whitelisted, well-typed compat flags for `api`. */
export function sanitizeCompat(api: ProviderApi, compat: unknown): Record<string, unknown> | undefined {
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) return undefined;
  const allowed = COMPAT_FLAGS[api] ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(compat as Record<string, unknown>)) {
    const spec = allowed[key];
    if (!spec) continue;
    if (spec === "boolean") {
      if (typeof value === "boolean") out[key] = value;
    } else if (typeof value === "string" && spec.includes(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── Zod schemas ─────────────────────────────────────────────────────

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;

/**
 * Env vars usable as key fallback. Restricted to key-looking names so a provider definition
 * cannot be used to ship arbitrary process secrets (vault key, database URL…) to an endpoint.
 */
export function isAllowedKeyEnvVar(name: string): boolean {
  if (!ENV_VAR_RE.test(name)) return false;
  const upper = name.toUpperCase();
  if (upper.startsWith("POLPO_")) return false;
  if (upper === "AWS_SECRET_ACCESS_KEY" || upper === "AWS_SESSION_TOKEN") return false;
  return /(API_KEY|_TOKEN|_KEY)$/.test(upper);
}

/** Headers Polpo manages itself — never configurable as static/secret headers. */
const RESERVED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "content-type"]);

export const providerApiSchema = z.enum(PROVIDER_APIS);

export const providerAuthSchema = z.object({
  type: z.enum(["none", "bearer", "x-api-key", "header"]),
  headerName: z.string().regex(HEADER_NAME_RE, "invalid header name").optional(),
  prefix: z.string().max(40).regex(/^[^\r\n]*$/, "invalid prefix").optional(),
  envVar: z.string().refine(isAllowedKeyEnvVar, "env var must be a key-like name (…_API_KEY, …_TOKEN, …_KEY) and not POLPO_*").optional(),
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

// ── Normalization ──────────────────────────────────────────────────

export interface BaseUrlCheck {
  url?: string;
  error?: string;
  hints: string[];
}

/**
 * Normalize a user-entered base URL for `api` and explain what changed.
 * - trims whitespace and trailing slashes, drops query/fragment
 * - strips a pasted endpoint suffix (/chat/completions, /responses, /messages, /models)
 * - anthropic-messages: the SDK appends /v1/messages, so a trailing /v1 is removed
 * - openai-*: suggests /v1 when the path is empty
 */
export function normalizeBaseUrl(raw: string, api: ProviderApi = "openai-completions"): BaseUrlCheck {
  const hints: string[] = [];
  const input = (raw ?? "").trim();
  if (!input) return { error: "Base URL is required", hints };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { error: "Not a valid URL (include http:// or https://)", hints };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http:// and https:// URLs are supported", hints };
  }
  if (url.username || url.password) {
    return { error: "Do not put credentials in the URL — use the API key field", hints };
  }
  if (url.search || url.hash) {
    url.search = "";
    url.hash = "";
    hints.push("Removed query string / fragment");
  }
  let path = url.pathname.replace(/\/+$/, "");
  const suffixes = ["/chat/completions", "/completions", "/responses", "/messages", "/models"];
  for (const suffix of suffixes) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      hints.push(`Removed endpoint suffix "${suffix}" — enter the API base, not a full endpoint`);
      break;
    }
  }
  if (api === "anthropic-messages" && /\/v1$/i.test(path)) {
    path = path.slice(0, -3);
    hints.push('Removed trailing "/v1" — Anthropic-compatible clients append /v1/messages themselves');
  }
  if ((api === "openai-completions" || api === "openai-responses") && path === "") {
    hints.push('Most OpenAI-compatible servers expect the base URL to end with "/v1"');
  }
  if (url.protocol === "http:" && !isLikelyLocalHost(url.hostname)) {
    hints.push("Plain http:// sends your key unencrypted — prefer https://");
  }
  url.pathname = path || "/";
  const out = url.toString().replace(/\/+$/, "");
  return { url: out, hints };
}

/** Cheap syntactic check (no DNS) used for UI hints only. */
export function isLikelyLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h.startsWith("127.")
    || h.startsWith("10.") || h.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.endsWith(".local") || h.endsWith(".internal")
    || h.endsWith(".ts.net") || /^f[cd][0-9a-f]{2}:/.test(h);
}

/** Default auth for an API when the config does not say. */
export function defaultAuthFor(api: ProviderApi): ProviderAuthConfig {
  if (api === "anthropic-messages") return { type: "x-api-key" };
  if (api === "azure-openai-responses") return { type: "header", headerName: "api-key" };
  return { type: "bearer" };
}

/** Effective auth: explicit config, legacy (no auth field) = keyless, else API default. */
export function effectiveAuth(cfg: Pick<ProviderConfig, "auth" | "api" | "preset">): ProviderAuthConfig {
  if (cfg.auth) return cfg.auth;
  // Legacy custom entries ({ baseUrl, api, models } only) never had key support — treat as keyless.
  if (!cfg.preset) return { type: "none" };
  return defaultAuthFor(cfg.api ?? "openai-completions");
}

/** Conventional fallback env var for a custom provider id: "my-gw" → "MY_GW_API_KEY". */
export function defaultProviderEnvVar(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * Validate and normalize a provider definition (draft or saved).
 * Returns the cleaned config (compat whitelisted, models normalized) or an error list.
 */
export function validateCustomProvider(input: unknown): { ok: true; config: ProviderConfig } | { ok: false; errors: string[] } {
  const parsed = customProviderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "provider"}: ${i.message}`) };
  }
  const p = parsed.data;
  const api = p.api;
  const base = normalizeBaseUrl(p.baseUrl, api);
  if (base.error || !base.url) return { ok: false, errors: [`baseUrl: ${base.error ?? "invalid"}`] };
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
  if (c.allowPrivateNetwork === true) pc.allowPrivateNetwork = true;
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

// ── Presets ─────────────────────────────────────────────────────────

export interface PresetField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
}

export type DiscoveryKind = "openai" | "anthropic" | "litellm" | "openrouter" | "ollama" | "none";

export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  api: ProviderApi;
  /** Base URL, possibly with {field} placeholders filled from `fields`. */
  baseUrl: string;
  auth: ProviderAuthConfig;
  /** Suggested slug for the provider id. */
  suggestedId: string;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
  fields?: PresetField[];
  /** Local server: private network toggle pre-enabled (with warning). */
  local?: boolean;
  /** Hosted gateway / local server / generic. */
  kind: "gateway" | "local" | "generic" | "proxy";
  discovery: DiscoveryKind;
  docsUrl?: string;
  /** Key is optional (e.g. LiteLLM without master key). */
  keyOptional?: boolean;
}

/** Compat defaults for self-hosted OpenAI-compatible servers (LiteLLM / vLLM / Ollama / LM Studio). */
export const SELF_HOSTED_OPENAI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter", label: "OpenRouter", kind: "gateway",
    description: "Hundreds of models behind one OpenAI-compatible key.",
    api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
    auth: { type: "bearer", envVar: "OPENROUTER_API_KEY" }, suggestedId: "openrouter-gw",
    discovery: "openrouter", docsUrl: "https://openrouter.ai/docs",
  },
  {
    id: "vercel-ai-gateway", label: "Vercel AI Gateway", kind: "gateway",
    description: "Vercel's OpenAI-compatible gateway with budgets and fallbacks.",
    api: "openai-completions", baseUrl: "https://ai-gateway.vercel.sh/v1",
    auth: { type: "bearer", envVar: "AI_GATEWAY_API_KEY" }, suggestedId: "vercel-gw",
    discovery: "openai", docsUrl: "https://vercel.com/docs/ai-gateway",
  },
  {
    id: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", kind: "gateway",
    description: "Cloudflare unified (compat) endpoint. Uses the gateway token; provider keys stay in Cloudflare (BYOK).",
    api: "openai-completions",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/compat",
    auth: { type: "header", headerName: "cf-aig-authorization", prefix: "Bearer ", envVar: "CLOUDFLARE_API_KEY" },
    compat: { supportsStore: false, maxTokensField: "max_tokens", supportsReasoningEffort: false },
    fields: [
      { key: "accountId", label: "Account ID", placeholder: "0123456789abcdef0123456789abcdef" },
      { key: "gatewayId", label: "Gateway ID", placeholder: "my-gateway" },
    ],
    suggestedId: "cloudflare-gw", discovery: "none",
    docsUrl: "https://developers.cloudflare.com/ai-gateway/usage/chat-completion/",
  },
  {
    id: "azure-openai", label: "Azure OpenAI", kind: "gateway",
    description: "Azure OpenAI / AI Foundry deployment. Add each deployment name as a model.",
    api: "azure-openai-responses",
    baseUrl: "https://{resource}.openai.azure.com/openai/v1",
    auth: { type: "header", headerName: "api-key", envVar: "AZURE_OPENAI_API_KEY" },
    fields: [{ key: "resource", label: "Resource name", placeholder: "my-resource", help: "The <resource> part of https://<resource>.openai.azure.com" }],
    suggestedId: "azure-openai", discovery: "none",
  },
  {
    id: "litellm", label: "LiteLLM", kind: "gateway",
    description: "LiteLLM proxy (self-hosted or managed).",
    api: "openai-completions", baseUrl: "http://localhost:4000/v1",
    auth: { type: "bearer" }, compat: { ...SELF_HOSTED_OPENAI_COMPAT },
    suggestedId: "litellm", discovery: "litellm", keyOptional: true, local: true,
  },
  {
    id: "ollama", label: "Ollama", kind: "local",
    description: "Local models served by Ollama.",
    api: "openai-completions", baseUrl: "http://localhost:11434/v1",
    auth: { type: "none" }, compat: { ...SELF_HOSTED_OPENAI_COMPAT, supportsReasoningEffort: false },
    suggestedId: "ollama", discovery: "ollama", local: true,
  },
  {
    id: "vllm", label: "vLLM", kind: "local",
    description: "vLLM OpenAI-compatible server.",
    api: "openai-completions", baseUrl: "http://localhost:8000/v1",
    auth: { type: "none" }, compat: { ...SELF_HOSTED_OPENAI_COMPAT },
    suggestedId: "vllm", discovery: "openai", local: true,
  },
  {
    id: "lm-studio", label: "LM Studio", kind: "local",
    description: "LM Studio local server.",
    api: "openai-completions", baseUrl: "http://localhost:1234/v1",
    auth: { type: "none" }, compat: { ...SELF_HOSTED_OPENAI_COMPAT, supportsReasoningEffort: false },
    suggestedId: "lm-studio", discovery: "openai", local: true,
  },
  {
    id: "openai-compatible", label: "OpenAI-compatible", kind: "generic",
    description: "Any endpoint speaking the OpenAI Chat Completions API.",
    api: "openai-completions", baseUrl: "",
    auth: { type: "bearer" }, suggestedId: "my-gateway", discovery: "openai",
  },
  {
    id: "anthropic-compatible", label: "Anthropic-compatible", kind: "generic",
    description: "Any endpoint speaking the Anthropic Messages API.",
    api: "anthropic-messages", baseUrl: "",
    auth: { type: "x-api-key" }, suggestedId: "my-anthropic-gw", discovery: "anthropic",
  },
  {
    id: "proxy", label: "Proxy for a built-in provider", kind: "proxy",
    description: "Route Anthropic or OpenAI traffic through a corporate proxy, reusing the catalog models.",
    api: "anthropic-messages", baseUrl: "",
    auth: { type: "x-api-key" }, suggestedId: "anthropic-proxy", discovery: "anthropic",
  },
];

/** Built-in providers that the "proxy" preset can wrap, with their wire API and key env var. */
export const PROXYABLE_PROVIDERS: Record<string, { api: ProviderApi; envVar: string; auth: ProviderAuthConfig }> = {
  anthropic: { api: "anthropic-messages", envVar: "ANTHROPIC_API_KEY", auth: { type: "x-api-key" } },
  openai: { api: "openai-responses", envVar: "OPENAI_API_KEY", auth: { type: "bearer" } },
};

export function getPreset(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined;
}

/** Fill `{field}` placeholders; unknown/empty fields stay as placeholders (validation then fails). */
export function fillPresetUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (m, key: string) => {
    const v = values[key]?.trim();
    return v ? encodeURIComponent(v) : m;
  });
}
