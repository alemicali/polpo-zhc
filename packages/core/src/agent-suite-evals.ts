/**
 * Agent suite evals (phase 2): scorers, aggregates, repetitions, baselines, trends and the AI review
 * of a run. Pure (no I/O): the LLM judge and the custom scorers' sandbox are given by the host
 * (src/server/agent-suites.ts), so every scorer can be tested with mocks.
 *
 *   Scorer       a score 0..1 for one case, pass / fail against a threshold, with a reason: exact,
 *                numeric, contains_all / contains_any, regex, similarity, json_schema,
 *                tool_trajectory, cost, latency, llm_judge (G-Eval), custom (sandboxed JS)
 *   Aggregates   per scorer mean / median / p10, the run's weighted score, pass rate, cost and
 *                latency; with repetitions, each case's mean, stddev and a flakiness flag
 *   Baseline     a marked run (or the previous / production one): deltas per case and per scorer,
 *                regressions and improvements beyond a tolerance
 *   Trend        a suite's runs over time (score, pass rate, cost, latency), by version
 */
import { argsMatch, scorerJudgeRole, suiteToolMatches, validateJsonSchema } from "./agent-suites.js";
import type {
  SuiteRole, CaseInput, SuiteCaseResult, SuiteCaseStatus, SuiteRun, SuiteScoreResult, SuiteScorer, SuiteScorerType, SuiteTrace,
} from "./agent-suites.js";

// ── Shapes ───────────────────────────────────────────────────────────

export interface SuiteScorerAggregate {
  id: string;
  label: string;
  type: SuiteScorerType;
  /** Scored results (attempts included). */
  count: number;
  mean: number;
  median: number;
  p10: number;
  min: number;
  max: number;
  stddev: number;
  /** Share of results that passed this scorer. */
  passRate: number;
  weight: number;
}

/** One case (or dataset row) over its attempts. */
export interface SuiteCaseAggregate {
  /** The case key without the attempt (caseId or caseId#row). */
  key: string;
  caseId: string;
  caseName: string;
  row?: { index: number; values: Record<string, unknown> };
  attempts: number;
  passed: number;
  /** passed / attempts run (skipped ones not counted). */
  passRate: number;
  /** Mean of the attempts' overall scores. */
  score?: number;
  scoreStddev?: number;
  /** Both passed and failed, or scores spread more than the flaky threshold. */
  flaky: boolean;
  /** Mean per scorer id. */
  scores: Record<string, number>;
  costUsd: number;
  durationMs: number;
  status: SuiteCaseStatus;
}

export interface SuiteRunAggregates {
  /** The run's overall score: the mean of the cases' weighted scores (0..1), when any case has scorers. */
  score?: number;
  passRate: number;
  costUsd: number;
  durationMs: number;
  latencyP50Ms?: number;
  latencyP90Ms?: number;
  /** What the LLM judges cost (not the agent's cost). */
  judgeCostUsd: number;
  scorers: SuiteScorerAggregate[];
  cases: SuiteCaseAggregate[];
  /** Keys of flaky cases. */
  flaky: string[];
  repetitions: number;
}

export type SuiteChange = "regressed" | "improved" | "unchanged" | "new" | "removed";

export interface SuiteScorerDelta {
  id: string;
  label?: string;
  baseline?: number;
  current?: number;
  delta?: number;
  change: SuiteChange;
}

export interface SuiteCaseDelta {
  key: string;
  caseName: string;
  change: SuiteChange;
  baselineStatus?: SuiteCaseStatus;
  status?: SuiteCaseStatus;
  passRate: { baseline?: number; current?: number; delta?: number };
  score?: { baseline?: number; current?: number; delta?: number };
  scorers: SuiteScorerDelta[];
  /** Why it changed, in words. */
  reasons: string[];
  costDelta?: number;
  durationDelta?: number;
}

/** A run compared with its baseline. */
export interface SuiteBaselineComparison {
  runId: string;
  /** How the baseline was chosen: marked on the suite, given with the run, the previous run, the latest on production. */
  source: "marked" | "request" | "previous" | "production";
  baselineTarget?: string;
  baselineVersion?: string;
  baselineStartedAt?: string;
  tolerance: number;
  passRateDelta: number;
  costDelta: number;
  durationDelta: number;
  scoreDelta?: number;
  regressions: number;
  improvements: number;
  cases: SuiteCaseDelta[];
  scorers: SuiteScorerDelta[];
}

/** The AI review of a run (stored on it). */
export interface SuiteRunReview {
  /** Markdown: a summary, what failed or regressed and why, suggested fixes (prompt, tools, the test itself). */
  text: string;
  model?: string;
  at: string;
  by?: string;
  costUsd?: number;
}

export interface SuiteTrendPoint {
  runId: string;
  startedAt: string;
  target: string;
  version?: string;
  label?: string;
  status: SuiteRun["status"];
  passRate: number;
  score?: number;
  costUsd: number;
  durationMs: number;
  /** Mean per scorer id. */
  scorers: Record<string, number>;
  regressions?: number;
  isBaseline?: boolean;
}

export interface SuiteTrend {
  suiteId: string;
  /** Oldest first. */
  points: SuiteTrendPoint[];
  /** Per version (production's version, a published one, or "draft"): runs and their means. */
  byVersion: Array<{ version: string; runs: number; passRate: number; score?: number; costUsd: number; durationMs: number; lastRunAt: string }>;
  /** Scorer ids seen, with their labels. */
  scorers: Array<{ id: string; label: string }>;
}

// ── Small numbers ────────────────────────────────────────────────────

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
export function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}
/** The q-quantile (0..1) by linear interpolation. */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// ── Reading values ───────────────────────────────────────────────────

/** A value at a path: `a.b[0].c`, `$.a`, `items.0.id`. Undefined when missing. */
export function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  const parts = path.replace(/^\$\.?/, "").split(/[.[\]]/).filter(Boolean);
  let v: unknown = value;
  for (const p of parts) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === "string") { const parsed = parseJsonLoose(v); if (parsed !== undefined) v = parsed; }
    if (typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[p];
  }
  return v;
}

/** JSON from a text: the whole text, a ```json block, or the outermost {…} / […]. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) tries.push(fence[1].trim());
  const o = t.indexOf("{"), oc = t.lastIndexOf("}");
  if (o >= 0 && oc > o) tries.push(t.slice(o, oc + 1));
  const a = t.indexOf("["), ac = t.lastIndexOf("]");
  if (a >= 0 && ac > a) tries.push(t.slice(a, ac + 1));
  for (const x of tries) { try { return JSON.parse(x); } catch { /* next */ } }
  return undefined;
}

/** What a scorer reads from the trace (see {@link SuiteScorer} `from`, `tool`, `which`, `path`). */
export function scorerValue(s: SuiteScorer, trace: SuiteTrace): { value: unknown; found: boolean; what: string } {
  const from = s.from ?? (s.type === "json_schema" ? "reply_json" : "reply");
  const pick = <T>(xs: T[]) => (s.which === "first" ? xs[0] : xs[xs.length - 1]);
  let value: unknown;
  let what: string;
  let found = true;
  switch (from) {
    case "reply": value = trace.text; what = "the reply"; break;
    case "reply_json": {
      value = parseJsonLoose(trace.text);
      what = "the reply's JSON";
      if (value === undefined) found = false;
      break;
    }
    case "tool_args":
    case "tool_result": {
      const calls = trace.toolCalls.filter((c) => suiteToolMatches(s.tool ?? "*", c.name));
      const call = pick(calls);
      what = `${s.which ?? "last"} ${s.tool} call's ${from === "tool_args" ? "arguments" : "result"}`;
      if (!call) { found = false; break; }
      value = from === "tool_args" ? call.args : (parseJsonLoose(call.result) ?? call.result);
      break;
    }
    case "outcome": {
      const calls = trace.toolCalls.filter((c) => c.name === "register_outcome" && !c.isError);
      const call = pick(calls);
      what = "the registered outcome";
      if (!call) { found = false; break; }
      value = call.args;
      break;
    }
  }
  if (found && s.path) {
    value = readPath(value, s.path);
    what = `${what} at ${s.path}`;
    if (value === undefined) found = false;
  }
  return { value, found, what };
}

// ── Text ─────────────────────────────────────────────────────────────

/** Lowercase, accents and punctuation removed, spaces folded. */
export function normalizeText(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Normalized similarity 0..1 of two texts: 1 − edit distance / longer length (levenshtein), or the
 * Dice coefficient of their words (tokens; used for long texts too, over 2000 characters).
 */
export function textSimilarity(a: string, b: string, method: "levenshtein" | "tokens" = "levenshtein"): number {
  const x = normalizeText(a), y = normalizeText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (method === "tokens" || Math.max(x.length, y.length) > 2000) {
    const count = (s: string) => { const m = new Map<string, number>(); for (const w of s.split(" ")) m.set(w, (m.get(w) ?? 0) + 1); return m; };
    const cx = count(x), cy = count(y);
    let common = 0;
    for (const [w, n] of cx) common += Math.min(n, cy.get(w) ?? 0);
    return (2 * common) / (x.split(" ").length + y.split(" ").length);
  }
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** A number from a value: itself, or the first number in its text ("4,99 EUR" → 4.99); `extract`'s first group first. */
export function extractNumber(value: unknown, extract?: string): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null || value === undefined) return undefined;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (extract) {
    let m: RegExpExecArray | null = null;
    try { m = new RegExp(extract).exec(text); } catch { return undefined; }
    if (!m) return undefined;
    text = m[1] ?? m[0];
  }
  const m = /-?\d[\d\s.,']*/.exec(text);
  if (!m) return undefined;
  let t = m[0].replace(/[\s']/g, "").replace(/[.,]$/, "");
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  if (lastDot < 0 && /^-?\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, ""); // 12,000 · 1,234,567: thousands
  else if (lastComma < 0 && /^-?\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, ""); // 1.234.567
  else if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", "."); // 4,99 · 1.234,56
  else t = t.replace(/,/g, ""); // 1,234.56
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Longest common subsequence length, with glob patterns on the expected side. */
function lcs(expected: string[], actual: string[]): number {
  const dp = Array.from({ length: expected.length + 1 }, () => new Array<number>(actual.length + 1).fill(0));
  for (let i = 1; i <= expected.length; i++) {
    for (let j = 1; j <= actual.length; j++) {
      dp[i][j] = suiteToolMatches(expected[i - 1], actual[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[expected.length][actual.length];
}

// ── Scorers ──────────────────────────────────────────────────────────

/** The default threshold of a scorer type. */
export function defaultScorerThreshold(type: SuiteScorerType): number {
  return type === "similarity" ? 0.8 : type === "llm_judge" ? 0.6 : 1;
}

const show = (v: unknown, n = 80) => { const t = typeof v === "string" ? v : JSON.stringify(v) ?? "undefined"; return t.length > n ? `${t.slice(0, n)}…` : t; };

/** A readable description of a scorer ("numeric 4.99 ±0.01 on the reply"). */
export function describeScorer(s: SuiteScorer): string {
  if (s.label) return s.label;
  const on = s.from && s.from !== "reply" ? ` on ${s.from === "tool_args" || s.from === "tool_result" ? `${s.tool} ${s.from === "tool_args" ? "args" : "result"}` : s.from}${s.path ? `.${s.path}` : ""}` : s.path ? ` on reply.${s.path}` : "";
  switch (s.type) {
    case "exact": return `equals ${show(s.expected)}${on}`;
    case "numeric": return `number ${show(s.expected)}${s.tolerance ? ` ±${s.tolerance}${s.relative ? " (relative)" : ""}` : ""}${on}`;
    case "contains_all": return `contains all of ${s.values.map((v) => `"${v}"`).join(", ")}${on}`;
    case "contains_any": return `contains any of ${s.values.map((v) => `"${v}"`).join(", ")}${on}`;
    case "regex": return `matches /${s.pattern}/${s.flags ?? ""}${on}`;
    case "similarity": return `similar to ${show(s.expected, 60)}${on}`;
    case "json_schema": return `valid against a JSON Schema${on}`;
    case "tool_trajectory": return `tools ${s.order === "any" ? "(any order)" : s.order === "exact" ? "(exactly)" : "(in order)"}: ${s.expected.join(" → ")}`;
    case "cost": return `costs at most $${s.maxUsd}`;
    case "latency": return `answers within ${s.maxMs} ms`;
    case "llm_judge": return `LLM judge: ${show(s.rubric, 70)}`;
    case "custom": return "custom scorer";
  }
}

export interface ScorerContext {
  trace: SuiteTrace;
  input?: CaseInput;
  row?: Record<string, unknown>;
}

export interface ScorerDeps {
  /**
   * The LLM judge: a chat turn of the judge's role (an agent, a model + engine block, or Polpo) through
   * the chat completions pipeline. `check` reads an answer (undefined: readable, else why not): an
   * unreadable one gets one corrective follow-up turn in the same conversation.
   */
  judge?: (req: { role?: SuiteRole; prompt: string; check?: (text: string) => string | undefined }) => Promise<{ text: string; model?: string; costUsd?: number }>;
  /** The suite's judge (evals.judge; the old evals.judgeModel as a model block). */
  judgeRole?: SuiteRole;
  /** Runs a custom scorer's code in the sandbox; returns what the code returned. */
  custom?: (req: { code: string; input: Record<string, unknown>; timeoutMs?: number }) => Promise<unknown>;
}

type Scored = Pick<SuiteScoreResult, "score"> & Partial<Pick<SuiteScoreResult, "reason" | "expected" | "actual" | "error" | "judge">>;

/** The deterministic scorers (everything but llm_judge and custom). */
export function scoreDeterministic(s: SuiteScorer, ctx: ScorerContext): Scored {
  const t = ctx.trace;
  switch (s.type) {
    case "cost": {
      const c = t.usage.costUsd;
      const score = c <= s.maxUsd ? 1 : s.maxUsd <= 0 ? 0 : s.maxUsd / c;
      return { score, actual: c, expected: s.maxUsd, reason: `$${c.toFixed(4)} (target $${s.maxUsd})` };
    }
    case "latency": {
      const ms = t.durationMs;
      return { score: ms <= s.maxMs ? 1 : s.maxMs / ms, actual: ms, expected: s.maxMs, reason: `${ms} ms (target ${s.maxMs} ms)` };
    }
    case "tool_trajectory": {
      const actual = t.toolCalls.map((c) => c.name);
      const order = s.order ?? "in_order";
      let score: number;
      if (order === "any") {
        const left = [...actual];
        let hit = 0;
        for (const e of s.expected) { const i = left.findIndex((a) => suiteToolMatches(e, a)); if (i >= 0) { hit++; left.splice(i, 1); } }
        score = hit / s.expected.length;
      } else if (order === "exact") {
        const exact = actual.length === s.expected.length && s.expected.every((e, i) => suiteToolMatches(e, actual[i]));
        score = exact ? 1 : lcs(s.expected, actual) / Math.max(s.expected.length, actual.length, 1);
      } else {
        score = lcs(s.expected, actual) / s.expected.length;
      }
      return { score, expected: s.expected, actual, reason: `called: ${actual.join(" → ") || "none"}` };
    }
    default: break;
  }
  const { value, found, what } = scorerValue(s, t);
  if (!found) return { score: 0, reason: `${what}: not found`, actual: undefined };
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  switch (s.type) {
    case "exact": {
      let ok: boolean;
      if (typeof s.expected === "string" && typeof value === "string") {
        ok = s.caseSensitive ? value.trim() === s.expected.trim() : value.trim().toLowerCase() === s.expected.trim().toLowerCase();
      } else ok = argsMatch(s.expected, value, "exact");
      return { score: ok ? 1 : 0, expected: s.expected, actual: value, reason: ok ? `${what} equals the expected value` : `${what} is ${show(value)}, expected ${show(s.expected)}` };
    }
    case "numeric": {
      const expected = extractNumber(s.expected);
      const actual = extractNumber(value, s.extract);
      if (expected === undefined) return { score: 0, error: `the expected value ${show(s.expected)} is not a number` };
      if (actual === undefined) return { score: 0, expected, actual: value, reason: `no number in ${what} (${show(value)})` };
      const diff = Math.abs(actual - expected);
      const tol = (s.tolerance ?? 0) * (s.relative ? Math.abs(expected) : 1);
      const score = diff <= tol + 1e-12 ? 1 : clamp01(1 - diff / Math.max(Math.abs(expected), 1e-9));
      return { score, expected, actual, reason: `${actual} vs ${expected}${tol ? ` (±${round(tol, 6)})` : ""}: off by ${round(diff, 6)}` };
    }
    case "contains_all":
    case "contains_any": {
      const hay = s.caseSensitive ? text : text.toLowerCase();
      const found = s.values.filter((v) => hay.includes(s.caseSensitive ? v : v.toLowerCase()));
      const missing = s.values.filter((v) => !found.includes(v));
      const score = s.type === "contains_all" ? found.length / s.values.length : found.length ? 1 : 0;
      return { score, expected: s.values, actual: show(text, 300), reason: missing.length ? `missing ${missing.map((m) => `"${m}"`).join(", ")}${found.length ? `; found ${found.map((m) => `"${m}"`).join(", ")}` : ""}` : "all found" };
    }
    case "regex": {
      let re: RegExp;
      try { re = new RegExp(s.pattern, s.flags); } catch { return { score: 0, error: `invalid pattern /${s.pattern}/` }; }
      const ok = re.test(text);
      return { score: ok ? 1 : 0, actual: show(text, 300), reason: ok ? `${what} matches` : `${what} does not match /${s.pattern}/${s.flags ?? ""}` };
    }
    case "similarity": {
      const score = textSimilarity(text, String(s.expected), s.method ?? "levenshtein");
      return { score, expected: s.expected, actual: show(text, 300), reason: `${(score * 100).toFixed(0)}% similar (${s.method ?? "levenshtein"})` };
    }
    case "json_schema": {
      const errs = validateJsonSchema(s.schema, value);
      return { score: errs.length ? 0 : 1, actual: value, reason: errs.length ? `${what}: ${errs.slice(0, 5).join("; ")}` : `${what} is valid` };
    }
    default:
      return { score: 0, error: `${s.type} is not a deterministic scorer` };
  }
}

/** The G-Eval prompt for an LLM judge. */
export function judgePrompt(s: Extract<SuiteScorer, { type: "llm_judge" }>, ctx: ScorerContext): string {
  const criteria = s.criteria?.length ? s.criteria : [{ name: "overall", description: s.rubric, weight: 1 }];
  const user = [...ctx.trace.input].reverse().find((m) => m.role === "user")?.content ?? ctx.input?.message ?? "";
  const tools = ctx.trace.toolCalls.slice(0, 30).map((c) => `- ${c.name}(${show(c.args, 300)}) → ${c.isError ? "ERROR " : ""}${show(c.result, 300)}`);
  return [
    "You are an impartial evaluator (LLM-as-a-judge, G-Eval). Score an AI agent's answer against the rubric and its criteria.",
    "",
    "## Rubric",
    s.rubric,
    "",
    "## Criteria",
    ...criteria.map((c, i) => `${i + 1}. ${c.name} (weight ${c.weight ?? 1}): ${c.description}`),
    "",
    "## The user's message",
    user.slice(0, 8000),
    "",
    "## The agent's reply",
    ctx.trace.text.slice(0, 12_000) || "(empty)",
    ...(tools.length ? ["", "## Tools the agent called", ...tools] : []),
    ...(s.expected ? ["", "## Reference answer", s.expected.slice(0, 8000)] : []),
    "",
    "Evaluate step by step. For each criterion, first reason briefly (cite the reply), then give a score from 1 (fails it completely) to 5 (fully meets it).",
    'Answer with JSON only: {"criteria":[{"name":"<criterion>","reasoning":"<why>","score":<1-5>}],"summary":"<one or two sentences>"}',
  ].join("\n");
}

/** Read the judge's answer: per-criterion scores (1–5) and the weighted score 0..1. Throws when unreadable. */
export function parseJudgeResponse(text: string, s: Extract<SuiteScorer, { type: "llm_judge" }>): { score: number; criteria: Array<{ name: string; weight: number; score: number; reasoning: string }>; summary?: string } {
  const criteria = s.criteria?.length ? s.criteria : [{ name: "overall", description: s.rubric, weight: 1 }];
  const data = parseJsonLoose(text) as { criteria?: Array<{ name?: unknown; score?: unknown; reasoning?: unknown }>; summary?: unknown; score?: unknown; reasoning?: unknown } | undefined;
  if (!data || typeof data !== "object") throw new Error(`the judge did not answer with JSON: ${show(text, 200)}`);
  const given = Array.isArray(data.criteria) ? data.criteria : typeof data.score === "number" ? [{ name: criteria[0].name, score: data.score, reasoning: data.reasoning }] : [];
  const out = criteria.map((c, i) => {
    const g = given.find((x) => typeof x?.name === "string" && normalizeText(x.name) === normalizeText(c.name)) ?? (given.length === criteria.length ? given[i] : undefined);
    const n = typeof g?.score === "number" ? g.score : Number(g?.score);
    if (!g || !Number.isFinite(n)) throw new Error(`the judge did not score "${c.name}"`);
    return { name: c.name, weight: c.weight ?? 1, score: Math.max(1, Math.min(5, n)), reasoning: typeof g.reasoning === "string" ? g.reasoning : "" };
  });
  const totalW = out.reduce((a, c) => a + c.weight, 0);
  const score = totalW > 0
    ? out.reduce((a, c) => a + c.weight * ((c.score - 1) / 4), 0) / totalW
    : mean(out.map((c) => (c.score - 1) / 4));
  return { score: clamp01(score), criteria: out, ...(typeof data.summary === "string" ? { summary: data.summary } : {}) };
}

/** What a custom scorer's code receives. */
export function customScorerInput(ctx: ScorerContext, expected: unknown): Record<string, unknown> {
  const t = ctx.trace;
  return {
    reply: t.text,
    toolCalls: t.toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result, isError: c.isError })),
    turns: t.turns.length,
    costUsd: t.usage.costUsd,
    durationMs: t.durationMs,
    message: ctx.input?.message ?? [...t.input].reverse().find((m) => m.role === "user")?.content ?? "",
    row: ctx.row ?? {},
    expected: expected ?? null,
  };
}

/** Read what a custom scorer returned: a number 0..1, a boolean, or { score, reason }. */
export function readCustomScore(out: unknown): { score: number; reason?: string } {
  if (typeof out === "boolean") return { score: out ? 1 : 0 };
  if (typeof out === "number") { if (!Number.isFinite(out)) throw new Error("the code returned a number that is not finite"); return { score: clamp01(out) }; }
  if (out && typeof out === "object") {
    const o = out as { score?: unknown; reason?: unknown; passed?: unknown; result?: unknown };
    if (o.result !== undefined && o.score === undefined) return readCustomScore(o.result);
    const score = typeof o.score === "boolean" ? (o.score ? 1 : 0) : typeof o.score === "number" ? o.score : typeof o.passed === "boolean" ? (o.passed ? 1 : 0) : NaN;
    if (!Number.isFinite(score)) throw new Error("the code must return a number 0..1, a boolean, or { score, reason }");
    return { score: clamp01(score), ...(typeof o.reason === "string" ? { reason: o.reason.slice(0, 2000) } : {}) };
  }
  throw new Error("the code must return a number 0..1, a boolean, or { score, reason }");
}

function finish(s: SuiteScorer, id: string, r: Scored): SuiteScoreResult {
  const threshold = s.threshold ?? defaultScorerThreshold(s.type);
  const score = round(clamp01(r.score));
  return {
    scorer: s, id, description: describeScorer(s), score, threshold, weight: s.weight ?? 1,
    passed: !r.error && score >= threshold - 1e-9,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.expected !== undefined ? { expected: r.expected } : {}),
    ...(r.actual !== undefined ? { actual: r.actual } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.judge ? { judge: r.judge } : {}),
  };
}

/** Score one case with one scorer. Never throws: a scorer that cannot run returns `error` (the case errors). */
export async function evaluateScorer(s: SuiteScorer, ctx: ScorerContext, deps: ScorerDeps = {}, index = 0): Promise<SuiteScoreResult> {
  const id = s.id ?? (index ? `${s.type.replace(/_/g, "-")}-${index + 1}` : s.type.replace(/_/g, "-"));
  try {
    if (s.type === "llm_judge") {
      if (!deps.judge) return finish(s, id, { score: 0, error: "No LLM judge is available on this server" });
      const role = scorerJudgeRole(s) ?? deps.judgeRole;
      const check = (text: string): string | undefined => { try { parseJudgeResponse(text, s); return undefined; } catch (err) { return err instanceof Error ? err.message : String(err); } };
      const res = await deps.judge({ ...(role ? { role } : {}), prompt: judgePrompt(s, ctx), check });
      let parsed: ReturnType<typeof parseJudgeResponse>;
      try { parsed = parseJudgeResponse(res.text, s); } catch (err) {
        // the raw answer, for the person reading the result
        throw new Error(`${err instanceof Error ? err.message : String(err)}. The judge answered: ${show(res.text.trim() || "(nothing)", 2000)}`);
      }
      return finish(s, id, {
        score: parsed.score,
        reason: parsed.summary ?? parsed.criteria.map((c) => `${c.name} ${c.score}/5`).join(", "),
        judge: { ...(res.model ? { model: res.model } : {}), criteria: parsed.criteria, ...(parsed.summary ? { summary: parsed.summary } : {}), ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}) },
      });
    }
    if (s.type === "custom") {
      if (!deps.custom) return finish(s, id, { score: 0, error: "Custom scorers need the sandboxed code worker (bubblewrap on Linux), which this server does not have" });
      const out = await deps.custom({ code: s.code, input: customScorerInput(ctx, s.expected), ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}) });
      const r = readCustomScore(out);
      return finish(s, id, { score: r.score, ...(r.reason ? { reason: r.reason } : {}) });
    }
    return finish(s, id, scoreDeterministic(s, ctx));
  } catch (err) {
    return finish(s, id, { score: 0, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Score a case with all its scorers (judges run one at a time). */
export async function scoreSuiteCase(scorers: SuiteScorer[], ctx: ScorerContext, deps: ScorerDeps = {}): Promise<SuiteScoreResult[]> {
  const out: SuiteScoreResult[] = [];
  for (const [i, s] of scorers.entries()) out.push(await evaluateScorer(s, ctx, deps, i));
  return out;
}

/** A case's overall score: the weighted mean of its scores (undefined without scores). */
export function caseOverallScore(scores: SuiteScoreResult[] | undefined): number | undefined {
  if (!scores?.length) return undefined;
  const w = scores.reduce((a, s) => a + s.weight, 0);
  if (w <= 0) return round(mean(scores.map((s) => s.score)));
  return round(scores.reduce((a, s) => a + s.score * s.weight, 0) / w);
}

// ── Aggregates ───────────────────────────────────────────────────────

/** A result key without its attempt (`case#2~3` → `case#2`). */
export function baseCaseKey(key: string): string { return key.replace(/~\d+$/, ""); }

type ResultLike = Pick<SuiteCaseResult, "key" | "caseId" | "caseName" | "status" | "costUsd" | "durationMs"> & Partial<Pick<SuiteCaseResult, "row" | "scores" | "score" | "attempt">>;

/** Aggregates of a run's results: per scorer, per case (attempts), the overall score, flaky cases. */
export function suiteRunAggregates(results: ResultLike[], opts: { flakyStddev?: number } = {}): SuiteRunAggregates {
  const flakyStddev = opts.flakyStddev ?? 0.1;
  const counted = results.filter((r) => r.status !== "skipped");
  // per scorer
  const byScorer = new Map<string, { label: string; type: SuiteScorerType; weight: number; scores: number[]; passed: number }>();
  let judgeCostUsd = 0;
  for (const r of counted) {
    for (const s of r.scores ?? []) {
      const e = byScorer.get(s.id) ?? { label: s.description, type: s.scorer.type, weight: s.weight, scores: [], passed: 0 };
      e.scores.push(s.score);
      if (s.passed) e.passed++;
      byScorer.set(s.id, e);
      judgeCostUsd += s.judge?.costUsd ?? 0;
    }
  }
  const scorers: SuiteScorerAggregate[] = [...byScorer.entries()].map(([id, e]) => ({
    id, label: e.label, type: e.type, count: e.scores.length, weight: e.weight,
    mean: round(mean(e.scores)), median: round(quantile(e.scores, 0.5)), p10: round(quantile(e.scores, 0.1)),
    min: round(Math.min(...e.scores)), max: round(Math.max(...e.scores)), stddev: round(stddev(e.scores)), passRate: round(e.passed / e.scores.length),
  }));
  // per case (attempts)
  const groups = new Map<string, ResultLike[]>();
  for (const r of results) { const k = baseCaseKey(r.key); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const cases: SuiteCaseAggregate[] = [...groups.entries()].map(([key, rs]) => {
    const run = rs.filter((r) => r.status !== "skipped");
    const passed = run.filter((r) => r.status === "passed").length;
    const scored = run.map((r) => r.score ?? caseOverallScore(r.scores)).filter((x): x is number => x !== undefined);
    const sd = stddev(scored);
    const perScorer = new Map<string, number[]>();
    for (const r of run) for (const s of r.scores ?? []) perScorer.set(s.id, [...(perScorer.get(s.id) ?? []), s.score]);
    const mixed = passed > 0 && passed < run.length;
    const status: SuiteCaseStatus = !run.length ? "skipped" : run.some((r) => r.status === "errored") && !passed ? "errored" : passed === run.length ? "passed" : "failed";
    return {
      key, caseId: rs[0].caseId, caseName: rs[0].caseName, ...(rs[0].row ? { row: rs[0].row } : {}),
      attempts: run.length, passed, passRate: run.length ? round(passed / run.length) : 0,
      ...(scored.length ? { score: round(mean(scored)), scoreStddev: round(sd) } : {}),
      flaky: run.length > 1 && (mixed || sd > flakyStddev),
      scores: Object.fromEntries([...perScorer.entries()].map(([id, xs]) => [id, round(mean(xs))])),
      costUsd: round(mean(run.map((r) => r.costUsd)), 6), durationMs: Math.round(mean(run.map((r) => r.durationMs))),
      status,
    };
  });
  const caseScores = cases.map((c) => c.score).filter((x): x is number => x !== undefined);
  const latencies = counted.map((r) => r.durationMs);
  const repetitions = Math.max(1, ...results.map((r) => r.attempt ?? 1));
  return {
    ...(caseScores.length ? { score: round(mean(caseScores)) } : {}),
    passRate: counted.length ? round(counted.filter((r) => r.status === "passed").length / counted.length) : 0,
    costUsd: round(counted.reduce((a, r) => a + r.costUsd, 0), 6),
    durationMs: counted.reduce((a, r) => a + r.durationMs, 0),
    ...(latencies.length ? { latencyP50Ms: Math.round(quantile(latencies, 0.5)), latencyP90Ms: Math.round(quantile(latencies, 0.9)) } : {}),
    judgeCostUsd: round(judgeCostUsd, 6),
    scorers, cases,
    flaky: cases.filter((c) => c.flaky).map((c) => c.key),
    repetitions,
  };
}

// ── Baseline ─────────────────────────────────────────────────────────

type RunLike = Pick<SuiteRun, "id" | "target" | "version" | "startedAt" | "stats"> & { results: ResultLike[]; aggregates?: SuiteRunAggregates };

const changeOf = (delta: number | undefined, tol: number): SuiteChange =>
  delta === undefined ? "unchanged" : delta < -tol - 1e-9 ? "regressed" : delta > tol + 1e-9 ? "improved" : "unchanged";

/**
 * Compare a run with a baseline run: per case (over its attempts) the pass rate and the score, per
 * scorer the mean; a drop beyond `tolerance` is a regression, a rise an improvement.
 */
export function compareSuiteRuns(current: RunLike, baseline: RunLike, opts: { tolerance?: number; source?: SuiteBaselineComparison["source"]; flakyStddev?: number } = {}): SuiteBaselineComparison {
  const tol = opts.tolerance ?? 0.05;
  const cur = current.aggregates ?? suiteRunAggregates(current.results, opts);
  const base = baseline.aggregates ?? suiteRunAggregates(baseline.results, opts);
  const baseCases = new Map(base.cases.map((c) => [c.key, c]));
  const curCases = new Map(cur.cases.map((c) => [c.key, c]));
  const cases: SuiteCaseDelta[] = [];
  for (const c of cur.cases) {
    const b = baseCases.get(c.key);
    if (c.status === "skipped") continue;
    if (!b || b.status === "skipped") {
      cases.push({ key: c.key, caseName: c.caseName, change: "new", status: c.status, passRate: { current: c.passRate }, ...(c.score !== undefined ? { score: { current: c.score } } : {}), scorers: [], reasons: ["not in the baseline"] });
      continue;
    }
    const prDelta = round(c.passRate - b.passRate);
    const scDelta = c.score !== undefined && b.score !== undefined ? round(c.score - b.score) : undefined;
    const ids = [...new Set([...Object.keys(b.scores), ...Object.keys(c.scores)])];
    const scorers: SuiteScorerDelta[] = ids.map((id) => {
      const x = b.scores[id], y = c.scores[id];
      if (x === undefined) return { id, current: y, change: "new" as const };
      if (y === undefined) return { id, baseline: x, change: "removed" as const };
      const d = round(y - x);
      return { id, baseline: x, current: y, delta: d, change: changeOf(d, tol) };
    });
    const reasons: string[] = [];
    // a pass → fail is always a regression (single attempts); with repetitions the pass rate counts
    const prChange = changeOf(prDelta, tol);
    if (prChange === "regressed") reasons.push(b.status === "passed" && c.status !== "passed" ? `was ${b.status}, now ${c.status}` : `pass rate ${pct(b.passRate)} → ${pct(c.passRate)}`);
    if (prChange === "improved") reasons.push(b.status !== "passed" && c.status === "passed" ? `was ${b.status}, now passes` : `pass rate ${pct(b.passRate)} → ${pct(c.passRate)}`);
    const scChange = changeOf(scDelta, tol);
    if (scChange !== "unchanged") reasons.push(`score ${b.score!.toFixed(2)} → ${c.score!.toFixed(2)}`);
    for (const s of scorers) if (s.change === "regressed" || s.change === "improved") reasons.push(`${s.id} ${s.baseline!.toFixed(2)} → ${s.current!.toFixed(2)}`);
    const regressed = prChange === "regressed" || scChange === "regressed" || scorers.some((s) => s.change === "regressed");
    const improved = !regressed && (prChange === "improved" || scChange === "improved" || scorers.some((s) => s.change === "improved"));
    cases.push({
      key: c.key, caseName: c.caseName, change: regressed ? "regressed" : improved ? "improved" : "unchanged",
      baselineStatus: b.status, status: c.status,
      passRate: { baseline: b.passRate, current: c.passRate, delta: prDelta },
      ...(c.score !== undefined || b.score !== undefined ? { score: { baseline: b.score, current: c.score, ...(scDelta !== undefined ? { delta: scDelta } : {}) } } : {}),
      scorers, reasons,
      costDelta: round(c.costUsd - b.costUsd, 6), durationDelta: c.durationMs - b.durationMs,
    });
  }
  for (const b of base.cases) {
    if (!curCases.has(b.key) && b.status !== "skipped") cases.push({ key: b.key, caseName: b.caseName, change: "removed", baselineStatus: b.status, passRate: { baseline: b.passRate }, scorers: [], reasons: ["not in this run"] });
  }
  const baseScorers = new Map(base.scorers.map((s) => [s.id, s]));
  const scorers: SuiteScorerDelta[] = cur.scorers.map((s) => {
    const b = baseScorers.get(s.id);
    if (!b) return { id: s.id, label: s.label, current: s.mean, change: "new" as const };
    const d = round(s.mean - b.mean);
    return { id: s.id, label: s.label, baseline: b.mean, current: s.mean, delta: d, change: changeOf(d, tol) };
  });
  for (const b of base.scorers) if (!cur.scorers.some((s) => s.id === b.id)) scorers.push({ id: b.id, label: b.label, baseline: b.mean, change: "removed" });
  const scoreDelta = cur.score !== undefined && base.score !== undefined ? round(cur.score - base.score) : undefined;
  return {
    runId: baseline.id,
    source: opts.source ?? "request",
    baselineTarget: baseline.target,
    ...(baseline.version ? { baselineVersion: baseline.version } : {}),
    baselineStartedAt: baseline.startedAt,
    tolerance: tol,
    passRateDelta: round(cur.passRate - base.passRate),
    costDelta: round(cur.costUsd - base.costUsd, 6),
    durationDelta: cur.durationMs - base.durationMs,
    ...(scoreDelta !== undefined ? { scoreDelta } : {}),
    regressions: cases.filter((c) => c.change === "regressed").length,
    improvements: cases.filter((c) => c.change === "improved").length,
    cases, scorers,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * The baseline run for a new run of a suite: the one given, the suite's marked baseline, or (by
 * the suite's policy) the previous finished run or the latest finished run on production.
 * `runs` are the suite's runs, newest first.
 */
export function pickSuiteBaseline<R extends Pick<SuiteRun, "id" | "status" | "target" | "isBaseline" | "startedAt">>(runs: R[], current: Pick<SuiteRun, "id" | "startedAt">, policy: "previous" | "production" | "none" = "previous"): { run: R; source: SuiteBaselineComparison["source"] } | undefined {
  const finished = runs.filter((r) => r.id !== current.id && ["passed", "failed", "errored"].includes(r.status) && r.startedAt <= current.startedAt);
  const marked = runs.find((r) => r.isBaseline && r.id !== current.id);
  if (marked) return { run: marked, source: "marked" };
  if (policy === "none") return undefined;
  const r = policy === "production" ? finished.find((x) => x.target === "production") : finished[0];
  return r ? { run: r, source: policy } : undefined;
}

// ── Trend ────────────────────────────────────────────────────────────

/** A suite's runs over time (oldest first) and by version. Running and cancelled runs are left out. */
export function suiteTrend(suiteId: string, runs: Array<Pick<SuiteRun, "id" | "startedAt" | "target" | "version" | "status" | "stats" | "variant" | "isBaseline" | "aggregates" | "baseline"> & { results: ResultLike[] }>): SuiteTrend {
  const done = runs.filter((r) => ["passed", "failed", "errored"].includes(r.status)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const labels = new Map<string, string>();
  const points: SuiteTrendPoint[] = done.map((r) => {
    const agg = r.aggregates ?? suiteRunAggregates(r.results);
    for (const s of agg.scorers) if (!labels.has(s.id)) labels.set(s.id, s.label);
    return {
      runId: r.id, startedAt: r.startedAt, target: r.target, ...(r.version ? { version: r.version } : {}),
      ...(r.variant?.label ? { label: r.variant.label } : {}), status: r.status,
      passRate: r.stats.passRate, ...(agg.score !== undefined ? { score: agg.score } : {}),
      costUsd: r.stats.costUsd, durationMs: r.stats.durationMs,
      scorers: Object.fromEntries(agg.scorers.map((s) => [s.id, s.mean])),
      ...(r.baseline ? { regressions: r.baseline.regressions } : {}),
      ...(r.isBaseline ? { isBaseline: true } : {}),
    };
  });
  const groups = new Map<string, SuiteTrendPoint[]>();
  for (const p of points) { const v = p.version ?? p.target; groups.set(v, [...(groups.get(v) ?? []), p]); }
  const byVersion = [...groups.entries()].map(([version, ps]) => {
    const scored = ps.map((p) => p.score).filter((x): x is number => x !== undefined);
    return {
      version, runs: ps.length, passRate: round(mean(ps.map((p) => p.passRate))),
      ...(scored.length ? { score: round(mean(scored)) } : {}),
      costUsd: round(mean(ps.map((p) => p.costUsd)), 6), durationMs: Math.round(mean(ps.map((p) => p.durationMs))),
      lastRunAt: ps[ps.length - 1].startedAt,
    };
  });
  return { suiteId, points, byVersion, scorers: [...labels.entries()].map(([id, label]) => ({ id, label })) };
}

// ── AI review ────────────────────────────────────────────────────────

/** The prompt of "explain this run": the failures, the scorers' reasons, the regressions, the agent's setup. */
export function suiteRunReviewPrompt(run: SuiteRun, agent: { name: string; instructions?: string; tools?: string[]; model?: string } = { name: run.agent }, opts: { language?: string } = {}): string {
  const lines: string[] = [];
  const s = run.stats;
  const agg = run.aggregates;
  lines.push(
    `You review a test and eval run of the AI agent "${agent.name}" on Polpo. Explain the run to the person who owns the agent, and suggest fixes.`,
    "",
    `## The run`,
    `Suite "${run.suiteName}" on ${run.target}${run.version ? ` (v${run.version})` : ""}${run.variant.label ? ` · ${run.variant.label}` : ""}: ${run.status}, ${s.passed}/${s.total - s.skipped} cases passed, $${s.costUsd.toFixed(4)}, ${(s.durationMs / 1000).toFixed(1)} s.`,
  );
  if (agg?.score !== undefined) lines.push(`Overall score ${agg.score.toFixed(2)}; per scorer: ${agg.scorers.map((x) => `${x.id} mean ${x.mean.toFixed(2)} (p10 ${x.p10.toFixed(2)}, pass ${pct(x.passRate)})`).join("; ")}.`);
  if (agg?.flaky.length) lines.push(`Flaky cases (different results across ${agg.repetitions} attempts): ${agg.flaky.join(", ")}.`);
  if (run.error) lines.push(`Run error: ${run.error}`);
  const failing = run.results.filter((r) => r.status === "failed" || r.status === "errored").slice(0, 15);
  if (failing.length) {
    lines.push("", "## Failed or errored cases");
    for (const r of failing) {
      lines.push(`### ${r.caseName} [${r.key}] — ${r.status} (mode ${r.mode})`);
      const user = [...(r.trace?.input ?? [])].reverse().find((m) => m.role === "user")?.content;
      if (user) lines.push(`User: ${show(user, 600)}`);
      if (r.error) lines.push(`Error: ${show(r.error, 600)}`);
      for (const a of r.assertions?.filter((x) => !x.passed) ?? []) lines.push(`- assertion ✗ ${a.description}: ${show(a.message, 400)}${a.diff ? `\n  diff:\n${a.diff.split("\n").slice(0, 20).map((l) => `    ${l}`).join("\n")}` : ""}`);
      for (const x of r.scores?.filter((y) => !y.passed) ?? []) lines.push(`- scorer ✗ ${x.description}: ${x.score.toFixed(2)} < ${x.threshold}${x.error ? ` (error: ${x.error})` : ""}${x.reason ? ` — ${show(x.reason, 400)}` : ""}${x.judge?.criteria.length ? `\n  judge: ${x.judge.criteria.map((c) => `${c.name} ${c.score}/5: ${show(c.reasoning, 200)}`).join(" | ")}` : ""}`);
      if (r.trace) {
        const calls = r.trace.toolCalls.slice(0, 12).map((c) => `${c.name}${c.mocked ? `[${c.mocked}]` : ""}(${show(c.args, 160)}) → ${c.isError ? "ERROR " : ""}${show(c.result, 160)}`);
        if (calls.length) lines.push(`Tool calls: ${calls.join("; ")}`);
        lines.push(`Reply: ${show(r.trace.text, 800) || "(empty)"}`);
        if (r.trace.notes.length) lines.push(`Notes: ${r.trace.notes.join("; ")}`);
      }
    }
  }
  if (run.baseline) {
    const b = run.baseline;
    lines.push("", "## Compared with the baseline", `Baseline ${b.runId} (${b.source}, ${b.baselineTarget ?? ""}${b.baselineVersion ? ` v${b.baselineVersion}` : ""}): pass rate ${b.passRateDelta >= 0 ? "+" : ""}${pct(b.passRateDelta)}${b.scoreDelta !== undefined ? `, score ${b.scoreDelta >= 0 ? "+" : ""}${b.scoreDelta.toFixed(2)}` : ""}, cost ${b.costDelta >= 0 ? "+" : ""}$${b.costDelta.toFixed(4)}; ${b.regressions} regression(s), ${b.improvements} improvement(s).`);
    for (const c of b.cases.filter((x) => x.change === "regressed" || x.change === "improved").slice(0, 15)) lines.push(`- ${c.change}: ${c.caseName} [${c.key}] — ${c.reasons.join("; ")}`);
  }
  lines.push("", "## The agent");
  if (agent.model) lines.push(`Model: ${agent.model}`);
  if (agent.tools?.length) lines.push(`Tools: ${agent.tools.slice(0, 60).join(", ")}`);
  lines.push(`Instructions:\n${show(agent.instructions ?? "(none)", 4000)}`);
  lines.push(
    "",
    "## What to write",
    `Answer in ${opts.language ?? "English"}, in Markdown, concise, with these sections:`,
    "1. **Summary** — two or three sentences: how the run went.",
    "2. **What failed and why** — per failing or regressed case, the most likely cause (the agent's behaviour, its instructions, a tool, or the test itself: a wrong expectation or mock).",
    "3. **Suggested fixes** — concrete changes: instruction edits (quote the text to add or change), tool changes (allowed tools, tool descriptions, connectors), and test changes when the test is wrong.",
    "If everything passed and nothing regressed, say so and suggest what is worth testing next.",
  );
  return lines.join("\n");
}
