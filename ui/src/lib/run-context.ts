/**
 * Labels and marks for where and with what a task run executed (Task.runs / lastRun).
 */
import type { TaskRunContext, TaskRunEngine, TaskRunSummary } from "@polpo-ai/react";
import type { BrandName } from "@/lib/brand-icons";

export const ENGINE_LABELS: Record<TaskRunEngine, string> = {
  polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", "claude-cli": "Claude Code (CLI)", "codex-cli": "Codex (CLI)",
};

const HARNESS_ENGINES = new Set<string>(["claude-code", "codex", "opencode"]);

export function engineBrand(engine: string | undefined): BrandName {
  // the CLI engine wears the program's mark
  if (engine === "claude-cli") return "claude-code";
  if (engine === "codex-cli") return "codex";
  return engine && HARNESS_ENGINES.has(engine) ? (engine as BrandName) : "polpo";
}

export function engineLabel(engine: string | undefined): string {
  return ENGINE_LABELS[(engine ?? "polpo") as TaskRunEngine] ?? engine ?? "Polpo";
}

/** The engine of an agent's config (`"polpo"` or `{ harness }`). */
export function agentEngineId(engine: unknown): TaskRunEngine {
  if (typeof engine === "string" && HARNESS_ENGINES.has(engine)) return engine as TaskRunEngine;
  if (engine && typeof engine === "object") {
    const e = engine as { type?: unknown; cli?: unknown };
    if (e.type === "cli") return e.cli === "codex" ? "codex-cli" : "claude-cli";
    const h = (engine as { harness?: unknown }).harness;
    if (typeof h === "string" && HARNESS_ENGINES.has(h)) return h as TaskRunEngine;
  }
  return "polpo";
}

export const AUTH_LABELS: Record<string, string> = { bedrock: "Bedrock", vertex: "Vertex AI", "api-key": "API key", "ai-gateway": "Vercel AI Gateway", gateway: "model gateway", subscription: "personal plan" };

export function authBrand(kind: string | undefined, engine?: string, provider?: string): BrandName {
  if (kind === "subscription") return engine === "codex-cli" || engine === "codex" ? "openai" : "anthropic";
  if (kind === "bedrock") return "bedrock";
  if (kind === "vertex") return "vertex";
  if (kind === "api-key") {
    // OpenCode: its provider's mark when there is one here (others: ProviderIcon, see openCodeProviderIcon)
    if (engine === "opencode") return provider === "anthropic" ? "anthropic" : provider === "openai" ? "openai" : "api-key";
    return engine === "codex" ? "openai" : engine === "claude-code" ? "anthropic" : "api-key";
  }
  return "api-key";
}

/** OpenCode's model provider with a ProviderIcon of its own (Google, xAI, Moonshot, Z.ai, the Vercel AI Gateway…), else undefined. */
export function openCodeProviderIcon(engine: string | undefined, auth: { kind?: string; provider?: string } | undefined): string | undefined {
  if (engine !== "opencode" || !auth?.provider) return undefined;
  if (auth.kind === "bedrock" || auth.provider === "anthropic" || auth.provider === "openai" || auth.provider === "polpo-gateway") return undefined;
  return auth.provider;
}

/**
 * A readable model name: "us.anthropic.claude-haiku-4-5-20251001-v1:0" → "Haiku 4.5",
 * "anthropic:claude-sonnet-4-5" → "Sonnet 4.5", "gpt-5-codex" → "gpt-5-codex".
 */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?(?![\d])/i.exec(model)
    ?? /claude-(\d+)(?:[-.](\d{1,2}))?-(opus|sonnet|haiku)/i.exec(model);
  if (m) {
    const [family, major, minor] = /^\d/.test(m[1]!) ? [m[3]!, m[1]!, m[2]] : [m[1]!, m[2]!, m[3]];
    return `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ""}`;
  }
  const bare = model.includes(":") && !/^[a-z]+\.anthropic\./.test(model) ? model.slice(model.indexOf(":") + 1) : model;
  return bare;
}

/** "Haiku 4.5 via Bedrock" (harness) or "Sonnet 4.5" (Polpo's engine). */
export function engineDetail(run: Pick<TaskRunContext, "model" | "auth">): string | undefined {
  const model = modelLabel(run.model);
  const via = run.auth ? `via ${AUTH_LABELS[run.auth.kind] ?? run.auth.kind}` : undefined;
  return [model, via].filter(Boolean).join(" ") || undefined;
}

type ComputerLike = Pick<TaskRunContext["computer"], "kind" | "provider" | "daytonaApi"> & { id?: string };

export function computerBrand(c: ComputerLike | undefined): BrandName {
  const p = c?.provider ?? (c?.kind === "daytona" || c?.kind === "e2b" ? c.kind : undefined);
  if (p === "daytona") return "daytona";
  if (p === "e2b") return "e2b";
  return c?.kind === "ephemeral" ? "ephemeral" : "host";
}

/** "Daytona v2", "E2B", "Host", "Ephemeral Daytona". */
export function computerKindLabel(c: ComputerLike | undefined): string {
  if (!c) return "Host";
  const provider = c.provider === "daytona" || c.kind === "daytona"
    ? `Daytona${c.daytonaApi ? ` ${c.daytonaApi}` : ""}`
    : c.provider === "e2b" || c.kind === "e2b" ? "E2B" : undefined;
  if (c.kind === "ephemeral") return provider ? `Ephemeral · ${provider}` : "Ephemeral";
  return provider ?? "Host";
}

export function formatUsd(v: number | undefined): string | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  return v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function formatMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** The latest run of a task, full or slim. */
export function latestRun(task: { runs?: TaskRunContext[]; lastRun?: TaskRunSummary } | undefined): TaskRunSummary | undefined {
  if (!task) return undefined;
  const last = task.runs?.at(-1);
  if (last) {
    return {
      engine: last.engine, ...(last.model ? { model: last.model } : {}), computerId: last.computer.id,
      ...(last.computer.name ? { computerName: last.computer.name } : {}), computerKind: last.computer.kind,
      ...(last.computer.provider ? { provider: last.computer.provider } : {}), status: last.status,
    };
  }
  return task.lastRun;
}
