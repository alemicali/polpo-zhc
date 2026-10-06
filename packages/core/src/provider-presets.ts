/**
 * Custom LLM providers / AI gateways — presets, compat whitelist and pure helpers.
 *
 * Dependency-free (no zod) so the web UI can import it cheaply via
 * `@polpo-ai/core/provider-presets`. Validation schemas live in `provider-config`.
 */

import type { ProviderApi, ProviderAuthConfig, ProviderConfig } from "./types.js";
import { RESERVED_VAULT_OWNER_PREFIX } from "./vault-store.js";

// ── Identifiers ─────────────────────────────────────────────────────

/** Custom provider ids: lowercase slug, 2-41 chars. Used as the model-spec prefix ("<id>:<model>"). */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/**
 * Reserved vault owner holding instance-wide provider secrets. Built on the shared
 * reserved-owner prefix, so user/agent-facing vault routes and tools refuse it
 * (see `isReservedVaultOwner`).
 */
export const PROVIDER_VAULT_OWNER = `${RESERVED_VAULT_OWNER_PREFIX}providers`;

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

export const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
export const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;

/** Prefix reserved for custom-provider key env vars (collision-free with other secrets). */
export const CUSTOM_ENV_PREFIX = "CUSTOM_";
const CUSTOM_ENV_RE = /^CUSTOM_[A-Z0-9_]{1,80}$/;

/**
 * Gateway env vars that may only be sent to the gateway's own official hosts
 * (a leading "." means "any subdomain of").
 */
export const GATEWAY_ENV_HOSTS: Record<string, string[]> = {
  OPENROUTER_API_KEY: ["openrouter.ai"],
  AI_GATEWAY_API_KEY: ["ai-gateway.vercel.sh"],
  CLOUDFLARE_API_KEY: ["gateway.ai.cloudflare.com"],
  AZURE_OPENAI_API_KEY: [".openai.azure.com", ".cognitiveservices.azure.com", ".ai.azure.com"],
};

/**
 * Env vars owned by built-in providers (pi-ai + Polpo). A custom provider may only use one of
 * these as key fallback when it is a proxy for that provider and the admin confirmed it, or when
 * it is a gateway variable sent to the gateway's official host (GATEWAY_ENV_HOSTS).
 */
export const BUILTIN_PROVIDER_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "NVIDIA_API_KEY",
  "DEEPSEEK_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "TYPESAFE_API_KEY", "RADIUS_API_KEY",
  "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN", "FIREWORKS_API_KEY", "TOGETHER_API_KEY",
  "BASETEN_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY", "META_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "ANT_LING_API_KEY", "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

function hostMatches(hostname: string, patterns: string[]): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((p) => (p.startsWith(".") ? h.endsWith(p) && h.length > p.length : h === p));
}

/**
 * Policy for the env var used as key fallback by a custom provider.
 * Allowed:
 *  - CUSTOM_* names (namespace dedicated to custom providers)
 *  - a gateway variable (OPENROUTER_API_KEY, …) when the base URL is that gateway's official host
 *  - the proxied provider's own variable (ANTHROPIC_API_KEY / OPENAI_API_KEY) for a proxyFor
 *    provider, only when `confirmedBuiltinReuse` (explicit admin confirmation) is set
 * Returns an error message, or undefined when allowed.
 */
export function envVarPolicyError(
  envVar: string | undefined,
  cfg: { baseUrl?: string; proxyFor?: string },
  opts: { confirmedBuiltinReuse?: boolean } = {},
): string | undefined {
  if (!envVar) return undefined;
  if (!ENV_VAR_RE.test(envVar)) return "invalid environment variable name";
  if (CUSTOM_ENV_RE.test(envVar)) return undefined;
  const gatewayHosts = GATEWAY_ENV_HOSTS[envVar];
  if (gatewayHosts) {
    let host = "";
    try { host = new URL(cfg.baseUrl ?? "").hostname; } catch { /* invalid */ }
    if (host && hostMatches(host, gatewayHosts)) return undefined;
    return `${envVar} can only be sent to ${gatewayHosts.map((h) => (h.startsWith(".") ? `*${h}` : h)).join(", ")} — use a CUSTOM_* variable for other hosts`;
  }
  const proxied = cfg.proxyFor ? PROXYABLE_PROVIDERS[cfg.proxyFor] : undefined;
  if (proxied && proxied.envVar === envVar) {
    return opts.confirmedBuiltinReuse ? undefined : `Reusing ${envVar} sends your ${cfg.proxyFor} key to this endpoint — confirm it explicitly`;
  }
  if (BUILTIN_PROVIDER_ENV_VARS.has(envVar)) return `${envVar} belongs to a built-in provider and cannot be used by a custom provider`;
  return `Fallback variables must start with ${CUSTOM_ENV_PREFIX} (e.g. ${CUSTOM_ENV_PREFIX}MY_GATEWAY_API_KEY)`;
}

/** Headers Polpo manages itself — never configurable as static/secret headers. */
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

/** Conventional fallback env var for a custom provider id: "my-gw" → "CUSTOM_MY_GW_API_KEY" (collision-free). */
export function defaultProviderEnvVar(id: string): string {
  return `${CUSTOM_ENV_PREFIX}${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * Validate and normalize a provider definition (draft or saved).
 * Returns the cleaned config (compat whitelisted, models normalized) or an error list.
 */
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
