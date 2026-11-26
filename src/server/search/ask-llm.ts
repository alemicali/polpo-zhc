/**
 * The search assistant's model: the orchestrator's (settings.orchestratorModel), called through the
 * same auth-aware pi-ai client as Polpo's chat (API keys, OAuth profiles, custom providers and
 * gateways, provider cooldowns).
 */
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ModelConfig } from "../../core/types.js";
import { AskError, type AskAssistantMessage, type AskLlm } from "./ask.js";

export interface AskModel {
  llm: AskLlm;
  provider: string;
  id: string;
}

/** The orchestrator's model as an AskLlm; AskError NO_MODEL when none is configured. */
export async function orchestratorAskModel(spec: string | ModelConfig | undefined): Promise<AskModel> {
  const { resolveModel, resolveModelSpec, buildStreamOpts, streamSimpleWithAuth, classifyProviderError, markProviderCooldown, clearProviderCooldown } = await import("../../llm/pi-client.js");
  let model: Model<Api>;
  try {
    model = resolveModel(resolveModelSpec(spec));
  } catch (err) {
    throw new AskError(`Polpo's model is not configured (Settings → Orchestrator): ${err instanceof Error ? err.message : String(err)}`, "NO_MODEL");
  }
  const provider = model.provider as string;
  const llm: AskLlm = async ({ systemPrompt, messages, tools, maxTokens, signal, onDelta }) => {
    const context = { systemPrompt, messages, ...(tools.length ? { tools } : {}) } as unknown as Context;
    const opts = { ...(buildStreamOpts(undefined, undefined, Math.min(maxTokens, model.maxTokens || maxTokens)) ?? {}), signal };
    try {
      const s = await streamSimpleWithAuth(model, context, opts as never);
      for await (const event of s) {
        if (event.type === "text_delta") onDelta(event.delta);
      }
      const result = await s.result();
      if (result.stopReason !== "error") clearProviderCooldown(provider);
      return result as unknown as AskAssistantMessage;
    } catch (err) {
      const classified = classifyProviderError(err);
      if (classified.shouldCooldown) markProviderCooldown(provider, classified.reason);
      throw err;
    }
  };
  return { llm, provider, id: model.id };
}
