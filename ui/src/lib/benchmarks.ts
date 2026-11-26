/**
 * Helpers of the Benchmarks page and the Playground (agent suites phase 5): blank benchmarks and
 * panes, variant labels, the matrix cells' tones, weights and the Pareto chart's points.
 */
import type {
  BenchmarkCellStatus, BenchmarkInput, BenchmarkLeaderboardEntry, BenchmarkRun, BenchmarkVariantSpec, PlaygroundPane, PlaygroundPaneInput, SuiteVariantOverrides,
} from "@polpo-ai/react";

export const DEFAULT_WEIGHTS = { quality: 0.7, cost: 0.2, latency: 0.1 };

/** A new benchmark, optionally from a suite (the Suites tab's "Benchmark"). */
export function blankBenchmark(from?: { agent?: string; suite?: string }): BenchmarkInput {
  return {
    name: from?.suite ? `${from.suite} benchmark` : "New benchmark",
    suites: from?.agent && from.suite ? [{ agent: from.agent, suite: from.suite }] : [],
    variants: from?.agent
      ? [{ agent: from.agent, version: "production", label: "Production" }, { agent: from.agent, version: "draft", label: "Draft" }]
      : [],
    repetitions: 3,
    mode: "all",
  };
}

export function variantText(v: Pick<BenchmarkVariantSpec, "agent" | "version" | "overrides"> & { label?: string }): string {
  const over = overridesText(v.overrides);
  return `${v.label ? `${v.label} · ` : ""}${v.agent}@${v.version ?? "production"}${over ? ` · ${over}` : ""}`;
}

export function overridesText(o: SuiteVariantOverrides | undefined): string {
  if (!o) return "";
  const parts: string[] = [];
  if (o.model) parts.push(o.model);
  if (o.reasoning) parts.push(`reasoning ${o.reasoning}`);
  if (o.instructions !== undefined) parts.push("instructions replaced");
  if (o.instructionsAppend) parts.push("+ instructions");
  if (o.allowedTools) parts.push(`${o.allowedTools.length} tool(s)`);
  if (o.maxTurns) parts.push(`max ${o.maxTurns} turns`);
  if (o.engine !== undefined) parts.push("engine");
  return parts.join(" · ");
}

/** Overrides without empty fields (the forms keep strings; an empty one means "not overridden"). */
export function cleanOverrides(o: SuiteVariantOverrides | undefined): SuiteVariantOverrides | undefined {
  if (!o) return undefined;
  const out: SuiteVariantOverrides = {};
  if (o.model?.trim()) out.model = o.model.trim();
  if (o.reasoning?.trim()) out.reasoning = o.reasoning.trim();
  if (o.instructions !== undefined && o.instructions.trim()) out.instructions = o.instructions;
  if (o.instructionsAppend?.trim()) out.instructionsAppend = o.instructionsAppend.trim();
  if (o.allowedTools?.length) out.allowedTools = o.allowedTools;
  if (o.maxTurns && o.maxTurns > 0) out.maxTurns = o.maxTurns;
  if (o.engine !== undefined) out.engine = o.engine;
  return Object.keys(out).length ? out : undefined;
}

export const CELL_STYLE: Record<BenchmarkCellStatus, { label: string; className: string }> = {
  passed: { label: "✓", className: "bg-success/15 text-success" },
  failed: { label: "✗", className: "bg-destructive/15 text-destructive" },
  mixed: { label: "≈", className: "bg-warning/15 text-warning" },
  errored: { label: "‼", className: "bg-warning/15 text-warning" },
  skipped: { label: "–", className: "bg-muted text-muted-foreground" },
  missing: { label: "", className: "bg-muted/40 text-muted-foreground" },
};

export function benchmarkIsLive(r: Pick<BenchmarkRun, "status">): boolean {
  return r.status === "running" || r.status === "queued";
}

export function formatPct(n: number | undefined): string {
  return n === undefined ? "—" : `${Math.round(n * 100)}%`;
}

/** The leaderboard as chart points: quality (y) against cost per repetition (x), the Pareto front marked. */
export function paretoPoints(entries: BenchmarkLeaderboardEntry[]): Array<{ label: string; variantId: string; cost: number; quality: number; pareto: boolean; latency: number }> {
  return entries.map((e) => ({ label: e.label, variantId: e.variantId, cost: e.costUsd, quality: e.quality, pareto: e.pareto, latency: e.latencyP50Ms }));
}

/** A new Playground pane for an agent. */
export function blankPane(agent: string, n: number, over: Partial<PlaygroundPaneInput> = {}): PlaygroundPaneInput {
  return { label: `Pane ${n}`, variant: { agent, version: "production" }, mockTools: true, mockModel: false, realTools: false, ...over };
}

/** A pane as its input (to send the panes back after a change). */
export function paneInput(p: PlaygroundPane): PlaygroundPaneInput {
  return { id: p.id, ...(p.label ? { label: p.label } : {}), variant: p.variant, mockTools: p.mockTools, mockModel: p.mockModel, realTools: p.realTools, ...(p.mocks ? { mocks: p.mocks } : {}) };
}

/** Does any of these panes run real tools (the confirmation)? */
export function panesUseRealTools(panes: Array<Pick<PlaygroundPaneInput, "realTools">>): boolean {
  return panes.some((p) => p.realTools === true);
}
