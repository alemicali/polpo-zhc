/**
 * Connection test + model discovery for custom providers / gateways.
 *
 * All network access goes through the endpoint guard (private-network policy checked on
 * the connected address, no redirects, timeouts, response size caps). Errors are
 * sanitized so keys never leak back to the caller.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { effectiveAuth, sanitizeCompat, type DiscoveryKind, getPreset } from "@polpo-ai/core/provider-config";
import type { CustomModelDef, ProviderApi, ProviderConfig } from "../core/types.js";
import { buildCustomModel, isBuiltinProvider, resolveCustomProviderAuth, streamWithDraftProvider } from "./custom-providers.js";
import { checkEndpoint, fetchJsonGuarded } from "./endpoint-guard.js";
import type { ProviderSecrets } from "./provider-secrets.js";

// ── Error sanitizing / compat suggestions ─────────────────────────

/** Remove secrets (known values, bearer tokens, key-looking strings) from an error message. */
export function sanitizeProviderError(message: string, secrets: Array<string | undefined> = []): string {
  let out = String(message ?? "");
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("***");
  }
  out = out
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1***")
    .replace(/\b(sk|pk|rk|key|token)[-_][A-Za-z0-9._-]{8,}/gi, "$1-***")
    .replace(/("?(api[-_]?key|authorization|x-api-key|token)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, "$1***");
  return out.length > 600 ? `${out.slice(0, 600)}…` : out;
}

export interface CompatSuggestion {
  flag: string;
  value: unknown;
  reason: string;
}

/** Map well-known proxy rejections to compat flags that avoid them. */
export function suggestCompatFromError(api: ProviderApi, message: string): CompatSuggestion[] {
  const m = message.toLowerCase();
  const out: CompatSuggestion[] = [];
  if (api === "openai-completions") {
    if (/\bstore\b/.test(m) && /(unrecognized|unknown|extra|not permitted|unsupported|invalid|unexpected)/.test(m)) {
      out.push({ flag: "supportsStore", value: false, reason: "Endpoint rejects the `store` field" });
    }
    if (m.includes("max_completion_tokens")) {
      out.push({ flag: "maxTokensField", value: "max_tokens", reason: "Endpoint expects `max_tokens`" });
    }
    if (m.includes("developer") && /(role|message)/.test(m)) {
      out.push({ flag: "supportsDeveloperRole", value: false, reason: "Endpoint does not accept the `developer` role" });
    }
    if (m.includes("stream_options") || m.includes("include_usage")) {
      out.push({ flag: "supportsUsageInStreaming", value: false, reason: "Endpoint rejects `stream_options`" });
    }
    if (m.includes("reasoning_effort")) {
      out.push({ flag: "supportsReasoningEffort", value: false, reason: "Endpoint rejects `reasoning_effort`" });
    }
  }
  return out;
}

function hintsFor(cfg: ProviderConfig, message: string, status?: number): string[] {
  const m = message.toLowerCase();
  const hints: string[] = [];
  if (status === 401 || status === 403 || /\b(401|403)\b|unauthori[sz]ed|invalid api key|forbidden|authentication/.test(m)) {
    hints.push("Authentication failed — check the key and the auth method (Bearer / x-api-key / custom header).");
  }
  if (status === 404 || /\b404\b|not found/.test(m)) {
    if (cfg.api === "anthropic-messages" && /\/v1$/.test(cfg.baseUrl ?? "")) {
      hints.push('Anthropic-compatible base URLs must not end with "/v1".');
    } else if ((cfg.api ?? "openai-completions").startsWith("openai") && !/\/v1(\/|$)/.test(cfg.baseUrl ?? "")) {
      hints.push('Endpoint not found — many OpenAI-compatible servers need "/v1" at the end of the base URL.');
    } else {
      hints.push("Endpoint or model not found — check the base URL and the model id.");
    }
  }
  if (/econnrefused|enotfound|eai_again|socket hang up|timed out|timeout|connection error|fetch failed/.test(m)) {
    hints.push("Could not reach the server — is it running and reachable from the Polpo server (not just your browser)?");
  }
  if (/private\/internal address/.test(m)) hints.push('Enable "Allow private network" for local / internal endpoints.');
  if (/redirect/.test(m)) hints.push("Use the final URL (after redirects) as the base URL.");
  return hints;
}

// ── Test connection ──────────────────────────────────────────────

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  /** First characters of the model's reply. */
  sample?: string;
  error?: string;
  stage?: "config" | "network" | "auth" | "request";
  hints: string[];
  /** Compat flags that made the request succeed after a failure (apply them to fix it). */
  suggestedCompat?: Record<string, unknown>;
  suggestions?: CompatSuggestion[];
  addressClass?: string;
}

async function runCompletion(
  id: string,
  cfg: ProviderConfig,
  secrets: ProviderSecrets | undefined,
  modelId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; text?: string; error?: string; latencyMs: number }> {
  const model: Model<Api> = buildCustomModel(id, cfg, modelId);
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const stream = streamWithDraftProvider(id, cfg, secrets, model, {
    messages: [{ role: "user", content: "Reply with the single word: OK", timestamp: Date.now() }],
  }, { maxTokens: 64, signal, maxRetries: 0 } as never);
  const result = await stream.result();
  const latencyMs = Date.now() - started;
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    return { ok: false, error: result.errorMessage ?? (signal.aborted ? "Request timed out" : "Request failed"), latencyMs };
  }
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return { ok: true, text, latencyMs };
}

/**
 * Test a provider (saved or draft): network policy pre-check, then a tiny completion.
 * When the request fails with a known proxy incompatibility, retries once with the
 * suggested compat flags and reports them.
 */
export async function testCustomProvider(input: {
  id: string;
  config: ProviderConfig;
  secrets?: ProviderSecrets;
  model?: string;
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const { id, config } = input;
  const api = config.api ?? "openai-completions";
  const secretValues = [input.secrets?.apiKey, ...Object.values(input.secrets?.headers ?? {})];
  if (!config.baseUrl) return { ok: false, stage: "config", error: "Base URL is required", hints: [] };

  const net = await checkEndpoint(config.baseUrl, { allowPrivateNetwork: !!config.allowPrivateNetwork });
  if (!net.ok) {
    return { ok: false, stage: "network", error: net.error, addressClass: net.addressClass, hints: hintsFor(config, net.error ?? "") };
  }

  if (effectiveAuth(config).type !== "none" && !(await resolveCustomProviderAuth(id, config, { secrets: input.secrets ?? { headers: {} } }))) {
    return { ok: false, stage: "auth", error: "No API key provided (enter one, or set the fallback environment variable)", hints: [] };
  }

  let modelId = input.model ?? config.models?.[0]?.id;
  if (!modelId) {
    const discovered = await discoverCustomProviderModels({ id, config, secrets: input.secrets }).catch(() => undefined);
    modelId = discovered?.models[0]?.id;
  }
  if (!modelId) {
    return { ok: false, stage: "config", error: "Add at least one model id to test the connection", hints: [] };
  }

  const timeoutMs = Math.min(input.timeoutMs ?? config.timeoutMs ?? 30_000, 60_000);
  const first = await runCompletion(id, config, input.secrets, modelId, timeoutMs);
  if (first.ok) {
    return { ok: true, latencyMs: first.latencyMs, model: modelId, sample: first.text?.slice(0, 120), hints: [], addressClass: net.addressClass };
  }

  const rawError = first.error ?? "Request failed";
  const suggestions = suggestCompatFromError(api, rawError);
  if (suggestions.length > 0) {
    const suggestedCompat = sanitizeCompat(api, {
      ...(config.compat ?? {}),
      ...Object.fromEntries(suggestions.map((s) => [s.flag, s.value])),
    }) ?? {};
    const retry = await runCompletion(id, { ...config, compat: suggestedCompat }, input.secrets, modelId, timeoutMs);
    if (retry.ok) {
      return {
        ok: true,
        latencyMs: retry.latencyMs,
        model: modelId,
        sample: retry.text?.slice(0, 120),
        suggestedCompat,
        suggestions,
        hints: ["Works with adjusted compatibility settings — apply them before saving."],
        addressClass: net.addressClass,
      };
    }
  }
  const error = sanitizeProviderError(rawError, secretValues);
  return {
    ok: false,
    stage: "request",
    model: modelId,
    latencyMs: first.latencyMs,
    error,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    hints: hintsFor(config, rawError),
    addressClass: net.addressClass,
  };
}

// ── Model discovery ──────────────────────────────────────────────

export interface DiscoveredModel extends CustomModelDef {
  /** Already defined in the provider config. */
  configured?: boolean;
}

export interface DiscoveryResult {
  source: string;
  models: DiscoveredModel[];
  warnings: string[];
}

/** Headers for a raw HTTP call, equivalent to what the SDK would send. */
async function discoveryHeaders(id: string, cfg: ProviderConfig, secrets: ProviderSecrets | undefined): Promise<Record<string, string>> {
  const api = cfg.api ?? "openai-completions";
  const resolved = await resolveCustomProviderAuth(id, cfg, secrets ? { secrets } : undefined);
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  if (!resolved) return headers;
  const native = api === "anthropic-messages" ? "x-api-key" : api === "azure-openai-responses" ? "api-key" : "authorization";
  const lower = new Map(Object.entries(resolved.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (!lower.has(native)) {
    headers[native] = native === "authorization" ? `Bearer ${resolved.apiKey}` : resolved.apiKey;
  }
  for (const [k, v] of Object.entries(resolved.headers)) {
    if (v === null) {
      for (const existing of Object.keys(headers)) if (existing.toLowerCase() === k.toLowerCase()) delete headers[existing];
    } else {
      headers[k] = v;
    }
  }
  if (api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  return headers;
}

function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000 * 10_000) / 10_000;
}

function parseOpenAIList(json: unknown): DiscoveredModel[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    const m = raw as Record<string, any>;
    if (typeof m?.id !== "string" || !m.id) continue;
    const def: DiscoveredModel = { id: m.id, name: typeof m.name === "string" && m.name ? m.name : (typeof m.display_name === "string" ? m.display_name : m.id) };
    const ctx = num(m.context_length) ?? num(m.max_model_len) ?? num(m.context_window) ?? num(m.top_provider?.context_length);
    if (ctx) def.contextWindow = ctx;
    const maxOut = num(m.top_provider?.max_completion_tokens) ?? num(m.max_output_tokens);
    if (maxOut) def.maxTokens = maxOut;
    // OpenRouter-style metadata
    if (m.pricing && typeof m.pricing === "object") {
      const input = perMillion(m.pricing.prompt);
      const output = perMillion(m.pricing.completion);
      if (input !== undefined && output !== undefined) {
        def.cost = { input, output, cacheRead: perMillion(m.pricing.input_cache_read) ?? 0, cacheWrite: perMillion(m.pricing.input_cache_write) ?? 0 };
      }
    }
    const modalities: unknown = m.architecture?.input_modalities;
    if (Array.isArray(modalities) && modalities.includes("image")) def.input = ["text", "image"];
    if (Array.isArray(m.supported_parameters) && (m.supported_parameters.includes("reasoning") || m.supported_parameters.includes("include_reasoning"))) def.reasoning = true;
    out.push(def);
  }
  return out;
}

function parseLiteLLMInfo(json: unknown): DiscoveredModel[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    const m = raw as Record<string, any>;
    const id = m?.model_name;
    if (typeof id !== "string" || !id) continue;
    const info = (m.model_info ?? {}) as Record<string, any>;
    const def: DiscoveredModel = { id, name: id };
    const ctx = num(info.max_input_tokens) ?? num(info.max_tokens);
    if (ctx) def.contextWindow = ctx;
    const maxOut = num(info.max_output_tokens);
    if (maxOut) def.maxTokens = maxOut;
    const input = perMillion(info.input_cost_per_token);
    const output = perMillion(info.output_cost_per_token);
    if (input !== undefined && output !== undefined) {
      def.cost = { input, output, cacheRead: perMillion(info.cache_read_input_token_cost) ?? 0, cacheWrite: perMillion(info.cache_creation_input_token_cost) ?? 0 };
    }
    if (info.supports_vision === true) def.input = ["text", "image"];
    if (info.supports_reasoning === true) def.reasoning = true;
    if (!out.some((x) => x.id === id)) out.push(def);
  }
  return out;
}

function parseOllamaTags(json: unknown): DiscoveredModel[] {
  const models = (json as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((raw) => raw as Record<string, any>)
    .filter((m) => typeof m?.name === "string" && m.name)
    .map((m) => ({ id: m.name as string, name: m.name as string }));
}

/** Default discovery strategy for a provider config. */
export function discoveryKindFor(cfg: ProviderConfig): DiscoveryKind {
  const preset = getPreset(cfg.preset);
  if (preset && preset.id !== "proxy") return preset.discovery;
  if (cfg.api === "anthropic-messages") return "anthropic";
  if (cfg.api === "azure-openai-responses") return "none";
  return "openai";
}

/**
 * Discover models from the endpoint (OpenAI /models, Anthropic /v1/models, LiteLLM
 * /model/info, OpenRouter /models, Ollama /api/tags). For "proxy" providers, the
 * built-in catalog of the proxied provider is included.
 */
export async function discoverCustomProviderModels(input: {
  id: string;
  config: ProviderConfig;
  secrets?: ProviderSecrets;
  kind?: DiscoveryKind;
  fetchImpl?: typeof fetch;
}): Promise<DiscoveryResult> {
  const { id, config } = input;
  const warnings: string[] = [];
  const secretValues = [input.secrets?.apiKey, ...Object.values(input.secrets?.headers ?? {})];
  const policy = { allowPrivateNetwork: !!config.allowPrivateNetwork };
  const base = (config.baseUrl ?? "").replace(/\/+$/, "");
  const kind = input.kind ?? discoveryKindFor(config);
  const configured = new Set((config.models ?? []).map((m) => m.id));
  let models: DiscoveredModel[] = [];
  let source = kind;

  if (config.proxyFor && isBuiltinProvider(config.proxyFor)) {
    try {
      models = (getBuiltinModels(config.proxyFor as BuiltinProvider) as Model<Api>[]).map((m) => ({
        id: m.id, name: m.name, reasoning: m.reasoning, input: [...m.input] as ("text" | "image")[],
        contextWindow: m.contextWindow, maxTokens: m.maxTokens,
        cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite },
      }));
      source = `catalog:${config.proxyFor}` as DiscoveryKind;
    } catch { /* ignore */ }
  }

  if (base && kind !== "none") {
    if (!input.fetchImpl) {
      const net = await checkEndpoint(base, policy);
      if (!net.ok) throw new Error(net.error ?? "Endpoint not allowed");
    }
    const headers = await discoveryHeaders(id, config, input.secrets);
    const get = async (url: string) => fetchJsonGuarded(url, { headers, policy, timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, fetchImpl: input.fetchImpl });
    const attempts: Array<{ url: string; parse: (j: unknown) => DiscoveredModel[] }> = [];
    if (kind === "litellm") {
      attempts.push({ url: `${rootOf(base)}/model/info`, parse: parseLiteLLMInfo });
      attempts.push({ url: `${base}/models`, parse: parseOpenAIList });
    } else if (kind === "ollama") {
      attempts.push({ url: `${rootOf(base)}/api/tags`, parse: parseOllamaTags });
      attempts.push({ url: `${base}/models`, parse: parseOpenAIList });
    } else if (kind === "anthropic") {
      attempts.push({ url: `${rootOf(base)}/v1/models?limit=1000`, parse: parseOpenAIList });
    } else {
      attempts.push({ url: `${base}/models`, parse: parseOpenAIList });
    }
    let found: DiscoveredModel[] | undefined;
    for (const attempt of attempts) {
      try {
        const res = await get(attempt.url);
        if (res.status >= 400) {
          warnings.push(`${new URL(attempt.url).pathname} → HTTP ${res.status}${res.text ? `: ${sanitizeProviderError(res.text, secretValues).slice(0, 160)}` : ""}`);
          continue;
        }
        const parsed = attempt.parse(res.json);
        if (parsed.length > 0) {
          found = parsed;
          break;
        }
        warnings.push(`${new URL(attempt.url).pathname} returned no models`);
      } catch (err) {
        warnings.push(`${new URL(attempt.url).pathname}: ${sanitizeProviderError((err as Error).message, secretValues)}`);
      }
    }
    if (found) {
      if (models.length > 0) {
        // Proxy: keep catalog metadata, restricted to what the endpoint actually serves.
        const served = new Set(found.map((m) => m.id));
        const fromCatalog = models.filter((m) => served.has(m.id));
        const extra = found.filter((m) => !fromCatalog.some((c) => c.id === m.id));
        models = [...fromCatalog, ...extra];
      } else {
        models = found;
      }
    }
  } else if (kind === "none" && models.length === 0) {
    warnings.push("This endpoint has no model listing — add model (or deployment) ids manually.");
  }

  const result = models.slice(0, 2000).map((m) => ({ ...m, configured: configured.has(m.id) || undefined }));
  result.sort((a, b) => a.id.localeCompare(b.id));
  return { source: String(source), models: result, warnings };
}
