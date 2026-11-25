/**
 * The agent suite card (an MCP App shown by polpo_agent_suite_show): an agent's suites, a run's
 * report (cases, assertions, scores, deltas versus the baseline, the AI review) or a suite's trend.
 * Built from the REST shapes; the widget (widgets/suite-card) draws it, the text is for clients
 * without MCP Apps.
 */
import {
  deployGateFailures, type AgentDeployGate, type BenchmarkCaseComparison, type BenchmarkLeaderboard, type BenchmarkMatrix, type BenchmarkRun, type DiffSegment,
  type SuiteBaselineComparison, type SuiteRun, type SuiteRunAggregates, type SuiteTrace, type SuiteTrend,
} from "@polpo-ai/core/agent-suites";

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
    /** A deploy gate: required before production (minimum pass rate, also run on publish). */
    gate?: { required: boolean; minPassRate: number; onPublish?: boolean };
    /** Cases that replay a cassette, and multi-turn cases (a simulated or scripted user). */
    cassettes?: number; simulated?: number;
  }>;
  /** The latest deploy gates (newest first): the required suites verifying versions. */
  gates?: SuiteCardGate[];
  link?: string;
  appearance?: Appearance;
}

export interface SuiteCardGate {
  id: string; version: string; status: string; trigger: string; at: string;
  progress: { done: number; total: number };
  /** "Suite: reason" for what did not pass. */
  failed: string[];
  override?: { by: string; reason: string };
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
    /** A multi-turn case: the conversation (shortened) and why it stopped. */
    transcript?: Array<{ role: string; content: string; simulated?: boolean }>;
    simulator?: { stoppedBy: string; calls: number; model?: string };
    /** Replayed from a cassette, or recorded into one. */
    cassette?: { id: string; replayedCalls: number; unmatched: number };
    recorded?: { cassetteId: string; calls: number; redactions: number };
    /** A mission case: its tasks. */
    tasks?: Array<{ title: string; agent: string; status: string }>;
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

/** A benchmark run: its progress, the leaderboard (Pareto front, noise notes) and the case × variant matrix. */
export interface BenchmarkCard {
  kind: "benchmark";
  key: SuiteCardKey;
  generatedAt: string;
  /** The first variant's agent (the card's "agent" for the shared host code). */
  agent: string;
  run: {
    id: string; name: string; status: string; stopReason?: string; startedAt: string;
    progress: BenchmarkRun["progress"]; spentUsd: number; budgetUsd?: number; estimateUsd: number; repetitions: number;
  };
  qualityMetric: "score" | "passRate";
  weights: BenchmarkLeaderboard["weights"];
  leaderboard: Array<{ rank: number; variantId: string; label: string; quality: number; qualityStddev: number; passRate: number; costUsd: number; latencyP50Ms: number; latencyP95Ms: number; composite: number; pareto: boolean; flakiness: number }>;
  notes: string[];
  variants: Array<{ id: string; label: string }>;
  rows: Array<{ key: string; name: string; suite: string; spread: boolean; cells: Record<string, { status: string; passed: number; attempts: number; score?: number }> }>;
  moreRows?: number;
  link?: string;
  appearance?: Appearance;
}

/** One case of a benchmark side by side: each variant's tool calls (diffed) and answer (diffed). */
export interface CompareCard {
  kind: "compare";
  key: SuiteCardKey;
  generatedAt: string;
  agent: string;
  runId: string;
  caseKey: string;
  caseName: string;
  reference: string;
  columns: Array<{
    variantId: string; label: string; status: string; score?: number; costUsd: number; durationMs: number; tokens: number;
    toolCalls: Array<{ name: string; args: string; diff: string; argChanges?: string[]; isError: boolean; mocked: string | false }>;
    missingCalls: string[];
    text: string;
    textDiff?: DiffSegment[];
  }>;
  link?: string;
  appearance?: Appearance;
}

export type SuiteCard = SuiteListCard | SuiteRunCard | SuiteTrendCard | BenchmarkCard | CompareCard;

export function buildBenchmarkCard(input: { run: BenchmarkRun; leaderboard: BenchmarkLeaderboard; matrix: BenchmarkMatrix; key: SuiteCardKey; link?: string; maxRows?: number }): BenchmarkCard {
  const r = input.run;
  const max = input.maxRows ?? 40;
  // the rows where the variants disagree first: what the comparison is about
  const rows = [...input.matrix.rows].sort((a, b) => Number(b.spread) - Number(a.spread));
  return {
    kind: "benchmark", key: input.key, generatedAt: new Date().toISOString(), agent: r.spec.variants[0]?.agent ?? "",
    run: {
      id: r.id, name: r.name, status: r.status, ...(r.stopReason ? { stopReason: r.stopReason } : {}), startedAt: r.startedAt,
      progress: r.progress, spentUsd: r.spentUsd, ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}), estimateUsd: r.estimate.costUsd, repetitions: r.spec.repetitions,
    },
    qualityMetric: input.leaderboard.qualityMetric, weights: input.leaderboard.weights,
    leaderboard: input.leaderboard.entries.map((e) => ({
      rank: e.rank, variantId: e.variantId, label: e.label, quality: e.quality, qualityStddev: e.qualityStddev, passRate: e.passRate, costUsd: e.costUsd,
      latencyP50Ms: e.latencyP50Ms, latencyP95Ms: e.latencyP95Ms, composite: e.composite, pareto: e.pareto, flakiness: e.flakiness,
    })),
    notes: input.leaderboard.notes,
    variants: input.matrix.variants,
    rows: rows.slice(0, max).map((x) => ({
      key: x.key, name: `${x.caseName}${x.row ? ` #${x.row}` : ""}`, suite: x.suiteName, spread: x.spread,
      cells: Object.fromEntries(Object.entries(x.cells).map(([v, c]) => [v, { status: c.status, passed: c.passed, attempts: c.attempts, ...(c.score !== undefined ? { score: c.score } : {}) }])),
    })),
    ...(rows.length > max ? { moreRows: rows.length - max } : {}),
    ...(input.link ? { link: input.link } : {}),
  };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildCompareCard(input: { runId: string; comparison: BenchmarkCaseComparison; key: SuiteCardKey; link?: string }): CompareCard {
  const c = input.comparison;
  return {
    kind: "compare", key: input.key, generatedAt: new Date().toISOString(), agent: c.columns[0]?.owner ?? "", runId: input.runId,
    caseKey: c.key, caseName: c.caseName, reference: c.reference,
    columns: c.columns.map((x) => ({
      variantId: x.variantId, label: x.label, status: x.status, ...(x.score !== undefined ? { score: x.score } : {}), costUsd: x.costUsd, durationMs: x.durationMs,
      tokens: x.tokens.input + x.tokens.output,
      toolCalls: x.toolCalls.slice(0, 30).map((t) => ({ name: t.name, args: cut(JSON.stringify(t.args), 300), diff: t.diff, ...(t.argChanges ? { argChanges: t.argChanges } : {}), isError: t.isError, mocked: t.mocked })),
      missingCalls: x.missingCalls,
      text: cut(x.finalText, 3000),
      ...(x.textDiff ? { textDiff: x.textDiff.length > 400 ? [{ op: "same" as const, text: cut(x.finalText, 3000) }] : x.textDiff } : {}),
    })),
    ...(input.link ? { link: input.link } : {}),
  };
}

/** The parts of a case's trace the card shows (phase 4: conversations, cassettes, mission tasks). */
type CaseTraceIn = Partial<Pick<SuiteTrace, "transcript" | "simulator" | "cassette" | "recorded" | "tasks">>;

/** A case's phase 4 extras for the card: the conversation (shortened), the cassette, the mission's tasks. */
function caseExtras(trace: CaseTraceIn | undefined): Pick<SuiteRunCard["cases"][number], "transcript" | "simulator" | "cassette" | "recorded" | "tasks"> {
  if (!trace) return {};
  return {
    ...(trace.transcript?.length ? { transcript: trace.transcript.slice(0, 12).map((m) => ({ role: m.role, content: m.content.length > 300 ? `${m.content.slice(0, 300)}…` : m.content, ...(m.simulated ? { simulated: true } : {}) })) } : {}),
    ...(trace.simulator ? { simulator: { stoppedBy: trace.simulator.stoppedBy, calls: trace.simulator.calls, ...(trace.simulator.model ? { model: trace.simulator.model } : {}) } } : {}),
    ...(trace.cassette ? { cassette: { id: trace.cassette.id, replayedCalls: trace.cassette.replayedCalls, unmatched: trace.cassette.unmatched.length } } : {}),
    ...(trace.recorded ? { recorded: { cassetteId: trace.recorded.cassetteId, calls: trace.recorded.calls, redactions: trace.recorded.redactions } } : {}),
    ...(trace.tasks?.length ? { tasks: trace.tasks.map((t) => ({ title: t.title, agent: t.agent, status: t.status })) } : {}),
  };
}

type RunIn = Pick<SuiteRun, "id" | "agent" | "suiteId" | "suiteName" | "status" | "target" | "version" | "startedAt" | "stats" | "notes" | "error" | "isBaseline" | "repetitions" | "review"> & {
  variant: { label?: string };
  aggregates?: SuiteRunAggregates;
  baseline?: SuiteBaselineComparison;
  results: Array<{
    key: string; caseName: string; status: string; score?: number; costUsd: number; durationMs: number; error?: string;
    assertions?: Array<{ description: string; passed: boolean; message: string }>;
    scores?: Array<{ id: string; score: number; threshold: number; passed: boolean; description: string; reason?: string; error?: string }>;
    failed?: string[];
    trace?: CaseTraceIn;
  }>;
};

export function buildSuiteListCard(input: {
  agent: string;
  suites: Array<{ id: string; name: string; cases: Array<{ scorers?: unknown[]; mocks?: { cassette?: unknown; simulatedUser?: unknown } }>; datasets: unknown[]; defaultMode: string; scorers?: unknown[]; gate?: { required?: boolean; minPassRate?: number; onPublish?: boolean } }>;
  runs: Array<Pick<SuiteRun, "id" | "suiteId" | "status" | "stats" | "startedAt" | "target" | "version" | "isBaseline" | "benchmarkRunId"> & { aggregates?: { score?: number }; baseline?: { regressions: number } }>;
  gates?: Array<Pick<AgentDeployGate, "id" | "version" | "status" | "trigger" | "requestedAt" | "finishedAt" | "progress" | "suites" | "override">>;
  key: SuiteCardKey; link?: string;
}): SuiteListCard {
  return {
    kind: "suites", key: input.key, generatedAt: new Date().toISOString(), agent: input.agent,
    suites: input.suites.map((s) => {
      const last = input.runs.find((r) => r.suiteId === s.id && !r.benchmarkRunId);
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
        ...(s.gate?.required ? { gate: { required: true, minPassRate: s.gate.minPassRate ?? 1, ...(s.gate.onPublish ? { onPublish: true } : {}) } } : {}),
        ...(s.cases.some((c) => c.mocks?.cassette) ? { cassettes: s.cases.filter((c) => c.mocks?.cassette).length } : {}),
        ...(s.cases.some((c) => c.mocks?.simulatedUser) ? { simulated: s.cases.filter((c) => c.mocks?.simulatedUser).length } : {}),
      };
    }),
    ...(input.gates?.length ? { gates: input.gates.slice(0, 5).map((g) => ({
      id: g.id, version: g.version, status: g.status, trigger: g.trigger, at: g.finishedAt ?? g.requestedAt, progress: g.progress,
      failed: deployGateFailures(g), ...(g.override ? { override: { by: g.override.by, reason: g.override.reason } } : {}),
    })) } : {}),
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
        ...caseExtras(results[0]?.trace),
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
        ...caseExtras(x.trace),
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
  if (card.kind === "benchmark") {
    const r = card.run;
    return [
      `${r.name} [${r.id}] · ${r.status}${r.stopReason ? ` (${r.stopReason})` : ""} · ${r.progress.runsDone}/${r.progress.runsTotal} runs · spent ${usd(r.spentUsd)}${r.budgetUsd !== undefined ? ` of $${r.budgetUsd.toFixed(2)}` : ""}`,
      ...card.leaderboard.map((e) => `${e.rank}. ${e.label}${e.pareto ? " ◆" : ""} · ${card.qualityMetric === "score" ? "score" : "pass rate"} ${e.quality.toFixed(2)} ± ${e.qualityStddev.toFixed(2)} · ${usd(e.costUsd)}/rep · p50 ${(e.latencyP50Ms / 1000).toFixed(1)} s`),
      ...card.notes.map((n) => `≈ ${n}`),
      ...card.rows.map((x) => `${x.spread ? "≠" : " "} ${x.suite} · ${x.name}: ${card.variants.map((v) => { const c = x.cells[v.id]; return `${v.label} ${c?.status ?? "—"}${c?.score !== undefined ? ` ${c.score.toFixed(2)}` : ""}`; }).join(" | ")}`),
    ].join("\n");
  }
  if (card.kind === "compare") {
    return [`${card.caseName} [${card.caseKey}] side by side:`, ...card.columns.map((c) => `${c.label}: ${c.status}${c.score !== undefined ? ` ${c.score.toFixed(2)}` : ""} · ${usd(c.costUsd)} · tools ${c.toolCalls.map((t) => `${t.diff === "same" ? "" : t.diff === "added" ? "+" : "~"}${t.name}`).join(", ") || "none"}${c.missingCalls.length ? ` · missing ${c.missingCalls.join(", ")}` : ""} · ${c.text.slice(0, 300)}`)].join("\n");
  }
  if (card.kind === "suites") {
    if (!card.suites.length) return `${card.agent} has no suites yet.`;
    return [`${card.agent}'s suites:`, ...card.suites.map((s) => `- ${s.name} [${s.id}] · ${s.cases} case(s) · ${s.scorers} scorer(s) · mode ${s.defaultMode}`
      + (s.lastRun ? ` · last ${s.lastRun.status} ${s.lastRun.passed}/${s.lastRun.total}${s.lastRun.score !== undefined ? ` score ${s.lastRun.score.toFixed(2)}` : ""}${s.lastRun.regressions ? ` · ${s.lastRun.regressions} regression(s)` : ""} (${s.lastRun.id})` : " · never run")
      + (s.baselineRunId ? ` · baseline ${s.baselineRunId}` : "")
      + (s.cassettes ? ` · ${s.cassettes} replaying a cassette` : "") + (s.simulated ? ` · ${s.simulated} multi-turn` : "")
      + (s.gate?.required ? ` · REQUIRED to deploy (pass rate ≥ ${pct(s.gate.minPassRate)}${s.gate.onPublish ? ", also on publish" : ""})` : "")),
    ...(card.gates?.length ? ["Deploy gates:", ...card.gates.map((g) => `- ${g.version} · ${g.status === "running" ? `verifying ${g.progress.done}/${g.progress.total}` : g.status}`
      + `${g.override ? ` by ${g.override.by}: "${g.override.reason}"` : ""}${g.failed.length && g.status !== "passed" ? ` · ${g.failed.join(" · ").slice(0, 300)}` : ""} [${g.id}]`)] : [])].join("\n");
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
    if (c.cassette) lines.push(`   ↺ replayed from ${c.cassette.id}: ${c.cassette.replayedCalls} call(s)${c.cassette.unmatched ? `, ${c.cassette.unmatched} unmatched` : ""}`);
    if (c.recorded) lines.push(`   ● recorded into ${c.recorded.cassetteId}: ${c.recorded.calls} call(s), ${c.recorded.redactions} redacted`);
    if (c.tasks) lines.push(`   tasks: ${c.tasks.map((t) => `${t.title} (${t.agent}) ${t.status}`).join(" → ")}`);
    for (const m of c.transcript?.slice(0, 6) ?? []) lines.push(`   ${m.role === "user" ? "USER" : "AGENT"}${m.simulated ? " (simulated)" : ""}: ${m.content.slice(0, 160)}`);
  }
  if (card.review) lines.push("", card.review.text);
  return lines.join("\n");
}
