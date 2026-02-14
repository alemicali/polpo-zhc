/**
 * Thin wrapper around pi-ai for Polpo's orchestrator-level LLM calls.
 * Provides model parsing, simple completion, and streaming.
 */

import { getModel, completeSimple, streamSimple, type Model, type Api, type KnownProvider } from "@mariozechner/pi-ai";

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
};

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-5-20250929";

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

  // Default to anthropic
  return { provider: "anthropic", modelId: s };
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
 * Replaces querySDKText for orchestrator-level calls.
 */
export async function queryText(prompt: string, model?: string): Promise<string> {
  const m = resolveModel(model);
  const response = await completeSimple(m, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });
  // Extract text from response content blocks
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
  const s = streamSimple(m, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  });

  for await (const event of s) {
    if (event.type === "text_delta" && onProgress) {
      onProgress(event.delta);
    }
  }

  const result = await s.result();
  const textBlocks = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
  return textBlocks.map(b => b.text).join("\n").trim();
}
