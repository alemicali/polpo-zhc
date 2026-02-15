/**
 * Thin wrapper around pi-ai for Polpo's orchestrator-level LLM calls.
 * Provides model parsing, simple completion, streaming, and provider auth resolution.
 */

import { getModel, getEnvApiKey, completeSimple, streamSimple, type Model, type Api, type KnownProvider } from "@mariozechner/pi-ai";
import type { ProviderConfig } from "../core/types.js";

/** Provider inference map: model ID prefix → pi-ai provider name */
const PROVIDER_MAP: Record<string, KnownProvider> = {
  "claude-": "anthropic",
  "gpt-": "openai",
  "o1-": "openai",
  "o3-": "openai",
  "o4-": "openai",
  "gemini-": "google",
  "mistral-": "mistral",
  "llama-": "groq",
  "deepseek-": "openrouter",
  "big-pickle": "opencode",
};

const DEFAULT_MODEL = "opencode:big-pickle";

// --- Provider override management ---

/** Provider overrides from polpo.json — set by the orchestrator at init time. */
let providerOverrides: Record<string, ProviderConfig> = {};

export function setProviderOverrides(overrides: Record<string, ProviderConfig>): void {
  providerOverrides = overrides;
}

/**
 * Resolve API key for a provider.
 * Priority: 1) polpo.json overrides, 2) pi-ai env var lookup.
 */
export function resolveApiKey(provider: string): string | undefined {
  const override = providerOverrides[provider];
  if (override?.apiKey) return override.apiKey;
  return getEnvApiKey(provider as KnownProvider);
}

/**
 * Validate that all required providers have API keys available.
 * Returns entries with missing keys.
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

    if (!resolveApiKey(provider)) {
      missing.push({ provider, modelSpec: spec });
    }
  }
  return missing;
}

// --- Model spec parsing ---

/**
 * Parse a model spec string into provider + modelId.
 * Supports formats:
 *   "provider:model" — explicit (e.g. "anthropic:claude-sonnet-4-5-20250929")
 *   "model-id"       — auto-inferred (e.g. "claude-sonnet-4-5-20250929" → anthropic)
 */
export function parseModelSpec(spec?: string): { provider: KnownProvider; modelId: string } {
  const s = spec || process.env.POLPO_MODEL || DEFAULT_MODEL;

  // Explicit "provider:model" format
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    return {
      provider: s.slice(0, colonIdx) as KnownProvider,
      modelId: s.slice(colonIdx + 1),
    };
  }

  // Auto-infer from prefix
  for (const [prefix, provider] of Object.entries(PROVIDER_MAP)) {
    if (s.startsWith(prefix)) {
      return { provider, modelId: s };
    }
  }

  // Default to opencode
  return { provider: "opencode", modelId: s };
}

/**
 * Resolve a model spec to a pi-ai Model object.
 * Uses getModel() with necessary casts for dynamic model IDs.
 */
export function resolveModel(spec?: string): Model<Api> {
  const { provider, modelId } = parseModelSpec(spec);
  return getModel(provider, modelId as never) as Model<Api>;
}

/**
 * Simple prompt → text completion using pi-ai.
 */
export async function queryText(prompt: string, model?: string): Promise<string> {
  const m = resolveModel(model);
  const apiKey = resolveApiKey(m.provider);
  const response = await completeSimple(m, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, apiKey ? { apiKey } : undefined);
  const textBlocks = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
  return textBlocks.map(b => b.text).join("\n").trim();
}

/**
 * Streaming prompt → text with progress callback.
 */
export async function queryStream(
  prompt: string,
  model?: string,
  onProgress?: (text: string) => void,
): Promise<string> {
  const m = resolveModel(model);
  const apiKey = resolveApiKey(m.provider);
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
  return textBlocks.map(b => b.text).join("\n").trim();
}
