/**
 * Agent suites phase 5: benchmarks and the Playground (docs/agent-suites.md, "Benchmarks" and
 * "Playground").
 *
 * A **benchmark** runs one or more suites (or the cases of one dataset) against N **variants** — an
 * agent (any agent) at a version with per-run overrides (model, reasoning, engine, instructions,
 * tools, max turns) — R times each (repetitions). Each (suite, variant, repetition) is an ordinary
 * suite run with `benchmarkRunId`, `repetition` and `variant`; the benchmark keeps the list and
 * compares the variants:
 *
 *   stats        per variant: pass rate and score (mean ± stddev over repetitions), per-scorer means,
 *                cost, latency p50 / p95, tokens, flakiness
 *   matrix       case × variant: each cell's attempts, pass rate, score, cost, latency, its results
 *   leaderboard  a weighted ranking (quality vs cost vs latency), the Pareto front, and a note when
 *                two variants differ by less than the noise
 *   compare      one case side by side for 2–4 variants: tool calls aligned and diffed (names and
 *                arguments), the final answers diffed word by word
 *
 * The **Playground** opens 2–4 chat panes, each bound to a variant with its own mocks; its exchanges
 * are traces like a case's, so "Save as test case" goes through caseFromTrace and "Promote variant"
 * writes the overrides into the agent's draft (never deployed).
 *
 * Pure functions only: the server (src/server/agent-benchmarks.ts) runs and stores.
 */
import {
  AgentSuiteError, SUITE_MOCK_MODES, caseFromTrace, suiteSlug,
  type ModelMock, type SuiteCase, type SuiteCaseResult, type SuiteMockMode, type SuiteRun, type SuiteRunStatus, type SuiteTrace,
  type SuiteVariantOverrides, type ToolMock,
} from "./agent-suites.js";
import { baseCaseKey, mean, quantile, stddev } from "./agent-suite-evals.js";

export const BENCHMARK_LIMITS = {
  suites: 20,
  variants: 8,
  repetitions: 10,
  /** Finished benchmark runs kept (the newest). */
  runsKept: 50,
  definitions: 200,
  /** Playground panes, and variants compared side by side. */
  panes: 4,
  compareColumns: 4,
  /** Benchmark suite runs kept per suite owner, apart from its ordinary runs. */
  suiteRunsKept: 300,
} as const;

// ── Definitions ──────────────────────────────────────────────────────

/** A variant: an agent (any agent) at a version, with per-run overrides. */
export interface BenchmarkVariantSpec {
  id: string;
  label?: string;
  agent: string;
  /** production (default), draft or a published version (1.2.0). */
  version: string;
  overrides?: SuiteVariantOverrides;
}

/** A suite of the benchmark: its owner (an agent), its id, optionally some cases or the cases of one dataset. */
export interface BenchmarkSuiteRef {
  /** The agent the suite belongs to (its cases run against every variant's agent). */
  agent: string;
  suite: string;
  caseIds?: string[];
  /** Only the cases that use this dataset (a benchmark over a dataset). */
  dataset?: string;
}

/** How the leaderboard weighs quality (score, else pass rate), cost and latency. */
export interface BenchmarkWeights { quality: number; cost: number; latency: number }
export const DEFAULT_BENCHMARK_WEIGHTS: BenchmarkWeights = { quality: 0.7, cost: 0.2, latency: 0.1 };

export interface BenchmarkDefinition {
  id: string;
  name: string;
  description?: string;
  suites: BenchmarkSuiteRef[];
  variants: BenchmarkVariantSpec[];
  /** Each (suite, variant) runs this many times (1–10). */
  repetitions: number;
  /** Every case in this mode (default: each case's own). all is offline and free. */
  mode?: SuiteMockMode;
  /** Cases at once inside each run (1–4). */
  concurrency?: number;
  /** Stop the benchmark once it has spent this much (USD): the runs not finished are cancelled. */
  budgetUsd?: number;
  weights?: BenchmarkWeights;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** The parts of a definition a run needs (an ad hoc benchmark has no id). */
export type BenchmarkSpec = Omit<BenchmarkDefinition, "id" | "revision" | "createdAt" | "updatedAt" | "updatedBy"> & { id?: string };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, where: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim()) throw new AgentSuiteError(`${where} is required (text)`);
  if (v.length > max) throw new AgentSuiteError(`${where} is longer than ${max} characters`);
  return v.trim();
};
const optStr = (v: unknown, where: string, max = 200): string | undefined => (v === undefined || v === null || v === "" ? undefined : str(v, where, max));
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

/** Per-run overrides, validated (the same fields a suite run takes). */
export function parseVariantOverrides(v: unknown, where = "overrides"): SuiteVariantOverrides | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const known = new Set(["model", "reasoning", "engine", "instructions", "instructionsAppend", "allowedTools", "maxTurns"]);
  const extra = Object.keys(v).filter((k) => !known.has(k));
  if (extra.length) throw new AgentSuiteError(`${where}: unknown field(s) ${extra.join(", ")} (model, reasoning, engine, instructions, instructionsAppend, allowedTools, maxTurns)`);
  if (v.allowedTools !== undefined && (!Array.isArray(v.allowedTools) || v.allowedTools.some((t) => typeof t !== "string"))) throw new AgentSuiteError(`${where}.allowedTools must be a list of tool names`);
  if (v.maxTurns !== undefined && (!Number.isInteger(v.maxTurns) || (v.maxTurns as number) < 1 || (v.maxTurns as number) > 200)) throw new AgentSuiteError(`${where}.maxTurns must be a whole number from 1 to 200`);
  const out = compact<SuiteVariantOverrides>({
    model: optStr(v.model, `${where}.model`),
    reasoning: optStr(v.reasoning, `${where}.reasoning`, 40),
    ...(v.engine !== undefined && v.engine !== null ? { engine: v.engine } : {}),
    instructions: typeof v.instructions === "string" ? (v.instructions.length > 100_000 ? (() => { throw new AgentSuiteError(`${where}.instructions is too long`); })() : v.instructions) : undefined,
    instructionsAppend: optStr(v.instructionsAppend, `${where}.instructionsAppend`, 20_000),
    allowedTools: v.allowedTools as string[] | undefined,
    maxTurns: v.maxTurns as number | undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

/** A variant's id from its agent, version and label ("shop@draft", "shop@production+model"). */
export function variantSlug(v: { agent: string; version?: string; label?: string; overrides?: SuiteVariantOverrides }): string {
  if (v.label) return suiteSlug(v.label, "variant");
  const over = v.overrides ? Object.keys(v.overrides).sort().join("+") : "";
  return `${v.agent}@${v.version ?? "production"}${over ? `+${over}` : ""}`.toLowerCase().replace(/[^a-z0-9@+._-]/g, "-").slice(0, 64);
}

export function parseBenchmarkVariant(v: unknown, where: string, taken: Set<string>): BenchmarkVariantSpec {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object: { agent, version?, label?, overrides? }`);
  const agent = str(v.agent, `${where}.agent`, 100);
  const version = optStr(v.version, `${where}.version`, 40) ?? "production";
  const label = optStr(v.label, `${where}.label`, 80);
  const overrides = parseVariantOverrides(v.overrides, `${where}.overrides`);
  let id = optStr(v.id, `${where}.id`, 64) ?? variantSlug({ agent, version, ...(label ? { label } : {}), ...(overrides ? { overrides } : {}) });
  if (taken.has(id)) {
    if (typeof v.id === "string") throw new AgentSuiteError(`${where}: the variant id "${id}" is used twice`);
    let n = 2;
    while (taken.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  taken.add(id);
  return compact({ id, ...(label ? { label } : {}), agent, version, ...(overrides ? { overrides } : {}) });
}

export function parseBenchmarkWeights(v: unknown): BenchmarkWeights | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError("weights must be an object: { quality, cost, latency }");
  const n = (x: unknown, k: string) => {
    if (x === undefined) return 0;
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new AgentSuiteError(`weights.${k} must be a number ≥ 0`);
    return x;
  };
  const w = { quality: n(v.quality, "quality"), cost: n(v.cost, "cost"), latency: n(v.latency, "latency") };
  if (w.quality + w.cost + w.latency <= 0) throw new AgentSuiteError("weights: at least one of quality, cost, latency must be above 0");
  return w;
}

/** A benchmark spec (what a run needs), validated. */
export function parseBenchmarkSpec(input: unknown): BenchmarkSpec {
  if (!isObj(input)) throw new AgentSuiteError("The benchmark must be an object: { name, suites: [{ agent, suite }], variants: [{ agent, version?, overrides? }], repetitions? }");
  const name = str(input.name ?? "Benchmark", "name", 120);
  const description = optStr(input.description, "description", 2000);
  if (!Array.isArray(input.suites) || !input.suites.length) throw new AgentSuiteError("suites: at least one { agent, suite } (or { agent, suite, dataset })");
  if (input.suites.length > BENCHMARK_LIMITS.suites) throw new AgentSuiteError(`suites: at most ${BENCHMARK_LIMITS.suites}`);
  const suites = input.suites.map((s, i): BenchmarkSuiteRef => {
    if (!isObj(s)) throw new AgentSuiteError(`suites[${i}] must be { agent, suite, caseIds?, dataset? }`);
    const caseIds = s.caseIds === undefined ? undefined : Array.isArray(s.caseIds) && s.caseIds.every((c) => typeof c === "string") ? s.caseIds as string[] : (() => { throw new AgentSuiteError(`suites[${i}].caseIds must be a list of case ids`); })();
    return compact({ agent: str(s.agent, `suites[${i}].agent`, 100), suite: str(s.suite, `suites[${i}].suite`, 100), ...(caseIds?.length ? { caseIds } : {}), dataset: optStr(s.dataset, `suites[${i}].dataset`, 100) });
  });
  const seen = new Set<string>();
  for (const s of suites) {
    const k = `${s.agent}/${s.suite}/${s.dataset ?? ""}/${(s.caseIds ?? []).join(",")}`;
    if (seen.has(k)) throw new AgentSuiteError(`suites: ${s.agent}/${s.suite} is listed twice`);
    seen.add(k);
  }
  if (!Array.isArray(input.variants) || !input.variants.length) throw new AgentSuiteError("variants: at least one { agent, version?, overrides? }");
  if (input.variants.length > BENCHMARK_LIMITS.variants) throw new AgentSuiteError(`variants: at most ${BENCHMARK_LIMITS.variants}`);
  const taken = new Set<string>();
  const variants = input.variants.map((v, i) => parseBenchmarkVariant(v, `variants[${i}]`, taken));
  const repetitions = input.repetitions === undefined ? 1 : Number(input.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > BENCHMARK_LIMITS.repetitions) throw new AgentSuiteError(`repetitions must be a whole number from 1 to ${BENCHMARK_LIMITS.repetitions}`);
  const mode = input.mode === undefined || input.mode === null ? undefined : SUITE_MOCK_MODES.includes(input.mode as SuiteMockMode) ? input.mode as SuiteMockMode : (() => { throw new AgentSuiteError(`mode must be one of ${SUITE_MOCK_MODES.join(", ")}`); })();
  const concurrency = input.concurrency === undefined ? undefined : Number(input.concurrency);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)) throw new AgentSuiteError("concurrency must be a whole number from 1 to 4");
  const budgetUsd = input.budgetUsd === undefined || input.budgetUsd === null ? undefined : Number(input.budgetUsd);
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) throw new AgentSuiteError("budgetUsd must be a number ≥ 0");
  const weights = parseBenchmarkWeights(input.weights);
  return compact({
    ...(typeof input.id === "string" && input.id ? { id: input.id } : {}),
    name, description, suites, variants, repetitions, mode, concurrency, budgetUsd, weights,
  });
}

/** A saved benchmark definition (id from the name; `revision` bumped on every save). */
export function parseBenchmark(input: unknown, existing?: BenchmarkDefinition, now = new Date().toISOString()): BenchmarkDefinition {
  const spec = parseBenchmarkSpec(input);
  const id = existing?.id ?? spec.id ?? suiteSlug(spec.name, "benchmark");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new AgentSuiteError(`The benchmark id "${id}" must be lowercase letters, digits, - or _`);
  const { id: _i, ...rest } = spec;
  return { ...rest, id, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
}

// ── Estimates ────────────────────────────────────────────────────────

/** Price of a model per million tokens (USD). */
export interface ModelPrice { input: number; output: number }

/** One (suite, variant) of the estimate. */
export interface BenchmarkEstimateCell {
  suite: string;
  owner: string;
  variantId: string;
  /** Cases per repetition (dataset rows and the suite's own repetitions counted). */
  cases: number;
  /** Of which run the real model (they cost tokens). */
  realModelCases: number;
  /** LLM judge calls per repetition (they cost tokens of the judge's model, even offline). */
  judgeCalls: number;
  /** Estimated cost of all its repetitions. */
  costUsd: number;
  /** offline: nothing costs; history: from past runs of the suite on that model; heuristic: from the prompt size and the model's price; unknown: no price. */
  basis: "offline" | "history" | "heuristic" | "unknown";
  model?: string;
  realTools: boolean;
}

export interface BenchmarkEstimate {
  runs: number;
  cases: number;
  realModelCases: number;
  /** The expected cost (USD). */
  costUsd: number;
  /** A cautious upper bound (USD): what the budget cap is compared with. */
  maxCostUsd: number;
  /** Nothing calls a real model: free, no confirmation needed. */
  offline: boolean;
  /** Some case of some variant has no known price: the estimate is a lower bound. */
  unknownPrice: boolean;
  /** Some run would use real tools (admins, after a confirmation). */
  realTools: boolean;
  cells: BenchmarkEstimateCell[];
  notes: string[];
}

/** The heuristic cost of one case on a real model: the prompt (instructions, message, tool schemas) for a few turns. */
export function heuristicCaseCostUsd(opts: { promptChars: number; turns?: number; price: ModelPrice; judges?: number; judgePrice?: ModelPrice }): number {
  const turns = Math.max(1, opts.turns ?? 3);
  // the system prompt, the tools' schemas and the conversation grow every turn
  const inputPerTurn = 1500 + Math.ceil(opts.promptChars / 4);
  const input = turns * inputPerTurn + (turns * (turns - 1) / 2) * 300;
  const output = turns * 300;
  let cost = (input * opts.price.input + output * opts.price.output) / 1e6;
  if (opts.judges && opts.judgePrice) cost += opts.judges * (2000 * opts.judgePrice.input + 400 * opts.judgePrice.output) / 1e6;
  return cost;
}

/** Sum up the cells of an estimate (the upper bound: +50% on heuristics, +20% on history). */
export function summarizeBenchmarkEstimate(cells: BenchmarkEstimateCell[], repetitions: number, notes: string[] = []): BenchmarkEstimate {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const cost = cells.reduce((a, c) => a + c.costUsd, 0);
  const max = cells.reduce((a, c) => a + c.costUsd * (c.basis === "heuristic" ? 1.5 : c.basis === "history" ? 1.2 : 1), 0);
  const realModelCases = cells.reduce((a, c) => a + c.realModelCases, 0) * repetitions;
  const unknownPrice = cells.some((c) => c.basis === "unknown");
  const out: BenchmarkEstimate = {
    runs: cells.length * repetitions,
    cases: cells.reduce((a, c) => a + c.cases, 0) * repetitions,
    realModelCases,
    costUsd: round(cost),
    maxCostUsd: round(max),
    offline: realModelCases === 0 && cells.every((c) => c.judgeCalls === 0),
    unknownPrice,
    realTools: cells.some((c) => c.realTools),
    cells,
    notes: [...notes],
  };
  if (out.offline) out.notes.push("Every case runs offline (scripted model, mocked tools): the benchmark is free.");
  else if (realModelCases === 0) out.notes.push("The agents' models are scripted, but LLM judges score the cases: they cost tokens of the judge's model.");
  if (unknownPrice) out.notes.push("Some variant's model has no known price: the estimate leaves it out (it is a lower bound).");
  return out;
}

// ── Runs ─────────────────────────────────────────────────────────────

export type BenchmarkRunStatus = "queued" | "running" | "completed" | "cancelled" | "errored";

/** One suite run of a benchmark (a suite × a variant × a repetition). */
export interface BenchmarkRunEntry {
  runId: string;
  /** Where the run is kept: the suite's owner (its agent). */
  owner: string;
  suiteId: string;
  suiteName: string;
  variantId: string;
  repetition: number;
  status: SuiteRunStatus;
  costUsd: number;
  passed: number;
  total: number;
  done: number;
  planned: number;
  score?: number;
  error?: string;
}

export interface BenchmarkRun {
  id: string;
  /** The saved benchmark it ran (none: an ad hoc benchmark). */
  benchmarkId?: string;
  name: string;
  spec: BenchmarkSpec;
  status: BenchmarkRunStatus;
  /** Why it stopped before the end: the budget cap, a person cancelled it, an error. */
  stopReason?: "budget" | "cancelled" | "error";
  startedAt: string;
  finishedAt?: string;
  actor?: string;
  estimate: BenchmarkEstimate;
  budgetUsd?: number;
  spentUsd: number;
  runs: BenchmarkRunEntry[];
  progress: { runsDone: number; runsTotal: number; casesDone: number; casesTotal: number };
  /** Started from: the dashboard's Suites tab, the Benchmarks page, the Playground, the CLI, MCP, Polpo's chat, the API. */
  source?: string;
  /** The leaderboard with the benchmark's weights, when it finished. */
  leaderboard?: BenchmarkLeaderboard;
  notes: string[];
  error?: string;
}

export function benchmarkRunIsLive(r: Pick<BenchmarkRun, "status">): boolean { return r.status === "queued" || r.status === "running"; }

/** Progress of a benchmark from its runs. */
export function benchmarkProgress(entries: BenchmarkRunEntry[]): BenchmarkRun["progress"] {
  const finished = (s: SuiteRunStatus) => s !== "queued" && s !== "running";
  return {
    runsDone: entries.filter((e) => finished(e.status)).length,
    runsTotal: entries.length,
    casesDone: entries.reduce((a, e) => a + (finished(e.status) ? e.planned : e.done), 0),
    casesTotal: entries.reduce((a, e) => a + e.planned, 0),
  };
}

// ── Aggregates ───────────────────────────────────────────────────────

/** The parts of a suite run the comparison reads. */
export type BenchmarkSuiteRun = Pick<SuiteRun, "id" | "agent" | "suiteId" | "suiteName" | "status" | "repetition"> & {
  variant: { id: string; label?: string; agent?: string; version?: string };
  results: Array<Pick<SuiteCaseResult, "key" | "caseId" | "caseName" | "status" | "score" | "costUsd" | "durationMs" | "row"> & {
    scores?: Array<{ id: string; description?: string; score: number }>;
    trace?: Pick<SuiteTrace, "usage">;
  }>;
};

export interface MeanSd { mean: number; stddev: number }

export interface BenchmarkVariantStats {
  variantId: string;
  label: string;
  agent: string;
  version: string;
  overrides?: SuiteVariantOverrides;
  runs: number;
  /** Repetitions that produced results. */
  repetitions: number;
  /** Distinct cases (dataset rows counted). */
  cases: number;
  /** Over the repetitions. */
  passRate: MeanSd;
  score?: MeanSd;
  scorers: Array<{ id: string; label: string; mean: number; stddev: number }>;
  /** Per repetition (all the suites' cases once), and per case. */
  costUsd: MeanSd & { total: number; perCase: number };
  latency: { p50Ms: number; p95Ms: number; meanMs: number };
  tokens: { input: number; output: number; perCase: number };
  /** Share of cases whose outcome changed between repetitions (or attempts), 0..1. */
  flakiness: number;
  flakyCases: string[];
  errored: number;
  /** Every planned run finished (not cancelled, no run-level error). */
  complete: boolean;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const meanSd = (xs: number[]): MeanSd => ({ mean: r4(mean(xs)), stddev: r4(stddev(xs)) });

/** The key of a case across runs: its suite, its id and dataset row (attempts ~n folded). */
export function benchmarkCaseKey(r: { agent: string; suiteId: string }, key: string): string {
  return `${r.agent}/${r.suiteId}/${baseCaseKey(key)}`;
}

export function variantLabel(v: Pick<BenchmarkVariantSpec, "id" | "label">): string { return v.label ?? v.id; }

/** Per variant: pass rate, score and scorers (mean ± stddev over repetitions), cost, latency, tokens, flakiness. */
export function benchmarkVariantStats(runs: BenchmarkSuiteRun[], variants: BenchmarkVariantSpec[], opts: { flakyStddev?: number } = {}): BenchmarkVariantStats[] {
  const flakyStddev = opts.flakyStddev ?? 0.1;
  return variants.map((v) => {
    const mine = runs.filter((r) => r.variant.id === v.id);
    const results = mine.flatMap((r) => r.results.filter((x) => x.status !== "skipped").map((x) => ({ run: r, x })));
    const reps = [...new Set(mine.map((r) => r.repetition ?? 1))].sort((a, b) => a - b);
    const byRep = reps.map((rep) => results.filter((e) => (e.run.repetition ?? 1) === rep).map((e) => e.x)).filter((xs) => xs.length);
    const passRates = byRep.map((xs) => xs.filter((x) => x.status === "passed").length / xs.length);
    const scored = byRep.map((xs) => xs.map((x) => x.score).filter((s): s is number => s !== undefined)).filter((xs) => xs.length);
    const scorerIds = new Map<string, string>();
    for (const { x } of results) for (const s of x.scores ?? []) if (!scorerIds.has(s.id)) scorerIds.set(s.id, s.description ?? s.id);
    const scorers = [...scorerIds.entries()].map(([id, label]) => {
      const perRep = byRep.map((xs) => xs.flatMap((x) => (x.scores ?? []).filter((s) => s.id === id).map((s) => s.score))).filter((xs) => xs.length).map(mean);
      return { id, label, mean: r4(mean(perRep)), stddev: r4(stddev(perRep)) };
    });
    const costs = byRep.map((xs) => xs.reduce((a, x) => a + x.costUsd, 0));
    const durations = results.map((e) => e.x.durationMs);
    const tokensIn = results.reduce((a, e) => a + (e.x.trace?.usage.inputTokens ?? 0), 0);
    const tokensOut = results.reduce((a, e) => a + (e.x.trace?.usage.outputTokens ?? 0), 0);
    // flakiness: the same case (suite, id, row) with different outcomes, or scores that spread
    const byCase = new Map<string, Array<(typeof results)[number]["x"]>>();
    for (const { run, x } of results) { const k = benchmarkCaseKey(run, x.key); byCase.set(k, [...(byCase.get(k) ?? []), x]); }
    const flakyCases = [...byCase.entries()].filter(([, xs]) => {
      if (xs.length < 2) return false;
      const passed = xs.filter((x) => x.status === "passed").length;
      if (passed > 0 && passed < xs.length) return true;
      const sc = xs.map((x) => x.score).filter((s): s is number => s !== undefined);
      return sc.length > 1 && stddev(sc) > flakyStddev;
    }).map(([k]) => k);
    const cases = byCase.size;
    return compact({
      variantId: v.id, label: variantLabel(v), agent: v.agent, version: v.version, ...(v.overrides ? { overrides: v.overrides } : {}),
      runs: mine.length, repetitions: byRep.length, cases,
      passRate: meanSd(passRates),
      score: scored.length ? meanSd(scored.map(mean)) : undefined,
      scorers,
      costUsd: { ...meanSd(costs), mean: r6(mean(costs)), stddev: r6(stddev(costs)), total: r6(costs.reduce((a, b) => a + b, 0)), perCase: r6(results.length ? results.reduce((a, e) => a + e.x.costUsd, 0) / results.length : 0) },
      latency: { p50Ms: Math.round(quantile(durations, 0.5)), p95Ms: Math.round(quantile(durations, 0.95)), meanMs: Math.round(mean(durations)) },
      tokens: { input: tokensIn, output: tokensOut, perCase: results.length ? Math.round((tokensIn + tokensOut) / results.length) : 0 },
      flakiness: cases ? r4(flakyCases.length / cases) : 0,
      flakyCases,
      errored: results.filter((e) => e.x.status === "errored").length,
      complete: mine.length > 0 && mine.every((r) => r.status === "passed" || r.status === "failed" || (r.status === "errored" && r.results.length > 0)),
    }) as BenchmarkVariantStats;
  });
}

// ── Matrix ───────────────────────────────────────────────────────────

export type BenchmarkCellStatus = "passed" | "failed" | "mixed" | "errored" | "skipped" | "missing";

export interface BenchmarkMatrixCell {
  variantId: string;
  attempts: number;
  passed: number;
  passRate: number;
  score?: number;
  costUsd: number;
  durationMs: number;
  status: BenchmarkCellStatus;
  /** Every result of this case for this variant (drill-down to its trace). */
  results: Array<{ runId: string; owner: string; key: string; repetition: number; status: string }>;
}

export interface BenchmarkMatrixRow {
  /** owner/suite/case key. */
  key: string;
  owner: string;
  suiteId: string;
  suiteName: string;
  caseId: string;
  caseName: string;
  /** The case's own key in its runs (id, or id#row). */
  caseKey: string;
  row?: number;
  cells: Record<string, BenchmarkMatrixCell>;
  /** The variants disagree on this case (some pass, some fail, or their scores differ by more than 0.1). */
  spread: boolean;
}

export interface BenchmarkMatrix {
  variants: Array<{ id: string; label: string }>;
  rows: BenchmarkMatrixRow[];
}

/** Case × variant: each cell's attempts, pass rate, mean score, cost and latency, and its results. */
export function benchmarkMatrix(runs: BenchmarkSuiteRun[], variants: BenchmarkVariantSpec[]): BenchmarkMatrix {
  const rows = new Map<string, BenchmarkMatrixRow>();
  const acc = new Map<string, Map<string, Array<{ run: BenchmarkSuiteRun; x: BenchmarkSuiteRun["results"][number] }>>>();
  for (const run of runs) {
    for (const x of run.results) {
      const key = benchmarkCaseKey(run, x.key);
      if (!rows.has(key)) {
        rows.set(key, compact({
          key, owner: run.agent, suiteId: run.suiteId, suiteName: run.suiteName, caseId: x.caseId, caseName: x.caseName, caseKey: baseCaseKey(x.key),
          row: x.row ? x.row.index + 1 : undefined, cells: {}, spread: false,
        }) as BenchmarkMatrixRow);
        acc.set(key, new Map());
      }
      const byVariant = acc.get(key)!;
      byVariant.set(run.variant.id, [...(byVariant.get(run.variant.id) ?? []), { run, x }]);
    }
  }
  for (const [key, row] of rows) {
    const byVariant = acc.get(key)!;
    for (const v of variants) {
      const entries = byVariant.get(v.id) ?? [];
      const counted = entries.filter((e) => e.x.status !== "skipped");
      const passed = counted.filter((e) => e.x.status === "passed").length;
      const scores = counted.map((e) => e.x.score).filter((s): s is number => s !== undefined);
      const status: BenchmarkCellStatus = !entries.length ? "missing" : !counted.length ? "skipped"
        : passed === counted.length ? "passed" : counted.every((e) => e.x.status === "errored") ? "errored" : passed === 0 ? "failed" : "mixed";
      row.cells[v.id] = compact({
        variantId: v.id, attempts: counted.length, passed, passRate: counted.length ? r4(passed / counted.length) : 0,
        score: scores.length ? r4(mean(scores)) : undefined,
        costUsd: r6(counted.length ? mean(counted.map((e) => e.x.costUsd)) : 0),
        durationMs: Math.round(counted.length ? mean(counted.map((e) => e.x.durationMs)) : 0),
        status,
        results: entries.map((e) => ({ runId: e.run.id, owner: e.run.agent, key: e.x.key, repetition: e.run.repetition ?? 1, status: e.x.status })),
      }) as BenchmarkMatrixCell;
    }
    const cells = Object.values(row.cells).filter((c) => c.attempts > 0);
    const rates = cells.map((c) => c.passRate);
    const sc = cells.map((c) => c.score).filter((s): s is number => s !== undefined);
    row.spread = (rates.length > 1 && Math.max(...rates) - Math.min(...rates) > 0) || (sc.length > 1 && Math.max(...sc) - Math.min(...sc) > 0.1);
  }
  return { variants: variants.map((v) => ({ id: v.id, label: variantLabel(v) })), rows: [...rows.values()] };
}

// ── Leaderboard ──────────────────────────────────────────────────────

export interface BenchmarkLeaderboardEntry {
  rank: number;
  variantId: string;
  label: string;
  /** Score (or pass rate when some variant has no scores), 0..1. */
  quality: number;
  qualityStddev: number;
  /** The standard error of `quality` (noise). */
  qualityError: number;
  passRate: number;
  score?: number;
  /** Cost of one repetition (every suite's cases once). */
  costUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** The weighted composite 0..1 the ranking uses. */
  composite: number;
  /** On the Pareto front (no other variant is at least as good on quality, cost and latency, and better on one). */
  pareto: boolean;
  dominatedBy: string[];
  flakiness: number;
}

export interface BenchmarkLeaderboard {
  weights: BenchmarkWeights;
  qualityMetric: "score" | "passRate";
  entries: BenchmarkLeaderboardEntry[];
  paretoFront: string[];
  /** Statistical notes: differences within the noise, a single repetition… */
  notes: string[];
}

/**
 * Rank the variants by a weighted composite of quality (higher is better), cost and latency (lower
 * is better), each normalized across the variants (min-max); mark the Pareto front; say when two
 * variants' quality differs by less than about two standard errors.
 */
export function benchmarkLeaderboard(stats: BenchmarkVariantStats[], weights: BenchmarkWeights = DEFAULT_BENCHMARK_WEIGHTS): BenchmarkLeaderboard {
  const live = stats.filter((s) => s.runs > 0 && s.cases > 0);
  const useScore = live.length > 0 && live.every((s) => s.score !== undefined);
  const q = (s: BenchmarkVariantStats) => (useScore ? s.score!.mean : s.passRate.mean);
  const qsd = (s: BenchmarkVariantStats) => (useScore ? s.score!.stddev : s.passRate.stddev);
  const err = (s: BenchmarkVariantStats) => {
    if (s.repetitions >= 2) return qsd(s) / Math.sqrt(s.repetitions);
    // one repetition: a binomial-ish error over the cases
    const p = Math.min(1, Math.max(0, q(s)));
    return Math.sqrt(Math.max(p * (1 - p), 0.0025) / Math.max(1, s.cases));
  };
  const norm = (xs: number[], x: number, lowerIsBetter: boolean) => {
    const min = Math.min(...xs), max = Math.max(...xs);
    if (!(max > min)) return 1;
    const t = (x - min) / (max - min);
    return lowerIsBetter ? 1 - t : t;
  };
  const costs = live.map((s) => s.costUsd.mean), lats = live.map((s) => s.latency.p50Ms);
  const total = weights.quality + weights.cost + weights.latency || 1;
  const entries: BenchmarkLeaderboardEntry[] = live.map((s) => {
    const composite = (weights.quality * q(s) + weights.cost * norm(costs, s.costUsd.mean, true) + weights.latency * norm(lats, s.latency.p50Ms, true)) / total;
    return {
      rank: 0, variantId: s.variantId, label: s.label,
      quality: r4(q(s)), qualityStddev: r4(qsd(s)), qualityError: r4(err(s)),
      passRate: s.passRate.mean, ...(s.score ? { score: s.score.mean } : {}),
      costUsd: s.costUsd.mean, latencyP50Ms: s.latency.p50Ms, latencyP95Ms: s.latency.p95Ms,
      composite: r4(composite), pareto: false, dominatedBy: [], flakiness: s.flakiness,
    };
  });
  // Pareto: a dominates b when it is at least as good on all three and better on one
  for (const b of entries) {
    for (const a of entries) {
      if (a === b) continue;
      const geq = a.quality >= b.quality && a.costUsd <= b.costUsd && a.latencyP50Ms <= b.latencyP50Ms;
      const gt = a.quality > b.quality || a.costUsd < b.costUsd || a.latencyP50Ms < b.latencyP50Ms;
      if (geq && gt) b.dominatedBy.push(a.variantId);
    }
    b.pareto = b.dominatedBy.length === 0;
  }
  entries.sort((a, b) => b.composite - a.composite || b.quality - a.quality || a.costUsd - b.costUsd);
  entries.forEach((e, i) => { e.rank = i + 1; });
  const notes: string[] = [];
  const metric = useScore ? "score" : "pass rate";
  if (live.length && live.every((s) => s.repetitions < 2)) {
    notes.push(`One repetition per variant: the spread between repetitions is unknown, so the noise below is estimated from the number of cases. Run 3 or more repetitions to compare with confidence.`);
  }
  const byQuality = [...entries].sort((a, b) => b.quality - a.quality);
  for (let i = 0; i + 1 < byQuality.length; i++) {
    const a = byQuality[i], b = byQuality[i + 1];
    const diff = a.quality - b.quality;
    const noise = 2 * Math.sqrt(a.qualityError ** 2 + b.qualityError ** 2);
    if (diff <= noise) {
      notes.push(`"${a.label}" and "${b.label}": their ${metric} differs by ${diff.toFixed(2)}, within the noise (±${noise.toFixed(2)}, about 95%): this benchmark cannot tell them apart on quality. More repetitions or cases would.`);
    }
  }
  if (live.length < stats.length) notes.push(`${stats.length - live.length} variant(s) have no results yet.`);
  if (weights.cost === 0 && weights.latency === 0) notes.push("Ranked by quality only (cost and latency weigh 0).");
  return { weights, qualityMetric: useScore ? "score" : "passRate", entries, paretoFront: entries.filter((e) => e.pareto).map((e) => e.variantId), notes };
}

// ── Side by side: one case across variants ───────────────────────────

export interface DiffSegment { op: "same" | "add" | "del"; text: string }

function tokens(s: string): string[] { return s.match(/\s+|[^\s]+/g) ?? []; }

/** A word-level diff of `b` against `a` (LCS); long texts are compared by lines. */
export function wordDiff(a: string, b: string): DiffSegment[] {
  if (a === b) return a ? [{ op: "same", text: a }] : [];
  let ta = tokens(a), tb = tokens(b);
  if (ta.length * tb.length > 4_000_000) { ta = a.split(/(?<=\n)/); tb = b.split(/(?<=\n)/); }
  if (ta.length * tb.length > 4_000_000) return [{ op: "del", text: a }, { op: "add", text: b }];
  const n = ta.length, m = tb.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffSegment[] = [];
  const push = (op: DiffSegment["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push("same", ta[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", ta[i]); i++; } else { push("add", tb[j]); j++; }
  }
  while (i < n) push("del", ta[i++]);
  while (j < m) push("add", tb[j++]);
  return out;
}

/** The paths where two argument objects differ (`recipient.country_code`, `items[0]`). */
export function argChanges(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isO = (x: unknown) => !!x && typeof x === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...argChanges(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (isO(a) && isO(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const out: string[] = [];
    for (const k of new Set([...Object.keys(a as Raw), ...Object.keys(b as Raw)])) out.push(...argChanges((a as Raw)[k], (b as Raw)[k], path ? `${path}.${k}` : k));
    return out;
  }
  return [path || "(value)"];
}

export interface BenchmarkCompareToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  mocked: string | false;
  /** Versus the reference column: same call, same tool with other arguments, or a call the reference did not make. */
  diff: "same" | "changed" | "added";
  argChanges?: string[];
}

export interface BenchmarkCompareColumn {
  variantId: string;
  label: string;
  runId: string;
  owner: string;
  repetition: number;
  key: string;
  status: string;
  score?: number;
  costUsd: number;
  durationMs: number;
  tokens: { input: number; output: number };
  finalText: string;
  toolCalls: BenchmarkCompareToolCall[];
  /** Tools the reference called that this column did not. */
  missingCalls: string[];
  /** The final answer versus the reference's (the reference itself: undefined). */
  textDiff?: DiffSegment[];
  sameAsReference: { tools: boolean; text: boolean };
  /** The full result (assertions, scores, trace) for the report's chat view. */
  result: SuiteCaseResult;
}

export interface BenchmarkCaseComparison {
  key: string;
  caseName: string;
  /** The first column: the others are diffed against it. */
  reference: string;
  columns: BenchmarkCompareColumn[];
}

/** One case side by side: tool calls aligned (longest common subsequence of names) and diffed, final answers diffed. */
export function compareBenchmarkCase(input: Array<{ variantId: string; label: string; runId: string; owner: string; repetition?: number; result: SuiteCaseResult }>, key?: string): BenchmarkCaseComparison {
  if (!input.length) throw new AgentSuiteError("Nothing to compare: no result for this case", "NOT_FOUND");
  const ref = input[0];
  const finalOf = (r: SuiteCaseResult) => r.trace.finalText ?? r.trace.text ?? "";
  const refCalls = ref.result.trace.toolCalls;
  const columns = input.slice(0, BENCHMARK_LIMITS.compareColumns).map((c, idx): BenchmarkCompareColumn => {
    const calls = c.result.trace.toolCalls;
    // align by tool name (LCS)
    const n = refCalls.length, m = calls.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = refCalls[i].name === calls[j].name ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const pair = new Map<number, number>();
    for (let i = 0, j = 0; i < n && j < m;) {
      if (refCalls[i].name === calls[j].name) { pair.set(j, i); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    const matchedRef = new Set(pair.values());
    const toolCalls = calls.map((call, j): BenchmarkCompareToolCall => {
      const i = pair.get(j);
      const base = { name: call.name, args: call.args, result: call.result, isError: call.isError, mocked: call.mocked };
      if (idx === 0) return { ...base, diff: "same" };
      if (i === undefined) return { ...base, diff: "added" };
      const changes = argChanges(refCalls[i].args, call.args);
      return changes.length ? { ...base, diff: "changed", argChanges: changes } : { ...base, diff: "same" };
    });
    const missingCalls = idx === 0 ? [] : refCalls.filter((_, i) => !matchedRef.has(i)).map((x) => x.name);
    const text = finalOf(c.result);
    const textDiff = idx === 0 ? undefined : wordDiff(finalOf(ref.result), text);
    return {
      variantId: c.variantId, label: c.label, runId: c.runId, owner: c.owner, repetition: c.repetition ?? 1, key: c.result.key,
      status: c.result.status, ...(c.result.score !== undefined ? { score: c.result.score } : {}),
      costUsd: c.result.costUsd, durationMs: c.result.durationMs,
      tokens: { input: c.result.trace.usage.inputTokens, output: c.result.trace.usage.outputTokens },
      finalText: text, toolCalls, missingCalls, ...(textDiff ? { textDiff } : {}),
      sameAsReference: { tools: idx === 0 || (missingCalls.length === 0 && toolCalls.every((t) => t.diff === "same")), text: idx === 0 || text === finalOf(ref.result) },
      result: c.result,
    };
  });
  return { key: key ?? baseCaseKey(ref.result.key), caseName: ref.result.caseName, reference: ref.variantId, columns };
}

// ── Playground ───────────────────────────────────────────────────────

/** A pane's mocks: a suite's (its shared mocks, and a case's), plus quick inline ones. */
export interface PlaygroundMocks {
  suite?: { agent: string; suite: string; caseId?: string };
  tools?: ToolMock[];
  model?: ModelMock;
}

/** One chat pane of the Playground, bound to a variant. */
export interface PlaygroundPane {
  id: string;
  label?: string;
  variant: { agent: string; version: string; overrides?: SuiteVariantOverrides };
  /** Answer tool calls with the mocks (default true). */
  mockTools: boolean;
  /** Play the model from the mocks' scripted turns (offline). */
  mockModel: boolean;
  /** Tool calls no mock answers run for real (admins, after a confirmation). Off: they are blocked. */
  realTools: boolean;
  mocks?: PlaygroundMocks;
}

/** One exchange of a pane: the message, the trace (turns, tool calls, reply), cost, latency, tokens. */
export interface PlaygroundExchange {
  index: number;
  message: string;
  at: string;
  trace: SuiteTrace;
  mode: SuiteMockMode;
  status: "done" | "error" | "stopped";
  error?: string;
  costUsd: number;
  durationMs: number;
  tokens: { input: number; output: number };
}

export interface PlaygroundSession {
  id: string;
  panes: PlaygroundPane[];
  /** Each pane's exchanges, oldest first. */
  exchanges: Record<string, PlaygroundExchange[]>;
  createdAt: string;
  updatedAt: string;
  actor?: string;
}

/** The suite mode a pane's toggles mean (tool calls are always intercepted: mocked, blocked or run for real). */
export function playgroundPaneMode(p: Pick<PlaygroundPane, "mockModel">): SuiteMockMode {
  return p.mockModel ? "all" : "tools";
}

/** Does a pane touch real tools (admins, after a confirmation)? */
export function playgroundPaneUsesRealTools(p: Pick<PlaygroundPane, "realTools">): boolean { return p.realTools === true; }

export function parsePlaygroundPane(v: unknown, i: number, taken: Set<string>): PlaygroundPane {
  const where = `panes[${i}]`;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be { variant: { agent, version?, overrides? }, mockTools?, mockModel?, realTools?, mocks? }`);
  const vv = isObj(v.variant) ? v.variant : v;
  const agent = str(vv.agent, `${where}.variant.agent`, 100);
  const version = optStr(vv.version, `${where}.variant.version`, 40) ?? "production";
  const overrides = parseVariantOverrides(vv.overrides, `${where}.variant.overrides`);
  let id = optStr(v.id, `${where}.id`, 40) ?? `pane-${i + 1}`;
  while (taken.has(id)) id = `${id}-${i + 1}`;
  taken.add(id);
  let mocks: PlaygroundMocks | undefined;
  if (v.mocks !== undefined && v.mocks !== null) {
    if (!isObj(v.mocks)) throw new AgentSuiteError(`${where}.mocks must be { suite?, tools?, model? }`);
    const m = v.mocks;
    const suite = m.suite === undefined ? undefined : isObj(m.suite) ? compact({ agent: str(m.suite.agent ?? agent, `${where}.mocks.suite.agent`, 100), suite: str(m.suite.suite, `${where}.mocks.suite.suite`, 100), caseId: optStr(m.suite.caseId, `${where}.mocks.suite.caseId`, 100) }) : (() => { throw new AgentSuiteError(`${where}.mocks.suite must be { agent?, suite, caseId? }`); })();
    if (m.tools !== undefined && !Array.isArray(m.tools)) throw new AgentSuiteError(`${where}.mocks.tools must be a list of tool mocks`);
    const tools = (m.tools as unknown[] | undefined)?.map((t, k) => {
      if (!isObj(t) || typeof t.tool !== "string" || !t.tool) throw new AgentSuiteError(`${where}.mocks.tools[${k}] needs a tool (a name or a glob)`);
      return t as unknown as ToolMock;
    });
    if (m.model !== undefined && (!isObj(m.model) || !Array.isArray(m.model.turns))) throw new AgentSuiteError(`${where}.mocks.model must be { turns: [...] }`);
    mocks = compact({ suite, tools: tools?.length ? tools : undefined, model: m.model as ModelMock | undefined });
    if (!Object.keys(mocks).length) mocks = undefined;
  }
  return compact({
    id, label: optStr(v.label, `${where}.label`, 80),
    variant: compact({ agent, version, overrides }),
    mockTools: v.mockTools !== false,
    mockModel: v.mockModel === true,
    realTools: v.realTools === true,
    mocks,
  }) as PlaygroundPane;
}

export function parsePlaygroundPanes(v: unknown): PlaygroundPane[] {
  if (!Array.isArray(v) || !v.length) throw new AgentSuiteError("panes: one to four { variant: { agent, version?, overrides? }, mockTools?, mockModel?, realTools?, mocks? }");
  if (v.length > BENCHMARK_LIMITS.panes) throw new AgentSuiteError(`panes: at most ${BENCHMARK_LIMITS.panes}`);
  const taken = new Set<string>();
  return v.map((p, i) => parsePlaygroundPane(p, i, taken));
}

/**
 * "Save as test case": a Playground exchange as a suite case (caseFromTrace: the observed tool calls
 * become mocks and checks; `mockModel` also scripts the model turns, an offline contract case).
 */
export function playgroundCase(ex: PlaygroundExchange, opts: { name?: string; mockModel?: boolean; id?: string } = {}): SuiteCase {
  const name = opts.name?.trim() || (ex.message.length > 60 ? `${ex.message.slice(0, 57)}…` : ex.message) || `Playground exchange ${ex.index + 1}`;
  const c = caseFromTrace(ex.trace, { name, mockModel: opts.mockModel === true, ...(opts.id ? { id: opts.id } : {}) });
  return { ...c, source: { kind: "recorded", at: new Date().toISOString() } };
}

/**
 * "Promote variant": the agent fields a variant's overrides change (written into the draft; never
 * deployed). `base` is the agent at the variant's version.
 */
export function promotionFields(base: { model?: unknown; reasoning?: unknown; engine?: unknown; systemPrompt?: string; allowedTools?: string[]; maxTurns?: number }, overrides: SuiteVariantOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (overrides.model) out.model = overrides.model;
  if (overrides.reasoning) out.reasoning = overrides.reasoning;
  if (overrides.engine !== undefined) out.engine = overrides.engine;
  if (overrides.allowedTools) out.allowedTools = overrides.allowedTools;
  if (overrides.maxTurns) out.maxTurns = overrides.maxTurns;
  let prompt = overrides.instructions !== undefined ? overrides.instructions : base.systemPrompt;
  if (overrides.instructionsAppend) prompt = `${prompt ?? ""}\n\n${overrides.instructionsAppend}`.trim();
  if (prompt !== base.systemPrompt) out.systemPrompt = prompt;
  return out;
}

/** A benchmark run's summary as text (CLI, MCP, Polpo's chat). */
export function benchmarkRunText(run: BenchmarkRun, board?: BenchmarkLeaderboard): string {
  const p = run.progress;
  const lines = [
    `${run.name} [${run.id}] · ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""} · ${p.runsDone}/${p.runsTotal} runs · ${p.casesDone}/${p.casesTotal} cases · spent $${run.spentUsd.toFixed(4)}`
      + `${run.budgetUsd !== undefined ? ` of $${run.budgetUsd.toFixed(2)}` : ""} · estimate $${run.estimate.costUsd.toFixed(4)}`,
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  for (const n of run.notes) lines.push(`note: ${n}`);
  const lb = board ?? run.leaderboard;
  if (lb?.entries.length) {
    lines.push(`Leaderboard (quality = ${lb.qualityMetric === "score" ? "score" : "pass rate"}; weights quality ${lb.weights.quality}, cost ${lb.weights.cost}, latency ${lb.weights.latency}):`);
    for (const e of lb.entries) {
      lines.push(`${e.rank}. ${e.label}${e.pareto ? " ◆" : ""} · quality ${e.quality.toFixed(2)} ± ${e.qualityStddev.toFixed(2)} · pass ${Math.round(e.passRate * 100)}% · $${e.costUsd.toFixed(4)}/rep · p50 ${(e.latencyP50Ms / 1000).toFixed(1)} s · p95 ${(e.latencyP95Ms / 1000).toFixed(1)} s`
        + `${e.flakiness ? ` · flaky ${Math.round(e.flakiness * 100)}%` : ""} · composite ${e.composite.toFixed(3)}`);
    }
    if (lb.paretoFront.length) lines.push(`◆ Pareto front: ${lb.paretoFront.join(", ")}`);
    for (const n of lb.notes) lines.push(`≈ ${n}`);
  }
  return lines.join("\n");
}
