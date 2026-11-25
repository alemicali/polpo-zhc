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
  /** A recorded exchange replayed (record it with a run's `record: true` or `recordAgentSuiteCase`). */
  cassette?: SuiteCassetteRef;
  /** A simulated (or scripted) user: a multi-turn case. */
  simulatedUser?: SimulatedUser;
  /** Missions: mocks per agent (by name). */
  agents?: Record<string, SuiteMocks>;
  /** Hosted MCP servers: the upstream API's answers. */
  http?: HttpMock[];
  unmockedHttp?: "block" | "real";
}

export type CassetteMatch = "exact" | "partial" | "tool" | "sequence";

export interface SuiteCassetteRef {
  id: string;
  mode?: "record" | "replay";
  /** How a tool call finds its recorded answer (default exact arguments). */
  match?: CassetteMatch;
  /** A call no recording answers: blocked (default) or the case fails. */
  onUnmatched?: "block" | "fail";
  /** Replay the recorded model turns (default true). */
  model?: boolean;
}

export interface SimulatedUser {
  persona?: string;
  goal?: string;
  constraints?: string[];
  /** User turns after the first (1–20, default 5). */
  maxTurns?: number;
  stop?: "goal" | "scorer" | "max_turns";
  stopScorer?: string;
  model?: string;
  /** Scripted user: these turns, in order (no simulator). */
  script?: string[];
}

export interface HttpMock {
  id?: string;
  method?: string;
  /** A glob or a substring of the request URL. */
  url: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  times?: number;
}

/** A cassette: a recorded exchange (secrets redacted) a case replays. */
export interface SuiteCassette {
  id: string;
  agent: string;
  suiteId?: string;
  caseId?: string;
  name: string;
  source: { kind: "run" | "session" | "task"; runId?: string; sessionId?: string; taskId?: string; target?: string; version?: string };
  input: Array<{ role: string; content: string }>;
  turns: Array<{ text: string; thinking?: string; toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }; model?: string }>;
  calls: SuiteCassetteCall[];
  text: string;
  redactions: number;
  revision: number;
  recordedAt: string;
  recordedBy?: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface SuiteCassetteCall {
  id: string;
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  response: string;
  isError: boolean;
  edited?: boolean;
  /** Turned into a case mock (kept on re-recording). */
  mock?: boolean;
}

/** A cassette in a list (without its calls). */
export type SuiteCassetteSummary = Omit<SuiteCassette, "turns" | "calls" | "input"> & { turnCount: number; callCount: number; tools: string[] };

export interface SuiteCassetteEdit {
  callId: string;
  response?: string;
  isError?: boolean;
  delete?: boolean;
  markAsMock?: boolean;
}

export interface CaseGenerationRequest {
  suiteId?: string;
  count?: number;
  brief?: string;
  sessionIds?: string[];
  include?: Array<"happy" | "edge" | "adversarial">;
  style?: "contract" | "tools";
}

/** A generated case awaiting review (never saved by itself). */
export interface GeneratedCaseProposal {
  index: number;
  case?: SuiteCase;
  dataset?: Pick<SuiteDataset, "id" | "name" | "columns" | "rows">;
  category?: string;
  rationale?: string;
  error?: string;
  raw: unknown;
}

export interface SuiteCaseInput {
  /** chat, task, tool (a hosted server's tool with `args`), mission (the target mission in test mode). */
  kind: "chat" | "task" | "tool" | "mission";
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  context?: {
    system?: string;
    memory?: string;
    files?: Array<{ path: string; content: string }>;
    attachments?: Array<{ name: string; content: string; mimeType?: string }>;
  };
}

export type SuiteAssertion = { id?: string; label?: string } & (
  | { type: "tool_called"; tool: string; times?: number; min?: number; max?: number; args?: unknown; match?: ArgsMatchMode; agent?: string }
  | { type: "tool_not_called"; tool: string; args?: unknown; match?: ArgsMatchMode; agent?: string }
  | { type: "tool_order"; tools: string[]; strict?: boolean }
  | { type: "tool_args"; tool: string; value: unknown; match?: ArgsMatchMode; which?: "any" | "all" | "first" | "last"; agent?: string }
  | { type: "tool_failed"; tool?: string; contains?: string }
  | { type: "http_called"; url: string; method?: string; times?: number }
  | { type: "task_status"; task: string; status: "done" | "failed" | "skipped" }
  | { type: "task_order"; tasks: string[] }
  | { type: "task_agent"; task: string; agent: string }
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
  source?: { kind: "manual" | "recorded" | "imported" | "generated"; sessionId?: string; runId?: string; taskId?: string; at?: string; rationale?: string; category?: string; model?: string };
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
  /** The simulated users' model (default Polpo's). */
  simulatorModel?: string;
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
  /** The variant's id and label; `agent`: run the suite's cases against another agent. */
  variant?: { id?: string; label?: string; agent?: string };
  benchmarkRunId?: string;
  repetition?: number;
  trigger?: "manual" | "publish" | "deploy" | "schedule" | "ci" | "benchmark" | "record";
  wait?: boolean;
  /** Confirm a run that uses real tools (side effects possible; approvals never given). */
  allowRealTools?: boolean;
  /** Run every case this many times (1–10). */
  repetitions?: number;
  /** Compare with this run instead of the suite's baseline. */
  baselineRunId?: string;
  regressionTolerance?: number;
  /** Record: run the cases live (admins, allowRealTools) and save each exchange as its cassette. */
  record?: boolean;
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
  mocked: "mock" | "cassette" | "stub" | "blocked" | false;
  /** Missions: the agent that called it. */
  agent?: string;
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
  agent?: string;
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
  /** Multi-turn cases: the whole conversation (`text` then holds every agent reply). */
  transcript?: Array<{ role: "user" | "assistant"; content: string; simulated?: boolean; note?: string }>;
  finalText?: string;
  simulator?: { model?: string; calls: number; costUsd: number; stoppedBy: "goal" | "scorer" | "max_turns" | "script" | "agent" | "budget" | "error"; goalReached?: boolean };
  /** Missions: each task in the order it ran. */
  tasks?: Array<{ title: string; agent: string; status: "done" | "failed" | "skipped"; text: string; toolCalls: number; turns: number; costUsd: number; durationMs: number; error?: string }>;
  /** Hosted MCP servers: the upstream requests. */
  http?: Array<{ method: string; url: string; status: number; mocked: "mock" | "blocked" | false; mockId?: string; body?: string }>;
  /** A replayed cassette. */
  cassette?: { id: string; replayedCalls: number; replayedTurns: number; unmatched: string[] };
  /** A recording run: the cassette saved from this case. */
  recorded?: { cassetteId: string; calls: number; turns: number; redactions: number };
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
  /** The benchmark run this run belongs to (phase 5). */
  benchmarkRunId?: string;
  repetition?: number;
  trigger: "manual" | "publish" | "deploy" | "schedule" | "ci" | "benchmark" | "record";
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
  /** What the suite tests (default agent); `agent` then holds the owner key (mcp-server:<id>, mission:<id>). */
  targetKind?: "agent" | "mcp-server" | "mission" | "team";
  /** A recording run: each case's exchange was saved as its cassette. */
  record?: boolean;
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

/** A suite target other than an agent. */
export type SuiteTargetKind = "mcp-server" | "mission";

// ── Phase 5: benchmarks and the Playground (docs/agent-suites.md) ──

/** A variant: an agent (any agent) at a version, with per-run overrides. */
export interface BenchmarkVariantSpec {
  id: string;
  label?: string;
  agent: string;
  /** production (default), draft or a published version. */
  version: string;
  overrides?: SuiteVariantOverrides;
}

/** A suite of a benchmark (its agent and id), optionally some cases or the cases of one dataset. */
export interface BenchmarkSuiteRef { agent: string; suite: string; caseIds?: string[]; dataset?: string }

export interface BenchmarkWeights { quality: number; cost: number; latency: number }

export interface BenchmarkDefinition {
  id: string;
  name: string;
  description?: string;
  suites: BenchmarkSuiteRef[];
  variants: BenchmarkVariantSpec[];
  repetitions: number;
  mode?: SuiteMockMode;
  concurrency?: number;
  budgetUsd?: number;
  weights?: BenchmarkWeights;
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** What you send to create or run a benchmark (variants' ids and versions are filled in). */
export type BenchmarkInput = Omit<Partial<BenchmarkDefinition>, "variants" | "suites" | "createdAt" | "updatedAt" | "updatedBy"> & {
  name: string;
  suites: BenchmarkSuiteRef[];
  variants: Array<Partial<BenchmarkVariantSpec> & { agent: string }>;
};

export interface BenchmarkEstimateCell {
  suite: string; owner: string; variantId: string; cases: number; realModelCases: number; judgeCalls: number; costUsd: number;
  basis: "offline" | "history" | "heuristic" | "unknown"; model?: string; realTools: boolean;
}

export interface BenchmarkEstimate {
  runs: number; cases: number; realModelCases: number;
  costUsd: number; maxCostUsd: number;
  /** Nothing calls a real model: free, no confirmation needed. */
  offline: boolean;
  unknownPrice: boolean;
  realTools: boolean;
  cells: BenchmarkEstimateCell[];
  notes: string[];
}

export type BenchmarkRunStatus = "queued" | "running" | "completed" | "cancelled" | "errored";

export interface BenchmarkRunEntry {
  runId: string; owner: string; suiteId: string; suiteName: string; variantId: string; repetition: number;
  status: SuiteRunStatus; costUsd: number; passed: number; total: number; done: number; planned: number; score?: number; error?: string;
}

export interface BenchmarkRun {
  id: string;
  benchmarkId?: string;
  name: string;
  spec: Omit<BenchmarkDefinition, "id" | "revision" | "createdAt" | "updatedAt" | "updatedBy"> & { id?: string };
  status: BenchmarkRunStatus;
  stopReason?: "budget" | "cancelled" | "error";
  startedAt: string;
  finishedAt?: string;
  actor?: string;
  estimate: BenchmarkEstimate;
  budgetUsd?: number;
  spentUsd: number;
  runs: BenchmarkRunEntry[];
  progress: { runsDone: number; runsTotal: number; casesDone: number; casesTotal: number };
  source?: string;
  leaderboard?: BenchmarkLeaderboard;
  notes: string[];
  error?: string;
}

export interface MeanSd { mean: number; stddev: number }

export interface BenchmarkVariantStats {
  variantId: string; label: string; agent: string; version: string; overrides?: SuiteVariantOverrides;
  runs: number; repetitions: number; cases: number;
  passRate: MeanSd; score?: MeanSd;
  scorers: Array<{ id: string; label: string; mean: number; stddev: number }>;
  costUsd: MeanSd & { total: number; perCase: number };
  latency: { p50Ms: number; p95Ms: number; meanMs: number };
  tokens: { input: number; output: number; perCase: number };
  flakiness: number; flakyCases: string[]; errored: number; complete: boolean;
}

export interface BenchmarkLeaderboardEntry {
  rank: number; variantId: string; label: string;
  quality: number; qualityStddev: number; qualityError: number; passRate: number; score?: number;
  costUsd: number; latencyP50Ms: number; latencyP95Ms: number;
  composite: number; pareto: boolean; dominatedBy: string[]; flakiness: number;
}

export interface BenchmarkLeaderboard {
  weights: BenchmarkWeights;
  qualityMetric: "score" | "passRate";
  entries: BenchmarkLeaderboardEntry[];
  paretoFront: string[];
  notes: string[];
}

export type BenchmarkCellStatus = "passed" | "failed" | "mixed" | "errored" | "skipped" | "missing";

export interface BenchmarkMatrixCell {
  variantId: string; attempts: number; passed: number; passRate: number; score?: number; costUsd: number; durationMs: number; status: BenchmarkCellStatus;
  results: Array<{ runId: string; owner: string; key: string; repetition: number; status: string }>;
}

export interface BenchmarkMatrixRow {
  key: string; owner: string; suiteId: string; suiteName: string; caseId: string; caseName: string; caseKey: string; row?: number;
  cells: Record<string, BenchmarkMatrixCell>;
  spread: boolean;
}

export interface BenchmarkMatrix { variants: Array<{ id: string; label: string }>; rows: BenchmarkMatrixRow[] }

/** GET /benchmark-runs/{id}: the run, per-variant stats, the leaderboard, the matrix. */
export interface BenchmarkReport { run: BenchmarkRun; stats: BenchmarkVariantStats[]; leaderboard: BenchmarkLeaderboard; matrix: BenchmarkMatrix }

export interface DiffSegment { op: "same" | "add" | "del"; text: string }

export interface BenchmarkCompareColumn {
  variantId: string; label: string; runId: string; owner: string; repetition: number; key: string;
  status: string; score?: number; costUsd: number; durationMs: number; tokens: { input: number; output: number };
  finalText: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; isError: boolean; mocked: string | false; diff: "same" | "changed" | "added"; argChanges?: string[] }>;
  missingCalls: string[];
  textDiff?: DiffSegment[];
  sameAsReference: { tools: boolean; text: boolean };
  result: SuiteCaseResult;
}

export interface BenchmarkCaseComparison { key: string; caseName: string; reference: string; columns: BenchmarkCompareColumn[] }

/** benchmark:progress (SSE). */
export interface BenchmarkProgressEvent {
  benchmarkRunId: string; benchmarkId?: string; name: string; status: BenchmarkRunStatus; stopReason?: "budget" | "cancelled" | "error";
  progress: BenchmarkRun["progress"]; spentUsd: number; budgetUsd?: number; timestamp: string;
}

export interface PlaygroundMocks {
  suite?: { agent: string; suite: string; caseId?: string };
  tools?: ToolMock[];
  model?: { turns: ScriptedTurn[]; onExhausted?: "stop" | "error" };
}

export interface PlaygroundPane {
  id: string;
  label?: string;
  variant: { agent: string; version: string; overrides?: SuiteVariantOverrides };
  /** Answer tool calls with the mocks (default true). */
  mockTools: boolean;
  /** Script the model from mocks.model (offline). */
  mockModel: boolean;
  /** Calls no mock answers run for real (admins, after a confirmation); off: blocked. */
  realTools: boolean;
  mocks?: PlaygroundMocks;
}

export type PlaygroundPaneInput = Partial<Omit<PlaygroundPane, "variant">> & { variant: { agent: string; version?: string; overrides?: SuiteVariantOverrides } };

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
  exchanges: Record<string, PlaygroundExchange[]>;
  createdAt: string;
  updatedAt: string;
  actor?: string;
}

/** What a pane streams while it answers (POST …/send with stream). */
export type PlaygroundStreamEvent =
  | { type: "start"; paneId: string; mode: string }
  | { type: "text"; paneId: string; delta: string }
  | { type: "turn"; paneId: string; turn: SuiteTraceTurn }
  | { type: "tool"; paneId: string; call: SuiteTraceToolCall }
  | { type: "done"; paneId: string; exchange: PlaygroundExchange };
