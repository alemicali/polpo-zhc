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

/** later (phase 2): scores 0..1 with thresholds. */
export type SuiteScorer = { id?: string; label?: string; threshold?: number; weight?: number } & (
  | { type: "exact"; expected: string; caseSensitive?: boolean }
  | { type: "numeric"; expected: number | string; tolerance?: number; extract?: string }
  | { type: "similarity"; expected: string }
  | { type: "llm_judge"; rubric: string; model?: string }
  | { type: "custom"; code: string }
);

export interface SuiteBudgets { maxTurns?: number; maxCostUsd?: number; maxDurationMs?: number }

export interface SuiteCase {
  id: string;
  name: string;
  description?: string;
  input: SuiteCaseInput;
  mode?: SuiteMockMode;
  mocks?: SuiteMocks;
  assertions: SuiteAssertion[];
  /** later (phase 2) */
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
  /** later (phase 3) */
  gate?: { required?: boolean; minPassRate?: number; maxRegression?: number; scoreThresholds?: Record<string, number> };
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
  trigger?: "manual" | "publish" | "schedule" | "ci" | "benchmark";
  wait?: boolean;
  /** Confirm a run that uses real tools (side effects possible; approvals never given). */
  allowRealTools?: boolean;
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
  /** later (phase 2) */
  scores?: Array<{ scorer: SuiteScorer; score: number; passed: boolean; reason?: string }>;
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
  trigger: "manual" | "publish" | "schedule" | "ci" | "benchmark";
  status: SuiteRunStatus;
  startedAt: string;
  finishedAt?: string;
  actor?: string;
  planned: string[];
  /** In lists, results come without trace and assertions (with `failed`: the failed assertions' descriptions). */
  results: Array<SuiteCaseResult & { failed?: string[] }>;
  stats: SuiteRunStats;
  /** later (phase 2) */
  baseline?: { runId: string; passRateDelta?: number; costDelta?: number };
  /** later (phase 3) */
  gate?: { decision: "pass" | "fail" | "override"; reason?: string; by?: string };
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
