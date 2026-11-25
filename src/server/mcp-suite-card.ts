/**
 * The agent suite card (an MCP App shown by polpo_agent_suite_show): an agent's suites, a run's
 * report (cases, assertions, scores, deltas versus the baseline, the AI review) or a suite's trend.
 * Built from the REST shapes; the widget (widgets/suite-card) draws it, the text is for clients
 * without MCP Apps.
 */
import type { SuiteBaselineComparison, SuiteRun, SuiteRunAggregates, SuiteTrend } from "@polpo-ai/core/agent-suites";

export interface SuiteCardKey { createdAt: number; seq: number }

type Appearance = { light?: Record<string, string>; dark?: Record<string, string> };

export interface SuiteListCard {
  kind: "suites";
  key: SuiteCardKey;
  generatedAt: string;
  agent: string;
  suites: Array<{
    id: string; name: string; cases: number; datasets: number; scorers: number; defaultMode: string;
    lastRun?: { id: string; status: string; passed: number; total: number; score?: number; startedAt: string; target: string; version?: string; regressions?: number };
    baselineRunId?: string;
  }>;
  link?: string;
  appearance?: Appearance;
}

export interface SuiteRunCard {
  kind: "run";
  key: SuiteCardKey;
  generatedAt: string;
  agent: string;
  run: {
    id: string; suiteId: string; suiteName: string; status: string; target: string; version?: string; label?: string; startedAt: string;
    passed: number; total: number; failed: number; errored: number; skipped: number; passRate: number; costUsd: number; durationMs: number;
    score?: number; isBaseline?: boolean; repetitions?: number; error?: string;
  };
  scorers: Array<{ id: string; label: string; mean: number; median: number; p10: number; passRate: number; delta?: number; change?: string }>;
  cases: Array<{
    key: string; name: string; status: string; score?: number; costUsd: number; durationMs: number;
    /** Failed assertions and scorers, in words. */
    failed: string[];
    scores: Array<{ id: string; score: number; threshold: number; passed: boolean }>;
    change?: string; reasons?: string[]; flaky?: boolean; attempts?: number; passRate?: number;
  }>;
  baseline?: { runId: string; source: string; target?: string; version?: string; passRateDelta: number; scoreDelta?: number; costDelta: number; regressions: number; improvements: number };
  review?: { text: string; model?: string; at: string };
  notes: string[];
  link?: string;
  appearance?: Appearance;
}

export interface SuiteTrendCard {
  kind: "trend";
  key: SuiteCardKey;
  generatedAt: string;
  agent: string;
  suiteId: string;
  suiteName?: string;
  points: SuiteTrend["points"];
  byVersion: SuiteTrend["byVersion"];
  scorers: SuiteTrend["scorers"];
  link?: string;
  appearance?: Appearance;
}

export type SuiteCard = SuiteListCard | SuiteRunCard | SuiteTrendCard;

type RunIn = Pick<SuiteRun, "id" | "agent" | "suiteId" | "suiteName" | "status" | "target" | "version" | "startedAt" | "stats" | "notes" | "error" | "isBaseline" | "repetitions" | "review"> & {
  variant: { label?: string };
  aggregates?: SuiteRunAggregates;
  baseline?: SuiteBaselineComparison;
  results: Array<{
    key: string; caseName: string; status: string; score?: number; costUsd: number; durationMs: number; error?: string;
    assertions?: Array<{ description: string; passed: boolean; message: string }>;
    scores?: Array<{ id: string; score: number; threshold: number; passed: boolean; description: string; reason?: string; error?: string }>;
    failed?: string[];
  }>;
};

export function buildSuiteListCard(input: {
  agent: string;
  suites: Array<{ id: string; name: string; cases: Array<{ scorers?: unknown[] }>; datasets: unknown[]; defaultMode: string; scorers?: unknown[] }>;
  runs: Array<Pick<SuiteRun, "id" | "suiteId" | "status" | "stats" | "startedAt" | "target" | "version" | "isBaseline"> & { aggregates?: { score?: number }; baseline?: { regressions: number } }>;
  key: SuiteCardKey; link?: string;
}): SuiteListCard {
  return {
    kind: "suites", key: input.key, generatedAt: new Date().toISOString(), agent: input.agent,
    suites: input.suites.map((s) => {
      const last = input.runs.find((r) => r.suiteId === s.id);
      const base = input.runs.find((r) => r.suiteId === s.id && r.isBaseline);
      return {
        id: s.id, name: s.name, cases: s.cases.length, datasets: s.datasets.length, defaultMode: s.defaultMode,
        scorers: (s.scorers?.length ?? 0) + s.cases.reduce((a, c) => a + (c.scorers?.length ?? 0), 0),
        ...(last ? { lastRun: {
          id: last.id, status: last.status, passed: last.stats.passed, total: last.stats.total - last.stats.skipped, startedAt: last.startedAt, target: last.target,
          ...(last.version ? { version: last.version } : {}), ...(last.aggregates?.score !== undefined ? { score: last.aggregates.score } : {}),
          ...(last.baseline ? { regressions: last.baseline.regressions } : {}),
        } } : {}),
        ...(base ? { baselineRunId: base.id } : {}),
      };
    }),
    ...(input.link ? { link: input.link } : {}),
  };
}

export function buildSuiteRunCard(input: { run: RunIn; key: SuiteCardKey; link?: string }): SuiteRunCard {
  const r = input.run;
  const a = r.aggregates;
  const b = r.baseline;
  const caseAgg = new Map((a?.cases ?? []).map((c) => [c.key, c]));
  const deltas = new Map((b?.cases ?? []).map((c) => [c.key, c]));
  const scorerDeltas = new Map((b?.scorers ?? []).map((x) => [x.id, x]));
  // with repetitions, one row per case (its attempts aggregated); else one per result
  const reps = (r.repetitions ?? a?.repetitions ?? 1) > 1;
  const cases: SuiteRunCard["cases"] = reps
    ? (a?.cases ?? []).map((c) => {
      const results = r.results.filter((x) => x.key.replace(/~\d+$/, "") === c.key);
      const d = deltas.get(c.key);
      return {
        key: c.key, name: c.caseName, status: c.status, ...(c.score !== undefined ? { score: c.score } : {}), costUsd: c.costUsd, durationMs: c.durationMs,
        failed: [...new Set(results.flatMap(failedOf))].slice(0, 8),
        scores: Object.entries(c.scores).map(([id, score]) => ({ id, score, threshold: results[0]?.scores?.find((x) => x.id === id)?.threshold ?? 1, passed: score >= (results[0]?.scores?.find((x) => x.id === id)?.threshold ?? 1) })),
        flaky: c.flaky, attempts: c.attempts, passRate: c.passRate,
        ...(d ? { change: d.change, reasons: d.reasons } : {}),
      };
    })
    : r.results.map((x) => {
      const d = deltas.get(x.key);
      const agg = caseAgg.get(x.key);
      return {
        key: x.key, name: x.caseName, status: x.status, ...(x.score !== undefined ? { score: x.score } : {}), costUsd: x.costUsd, durationMs: x.durationMs,
        failed: failedOf(x).slice(0, 8),
        scores: (x.scores ?? []).map((s) => ({ id: s.id, score: s.score, threshold: s.threshold, passed: s.passed })),
        ...(agg?.flaky ? { flaky: true } : {}),
        ...(d ? { change: d.change, reasons: d.reasons } : {}),
      };
    });
  return {
    kind: "run", key: input.key, generatedAt: new Date().toISOString(), agent: r.agent,
    run: {
      id: r.id, suiteId: r.suiteId, suiteName: r.suiteName, status: r.status, target: r.target, ...(r.version ? { version: r.version } : {}),
      ...(r.variant.label ? { label: r.variant.label } : {}), startedAt: r.startedAt,
      passed: r.stats.passed, total: r.stats.total - r.stats.skipped, failed: r.stats.failed, errored: r.stats.errored, skipped: r.stats.skipped,
      passRate: r.stats.passRate, costUsd: r.stats.costUsd, durationMs: r.stats.durationMs,
      ...(a?.score !== undefined ? { score: a.score } : {}), ...(r.isBaseline ? { isBaseline: true } : {}),
      ...(reps ? { repetitions: r.repetitions ?? a?.repetitions } : {}), ...(r.error ? { error: r.error } : {}),
    },
    scorers: (a?.scorers ?? []).map((x) => {
      const d = scorerDeltas.get(x.id);
      return { id: x.id, label: x.label, mean: x.mean, median: x.median, p10: x.p10, passRate: x.passRate, ...(d?.delta !== undefined ? { delta: d.delta, change: d.change } : {}) };
    }),
    cases,
    ...(b ? { baseline: {
      runId: b.runId, source: b.source, ...(b.baselineTarget ? { target: b.baselineTarget } : {}), ...(b.baselineVersion ? { version: b.baselineVersion } : {}),
      passRateDelta: b.passRateDelta, ...(b.scoreDelta !== undefined ? { scoreDelta: b.scoreDelta } : {}), costDelta: b.costDelta, regressions: b.regressions, improvements: b.improvements,
    } } : {}),
    ...(r.review ? { review: { text: r.review.text, ...(r.review.model ? { model: r.review.model } : {}), at: r.review.at } } : {}),
    notes: r.notes,
    ...(input.link ? { link: input.link } : {}),
  };
}

function failedOf(x: RunIn["results"][number]): string[] {
  if (x.failed) return x.failed;
  return [
    ...(x.error ? [x.error] : []),
    ...(x.assertions ?? []).filter((y) => !y.passed).map((y) => `${y.description}: ${y.message}`),
    ...(x.scores ?? []).filter((y) => !y.passed).map((y) => `${y.description}: ${y.score.toFixed(2)} < ${y.threshold}${y.error ? ` (${y.error})` : y.reason ? ` — ${y.reason}` : ""}`),
  ];
}

export function buildSuiteTrendCard(input: { agent: string; suiteName?: string; trend: SuiteTrend; key: SuiteCardKey; link?: string }): SuiteTrendCard {
  const t = input.trend;
  return {
    kind: "trend", key: input.key, generatedAt: new Date().toISOString(), agent: input.agent, suiteId: t.suiteId,
    ...(input.suiteName ? { suiteName: input.suiteName } : {}),
    points: t.points, byVersion: t.byVersion, scorers: t.scorers,
    ...(input.link ? { link: input.link } : {}),
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;

/** The card as text (clients without MCP Apps, and the model). */
export function suiteCardText(card: SuiteCard): string {
  if (card.kind === "suites") {
    if (!card.suites.length) return `${card.agent} has no suites yet.`;
    return [`${card.agent}'s suites:`, ...card.suites.map((s) => `- ${s.name} [${s.id}] · ${s.cases} case(s) · ${s.scorers} scorer(s) · mode ${s.defaultMode}`
      + (s.lastRun ? ` · last ${s.lastRun.status} ${s.lastRun.passed}/${s.lastRun.total}${s.lastRun.score !== undefined ? ` score ${s.lastRun.score.toFixed(2)}` : ""}${s.lastRun.regressions ? ` · ${s.lastRun.regressions} regression(s)` : ""} (${s.lastRun.id})` : " · never run")
      + (s.baselineRunId ? ` · baseline ${s.baselineRunId}` : ""))].join("\n");
  }
  if (card.kind === "trend") {
    if (!card.points.length) return `${card.suiteName ?? card.suiteId} has no finished runs yet.`;
    return [`${card.suiteName ?? card.suiteId}: ${card.points.length} run(s)`,
      ...card.points.map((p) => `${p.startedAt.slice(0, 16).replace("T", " ")} ${p.version ? `v${p.version}` : p.target} · pass ${pct(p.passRate)}${p.score !== undefined ? ` · score ${p.score.toFixed(2)}` : ""} · ${usd(p.costUsd)} [${p.runId}]`)].join("\n");
  }
  const r = card.run;
  const lines = [`${r.suiteName} @ ${r.version ? `v${r.version}` : r.target} · ${r.status} · ${r.passed}/${r.total} passed${r.score !== undefined ? ` · score ${r.score.toFixed(2)}` : ""} · ${usd(r.costUsd)} [${r.id}]${r.isBaseline ? " · baseline" : ""}`];
  if (card.scorers.length) lines.push(`scorers: ${card.scorers.map((x) => `${x.id} ${x.mean.toFixed(2)}${x.delta !== undefined ? ` (${signed(x.delta)})` : ""}`).join(", ")}`);
  if (card.baseline) lines.push(`vs ${card.baseline.runId}: pass rate ${signed(card.baseline.passRateDelta * 100, 0)} pts${card.baseline.scoreDelta !== undefined ? `, score ${signed(card.baseline.scoreDelta)}` : ""}; ${card.baseline.regressions} regression(s), ${card.baseline.improvements} improvement(s)`);
  for (const c of card.cases) {
    lines.push(`${c.status === "passed" ? "✓" : c.status === "skipped" ? "–" : "✗"} ${c.name} [${c.key}]${c.score !== undefined ? ` ${c.score.toFixed(2)}` : ""}${c.change && c.change !== "unchanged" ? ` · ${c.change}` : ""}${c.flaky ? " · flaky" : ""}`);
    for (const f of c.failed.slice(0, 3)) lines.push(`   ✗ ${f.slice(0, 200)}`);
  }
  if (card.review) lines.push("", card.review.text);
  return lines.join("\n");
}
