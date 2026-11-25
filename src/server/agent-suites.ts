/**
 * Agent suites (the agent page's Suites tab, /agents/:name/suites…, MCP polpo_agent_suite_*,
 * Polpo's agent_suite_* chat tools): save suites of cases, run them against an agent version,
 * keep the runs with a trace per case.
 *
 * Each case runs as a real chat turn with the agent (the in-process chat completions pipeline: the
 * same prompt, memory, tools, connectors and engine the agent's chats use) inside the case's hooks
 * (src/core/agent-suite-context.ts): scripted model turns, tool mocks matched before any tool runs,
 * budgets. The turn's chat is deleted afterwards (a test run is not a conversation).
 *
 * Phase 4:
 *   cassettes        a recording run (record: true, live) saves each case's exchange, secrets
 *                    redacted; replaying cases answer their tools (and model turns) from it
 *   simulated users  multi-turn cases: after each reply a model (or a script) writes the next user turn
 *   generation       proposed cases and dataset rows (never saved by themselves)
 *   targets          a hosted MCP server's saved tests (tool calls with HTTP mocks) and missions
 *                    (their tasks in dependency order, each agent with its own mocks)
 *
 * Engines:
 *   native   Polpo's engine: model mocks and tool mocks for every tool
 *   harness  chats run on Polpo's engine with the agent's model (docs/harnesses.md): as native
 *   cli      the official claude / codex program: its model cannot be scripted (modes model / all
 *            refused); Polpo's tools it uses are mocked, its own (Bash, Read, Edit…) run for real
 */
import { randomUUID } from "node:crypto";
import {
  AgentSuiteError, SIMULATED_USER_LIMITS, SUITE_LIMITS, SUITE_STUBBED_TOOLS,
  agentCliEngine, agentHarness, agentMocksFor, caseMessages, caseOverallScore, cassetteFromTrace, cassetteIdFor, cassetteIdsToTry,
  cassetteScript, caseGenerationPrompt, compareSuiteRuns, datasetRowsPrompt, dependencyOrder, editCassette, evaluateAssertion, findHttpMock, findToolMock,
  httpMockResponse, matchCassetteCall, missionTaskMessage, modeMocksModel, modeMocksTools, parseAgentSuite, parseCsvDataset, parseGeneratedCases,
  parseGeneratedRows, parseJsonDataset, parseSimulatedUserReply, parseSuiteCase, parseSuiteOwner, pickSuiteBaseline, planSuiteCases, planUsesRealTools,
  recordedCase, redactCassetteSecrets, scoreSuiteCase, simulatedUserPrompt, suiteRunAggregates, suiteRunReviewPrompt, suiteRunStats, suiteRunStatus, suiteSlug,
  suiteTargetFor, suiteTrend, toolMockResult, traceFromChat, traceFromTaskActivity,
  type ActivityEntryLike, type AgentConfig, type AgentGenerationInfo, type AgentSuite, type AgentSuiteStore, type CaseGenerationRequest,
  type CassetteCallEdit, type ChatMessageLike, type GeneratedCaseProposal, type MissionTaskLike, type PlannedCase, type ScorerDeps,
  type ScriptedTurn, type SuiteAssertionResult, type SuiteBaselineComparison, type SuiteCase, type SuiteCaseResult, type SuiteCassetteRecord,
  type SuiteEngine, type SuiteMocks, type SuiteRun, type SuiteRunListOptions, type SuiteRunRequest, type SuiteTrace, type SuiteTraceHttp,
  type SuiteTraceTask, type SuiteTraceToolCall, type SuiteTraceTurn, type SuiteTranscriptMessage, type SuiteTrend, type SuiteVariant,
} from "@polpo-ai/core";
import { applySuiteOverrides, runAsSuiteCase, type SuiteCaseHooks } from "../core/agent-suite-context.js";

/** A tool call as the chat persisted it. */
export interface SessionToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state?: string;
}

/** What one chat turn returned. */
export interface SuiteTurnResult {
  text: string;
  /** stop, or why the turn stopped for a person (email_preview, ask_user…). */
  finishReason?: string;
  /** The tool calls the chat persisted (to see the calls that never reached the executor). */
  toolCalls: SessionToolCall[];
}

/** One call of a hosted server's tool for a suite case (see McpServerService.suiteCall). */
export interface HostedToolCallResult {
  ok: boolean;
  text: string;
  error?: string;
  ms: number;
  status?: number;
  skipped?: string;
}

/** A model completion (the simulated user, case generation). */
export type SuiteCompletion = (req: { prompt: string; model?: string }) => Promise<{ text: string; model?: string; costUsd?: number }>;

export interface AgentSuiteDeps {
  store: AgentSuiteStore;
  agents: () => Promise<AgentConfig[]>;
  /** The agent at a ref (production: undefined, "draft", "1.2.0"); throws when the version does not exist. */
  resolveAgent: (name: string, ref?: string) => Promise<AgentConfig | undefined>;
  /** The production version of a versioned agent. */
  productionVersion?: (name: string) => Promise<string | undefined>;
  /**
   * One chat turn with the agent (`agent`, `agent@draft`, `agent@1.2.0`) through the chat
   * completions pipeline, run inside the case's hooks; the chat is deleted afterwards.
   */
  turn: (agentRef: string, messages: Array<{ role: string; content: string }>, hooks: SuiteCaseHooks) => Promise<SuiteTurnResult>;
  /** Runs at once on this instance (default 2). */
  maxRunningRuns?: number;
  /**
   * The LLM judge of llm_judge scorers: one completion at temperature 0 (`model`: the scorer's or
   * the suite's judge model; undefined: the orchestrator's effective model). Absent: judges error.
   */
  judge?: ScorerDeps["judge"];
  /** Runs a custom scorer's code in the sandboxed code worker. Absent: custom scorers error. */
  customScorer?: ScorerDeps["custom"];
  /** "Explain this run": one completion with the orchestrator's effective model. */
  review?: (prompt: string) => Promise<{ text: string; model?: string; costUsd?: number }>;
  /** The simulated user's model (`model`: the case's, else the suite's simulatorModel; undefined: Polpo's model). */
  simulate?: SuiteCompletion;
  /** Case and dataset generation: one completion with Polpo's model. */
  generate?: SuiteCompletion;
  /** The vault's secret values: redacted from every recording. */
  secrets?: () => Promise<string[]>;
  /** What the case generator knows about an agent (its tools with descriptions, skills, connectors). */
  agentInfo?: (agent: AgentConfig) => Promise<AgentGenerationInfo>;
  /** A chat session's messages (record a case from a real chat). */
  sessionMessages?: (sessionId: string) => Promise<{ agent?: string; title?: string; messages: ChatMessageLike[] } | undefined>;
  /** A task and its runs' activity (record a case from a task run). */
  taskActivity?: (taskId: string) => Promise<{ title: string; description: string; assignTo?: string; entries: ActivityEntryLike[] } | undefined>;
  /** Targets other than an agent. */
  targets?: {
    mcpServer?: {
      exists: (id: string) => boolean;
      /** The suite (saved tests) of a server: read and write its own storage (tests.json, server.json). */
      readSuite: (id: string) => AgentSuite;
      writeSuite: (suite: AgentSuite) => void;
      /** production's version, or undefined. */
      production: (id: string) => string | undefined;
      /** The tools at a ref (undefined: nothing at that ref). */
      tools: (id: string, ref: string) => Record<string, { kind: "http" | "code"; sensitive: boolean }> | undefined;
      call: (id: string, opts: { ref: string; tool: string; input: Record<string, unknown>; fetch: (url: string, init: RequestInit) => Promise<Response>; mockedHttp: boolean; actor?: string }) => Promise<HostedToolCallResult>;
    };
    mission?: {
      exists: (id: string) => Promise<boolean>;
      /** The mission's name and tasks (its current document). */
      document: (id: string) => Promise<{ name: string; tasks: MissionTaskLike[]; notes?: string[] } | undefined>;
      /** The agent a task without assignTo goes to. */
      defaultAgent?: () => Promise<string | undefined>;
    };
  };
}

export interface RunOptions {
  actor?: string;
  /** May the run touch real tools (modes none / model, or unmocked tools run for real)? Admins only. */
  allowRealTools?: boolean;
  /** Called after each case (the run so far): deploy gates report their progress. */
  onProgress?: (run: SuiteRun) => void;
}

const INTERACTIVE_REASONS = new Set(["ask_user", "email_preview", "whatsapp_preview", "vault_preview", "mission_preview"]);

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }

function engineOf(agent: AgentConfig): SuiteEngine {
  if (agentCliEngine(agent)) return "cli";
  if (agentHarness(agent)) return "harness";
  return "native";
}

/** The model script a case plays: its own model mock, else its cassette's turns (replay). */
function scriptFor(plan: PlannedCase, cassette: SuiteCassetteRecord | undefined): ScriptedTurn[] {
  if (plan.mocks.model) return plan.mocks.model.turns;
  if (cassette && plan.mocks.cassette?.model !== false) return cassetteScript(cassette);
  return [];
}

/** The hooks of one case (or one mission task): mocks, cassette, budgets and the trace being written. */
class CaseRecorder implements SuiteCaseHooks {
  readonly mocksModel: boolean;
  readonly turns: SuiteTraceTurn[] = [];
  readonly toolCalls: SuiteTraceToolCall[] = [];
  readonly notes: string[] = [];
  readonly approvals: SuiteTrace["approvals"] = [];
  /** Cassette replay: what it answered and what it could not. */
  readonly replay = { calls: 0, turns: 0, unmatched: [] as string[] };
  private readonly script: ScriptedTurn[];
  private exhausted = false;
  private callsPerTool = new Map<string, number>();
  private mockUse = new Map<number, number>();
  private cassetteUsed = new Set<string>();
  private cost = 0;
  private readonly t0 = Date.now();
  cancelled?: string;
  stoppedBy?: string;

  constructor(
    readonly plan: PlannedCase,
    readonly overrides: SuiteRun["variant"]["overrides"],
    private readonly engine: SuiteEngine,
    private readonly opts: { cassette?: SuiteCassetteRecord; agent?: string; cursor?: { n: number } } = {},
  ) {
    this.mocksModel = modeMocksModel(plan.mode);
    this.script = scriptFor(plan, opts.cassette);
    this.cursor = opts.cursor ?? { n: 0 };
  }

  private readonly cursor: { n: number };

  get scriptExhausted(): boolean { return this.exhausted; }
  get spentUsd(): number { return this.cost; }

  budgetExceeded(): string | undefined {
    if (this.cancelled) return this.cancelled;
    const b = this.plan.budgets;
    let reason: string | undefined;
    if (this.turns.length >= b.maxTurns) reason = `budget: ${b.maxTurns} model turns`;
    else if (b.maxCostUsd !== undefined && this.cost >= b.maxCostUsd) reason = `budget: $${b.maxCostUsd}`;
    else if (Date.now() - this.t0 >= b.maxDurationMs) reason = `budget: ${b.maxDurationMs} ms`;
    if (reason && !this.stoppedBy) { this.stoppedBy = reason; this.notes.push(`Stopped by the ${reason}`); }
    return reason;
  }

  nextScriptedTurn(): ScriptedTurn | undefined {
    // a mission's agent continues its script across its tasks (a shared cursor)
    const cursor = this.cursor;
    if (cursor.n < this.script.length) {
      const turn = this.script[cursor.n++];
      if (!this.plan.mocks.model && this.opts.cassette) this.replay.turns++;
      return turn;
    }
    if (!this.exhausted) {
      this.exhausted = true;
      const what = this.plan.mocks.model ? "The model script" : this.opts.cassette ? `The cassette ${this.opts.cassette.id}` : "";
      this.notes.push(what ? `${what} ended after ${this.script.length} turn(s)` : "This case mocks the model but has no scripted turns (and no cassette)");
    }
    return undefined;
  }

  recordTurn(turn: Omit<SuiteTraceTurn, "index">): void {
    this.turns.push({ index: this.turns.length, ...turn, ...(this.opts.agent ? { agent: this.opts.agent } : {}) });
    this.cost += turn.usage?.costUsd ?? 0;
  }

  async toolCall(name: string, args: Record<string, unknown>, run: () => Promise<string>, callId?: string): Promise<string> {
    const n = (this.callsPerTool.get(name) ?? 0) + 1;
    this.callsPerTool.set(name, n);
    const callIndex = this.toolCalls.length;
    const t0 = Date.now();
    const turn = Math.max(0, this.turns.length - 1);
    const id = callId ?? `call-${this.toolCalls.length + 1}`;
    const record = (result: string, mocked: SuiteTraceToolCall["mocked"], extra: Partial<SuiteTraceToolCall> = {}) => {
      const isError = result.startsWith("Error:");
      const approval = !isError && /^Queued for approval/i.test(result) ? "queued" as const : undefined;
      if (approval) this.approvals.push({ tool: name, kind: approval, detail: result.slice(0, 300) });
      this.toolCalls.push({ id, turn, name, args, result, isError, mocked, durationMs: Date.now() - t0, ...(approval ? { approval } : {}), ...(this.opts.agent ? { agent: this.opts.agent } : {}), ...extra });
      return result;
    };
    if (this.cancelled) return record(`Error: the test run was cancelled: ${name} did not run.`, "blocked");
    // the CLI program's model cannot be scripted, but Polpo's tools it calls go through here too
    if (modeMocksTools(this.plan.mode)) {
      const hit = findToolMock(this.plan.mocks.tools ?? [], name, args, n, this.mockUse);
      if (hit) {
        if (hit.mock.delayMs) await new Promise((r) => setTimeout(r, hit.mock.delayMs));
        const { text } = toolMockResult(hit.mock, { args, row: this.plan.row?.values ?? {} });
        return record(text, "mock", { mockId: hit.mock.id ?? `${hit.mock.tool}#${hit.index + 1}` });
      }
      const cassette = this.opts.cassette;
      if (cassette) {
        const rec = matchCassetteCall(cassette.calls, name, args, { match: this.plan.mocks.cassette?.match, used: this.cassetteUsed, callIndex });
        if (rec) {
          this.replay.calls++;
          return record(rec.isError && !rec.response.startsWith("Error:") ? `Error: ${rec.response}` : rec.response, "cassette", { mockId: `${cassette.id}#${rec.id}` });
        }
      }
      const stub = SUITE_STUBBED_TOOLS[name];
      if (stub) return record(stub, "stub");
      if (cassette) {
        this.replay.unmatched.push(name);
        this.notes.push(`${name} has no recording in the cassette ${cassette.id} matching these arguments (match ${this.plan.mocks.cassette?.match ?? "exact"}): ${this.plan.mocks.cassette?.onUnmatched === "fail" ? "the case fails" : "blocked"}`);
        return record(`Error: ${name} has no recorded answer in this test's cassette for these arguments, so it did not run.`, "blocked");
      }
      if (this.plan.mode === "tools" && this.plan.mocks.unmockedTools === "real") return record(await runReal(run), false);
      this.notes.push(`${name} was called with no matching mock: blocked`);
      return record(`Error: ${name} is not mocked in this test (mode ${this.plan.mode}), so it did not run. No mock matched these arguments.`, "blocked");
    }
    void this.engine;
    return record(await runReal(run), false);
  }
}

async function runReal(run: () => Promise<string>): Promise<string> {
  try { return await run(); } catch (err) { return `Error: ${errorText(err)}`; }
}

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); timer.unref?.(); }),
  ]);
}

/** Bounded parallel map, in order. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** The calls of a turn that never reached the executor (invalid arguments, a send stopped for a person's yes), and the interactive stop. */
function absorbReply(recorder: CaseRecorder, reply: SuiteTurnResult | undefined, opts: { agent?: string; firstTurn?: number } = {}): void {
  const seen = new Set(recorder.toolCalls.map((c) => c.id));
  for (const c of reply?.toolCalls ?? []) {
    if (seen.has(c.id)) continue;
    const interactive = c.state === "interrupted";
    if (interactive) recorder.approvals.push({ tool: c.name, kind: "interactive" });
    const turnIdx = Math.max(opts.firstTurn ?? 0, recorder.turns.findIndex((t) => t.toolCalls.some((x) => x.id === c.id)));
    recorder.toolCalls.push({
      id: c.id, turn: turnIdx, name: c.name, args: c.arguments ?? {}, result: c.result ?? (interactive ? "Waiting for a person (not run)" : ""),
      isError: c.state === "error", mocked: false, durationMs: 0, ...(interactive ? { approval: "interactive" as const } : {}), ...(opts.agent ? { agent: opts.agent } : {}),
    });
  }
  if (reply?.finishReason && INTERACTIVE_REASONS.has(reply.finishReason) && !recorder.approvals.some((a) => a.kind === "interactive")) {
    recorder.approvals.push({ tool: reply.finishReason.replace(/_preview$/, "_send"), kind: "interactive", detail: reply.finishReason });
  }
}

const usageOf = (turns: SuiteTraceTurn[]) => turns.reduce((u, t) => ({
  inputTokens: u.inputTokens + (t.usage?.inputTokens ?? 0), outputTokens: u.outputTokens + (t.usage?.outputTokens ?? 0), costUsd: u.costUsd + (t.usage?.costUsd ?? 0),
}), { inputTokens: 0, outputTokens: 0, costUsd: 0 });

/** What a case runs against: an agent ref, a hosted server at a ref, a mission. */
type RunContext =
  | { kind: "agent"; agent: string; agentRef: string; engine: SuiteEngine }
  | { kind: "mcp-server"; server: string; ref: string; tools: Record<string, { kind: "http" | "code"; sensitive: boolean }>; allowRealTools: boolean; actor?: string }
  | { kind: "mission"; mission: string; name: string; tasks: MissionTaskLike[]; defaultAgent?: string; notes: string[] };

export class AgentSuiteRunner {
  private running = new Map<string, { cancel: (reason: string) => void; done: Promise<SuiteRun> }>();
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly deps: AgentSuiteDeps) {}

  /** Where suites, runs and deploy gates are kept. */
  get store(): AgentSuiteStore { return this.deps.store; }

  // ── owners: an agent, a hosted server (mcp-server:<id>), a mission (mission:<id>) ──

  private async ownerExists(owner: string): Promise<void> {
    const o = parseSuiteOwner(owner);
    if (o.kind === "mcp-server") {
      if (!this.deps.targets?.mcpServer) throw new AgentSuiteError("Hosted MCP server suites are not available on this server", "CONFLICT");
      if (!this.deps.targets.mcpServer.exists(o.id)) throw new AgentSuiteError(`No hosted server "${o.id}"`, "NOT_FOUND");
      return;
    }
    if (o.kind === "mission") {
      if (!this.deps.targets?.mission) throw new AgentSuiteError("Mission suites are not available on this server", "CONFLICT");
      if (!(await this.deps.targets.mission.exists(o.id))) throw new AgentSuiteError(`No mission "${o.id}"`, "NOT_FOUND");
      return;
    }
    if (o.kind === "team") throw new AgentSuiteError("Suites that target a team are not supported yet", "CONFLICT");
    if (!(await this.deps.agents()).some((a) => a.name === owner)) throw new AgentSuiteError(`Agent "${owner}" not found`, "NOT_FOUND");
  }

  /** A hosted server's suite lives in its own storage (its saved tests). */
  private hosted(owner: string): NonNullable<NonNullable<AgentSuiteDeps["targets"]>["mcpServer"]> | undefined {
    return parseSuiteOwner(owner).kind === "mcp-server" ? this.deps.targets?.mcpServer : undefined;
  }

  // ── suites ──

  async listSuites(agent: string): Promise<AgentSuite[]> {
    const hosted = this.hosted(agent);
    if (hosted) {
      await this.ownerExists(agent);
      return [hosted.readSuite(parseSuiteOwner(agent).id)];
    }
    return (await this.deps.store.listSuites(agent)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSuite(agent: string, id: string): Promise<AgentSuite> {
    const hosted = this.hosted(agent);
    if (hosted) {
      await this.ownerExists(agent);
      const s = hosted.readSuite(parseSuiteOwner(agent).id);
      if (s.id !== id) throw new AgentSuiteError(`A hosted server has one suite, its saved tests ("${s.id}"): there is no "${id}"`, "NOT_FOUND");
      return s;
    }
    const s = await this.deps.store.getSuite(agent, id);
    if (!s) throw new AgentSuiteError(`${agent} has no suite "${id}"`, "NOT_FOUND");
    return s;
  }

  /**
   * Create or replace a suite (validated; ids made from names). `revision`: the revision the edit
   * started from (a newer saved revision refuses the save: someone else changed it).
   */
  async saveSuite(agent: string, input: unknown, opts: { actor?: string; revision?: number; create?: boolean; admin?: boolean } = {}): Promise<AgentSuite> {
    await this.ownerExists(agent);
    const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const hosted = this.hosted(agent);
    const id = typeof raw.id === "string" && raw.id ? raw.id : typeof raw.name === "string" ? suiteSlug(raw.name) : undefined;
    const existing = hosted ? hosted.readSuite(parseSuiteOwner(agent).id) : id ? await this.deps.store.getSuite(agent, id) : undefined;
    if (hosted && id && id !== existing!.id) throw new AgentSuiteError(`A hosted server has one suite, its saved tests: save it as "${existing!.id}"`);
    if (existing && opts.create && !hosted) throw new AgentSuiteError(`${agent} already has a suite "${id}"`, "CONFLICT");
    if (existing && opts.revision !== undefined && opts.revision !== existing.revision) {
      throw new AgentSuiteError(`The suite changed since you opened it (revision ${existing.revision}, yours ${opts.revision}): reload it and apply your edit again`, "CONFLICT");
    }
    const target = suiteTargetFor(agent);
    const suite = parseAgentSuite({ ...raw, ...(hosted ? { id: existing!.id, name: raw.name ?? existing!.name } : {}), target }, agent, existing);
    // a deploy gate that may run real tools (side effects at every deploy): an admin decides
    if (suite.gate?.allowRealTools && !existing?.gate?.allowRealTools && opts.admin !== true) {
      throw new AgentSuiteError("gate.allowRealTools lets every deploy run this suite's real tools (side effects possible): only an admin can turn it on", "FORBIDDEN");
    }
    if (opts.actor) suite.updatedBy = opts.actor;
    if (hosted) {
      const bad = suite.cases.find((c) => c.input.kind !== "tool" || !c.input.tool);
      if (bad) throw new AgentSuiteError(`Case "${bad.name}": a hosted server's test calls one of its tools (input: { kind: tool, tool, args })`);
      hosted.writeSuite(suite);
      return suite;
    }
    if (target.kind === "mission") {
      const bad = suite.cases.find((c) => c.input.kind !== "mission");
      if (bad) throw new AgentSuiteError(`Case "${bad.name}": a mission's case runs the mission (input: { kind: mission, message? })`);
    }
    await this.deps.store.saveSuite(suite);
    return suite;
  }

  async deleteSuite(agent: string, id: string): Promise<void> {
    if (this.hosted(agent)) throw new AgentSuiteError("A hosted server's suite is its saved tests: remove its cases instead", "CONFLICT");
    if (!(await this.deps.store.deleteSuite(agent, id))) throw new AgentSuiteError(`${agent} has no suite "${id}"`, "NOT_FOUND");
  }

  /** Import a dataset into a suite from CSV or JSON (a new dataset, or replace / append rows of one). */
  async importDataset(agent: string, suiteId: string, req: { format: "csv" | "json"; text: string; id?: string; name?: string; mode?: "replace" | "append"; coerce?: boolean }, opts: { actor?: string } = {}): Promise<AgentSuite> {
    const suite = await this.getSuite(agent, suiteId);
    const parsed = req.format === "csv" ? parseCsvDataset(req.text, { coerce: req.coerce }) : parseJsonDataset(req.text);
    const name = req.name?.trim() || req.id || `Dataset ${suite.datasets.length + 1}`;
    const id = req.id ?? suiteSlug(name, "dataset");
    const datasets = [...suite.datasets];
    const at = datasets.findIndex((d) => d.id === id);
    const source = { kind: req.format, at: new Date().toISOString() } as const;
    if (at >= 0 && req.mode === "append") {
      const d = datasets[at];
      datasets[at] = { ...d, columns: [...new Set([...d.columns, ...parsed.columns])], rows: [...d.rows, ...parsed.rows], source };
    } else if (at >= 0) {
      datasets[at] = { ...datasets[at], columns: parsed.columns, rows: parsed.rows, source };
    } else {
      datasets.push({ id, name, columns: parsed.columns, rows: parsed.rows, source });
    }
    return this.saveSuite(agent, { ...suite, datasets }, { actor: opts.actor, revision: suite.revision, admin: true });
  }

  // ── runs ──

  listRuns(agent: string, opts?: SuiteRunListOptions): Promise<SuiteRun[]> { return this.deps.store.listRuns(agent, opts); }

  async getRun(agent: string, id: string): Promise<SuiteRun> {
    const r = await this.deps.store.getRun(agent, id);
    if (!r) throw new AgentSuiteError(`${agent} has no suite run "${id}"`, "NOT_FOUND");
    return r;
  }

  /** Stop a running run: cases not started are skipped, the running ones stop before their next model call or tool. */
  async cancelRun(agent: string, id: string): Promise<SuiteRun> {
    const live = this.running.get(id);
    if (!live) {
      const r = await this.getRun(agent, id);
      if (r.status === "running" || r.status === "queued") {
        // a run left over by a restart
        const fixed: SuiteRun = { ...r, status: "cancelled", finishedAt: new Date().toISOString(), notes: [...r.notes, "Cancelled (the server restarted during the run)"] };
        await this.deps.store.saveRun(fixed);
        return fixed;
      }
      return r;
    }
    live.cancel("cancelled");
    return live.done;
  }

  /** What the run executes against, by the suite's target. */
  private async runContext(owner: string, suite: AgentSuite, target: string, req: SuiteRunRequest, opts: RunOptions): Promise<{ ctx: RunContext; version?: string; notes: string[] }> {
    const kind = suite.target.kind;
    if (kind === "agent") {
      const ref = target === "production" ? undefined : target;
      let config: AgentConfig | undefined;
      try { config = await this.deps.resolveAgent(owner, ref); } catch (err) { throw new AgentSuiteError(errorText(err), "NOT_FOUND"); }
      if (!config) throw new AgentSuiteError(`Agent "${owner}" not found`, "NOT_FOUND");
      const engine = engineOf(applySuiteOverrides(config, req.overrides));
      const version = target === "production" ? await this.deps.productionVersion?.(owner).catch(() => undefined) : target === "draft" ? undefined : target;
      const notes: string[] = [];
      if (engine === "harness") notes.push("This agent runs its tasks on a harness; its chats (and these cases) run on Polpo's engine with its model.");
      if (engine === "cli") notes.push("CLI engine: the official program's model cannot be scripted; Polpo's tools it calls are mocked, its own tools (Bash, Read, Edit…) run for real.");
      return { ctx: { kind: "agent", agent: owner, agentRef: ref ? `${owner}@${ref}` : owner, engine }, ...(version ? { version } : {}), notes };
    }
    if (kind === "mcp-server") {
      const hosted = this.deps.targets?.mcpServer;
      if (!hosted) throw new AgentSuiteError("Hosted MCP server suites are not available on this server", "CONFLICT");
      const id = parseSuiteOwner(owner).id;
      const tools = hosted.tools(id, target);
      if (!tools) throw new AgentSuiteError(`${id} has nothing at "${target}"`, "NOT_FOUND");
      const version = target === "production" ? hosted.production(id) : target === "draft" ? undefined : target;
      return { ctx: { kind: "mcp-server", server: id, ref: target, tools, allowRealTools: opts.allowRealTools === true, ...(opts.actor ? { actor: opts.actor } : {}) }, ...(version ? { version } : {}), notes: [] };
    }
    if (kind === "mission") {
      const mission = this.deps.targets?.mission;
      if (!mission) throw new AgentSuiteError("Mission suites are not available on this server", "CONFLICT");
      const id = parseSuiteOwner(owner).id;
      const doc = await mission.document(id);
      if (!doc) throw new AgentSuiteError(`No mission "${id}"`, "NOT_FOUND");
      if (target !== "production") throw new AgentSuiteError("A mission suite runs the mission with its agents' production versions: no target");
      const defaultAgent = await mission.defaultAgent?.().catch(() => undefined);
      const notes = [
        "Mission test mode: tasks run one at a time in dependency order, each as a turn of its agent with that agent's mocks (not through the task runner: no sandbox, no review loop, no retries).",
        ...(doc.notes ?? []),
      ];
      return { ctx: { kind: "mission", mission: id, name: doc.name, tasks: doc.tasks, ...(defaultAgent ? { defaultAgent } : {}), notes: doc.notes ?? [] }, notes };
    }
    throw new AgentSuiteError(`Suites that target a ${kind} are not supported yet`, "CONFLICT");
  }

  /** The cassette each planned case replays (loaded once per run). */
  private async cassettesFor(owner: string, planned: PlannedCase[], run: SuiteRun): Promise<Map<string, SuiteCassetteRecord>> {
    const out = new Map<string, SuiteCassetteRecord>();
    for (const p of planned) {
      const ref = p.mocks.cassette;
      if (!ref || run.record) continue;
      let found: SuiteCassetteRecord | undefined;
      for (const id of cassetteIdsToTry(ref, p.row?.index)) {
        found = await this.deps.store.getCassette(owner, id);
        if (found) break;
      }
      if (found) out.set(p.key, found);
    }
    return out;
  }

  /**
   * Start a run of a suite (or some of its cases) against the agent at `target`, with the variant's
   * overrides. Returns the run as soon as it is recorded; `done` resolves when it finishes.
   */
  async startRun(agent: string, suiteId: string, req: SuiteRunRequest = {}, opts: RunOptions = {}): Promise<{ run: SuiteRun; done: Promise<SuiteRun> }> {
    const suite = await this.getSuite(agent, suiteId);
    const target = req.target?.trim() || (suite.target.kind === "mcp-server" ? "draft" : "production");
    if (req.repetitions !== undefined && (!Number.isInteger(req.repetitions) || req.repetitions < 1 || req.repetitions > SUITE_LIMITS.maxRepetitions)) {
      throw new AgentSuiteError(`repetitions must be a whole number from 1 to ${SUITE_LIMITS.maxRepetitions}`);
    }
    if (req.record) {
      if (suite.target.kind !== "agent") throw new AgentSuiteError("Recording cassettes is for agent suites (a hosted server's tests use HTTP mocks)");
      if (!opts.allowRealTools) throw new AgentSuiteError("Recording runs the cases live (real model, real tools: side effects possible): it needs the admin scope and a confirmation", "FORBIDDEN");
    }
    if (req.baselineRunId) await this.getRun(agent, req.baselineRunId);
    const { ctx, version, notes } = await this.runContext(agent, suite, target, req, opts);
    const planned = planSuiteCases(suite, {
      ...(req.caseIds ? { caseIds: req.caseIds } : {}), ...(req.record ? { mode: "none" as const } : req.mode ? { mode: req.mode } : {}),
      ...(req.record ? { repetitions: 1 } : req.repetitions ? { repetitions: req.repetitions } : {}),
    });
    if (!planned.length) throw new AgentSuiteError(`${suite.name} has no cases to run`);
    const realTools = planUsesRealTools(planned)
      || (ctx.kind === "agent" && ctx.engine === "cli" && planned.some((p) => p.mode === "tools"))
      || (ctx.kind === "mcp-server" && planned.some((p) => p.case.input.tool && ctx.tools[p.case.input.tool]?.kind === "code" && !modeMocksTools(p.mode)));
    if (realTools && !opts.allowRealTools) {
      throw new AgentSuiteError("This run would use real tools (a case in mode none or model, unmocked tools or HTTP run for real, or the CLI engine's own tools): "
        + "it needs the admin scope. Run it in mode all (offline) or tools (mocked tools), or ask an admin.", "FORBIDDEN");
    }
    const variant: SuiteVariant = {
      id: req.variant?.id ?? `${agent}@${target}${req.overrides ? `+${Object.keys(req.overrides).sort().join("+")}` : ""}`,
      ...(req.variant?.label ? { label: req.variant.label } : {}),
      agent, version: target,
      ...(req.overrides ? { overrides: req.overrides } : {}),
    };
    const run: SuiteRun = {
      id: `sr-${randomUUID().slice(0, 12)}`,
      agent, suiteId: suite.id, suiteName: suite.name, suiteRevision: suite.revision,
      target, ...(version ? { version } : {}),
      variant,
      ...(req.benchmarkRunId ? { benchmarkRunId: req.benchmarkRunId } : {}),
      ...(req.repetition !== undefined ? { repetition: req.repetition } : {}),
      trigger: req.record ? "record" : req.trigger ?? "manual",
      status: "queued",
      startedAt: new Date().toISOString(),
      ...(opts.actor ? { actor: opts.actor } : {}),
      planned: planned.map((p) => p.key),
      results: [],
      stats: suiteRunStats([]),
      ...(planned.some((p) => p.attempt) ? { repetitions: Math.max(...planned.map((p) => p.attempt ?? 1)) } : {}),
      ...(suite.target.kind !== "agent" ? { targetKind: suite.target.kind } : {}),
      ...(req.record ? { record: true } : {}),
      notes: [...notes],
    };
    if (planned.some((p) => p.case.scorers?.some((x) => x.type === "llm_judge")) && !this.deps.judge) run.notes.push("No LLM judge on this server: llm_judge scorers error.");
    if (req.record) run.notes.push("Recording: the cases ran live (real model, real tools); each one's exchange is saved as its cassette (secrets redacted) and the case replays it from now on.");
    await this.deps.store.saveRun(run);
    const cassettes = await this.cassettesFor(agent, planned, run);
    const secrets = req.record ? await this.deps.secrets?.().catch(() => [] as string[]) ?? [] : [];

    let cancelled: string | undefined;
    const recorders = new Set<CaseRecorder>();
    const done = (async (): Promise<SuiteRun> => {
      await this.acquire();
      try {
        if (cancelled) { run.status = "cancelled"; return run; }
        run.status = "running";
        await this.deps.store.saveRun(run);
        const concurrency = Math.min(SUITE_LIMITS.maxConcurrency, req.concurrency ?? suite.concurrency ?? 1);
        let saving = Promise.resolve();
        const recorded: Array<{ caseId: string; base: string }> = [];
        await pool(planned, concurrency, async (p) => {
          const hooks = { onStart: (r: CaseRecorder) => { recorders.add(r); if (cancelled) r.cancelled = cancelled; }, onEnd: (r: CaseRecorder) => recorders.delete(r) };
          const engine: SuiteEngine = ctx.kind === "agent" ? ctx.engine : "native";
          let result = cancelled
            ? this.skipped(p, engine, variant.id, `Not run: the run was ${cancelled}`)
            : await this.runCase(p, ctx, variant, suite, hooks, cassettes.get(p.key));
          if (req.record && result.status !== "skipped" && !result.error) {
            result = await this.saveRecording(agent, suite, p, result, run, secrets, opts.actor).catch((err) => ({ ...result, trace: { ...result.trace, notes: [...result.trace.notes, `The cassette could not be saved: ${errorText(err)}`] } }));
            if (result.trace.recorded) recorded.push({ caseId: p.case.id, base: cassetteIdFor(p.case.id) });
          }
          run.results.push(result);
          run.results.sort((a, b) => run.planned.indexOf(a.key) - run.planned.indexOf(b.key));
          run.stats = suiteRunStats(run.results);
          run.aggregates = suiteRunAggregates(run.results, { flakyStddev: suite.evals?.flakyStddev });
          saving = saving.then(() => this.deps.store.saveRun(run)).catch(() => undefined);
          try { opts.onProgress?.(run); } catch { /* a listener's problem is not the run's */ }
          return result;
        });
        await saving;
        if (recorded.length) await this.pointCasesAtCassettes(agent, suite.id, recorded, opts.actor).catch((err) => { run.notes.push(`The cases could not be pointed at their cassettes: ${errorText(err)}`); });
        run.status = cancelled ? "cancelled" : suiteRunStatus(run.results);
        if (!cancelled && !req.record) {
          const cmp = await this.baselineFor(run, suite, req).catch((err) => { run.notes.push(`The comparison with the baseline failed: ${errorText(err)}`); return undefined; });
          if (cmp) run.baseline = cmp;
        }
      } catch (err) {
        run.status = "errored";
        run.error = errorText(err);
      } finally {
        run.finishedAt = new Date().toISOString();
        run.stats = suiteRunStats(run.results);
        run.aggregates = suiteRunAggregates(run.results, { flakyStddev: suite.evals?.flakyStddev });
        await this.deps.store.saveRun(run).catch(() => undefined);
        this.running.delete(run.id);
        this.release();
      }
      return run;
    })();
    this.running.set(run.id, {
      cancel: (reason) => { cancelled = reason; for (const r of recorders) r.cancelled = reason; },
      done,
    });
    return { run: { ...run }, done };
  }

  /** Start a run and wait for it. */
  async run(agent: string, suiteId: string, req: SuiteRunRequest = {}, opts: RunOptions = {}): Promise<SuiteRun> {
    return (await this.startRun(agent, suiteId, req, opts)).done;
  }

  private async acquire(): Promise<void> {
    const max = this.deps.maxRunningRuns ?? 2;
    if (this.active < max) { this.active++; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  private skipped(p: PlannedCase, engine: SuiteEngine, variantId: string, why: string): SuiteCaseResult {
    return {
      key: p.key, caseId: p.case.id, caseName: p.case.name, ...(p.row ? { row: p.row } : {}), ...(p.attempt ? { attempt: p.attempt } : {}),
      status: "skipped", mode: p.mode, engine, assertions: [],
      trace: { input: [], turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 0, notes: why ? [why] : [] },
      startedAt: new Date().toISOString(), durationMs: 0, costUsd: 0, variantId,
    };
  }

  private async runCase(p: PlannedCase, ctx: RunContext, variant: SuiteVariant, suite: AgentSuite, hooks: { onStart: (r: CaseRecorder) => void; onEnd: (r: CaseRecorder) => void }, cassette: SuiteCassetteRecord | undefined): Promise<SuiteCaseResult> {
    const engine: SuiteEngine = ctx.kind === "agent" ? ctx.engine : "native";
    if (p.case.skip) return this.skipped(p, engine, variant.id, "Skipped (skip: true)");
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let out: { trace: SuiteTrace; error?: string; extra?: SuiteAssertionResult[]; skipped?: string };
    if (ctx.kind === "mcp-server") out = await this.runToolCase(p, ctx);
    else if (ctx.kind === "mission") out = await this.runMissionCase(p, ctx, variant, hooks);
    else {
      if (engine === "cli" && modeMocksModel(p.mode)) {
        const r = this.skipped(p, engine, variant.id, "");
        return { ...r, status: "errored", trace: { ...r.trace, notes: [] }, error: `Mode ${p.mode} scripts the model, which the CLI engine cannot do (the official program calls its own model): use mode tools or none for this agent.` };
      }
      out = await this.runAgentCase(p, ctx, variant, suite, hooks, cassette);
    }
    const { trace } = out;
    if (out.skipped) return this.skipped(p, engine, variant.id, out.skipped);
    let error = out.error;
    const assertions = error ? [] : [...(out.extra ?? []), ...p.case.assertions.map((a) => evaluateAssertion(a, trace))];
    // the scorers (evals) run after the turn, outside the case's hooks: a judge calls its real model
    const scores = error || !p.case.scorers?.length ? undefined : await scoreSuiteCase(p.case.scorers, { trace, input: p.case.input, ...(p.row ? { row: p.row.values } : {}) }, this.scorerDeps(suite));
    const scorerError = scores?.find((x) => x.error);
    if (scorerError && !error) error = `Scorer ${scorerError.id}: ${scorerError.error}`;
    if (!error && !assertions.length && !scores?.length) trace.notes.push("This case has no assertions: it passes when it runs without errors");
    const score = caseOverallScore(scores);
    trace.durationMs = trace.durationMs || Date.now() - t0;
    return {
      key: p.key, caseId: p.case.id, caseName: p.case.name, ...(p.row ? { row: p.row } : {}), ...(p.attempt ? { attempt: p.attempt } : {}),
      status: error ? "errored" : assertions.every((a) => a.passed) && (scores ?? []).every((x) => x.passed) ? "passed" : "failed",
      mode: p.mode, engine, assertions, ...(scores ? { scores } : {}), ...(score !== undefined ? { score } : {}), trace,
      ...(error ? { error } : {}),
      startedAt, durationMs: trace.durationMs, costUsd: trace.usage.costUsd, variantId: variant.id,
    };
  }

  private scorerDeps(suite: AgentSuite): ScorerDeps & { judgeModel?: string } {
    return {
      ...(this.deps.judge ? { judge: this.deps.judge } : {}), ...(this.deps.customScorer ? { custom: this.deps.customScorer } : {}),
      ...(suite.evals?.judgeModel ? { judgeModel: suite.evals.judgeModel } : {}),
    };
  }

  /** An agent case: one chat turn, or a conversation with a simulated / scripted user. */
  private async runAgentCase(p: PlannedCase, ctx: Extract<RunContext, { kind: "agent" }>, variant: SuiteVariant, suite: AgentSuite, hooks: { onStart: (r: CaseRecorder) => void; onEnd: (r: CaseRecorder) => void }, cassette: SuiteCassetteRecord | undefined): Promise<{ trace: SuiteTrace; error?: string; extra?: SuiteAssertionResult[] }> {
    const recorder = new CaseRecorder(p, variant.overrides, ctx.engine, { ...(cassette ? { cassette } : {}) });
    hooks.onStart(recorder);
    const t0 = Date.now();
    const messages = caseMessages(p.case.input);
    const sim = p.mocks.simulatedUser;
    let reply: SuiteTurnResult | undefined;
    let error: string | undefined;
    const transcript: SuiteTranscriptMessage[] = [];
    const replies: string[] = [];
    let simulator: SuiteTrace["simulator"];
    const turnOnce = async (msgs: Array<{ role: string; content: string }>) => {
      const firstTurn = recorder.turns.length;
      const r = await within(p.budgets.maxDurationMs + 30_000, this.deps.turn(ctx.agentRef, msgs, recorder), "The case");
      absorbReply(recorder, r, { firstTurn });
      return r;
    };
    try {
      reply = await turnOnce(messages);
      replies.push(reply.text);
      if (sim) {
        transcript.push({ role: "user", content: p.case.input.message, simulated: false }, { role: "assistant", content: reply.text });
        simulator = await this.converse(p, suite, sim, recorder, messages, transcript, replies, (msgs) => turnOnce(msgs).then((r) => { reply = r; return r; }));
      }
    } catch (err) {
      error = errorText(err);
      recorder.cancelled ??= "stopped";
      if (simulator) simulator.stoppedBy = "error";
    } finally {
      hooks.onEnd(recorder);
    }
    if (recorder.scriptExhausted && p.mocks.model?.onExhausted === "error" && !error) error = "The model script ended before the agent finished (onExhausted: error)";
    if (p.mocks.cassette && !cassette && modeMocksTools(p.mode)) recorder.notes.push(`The cassette ${p.mocks.cassette.id} was not found: record the case first (its tool calls are blocked meanwhile)`);
    const usage = usageOf(recorder.turns);
    const trace: SuiteTrace = {
      input: messages,
      turns: recorder.turns,
      toolCalls: recorder.toolCalls.sort((a, b) => a.turn - b.turn),
      text: sim ? replies.join("\n\n") : reply?.text ?? "",
      finishReason: recorder.stoppedBy ? "budget" : reply?.finishReason ?? (error ? "error" : undefined),
      approvals: recorder.approvals,
      usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 },
      durationMs: Date.now() - t0,
      notes: recorder.notes,
      ...(sim ? { transcript, finalText: reply?.text ?? "", ...(simulator ? { simulator } : {}) } : {}),
      ...(cassette ? { cassette: { id: cassette.id, replayedCalls: recorder.replay.calls, replayedTurns: recorder.replay.turns, unmatched: recorder.replay.unmatched } } : {}),
    };
    const extra: SuiteAssertionResult[] = [];
    if (cassette && p.mocks.cassette?.onUnmatched === "fail") {
      const unmatched = recorder.replay.unmatched;
      extra.push({
        assertion: { type: "no_tool_errors", label: "every tool call matches the cassette" }, description: `every tool call matches the cassette ${cassette.id}`,
        passed: unmatched.length === 0, message: unmatched.length ? `no recording for: ${unmatched.join(", ")}` : `${recorder.replay.calls} call(s) replayed`,
        ...(unmatched.length ? { actual: unmatched } : {}),
      });
    }
    return { trace, ...(error ? { error } : {}), extra };
  }

  /**
   * A multi-turn conversation: after each agent reply the simulated user (a model) or the script
   * writes the next user turn, until the goal is reached, a scorer passes, the turns run out, the
   * agent stops for a person or a budget is spent.
   */
  private async converse(
    p: PlannedCase, suite: AgentSuite, sim: NonNullable<SuiteMocks["simulatedUser"]>, recorder: CaseRecorder,
    first: Array<{ role: string; content: string }>, transcript: SuiteTranscriptMessage[], replies: string[],
    turn: (msgs: Array<{ role: string; content: string }>) => Promise<SuiteTurnResult>,
  ): Promise<NonNullable<SuiteTrace["simulator"]>> {
    const scripted = !!sim.script?.length;
    const maxTurns = scripted ? sim.script!.length : Math.min(SIMULATED_USER_LIMITS.maxTurns, sim.maxTurns ?? SIMULATED_USER_LIMITS.defaultTurns);
    const model = sim.model ?? suite.simulatorModel;
    const out: NonNullable<SuiteTrace["simulator"]> = { ...(scripted ? {} : model ? { model } : {}), calls: 0, costUsd: 0, stoppedBy: scripted ? "script" : "max_turns" };
    let messages = [...first];
    let last = replies[replies.length - 1] ?? "";
    for (let i = 0; i < maxTurns; i++) {
      if (recorder.approvals.some((a) => a.kind === "interactive")) { out.stoppedBy = "agent"; recorder.notes.push("The conversation stopped: the agent waits for a person's approval"); break; }
      if (recorder.stoppedBy) { out.stoppedBy = "budget"; break; }
      if (sim.stop === "scorer" && sim.stopScorer) {
        const scorer = p.case.scorers?.find((s) => s.id === sim.stopScorer);
        if (!scorer) { recorder.notes.push(`stopScorer "${sim.stopScorer}" is not one of the case's scorers`); }
        else {
          const partial: SuiteTrace = { input: messages, turns: recorder.turns, toolCalls: recorder.toolCalls, text: replies.join("\n\n"), approvals: recorder.approvals, usage: usageOf(recorder.turns), durationMs: 0, notes: [], transcript, finalText: last };
          const [score] = await scoreSuiteCase([scorer], { trace: partial, input: p.case.input, ...(p.row ? { row: p.row.values } : {}) }, this.scorerDeps(suite));
          if (score?.passed) { out.stoppedBy = "scorer"; recorder.notes.push(`The conversation stopped: ${scorer.id} passed (${score.score.toFixed(2)})`); break; }
        }
      }
      let next: string | undefined;
      if (scripted) next = sim.script![i];
      else {
        if (!this.deps.simulate) throw new Error("No simulated user on this server (no model to play the user): use a script instead");
        const res = await this.deps.simulate({ prompt: simulatedUserPrompt(sim, transcript, { turn: i + 2, maxTurns: maxTurns + 1 }), ...(model ? { model } : {}) });
        out.calls++;
        out.costUsd = Math.round((out.costUsd + (res.costUsd ?? 0)) * 1e6) / 1e6;
        if (res.model) out.model = res.model;
        const said = parseSimulatedUserReply(res.text);
        if (said.done) {
          out.stoppedBy = said.goalReached === false ? "max_turns" : "goal";
          out.goalReached = said.goalReached !== false;
          recorder.notes.push(`The simulated user stopped${said.goalReached === false ? " (goal not reached)" : " (goal reached)"}${said.reason ? `: ${said.reason}` : ""}`);
          if (transcript.length) transcript[transcript.length - 1] = { ...transcript[transcript.length - 1], note: said.reason ?? (said.goalReached === false ? "goal not reached" : "goal reached") };
          break;
        }
        next = said.message;
      }
      if (!next) break;
      transcript.push({ role: "user", content: next, simulated: !scripted });
      messages = [...messages, { role: "assistant", content: last }, { role: "user", content: next }];
      const r = await turn(messages);
      last = r.text;
      replies.push(r.text);
      transcript.push({ role: "assistant", content: r.text });
    }
    return out;
  }

  /** A hosted server's test: one tool call, its upstream HTTP answered by the case's mocks. */
  private async runToolCase(p: PlannedCase, ctx: Extract<RunContext, { kind: "mcp-server" }>): Promise<{ trace: SuiteTrace; error?: string; skipped?: string }> {
    const hosted = this.deps.targets!.mcpServer!;
    const t0 = Date.now();
    const tool = p.case.input.tool ?? "";
    const args = p.case.input.args ?? {};
    const notes: string[] = [];
    const http: SuiteTraceHttp[] = [];
    const used = new Map<number, number>();
    const mocked = modeMocksTools(p.mode);
    const realHttp = !mocked || p.mocks.unmockedHttp === "real";
    const vars = { row: p.row?.values ?? {}, args };
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? redactCassetteSecrets(init.body).value.slice(0, 2000) : undefined;
      const hit = mocked ? findHttpMock(p.mocks.http ?? [], method, url, used) : undefined;
      if (hit) {
        const r = httpMockResponse(hit.mock, { ...vars, request: { method, url } });
        http.push({ method, url, status: r.status, mocked: "mock", mockId: hit.mock.id ?? `${hit.mock.url}#${hit.index + 1}`, ...(body ? { body } : {}) });
        return new Response(r.body, { status: r.status, headers: r.headers });
      }
      if (mocked && !realHttp) {
        http.push({ method, url, status: 0, mocked: "blocked", ...(body ? { body } : {}) });
        notes.push(`${method} ${url}: no HTTP mock matched, blocked`);
        throw new Error(`no HTTP mock matches ${method} ${url} (blocked in this test)`);
      }
      const res = await fetch(url, init);
      http.push({ method, url, status: res.status, mocked: false, ...(body ? { body } : {}) });
      return res;
    };
    const kind = ctx.tools[tool];
    if (!kind) {
      return { trace: { input: [], turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 0, notes, http }, error: `${ctx.server} has no tool "${tool}" at ${ctx.ref}` };
    }
    let r: HostedToolCallResult;
    try {
      r = await hosted.call(ctx.server, { ref: ctx.ref, tool, input: args, fetch: fetchImpl, mockedHttp: !realHttp, ...(ctx.actor ? { actor: ctx.actor } : {}) });
    } catch (err) {
      return { trace: { input: [], turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: Date.now() - t0, notes, http }, error: errorText(err) };
    }
    const result = r.ok ? r.text : `Error: ${r.error ?? r.text}`;
    const trace: SuiteTrace = {
      input: [{ role: "user", content: `${tool} ${JSON.stringify(args)}` }],
      turns: [],
      toolCalls: r.skipped ? [] : [{ id: "call-1", turn: 0, name: tool, args, result, isError: !r.ok, mocked: false, durationMs: r.ms, ...(/^Queued for approval/i.test(r.text) ? { approval: "queued" as const } : {}) }],
      text: r.ok ? r.text : r.error ?? r.text,
      approvals: /^Queued for approval/i.test(r.text) ? [{ tool, kind: "queued" }] : [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      durationMs: Date.now() - t0,
      notes,
      ...(r.skipped ? {} : { http }),
    };
    return { trace, ...(r.skipped ? { skipped: r.skipped } : {}) };
  }

  /**
   * A mission case: the mission's tasks in dependency order, each a chat turn of its agent with the
   * task framing (what the tasks before produced included) and that agent's mocks; a task whose
   * dependency did not finish is skipped. One trace for the mission (calls and turns by agent).
   */
  private async runMissionCase(p: PlannedCase, ctx: Extract<RunContext, { kind: "mission" }>, variant: SuiteVariant, hooks: { onStart: (r: CaseRecorder) => void; onEnd: (r: CaseRecorder) => void }): Promise<{ trace: SuiteTrace; error?: string; extra?: SuiteAssertionResult[] }> {
    const t0 = Date.now();
    const tasks = dependencyOrder(ctx.tasks);
    const turns: SuiteTraceTurn[] = [];
    const toolCalls: SuiteTraceToolCall[] = [];
    const approvals: SuiteTrace["approvals"] = [];
    const notes: string[] = [];
    const traceTasks: SuiteTraceTask[] = [];
    const done: Array<{ title: string; text: string }> = [];
    const cursors = new Map<string, { n: number }>();
    let cost = 0;
    for (const task of tasks) {
      const agent = task.assignTo ?? ctx.defaultAgent;
      const blocked = (task.dependsOn ?? []).find((d) => traceTasks.some((t) => t.title === d && t.status !== "done"));
      if (!agent || blocked) {
        traceTasks.push({ title: task.title, agent: agent ?? "", status: "skipped", text: "", toolCalls: 0, turns: 0, costUsd: 0, durationMs: 0, error: blocked ? `"${blocked}" did not finish` : "the task has no agent (assignTo)" });
        continue;
      }
      const tt0 = Date.now();
      let config: AgentConfig | undefined;
      try { config = await this.deps.resolveAgent(agent); } catch { config = undefined; }
      if (!config) {
        traceTasks.push({ title: task.title, agent, status: "failed", text: "", toolCalls: 0, turns: 0, costUsd: 0, durationMs: 0, error: `there is no agent "${agent}"` });
        continue;
      }
      const engine = engineOf(applySuiteOverrides(config, variant.overrides));
      if (engine === "cli" && modeMocksModel(p.mode)) {
        traceTasks.push({ title: task.title, agent, status: "failed", text: "", toolCalls: 0, turns: 0, costUsd: 0, durationMs: 0, error: `${agent} runs on the CLI engine, whose model cannot be scripted (mode ${p.mode})` });
        continue;
      }
      // what is left of the case's budgets
      const budgets = {
        maxTurns: Math.max(0, p.budgets.maxTurns - turns.length),
        maxDurationMs: Math.max(1000, p.budgets.maxDurationMs - (Date.now() - t0)),
        ...(p.budgets.maxCostUsd !== undefined ? { maxCostUsd: Math.max(0, p.budgets.maxCostUsd - cost) } : {}),
      };
      const sub: PlannedCase = { ...p, mocks: agentMocksFor(p.mocks, agent), budgets };
      if (!cursors.has(agent)) cursors.set(agent, { n: 0 });
      const recorder = new CaseRecorder(sub, variant.overrides, engine, { agent, cursor: cursors.get(agent)! });
      hooks.onStart(recorder);
      const message = missionTaskMessage(task, done, { mission: ctx.name, ...(p.case.input.message ? { extra: p.case.input.message } : {}) });
      let reply: SuiteTurnResult | undefined;
      let error: string | undefined;
      try {
        reply = await within(budgets.maxDurationMs + 30_000, this.deps.turn(agent, [{ role: "user", content: message }], recorder), `The task "${task.title}"`);
        absorbReply(recorder, reply, { agent });
      } catch (err) {
        error = errorText(err);
      } finally {
        hooks.onEnd(recorder);
      }
      const offset = turns.length;
      for (const t of recorder.turns) turns.push({ ...t, index: offset + t.index });
      for (const c of recorder.toolCalls) toolCalls.push({ ...c, turn: offset + c.turn, agent });
      approvals.push(...recorder.approvals);
      notes.push(...recorder.notes.map((n) => `${task.title} (${agent}): ${n}`));
      const usage = usageOf(recorder.turns);
      cost += usage.costUsd;
      const failed = error ?? (recorder.stoppedBy ? `stopped by the ${recorder.stoppedBy}` : undefined);
      traceTasks.push({
        title: task.title, agent, status: failed ? "failed" : "done", text: reply?.text ?? "", toolCalls: recorder.toolCalls.length, turns: recorder.turns.length,
        costUsd: Math.round(usage.costUsd * 1e6) / 1e6, durationMs: Date.now() - tt0, ...(failed ? { error: failed } : {}),
      });
      if (!failed) done.push({ title: task.title, text: reply?.text ?? "" });
      if (recorder.cancelled && recorder.cancelled !== "stopped") break;
    }
    const usage = usageOf(turns);
    const trace: SuiteTrace = {
      input: [{ role: "user", content: `Mission ${ctx.name}${p.case.input.message ? `\n\n${p.case.input.message}` : ""}` }],
      turns, toolCalls, text: traceTasks.filter((t) => t.status === "done").map((t) => `## ${t.title}\n${t.text}`).join("\n\n"),
      finishReason: traceTasks.some((t) => t.status === "failed") ? "task_failed" : "stop",
      approvals, usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 }, durationMs: Date.now() - t0,
      notes: [...ctx.notes, ...notes], tasks: traceTasks,
    };
    const extra: SuiteAssertionResult[] = [];
    // with no checks of their own, a mission case passes when every task finished
    if (!p.case.assertions.length && !p.case.scorers?.length) {
      const bad = traceTasks.filter((t) => t.status !== "done");
      extra.push({
        assertion: { type: "no_tool_errors", label: "every task done" }, description: "every task done", passed: bad.length === 0,
        message: bad.length ? bad.map((t) => `${t.title}: ${t.status}${t.error ? ` (${t.error})` : ""}`).join("; ") : `${traceTasks.length} task(s) done`,
      });
    }
    return { trace, extra };
  }

  // ── cassettes ──

  /** Save a recorded case's exchange as its cassette (secrets redacted). */
  private async saveRecording(owner: string, suite: AgentSuite, p: PlannedCase, result: SuiteCaseResult, run: SuiteRun, secrets: string[], actor?: string): Promise<SuiteCaseResult> {
    const id = cassetteIdFor(p.case.id, p.row?.index);
    const previous = await this.deps.store.getCassette(owner, id);
    const cassette = cassetteFromTrace(result.trace, {
      id, agent: owner, name: `${p.case.name}${p.row ? ` #${p.row.index + 1}` : ""}`, suiteId: suite.id, caseId: p.case.id,
      source: { kind: "run", runId: run.id, target: run.target, ...(run.version ? { version: run.version } : {}) },
      secrets, ...(actor ? { actor } : {}), ...(previous ? { previous } : {}),
    });
    await this.deps.store.saveCassette(cassette);
    return { ...result, trace: { ...result.trace, recorded: { cassetteId: id, calls: cassette.calls.length, turns: cassette.turns.length, redactions: cassette.redactions } } };
  }

  /** After a recording: each recorded case replays its cassette (mode all when it ran live before). */
  private async pointCasesAtCassettes(owner: string, suiteId: string, recorded: Array<{ caseId: string; base: string }>, actor?: string): Promise<void> {
    const suite = await this.getSuite(owner, suiteId);
    const byCase = new Map(recorded.map((r) => [r.caseId, r.base]));
    let changed = false;
    const cases = suite.cases.map((c) => {
      const base = byCase.get(c.id);
      if (!base) return c;
      const mode = c.mode ?? suite.defaultMode;
      const next: SuiteCase = {
        ...c, mocks: { ...(c.mocks ?? {}), cassette: { ...(c.mocks?.cassette ?? {}), id: c.mocks?.cassette?.id ?? base } },
        ...(mode === "none" || mode === "model" ? { mode: "all" as const } : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(c)) changed = true;
      return next;
    });
    if (changed) await this.saveSuite(owner, { ...suite, cases }, { ...(actor ? { actor } : {}), admin: true });
  }

  async listCassettes(owner: string): Promise<SuiteCassetteRecord[]> {
    return (await this.deps.store.listCassettes(owner)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getCassette(owner: string, id: string): Promise<SuiteCassetteRecord> {
    const c = await this.deps.store.getCassette(owner, id);
    if (!c) throw new AgentSuiteError(`${owner} has no cassette "${id}"`, "NOT_FOUND");
    return c;
  }

  /** The cassette a case replays (its id from the case, else the one it would record into). */
  async caseCassette(owner: string, suiteId: string, caseId: string): Promise<SuiteCassetteRecord | null> {
    const suite = await this.getSuite(owner, suiteId);
    const c = suite.cases.find((x) => x.id === caseId);
    if (!c) throw new AgentSuiteError(`${suite.name} has no case "${caseId}"`, "NOT_FOUND");
    return (await this.deps.store.getCassette(owner, c.mocks?.cassette?.id ?? cassetteIdFor(caseId))) ?? null;
  }

  /**
   * Edit a cassette's calls: a new response, delete, or turn a call into a case tool mock (the mock
   * is added to the case the cassette belongs to; a re-recording keeps the call pinned).
   */
  async editCassette(owner: string, id: string, edits: CassetteCallEdit[], opts: { actor?: string; revision?: number } = {}): Promise<SuiteCassetteRecord> {
    const current = await this.getCassette(owner, id);
    const { cassette, mocks } = editCassette(current, edits, opts);
    if (mocks.length) {
      if (!current.suiteId || !current.caseId) throw new AgentSuiteError("This cassette belongs to no case: a call cannot become a case mock");
      const suite = await this.getSuite(owner, current.suiteId);
      const cases = suite.cases.map((c) => c.id !== current.caseId ? c : {
        ...c,
        mocks: {
          ...(c.mocks ?? {}),
          tools: [
            ...mocks.map((m) => ({ id: `cassette-${suiteSlug(m.id, "call")}`.slice(0, 64), tool: m.tool, when: { args: m.args, match: "exact" as const }, ...(m.isError ? { error: m.response.replace(/^Error:\s*/, "") } : { response: m.response }), description: `From the cassette ${id}` })),
            ...(c.mocks?.tools ?? []).filter((t) => !mocks.some((m) => t.id === `cassette-${suiteSlug(m.id, "call")}`.slice(0, 64))),
          ],
        },
      });
      await this.saveSuite(owner, { ...suite, cases }, { ...(opts.actor ? { actor: opts.actor } : {}), admin: true });
    }
    await this.deps.store.saveCassette(cassette);
    return cassette;
  }

  /** Delete a cassette (the cases pointing at it then block their tool calls until recorded again). */
  async deleteCassette(owner: string, id: string): Promise<void> {
    if (!(await this.deps.store.deleteCassette(owner, id))) throw new AgentSuiteError(`${owner} has no cassette "${id}"`, "NOT_FOUND");
  }

  /** Record (or re-record) one case: a live run whose exchange becomes its cassette. */
  recordCase(owner: string, suiteId: string, caseId: string, req: { target?: string } = {}, opts: RunOptions = {}): Promise<{ run: SuiteRun; done: Promise<SuiteRun> }> {
    return this.startRun(owner, suiteId, { caseIds: [caseId], record: true, ...(req.target ? { target: req.target } : {}) }, opts);
  }

  /**
   * A case and its cassette from a real chat session or a task run, added to the suite (the person
   * asked for it): the exchange is replayed offline, its tool calls checked in order.
   */
  async caseFromRecording(owner: string, suiteId: string, req: { sessionId?: string; taskId?: string; messageIndex?: number; name?: string }, opts: { actor?: string } = {}): Promise<{ suite: AgentSuite; case: SuiteCase; cassette: SuiteCassetteRecord }> {
    const suite = await this.getSuite(owner, suiteId);
    if (suite.target.kind !== "agent") throw new AgentSuiteError("A recorded chat or task becomes a case of an agent suite");
    const secrets = await this.deps.secrets?.().catch(() => [] as string[]) ?? [];
    let built: { case: SuiteCase; cassette: SuiteCassetteRecord };
    if (req.sessionId) {
      if (!this.deps.sessionMessages) throw new AgentSuiteError("Chats cannot be read on this server", "CONFLICT");
      const session = await this.deps.sessionMessages(req.sessionId);
      if (!session) throw new AgentSuiteError(`There is no chat "${req.sessionId}"`, "NOT_FOUND");
      if (session.agent && session.agent !== owner) throw new AgentSuiteError(`The chat is with ${session.agent}, not ${owner}`);
      let trace;
      try { trace = traceFromChat(session.messages, req.messageIndex !== undefined ? { messageIndex: req.messageIndex } : {}); } catch (err) { throw new AgentSuiteError(errorText(err)); }
      built = recordedCase(trace, {
        agent: owner, suiteId, name: req.name?.trim() || session.title?.trim() || `From chat ${req.sessionId.slice(0, 8)}`,
        source: { kind: "session", sessionId: req.sessionId }, secrets, ...(opts.actor ? { actor: opts.actor } : {}),
      });
    } else if (req.taskId) {
      if (!this.deps.taskActivity) throw new AgentSuiteError("Task runs cannot be read on this server", "CONFLICT");
      const task = await this.deps.taskActivity(req.taskId);
      if (!task) throw new AgentSuiteError(`There is no task "${req.taskId}"`, "NOT_FOUND");
      if (task.assignTo && task.assignTo !== owner) throw new AgentSuiteError(`The task was done by ${task.assignTo}, not ${owner}`);
      const trace = traceFromTaskActivity(task, task.entries);
      if (!trace.toolCalls.length && !trace.text) throw new AgentSuiteError("The task's runs recorded no activity to make a case from");
      built = recordedCase(trace, {
        agent: owner, suiteId, name: req.name?.trim() || task.title, kind: "task", message: trace.message,
        source: { kind: "task", taskId: req.taskId }, secrets, ...(opts.actor ? { actor: opts.actor } : {}),
      });
    } else throw new AgentSuiteError("Give sessionId (a chat) or taskId (a task run)");
    // a unique case id (and cassette id) in this suite
    const taken = new Set(suite.cases.map((c) => c.id));
    let caseId = built.case.id;
    for (let n = 2; taken.has(caseId); n++) caseId = `${built.case.id.slice(0, 56)}-${n}`;
    const cassetteId = cassetteIdFor(caseId);
    const c: SuiteCase = { ...built.case, id: caseId, mocks: { ...(built.case.mocks ?? {}), cassette: { id: cassetteId } } };
    const cassette = { ...built.cassette, id: cassetteId, caseId };
    await this.deps.store.saveCassette(cassette);
    const saved = await this.saveSuite(owner, { ...suite, cases: [...suite.cases, c] }, { ...(opts.actor ? { actor: opts.actor } : {}), revision: suite.revision, admin: true });
    return { suite: saved, case: saved.cases.find((x) => x.id === caseId) ?? c, cassette };
  }

  // ── generation (never saved by itself) ──

  /**
   * Proposed cases for an agent (from its instructions, tools, skills, connectors, a brief and sample
   * chats): validated, returned for review. Nothing is saved: a person accepts them (acceptCases).
   */
  async generateCases(owner: string, req: CaseGenerationRequest & { suiteId?: string; sessionIds?: string[] } = {}): Promise<{ proposals: GeneratedCaseProposal[]; model?: string; costUsd?: number }> {
    if (!this.deps.generate) throw new AgentSuiteError("Case generation is not available on this server (no model)", "CONFLICT");
    const o = parseSuiteOwner(owner);
    if (o.kind !== "agent") throw new AgentSuiteError("Case generation is for agent suites");
    const config = (await this.deps.agents()).find((a) => a.name === owner);
    if (!config) throw new AgentSuiteError(`Agent "${owner}" not found`, "NOT_FOUND");
    const suite = req.suiteId ? await this.getSuite(owner, req.suiteId) : undefined;
    const info: AgentGenerationInfo = this.deps.agentInfo ? await this.deps.agentInfo(config) : {
      name: config.name, ...(config.role ? { role: config.role } : {}), ...(config.systemPrompt ? { instructions: config.systemPrompt } : {}),
      tools: (config.allowedTools ?? []).map((name) => ({ name })),
    };
    const samples: NonNullable<CaseGenerationRequest["samples"]> = [...(req.samples ?? [])];
    for (const id of (req.sessionIds ?? []).slice(0, 5)) {
      const s = await this.deps.sessionMessages?.(id).catch(() => undefined);
      if (s) samples.push({ ...(s.title ? { title: s.title } : {}), messages: redactCassetteSecrets(s.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })), await this.deps.secrets?.().catch(() => []) ?? []).value });
    }
    const prompt = caseGenerationPrompt(info, { ...req, ...(samples.length ? { samples } : {}) });
    let res: { text: string; model?: string; costUsd?: number };
    try { res = await this.deps.generate({ prompt }); } catch (err) { throw new AgentSuiteError(`The generation failed: ${errorText(err)}`, "CONFLICT"); }
    const proposals = parseGeneratedCases(res.text, { takenIds: suite?.cases.map((c) => c.id) ?? [], takenDatasets: suite?.datasets.map((d) => d.id) ?? [], ...(res.model ? { model: res.model } : {}) });
    return { proposals, ...(res.model ? { model: res.model } : {}), ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}) };
  }

  /** Add the cases a person accepted (and their datasets) to a suite. */
  async acceptCases(owner: string, suiteId: string, req: { cases: unknown[]; datasets?: unknown[]; revision?: number }, opts: { actor?: string } = {}): Promise<AgentSuite> {
    const suite = await this.getSuite(owner, suiteId);
    if (!Array.isArray(req.cases) || !req.cases.length) throw new AgentSuiteError("cases: give at least one case to add");
    const taken = new Set(suite.cases.map((c) => c.id));
    const cases = req.cases.map((c, i) => {
      const raw = c && typeof c === "object" ? { ...(c as Record<string, unknown>) } : c;
      // an id already used: a new one from the name
      if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" && taken.has((raw as { id: string }).id)) delete (raw as { id?: unknown }).id;
      const parsed = parseSuiteCase(raw, `cases[${i}]`, taken);
      taken.add(parsed.id);
      return parsed;
    });
    const dsTaken = new Set(suite.datasets.map((d) => d.id));
    const datasets = (Array.isArray(req.datasets) ? req.datasets : []).filter((d): d is Record<string, unknown> => !!d && typeof d === "object" && !dsTaken.has(String((d as { id?: unknown }).id)));
    return this.saveSuite(owner, { ...suite, cases: [...suite.cases, ...cases], datasets: [...suite.datasets, ...datasets] }, { ...(opts.actor ? { actor: opts.actor } : {}), revision: req.revision ?? suite.revision, admin: true });
  }

  /** Proposed dataset rows for a case (its dataset's columns kept); nothing is saved. */
  async generateDatasetRows(owner: string, suiteId: string, req: { caseId: string; count?: number; brief?: string }): Promise<{ datasetId?: string; columns: string[]; rows: Array<Record<string, unknown>>; model?: string; costUsd?: number }> {
    if (!this.deps.generate) throw new AgentSuiteError("Generation is not available on this server (no model)", "CONFLICT");
    const suite = await this.getSuite(owner, suiteId);
    const c = suite.cases.find((x) => x.id === req.caseId);
    if (!c) throw new AgentSuiteError(`${suite.name} has no case "${req.caseId}"`, "NOT_FOUND");
    const ds = c.dataset ? suite.datasets.find((d) => d.id === c.dataset) : undefined;
    let res: { text: string; model?: string; costUsd?: number };
    try { res = await this.deps.generate({ prompt: datasetRowsPrompt(c, ds, { ...(req.count ? { count: req.count } : {}), ...(req.brief ? { brief: req.brief } : {}), agent: owner }) }); } catch (err) { throw new AgentSuiteError(`The generation failed: ${errorText(err)}`, "CONFLICT"); }
    const out = parseGeneratedRows(res.text, ds?.columns);
    return { ...(ds ? { datasetId: ds.id } : {}), ...out, ...(res.model ? { model: res.model } : {}), ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}) };
  }

  // ── evals: baselines, comparisons, trends, reviews ──

  private compareOpts(suite: AgentSuite | undefined, tolerance?: number): { tolerance?: number; flakyStddev?: number } {
    const tol = tolerance ?? suite?.evals?.regressionTolerance;
    const flaky = suite?.evals?.flakyStddev;
    return { ...(tol !== undefined ? { tolerance: tol } : {}), ...(flaky !== undefined ? { flakyStddev: flaky } : {}) };
  }

  /** The comparison of a finished run with its baseline (the given one, the marked one, or by the suite's policy). */
  private async baselineFor(run: SuiteRun, suite: AgentSuite, req: SuiteRunRequest): Promise<SuiteBaselineComparison | undefined> {
    const opts = this.compareOpts(suite, req.regressionTolerance);
    if (req.baselineRunId) {
      const b = await this.deps.store.getRun(run.agent, req.baselineRunId);
      return b ? compareSuiteRuns(run, b, { source: "request", ...opts }) : undefined;
    }
    // recording runs are not baselines (they ran live once to make the cassettes)
    const picked = pickSuiteBaseline((await this.deps.store.listRuns(run.agent, { suiteId: run.suiteId })).filter((r) => !r.record), run, suite.evals?.baseline ?? "previous");
    if (!picked) return undefined;
    const full = await this.deps.store.getRun(run.agent, picked.run.id) ?? picked.run;
    return compareSuiteRuns(run, full, { source: picked.source, ...opts });
  }

  /** Mark a run as its suite's baseline (the previous mark is removed); `runId` undefined clears it. */
  async setBaseline(agent: string, suiteId: string, runId: string | undefined): Promise<SuiteRun | undefined> {
    await this.getSuite(agent, suiteId);
    let target: SuiteRun | undefined;
    if (runId) {
      target = await this.getRun(agent, runId);
      if (target.suiteId !== suiteId) throw new AgentSuiteError(`Run ${runId} is a run of ${target.suiteName}, not of ${suiteId}`);
      if (target.status === "running" || target.status === "queued") throw new AgentSuiteError("A run still going cannot be the baseline: wait for it to finish");
      if (target.status === "cancelled") throw new AgentSuiteError("A cancelled run cannot be the baseline");
    }
    for (const r of await this.deps.store.listRuns(agent, { suiteId })) {
      if (!r.isBaseline || r.id === runId) continue;
      const full = await this.deps.store.getRun(agent, r.id);
      if (full) { delete full.isBaseline; await this.deps.store.saveRun(full); }
    }
    if (target && !target.isBaseline) { target.isBaseline = true; await this.deps.store.saveRun(target); }
    return target;
  }

  /** The suite's marked baseline run, if any. */
  async getBaseline(agent: string, suiteId: string): Promise<SuiteRun | undefined> {
    await this.getSuite(agent, suiteId);
    const marked = (await this.deps.store.listRuns(agent, { suiteId })).find((r) => r.isBaseline);
    return marked ? this.deps.store.getRun(agent, marked.id) : undefined;
  }

  /** Compare a run with another (`baselineRunId`) or with its suite's baseline now. */
  async compareRuns(agent: string, runId: string, opts: { baselineRunId?: string; tolerance?: number } = {}): Promise<SuiteBaselineComparison | undefined> {
    const run = await this.getRun(agent, runId);
    const suite = await this.getSuite(agent, run.suiteId).catch(() => undefined);
    const extra = this.compareOpts(suite, opts.tolerance);
    if (opts.baselineRunId) return compareSuiteRuns(run, await this.getRun(agent, opts.baselineRunId), { source: "request", ...extra });
    const picked = pickSuiteBaseline(await this.deps.store.listRuns(agent, { suiteId: run.suiteId }), run, suite?.evals?.baseline ?? "previous");
    if (!picked) return undefined;
    return compareSuiteRuns(run, await this.deps.store.getRun(agent, picked.run.id) ?? picked.run, { source: picked.source, ...extra });
  }

  /** A suite's runs over time: score, pass rate, cost and latency per run and per version. */
  async trend(agent: string, suiteId: string, opts: { limit?: number } = {}): Promise<SuiteTrend> {
    await this.getSuite(agent, suiteId);
    const runs = await this.deps.store.listRuns(agent, { suiteId, limit: Math.max(1, Math.min(SUITE_LIMITS.runsKept, opts.limit ?? 50)) });
    return suiteTrend(suiteId, runs);
  }

  /** "Explain this run": an AI review of the failures and regressions with suggested fixes, stored on the run. */
  async reviewRun(agent: string, runId: string, opts: { actor?: string; language?: string } = {}): Promise<SuiteRun> {
    if (!this.deps.review) throw new AgentSuiteError("AI reviews are not available on this server", "CONFLICT");
    const run = await this.getRun(agent, runId);
    if (run.status === "running" || run.status === "queued") throw new AgentSuiteError("The run is still going: review it when it has finished");
    const isAgent = parseSuiteOwner(agent).kind === "agent";
    const config = isAgent ? await this.deps.resolveAgent(agent, run.target === "production" ? undefined : run.target).catch(() => undefined)
      ?? (await this.deps.agents()).find((a) => a.name === agent) : undefined;
    const info = config ? applySuiteOverrides(config, run.variant.overrides) : undefined;
    const prompt = suiteRunReviewPrompt(run, {
      name: agent,
      ...(info?.systemPrompt ? { instructions: info.systemPrompt } : {}),
      ...(info?.allowedTools?.length ? { tools: info.allowedTools } : {}),
      ...(typeof info?.model === "string" ? { model: info.model } : {}),
    }, opts.language ? { language: opts.language } : {});
    let res: { text: string; model?: string; costUsd?: number };
    try { res = await this.deps.review(prompt); } catch (err) { throw new AgentSuiteError(`The review failed: ${errorText(err)}`, "CONFLICT"); }
    const latest = await this.getRun(agent, runId);
    latest.review = {
      text: res.text.trim(), at: new Date().toISOString(),
      ...(res.model ? { model: res.model } : {}), ...(opts.actor ? { by: opts.actor } : {}), ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    };
    await this.deps.store.saveRun(latest);
    return latest;
  }

  /**
   * A hosted server's publish check: its saved tests run as the suite on `ref` (the draft), HTTP
   * mocked, nothing real. Undefined when there is nothing to run or a case would need real HTTP
   * (the service falls back to the legacy live run of the saved tests then).
   */
  async hostedCheck(serverId: string, ref: string, opts: { actor?: string } = {}): Promise<{ passed: number; failed: number; skipped: number; runId: string } | undefined> {
    const owner = `mcp-server:${serverId}`;
    const suite = await this.getSuite(owner, (await this.listSuites(owner))[0]!.id);
    if (!suite.cases.length) return undefined;
    let run: SuiteRun;
    try {
      run = await this.run(owner, suite.id, { target: ref, trigger: "publish" }, opts.actor ? { actor: opts.actor } : {});
    } catch (err) {
      if (err instanceof AgentSuiteError && err.code === "FORBIDDEN") return undefined;
      throw err;
    }
    return { passed: run.stats.passed, failed: run.stats.failed + run.stats.errored, skipped: run.stats.skipped, runId: run.id };
  }

  /** The agent was removed: drop its suites and runs. */
  forget(agent: string): Promise<void> { return this.deps.store.deleteAgent(agent); }

  /**
   * A hosted server's deploy gate: its suite against the version, with the gate's thresholds; the
   * deploy goes on only when it passes.
   */
  async hostedGate(serverId: string, version: string, opts: { actor?: string } = {}): Promise<{ passed: boolean; runId?: string; failures: string[] }> {
    const owner = `mcp-server:${serverId}`;
    const suite = await this.getSuite(owner, (await this.listSuites(owner))[0]!.id);
    if (!suite.cases.length) return { passed: true, failures: [] };
    let run: SuiteRun;
    try {
      run = await this.run(owner, suite.id, { target: version, trigger: "deploy" }, { ...(opts.actor ? { actor: opts.actor } : {}), allowRealTools: suite.gate?.allowRealTools === true });
    } catch (err) {
      // a suite that needs real HTTP (mode none, unmocked requests run for real) without gate.allowRealTools
      if (err instanceof AgentSuiteError && err.code === "FORBIDDEN") {
        return { passed: false, failures: ["The suite needs real HTTP (a case in mode none, or unmocked requests run for real): mock it, or let the gate run it for real (gate.allowRealTools, admins)"] };
      }
      throw err;
    }
    const failures: string[] = [];
    const minPassRate = suite.gate?.minPassRate ?? 1;
    if (run.status === "errored" && run.error) failures.push(run.error);
    if (run.stats.passRate < minPassRate) failures.push(`pass rate ${Math.round(run.stats.passRate * 100)}% < ${Math.round(minPassRate * 100)}%`);
    for (const r of run.results.filter((x) => x.status === "failed" || x.status === "errored").slice(0, 5)) failures.push(`${r.caseName}: ${r.error ?? r.assertions.filter((a) => !a.passed).map((a) => a.message).join("; ")}`);
    const passed = run.status !== "cancelled" && !(run.status === "errored" && run.error) && run.stats.passRate >= minPassRate;
    const saved = await this.getRun(owner, run.id);
    saved.gate = { decision: passed ? "pass" : "fail", ...(passed ? {} : { reason: failures[0] }) };
    await this.deps.store.saveRun(saved);
    return { passed, runId: run.id, failures: passed ? [] : failures };
  }
}


/** Run a turn under a case's hooks (the host's `turn` wraps the completions call with this). */
export { runAsSuiteCase };
