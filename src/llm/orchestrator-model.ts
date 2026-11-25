/**
 * The model Polpo itself uses (chat, Spotlight ask, generators) when `settings.orchestratorModel`
 * may be unset: the configured one first; otherwise a model of a connected provider, so a fresh
 * instance with only an API key still works. Throws a readable error pointing to Settings →
 * Orchestrator when neither is available.
 */
import type { ModelConfig } from "../core/types.js";
import { detectProviders } from "../setup/providers.js";
import { listModels, resolveModelSpec } from "./pi-client.js";

/**
 * Providers tried first when nothing is configured, each with its preferred models (the first one
 * in the catalog is picked); a provider's catalog order is alphabetical, so it is the last resort.
 */
const PREFERRED: Record<string, string[]> = {
  "anthropic": ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  "openai-codex": ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol"],
  "openai": ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.5"],
  "google": ["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash"],
  "openrouter": ["~anthropic/claude-sonnet-latest", "anthropic/claude-sonnet-5.5"],
};
const PREFERRED_PROVIDERS = Object.keys(PREFERRED);

export class NoOrchestratorModelError extends Error {
  readonly code = "NO_MODEL";
  constructor() {
    super("Polpo's model is not configured: set it in Settings → Orchestrator, or connect a provider in Settings → Providers.");
    this.name = "NoOrchestratorModelError";
  }
}

/** The configured orchestrator model, or the first model of a connected provider; undefined when none. */
export function effectiveOrchestratorModel(configured: string | ModelConfig | undefined | null): string | ModelConfig | undefined {
  if (configured && resolveModelSpec(configured)) return configured;
  let connected: string[];
  try {
    connected = detectProviders().filter((p) => p.hasKey).map((p) => p.name);
  } catch {
    return undefined;
  }
  const ordered = [...PREFERRED_PROVIDERS.filter((p) => connected.includes(p)), ...connected.filter((p) => !PREFERRED_PROVIDERS.includes(p))];
  for (const provider of ordered) {
    const ids = listModels(provider).map((m) => m.id);
    const id = (PREFERRED[provider] ?? []).find((candidate) => ids.includes(candidate)) ?? ids[0];
    if (id) return `${provider}:${id}`;
  }
  return undefined;
}

/** Like {@link effectiveOrchestratorModel}, throwing {@link NoOrchestratorModelError} when there is none. */
export function requireOrchestratorModel(configured: string | ModelConfig | undefined | null): string | ModelConfig {
  const model = effectiveOrchestratorModel(configured);
  if (!model) throw new NoOrchestratorModelError();
  return model;
}
