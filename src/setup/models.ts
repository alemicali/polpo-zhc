import { listModels as piListModels } from "../llm/pi-client.js";
import type { ModelInfo } from "../llm/pi-client.js";

export type { ModelInfo };

/**
 * Get models for a provider, sorted by cost (cheapest first).
 */
export function getProviderModels(provider: string): ModelInfo[] {
  return piListModels(provider).sort((a, b) => a.cost.input - b.cost.input);
}

/**
 * Format a model cost as a human-readable string.
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "free";
  if (cost < 1) return `$${cost.toFixed(2)}/M`;
  return `$${cost.toFixed(0)}/M`;
}

/**
 * Get structured label data for a model. Pure data — no formatting.
 * CLI wraps this with chalk, server returns it as JSON.
 */
export function modelLabel(m: ModelInfo): { name: string; tags: string[]; costStr: string } {
  const tags: string[] = [];
  if (m.reasoning) tags.push("reasoning");
  if (m.cost.input === 0 && m.cost.output === 0) tags.push("free");
  const costStr = m.cost.input > 0
    ? `in:${formatCost(m.cost.input)} out:${formatCost(m.cost.output)}`
    : "";
  return { name: m.name, tags, costStr };
}
