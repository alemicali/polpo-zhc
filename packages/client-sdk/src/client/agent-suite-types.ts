/**
 * Agent suites — tests and evals of an agent with tool and model mocks, datasets and assertions,
 * run against a version with a trace per case. Mirrors @polpo-ai/core/agent-suites (the server
 * contract); see docs/agent-suites.md. Fields marked "later" are reserved for the next phases
 * (scorers, gates, cassettes, simulated users, benchmarks).
 */

/** none: live · tools: mocked tools, real model · model: scripted model, real tools · all: offline contract. */
export type SuiteMockMode = "none" | "tools" | "model" | "all";
export type ArgsMatchMode = "exact" | "partial" | "regex" | "schema";

export interface ToolMock {
  id?: string;
  /** A tool name or a glob (mcp__printful__*). */
  tool: string;
  when?: { args?: unknown; match?: ArgsMatchMode; call?: number };
  response?: unknown;
  error?: string;
  delayMs?: number;
  times?: number;
  description?: string;
}

export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; args?: Record<string, unknown>; id?: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface SuiteMocks {
  tools?: ToolMock[];
  model?: { turns: ScriptedTurn[]; onExhausted?: "stop" | "error" };
  unmockedTools?: "block" | "real";
  /** later (phase 4) */
  cassette?: { id: string; mode: "record" | "replay" };
  /** later (phase 4) */
  simulatedUser?: { persona: string; goal?: string; maxTurns?: number; model?: string };
}

export interface SuiteCaseInput {
  kind: "chat" | "task";
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  context?: {
    system?: string;
    memory?: string;
    files?: Array<{ path: string; content: string }>;
    attachments?: Array<{ name: string; content: string; mimeType?: string }>;
  };
}

export type SuiteAssertion = { id?: string; label?: string } & (
  | { type: "tool_called"; tool: string; times?: number; min?: number; max?: number; args?: unknown; match?: ArgsMatchMode }
  | { type: "tool_not_called"; tool: string; args?: unknown; match?: ArgsMatchMode }
  | { type: "tool_order"; tools: string[]; strict?: boolean }
  | { type: "tool_args"; tool: string; value: unknown; match?: ArgsMatchMode; which?: "any" | "all" | "first" | "last" }
  | { type: "no_tool_errors" }
  | { type: "outcome_registered"; label?: string; outcomeType?: string; valueContains?: string }
  | { type: "artifact_created"; kind?: string; titleContains?: string }
  | { type: "approval_requested"; tool?: string }
  | { type: "text_contains"; value: string | string[]; caseSensitive?: boolean }
  | { type: "text_not_contains"; value: string | string[]; caseSensitive?: boolean }
  | { type: "text_regex"; pattern: string; flags?: string }
  | { type: "max_turns"; value: number }
  | { type: "max_cost"; usd: number }
  | { type: "max_duration"; ms: number }
);
export type SuiteAssertionType = SuiteAssertion["type"];

/** What a scorer reads: the reply (default), the reply's JSON, a tool call's arguments or result, a registered outcome. */
export type ScorerSource = "reply" | "reply_json" | "tool_args" | "tool_result" | "outcome";

export interface JudgeCriterion { name: string; description: string; weight?: number }

/** Evals: a score 0..1 with a threshold (default 1; similarity 0.8; llm_judge 0.6) and a weight. */
export type SuiteScorer = {
  id?: string; label?: string; threshold?: number; weight?: number;
  from?: ScorerSource; tool?: string; which?: "first" | "last"; path?: string;
} & (
  | { type: "exact"; expected: unknown; caseSensitive?: boolean }
  | { type: "numeric"; expected: number | string; tolerance?: number; relative?: boolean; extract?: string }
  | { type: "contains_all"; values: string[]; caseSensitive?: boolean }
  | { type: "contains_any"; values: string[]; caseSensitive?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "similarity"; expected: string; method?: "levenshtein" | "tokens" }
  | { type: "json_schema"; schema: Record<string, unknown> }
  | { type: "tool_trajectory"; expected: string[]; order?: "exact" | "in_order" | "any" }
  | { type: "cost"; maxUsd: number }
  | { type: "latency"; maxMs: number }
  | { type: "llm_judge"; rubric: string; criteria?: JudgeCriterion[]; expected?: string; model?: string }
  | { type: "custom"; code: string; expected?: unknown; timeoutMs?: number }
);
export type SuiteScorerType = SuiteScorer["type"];

/** A suite's eval settings. */
export interface SuiteEvalSettings {
  judgeModel?: string;
  repetitions?: number;
  regressionTolerance?: number;
  flakyStddev?: number;
  baseline?: "previous" | "production" | "none";
}

export interface SuiteBudgets { maxTurns?: number; maxCostUsd?: number; maxDurationMs?: number }

export interface SuiteCase {
  id: string;
  name: string;
  description?: string;
  input: SuiteCaseInput;
  mode?: SuiteMockMode;
  mocks?: SuiteMocks;
  assertions: SuiteAssertion[];
  /** Evals (with the suite's default scorers). */
  scorers?: SuiteScorer[];
  dataset?: string;
  budgets?: SuiteBudgets;
  tags?: string[];
  skip?: boolean;
  source?: { kind: "manual" | "recorded" | "imported" | "generated"; sessionId?: string; runId?: string; at?: string };
}

export interface SuiteDataset {
  id: string;
  name: string;
  description?: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  source?: { kind: "manual" | "csv" | "json" | "generated"; file?: string; at?: string };
}

export interface AgentSuite {
  id: string;
  agent: string;
  name: string;
  description?: string;
  target: { kind: "agent" } | { kind: "mcp-server"; server: string } | { kind: "mission"; mission: string } | { kind: "team"; team: string };
  defaultMode: SuiteMockMode;
  mocks?: SuiteMocks;
  cases: SuiteCase[];
  datasets: SuiteDataset[];
  budgets?: SuiteBudgets;
  concurrency?: number;
  /** Scorers every case gets. */
  scorers?: SuiteScorer[];
  evals?: SuiteEvalSettings;
  /** A deploy gate: required before a version reaches production (docs/agent-suites.md, "CI gate"). */
  gate?: SuiteGate;
  tags?: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** What a client sends to save a suite (ids are made from names when missing). */
export type AgentSuiteInput = Partial<Omit<AgentSuite, "agent" | "createdAt" | "updatedAt" | "updatedBy" | "cases" | "datasets">> & {
  name: string;
  cases?: Array<Partial<SuiteCase> & { name: string; input: SuiteCaseInput }>;
  datasets?: Array<Partial<SuiteDataset> & { name: string; rows: Array<Record<string, unknown>> }>;
};

export interface SuiteVariantOverrides {
  model?: string;
  reasoning?: string;
  engine?: unknown;
  instructions?: string;
  instructionsAppend?: string;
  allowedTools?: string[];
  maxTurns?: number;
}

export interface SuiteRunRequest {
  /** production (default), draft, or a version. */
  target?: string;
  caseIds?: string[];
  mode?: SuiteMockMode;
  concurrency?: number;
  overrides?: SuiteVariantOverrides;
  variant?: { id?: string; label?: string };
  benchmarkRunId?: string;
  repetition?: number;
  trigger?: "manual" | "publish" | "deploy" | "schedule" | "ci" | "benchmark";
  wait?: boolean;
  /** Confirm a run that uses real tools (side effects possible; approvals never given). */
  allowRealTools?: boolean;
  /** Run every case this many times (1–10). */
  repetitions?: number;
  /** Compare with this run instead of the suite's baseline. */
  baselineRunId?: string;
  regressionTolerance?: number;
}

export type SuiteRunStatus = "queued" | "running" | "passed" | "failed" | "errored" | "cancelled";
export type SuiteCaseStatus = "passed" | "failed" | "errored" | "skipped";

export interface SuiteAssertionResult {
  assertion: SuiteAssertion;
  description: string;
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
  diff?: string;
}

export interface SuiteTraceToolCall {
  id: string;
  turn: number;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  /** mock, stub, blocked, or false (ran for real). */
  mocked: "mock" | "stub" | "blocked" | false;
  mockId?: string;
  durationMs: number;
  approval?: "interactive" | "queued";
}

export interface SuiteTraceTurn {
  index: number;
  text: string;
  thinking?: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  mocked: boolean;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  error?: string;
}

export interface SuiteTrace {
  input: Array<{ role: string; content: string }>;
  turns: SuiteTraceTurn[];
  toolCalls: SuiteTraceToolCall[];
  text: string;
  finishReason?: string;
  approvals: Array<{ tool: string; kind: "interactive" | "queued"; detail?: string }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  notes: string[];
}

export interface SuiteCaseResult {
  key: string;
  caseId: string;
  caseName: string;
  row?: { index: number; values: Record<string, unknown> };
  status: SuiteCaseStatus;
  mode: SuiteMockMode;
  engine: "native" | "harness" | "cli";
  assertions: SuiteAssertionResult[];
  scores?: SuiteScoreResult[];
  /** The weighted mean of its scores. */
  score?: number;
  /** With repetitions: the attempt (1-based). */
  attempt?: number;
  trace: SuiteTrace;
  error?: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  variantId: string;
}

export interface SuiteRunStats {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  passRate: number;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  toolCalls: number;
}

export interface SuiteRun {
  id: string;
  agent: string;
  suiteId: string;
  suiteName: string;
  suiteRevision: number;
  target: string;
  version?: string;
  variant: { id: string; label?: string; agent: string; version: string; overrides?: SuiteVariantOverrides };
  /** later (phase 5) */
  benchmarkRunId?: string;
  repetition?: number;
  trigger: "manual" | "publish" | "deploy" | "schedule" | "ci" | "benchmark";
  status: SuiteRunStatus;
  startedAt: string;
  finishedAt?: string;
  actor?: string;
  planned: string[];
  /** In lists, results come without trace and assertions (with `failed`: the failed assertions' descriptions). */
  results: Array<SuiteCaseResult & { failed?: string[] }>;
  stats: SuiteRunStats;
  aggregates?: SuiteRunAggregates;
  repetitions?: number;
  /** The comparison with the baseline run. */
  baseline?: SuiteBaselineComparison;
  /** This run is its suite's marked baseline. */
  isBaseline?: boolean;
  /** "Explain this run" (Markdown). */
  review?: SuiteRunReview;
  /** later (phase 3) */
  /** A gate run (trigger deploy / publish): the decision and its deploy gate. */
  gate?: { decision: "pass" | "fail" | "override"; reason?: string; by?: string; gateId?: string };
  notes: string[];
  error?: string;
}

export interface SuiteDatasetImport {
  format: "csv" | "json";
  text: string;
  id?: string;
  name?: string;
  mode?: "replace" | "append";
  coerce?: boolean;
}

export interface SuiteScoreResult {
  scorer: SuiteScorer;
  id: string;
  description: string;
  score: number;
  threshold: number;
  weight: number;
  passed: boolean;
  reason?: string;
  expected?: unknown;
  actual?: unknown;
  error?: string;
  judge?: { model?: string; criteria: Array<{ name: string; weight: number; score: number; reasoning: string }>; summary?: string; costUsd?: number };
}

export interface SuiteScorerAggregate {
  id: string; label: string; type: SuiteScorerType; count: number;
  mean: number; median: number; p10: number; min: number; max: number; stddev: number; passRate: number; weight: number;
}

export interface SuiteCaseAggregate {
  key: string; caseId: string; caseName: string; row?: { index: number; values: Record<string, unknown> };
  attempts: number; passed: number; passRate: number; score?: number; scoreStddev?: number; flaky: boolean;
  scores: Record<string, number>; costUsd: number; durationMs: number; status: SuiteCaseStatus;
}

export interface SuiteRunAggregates {
  score?: number; passRate: number; costUsd: number; durationMs: number; latencyP50Ms?: number; latencyP90Ms?: number; judgeCostUsd: number;
  scorers: SuiteScorerAggregate[]; cases: SuiteCaseAggregate[]; flaky: string[]; repetitions: number;
}

export type SuiteChange = "regressed" | "improved" | "unchanged" | "new" | "removed";
export interface SuiteScorerDelta { id: string; label?: string; baseline?: number; current?: number; delta?: number; change: SuiteChange }
export interface SuiteCaseDelta {
  key: string; caseName: string; change: SuiteChange; baselineStatus?: SuiteCaseStatus; status?: SuiteCaseStatus;
  passRate: { baseline?: number; current?: number; delta?: number };
  score?: { baseline?: number; current?: number; delta?: number };
  scorers: SuiteScorerDelta[]; reasons: string[]; costDelta?: number; durationDelta?: number;
}
export interface SuiteBaselineComparison {
  runId: string; source: "marked" | "request" | "previous" | "production";
  baselineTarget?: string; baselineVersion?: string; baselineStartedAt?: string; tolerance: number;
  passRateDelta: number; costDelta: number; durationDelta: number; scoreDelta?: number;
  regressions: number; improvements: number; cases: SuiteCaseDelta[]; scorers: SuiteScorerDelta[];
}

export interface SuiteRunReview { text: string; model?: string; at: string; by?: string; costUsd?: number }

export interface SuiteTrendPoint {
  runId: string; startedAt: string; target: string; version?: string; label?: string; status: SuiteRunStatus;
  passRate: number; score?: number; costUsd: number; durationMs: number; scorers: Record<string, number>; regressions?: number; isBaseline?: boolean;
}
export interface SuiteTrend {
  suiteId: string;
  points: SuiteTrendPoint[];
  byVersion: Array<{ version: string; runs: number; passRate: number; score?: number; costUsd: number; durationMs: number; lastRunAt: string }>;
  scorers: Array<{ id: string; label: string }>;
}

// ── Deploy gates (agent suites phase 3) ──

/** A suite as a deploy gate of its agent. */
export interface SuiteGate {
  /** Must pass before a version is deployed to production. */
  required?: boolean;
  /** Minimum pass rate (0..1, default 1). */
  minPassRate?: number;
  /** Largest pass-rate (or overall score) drop allowed versus the baseline (0..1). */
  maxRegression?: number;
  /** Minimum mean score per scorer id ("score": the run's overall score). */
  scoreThresholds?: Record<string, number>;
  /** Also run when a version is published (non-blocking). */
  onPublish?: boolean;
  /** The gate may run the suite's real-tools cases (admins only). */
  allowRealTools?: boolean;
}

export type DeployGateTrigger = "deploy" | "api-update" | "publish";
/** running = "in verifica"; blocked: a deploy stopped; failed: a publish check failed; override: deployed anyway by an admin. */
export type DeployGateStatus = "running" | "passed" | "blocked" | "failed" | "override" | "cancelled" | "errored";
export type DeployGateSuiteStatus = "queued" | "running" | "passed" | "failed" | "errored" | "cancelled" | "not_run";

export interface DeployGateSuite {
  suiteId: string;
  suiteName: string;
  suiteRevision: number;
  runId?: string;
  status: DeployGateSuiteStatus;
  reasons: string[];
  failedCases: Array<{ key: string; caseName: string; failed: string[]; error?: string }>;
  passRate?: number;
  score?: number;
  baselineRunId?: string;
  thresholds: { minPassRate: number; maxRegression?: number; scoreThresholds?: Record<string, number> };
  progress: { done: number; total: number };
}

/** The required suites run against a version (before a deploy, or as a publish check). */
export interface AgentDeployGate {
  id: string;
  agent: string;
  version: string;
  from?: string;
  trigger: DeployGateTrigger;
  status: DeployGateStatus;
  requestedBy: string;
  requestedAt: string;
  finishedAt?: string;
  note?: string;
  suites: DeployGateSuite[];
  progress: { done: number; total: number };
  deployId?: string;
  blockedEntryId?: string;
  override?: { by: string; at: string; reason: string; failed: string[] };
  cancelledBy?: string;
  error?: string;
  notes: string[];
}

/** What a deploy history entry carries about its gate. */
export interface AgentDeployGateRef {
  id: string;
  status: DeployGateStatus;
  trigger: DeployGateTrigger;
  failed: string[];
  suites: Array<{ suiteId: string; suiteName: string; status: DeployGateSuiteStatus; runId?: string; passRate?: number; score?: number }>;
  override?: { by: string; at: string; reason: string; failed: string[] };
}

/** A version's latest gate (the badge in the versions list). */
export interface AgentVersionGateStatus {
  gateId: string;
  status: DeployGateStatus;
  trigger: DeployGateTrigger;
  at: string;
  failed: string[];
  progress?: { done: number; total: number };
}
