/**
 * LLM integration: query wrappers with retry and cost tracking.
 *
 * Backend: pi-ai (multi-provider, works with any LLM).
 */

import type { Usage, Model, Api } from "@mariozechner/pi-ai";
import type { ModelConfig } from "../core/types.js";
import { withRetry } from "./retry.js";
import { queryText, queryStream, queryTextWithFallback, resolveModelSpec } from "./pi-client.js";

/** Progress callback for streaming queries */
export type OnProgress = (event: string) => void;

/** Result from an LLM query with optional metadata */
export interface QueryResult {
  text: string;
  usage?: Usage;
  model?: Model<Api>;
  /** Which model spec was actually used (useful when fallback triggered) */
  usedSpec?: string;
  /** Estimated cost in USD (null if cost info unavailable) */
  costUsd?: number;
}

/**
 * Query LLM for text-only response (no tools).
 * Uses pi-ai multi-provider backend. Model can be "provider:model" or bare model ID.
 */
export async function querySDKText(prompt: string, model?: string): Promise<string> {
  return withRetry(async () => {
    const result = await queryText(prompt, model);
    return result.text;
  }, { maxRetries: 2 });
}

/**
 * Query LLM with full result metadata (usage, cost, model info).
 */
export async function querySDKTextDetailed(prompt: string, model?: string): Promise<QueryResult> {
  return withRetry(async () => {
    const result = await queryText(prompt, model);
    const { calculateCost } = await import("@mariozechner/pi-ai");
    let costUsd: number | undefined;
    if (result.usage) {
      try {
        const cost = calculateCost(result.model, result.usage);
        costUsd = cost.total;
      } catch {
        // Cost calculation may fail for custom models
      }
    }
    return {
      text: result.text,
      usage: result.usage,
      model: result.model,
      costUsd,
    };
  }, { maxRetries: 2 });
}

/**
 * Query with model fallback chain — tries primary model, then each fallback.
 * Returns which model was actually used.
 */
export async function querySDKWithFallback(
  prompt: string,
  modelConfig: ModelConfig,
): Promise<QueryResult> {
  return withRetry(async () => {
    const result = await queryTextWithFallback(prompt, modelConfig);
    const { calculateCost } = await import("@mariozechner/pi-ai");
    let costUsd: number | undefined;
    if (result.usage) {
      try {
        const cost = calculateCost(result.model, result.usage);
        costUsd = cost.total;
      } catch { /* ignore */ }
    }
    return {
      text: result.text,
      usage: result.usage,
      model: result.model,
      usedSpec: result.usedSpec,
      costUsd,
    };
  }, { maxRetries: 1 }); // Lower retries since fallback already handles provider failures
}

/**
 * Query with tool access.
 * Currently falls back to text-only query via pi-ai.
 */
export async function querySDK(
  prompt: string,
  allowedTools: string[],
  onProgress?: OnProgress,
  model?: string,
): Promise<string> {
  // Tools are handled by the built-in engine at spawn time;
  // for orchestrator-level queries, use text-only.
  return querySDKText(prompt, model);
}

/**
 * Streaming text query with progress callback.
 * Each delta chunk is passed to onChunk as it arrives.
 */
export async function querySDKStream(
  prompt: string,
  model?: string,
  onChunk?: (delta: string) => void,
): Promise<string> {
  return withRetry(async () => {
    const result = await queryStream(prompt, model, onChunk);
    return result.text;
  }, { maxRetries: 2 });
}

/**
 * Streaming query with full metadata.
 */
export async function querySDKStreamDetailed(
  prompt: string,
  model?: string,
  onChunk?: (delta: string) => void,
): Promise<QueryResult> {
  return withRetry(async () => {
    const result = await queryStream(prompt, model, onChunk);
    const { calculateCost } = await import("@mariozechner/pi-ai");
    let costUsd: number | undefined;
    if (result.usage) {
      try {
        const cost = calculateCost(result.model, result.usage);
        costUsd = cost.total;
      } catch { /* ignore */ }
    }
    return {
      text: result.text,
      usage: result.usage,
      model: result.model,
      costUsd,
    };
  }, { maxRetries: 2 });
}

// ─── Smart Orchestrator Query ───────────────────────

/**
 * Smart query function for orchestrator-level LLM calls.
 *
 * Accepts `string | ModelConfig | undefined` directly — no need for `resolveModelSpec()`.
 * When given a ModelConfig with fallbacks, uses the full fallback chain with cooldown.
 * When given a plain string, uses standard query with retry.
 *
 * Returns text + cost metadata. This is the recommended function for all orchestrator
 * subsystems (assessment, deadlock, escalation, chat, plan generation).
 */
export async function queryOrchestratorText(
  prompt: string,
  model: string | ModelConfig | undefined,
): Promise<QueryResult> {
  // If ModelConfig with fallbacks, use fallback-aware query
  if (model && typeof model === "object" && model.fallbacks && model.fallbacks.length > 0) {
    return withRetry(async () => {
      const result = await queryTextWithFallback(prompt, model);
      const { calculateCost } = await import("@mariozechner/pi-ai");
      let costUsd: number | undefined;
      if (result.usage) {
        try {
          const cost = calculateCost(result.model, result.usage);
          costUsd = cost.total;
        } catch { /* ignore */ }
      }
      return {
        text: result.text,
        usage: result.usage,
        model: result.model,
        usedSpec: result.usedSpec,
        costUsd,
      };
    }, { maxRetries: 1 }); // Lower retries since fallback handles provider failures
  }

  // Plain string or ModelConfig without fallbacks — standard query
  const spec = resolveModelSpec(model);
  return withRetry(async () => {
    const result = await queryText(prompt, spec);
    const { calculateCost } = await import("@mariozechner/pi-ai");
    let costUsd: number | undefined;
    if (result.usage) {
      try {
        const cost = calculateCost(result.model, result.usage);
        costUsd = cost.total;
      } catch { /* ignore */ }
    }
    return {
      text: result.text,
      usage: result.usage,
      model: result.model,
      costUsd,
    };
  }, { maxRetries: 2 });
}
