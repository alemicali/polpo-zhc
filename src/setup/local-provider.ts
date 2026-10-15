/**
 * Local (offline) model servers for the setup wizard: Ollama, LM Studio, vLLM or any
 * OpenAI-compatible server on this machine or the local network.
 *
 * Custom providers are normally managed through /providers/custom, which needs an
 * initialized instance. The wizard runs before that, so it discovers the server's models
 * here and hands the resulting provider to /config/initialize, which writes it into
 * polpo.json `providers` like any custom provider.
 *
 * Only local addresses are accepted: these calls happen before setup, without auth.
 */

import {
  getPreset,
  isLikelyLocalHost,
  normalizeBaseUrl,
  validateCustomProvider,
} from "@polpo-ai/core/provider-config";
import type { CustomModelDef, ProviderConfig } from "../core/types.js";
import { discoverCustomProviderModels, type DiscoveryResult } from "../llm/custom-provider-probe.js";

/** Presets offered for an offline setup. "openai-compatible" = any other local server. */
export const LOCAL_SETUP_PRESETS = ["ollama", "lm-studio", "vllm", "openai-compatible"] as const;
export type LocalSetupPreset = (typeof LOCAL_SETUP_PRESETS)[number];

/** Provider id written to polpo.json, also the model-spec prefix ("<id>:<model>"). */
export function localProviderId(preset: LocalSetupPreset): string {
  return preset === "openai-compatible" ? "local" : getPreset(preset)!.suggestedId;
}

export type LocalProviderResult =
  | { ok: true; id: string; config: ProviderConfig }
  | { ok: false; error: string };

/** Build (and validate) the provider config for a local server. */
export function buildLocalProvider(input: {
  preset: string;
  baseUrl?: string;
  models?: CustomModelDef[];
}): LocalProviderResult {
  if (!(LOCAL_SETUP_PRESETS as readonly string[]).includes(input.preset)) {
    return { ok: false, error: `Unknown local server type "${input.preset}"` };
  }
  const presetId = input.preset as LocalSetupPreset;
  const preset = getPreset(presetId)!;
  const api = preset.api;
  const base = normalizeBaseUrl(input.baseUrl?.trim() || preset.baseUrl, api);
  if (base.error || !base.url) return { ok: false, error: base.error ?? "Invalid URL" };
  if (!isLikelyLocalHost(new URL(base.url).hostname)) {
    return { ok: false, error: "Only servers on this machine or the local network can be added here" };
  }

  const validated = validateCustomProvider({
    label: presetId === "openai-compatible" ? "Local model server" : preset.label,
    preset: presetId,
    api,
    baseUrl: base.url,
    auth: { type: "none" },
    // OpenAI-compatible local servers share the self-hosted defaults (no store, no developer role).
    compat: preset.compat ?? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    allowPrivateNetwork: true,
    models: input.models,
  });
  if (!validated.ok) return { ok: false, error: validated.errors.join("; ") };
  return { ok: true, id: localProviderId(presetId), config: validated.config };
}

/**
 * Ollama reports each model's capabilities (/api/show). Agents act through tools (files,
 * commands), so a model without "tools" cannot run tasks: tell the wizard which ones.
 * Other servers do not report it; their models are left unmarked.
 */
async function ollamaToolSupport(baseUrl: string, ids: string[], fetchImpl: typeof fetch): Promise<Map<string, boolean>> {
  const root = baseUrl.replace(/\/v1\/?$/, "");
  const out = new Map<string, boolean>();
  await Promise.all(ids.slice(0, 50).map(async (id) => {
    try {
      const res = await fetchImpl(`${root}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: id }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const info = await res.json() as { capabilities?: unknown };
      if (Array.isArray(info.capabilities)) out.set(id, info.capabilities.includes("tools"));
    } catch { /* unknown: leave unmarked */ }
  }));
  return out;
}

/** Ask the local server which models it serves. */
export async function discoverLocalModels(
  input: { preset: string; baseUrl?: string },
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; id: string; baseUrl: string; result: DiscoveryResult } | { ok: false; error: string }> {
  const built = buildLocalProvider(input);
  if (!built.ok) return built;
  const preset = getPreset(input.preset)!;
  try {
    const result = await discoverCustomProviderModels({
      id: built.id,
      config: built.config,
      kind: preset.discovery === "none" ? "openai" : preset.discovery,
      fetchImpl,
    });
    if (input.preset === "ollama" && result.models.length > 0) {
      const tools = await ollamaToolSupport(built.config.baseUrl!, result.models.map((m) => m.id), fetchImpl ?? fetch);
      result.models = result.models
        .map((m) => (tools.has(m.id) ? { ...m, tools: tools.get(m.id) } : m))
        // Models that can run tasks first, so the wizard's default is one of them.
        .sort((a, b) => Number((b as { tools?: boolean }).tools !== false) - Number((a as { tools?: boolean }).tools !== false));
    }
    return { ok: true, id: built.id, baseUrl: built.config.baseUrl!, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
