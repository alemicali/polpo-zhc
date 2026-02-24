/**
 * Polpo LLM abstraction — multi-provider model resolution, streaming, cost tracking,
 * and provider-level failover built on top of pi-ai.
 *
 * Supports all 22 pi-ai providers out-of-the-box plus custom OpenAI/Anthropic-compatible
 * endpoints via ProviderConfig.
 */

import {
  getModel,
  getModels,
  getProviders,
  getEnvApiKey,
  calculateCost,
  completeSimple,
  streamSimple,
  type Model,
  type Api,
  type KnownProvider,
  type Usage,
} from "@mariozechner/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderConfig, ModelConfig, ModelAllowlistEntry } from "../core/types.js";

// ─── Constants ──────────────────────────────────────

/**
 * Prefix-based inference map for bare model IDs (without provider prefix).
 * Used ONLY when the user writes "claude-opus-4-6" instead of "anthropic:claude-opus-4-6".
 * All 22 pi-ai providers are supported — this map covers the most common prefixes.
 */
const PREFIX_MAP: [string, KnownProvider][] = [
  // Anthropic
  ["claude-", "anthropic"],
  // OpenAI
  ["gpt-", "openai"],
  ["o1-", "openai"],
  ["o3-", "openai"],
  ["o4-", "openai"],
  ["chatgpt-", "openai"],
  ["codex-", "openai"],
  // Google
  ["gemini-", "google"],
  // Mistral
  ["mistral-", "mistral"],
  ["codestral-", "mistral"],
  ["devstral-", "mistral"],
  // Groq
  ["llama-", "groq"],
  ["llama3", "groq"],
  // xAI
  ["grok-", "xai"],
  // OpenRouter
  ["deepseek-", "openrouter"],
  // Cerebras
  ["gpt-oss-", "cerebras"],
  // ZAI / GLM
  ["glm-", "zai"],
  // MiniMax
  ["minimax-", "minimax"],
  // Kimi
  ["kimi-", "kimi-coding"],
  // Amazon Bedrock
  ["amazon.", "amazon-bedrock"],
  ["us.", "amazon-bedrock"],
  ["eu.", "amazon-bedrock"],
  // HuggingFace
  ["hf:", "huggingface"],
  // OpenCode
  ["big-pickle", "opencode"],
];

// ─── Provider → env var map (shared with setup wizard) ──

/** Map provider names to their standard environment variable for API keys. */
export const PROVIDER_ENV_MAP: Record<string, string> = {
  "openai": "OPENAI_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",
  "google": "GEMINI_API_KEY",
  "groq": "GROQ_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "xai": "XAI_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "zai": "ZAI_API_KEY",
  "mistral": "MISTRAL_API_KEY",
  "minimax": "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "huggingface": "HF_TOKEN",
  "opencode": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
  "google-vertex": "GOOGLE_CLOUD_PROJECT",
  "openai-codex": "OPENAI_API_KEY",
};

// ─── Provider override management ───────────────────

/** Provider overrides from polpo.json — set by the orchestrator at init time. */
let providerOverrides: Record<string, ProviderConfig> = {};

export function setProviderOverrides(overrides: Record<string, ProviderConfig>): void {
  providerOverrides = overrides;
}

export function getProviderOverrides(): Record<string, ProviderConfig> {
  return { ...providerOverrides };
}

// ─── Model Allowlist ────────────────────────────────

/** Model allowlist — when set, only these models can be used. Set by orchestrator at init. */
let modelAllowlist: Record<string, ModelAllowlistEntry> | undefined;

export function setModelAllowlist(allowlist: Record<string, ModelAllowlistEntry> | undefined): void {
  modelAllowlist = allowlist;
}

export function getModelAllowlist(): Record<string, ModelAllowlistEntry> | undefined {
  return modelAllowlist;
}

/**
 * Check if a model spec is allowed by the allowlist.
 * Returns true if no allowlist is set (everything allowed) or the model is in the list.
 */
export function isModelAllowed(spec: string): boolean {
  if (!modelAllowlist) return true;
  // Check exact match
  if (spec in modelAllowlist) return true;
  // Check without provider prefix (e.g. "claude-opus-4-6" matches "anthropic:claude-opus-4-6")
  const { provider, modelId } = parseModelSpec(spec);
  const fullSpec = `${provider}:${modelId}`;
  return fullSpec in modelAllowlist;
}

/**
 * Enforce model allowlist. Throws if the model is not allowed.
 */
export function enforceModelAllowlist(spec: string): void {
  if (!isModelAllowed(spec)) {
    const allowed = Object.keys(modelAllowlist!).join(", ");
    throw new Error(`Model "${spec}" is not in the allowlist. Allowed models: ${allowed}`);
  }
}

// ─── API Key Resolution ─────────────────────────────

/**
 * Resolve API key for a provider (synchronous).
 * Priority: 1) polpo.json overrides, 2) pi-ai env var lookup.
 *
 * Does NOT check OAuth profiles (that requires async). Use resolveApiKeyAsync
 * for the full resolution chain including OAuth.
 */
export function resolveApiKey(provider: string): string | undefined {
  const override = providerOverrides[provider];
  if (override?.apiKey) return override.apiKey;
  return getEnvApiKey(provider as KnownProvider);
}

/**
 * Resolve API key for a provider (async, full resolution chain).
 * Priority: 1) polpo.json overrides, 2) pi-ai env var lookup, 3) stored OAuth profiles.
 *
 * OAuth profiles are checked last and may trigger a token refresh if expired.
 */
export async function resolveApiKeyAsync(provider: string): Promise<string | undefined> {
  // 1. Sync path first (fast)
  const syncKey = resolveApiKey(provider);
  if (syncKey) return syncKey;

  // 2. Check OAuth profiles (async — may refresh expired tokens)
  try {
    const { getOAuthApiKeyForProvider } = await import("../auth/oauth-manager.js");
    const result = await getOAuthApiKeyForProvider(provider);
    return result?.apiKey;
  } catch {
    return undefined;
  }
}

// ─── Model Spec Parsing ─────────────────────────────

export interface ParsedModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Parse a model spec string into provider + modelId.
 *
 * Supported formats:
 *   "provider:model" — explicit (e.g. "anthropic:claude-opus-4-6")
 *   "model-id"       — auto-inferred from prefix map
 *
 * Falls back to POLPO_MODEL env var. Throws if no model is available.
 */
export function parseModelSpec(spec?: string): ParsedModelSpec {
  const s = spec || process.env.POLPO_MODEL;
  if (!s) {
    throw new Error(
      "No model configured. Set a model on your agent in .polpo/polpo.json, " +
      "set the POLPO_MODEL env var, or run 'polpo setup'."
    );
  }

  // Explicit "provider:model" format
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const provider = s.slice(0, colonIdx);
    const modelId = s.slice(colonIdx + 1);
    // Validate it's not a windows path or similar
    if (!provider.includes("/") && !provider.includes("\\")) {
      return { provider, modelId };
    }
  }

  // Auto-infer from prefix map
  const lower = s.toLowerCase();
  for (const [prefix, provider] of PREFIX_MAP) {
    if (lower.startsWith(prefix)) {
      return { provider, modelId: s };
    }
  }

  // Unknown bare model ID — cannot infer provider
  throw new Error(
    `Cannot infer provider for model "${s}". Use "provider:model" format (e.g. "anthropic:${s}").`
  );
}

/**
 * Map ProviderConfig.api values to pi-ai Api strings.
 */
const API_MODE_MAP: Record<string, Api> = {
  "openai-completions": "openai-completions" as Api,
  "openai-responses": "openai-responses" as Api,
  "anthropic-messages": "anthropic-messages" as Api,
};

/**
 * Resolve a model spec to a pi-ai Model object with full metadata.
 *
 * Resolution order:
 * 1. Try pi-ai catalog (built-in providers)
 * 2. If that fails, check providerOverrides for a CustomModelDef match
 * 3. If no custom model def, construct a minimal Model from override config
 *
 * This ensures custom providers (Ollama, vLLM, etc.) work without being in the catalog.
 */
export function resolveModel(spec?: string): Model<Api> {
  const { provider, modelId } = parseModelSpec(spec);
  const override = providerOverrides[provider];

  // 1. Try pi-ai built-in catalog first
  try {
    const model = getModel(provider as KnownProvider, modelId as never) as Model<Api> | undefined;
    if (model) {
      if (override?.baseUrl) {
        return { ...model, baseUrl: override.baseUrl };
      }
      return model;
    }
    // Model not found in catalog — fall through to custom provider logic
  } catch {
    // Not in catalog — fall through to custom provider logic
  }

  // 2. Check for custom model definitions in providerOverrides
  if (override) {
    const customDef = override.models?.find(m => m.id === modelId);
    const apiMode = override.api ? API_MODE_MAP[override.api] : ("openai-completions" as Api);
    const baseUrl = override.baseUrl || "http://localhost:11434/v1";

    if (customDef) {
      return {
        id: customDef.id,
        name: customDef.name,
        api: apiMode,
        provider,
        baseUrl,
        reasoning: customDef.reasoning ?? false,
        input: customDef.input ?? ["text"],
        cost: customDef.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: customDef.contextWindow ?? 200_000,
        maxTokens: customDef.maxTokens ?? 8192,
      } as Model<Api>;
    }

    // 3. No custom def — construct minimal Model (provider exists but model isn't pre-defined)
    return {
      id: modelId,
      name: modelId,
      api: apiMode,
      provider,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    } as Model<Api>;
  }

  // 4. Unknown provider with no override — try pi-ai, but guard against undefined return
  try {
    const model = getModel(provider as KnownProvider, modelId as never) as Model<Api> | undefined;
    if (model) return model;
  } catch {
    // Fall through to error
  }

  throw new Error(
    `Model "${modelId}" not found for provider "${provider}". ` +
    `Use "polpo models list ${provider}" to see available models, or configure a custom model in providers.`,
  );
}

// ─── Model Catalog ──────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * List all available providers from the pi-ai catalog.
 */
export function listProviders(): string[] {
  return getProviders();
}

/**
 * List all models for a given provider (or all providers if none specified).
 */
export function listModels(provider?: string): ModelInfo[] {
  const providers = provider ? [provider] : getProviders();
  const models: ModelInfo[] = [];

  for (const p of providers) {
    try {
      const pModels = getModels(p as KnownProvider);
      for (const m of pModels) {
        models.push({
          id: m.id,
          name: m.name,
          provider: p,
          reasoning: m.reasoning,
          input: m.input,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: m.cost,
        });
      }
    } catch {
      // Skip unknown providers
    }
  }

  return models;
}

/**
 * Get detailed model info for a specific model spec.
 */
export function getModelInfo(spec: string): ModelInfo | undefined {
  try {
    const model = resolveModel(spec);
    return {
      id: model.id,
      name: model.name,
      provider: model.provider as string,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
    };
  } catch {
    return undefined;
  }
}

// ─── Cost Tracking ──────────────────────────────────

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  currency: string;
}

/**
 * Calculate the cost of an LLM call from usage data.
 * Returns cost in USD.
 */
export function estimateCost(model: Model<Api>, usage: Usage): CostEstimate {
  const cost = calculateCost(model, usage);
  return {
    inputCost: cost.input,
    outputCost: cost.output,
    cacheReadCost: cost.cacheRead,
    cacheWriteCost: cost.cacheWrite,
    totalCost: cost.total,
    currency: "USD",
  };
}

// ─── Provider Validation ────────────────────────────

export interface ProviderValidationResult {
  provider: string;
  modelSpec: string;
  hasKey: boolean;
  envVar?: string;
}

/**
 * Validate that all required providers have API keys available.
 * Returns detailed validation results for all model specs.
 */
export function validateProviderKeys(
  modelSpecs: string[]
): { provider: string; modelSpec: string }[] {
  const missing: { provider: string; modelSpec: string }[] = [];
  const seen = new Set<string>();

  for (const spec of modelSpecs) {
    const { provider } = parseModelSpec(spec);
    if (seen.has(provider)) continue;
    seen.add(provider);

    if (!resolveApiKey(provider) && !hasOAuthProfiles(provider)) {
      missing.push({ provider, modelSpec: spec });
    }
  }
  return missing;
}

/**
 * Check if there are any stored OAuth profiles for a provider (synchronous).
 * Used by the sync validation path so OAuth-based providers (openai-codex,
 * github-copilot, anthropic, etc.) aren't rejected before spawn.
 *
 * Reads the auth-profiles.json file directly to avoid async module imports.
 */
function hasOAuthProfiles(provider: string): boolean {
  try {
    const dir = process.env.POLPO_STATE_DIR || join(homedir(), ".polpo");
    const raw = readFileSync(join(dir, "auth-profiles.json"), "utf-8");
    const data = JSON.parse(raw);
    if (!data?.profiles || typeof data.profiles !== "object") return false;
    return Object.values(data.profiles).some(
      (p: any) => p?.provider === provider,
    );
  } catch {
    return false;
  }
}

/**
 * Get detailed validation for a set of model specs — including which env var to set.
 */
export function validateProviderKeysDetailed(
  modelSpecs: string[]
): ProviderValidationResult[] {
  const results: ProviderValidationResult[] = [];
  const seen = new Set<string>();

  for (const spec of modelSpecs) {
    const { provider } = parseModelSpec(spec);
    if (seen.has(provider)) continue;
    seen.add(provider);

    results.push({
      provider,
      modelSpec: spec,
      hasKey: !!resolveApiKey(provider),
      envVar: PROVIDER_ENV_MAP[provider],
    });
  }
  return results;
}

// ─── Dynamic prompt helpers ─────────────────────────

/**
 * Build a dynamic model listing string for system prompts.
 * Uses the pi-ai catalog instead of hardcoded lists.
 */
export function buildModelListingForPrompt(): string {
  const lines: string[] = [
    `Format: "provider:model" (e.g. "anthropic:claude-opus-4-6") or just "model" (auto-inferred from prefix).`,
  ];

  // Show the most relevant providers with their top models
  const FEATURED_PROVIDERS: { provider: string; label: string; picks: number }[] = [
    { provider: "anthropic", label: "anthropic", picks: 3 },
    { provider: "openai", label: "openai", picks: 4 },
    { provider: "google", label: "google", picks: 3 },
    { provider: "opencode", label: "opencode", picks: 3 },
    { provider: "mistral", label: "mistral", picks: 2 },
    { provider: "groq", label: "groq", picks: 2 },
    { provider: "xai", label: "xai", picks: 1 },
    { provider: "amazon-bedrock", label: "amazon-bedrock", picks: 2 },
  ];

  for (const { provider, label, picks } of FEATURED_PROVIDERS) {
    try {
      const models = getModels(provider as KnownProvider);
      if (models.length === 0) continue;
      // Sort by most capable: reasoning first, then by context window
      const sorted = [...models].sort((a, b) => {
        if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
        return b.contextWindow - a.contextWindow;
      });
      const top = sorted.slice(0, picks);
      const modelStr = top.map(m => {
        const tags: string[] = [];
        if (m.cost.input === 0 && m.cost.output === 0) tags.push("FREE");
        if (m.reasoning) tags.push("reasoning");
        const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        return `${m.id}${tagStr}`;
      }).join(", ");
      lines.push(`- ${label}: ${modelStr}`);
    } catch {
      // Skip if provider not available
    }
  }

  // Count total available
  const allProviders = getProviders();
  const totalModels = allProviders.reduce((sum, p) => {
    try { return sum + getModels(p as KnownProvider).length; } catch { return sum; }
  }, 0);

  lines.push(`- ... and ${allProviders.length} total providers with ${totalModels}+ models (use "provider:model" format)`);
  lines.push(`Configure your default model in .polpo/polpo.json or via the POLPO_MODEL env var.`);

  return lines.join("\n");
}

// ─── Model Fallback Chain ───────────────────────────

/**
 * Resolve a model from a fallback chain (synchronous).
 * Tries primary first, then each fallback in order.
 * Returns the first model that has a valid API key.
 *
 * NOTE: This sync variant only checks config/env API keys, NOT OAuth profiles.
 * Use `resolveModelWithFallbackAsync` for the full resolution chain including OAuth.
 */
export function resolveModelWithFallback(config: ModelConfig): { model: Model<Api>; spec: string } {
  // Try primary
  const primary = config.primary;
  if (!primary) {
    throw new Error("No primary model configured. Run 'polpo setup' or set POLPO_MODEL env var.");
  }
  const { provider: primaryProvider } = parseModelSpec(primary);
  if (resolveApiKey(primaryProvider)) {
    try {
      return { model: resolveModel(primary), spec: primary };
    } catch {
      // Primary model not found in catalog — try fallbacks
    }
  }

  // Try fallbacks in order
  if (config.fallbacks) {
    for (const fallback of config.fallbacks) {
      const { provider: fbProvider } = parseModelSpec(fallback);
      if (resolveApiKey(fbProvider)) {
        try {
          return { model: resolveModel(fallback), spec: fallback };
        } catch {
          // Model not found — try next
        }
      }
    }
  }

  // Last resort: try primary anyway (will fail at call time with a clear error)
  return { model: resolveModel(primary), spec: primary };
}

/**
 * Resolve a model from a fallback chain (async).
 * Tries primary first, then each fallback in order.
 * Checks the FULL API key resolution chain including OAuth profiles with auto-refresh.
 *
 * Prefer this over the sync variant when in an async context.
 */
export async function resolveModelWithFallbackAsync(config: ModelConfig): Promise<{ model: Model<Api>; spec: string }> {
  // Try primary
  const primary = config.primary;
  if (!primary) {
    throw new Error("No primary model configured. Run 'polpo setup' or set POLPO_MODEL env var.");
  }
  const { provider: primaryProvider } = parseModelSpec(primary);
  if (await resolveApiKeyAsync(primaryProvider)) {
    try {
      return { model: resolveModel(primary), spec: primary };
    } catch {
      // Primary model not found in catalog — try fallbacks
    }
  }

  // Try fallbacks in order
  if (config.fallbacks) {
    for (const fallback of config.fallbacks) {
      const { provider: fbProvider } = parseModelSpec(fallback);
      if (await resolveApiKeyAsync(fbProvider)) {
        try {
          return { model: resolveModel(fallback), spec: fallback };
        } catch {
          // Model not found — try next
        }
      }
    }
  }

  // Last resort: try primary anyway (will fail at call time with a clear error)
  return { model: resolveModel(primary), spec: primary };
}

// ─── Provider Cooldown ──────────────────────────────

interface CooldownEntry {
  until: number;    // timestamp
  errorCount: number;
  reason?: string;  // "rate_limit" | "auth" | "billing" | "error"
}

const providerCooldowns: Map<string, CooldownEntry> = new Map();

const COOLDOWN_STEPS = [60_000, 300_000, 1_500_000, 3_600_000]; // 1m, 5m, 25m, 1h

/**
 * Check if a provider is currently in cooldown.
 */
export function isProviderInCooldown(provider: string): boolean {
  const entry = providerCooldowns.get(provider);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    providerCooldowns.delete(provider);
    return false;
  }
  return true;
}

/**
 * Mark a provider as temporarily unavailable (cooldown).
 */
export function markProviderCooldown(provider: string, reason?: string): void {
  const existing = providerCooldowns.get(provider);
  const errorCount = (existing?.errorCount ?? 0) + 1;
  const stepIdx = Math.min(errorCount - 1, COOLDOWN_STEPS.length - 1);
  const cooldownMs = COOLDOWN_STEPS[stepIdx];

  providerCooldowns.set(provider, {
    until: Date.now() + cooldownMs,
    errorCount,
    reason,
  });
}

/**
 * Clear cooldown for a provider (e.g. after successful call).
 */
export function clearProviderCooldown(provider: string): void {
  providerCooldowns.delete(provider);
}

/**
 * Get current cooldown state for all providers.
 */
export function getProviderCooldowns(): Record<string, { until: number; errorCount: number; reason?: string }> {
  const result: Record<string, { until: number; errorCount: number; reason?: string }> = {};
  for (const [provider, entry] of providerCooldowns) {
    if (Date.now() < entry.until) {
      result[provider] = { ...entry };
    }
  }
  return result;
}

// ─── Error Classification ───────────────────────────

/**
 * Classify an error to determine if it should trigger cooldown or failover.
 */
export function classifyProviderError(err: unknown): {
  shouldCooldown: boolean;
  shouldFailover: boolean;
  reason: string;
} {
  if (!(err instanceof Error)) {
    return { shouldCooldown: false, shouldFailover: false, reason: "unknown" };
  }

  const msg = err.message.toLowerCase();

  // Auth errors — cooldown + failover
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key") ||
      msg.includes("authentication") || msg.includes("forbidden") || msg.includes("403")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "auth" };
  }

  // Rate limit — cooldown + failover
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") ||
      msg.includes("quota exceeded")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "rate_limit" };
  }

  // Billing — long cooldown + failover
  if (msg.includes("insufficient") || msg.includes("credit") || msg.includes("billing") ||
      msg.includes("payment required") || msg.includes("402")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "billing" };
  }

  // Server errors — short cooldown, failover
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") ||
      msg.includes("overloaded") || msg.includes("service unavailable")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "server_error" };
  }

  // Transient network — no cooldown, retry
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("econnrefused") ||
      msg.includes("socket hang up")) {
    return { shouldCooldown: false, shouldFailover: false, reason: "network" };
  }

  // Non-retryable errors (bad request, invalid model, etc.)
  if (msg.includes("400") || msg.includes("invalid") || msg.includes("not found") ||
      msg.includes("404")) {
    return { shouldCooldown: false, shouldFailover: false, reason: "client_error" };
  }

  return { shouldCooldown: false, shouldFailover: false, reason: "unknown" };
}

// ─── ModelConfig Helpers ────────────────────────────

/**
 * Normalize a model spec that may be string or ModelConfig into a plain string.
 * Useful for APIs that only accept a string model spec.
 */
export function resolveModelSpec(spec: string | ModelConfig | undefined): string | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "string") return spec;
  return spec.primary;
}

// ─── Billing Disable Integration ────────────────────

/**
 * Handle billing disable for a provider — uses the auth store's billing disable
 * mechanism with separate backoff from regular cooldown.
 *
 * This records a billing failure against all stored auth profiles for the provider,
 * which affects profile rotation (billing-disabled profiles are deprioritized).
 */
async function handleBillingDisable(provider: string): Promise<void> {
  try {
    const store = await import("../auth/store.js");
    const profiles = store.getProfilesForProvider(provider);
    for (const { id } of profiles) {
      store.recordBillingFailure(id, "billing");
    }
  } catch {
    // Auth module not available or provider has no profiles — skip
  }
}

// ─── Query Functions ────────────────────────────────

/**
 * Simple prompt → text completion using pi-ai.
 * Integrates with the cooldown system: marks provider cooldown on classified errors,
 * clears cooldown on success. Uses async API key resolution (includes OAuth profiles).
 */
export async function queryText(prompt: string, model?: string): Promise<{ text: string; usage?: Usage; model: Model<Api> }> {
  const m = resolveModel(model);
  const provider = m.provider as string;
  const apiKey = await resolveApiKeyAsync(provider);
  try {
    const response = await completeSimple(m, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, apiKey ? { apiKey } : undefined);
    const textBlocks = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
    const text = textBlocks.map(b => b.text).join("\n").trim();
    // Success — clear any cooldown for this provider
    clearProviderCooldown(provider);
    return {
      text,
      usage: response.usage as Usage | undefined,
      model: m,
    };
  } catch (err) {
    // Classify and potentially cooldown the provider
    const classified = classifyProviderError(err);
    if (classified.reason === "billing") {
      // Billing errors use separate disable mechanism with longer backoff
      markProviderCooldown(provider, classified.reason);
      handleBillingDisable(provider);
    } else if (classified.shouldCooldown) {
      markProviderCooldown(provider, classified.reason);
    }
    throw err;
  }
}

/**
 * Streaming prompt → text with progress callback.
 * Integrates with the cooldown system. Uses async API key resolution (includes OAuth profiles).
 */
export async function queryStream(
  prompt: string,
  model?: string,
  onProgress?: (text: string) => void,
): Promise<{ text: string; usage?: Usage; model: Model<Api> }> {
  const m = resolveModel(model);
  const provider = m.provider as string;
  const apiKey = await resolveApiKeyAsync(provider);
  try {
    const s = streamSimple(m, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, apiKey ? { apiKey } : undefined);

    for await (const event of s) {
      if (event.type === "text_delta" && onProgress) {
        onProgress(event.delta);
      }
    }

    const result = await s.result();
    const textBlocks = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
    const text = textBlocks.map(b => b.text).join("\n").trim();
    // Success — clear cooldown
    clearProviderCooldown(provider);
    return {
      text,
      usage: result.usage as Usage | undefined,
      model: m,
    };
  } catch (err) {
    const classified = classifyProviderError(err);
    if (classified.reason === "billing") {
      markProviderCooldown(provider, classified.reason);
      handleBillingDisable(provider);
    } else if (classified.shouldCooldown) {
      markProviderCooldown(provider, classified.reason);
    }
    throw err;
  }
}

/**
 * Query with model fallback chain — tries primary model, then fallbacks.
 * On provider-level errors, marks cooldown and tries next model.
 */
export async function queryTextWithFallback(
  prompt: string,
  modelConfig: ModelConfig,
): Promise<{ text: string; usage?: Usage; model: Model<Api>; usedSpec: string }> {
  if (!modelConfig.primary) {
    throw new Error("No primary model configured. Run 'polpo setup' or set POLPO_MODEL env var.");
  }
  const specs = [modelConfig.primary, ...(modelConfig.fallbacks || [])];

  let lastError: unknown;

  for (const spec of specs) {
    const { provider } = parseModelSpec(spec);

    // Skip providers in cooldown
    if (isProviderInCooldown(provider)) continue;

    try {
      const result = await queryText(prompt, spec);
      clearProviderCooldown(provider);
      return { ...result, usedSpec: spec };
    } catch (err) {
      lastError = err;
      const classified = classifyProviderError(err);
      if (classified.shouldCooldown) {
        markProviderCooldown(provider, classified.reason);
      }
      if (!classified.shouldFailover) {
        throw err; // Non-retryable error — don't try other providers
      }
      // Continue to next fallback
    }
  }

  throw lastError ?? new Error("All model providers failed or are in cooldown");
}
