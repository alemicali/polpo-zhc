/**
 * Labels and marks for where and with what a task run executed (Task.runs / lastRun).
 */
import type { TaskRunContext, TaskRunEngine, TaskRunSummary } from "@polpo-ai/react";
import type { BrandName } from "@/lib/brand-icons";

export const ENGINE_LABELS: Record<TaskRunEngine, string> = { polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex" };

export function engineBrand(engine: string | undefined): BrandName {
  return engine === "claude-code" ? "claude-code" : engine === "codex" ? "codex" : "polpo";
}

export function engineLabel(engine: string | undefined): string {
  return ENGINE_LABELS[(engine ?? "polpo") as TaskRunEngine] ?? engine ?? "Polpo";
}

/** The engine of an agent's config (`"polpo"` or `{ harness }`). */
export function agentEngineId(engine: unknown): TaskRunEngine {
  if (engine === "claude-code" || engine === "codex") return engine;
  if (engine && typeof engine === "object") {
    const h = (engine as { harness?: unknown }).harness;
    if (h === "claude-code" || h === "codex") return h;
  }
  return "polpo";
}

export const AUTH_LABELS: Record<string, string> = { bedrock: "Bedrock", vertex: "Vertex AI", "api-key": "API key", "ai-gateway": "Vercel AI Gateway", gateway: "model gateway" };

export function authBrand(kind: string | undefined, engine?: string): BrandName {
  if (kind === "bedrock") return "bedrock";
  if (kind === "vertex") return "vertex";
  if (kind === "api-key") return engine === "codex" ? "openai" : engine === "claude-code" ? "anthropic" : "api-key";
  return "api-key";
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
