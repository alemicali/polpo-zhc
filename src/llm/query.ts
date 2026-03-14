/**
 * LLM integration: query wrappers with retry and cost tracking.
 *
 * Backend: pi-ai (multi-provider, works with any LLM).
 */

import type { Usage, Model, Api } from "@mariozechner/pi-ai";
import type { ModelConfig } from "../core/types.js";
import { withRetry } from "./retry.js";
import { queryText, queryTextWithFallback, resolveModelSpec } from "./pi-client.js";

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
