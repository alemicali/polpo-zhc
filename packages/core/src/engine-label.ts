/**
 * The engine an agent or a run uses, named the same way everywhere a model is shown: after the
 * model comes the engine's mark and its type — "Polpo" (Polpo's own agent loop, any provider),
 * "<Claude Code|Codex|OpenCode> Harness" (the Vercel AI SDK harness, API key / Bedrock / Vertex /
 * gateway) or "<Claude Code|Codex> CLI" (the official program signed in with a person's own plan).
 *
 * Pure and dependency-free: the dashboard, the MCP widgets and the MCP/Polpo text outputs share it.
 */

/** The engine ids recorded on runs (TaskRunContext.engine) and derived from agent.engine. */
export type EngineId = "polpo" | "claude-code" | "codex" | "opencode" | "claude-cli" | "codex-cli";

/** Polpo's own loop, an official harness, or an official CLI. */
export type EngineKind = "polpo" | "harness" | "cli";

export const ENGINE_KIND_LABELS: Record<EngineKind, string> = { polpo: "Polpo", harness: "Harness", cli: "CLI" };

/** The product: "Polpo", "Claude Code", "Codex", "OpenCode". */
export const ENGINE_PRODUCTS: Record<EngineId, string> = {
  polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", "claude-cli": "Claude Code", "codex-cli": "Codex",
};

const IDS = new Set<string>(Object.keys(ENGINE_PRODUCTS));
const HARNESS = new Set<string>(["claude-code", "codex", "opencode"]);

/** A known engine id, else "polpo" (absent, unknown or legacy values). */
export function normalizeEngineId(id: unknown): EngineId {
  return typeof id === "string" && IDS.has(id) ? (id as EngineId) : "polpo";
}

export function engineKindOf(id: unknown): EngineKind {
  const e = normalizeEngineId(id);
  return e === "polpo" ? "polpo" : HARNESS.has(e) ? "harness" : "cli";
}

/** "Polpo", "Claude Code Harness", "OpenCode Harness", "Claude Code CLI", "Codex CLI". */
export function engineMarkLabel(id: unknown): string {
  const e = normalizeEngineId(id);
  const kind = engineKindOf(e);
  return kind === "polpo" ? "Polpo" : `${ENGINE_PRODUCTS[e]} ${ENGINE_KIND_LABELS[kind]}`;
}

/** For text outputs: "Polpo", "Claude Code · Harness", "Codex · CLI". */
export function engineTypeText(id: unknown): string {
  const e = normalizeEngineId(id);
  const kind = engineKindOf(e);
  return kind === "polpo" ? "Polpo" : `${ENGINE_PRODUCTS[e]} · ${ENGINE_KIND_LABELS[kind]}`;
}

/** "claude-sonnet-4-6 (Claude Code · CLI)", "gpt-6 (Polpo)", "default model (OpenCode · Harness)". */
export function modelWithEngineText(model: string | undefined, id: unknown, fallback = "default model"): string {
  return `${model || fallback} (${engineTypeText(id)})`;
}

/**
 * The engine of an agent's config: absent or "polpo" → Polpo; "claude-code" / { harness } → that
 * harness; { type: "cli", cli } → that CLI. Lenient (configs were validated when saved).
 */
export function agentEngineIdOf(engine: unknown): EngineId {
  if (typeof engine === "string") return HARNESS.has(engine) ? (engine as EngineId) : "polpo";
  if (engine && typeof engine === "object") {
    const e = engine as { type?: unknown; cli?: unknown; harness?: unknown };
    if (e.type === "cli") return e.cli === "codex" ? "codex-cli" : "claude-cli";
    if (typeof e.harness === "string" && HARNESS.has(e.harness)) return e.harness as EngineId;
  }
  return "polpo";
}

/**
 * The model an agent actually runs: the engine's own model on a harness or a CLI (undefined: the
 * harness setting's or the CLI's default), the agent's model on Polpo's engine.
 */
export function agentEffectiveModel(agent: { model?: unknown; engine?: unknown } | undefined): string | undefined {
  if (!agent) return undefined;
  if (agentEngineIdOf(agent.engine) === "polpo") return typeof agent.model === "string" && agent.model ? agent.model : undefined;
  const m = (agent.engine as { model?: unknown } | undefined)?.model;
  return typeof m === "string" && m ? m : undefined;
}
