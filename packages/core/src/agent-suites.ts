/**
 * Agent suites: one engine for agentic tests, evals and (later) deploy gates and benchmarks.
 *
 *   Suite     an agent's named collection of cases (+ datasets, shared mocks, default mock mode)
 *   Case      an input (a chat message or a task description, with optional context and earlier
 *             turns), a mock mode, mocks and checks (assertions now, scorers from phase 2)
 *   Dataset   rows of inputs and expected values, templated into a case ({{row.product_id}})
 *   Run       a suite executed against an agent version (production, draft, 1.2.0) as a
 *             "variant" (agent + version + per-run overrides), with per-case traces and stats
 *
 * Mock modes: `none` (real model, real tools), `tools` (real model, tool mocks), `model` (scripted
 * model turns, real tools), `all` (both: offline and deterministic, the "contract" mode).
 *
 * Phase 1 builds suites, cases, datasets, mocks, runs, assertions and reports. Fields reserved for
 * later phases are part of the model already (so they need no migration):
 *   phase 2  scorers (exact, numeric, similarity, LLM judge, custom), baselines
 *   phase 3  gates (required suites, thresholds, max regression vs production, override)
 *   phase 4  cassettes (record/replay), simulated users, AI-generated datasets
 *   phase 5  benchmarks (variants with overrides × repetitions, comparison matrix), playground
 *            (a recorded chat exchange becomes a case: {@link caseFromTrace})
 *
 * Everything here is pure (no I/O): the server runs cases (src/server/agent-suites.ts), every
 * surface shares these shapes (REST, MCP, Polpo's chat, the SDK, the dashboard).
 */
import { unifiedLineDiff } from "./agent-versions.js";
import type { SuiteBaselineComparison, SuiteRunAggregates, SuiteRunReview } from "./agent-suite-evals.js";
import { DEPLOY_GATE_LIMITS, type AgentDeployGate } from "./agent-suite-gates.js";
import type { SuiteCassetteRecord } from "./agent-suite-replay.js";
// types only: harnesses.js imports computers.js, which must not load before sandbox.js (an import cycle)
import type { AgentHarnessEngine } from "./harnesses.js";
import type { AgentCliEngine } from "./cli-engine.js";

// ── Modes ────────────────────────────────────────────────────────────

export type SuiteMockMode = "none" | "tools" | "model" | "all";
export const SUITE_MOCK_MODES: readonly SuiteMockMode[] = ["none", "tools", "model", "all"];

export const SUITE_MOCK_MODE_LABELS: Record<SuiteMockMode, string> = {
  none: "Live (real model, real tools)",
  tools: "Mock tools (real model)",
  model: "Mock model (real tools)",
  all: "Contract (model and tools mocked, offline)",
};

/** Does this mode script the model? */
export function modeMocksModel(mode: SuiteMockMode): boolean { return mode === "model" || mode === "all"; }
/** Does this mode intercept tools? */
export function modeMocksTools(mode: SuiteMockMode): boolean { return mode === "tools" || mode === "all"; }

// ── Mocks ────────────────────────────────────────────────────────────

/** How arguments are compared: exact (deep equal), partial (the listed keys, deep), regex (string values are patterns), schema (a JSON Schema). */
export type ArgsMatchMode = "exact" | "partial" | "regex" | "schema";
export const ARGS_MATCH_MODES: readonly ArgsMatchMode[] = ["exact", "partial", "regex", "schema"];

export interface ToolMockWhen {
  /** The arguments the call must have (compared with `match`, partial by default). Templated ({{row.x}}). */
  args?: unknown;
  match?: ArgsMatchMode;
  /** Only the n-th call (1-based) of this tool in the case. */
  call?: number;
}

/**
 * A tool mock: intercepts a tool call before it runs (no side effect). `tool` is a tool name or a
 * glob (`mcp__printful__*`, `email_*`); the first mock that matches (case mocks before the suite's)
 * answers. Native tools, Polpo's host tools, connector / MCP tools and hosted MCP server tools alike.
 */
export interface ToolMock {
  id?: string;
  tool: string;
  when?: ToolMockWhen;
  /** The result the model sees: a string as is, anything else as JSON. Templated ({{row.x}}, {{args.x}}). */
  response?: unknown;
  /** The call fails with this message (the model sees "Error: …"). */
  error?: string;
  /** Wait before answering (timeouts, slow APIs), max 60 s. */
  delayMs?: number;
  /** Answer at most this many calls, then the next matching mock (or the unmocked policy). */
  times?: number;
  description?: string;
}

export interface ScriptedToolCall {
  name: string;
  /** The exact arguments (templated). */
  args?: Record<string, unknown>;
  id?: string;
}

/** One scripted model turn: text and/or tool calls. */
export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: ScriptedToolCall[];
  /** Reported usage (cost budgets can be tested offline). */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** A model mock: each model call takes the next turn. */
export interface ModelMock {
  turns: ScriptedTurn[];
  /** After the last turn: "stop" (an empty final answer, default) or "error" (the case errors). */
  onExhausted?: "stop" | "error";
}

/** How a replayed tool call is matched with a recorded one (see `matchCassetteCall`). */
export type CassetteMatch = "exact" | "partial" | "tool" | "sequence";
export const CASSETTE_MATCHES: readonly CassetteMatch[] = ["exact", "partial", "tool", "sequence"];

/**
 * Phase 4 — a cassette: a recorded exchange (every model turn and tool call of a real run, secrets
 * redacted) replayed instead of the model and the tools. The recording itself is kept apart
 * (`.polpo/agent-suites/<agent>/cassettes/<id>.json`); a case points at it.
 */
export interface SuiteCassette {
  id: string;
  /** replay (default). A recording is made with a run's `record: true` (or the Record button). */
  mode?: "record" | "replay";
  /**
   * How a tool call finds its recorded answer: exact arguments (default), partial (the recorded
   * arguments are a subset of the call's), tool (the next unused recording of that tool) or
   * sequence (the n-th call of the case must be the n-th recorded one).
   */
  match?: CassetteMatch;
  /** A call no recording answers: blocked (an error result, default) or the case fails. */
  onUnmatched?: "block" | "fail";
  /** Replay the recorded model turns when the mode scripts the model (default true). */
  model?: boolean;
}

/** When a simulated conversation stops (besides maxTurns): the simulator says the goal is reached, a scorer passes, or only at maxTurns. */
export type SimulatedUserStop = "goal" | "scorer" | "max_turns";

/**
 * Phase 4 — a simulated user: a model plays the user of a multi-turn case from a persona, a goal and
 * constraints (or a scripted list of user turns). The case's message is the first user turn.
 */
export interface SimulatedUser {
  /** Who the user is (tone, knowledge, situation). */
  persona?: string;
  /** What the user wants to get done. */
  goal?: string;
  /** Rules the user follows ("never gives the order number", "answers in Italian"). */
  constraints?: string[];
  /** User turns after the first (1–20, default 5). */
  maxTurns?: number;
  /** goal (default): stop when the simulator says the goal is reached; scorer: when `stopScorer` passes; max_turns: run every turn. */
  stop?: SimulatedUserStop;
  /** stop: scorer — the id of one of the case's scorers (checked after each agent reply). */
  stopScorer?: string;
  /** Who plays this case's user (default the suite's simulator, else Polpo): an agent, or a model + engine block. */
  simulator?: SuiteRole;
  /** @deprecated read as `simulator: { model }` (kept for suites saved before roles). */
  model?: string;
  /** Scripted user: these turns, in order, after the case's message (no simulator call). */
  script?: string[];
}

/**
 * Phase 4 — an HTTP mock for hosted MCP server suites: answers an upstream request a server's tool
 * makes (matched by method and URL: a glob, or a substring) instead of the network.
 */
export interface HttpMock {
  id?: string;
  /** GET, POST… (default any). */
  method?: string;
  /** A glob (`https://api.example.com/v1/orders*`) or a substring of the request URL. */
  url: string;
  /** Default 200. */
  status?: number;
  /** The response body: a string as is, anything else as JSON. Templated ({{row.x}}). */
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer at most this many requests. */
  times?: number;
}

/** What a tool call no mock matches does in a tool-mocking mode: blocked (an error result, default) or run for real (`tools` mode only). */
export type UnmockedToolPolicy = "block" | "real";

export interface SuiteMocks {
  tools?: ToolMock[];
  model?: ModelMock;
  unmockedTools?: UnmockedToolPolicy;
  /** A recorded exchange replayed (phase 4). */
  cassette?: SuiteCassette;
  /** A simulated (or scripted) user for a multi-turn case (phase 4). */
  simulatedUser?: SimulatedUser;
  /** Missions: mocks per agent (by name), merged over the shared ones for that agent's tasks. */
  agents?: Record<string, SuiteMocks>;
  /** Hosted MCP servers: the upstream API's answers. */
  http?: HttpMock[];
  /** Hosted MCP servers: a request no HTTP mock matches is blocked (default) or sent for real (admins). */
  unmockedHttp?: UnmockedToolPolicy;
}

/**
 * Tools answered with a harmless stub when tools are mocked and no mock matches (they only record
 * what the agent did: the assertions read their arguments from the trace).
 */
export const SUITE_STUBBED_TOOLS: Record<string, string> = {
  register_outcome: "Outcome registered (test run: nothing was saved).",
  artifact_create: "Artifact created (test run: nothing was saved).",
  artifact_update: "Artifact updated (test run: nothing was saved).",
};

// ── Input ────────────────────────────────────────────────────────────

export interface CaseContextFile { path: string; content: string }
export interface CaseAttachment { name: string; content: string; mimeType?: string }

export type CaseInputKind = "chat" | "task" | "tool" | "mission";

export interface CaseInput {
  /**
   * chat: a message to the agent; task: a task description (run as an agent turn with the task
   * framing); tool: a hosted MCP server's tool called with `args`; mission: the target mission run
   * in test mode (the message, when given, is added to every task as context).
   */
  kind: CaseInputKind;
  /** The message or the task description (tool: unused). Templated ({{row.x}}). */
  message: string;
  /** tool: the hosted server's tool to call. */
  tool?: string;
  /** tool: its arguments (templated). */
  args?: Record<string, unknown>;
  /** Earlier turns of the conversation (a recorded exchange). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  context?: {
    /** Extra instructions for this case (added to the system prompt). */
    system?: string;
    /** Memory the agent has for this case (added as context, the agent's real memory is untouched). */
    memory?: string;
    /** Files given as context (inlined; never written to the workspace). */
    files?: CaseContextFile[];
    /** Attachments (text) given with the message. */
    attachments?: CaseAttachment[];
  };
}

// ── Checks ───────────────────────────────────────────────────────────

interface AssertionBase {
  id?: string;
  /** Shown in reports instead of the generated description. */
  label?: string;
}

export type SuiteAssertion = AssertionBase & (
  /** Called (at least once, or exactly `times`, or between `min` and `max`), optionally with these arguments (missions: by `agent`). */
  | { type: "tool_called"; tool: string; times?: number; min?: number; max?: number; args?: unknown; match?: ArgsMatchMode; agent?: string }
  /** Never called (with these arguments, when given; missions: by `agent`). */
  | { type: "tool_not_called"; tool: string; args?: unknown; match?: ArgsMatchMode; agent?: string }
  /** These tools were called in this order (a subsequence; strict: one right after the other). */
  | { type: "tool_order"; tools: string[]; strict?: boolean }
  /** The arguments of the tool's calls (which: any (default), all, first, last; missions: by `agent`). */
  | { type: "tool_args"; tool: string; value: unknown; match?: ArgsMatchMode; which?: "any" | "all" | "first" | "last"; agent?: string }
  /** A call (of this tool, when given) failed: hosted server cases that expect an error. */
  | { type: "tool_failed"; tool?: string; contains?: string }
  /** Hosted MCP servers: the tool sent an upstream request (method, URL glob or substring), `times` when given. */
  | { type: "http_called"; url: string; method?: string; times?: number }
  /** Missions: the task (by title) ended with this status (done, failed, skipped). */
  | { type: "task_status"; task: string; status: "done" | "failed" | "skipped" }
  /** Missions: these tasks ran in this order (titles). */
  | { type: "task_order"; tasks: string[] }
  /** Missions: the task was done by this agent. */
  | { type: "task_agent"; task: string; agent: string }
  /** No tool call failed. */
  | { type: "no_tool_errors" }
  /** register_outcome was called (with this label / type, a value containing this text). */
  | { type: "outcome_registered"; label?: string; outcomeType?: string; valueContains?: string }
  /** An artifact was created (artifact_create; of this kind, a title containing this text). */
  | { type: "artifact_created"; kind?: string; titleContains?: string }
  /** A person's approval was requested (a gated send, ask_user, a hosted tool queued for approval), optionally for this tool. */
  | { type: "approval_requested"; tool?: string }
  /** The final text contains every value (case-insensitive unless caseSensitive). */
  | { type: "text_contains"; value: string | string[]; caseSensitive?: boolean }
  | { type: "text_not_contains"; value: string | string[]; caseSensitive?: boolean }
  | { type: "text_regex"; pattern: string; flags?: string }
  /** Budgets checked after the run (the case's own budgets also stop the run). */
  | { type: "max_turns"; value: number }
  | { type: "max_cost"; usd: number }
  | { type: "max_duration"; ms: number }
);
export type SuiteAssertionType = SuiteAssertion["type"];
export const SUITE_ASSERTION_TYPES: readonly SuiteAssertionType[] = [
  "tool_called", "tool_not_called", "tool_order", "tool_args", "no_tool_errors", "outcome_registered", "artifact_created",
  "approval_requested", "text_contains", "text_not_contains", "text_regex", "max_turns", "max_cost", "max_duration",
  "tool_failed", "http_called", "task_status", "task_order", "task_agent",
];

/**
 * What a scorer reads: the final reply (default), the reply parsed as JSON, a tool call's arguments
 * or result, or the arguments of a registered outcome — optionally narrowed by a `path`
 * (`recipient.country_code`, `items[0].quantity`, `$.rate`).
 */
export type ScorerSource = "reply" | "reply_json" | "tool_args" | "tool_result" | "outcome";
export const SCORER_SOURCES: readonly ScorerSource[] = ["reply", "reply_json", "tool_args", "tool_result", "outcome"];

/** One criterion of an LLM judge (G-Eval style): scored 1–5 by the judge, weighted. */
export interface JudgeCriterion {
  name: string;
  description: string;
  /** Relative weight (default 1). */
  weight?: number;
}

interface ScorerBase {
  /** Stable id: aggregates, baselines and (phase 3) gate thresholds refer to it. Made from the type when missing. */
  id?: string;
  label?: string;
  /** Pass when the score is at least this (0..1; default: 1 for the deterministic scorers, 0.8 similarity, 0.6 llm_judge). */
  threshold?: number;
  /** Weight in the case's overall score (default 1). */
  weight?: number;
  /** What the scorer reads (default reply); exact, numeric, contains_*, regex, similarity, json_schema. */
  from?: ScorerSource;
  /** tool_args / tool_result: the tool (name or glob). */
  tool?: string;
  /** tool_args / tool_result / outcome: which call (default last). */
  which?: "first" | "last";
  /** A path into the value read (dots and [n]; a leading $. is allowed). */
  path?: string;
}

/**
 * Phase 2 — a scorer: a score 0..1, pass / fail against a threshold, an explanation. A case with
 * scorers is an eval; `expected` values may come from the dataset (`{{row.expected}}`).
 */
export type SuiteScorer = ScorerBase & (
  /** The value equals `expected` (text trimmed, case-insensitive unless caseSensitive; objects deeply). */
  | { type: "exact"; expected: unknown; caseSensitive?: boolean }
  /** A number (the value, or the first number in the text, or `extract`'s first group) within `tolerance` of `expected` (absolute, or a fraction with relative). */
  | { type: "numeric"; expected: number | string; tolerance?: number; relative?: boolean; extract?: string }
  /** contains_all: the share of `values` found; contains_any: 1 when any is found. */
  | { type: "contains_all"; values: string[]; caseSensitive?: boolean }
  | { type: "contains_any"; values: string[]; caseSensitive?: boolean }
  | { type: "regex"; pattern: string; flags?: string }
  /** Normalized string similarity (lowercase, punctuation and spaces folded): levenshtein (default) or tokens (Dice of words). */
  | { type: "similarity"; expected: string; method?: "levenshtein" | "tokens" }
  /** The value (reply_json by default) is valid against a JSON Schema. */
  | { type: "json_schema"; schema: Record<string, unknown> }
  /** The tools called match `expected` (names or globs), with partial credit: exact sequence, in order (extra calls allowed), or any order. */
  | { type: "tool_trajectory"; expected: string[]; order?: "exact" | "in_order" | "any" }
  /** 1 within the target, then target / actual. */
  | { type: "cost"; maxUsd: number }
  | { type: "latency"; maxMs: number }
  /** An LLM judge (G-Eval): the rubric and weighted criteria scored 1–5 with reasoning; `expected` is an optional reference answer. */
  | { type: "llm_judge"; rubric: string; criteria?: JudgeCriterion[]; expected?: string; judge?: SuiteRole; /** @deprecated read as `judge: { model }`. */ model?: string }
  /** A JS function body run in the sandboxed code worker: receives { reply, toolCalls, trace, row, input, expected } and returns a number 0..1, a boolean, or { score, reason }. */
  | { type: "custom"; code: string; expected?: unknown; timeoutMs?: number }
);
export type SuiteScorerType = SuiteScorer["type"];
export const SUITE_SCORER_TYPES: readonly SuiteScorerType[] = [
  "exact", "numeric", "contains_all", "contains_any", "regex", "similarity", "json_schema", "tool_trajectory", "cost", "latency", "llm_judge", "custom",
];

// ── Roles ────────────────────────────────────────────────────────────

/** The LLM roles of a suite: the judge of llm_judge scorers, the simulated user, the case generator, the run reviewer. */
export type SuiteRoleName = "judge" | "simulator" | "generator" | "reviewer";
export const SUITE_ROLE_NAMES: readonly SuiteRoleName[] = ["judge", "simulator", "generator", "reviewer"];

/**
 * Who plays one of a suite's LLM roles: an existing agent by name (`judge-bot`, `judge-bot@1.2.0`,
 * `judge-bot@draft`), or the block an agent uses for its model and engine (`model`, `reasoning`,
 * `engine`: Polpo's, a harness, a CLI account), run as an ephemeral agent. Neither: Polpo itself.
 * Every role turn is a chat turn through the chat completions pipeline (the agent's or Polpo's
 * engine, provider auth, fallbacks, cost tracking), without tools; its chat is deleted afterwards.
 */
export interface SuiteRole {
  agent?: string;
  model?: string;
  reasoning?: string;
  engine?: AgentHarnessEngine | AgentCliEngine;
}

/** Eval settings of a suite (phase 2). */
export interface SuiteEvalSettings {
  /** Who judges llm_judge scorers (default Polpo); a scorer's own `judge` wins. */
  judge?: SuiteRole;
  /** Who writes "Explain this run" (default Polpo). */
  reviewer?: SuiteRole;
  /** @deprecated read as `judge: { model }` (kept for suites saved before roles). */
  judgeModel?: string;
  /** Run every case this many times (1–10): mean, stddev and a flakiness flag per case. */
  repetitions?: number;
  /** A score or pass-rate change within this (0..1, default 0.05) is not a regression or an improvement. */
  regressionTolerance?: number;
  /** A case whose attempts' scores vary more than this (stddev, default 0.1) — or that both passed and failed — is flaky. */
  flakyStddev?: number;
  /** The baseline when none is marked: the previous finished run (default), the latest run on production, or none. */
  baseline?: "previous" | "production" | "none";
}

export interface CaseBudgets {
  /** Model turns (LLM calls) before the case is stopped. */
  maxTurns?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

// ── Suite ────────────────────────────────────────────────────────────

export interface SuiteCase {
  id: string;
  name: string;
  description?: string;
  input: CaseInput;
  /** Overrides the suite's default mode. */
  mode?: SuiteMockMode;
  /** Merged over the suite's mocks (the case's tool mocks are tried first; its model mock wins). */
  mocks?: SuiteMocks;
  assertions: SuiteAssertion[];
  /** Scorers (evals): with the suite's default scorers (a case scorer with the same id replaces it). */
  scorers?: SuiteScorer[];
  /** A dataset id: the case runs once per row, with {{row.column}} templated. */
  dataset?: string;
  budgets?: CaseBudgets;
  tags?: string[];
  skip?: boolean;
  /** Where the case came from (a recorded chat exchange, the playground, an import, AI generation). */
  source?: {
    kind: "manual" | "recorded" | "imported" | "generated";
    sessionId?: string; runId?: string; taskId?: string; at?: string;
    /** generated: why the model proposed it, and what it covers (happy path, edge case, adversarial…). */
    rationale?: string; category?: string; model?: string;
  };
}

export interface SuiteDataset {
  id: string;
  name: string;
  description?: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** manual, csv / json import, generated (AI, reviewed before it was saved). */
  source?: { kind: "manual" | "csv" | "json" | "generated"; file?: string; at?: string; model?: string };
}

/**
 * What a suite tests: an agent (its suites live with it), a hosted MCP server (its saved tests are
 * its suite) or a mission (run in test mode with every agent mocked). Teams: reserved.
 */
export type SuiteTarget =
  | { kind: "agent" }
  | { kind: "mcp-server"; server: string }
  | { kind: "mission"; mission: string }
  | { kind: "team"; team: string };

/** This suite as a deploy gate of its agent (docs/agent-suites.md, "CI gate"). */
export interface SuiteGate {
  /** Must pass before a version is deployed to production. */
  required?: boolean;
  /** Minimum pass rate (0..1, default 1). */
  minPassRate?: number;
  /** Largest pass-rate (or overall score) drop allowed versus the baseline: the marked one, else the latest run on production (0..1). */
  maxRegression?: number;
  /** Minimum mean score per scorer id ("score": the run's overall score). */
  scoreThresholds?: Record<string, number>;
  /** Also run it when a version is published (non-blocking: the version shows the result before it is deployed). */
  onPublish?: boolean;
  /** The gate may run this suite's real-tools cases (modes none / model, unmocked tools run for real). Admins only. */
  allowRealTools?: boolean;
}

export interface AgentSuite {
  id: string;
  agent: string;
  name: string;
  description?: string;
  target: SuiteTarget;
  defaultMode: SuiteMockMode;
  /** Shared by every case (tool mocks after the case's own). */
  mocks?: SuiteMocks;
  cases: SuiteCase[];
  datasets: SuiteDataset[];
  /** Defaults for every case. */
  budgets?: CaseBudgets;
  /** Cases run at once (1–4, default 1). */
  concurrency?: number;
  /** Scorers every case gets (a case scorer with the same id replaces one). */
  scorers?: SuiteScorer[];
  /** Eval settings: judge model, repetitions, regression tolerance, baseline policy. */
  evals?: SuiteEvalSettings;
  /** A deploy gate: required before production, thresholds, run on publish. */
  gate?: SuiteGate;
  /** Who plays the simulated users (default Polpo): an agent, or a model + engine block. A case's own wins. */
  simulator?: SuiteRole;
  /** Who proposes cases and dataset rows for this suite (default Polpo). */
  generator?: SuiteRole;
  /** @deprecated read as `simulator: { model }` (kept for suites saved before roles). */
  simulatorModel?: string;
  tags?: string[];
  /** Bumped on every save (a save with an older revision is refused). */
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export const SUITE_LIMITS = {
  cases: 200,
  datasetRows: 1000,
  datasets: 20,
  toolMocks: 200,
  scriptedTurns: 50,
  assertions: 50,
  scorers: 20,
  maxRepetitions: 10,
  maxConcurrency: 4,
  defaultMaxTurns: 20,
  defaultMaxDurationMs: 300_000,
  maxDelayMs: 60_000,
  runsKept: 100,
} as const;

// ── Runs ─────────────────────────────────────────────────────────────

/** Per-run changes to the agent (phase 5 benchmarks compare variants; nothing is saved to the agent). */
export interface SuiteVariantOverrides {
  model?: string;
  reasoning?: string;
  /** The engine (Polpo's, a harness, a CLI account), as agent.engine. */
  engine?: unknown;
  /** Replaces the agent's instructions (systemPrompt). */
  instructions?: string;
  /** Appended to the agent's instructions. */
  instructionsAppend?: string;
  allowedTools?: string[];
  maxTurns?: number;
}

/** What a run ran against: the agent at a version, with per-run overrides. */
export interface SuiteVariant {
  id: string;
  label?: string;
  agent: string;
  /** production, draft or a published version. */
  version: string;
  overrides?: SuiteVariantOverrides;
}

export type SuiteRunTrigger = "manual" | "publish" | "deploy" | "schedule" | "ci" | "benchmark" | "record";

export interface SuiteRunRequest {
  /** production (default), draft, or a published version (1.2.0). */
  target?: string;
  /** Only these cases (ids). */
  caseIds?: string[];
  /** Every case in this mode (default: each case's own). */
  mode?: SuiteMockMode;
  concurrency?: number;
  /** Per-run overrides (the variant): applied to this run only. */
  overrides?: SuiteVariantOverrides;
  /** The variant's id and label; `agent`: run the suite's cases against another agent (benchmarks compare agents). */
  variant?: { id?: string; label?: string; agent?: string };
  /** Phase 5: the benchmark this run belongs to. */
  benchmarkRunId?: string;
  repetition?: number;
  trigger?: SuiteRunTrigger;
  /** Wait for the run to finish (default: return it running). */
  wait?: boolean;
  /** Run every case this many times (1–10; default the suite's evals.repetitions, 1). */
  repetitions?: number;
  /** Compare with this run instead of the suite's baseline. */
  baselineRunId?: string;
  /** Overrides the suite's evals.regressionTolerance for this run's comparison. */
  regressionTolerance?: number;
  /**
   * Record: run the cases live (real model, real tools: admins, after a confirmation) and save each
   * one's exchange as its cassette (secrets redacted); the case then replays it.
   */
  record?: boolean;
}

export type SuiteRunStatus = "queued" | "running" | "passed" | "failed" | "errored" | "cancelled";
export type SuiteCaseStatus = "passed" | "failed" | "errored" | "skipped";
export type SuiteEngine = "native" | "harness" | "cli";

export interface SuiteAssertionResult {
  assertion: SuiteAssertion;
  /** What was checked, in words. */
  description: string;
  passed: boolean;
  /** Why it failed (or what was seen). */
  message: string;
  expected?: unknown;
  actual?: unknown;
  /** A unified diff of expected and actual (arguments, text). */
  diff?: string;
}

/** A scorer's result on one case: the score 0..1, pass / fail against the threshold, why. */
export interface SuiteScoreResult {
  scorer: SuiteScorer;
  /** The scorer's id (given, or made from its type: exact, numeric-2…). */
  id: string;
  /** What was scored, in words. */
  description: string;
  score: number;
  threshold: number;
  weight: number;
  passed: boolean;
  /** Why: what was compared, the judge's summary… */
  reason?: string;
  expected?: unknown;
  actual?: unknown;
  /** The scorer could not run (no judge model, the sandbox is missing, bad code): the case errors. */
  error?: string;
  /** LLM judge: per-criterion scores (1–5) with reasoning, the model, the judge's cost. */
  judge?: { model?: string; criteria: Array<{ name: string; weight: number; score: number; reasoning: string }>; summary?: string; costUsd?: number };
}

export interface SuiteTraceTurn {
  index: number;
  text: string;
  thinking?: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** A scripted turn (model mock, or a cassette's recorded turn). */
  mocked: boolean;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  error?: string;
  /** Missions: the agent whose turn it was. */
  agent?: string;
}

/** mock: a tool mock answered; cassette: a recorded answer; stub: a harmless stub (register_outcome…); blocked: no mock, not run; false: ran for real. */
export type SuiteToolCallMocked = "mock" | "cassette" | "stub" | "blocked" | false;

export interface SuiteTraceToolCall {
  id: string;
  /** The model turn that asked for it. */
  turn: number;
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  mocked: SuiteToolCallMocked;
  mockId?: string;
  durationMs: number;
  /** interactive: the chat stopped for a person (a gated send, ask_user); queued: a hosted tool waits in Approvals. */
  approval?: "interactive" | "queued";
  /** Missions: the agent that called it. */
  agent?: string;
}

/** One message of a multi-turn case (simulated or scripted user). */
export interface SuiteTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  /** user: written by the simulator (false: the case's first message or a scripted turn). */
  simulated?: boolean;
  /** The simulator's reasoning for this turn, or why it stopped. */
  note?: string;
}

/** Missions: one task of the mission run in test mode. */
export interface SuiteTraceTask {
  title: string;
  agent: string;
  status: "done" | "failed" | "skipped";
  /** The agent's final reply for the task. */
  text: string;
  toolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

/** Hosted MCP servers: one upstream request a tool made. */
export interface SuiteTraceHttp {
  method: string;
  url: string;
  status: number;
  /** mock: an HTTP mock answered (its id); blocked: no mock, not sent; false: sent for real. */
  mocked: "mock" | "blocked" | false;
  mockId?: string;
  /** The request body (secrets redacted), shortened. */
  body?: string;
}

export interface SuiteTrace {
  /** The messages sent (history + the case's message, with its context). */
  input: Array<{ role: string; content: string }>;
  turns: SuiteTraceTurn[];
  toolCalls: SuiteTraceToolCall[];
  /** The agent's final text. */
  text: string;
  /** stop, or why the turn stopped for a person (email_preview, whatsapp_preview, ask_user…), or budget. */
  finishReason?: string;
  approvals: Array<{ tool: string; kind: "interactive" | "queued"; detail?: string }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  /** What the runner noticed (engine limits, budget stops, unmocked calls blocked…). */
  notes: string[];
  /** Multi-turn cases (simulated or scripted user): the whole conversation. `text` then holds every agent reply. */
  transcript?: SuiteTranscriptMessage[];
  /** The reply of the last turn (multi-turn cases). */
  finalText?: string;
  /** The simulated user's model calls (not counted in the agent's cost), and why the conversation stopped. */
  simulator?: { model?: string; calls: number; costUsd: number; stoppedBy: "goal" | "scorer" | "max_turns" | "script" | "agent" | "budget" | "error"; goalReached?: boolean };
  /** Missions: each task, in the order it ran. */
  tasks?: SuiteTraceTask[];
  /** Hosted MCP servers: the upstream requests. */
  http?: SuiteTraceHttp[];
  /** A replayed cassette: what it answered and what it could not. */
  cassette?: { id: string; replayedCalls: number; replayedTurns: number; unmatched: string[] };
  /** A recorded run: the cassette saved from this case. */
  recorded?: { cassetteId: string; calls: number; turns: number; redactions: number };
}

export interface SuiteCaseResult {
  /** caseId, or caseId#row for a dataset row. */
  key: string;
  caseId: string;
  caseName: string;
  row?: { index: number; values: Record<string, unknown> };
  status: SuiteCaseStatus;
  mode: SuiteMockMode;
  engine: SuiteEngine;
  assertions: SuiteAssertionResult[];
  /** The scorers' results (evals). */
  scores?: SuiteScoreResult[];
  /** The case's overall score: the weighted mean of its scores (0..1). */
  score?: number;
  /** With repetitions: which attempt (1-based); the key ends with ~attempt. */
  attempt?: number;
  trace: SuiteTrace;
  error?: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  /** Phase 5: the variant (benchmark matrix column). */
  variantId: string;
}

export interface SuiteRunStats {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  /** passed / (total − skipped), 0..1. */
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
  /** production, draft or a version. */
  target: string;
  /** The version tested (production's or the given one); undefined for the draft. */
  version?: string;
  variant: SuiteVariant;
  /** Phase 5: the benchmark this run belongs to. */
  benchmarkRunId?: string;
  repetition?: number;
  trigger: SuiteRunTrigger;
  status: SuiteRunStatus;
  startedAt: string;
  finishedAt?: string;
  actor?: string;
  /** The cases (in order) this run executes: their keys. */
  planned: string[];
  results: SuiteCaseResult[];
  stats: SuiteRunStats;
  /** Scores per scorer, the overall score, repetitions and flaky cases (evals). */
  aggregates?: SuiteRunAggregates;
  /** Attempts per case (repetitions). */
  repetitions?: number;
  /** The comparison with the baseline run: deltas per case and per scorer, regressions and improvements. */
  baseline?: SuiteBaselineComparison;
  /** This run is the suite's marked baseline (kept when older runs are dropped). */
  isBaseline?: boolean;
  /** An AI review of the run ("explain this run"): what failed or regressed and what to change. */
  review?: SuiteRunReview;
  /** A gate run (trigger deploy / publish): the gate's decision and the deploy gate it belongs to. */
  gate?: { decision: "pass" | "fail" | "override"; reason?: string; by?: string; gateId?: string };
  /** What the suite tests (default agent); `agent` then holds the owner key (`mcp-server:<id>`, `mission:<id>`). */
  targetKind?: SuiteTarget["kind"];
  /** A recording run: each case's exchange was saved as its cassette. */
  record?: boolean;
  notes: string[];
  error?: string;
}

/** A run without traces (lists). */
export type SuiteRunSummary = Omit<SuiteRun, "results"> & { results: Array<Omit<SuiteCaseResult, "trace" | "assertions"> & { failed: string[] }> };

export function summarizeSuiteRun(run: SuiteRun): SuiteRunSummary {
  return {
    ...run,
    results: run.results.map(({ trace: _t, assertions, scores, ...r }) => ({
      ...r,
      // the judge's per-criterion reasoning stays in the full run
      ...(scores ? { scores: scores.map(({ judge: _j, ...x }) => x) } : {}),
      failed: [...assertions.filter((a) => !a.passed).map((a) => a.description), ...(scores ?? []).filter((x) => !x.passed).map((x) => `${x.description}: ${x.score.toFixed(2)} < ${x.threshold}`)],
    })),
  };
}

export function suiteRunStats(results: SuiteCaseResult[]): SuiteRunStats {
  const s: SuiteRunStats = { total: results.length, passed: 0, failed: 0, errored: 0, skipped: 0, passRate: 0, costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 };
  for (const r of results) {
    s[r.status] += 1;
    s.costUsd += r.costUsd;
    s.durationMs += r.durationMs;
    s.inputTokens += r.trace.usage.inputTokens;
    s.outputTokens += r.trace.usage.outputTokens;
    s.turns += r.trace.turns.length;
    s.toolCalls += r.trace.toolCalls.length;
  }
  const counted = s.total - s.skipped;
  s.passRate = counted > 0 ? s.passed / counted : 0;
  s.costUsd = Math.round(s.costUsd * 1e6) / 1e6;
  return s;
}

/** The run's status from its results: errored if any errored, failed if any failed, else passed. */
export function suiteRunStatus(results: SuiteCaseResult[]): SuiteRunStatus {
  if (results.some((r) => r.status === "errored")) return "errored";
  if (results.some((r) => r.status === "failed")) return "failed";
  return "passed";
}

// ── Store ────────────────────────────────────────────────────────────

export interface SuiteRunListOptions {
  suiteId?: string;
  benchmarkRunId?: string;
  /** Leave out the runs of benchmarks (a suite's own history: baselines, trends, its last run). */
  excludeBenchmarks?: boolean;
  limit?: number;
}

/** Does a run match the list options? */
export function suiteRunMatches(r: Pick<SuiteRun, "suiteId" | "benchmarkRunId">, opts: SuiteRunListOptions): boolean {
  return (!opts.suiteId || r.suiteId === opts.suiteId) && (!opts.benchmarkRunId || r.benchmarkRunId === opts.benchmarkRunId) && (!opts.excludeBenchmarks || !r.benchmarkRunId);
}

/**
 * The runs a store keeps: the newest {@link SUITE_LIMITS.runsKept} of the suite's own, the newest
 * benchmark runs apart (so a benchmark does not push the history out), marked baselines and runs
 * still going. Newest first in, the ids to drop out.
 */
export function suiteRunsToDrop(runs: Array<Pick<SuiteRun, "id" | "status" | "isBaseline" | "benchmarkRunId">>, keptBenchmarkRuns = 300): string[] {
  let own = 0, bench = 0;
  const drop: string[] = [];
  for (const r of runs) {
    const n = r.benchmarkRunId ? ++bench : ++own;
    const limit = r.benchmarkRunId ? keptBenchmarkRuns : SUITE_LIMITS.runsKept;
    if (n > limit && r.status !== "running" && r.status !== "queued" && !r.isBaseline) drop.push(r.id);
  }
  return drop;
}

/** Where suites and their runs are kept (files under .polpo/agent-suites/<agent>/, a database…). */
export interface AgentSuiteStore {
  listSuites(agent: string): Promise<AgentSuite[]>;
  getSuite(agent: string, id: string): Promise<AgentSuite | undefined>;
  saveSuite(suite: AgentSuite): Promise<void>;
  deleteSuite(agent: string, id: string): Promise<boolean>;
  /** Newest first. */
  listRuns(agent: string, opts?: SuiteRunListOptions): Promise<SuiteRun[]>;
  getRun(agent: string, id: string): Promise<SuiteRun | undefined>;
  saveRun(run: SuiteRun): Promise<void>;
  /** Deploy gates (the suites run before a version reaches production), newest first. */
  listGates(agent: string, opts?: { version?: string; limit?: number }): Promise<AgentDeployGate[]>;
  getGate(agent: string, id: string): Promise<AgentDeployGate | undefined>;
  saveGate(gate: AgentDeployGate): Promise<void>;
  /** Cassettes (recorded exchanges replayed by cases), by id. */
  listCassettes(agent: string): Promise<SuiteCassetteRecord[]>;
  getCassette(agent: string, id: string): Promise<SuiteCassetteRecord | undefined>;
  saveCassette(cassette: SuiteCassetteRecord): Promise<void>;
  deleteCassette(agent: string, id: string): Promise<boolean>;
  deleteAgent(agent: string): Promise<void>;
}

export class InMemoryAgentSuiteStore implements AgentSuiteStore {
  private suites = new Map<string, Map<string, AgentSuite>>();
  private runs = new Map<string, SuiteRun[]>();
  private gates = new Map<string, AgentDeployGate[]>();
  private cassettes = new Map<string, Map<string, SuiteCassetteRecord>>();
  async listCassettes(agent: string) { return [...(this.cassettes.get(agent)?.values() ?? [])].map(clone); }
  async getCassette(agent: string, id: string) { const c = this.cassettes.get(agent)?.get(id); return c ? clone(c) : undefined; }
  async saveCassette(c: SuiteCassetteRecord) {
    if (!this.cassettes.has(c.agent)) this.cassettes.set(c.agent, new Map());
    this.cassettes.get(c.agent)!.set(c.id, clone(c));
  }
  async deleteCassette(agent: string, id: string) { return this.cassettes.get(agent)?.delete(id) ?? false; }
  async listSuites(agent: string) { return [...(this.suites.get(agent)?.values() ?? [])].map(clone); }
  async getSuite(agent: string, id: string) { const s = this.suites.get(agent)?.get(id); return s ? clone(s) : undefined; }
  async saveSuite(suite: AgentSuite) {
    if (!this.suites.has(suite.agent)) this.suites.set(suite.agent, new Map());
    this.suites.get(suite.agent)!.set(suite.id, clone(suite));
  }
  async deleteSuite(agent: string, id: string) { return this.suites.get(agent)?.delete(id) ?? false; }
  async listRuns(agent: string, opts: SuiteRunListOptions = {}) {
    return (this.runs.get(agent) ?? [])
      .filter((r) => suiteRunMatches(r, opts))
      .slice(0, opts.limit ?? SUITE_LIMITS.runsKept).map(clone);
  }
  async getRun(agent: string, id: string) { const r = this.runs.get(agent)?.find((x) => x.id === id); return r ? clone(r) : undefined; }
  async saveRun(run: SuiteRun) {
    const list = (this.runs.get(run.agent) ?? []).filter((r) => r.id !== run.id);
    const i = list.findIndex((r) => r.startedAt < run.startedAt);
    if (i < 0) list.push(clone(run)); else list.splice(i, 0, clone(run));
    // the newest runs (benchmark runs counted apart), and every marked baseline
    const drop = new Set(suiteRunsToDrop(list));
    this.runs.set(run.agent, list.filter((r) => !drop.has(r.id)));
  }
  async listGates(agent: string, opts: { version?: string; limit?: number } = {}) {
    return (this.gates.get(agent) ?? []).filter((g) => !opts.version || g.version === opts.version).slice(0, opts.limit ?? DEPLOY_GATE_LIMITS.kept).map(clone);
  }
  async getGate(agent: string, id: string) { const g = this.gates.get(agent)?.find((x) => x.id === id); return g ? clone(g) : undefined; }
  async saveGate(gate: AgentDeployGate) {
    const list = (this.gates.get(gate.agent) ?? []).filter((g) => g.id !== gate.id);
    list.push(clone(gate));
    list.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    this.gates.set(gate.agent, list.slice(0, DEPLOY_GATE_LIMITS.kept));
  }
  async deleteAgent(agent: string) { this.suites.delete(agent); this.runs.delete(agent); this.gates.delete(agent); this.cassettes.delete(agent); }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

// ── Validation ───────────────────────────────────────────────────────

export class AgentSuiteError extends Error {
  constructor(message: string, readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN" = "INVALID") {
    super(message);
    this.name = "AgentSuiteError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A slug from a name ("Shipping rates" → "shipping-rates"). */
export function suiteSlug(name: string, fallback = "suite"): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 48).replace(/^-+|-+$/g, "");
  return s || fallback;
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, where: string, opts: { optional?: boolean; max?: number } = {}): string | undefined => {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return undefined;
    throw new AgentSuiteError(`${where} is required`);
  }
  if (typeof v !== "string") throw new AgentSuiteError(`${where} must be a string`);
  if (opts.max && v.length > opts.max) throw new AgentSuiteError(`${where} is longer than ${opts.max} characters`);
  return v;
};
const num = (v: unknown, where: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentSuiteError(`${where} must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new AgentSuiteError(`${where} must be a whole number`);
  if (opts.min !== undefined && v < opts.min) throw new AgentSuiteError(`${where} must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new AgentSuiteError(`${where} must be at most ${opts.max}`);
  return v;
};
const mode = (v: unknown, where: string): SuiteMockMode | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!(SUITE_MOCK_MODES as readonly unknown[]).includes(v)) throw new AgentSuiteError(`${where} must be one of ${SUITE_MOCK_MODES.join(", ")}`);
  return v as SuiteMockMode;
};
const matchMode = (v: unknown, where: string): ArgsMatchMode | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!(ARGS_MATCH_MODES as readonly unknown[]).includes(v)) throw new AgentSuiteError(`${where} must be one of ${ARGS_MATCH_MODES.join(", ")}`);
  return v as ArgsMatchMode;
};
const strList = (v: unknown, where: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new AgentSuiteError(`${where} must be a list of strings`);
  return v as string[];
};
// ── Roles: parsing and reading ──

const AGENT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9.+_-]{0,63})?$/;
const ROLE_KEYS = new Set(["agent", "model", "reasoning", "engine"]);

/**
 * A role from raw input: `{ agent }` (an existing agent, optionally `@version` / `@draft`) or a
 * model + engine block `{ model?, reasoning?, engine? }`; a string is a model. The old `judgeModel`
 * / `simulatorModel` / `model` fields come in as `legacyModel` (a model block). Empty: undefined (Polpo).
 */
export function parseSuiteRole(v: unknown, where: string, legacyModel?: string): SuiteRole | undefined {
  if (v === undefined || v === null || v === "") return legacyModel ? { model: legacyModel } : undefined;
  if (typeof v === "string") return { model: str(v, where, { max: 200 })! };
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be { agent } or { model?, reasoning?, engine? }`);
  const extra = Object.keys(v).filter((k) => !ROLE_KEYS.has(k));
  if (extra.length) throw new AgentSuiteError(`${where}: unknown field(s) ${extra.join(", ")} (agent, or model, reasoning, engine)`);
  const agent = str(v.agent, `${where}.agent`, { optional: true, max: 170 })?.trim() || undefined;
  if (agent !== undefined && !AGENT_REF_RE.test(agent)) throw new AgentSuiteError(`${where}.agent must be an agent's name, optionally with @version or @draft`);
  const model = str(v.model, `${where}.model`, { optional: true, max: 200 })?.trim() || undefined;
  const reasoning = str(v.reasoning, `${where}.reasoning`, { optional: true, max: 20 })?.trim() || undefined;
  // the shape here; the engine's own fields are checked by the server (parseAgentEngine, as agent.engine)
  let engine: SuiteRole["engine"];
  const e = v.engine;
  if (e !== undefined && e !== null && e !== "" && e !== "polpo") {
    if (typeof e === "string") engine = { harness: e } as AgentHarnessEngine;
    else if (isObj(e) && (typeof e.harness === "string" || e.type === "cli")) engine = e as unknown as SuiteRole["engine"];
    else throw new AgentSuiteError(`${where}.engine must be "polpo", { harness, ... } or { type: "cli", cli, ... } (as an agent's engine)`);
  }
  if (agent && (model || reasoning || engine)) throw new AgentSuiteError(`${where}: name an agent, or give a model and engine block, not both`);
  const out = compact({ agent, model, reasoning, engine });
  return Object.keys(out).length ? out : legacyModel ? { model: legacyModel } : undefined;
}

/** Every role a suite sets (suite, cases' simulated users, judge scorers), with where it is: to check or rewrite them. */
export function suiteRoles(suite: AgentSuite): Array<{ role: SuiteRole; where: string; set: (role: SuiteRole) => void }> {
  const out: Array<{ role: SuiteRole; where: string; set: (role: SuiteRole) => void }> = [];
  const ev = suite.evals;
  if (ev?.judge) out.push({ role: ev.judge, where: "evals.judge", set: (r) => { ev.judge = r; } });
  if (ev?.reviewer) out.push({ role: ev.reviewer, where: "evals.reviewer", set: (r) => { ev.reviewer = r; } });
  if (suite.simulator) out.push({ role: suite.simulator, where: "simulator", set: (r) => { suite.simulator = r; } });
  if (suite.generator) out.push({ role: suite.generator, where: "generator", set: (r) => { suite.generator = r; } });
  const scorers = (list: SuiteScorer[] | undefined, where: string) => list?.forEach((s, i) => {
    if (s.type === "llm_judge" && s.judge) out.push({ role: s.judge, where: `${where}[${i}].judge`, set: (r) => { s.judge = r; } });
  });
  scorers(suite.scorers, "scorers");
  suite.cases.forEach((c, i) => {
    scorers(c.scorers, `cases[${i}].scorers`);
    const sim = c.mocks?.simulatedUser;
    if (sim?.simulator) out.push({ role: sim.simulator, where: `cases[${i}].mocks.simulatedUser.simulator`, set: (r) => { sim.simulator = r; } });
  });
  return out;
}

/** A suite's role (the old *Model fields read as a model block); undefined: Polpo. */
export function suiteRoleFor(suite: Partial<Pick<AgentSuite, "evals" | "simulator" | "generator" | "simulatorModel">> | undefined, role: SuiteRoleName): SuiteRole | undefined {
  if (!suite) return undefined;
  switch (role) {
    case "judge": return suite.evals?.judge ?? (suite.evals?.judgeModel ? { model: suite.evals.judgeModel } : undefined);
    case "reviewer": return suite.evals?.reviewer;
    case "simulator": return suite.simulator ?? (suite.simulatorModel ? { model: suite.simulatorModel } : undefined);
    case "generator": return suite.generator;
  }
}

/** An llm_judge scorer's own judge (its old `model` read as a model block). */
export function scorerJudgeRole(s: SuiteScorer): SuiteRole | undefined {
  if (s.type !== "llm_judge") return undefined;
  return s.judge ?? (s.model ? { model: s.model } : undefined);
}

/** A simulated user's own simulator (its old `model` read as a model block). */
export function simulatedUserRole(sim: SimulatedUser | undefined): SuiteRole | undefined {
  return sim?.simulator ?? (sim?.model ? { model: sim.model } : undefined);
}

/** Does this role run as an ephemeral agent (a model + engine block)? */
export function isRoleBlock(role: SuiteRole | undefined): boolean {
  return !!role && !role.agent && !!(role.model || role.reasoning || role.engine);
}

/** Who plays a role, in words: "Polpo", "agent judge-bot@1.2.0", "anthropic:… · Claude Code (CLI)". */
export function describeSuiteRole(role: SuiteRole | undefined): string {
  if (!role || (!role.agent && !isRoleBlock(role))) return "Polpo";
  if (role.agent) return `agent ${role.agent}`;
  const e = role.engine as { harness?: string; type?: string; cli?: string; model?: string } | undefined;
  const engine = !e ? "" : e.type === "cli" ? `${e.cli === "codex" ? "Codex" : "Claude Code"} (CLI)` : e.harness ?? "";
  const model = role.model ?? e?.model;
  return [model, engine].filter(Boolean).join(" · ") || "Polpo's engine";
}


function parseScoreThresholds(v: unknown): Record<string, number> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError("gate.scoreThresholds must be an object: { scorerId: minimum mean score }");
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) throw new AgentSuiteError(`gate.scoreThresholds.${k} must be a number from 0 to 1`);
    out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

function parseBudgets(v: unknown, where: string): CaseBudgets | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  return compact({
    maxTurns: num(v.maxTurns, `${where}.maxTurns`, { min: 1, max: 200, int: true }),
    maxCostUsd: num(v.maxCostUsd, `${where}.maxCostUsd`, { min: 0, max: 1000 }),
    maxDurationMs: num(v.maxDurationMs, `${where}.maxDurationMs`, { min: 1000, max: 3_600_000, int: true }),
  });
}

function parseToolMock(v: unknown, where: string): ToolMock {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const tool = str(v.tool, `${where}.tool`, { max: 200 })!;
  let when: ToolMockWhen | undefined;
  if (v.when !== undefined && v.when !== null) {
    if (!isObj(v.when)) throw new AgentSuiteError(`${where}.when must be an object`);
    when = compact({ args: v.when.args, match: matchMode(v.when.match, `${where}.when.match`), call: num(v.when.call, `${where}.when.call`, { min: 1, int: true }) });
    if (when.match === "regex") checkRegexes(when.args, `${where}.when.args`);
  }
  if (v.response !== undefined && v.error !== undefined) throw new AgentSuiteError(`${where}: give response or error, not both`);
  return compact({
    id: str(v.id, `${where}.id`, { optional: true, max: 64 }),
    tool,
    when,
    response: v.response,
    error: str(v.error, `${where}.error`, { optional: true, max: 4000 }),
    delayMs: num(v.delayMs, `${where}.delayMs`, { min: 0, max: SUITE_LIMITS.maxDelayMs, int: true }),
    times: num(v.times, `${where}.times`, { min: 1, int: true }),
    description: str(v.description, `${where}.description`, { optional: true, max: 500 }),
  });
}

function parseScriptedTurn(v: unknown, where: string): ScriptedTurn {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  let toolCalls: ScriptedToolCall[] | undefined;
  if (v.toolCalls !== undefined) {
    if (!Array.isArray(v.toolCalls)) throw new AgentSuiteError(`${where}.toolCalls must be a list`);
    toolCalls = v.toolCalls.map((c, i) => {
      const w = `${where}.toolCalls[${i}]`;
      if (!isObj(c)) throw new AgentSuiteError(`${w} must be an object`);
      if (c.args !== undefined && !isObj(c.args)) throw new AgentSuiteError(`${w}.args must be an object`);
      return compact({ name: str(c.name, `${w}.name`, { max: 200 })!, args: c.args as Record<string, unknown> | undefined, id: str(c.id, `${w}.id`, { optional: true, max: 64 }) });
    });
  }
  const text = str(v.text, `${where}.text`, { optional: true, max: 100_000 });
  if (text === undefined && !toolCalls?.length) throw new AgentSuiteError(`${where} needs text or toolCalls`);
  let usage: ScriptedTurn["usage"];
  if (isObj(v.usage)) usage = compact({ inputTokens: num(v.usage.inputTokens, `${where}.usage.inputTokens`, { min: 0 }), outputTokens: num(v.usage.outputTokens, `${where}.usage.outputTokens`, { min: 0 }), costUsd: num(v.usage.costUsd, `${where}.usage.costUsd`, { min: 0 }) });
  return compact({ text, thinking: str(v.thinking, `${where}.thinking`, { optional: true }), toolCalls, usage });
}

function parseMocks(v: unknown, where: string): SuiteMocks | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  let tools: ToolMock[] | undefined;
  if (v.tools !== undefined) {
    if (!Array.isArray(v.tools)) throw new AgentSuiteError(`${where}.tools must be a list`);
    if (v.tools.length > SUITE_LIMITS.toolMocks) throw new AgentSuiteError(`${where}.tools: at most ${SUITE_LIMITS.toolMocks} mocks`);
    tools = v.tools.map((t, i) => parseToolMock(t, `${where}.tools[${i}]`));
  }
  let model: ModelMock | undefined;
  if (v.model !== undefined && v.model !== null) {
    if (!isObj(v.model) || !Array.isArray(v.model.turns)) throw new AgentSuiteError(`${where}.model.turns must be a list of turns`);
    if (v.model.turns.length > SUITE_LIMITS.scriptedTurns) throw new AgentSuiteError(`${where}.model.turns: at most ${SUITE_LIMITS.scriptedTurns} turns`);
    const onExhausted = v.model.onExhausted;
    if (onExhausted !== undefined && onExhausted !== "stop" && onExhausted !== "error") throw new AgentSuiteError(`${where}.model.onExhausted must be stop or error`);
    model = compact({ turns: v.model.turns.map((t, i) => parseScriptedTurn(t, `${where}.model.turns[${i}]`)), onExhausted: onExhausted as ModelMock["onExhausted"] });
  }
  const unmocked = v.unmockedTools;
  if (unmocked !== undefined && unmocked !== "block" && unmocked !== "real") throw new AgentSuiteError(`${where}.unmockedTools must be block or real`);
  const unmockedHttp = v.unmockedHttp;
  if (unmockedHttp !== undefined && unmockedHttp !== "block" && unmockedHttp !== "real") throw new AgentSuiteError(`${where}.unmockedHttp must be block or real`);
  let agents: Record<string, SuiteMocks> | undefined;
  if (v.agents !== undefined && v.agents !== null) {
    if (!isObj(v.agents)) throw new AgentSuiteError(`${where}.agents must be an object: { agentName: mocks }`);
    agents = {};
    for (const [name, m] of Object.entries(v.agents)) {
      const parsed = parseMocks(m, `${where}.agents.${name}`);
      if (parsed?.agents) throw new AgentSuiteError(`${where}.agents.${name}: mocks per agent cannot nest`);
      if (parsed) agents[name] = parsed;
    }
  }
  let http: HttpMock[] | undefined;
  if (v.http !== undefined && v.http !== null) {
    if (!Array.isArray(v.http)) throw new AgentSuiteError(`${where}.http must be a list`);
    if (v.http.length > SUITE_LIMITS.toolMocks) throw new AgentSuiteError(`${where}.http: at most ${SUITE_LIMITS.toolMocks} mocks`);
    http = v.http.map((h, i) => parseHttpMock(h, `${where}.http[${i}]`));
  }
  return compact({
    tools, model, unmockedTools: unmocked as UnmockedToolPolicy | undefined,
    cassette: parseCassetteRef(v.cassette, `${where}.cassette`),
    simulatedUser: parseSimulatedUser(v.simulatedUser, `${where}.simulatedUser`),
    agents, http, unmockedHttp: unmockedHttp as UnmockedToolPolicy | undefined,
  });
}

function parseCassetteRef(v: unknown, where: string): SuiteCassette | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object: { id, match?, onUnmatched? }`);
  const id = str(v.id, `${where}.id`, { max: 64 })!;
  if (!ID_RE.test(id)) throw new AgentSuiteError(`${where}.id "${id}" must be lowercase letters, digits, - or _`);
  const m = v.match;
  if (m !== undefined && !(CASSETTE_MATCHES as readonly unknown[]).includes(m)) throw new AgentSuiteError(`${where}.match must be one of ${CASSETTE_MATCHES.join(", ")}`);
  const onUnmatched = v.onUnmatched;
  if (onUnmatched !== undefined && onUnmatched !== "block" && onUnmatched !== "fail") throw new AgentSuiteError(`${where}.onUnmatched must be block or fail`);
  const mode = v.mode;
  if (mode !== undefined && mode !== "record" && mode !== "replay") throw new AgentSuiteError(`${where}.mode must be replay or record`);
  return compact({
    id, mode: mode as SuiteCassette["mode"], match: m as CassetteMatch | undefined, onUnmatched: onUnmatched as SuiteCassette["onUnmatched"],
    model: v.model === false ? false : undefined,
  });
}

function parseSimulatedUser(v: unknown, where: string): SimulatedUser | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object: { persona, goal, constraints?, maxTurns?, stop?, script? }`);
  const script = strList(v.script, `${where}.script`);
  if (script && script.length > 20) throw new AgentSuiteError(`${where}.script: at most 20 turns`);
  const persona = str(v.persona, `${where}.persona`, { optional: true, max: 4000 });
  const goal = str(v.goal, `${where}.goal`, { optional: true, max: 4000 });
  if (!script?.length && !persona && !goal) throw new AgentSuiteError(`${where} needs a persona or a goal (a simulated user), or a script (scripted turns)`);
  const stop = v.stop;
  if (stop !== undefined && stop !== "goal" && stop !== "scorer" && stop !== "max_turns") throw new AgentSuiteError(`${where}.stop must be goal, scorer or max_turns`);
  const stopScorer = str(v.stopScorer, `${where}.stopScorer`, { optional: true, max: 64 });
  if (stop === "scorer" && !stopScorer) throw new AgentSuiteError(`${where}.stopScorer is required with stop: scorer`);
  const constraints = strList(v.constraints, `${where}.constraints`);
  return compact({
    persona, goal, constraints: constraints?.length ? constraints : undefined,
    maxTurns: num(v.maxTurns, `${where}.maxTurns`, { min: 1, max: 20, int: true }),
    stop: stop as SimulatedUserStop | undefined, stopScorer,
    simulator: parseSuiteRole(v.simulator, `${where}.simulator`, str(v.model, `${where}.model`, { optional: true, max: 200 })),
    script: script?.length ? script : undefined,
  });
}

function parseHttpMock(v: unknown, where: string): HttpMock {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object: { method?, url, status?, body? }`);
  const method = str(v.method, `${where}.method`, { optional: true, max: 10 });
  let headers: Record<string, string> | undefined;
  if (v.headers !== undefined) {
    if (!isObj(v.headers) || Object.values(v.headers).some((x) => typeof x !== "string")) throw new AgentSuiteError(`${where}.headers must be an object of strings`);
    headers = v.headers as Record<string, string>;
  }
  return compact({
    id: str(v.id, `${where}.id`, { optional: true, max: 64 }),
    method: method?.toUpperCase(),
    url: str(v.url, `${where}.url`, { max: 2000 })!,
    status: num(v.status, `${where}.status`, { min: 100, max: 599, int: true }),
    body: v.body,
    headers,
    times: num(v.times, `${where}.times`, { min: 1, int: true }),
  });
}

function checkRegexes(value: unknown, where: string): void {
  if (typeof value === "string") {
    try { new RegExp(value); } catch { throw new AgentSuiteError(`${where}: "${value}" is not a valid regular expression`); }
  } else if (Array.isArray(value)) value.forEach((x, i) => checkRegexes(x, `${where}[${i}]`));
  else if (isObj(value)) for (const [k, x] of Object.entries(value)) checkRegexes(x, `${where}.${k}`);
}

function parseAssertion(v: unknown, where: string): SuiteAssertion {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const type = v.type as SuiteAssertionType;
  if (!(SUITE_ASSERTION_TYPES as readonly unknown[]).includes(type)) throw new AgentSuiteError(`${where}.type must be one of ${SUITE_ASSERTION_TYPES.join(", ")}`);
  const base = compact({ id: str(v.id, `${where}.id`, { optional: true, max: 64 }), label: str(v.label, `${where}.label`, { optional: true, max: 300 }) });
  const m = matchMode(v.match, `${where}.match`);
  if (m === "regex") checkRegexes(v.args ?? v.value, `${where}.${v.args !== undefined ? "args" : "value"}`);
  const agent = str(v.agent, `${where}.agent`, { optional: true, max: 200 });
  switch (type) {
    case "tool_called":
      return compact({ ...base, type, tool: str(v.tool, `${where}.tool`)!, times: num(v.times, `${where}.times`, { min: 0, int: true }), min: num(v.min, `${where}.min`, { min: 0, int: true }), max: num(v.max, `${where}.max`, { min: 0, int: true }), args: v.args, match: m, agent });
    case "tool_not_called":
      return compact({ ...base, type, tool: str(v.tool, `${where}.tool`)!, args: v.args, match: m, agent });
    case "tool_failed":
      return compact({ ...base, type, tool: str(v.tool, `${where}.tool`, { optional: true, max: 200 }), contains: str(v.contains, `${where}.contains`, { optional: true, max: 2000 }) });
    case "http_called":
      return compact({ ...base, type, url: str(v.url, `${where}.url`, { max: 2000 })!, method: str(v.method, `${where}.method`, { optional: true, max: 10 })?.toUpperCase(), times: num(v.times, `${where}.times`, { min: 0, int: true }) });
    case "task_status": {
      const status = v.status;
      if (status !== "done" && status !== "failed" && status !== "skipped") throw new AgentSuiteError(`${where}.status must be done, failed or skipped`);
      return { ...base, type, task: str(v.task, `${where}.task`, { max: 300 })!, status };
    }
    case "task_order": {
      const tasks = strList(v.tasks, `${where}.tasks`);
      if (!tasks || tasks.length < 2) throw new AgentSuiteError(`${where}.tasks needs at least two task titles`);
      return { ...base, type, tasks };
    }
    case "task_agent":
      return { ...base, type, task: str(v.task, `${where}.task`, { max: 300 })!, agent: str(v.agent, `${where}.agent`, { max: 200 })! };
    case "tool_order": {
      const tools = strList(v.tools, `${where}.tools`);
      if (!tools || tools.length < 2) throw new AgentSuiteError(`${where}.tools needs at least two tools`);
      return compact({ ...base, type, tools, strict: v.strict === true ? true : undefined });
    }
    case "tool_args": {
      if (v.value === undefined) throw new AgentSuiteError(`${where}.value is required`);
      const which = v.which;
      if (which !== undefined && !["any", "all", "first", "last"].includes(which as string)) throw new AgentSuiteError(`${where}.which must be any, all, first or last`);
      return compact({ ...base, type, tool: str(v.tool, `${where}.tool`)!, value: v.value, match: m, which: which as "any" | undefined, agent });
    }
    case "no_tool_errors": return { ...base, type };
    case "outcome_registered":
      return compact({ ...base, type, label: str(v.label, `${where}.label`, { optional: true }), outcomeType: str(v.outcomeType, `${where}.outcomeType`, { optional: true }), valueContains: str(v.valueContains, `${where}.valueContains`, { optional: true }) });
    case "artifact_created":
      return compact({ ...base, type, kind: str(v.kind, `${where}.kind`, { optional: true }), titleContains: str(v.titleContains, `${where}.titleContains`, { optional: true }) });
    case "approval_requested":
      return compact({ ...base, type, tool: str(v.tool, `${where}.tool`, { optional: true }) });
    case "text_contains":
    case "text_not_contains": {
      const value = typeof v.value === "string" ? v.value : strList(v.value, `${where}.value`);
      if (!value || (Array.isArray(value) && !value.length)) throw new AgentSuiteError(`${where}.value is required`);
      return compact({ ...base, type, value, caseSensitive: v.caseSensitive === true ? true : undefined });
    }
    case "text_regex": {
      const pattern = str(v.pattern, `${where}.pattern`)!;
      const flags = str(v.flags, `${where}.flags`, { optional: true, max: 6 });
      try { new RegExp(pattern, flags); } catch { throw new AgentSuiteError(`${where}.pattern is not a valid regular expression`); }
      return compact({ ...base, type, pattern, flags });
    }
    case "max_turns": return { ...base, type, value: num(v.value, `${where}.value`, { min: 0, int: true }) ?? fail(`${where}.value is required`) };
    case "max_cost": return { ...base, type, usd: num(v.usd, `${where}.usd`, { min: 0 }) ?? fail(`${where}.usd is required`) };
    case "max_duration": return { ...base, type, ms: num(v.ms, `${where}.ms`, { min: 0, int: true }) ?? fail(`${where}.ms is required`) };
  }
}

function fail(message: string): never { throw new AgentSuiteError(message); }

function parseScorer(v: unknown, where: string, ids: Set<string>): SuiteScorer {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const type = v.type as SuiteScorerType;
  if (!(SUITE_SCORER_TYPES as readonly unknown[]).includes(type)) throw new AgentSuiteError(`${where}.type must be one of ${SUITE_SCORER_TYPES.join(", ")}`);
  let id = str(v.id, `${where}.id`, { optional: true, max: 64 });
  if (id !== undefined && !ID_RE.test(id)) throw new AgentSuiteError(`${where}.id "${id}" must be lowercase letters, digits, - or _`);
  if (id !== undefined && ids.has(id)) throw new AgentSuiteError(`${where}.id "${id}" is used by another scorer`);
  if (id === undefined) { id = type.replace(/_/g, "-"); let n = 2; while (ids.has(id)) id = `${type.replace(/_/g, "-")}-${n++}`; }
  ids.add(id);
  const from = v.from;
  if (from !== undefined && !(SCORER_SOURCES as readonly unknown[]).includes(from)) throw new AgentSuiteError(`${where}.from must be one of ${SCORER_SOURCES.join(", ")}`);
  const which = v.which;
  if (which !== undefined && which !== "first" && which !== "last") throw new AgentSuiteError(`${where}.which must be first or last`);
  const tool = str(v.tool, `${where}.tool`, { optional: true, max: 200 });
  if ((from === "tool_args" || from === "tool_result") && !tool) throw new AgentSuiteError(`${where}.tool is required with from: ${from}`);
  const base = compact({
    id,
    label: str(v.label, `${where}.label`, { optional: true, max: 300 }),
    threshold: num(v.threshold, `${where}.threshold`, { min: 0, max: 1 }),
    weight: num(v.weight, `${where}.weight`, { min: 0, max: 100 }),
    from: from as ScorerSource | undefined,
    tool,
    which: which as "first" | "last" | undefined,
    path: str(v.path, `${where}.path`, { optional: true, max: 300 }),
  });
  const values = (key: string) => {
    const list = typeof v[key] === "string" ? [v[key] as string] : strList(v[key], `${where}.${key}`);
    if (!list?.length) throw new AgentSuiteError(`${where}.${key} needs at least one value`);
    return list;
  };
  switch (type) {
    case "exact":
      if (v.expected === undefined) throw new AgentSuiteError(`${where}.expected is required`);
      return compact({ ...base, type, expected: v.expected, caseSensitive: v.caseSensitive === true ? true : undefined });
    case "numeric": {
      if (typeof v.expected !== "number" && typeof v.expected !== "string") throw new AgentSuiteError(`${where}.expected must be a number (or a {{row.x}} placeholder)`);
      const extract = str(v.extract, `${where}.extract`, { optional: true, max: 300 });
      if (extract) { try { new RegExp(extract); } catch { throw new AgentSuiteError(`${where}.extract is not a valid regular expression`); } }
      return compact({ ...base, type, expected: v.expected, tolerance: num(v.tolerance, `${where}.tolerance`, { min: 0 }), relative: v.relative === true ? true : undefined, extract });
    }
    case "contains_all":
    case "contains_any":
      return compact({ ...base, type, values: values("values"), caseSensitive: v.caseSensitive === true ? true : undefined });
    case "regex": {
      const pattern = str(v.pattern, `${where}.pattern`, { max: 1000 })!;
      const flags = str(v.flags, `${where}.flags`, { optional: true, max: 6 });
      try { new RegExp(pattern, flags); } catch { throw new AgentSuiteError(`${where}.pattern is not a valid regular expression`); }
      return compact({ ...base, type, pattern, flags });
    }
    case "similarity": {
      const method = v.method;
      if (method !== undefined && method !== "levenshtein" && method !== "tokens") throw new AgentSuiteError(`${where}.method must be levenshtein or tokens`);
      if (typeof v.expected !== "string") throw new AgentSuiteError(`${where}.expected is required (text)`);
      return compact({ ...base, type, expected: v.expected, method: method as "levenshtein" | "tokens" | undefined });
    }
    case "json_schema":
      if (!isObj(v.schema)) throw new AgentSuiteError(`${where}.schema must be a JSON Schema object`);
      return { ...base, type, schema: v.schema };
    case "tool_trajectory": {
      const order = v.order;
      if (order !== undefined && !["exact", "in_order", "any"].includes(order as string)) throw new AgentSuiteError(`${where}.order must be exact, in_order or any`);
      return compact({ ...base, type, expected: values("expected"), order: order as "exact" | undefined });
    }
    case "cost": return { ...base, type, maxUsd: num(v.maxUsd, `${where}.maxUsd`, { min: 0 }) ?? fail(`${where}.maxUsd is required`) };
    case "latency": return { ...base, type, maxMs: num(v.maxMs, `${where}.maxMs`, { min: 1 }) ?? fail(`${where}.maxMs is required`) };
    case "llm_judge": {
      let criteria: JudgeCriterion[] | undefined;
      if (v.criteria !== undefined) {
        if (!Array.isArray(v.criteria) || !v.criteria.length || v.criteria.length > 10) throw new AgentSuiteError(`${where}.criteria must be a list of 1–10 criteria`);
        criteria = v.criteria.map((c, i) => {
          const w = `${where}.criteria[${i}]`;
          if (!isObj(c)) throw new AgentSuiteError(`${w} must be an object`);
          return compact({ name: str(c.name, `${w}.name`, { max: 80 })!, description: str(c.description, `${w}.description`, { max: 2000 })!, weight: num(c.weight, `${w}.weight`, { min: 0, max: 100 }) });
        });
      }
      return compact({ ...base, type, rubric: str(v.rubric, `${where}.rubric`, { max: 10_000 })!, criteria, expected: str(v.expected, `${where}.expected`, { optional: true, max: 50_000 }), judge: parseSuiteRole(v.judge, `${where}.judge`, str(v.model, `${where}.model`, { optional: true, max: 200 })) });
    }
    case "custom":
      return compact({ ...base, type, code: str(v.code, `${where}.code`, { max: 20_000 })!, expected: v.expected, timeoutMs: num(v.timeoutMs, `${where}.timeoutMs`, { min: 100, max: 30_000, int: true }) });
  }
}

function parseScorers(v: unknown, where: string): SuiteScorer[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new AgentSuiteError(`${where} must be a list`);
  if (v.length > SUITE_LIMITS.scorers) throw new AgentSuiteError(`${where}: at most ${SUITE_LIMITS.scorers} scorers`);
  const ids = new Set<string>();
  return v.map((s, i) => parseScorer(s, `${where}[${i}]`, ids));
}

function parseEvals(v: unknown, where: string): SuiteEvalSettings | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const baseline = v.baseline;
  if (baseline !== undefined && !["previous", "production", "none"].includes(baseline as string)) throw new AgentSuiteError(`${where}.baseline must be previous, production or none`);
  return compact({
    judge: parseSuiteRole(v.judge, `${where}.judge`, str(v.judgeModel, `${where}.judgeModel`, { optional: true, max: 200 })),
    reviewer: parseSuiteRole(v.reviewer, `${where}.reviewer`),
    repetitions: num(v.repetitions, `${where}.repetitions`, { min: 1, max: SUITE_LIMITS.maxRepetitions, int: true }),
    regressionTolerance: num(v.regressionTolerance, `${where}.regressionTolerance`, { min: 0, max: 1 }),
    flakyStddev: num(v.flakyStddev, `${where}.flakyStddev`, { min: 0, max: 1 }),
    baseline: baseline as SuiteEvalSettings["baseline"],
  });
}

function parseInput(v: unknown, where: string): CaseInput {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const kind = v.kind ?? "chat";
  if (kind !== "chat" && kind !== "task" && kind !== "tool" && kind !== "mission") throw new AgentSuiteError(`${where}.kind must be chat, task, tool or mission`);
  if (kind === "tool") {
    if (v.args !== undefined && !isObj(v.args)) throw new AgentSuiteError(`${where}.args must be an object`);
    return compact({ kind, message: str(v.message, `${where}.message`, { optional: true, max: 100_000 }) ?? "", tool: str(v.tool, `${where}.tool`, { max: 200 })!, args: (v.args as Record<string, unknown> | undefined) ?? {} });
  }
  let history: CaseInput["history"];
  if (v.history !== undefined) {
    if (!Array.isArray(v.history)) throw new AgentSuiteError(`${where}.history must be a list`);
    history = v.history.map((m, i) => {
      if (!isObj(m) || (m.role !== "user" && m.role !== "assistant")) throw new AgentSuiteError(`${where}.history[${i}].role must be user or assistant`);
      return { role: m.role, content: str(m.content, `${where}.history[${i}].content`, { max: 100_000 }) ?? "" };
    });
  }
  let context: CaseInput["context"];
  if (v.context !== undefined && v.context !== null) {
    const c = v.context;
    if (!isObj(c)) throw new AgentSuiteError(`${where}.context must be an object`);
    const list = <T>(x: unknown, w: string, f: (o: Raw, w: string) => T): T[] | undefined => {
      if (x === undefined) return undefined;
      if (!Array.isArray(x)) throw new AgentSuiteError(`${w} must be a list`);
      return x.map((o, i) => { if (!isObj(o)) throw new AgentSuiteError(`${w}[${i}] must be an object`); return f(o, `${w}[${i}]`); });
    };
    context = compact({
      system: str(c.system, `${where}.context.system`, { optional: true, max: 50_000 }),
      memory: str(c.memory, `${where}.context.memory`, { optional: true, max: 50_000 }),
      files: list(c.files, `${where}.context.files`, (o, w) => ({ path: str(o.path, `${w}.path`, { max: 500 })!, content: str(o.content, `${w}.content`, { max: 200_000, optional: true }) ?? "" })),
      attachments: list(c.attachments, `${where}.context.attachments`, (o, w) => compact({ name: str(o.name, `${w}.name`, { max: 200 })!, content: str(o.content, `${w}.content`, { max: 200_000, optional: true }) ?? "", mimeType: str(o.mimeType, `${w}.mimeType`, { optional: true }) })),
    });
  }
  const message = kind === "mission" ? str(v.message, `${where}.message`, { optional: true, max: 100_000 }) ?? "" : str(v.message, `${where}.message`, { max: 100_000 })!;
  return compact({ kind, message, history, context });
}

/** Validate one case (the generated cases a person accepts, the cases appended to a suite). */
export function parseSuiteCase(input: unknown, where = "case", takenIds: Iterable<string> = []): SuiteCase {
  return parseCase(input, where, new Set(takenIds));
}

function parseCase(v: unknown, where: string, ids: Set<string>): SuiteCase {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const name = str(v.name, `${where}.name`, { max: 200 })!;
  let id = str(v.id, `${where}.id`, { optional: true, max: 64 }) ?? suiteSlug(name, "case");
  if (!ID_RE.test(id)) throw new AgentSuiteError(`${where}.id "${id}" must be lowercase letters, digits, - or _`);
  if (ids.has(id) && v.id === undefined) { let n = 2; while (ids.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
  if (ids.has(id)) throw new AgentSuiteError(`${where}.id "${id}" is used by another case`);
  ids.add(id);
  if (v.assertions !== undefined && !Array.isArray(v.assertions)) throw new AgentSuiteError(`${where}.assertions must be a list`);
  const assertions = ((v.assertions as unknown[] | undefined) ?? []).map((a, i) => parseAssertion(a, `${where}.assertions[${i}]`));
  if (assertions.length > SUITE_LIMITS.assertions) throw new AgentSuiteError(`${where}: at most ${SUITE_LIMITS.assertions} assertions`);
  return compact({
    id, name,
    description: str(v.description, `${where}.description`, { optional: true, max: 2000 }),
    input: parseInput(v.input, `${where}.input`),
    mode: mode(v.mode, `${where}.mode`),
    mocks: parseMocks(v.mocks, `${where}.mocks`),
    assertions,
    scorers: parseScorers(v.scorers, `${where}.scorers`),
    dataset: str(v.dataset, `${where}.dataset`, { optional: true, max: 64 }),
    budgets: parseBudgets(v.budgets, `${where}.budgets`),
    tags: strList(v.tags, `${where}.tags`),
    skip: v.skip === true ? true : undefined,
    source: isObj(v.source) ? v.source as SuiteCase["source"] : undefined,
  });
}

function parseDataset(v: unknown, where: string, ids: Set<string>): SuiteDataset {
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  const name = str(v.name, `${where}.name`, { max: 200 })!;
  const id = str(v.id, `${where}.id`, { optional: true, max: 64 }) ?? suiteSlug(name, "dataset");
  if (!ID_RE.test(id)) throw new AgentSuiteError(`${where}.id "${id}" must be lowercase letters, digits, - or _`);
  if (ids.has(id)) throw new AgentSuiteError(`${where}.id "${id}" is used by another dataset`);
  ids.add(id);
  if (!Array.isArray(v.rows) || v.rows.some((r) => !isObj(r))) throw new AgentSuiteError(`${where}.rows must be a list of objects`);
  if (v.rows.length > SUITE_LIMITS.datasetRows) throw new AgentSuiteError(`${where}: at most ${SUITE_LIMITS.datasetRows} rows`);
  const rows = v.rows as Array<Record<string, unknown>>;
  const columns = strList(v.columns, `${where}.columns`) ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return compact({ id, name, description: str(v.description, `${where}.description`, { optional: true, max: 2000 }), columns, rows, source: isObj(v.source) ? v.source as SuiteDataset["source"] : undefined });
}

function parseTarget(v: unknown, where: string): SuiteTarget {
  if (v === undefined || v === null) return { kind: "agent" };
  if (!isObj(v)) throw new AgentSuiteError(`${where} must be an object`);
  switch (v.kind) {
    case "agent": return { kind: "agent" };
    case "mcp-server": return { kind: "mcp-server", server: str(v.server, `${where}.server`)! };
    case "mission": return { kind: "mission", mission: str(v.mission, `${where}.mission`)! };
    case "team": return { kind: "team", team: str(v.team, `${where}.team`)! };
    default: throw new AgentSuiteError(`${where}.kind must be agent, mcp-server, mission or team`);
  }
}

/** What a person (or a client) sends to save a suite: everything but the bookkeeping. */
export type AgentSuiteInput = Partial<Omit<AgentSuite, "agent" | "createdAt" | "updatedAt" | "updatedBy">> & { name: string };

/**
 * Validate and normalize a suite (ids made from names when missing, defaults applied). Throws
 * AgentSuiteError with the path of the first problem ("cases[1].assertions[0].tool is required").
 */
export function parseAgentSuite(input: unknown, agent: string, existing?: AgentSuite, now = new Date().toISOString()): AgentSuite {
  if (!isObj(input)) throw new AgentSuiteError("The suite must be an object");
  const name = str(input.name, "name", { max: 200 })!;
  const id = str(input.id, "id", { optional: true, max: 64 }) ?? existing?.id ?? suiteSlug(name);
  if (!ID_RE.test(id)) throw new AgentSuiteError(`id "${id}" must be lowercase letters, digits, - or _`);
  if (input.cases !== undefined && !Array.isArray(input.cases)) throw new AgentSuiteError("cases must be a list");
  if (input.datasets !== undefined && !Array.isArray(input.datasets)) throw new AgentSuiteError("datasets must be a list");
  const caseList = (input.cases as unknown[] | undefined) ?? [];
  if (caseList.length > SUITE_LIMITS.cases) throw new AgentSuiteError(`At most ${SUITE_LIMITS.cases} cases`);
  const dsList = (input.datasets as unknown[] | undefined) ?? [];
  if (dsList.length > SUITE_LIMITS.datasets) throw new AgentSuiteError(`At most ${SUITE_LIMITS.datasets} datasets`);
  const dsIds = new Set<string>();
  const datasets = dsList.map((d, i) => parseDataset(d, `datasets[${i}]`, dsIds));
  const caseIds = new Set<string>();
  const cases = caseList.map((c, i) => parseCase(c, `cases[${i}]`, caseIds));
  for (const [i, c] of cases.entries()) {
    if (c.dataset && !dsIds.has(c.dataset)) throw new AgentSuiteError(`cases[${i}].dataset: there is no dataset "${c.dataset}"`);
  }
  let gate: SuiteGate | undefined;
  if (isObj(input.gate)) {
    gate = compact({
      required: input.gate.required === true ? true : undefined,
      minPassRate: num(input.gate.minPassRate, "gate.minPassRate", { min: 0, max: 1 }),
      maxRegression: num(input.gate.maxRegression, "gate.maxRegression", { min: 0, max: 1 }),
      scoreThresholds: parseScoreThresholds(input.gate.scoreThresholds),
      onPublish: input.gate.onPublish === true ? true : undefined,
      allowRealTools: input.gate.allowRealTools === true ? true : undefined,
    });
    if (!Object.keys(gate).length) gate = undefined;
  }
  return compact({
    id, agent, name,
    description: str(input.description, "description", { optional: true, max: 4000 }),
    target: parseTarget(input.target, "target"),
    defaultMode: mode(input.defaultMode, "defaultMode") ?? "all",
    mocks: parseMocks(input.mocks, "mocks"),
    cases,
    datasets,
    budgets: parseBudgets(input.budgets, "budgets"),
    concurrency: num(input.concurrency, "concurrency", { min: 1, max: SUITE_LIMITS.maxConcurrency, int: true }),
    scorers: parseScorers(input.scorers, "scorers"),
    evals: parseEvals(input.evals, "evals"),
    gate,
    simulator: parseSuiteRole(input.simulator, "simulator", str(input.simulatorModel, "simulatorModel", { optional: true, max: 200 })),
    generator: parseSuiteRole(input.generator, "generator"),
    tags: strList(input.tags, "tags"),
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

// ── Templating ───────────────────────────────────────────────────────

const WHOLE = /^\{\{\s*([\w.$-]+)\s*\}\}$/;
const PART = /\{\{\s*([\w.$-]+)\s*\}\}/g;

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let v: unknown = vars;
  for (const k of path.split(".")) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/**
 * Fill {{row.column}} / {{args.name}} placeholders, deeply. A string that is only a placeholder
 * takes the value as is (numbers stay numbers); inside text it is written out (objects as JSON).
 * Unknown names are left as they are (so a mistake shows in the trace).
 */
export function renderSuiteTemplate<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) { const v = lookup(vars, whole[1]); return (v === undefined ? value : v) as T; }
    return value.replace(PART, (m, path: string) => {
      const v = lookup(vars, path);
      return v === undefined ? m : typeof v === "string" ? v : JSON.stringify(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((x) => renderSuiteTemplate(x, vars)) as T;
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, renderSuiteTemplate(x, vars)])) as T;
  return value;
}

/** One case to execute: the case (templated with its dataset row) and the row. */
export interface PlannedCase {
  /** caseId, caseId#row, and ~attempt with repetitions. */
  key: string;
  /** The key without the attempt (the case, or its dataset row): attempts are aggregated by it. */
  baseKey: string;
  /** With repetitions: 1-based. */
  attempt?: number;
  case: SuiteCase;
  row?: { index: number; values: Record<string, unknown> };
  mode: SuiteMockMode;
  mocks: SuiteMocks;
  budgets: Required<Pick<CaseBudgets, "maxTurns" | "maxDurationMs">> & Pick<CaseBudgets, "maxCostUsd">;
}

/** Merge the suite's and the case's mocks: the case's tool mocks first, its model mock and policy win. */
export function mergeSuiteMocks(suite: SuiteMocks | undefined, own: SuiteMocks | undefined): SuiteMocks {
  let agents: Record<string, SuiteMocks> | undefined;
  if (own?.agents || suite?.agents) {
    agents = {};
    for (const name of new Set([...Object.keys(own?.agents ?? {}), ...Object.keys(suite?.agents ?? {})])) {
      agents[name] = mergeSuiteMocks(suite?.agents?.[name], own?.agents?.[name]);
    }
  }
  const http = [...(own?.http ?? []), ...(suite?.http ?? [])];
  return compact({
    tools: [...(own?.tools ?? []), ...(suite?.tools ?? [])],
    model: own?.model ?? suite?.model,
    unmockedTools: own?.unmockedTools ?? suite?.unmockedTools,
    cassette: own?.cassette ?? suite?.cassette,
    simulatedUser: own?.simulatedUser ?? suite?.simulatedUser,
    agents,
    http: http.length ? http : undefined,
    unmockedHttp: own?.unmockedHttp ?? suite?.unmockedHttp,
  });
}

/** A mission task's mocks: the agent's own (by name), over the case's shared ones (tool mocks first, model mock and policies win). */
export function agentMocksFor(mocks: SuiteMocks, agent: string): SuiteMocks {
  const { agents, ...shared } = mocks;
  const own = agents?.[agent];
  return own ? mergeSuiteMocks(shared, own) : shared;
}

/** The scorers a case runs: the suite's defaults, then its own (one with the same id replaces the default). */
export function mergeSuiteScorers(suite: SuiteScorer[] | undefined, own: SuiteScorer[] | undefined): SuiteScorer[] {
  const ownIds = new Set((own ?? []).map((s) => s.id).filter(Boolean));
  return [...(suite ?? []).filter((s) => !s.id || !ownIds.has(s.id)), ...(own ?? [])];
}

/** The cases a run executes, in order: each case once (or `repetitions` times), or once per row of its dataset. */
export function planSuiteCases(suite: AgentSuite, opts: { caseIds?: string[]; mode?: SuiteMockMode; repetitions?: number } = {}): PlannedCase[] {
  if (opts.caseIds?.length) {
    const unknown = opts.caseIds.filter((id) => !suite.cases.some((c) => c.id === id));
    if (unknown.length) throw new AgentSuiteError(`${suite.name} has no case ${unknown.map((u) => `"${u}"`).join(", ")}`, "NOT_FOUND");
  }
  const reps = Math.max(1, Math.min(SUITE_LIMITS.maxRepetitions, Math.floor(opts.repetitions ?? suite.evals?.repetitions ?? 1)));
  const base: Array<Omit<PlannedCase, "key" | "attempt"> > = [];
  for (const raw of suite.cases) {
    if (opts.caseIds?.length && !opts.caseIds.includes(raw.id)) continue;
    const scorers = mergeSuiteScorers(suite.scorers, raw.scorers);
    const c: SuiteCase = scorers.length ? { ...raw, scorers } : raw;
    const m = opts.mode ?? c.mode ?? suite.defaultMode;
    const budgets = {
      maxTurns: c.budgets?.maxTurns ?? suite.budgets?.maxTurns ?? SUITE_LIMITS.defaultMaxTurns,
      maxDurationMs: c.budgets?.maxDurationMs ?? suite.budgets?.maxDurationMs ?? SUITE_LIMITS.defaultMaxDurationMs,
      ...(c.budgets?.maxCostUsd ?? suite.budgets?.maxCostUsd) !== undefined ? { maxCostUsd: c.budgets?.maxCostUsd ?? suite.budgets?.maxCostUsd } : {},
    };
    const mocks = mergeSuiteMocks(suite.mocks, c.mocks);
    const ds = c.dataset ? suite.datasets.find((d) => d.id === c.dataset) : undefined;
    if (!ds) { base.push({ baseKey: c.id, case: c, mode: m, mocks, budgets }); continue; }
    ds.rows.forEach((values, index) => {
      const vars = { row: values };
      base.push({
        baseKey: `${c.id}#${index + 1}`,
        case: { ...c, input: renderSuiteTemplate(c.input, vars), assertions: renderSuiteTemplate(c.assertions, vars), ...(c.scorers ? { scorers: renderSuiteTemplate(c.scorers, vars) } : {}) },
        row: { index, values },
        mode: m,
        mocks: renderSuiteTemplate(mocks, vars),
        budgets,
      });
    });
  }
  if (reps === 1) return base.map((p) => ({ ...p, key: p.baseKey }));
  return base.flatMap((p) => Array.from({ length: reps }, (_, i) => ({ ...p, key: `${p.baseKey}~${i + 1}`, attempt: i + 1 })));
}

/** Does running these cases touch real tools (a side effect is possible)? Such runs need the admin scope. */
export function planUsesRealTools(planned: PlannedCase[]): boolean {
  return planned.some((p) => !modeMocksTools(p.mode) || (p.mode === "tools" && p.mocks.unmockedTools === "real")
    || (p.case.input.kind === "tool" && p.mocks.unmockedHttp === "real")
    || (p.case.input.kind === "mission" && Object.values(p.mocks.agents ?? {}).some((m) => p.mode === "tools" && m.unmockedTools === "real")));
}

/** Does running these cases call a real model (it costs tokens)? */
export function planUsesRealModel(planned: PlannedCase[]): boolean {
  return planned.some((p) => p.case.input.kind !== "tool" && !modeMocksModel(p.mode));
}

/** The message sent to the agent for a case: the task framing, context files and attachments inlined. */
export function caseUserMessage(input: CaseInput): string {
  const parts: string[] = [];
  parts.push(input.kind === "task" ? `## Task\n\n${input.message}\n\nComplete this task, then report what you did.` : input.message);
  for (const f of input.context?.files ?? []) parts.push(`## File ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``);
  for (const a of input.context?.attachments ?? []) parts.push(`## Attachment ${a.name}${a.mimeType ? ` (${a.mimeType})` : ""}\n\n${a.content}`);
  return parts.join("\n\n");
}

/** The chat messages for a case (system context, earlier turns, the message). */
export function caseMessages(input: CaseInput): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const system = [
    input.context?.system,
    input.context?.memory ? `## Memory for this conversation\n\n${input.context.memory}` : undefined,
  ].filter(Boolean).join("\n\n");
  if (system) out.push({ role: "system", content: system });
  for (const m of input.history ?? []) out.push(m);
  out.push({ role: "user", content: caseUserMessage(input) });
  return out;
}

// ── Matching ─────────────────────────────────────────────────────────

/** A tool name pattern: an exact name or a glob (* any characters, ? one). */
export function suiteToolMatches(pattern: string, name: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === name;
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(name);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Partial: every key of `expected` is in `actual` with a matching value (objects recursively, arrays element by element). */
function partialMatch(expected: unknown, actual: unknown): boolean {
  if (isObj(expected)) return isObj(actual) && Object.entries(expected).every(([k, v]) => partialMatch(v, actual[k]));
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length <= actual.length && expected.every((v, i) => partialMatch(v, actual[i]));
  return deepEqual(expected, actual);
}

/** Regex: like partial, string values of `expected` are regular expressions tested on the actual value (as text). */
function regexMatch(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string") {
    if (actual === undefined || actual === null) return false;
    const text = typeof actual === "string" ? actual : JSON.stringify(actual);
    try { return new RegExp(expected).test(text); } catch { return false; }
  }
  if (isObj(expected)) return isObj(actual) && Object.entries(expected).every(([k, v]) => regexMatch(v, actual[k]));
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((v, i) => regexMatch(v, actual[i]));
  return deepEqual(expected, actual);
}

/** Compare arguments (see {@link ArgsMatchMode}); schema: `expected` is a JSON Schema. */
export function argsMatch(expected: unknown, actual: unknown, mode: ArgsMatchMode = "partial"): boolean {
  switch (mode) {
    case "exact": return deepEqual(expected, actual);
    case "partial": return partialMatch(expected, actual);
    case "regex": return regexMatch(expected, actual);
    case "schema": return validateJsonSchema(expected, actual).length === 0;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
function validDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
function validTime(v: string): boolean {
  const m = TIME_RE.exec(v);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60 && Number(m[3]) < 61;
}

/** The `format` values validateJsonSchema checks (JSON Schema 2020-12 names). */
export const JSON_SCHEMA_FORMATS: Record<string, (v: string) => boolean> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254,
  uri: (v) => { try { return !!new URL(v).protocol; } catch { return false; } },
  url: (v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } },
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  date: validDate,
  time: validTime,
  "date-time": (v) => { const i = v.search(/[Tt ]/); return i === 10 && validDate(v.slice(0, 10)) && validTime(v.slice(11)); },
  ipv4: (v) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(v),
  ipv6: (v) => v.includes(":") && /^[0-9a-f:.]+$/i.test(v) && (() => { try { return new URL(`http://[${v}]/`).hostname.length > 2; } catch { return false; } })(),
  hostname: (v) => v.length <= 253 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i.test(v),
};

/**
 * A small JSON Schema check (type, properties, required, additionalProperties, items, enum, const,
 * minimum / maximum, minLength / maxLength, pattern, format, minItems / maxItems, anyOf / oneOf / allOf, not).
 * Known formats ({@link JSON_SCHEMA_FORMATS}) are checked; unknown ones are ignored, as the spec allows.
 * Returns the problems ("$.rate: must be a number"), empty when valid.
 */
export function validateJsonSchema(schema: unknown, value: unknown, path = "$"): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (!isObj(schema)) return [];
  const errs: string[] = [];
  const t = schema.type;
  if (t !== undefined) {
    const types = Array.isArray(t) ? t as string[] : [t as string];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((x) => x === actual || (x === "number" && actual === "integer"));
    if (!ok) return [`${path}: must be ${types.join(" or ")} (is ${actual})`];
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) errs.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) errs.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: must be ≥ ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errs.push(`${path}: must be ≤ ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errs.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errs.push(`${path}: must be < ${schema.exclusiveMaximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string") { try { if (!new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match /${schema.pattern}/`); } catch { /* bad pattern: ignored */ } }
    if (typeof schema.format === "string") {
      const check = JSON_SCHEMA_FORMATS[schema.format];
      if (check && !check(value)) errs.push(`${path}: must be a valid ${schema.format}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((x, i) => errs.push(...validateJsonSchema(schema.items, x, `${path}[${i}]`)));
  }
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const r of Array.isArray(schema.required) ? schema.required as string[] : []) if (value[r] === undefined) errs.push(`${path}.${r}: required`);
    for (const [k, s] of Object.entries(props)) if (value[k] !== undefined) errs.push(...validateJsonSchema(s, value[k], `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in props)) errs.push(`${path}.${k}: not allowed`);
    else if (isObj(schema.additionalProperties)) for (const k of Object.keys(value)) if (!(k in props)) errs.push(...validateJsonSchema(schema.additionalProperties, value[k], `${path}.${k}`));
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) errs.push(...validateJsonSchema(s, value, path));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validateJsonSchema(s, value, path).length === 0)) errs.push(`${path}: matches none of anyOf`);
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((s) => validateJsonSchema(s, value, path).length === 0).length !== 1) errs.push(`${path}: must match exactly one of oneOf`);
  if (schema.not !== undefined && validateJsonSchema(schema.not, value, path).length === 0) errs.push(`${path}: must not match "not"`);
  return errs;
}

/**
 * The mock that answers a tool call, if any: the first whose tool pattern, call number and
 * arguments match and that has calls left. `used` counts the calls each mock answered so far
 * (index → count) and is updated; `callNumber` is the 1-based number of this tool's call.
 */
export function findToolMock(mocks: ToolMock[], name: string, args: Record<string, unknown>, callNumber: number, used: Map<number, number>): { mock: ToolMock; index: number } | undefined {
  for (const [index, mock] of mocks.entries()) {
    if (!suiteToolMatches(mock.tool, name)) continue;
    if (mock.when?.call !== undefined && mock.when.call !== callNumber) continue;
    if (mock.when?.args !== undefined && !argsMatch(mock.when.args, args, mock.when.match ?? "partial")) continue;
    const n = used.get(index) ?? 0;
    if (mock.times !== undefined && n >= mock.times) continue;
    used.set(index, n + 1);
    return { mock, index };
  }
  return undefined;
}

/** The text a mock answers with (templated with the call's args and the row). */
export function toolMockResult(mock: ToolMock, vars: Record<string, unknown>): { text: string; isError: boolean } {
  if (mock.error !== undefined) {
    const msg = renderSuiteTemplate(mock.error, vars);
    return { text: msg.startsWith("Error:") ? msg : `Error: ${msg}`, isError: true };
  }
  const r = renderSuiteTemplate(mock.response, vars);
  const text = r === undefined ? "OK" : typeof r === "string" ? r : JSON.stringify(r);
  return { text, isError: false };
}

// ── Assertions ───────────────────────────────────────────────────────

function pretty(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "undefined";
}

function argsDiff(expected: unknown, actual: unknown): string {
  return unifiedLineDiff(pretty(expected), pretty(actual), "expected", "actual");
}

/** A readable description of an assertion ("tool_called mcp__printful__shipping_rates ×1"). */
export function describeAssertion(a: SuiteAssertion): string {
  if (a.label) return a.label;
  const args = (x: unknown, m?: ArgsMatchMode) => x === undefined ? "" : ` with ${m ?? "partial"} args ${JSON.stringify(x)}`;
  const by = "agent" in a && a.agent ? ` by ${a.agent}` : "";
  switch (a.type) {
    case "tool_called": return `${a.tool} called${by}${a.times !== undefined ? ` exactly ${a.times}×` : a.min !== undefined || a.max !== undefined ? ` ${a.min ?? 0}–${a.max ?? "∞"}×` : ""}${args(a.args, a.match)}`;
    case "tool_not_called": return `${a.tool} not called${by}${args(a.args, a.match)}`;
    case "tool_failed": return `${a.tool ?? "a tool call"} fails${a.contains ? ` with "${a.contains}"` : ""}`;
    case "http_called": return `${a.method ?? "a"} request to ${a.url}${a.times !== undefined ? ` exactly ${a.times}×` : ""}`;
    case "task_status": return `task "${a.task}" ${a.status}`;
    case "task_order": return `tasks in order: ${a.tasks.join(" → ")}`;
    case "task_agent": return `task "${a.task}" done by ${a.agent}`;
    case "tool_order": return `tools in order${a.strict ? " (consecutive)" : ""}: ${a.tools.join(" → ")}`;
    case "tool_args": return `${a.which ?? "any"} ${a.tool} call${by} has ${a.match ?? "partial"} args ${JSON.stringify(a.value)}`;
    case "no_tool_errors": return "no tool call failed";
    case "outcome_registered": return `outcome registered${a.label ? ` "${a.label}"` : ""}${a.outcomeType ? ` (${a.outcomeType})` : ""}${a.valueContains ? ` containing "${a.valueContains}"` : ""}`;
    case "artifact_created": return `artifact created${a.kind ? ` (${a.kind})` : ""}${a.titleContains ? ` titled "…${a.titleContains}…"` : ""}`;
    case "approval_requested": return `approval requested${a.tool ? ` for ${a.tool}` : ""}`;
    case "text_contains": return `reply contains ${(Array.isArray(a.value) ? a.value : [a.value]).map((v) => `"${v}"`).join(", ")}`;
    case "text_not_contains": return `reply does not contain ${(Array.isArray(a.value) ? a.value : [a.value]).map((v) => `"${v}"`).join(", ")}`;
    case "text_regex": return `reply matches /${a.pattern}/${a.flags ?? ""}`;
    case "max_turns": return `at most ${a.value} model turns`;
    case "max_cost": return `costs at most $${a.usd}`;
    case "max_duration": return `takes at most ${a.ms} ms`;
  }
}

/** Evaluate one assertion against a case's trace. */
export function evaluateAssertion(a: SuiteAssertion, trace: SuiteTrace): SuiteAssertionResult {
  const description = describeAssertion(a);
  const res = (passed: boolean, message: string, extra: Partial<SuiteAssertionResult> = {}): SuiteAssertionResult => ({ assertion: a, description, passed, message, ...extra });
  const byAgent = "agent" in a && typeof a.agent === "string" ? a.agent : undefined;
  const callsOf = (pattern: string) => trace.toolCalls.filter((c) => suiteToolMatches(pattern, c.name) && (!byAgent || c.agent === byAgent));
  const taskOf = (title: string) => trace.tasks?.find((t) => t.title === title);
  const names = trace.toolCalls.map((c) => c.name);
  const calledText = names.length ? `called: ${names.join(", ")}` : "no tool was called";
  switch (a.type) {
    case "tool_called": {
      const calls = callsOf(a.tool);
      const matching = a.args === undefined ? calls : calls.filter((c) => argsMatch(a.args, c.args, a.match ?? "partial"));
      const n = matching.length;
      const lo = a.times ?? a.min ?? 1, hi = a.times ?? a.max ?? Infinity;
      if (n >= lo && n <= hi) return res(true, `${a.tool}: ${n} matching call(s)`, { actual: n });
      if (a.args !== undefined && calls.length && !n) {
        const closest = calls[0];
        return res(false, `${a.tool} was called ${calls.length}×, never with the expected arguments`, { expected: a.args, actual: closest.args, diff: argsDiff(a.args, closest.args) });
      }
      return res(false, `${a.tool}: expected ${a.times !== undefined ? `exactly ${a.times}` : `${lo}–${hi === Infinity ? "∞" : hi}`} call(s), got ${n} (${calledText})`, { expected: a.times ?? { min: lo, max: hi === Infinity ? undefined : hi }, actual: n });
    }
    case "tool_not_called": {
      const calls = callsOf(a.tool).filter((c) => a.args === undefined || argsMatch(a.args, c.args, a.match ?? "partial"));
      return calls.length
        ? res(false, `${calls[0].name} was called ${calls.length}× (args ${JSON.stringify(calls[0].args)})`, { actual: calls.map((c) => c.args) })
        : res(true, `${a.tool} not called`);
    }
    case "tool_order": {
      if (a.strict) {
        for (let i = 0; i + a.tools.length <= names.length; i++) {
          if (a.tools.every((t, j) => suiteToolMatches(t, names[i + j]))) return res(true, `found at call ${i + 1}`);
        }
      } else {
        let j = 0;
        for (const n of names) if (j < a.tools.length && suiteToolMatches(a.tools[j], n)) j++;
        if (j === a.tools.length) return res(true, "in order");
      }
      return res(false, `expected ${a.tools.join(" → ")}; ${calledText}`, { expected: a.tools, actual: names, diff: unifiedLineDiff(a.tools.join("\n"), names.join("\n"), "expected", "actual") });
    }
    case "tool_args": {
      const calls = callsOf(a.tool);
      if (!calls.length) return res(false, `${a.tool} was never called (${calledText})`, { expected: a.value });
      const m = a.match ?? "partial";
      const which = a.which ?? "any";
      const pick = which === "first" ? [calls[0]] : which === "last" ? [calls[calls.length - 1]] : calls;
      const ok = (c: SuiteTraceToolCall) => argsMatch(a.value, c.args, m);
      const passed = which === "all" ? pick.every(ok) : pick.some(ok);
      if (passed) return res(true, `${which} ${a.tool} call matches`);
      const bad = pick.find((c) => !ok(c)) ?? pick[0];
      const schemaErrs = m === "schema" ? validateJsonSchema(a.value, bad.args) : [];
      return res(false, schemaErrs.length ? `${a.tool} arguments do not match the schema: ${schemaErrs.slice(0, 5).join("; ")}` : `${a.tool} arguments do not match (${m})`,
        { expected: a.value, actual: bad.args, ...(m === "schema" ? {} : { diff: argsDiff(a.value, bad.args) }) });
    }
    case "no_tool_errors": {
      const errs = trace.toolCalls.filter((c) => c.isError);
      return errs.length ? res(false, `${errs.length} tool call(s) failed: ${errs.map((e) => `${e.name}: ${e.result.slice(0, 160)}`).join(" | ")}`, { actual: errs.map((e) => e.name) }) : res(true, "no tool errors");
    }
    case "outcome_registered": {
      const calls = trace.toolCalls.filter((c) => c.name === "register_outcome" && !c.isError);
      const ok = calls.filter((c) => {
        const x = c.args as Record<string, unknown>;
        if (a.label && String(x.label ?? "") !== a.label) return false;
        if (a.outcomeType && String(x.type ?? "") !== a.outcomeType) return false;
        if (a.valueContains && !JSON.stringify(x).toLowerCase().includes(a.valueContains.toLowerCase())) return false;
        return true;
      });
      return ok.length ? res(true, `${ok.length} outcome(s) registered`) : res(false, calls.length ? `outcomes registered, none matching: ${calls.map((c) => JSON.stringify(c.args)).join("; ").slice(0, 400)}` : "register_outcome was not called", { actual: calls.map((c) => c.args) });
    }
    case "artifact_created": {
      const calls = trace.toolCalls.filter((c) => c.name === "artifact_create" && !c.isError);
      const ok = calls.filter((c) => {
        const x = c.args as Record<string, unknown>;
        if (a.kind && String(x.kind ?? x.type ?? "") !== a.kind) return false;
        if (a.titleContains && !String(x.title ?? x.name ?? "").toLowerCase().includes(a.titleContains.toLowerCase())) return false;
        return true;
      });
      return ok.length ? res(true, `${ok.length} artifact(s) created`) : res(false, calls.length ? "artifacts created, none matching" : "artifact_create was not called", { actual: calls.map((c) => c.args) });
    }
    case "approval_requested": {
      const ok = trace.approvals.filter((x) => !a.tool || suiteToolMatches(a.tool, x.tool));
      return ok.length ? res(true, `approval requested for ${ok.map((x) => x.tool).join(", ")}`) : res(false, trace.approvals.length ? `approvals requested only for ${trace.approvals.map((x) => x.tool).join(", ")}` : "no approval was requested", { actual: trace.approvals.map((x) => x.tool) });
    }
    case "text_contains":
    case "text_not_contains": {
      const values = Array.isArray(a.value) ? a.value : [a.value];
      const hay = a.caseSensitive ? trace.text : trace.text.toLowerCase();
      const found = values.filter((v) => hay.includes(a.caseSensitive ? v : v.toLowerCase()));
      if (a.type === "text_contains") {
        const missing = values.filter((v) => !found.includes(v));
        return missing.length ? res(false, `the reply does not contain ${missing.map((m) => `"${m}"`).join(", ")}`, { expected: values, actual: short(trace.text) }) : res(true, "contains every value");
      }
      return found.length ? res(false, `the reply contains ${found.map((m) => `"${m}"`).join(", ")}`, { actual: short(trace.text) }) : res(true, "contains none");
    }
    case "text_regex": {
      let re: RegExp;
      try { re = new RegExp(a.pattern, a.flags); } catch { return res(false, `invalid pattern /${a.pattern}/`); }
      return re.test(trace.text) ? res(true, "matches") : res(false, `the reply does not match /${a.pattern}/${a.flags ?? ""}`, { actual: short(trace.text) });
    }
    case "max_turns": return trace.turns.length <= a.value ? res(true, `${trace.turns.length} turn(s)`) : res(false, `${trace.turns.length} model turns (max ${a.value})`, { expected: a.value, actual: trace.turns.length });
    case "max_cost": return trace.usage.costUsd <= a.usd ? res(true, `$${trace.usage.costUsd.toFixed(4)}`) : res(false, `cost $${trace.usage.costUsd.toFixed(4)} (max $${a.usd})`, { expected: a.usd, actual: trace.usage.costUsd });
    case "max_duration": return trace.durationMs <= a.ms ? res(true, `${trace.durationMs} ms`) : res(false, `took ${trace.durationMs} ms (max ${a.ms} ms)`, { expected: a.ms, actual: trace.durationMs });
    case "tool_failed": {
      const calls = (a.tool ? callsOf(a.tool) : trace.toolCalls).filter((c) => c.isError);
      const ok = calls.filter((c) => !a.contains || c.result.toLowerCase().includes(a.contains.toLowerCase()));
      if (ok.length) return res(true, `${ok[0].name} failed: ${short(ok[0].result, 200)}`);
      return res(false, calls.length ? `the failure does not mention "${a.contains}": ${short(calls[0].result, 300)}` : `no call${a.tool ? ` of ${a.tool}` : ""} failed (${calledText})`, { actual: trace.toolCalls.map((c) => ({ name: c.name, isError: c.isError })) });
    }
    case "http_called": {
      const reqs = (trace.http ?? []).filter((h) => (!a.method || h.method.toUpperCase() === a.method) && (suiteToolMatches(a.url, h.url) || (!/[*?]/.test(a.url) && h.url.includes(a.url))));
      const n = reqs.length;
      const ok = a.times === undefined ? n > 0 : n === a.times;
      const seen = (trace.http ?? []).map((h) => `${h.method} ${h.url}`);
      return ok ? res(true, `${n} matching request(s)`, { actual: n })
        : res(false, `${a.method ?? "any method"} ${a.url}: expected ${a.times ?? "≥1"} request(s), got ${n}${seen.length ? ` (sent: ${seen.slice(0, 5).join(", ")})` : " (no request was sent)"}`, { expected: a.times ?? ">=1", actual: n });
    }
    case "task_status": {
      const t = taskOf(a.task);
      if (!t) return res(false, `there is no task "${a.task}" (tasks: ${(trace.tasks ?? []).map((x) => x.title).join(", ") || "none"})`);
      return t.status === a.status ? res(true, `${a.task}: ${t.status}`) : res(false, `${a.task} is ${t.status}${t.error ? ` (${short(t.error, 200)})` : ""}, expected ${a.status}`, { expected: a.status, actual: t.status });
    }
    case "task_order": {
      const ran = (trace.tasks ?? []).filter((t) => t.status !== "skipped").map((t) => t.title);
      let j = 0;
      for (const t of ran) if (j < a.tasks.length && t === a.tasks[j]) j++;
      return j === a.tasks.length ? res(true, "in order")
        : res(false, `expected ${a.tasks.join(" → ")}; ran ${ran.join(" → ") || "nothing"}`, { expected: a.tasks, actual: ran, diff: unifiedLineDiff(a.tasks.join("\n"), ran.join("\n"), "expected", "actual") });
    }
    case "task_agent": {
      const t = taskOf(a.task);
      if (!t) return res(false, `there is no task "${a.task}"`);
      return t.agent === a.agent ? res(true, `${a.task}: ${t.agent}`) : res(false, `${a.task} was done by ${t.agent}, expected ${a.agent}`, { expected: a.agent, actual: t.agent });
    }
  }
}

function short(s: string, n = 600): string { return s.length > n ? `${s.slice(0, n)}…` : s; }

// ── Datasets ─────────────────────────────────────────────────────────

/** Numbers and booleans from text ("12.5" → 12.5, "true" → true); everything else as is. */
export function coerceCell(v: string): unknown {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return v;
}

/** Parse CSV (RFC 4180: quotes, escaped "", commas and newlines in quotes; comma or semicolon). The first line is the header. */
export function parseCsvDataset(text: string, opts: { coerce?: boolean; delimiter?: "," | ";" | "\t" } = {}): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = opts.delimiter ?? (firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : (firstLine.split(";").length > firstLine.split(",").length ? ";" : ","));
  const records: string[][] = [];
  let field = "", record: string[] = [], quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some((x) => x !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  if (quoted) throw new AgentSuiteError("CSV: a quoted field is not closed");
  record.push(field);
  if (record.some((x) => x !== "")) records.push(record);
  if (!records.length) throw new AgentSuiteError("CSV: the file is empty");
  const columns = records[0].map((c) => c.trim());
  if (columns.some((c) => !c)) throw new AgentSuiteError("CSV: every column needs a name in the first line");
  if (new Set(columns).size !== columns.length) throw new AgentSuiteError("CSV: column names must be unique");
  const rows = records.slice(1).map((r, i) => {
    if (r.length > columns.length) throw new AgentSuiteError(`CSV: line ${i + 2} has ${r.length} fields, the header ${columns.length}`);
    return Object.fromEntries(columns.map((c, j) => [c, opts.coerce === false ? (r[j] ?? "") : coerceCell(r[j] ?? "")]));
  });
  if (rows.length > SUITE_LIMITS.datasetRows) throw new AgentSuiteError(`CSV: at most ${SUITE_LIMITS.datasetRows} rows`);
  return { columns, rows };
}

/** Parse a JSON dataset: a list of objects, or { rows: [...] } (with optional columns). */
export function parseJsonDataset(text: string): { columns: string[]; rows: Array<Record<string, unknown>> } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (err) { throw new AgentSuiteError(`JSON: ${(err as Error).message}`); }
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.rows) ? data.rows : undefined;
  if (!rows || rows.some((r) => !isObj(r))) throw new AgentSuiteError("JSON: expected a list of objects (or { rows: [...] })");
  if (rows.length > SUITE_LIMITS.datasetRows) throw new AgentSuiteError(`JSON: at most ${SUITE_LIMITS.datasetRows} rows`);
  const columns = isObj(data) && Array.isArray(data.columns) ? data.columns as string[] : [...new Set((rows as Raw[]).flatMap((r) => Object.keys(r)))];
  return { columns, rows: rows as Array<Record<string, unknown>> };
}

// ── Recorded exchanges → cases (phase 5 playground, "save as a test case") ──

/**
 * A case from a recorded exchange (a trace, or a chat's messages and tool calls): the observed tool
 * calls become tool mocks answering with their observed results (exact arguments), and assertions
 * that the same tools are called with the same arguments, in order. With `mockModel`, the observed
 * model turns become the model mock (a contract case).
 */
export function caseFromTrace(trace: Pick<SuiteTrace, "input" | "toolCalls" | "turns" | "text">, opts: { id?: string; name: string; mockModel?: boolean; sessionId?: string } ): SuiteCase {
  const last = [...trace.input].reverse().find((m) => m.role === "user");
  const history = trace.input.slice(0, last ? trace.input.lastIndexOf(last) : 0)
    .filter((m): m is { role: "user" | "assistant"; content: string } => m.role === "user" || m.role === "assistant");
  const tools: ToolMock[] = trace.toolCalls.map((c, i) => ({
    id: `observed-${i + 1}`, tool: c.name, when: { args: c.args, match: "exact" }, times: 1,
    ...(c.isError ? { error: c.result.replace(/^Error:\s*/, "") } : { response: c.result }),
  }));
  const assertions: SuiteAssertion[] = trace.toolCalls.map((c) => ({ type: "tool_called", tool: c.name, args: c.args, match: "exact" }));
  if (trace.toolCalls.length > 1) assertions.push({ type: "tool_order", tools: trace.toolCalls.map((c) => c.name) });
  const model: ModelMock | undefined = opts.mockModel
    ? { turns: trace.turns.map((t) => compact({ text: t.text || undefined, toolCalls: t.toolCalls.length ? t.toolCalls.map((c) => ({ name: c.name, args: c.args })) : undefined })).filter((t) => t.text !== undefined || t.toolCalls) }
    : undefined;
  return compact({
    id: opts.id ?? suiteSlug(opts.name, "case"),
    name: opts.name,
    input: compact({ kind: "chat" as const, message: last?.content ?? "", history: history.length ? history : undefined }),
    mode: opts.mockModel ? "all" as const : "tools" as const,
    mocks: compact({ tools, model }),
    assertions,
    source: compact({ kind: "recorded" as const, sessionId: opts.sessionId, at: new Date().toISOString() }),
  });
}

export * from "./agent-suite-evals.js";
export * from "./agent-suite-gates.js";
export * from "./agent-suite-replay.js";
export * from "./agent-suite-generate.js";
export * from "./agent-suite-report.js";
export * from "./agent-suite-targets.js";
export * from "./agent-suite-bench.js";
