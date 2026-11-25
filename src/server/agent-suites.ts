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
 * Engines:
 *   native   Polpo's engine: model mocks and tool mocks for every tool
 *   harness  chats run on Polpo's engine with the agent's model (docs/harnesses.md): as native
 *   cli      the official claude / codex program: its model cannot be scripted (modes model / all
 *            refused); Polpo's tools it uses are mocked, its own (Bash, Read, Edit…) run for real
 */
import { randomUUID } from "node:crypto";
import {
  AgentSuiteError, SUITE_LIMITS, SUITE_STUBBED_TOOLS,
  agentCliEngine, agentHarness, caseMessages, caseOverallScore, compareSuiteRuns, evaluateAssertion, findToolMock, modeMocksModel, modeMocksTools,
  parseAgentSuite, parseCsvDataset, parseJsonDataset, pickSuiteBaseline, planSuiteCases, planUsesRealTools, scoreSuiteCase,
  suiteRunAggregates, suiteRunReviewPrompt, suiteRunStats, suiteRunStatus, suiteSlug, suiteTrend, toolMockResult,
  type AgentConfig, type AgentSuite, type AgentSuiteStore, type PlannedCase, type ScorerDeps, type ScriptedTurn, type SuiteBaselineComparison,
  type SuiteCaseResult, type SuiteEngine, type SuiteRun, type SuiteRunListOptions, type SuiteRunRequest, type SuiteTrace, type SuiteTraceToolCall,
  type SuiteTraceTurn, type SuiteTrend, type SuiteVariant,
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
}

export interface RunOptions {
  actor?: string;
  /** May the run touch real tools (modes none / model, or unmocked tools run for real)? Admins only. */
  allowRealTools?: boolean;
}

const INTERACTIVE_REASONS = new Set(["ask_user", "email_preview", "whatsapp_preview", "vault_preview", "mission_preview"]);

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }

function engineOf(agent: AgentConfig): SuiteEngine {
  if (agentCliEngine(agent)) return "cli";
  if (agentHarness(agent)) return "harness";
  return "native";
}

/** The hooks of one case: mocks, budgets and the trace being written. */
class CaseRecorder implements SuiteCaseHooks {
  readonly mocksModel: boolean;
  readonly turns: SuiteTraceTurn[] = [];
  readonly toolCalls: SuiteTraceToolCall[] = [];
  readonly notes: string[] = [];
  readonly approvals: SuiteTrace["approvals"] = [];
  private scripted = 0;
  private exhausted = false;
  private callsPerTool = new Map<string, number>();
  private mockUse = new Map<number, number>();
  private cost = 0;
  private readonly t0 = Date.now();
  cancelled?: string;
  stoppedBy?: string;

  constructor(readonly plan: PlannedCase, readonly overrides: SuiteRun["variant"]["overrides"], private readonly engine: SuiteEngine) {
    this.mocksModel = modeMocksModel(plan.mode);
  }

  get scriptExhausted(): boolean { return this.exhausted; }

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
    const turns = this.plan.mocks.model?.turns ?? [];
    if (this.scripted < turns.length) return turns[this.scripted++];
    if (!this.exhausted) {
      this.exhausted = true;
      this.notes.push(turns.length ? `The model script ended after ${turns.length} turn(s)` : "This case mocks the model but has no scripted turns");
    }
    return undefined;
  }

  recordTurn(turn: Omit<SuiteTraceTurn, "index">): void {
    this.turns.push({ index: this.turns.length, ...turn });
    this.cost += turn.usage?.costUsd ?? 0;
  }

  async toolCall(name: string, args: Record<string, unknown>, run: () => Promise<string>, callId?: string): Promise<string> {
    const n = (this.callsPerTool.get(name) ?? 0) + 1;
    this.callsPerTool.set(name, n);
    const t0 = Date.now();
    const turn = Math.max(0, this.turns.length - 1);
    const id = callId ?? `call-${this.toolCalls.length + 1}`;
    const record = (result: string, mocked: SuiteTraceToolCall["mocked"], extra: Partial<SuiteTraceToolCall> = {}) => {
      const isError = result.startsWith("Error:");
      const approval = !isError && /^Queued for approval/i.test(result) ? "queued" as const : undefined;
      if (approval) this.approvals.push({ tool: name, kind: approval, detail: result.slice(0, 300) });
      this.toolCalls.push({ id, turn, name, args, result, isError, mocked, durationMs: Date.now() - t0, ...(approval ? { approval } : {}), ...extra });
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
      const stub = SUITE_STUBBED_TOOLS[name];
      if (stub) return record(stub, "stub");
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

export class AgentSuiteRunner {
  private running = new Map<string, { cancel: (reason: string) => void; done: Promise<SuiteRun> }>();
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly deps: AgentSuiteDeps) {}

  // ── suites ──

  private async agentExists(agent: string): Promise<void> {
    if (!(await this.deps.agents()).some((a) => a.name === agent)) throw new AgentSuiteError(`Agent "${agent}" not found`, "NOT_FOUND");
  }

  async listSuites(agent: string): Promise<AgentSuite[]> {
    return (await this.deps.store.listSuites(agent)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSuite(agent: string, id: string): Promise<AgentSuite> {
    const s = await this.deps.store.getSuite(agent, id);
    if (!s) throw new AgentSuiteError(`${agent} has no suite "${id}"`, "NOT_FOUND");
    return s;
  }

  /**
   * Create or replace a suite (validated; ids made from names). `revision`: the revision the edit
   * started from (a newer saved revision refuses the save: someone else changed it).
   */
  async saveSuite(agent: string, input: unknown, opts: { actor?: string; revision?: number; create?: boolean } = {}): Promise<AgentSuite> {
    await this.agentExists(agent);
    const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const id = typeof raw.id === "string" && raw.id ? raw.id : typeof raw.name === "string" ? suiteSlug(raw.name) : undefined;
    const existing = id ? await this.deps.store.getSuite(agent, id) : undefined;
    if (existing && opts.create) throw new AgentSuiteError(`${agent} already has a suite "${id}"`, "CONFLICT");
    if (existing && opts.revision !== undefined && opts.revision !== existing.revision) {
      throw new AgentSuiteError(`The suite changed since you opened it (revision ${existing.revision}, yours ${opts.revision}): reload it and apply your edit again`, "CONFLICT");
    }
    const suite = parseAgentSuite(input, agent, existing);
    if (opts.actor) suite.updatedBy = opts.actor;
    await this.deps.store.saveSuite(suite);
    return suite;
  }

  async deleteSuite(agent: string, id: string): Promise<void> {
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
    return this.saveSuite(agent, { ...suite, datasets }, { actor: opts.actor, revision: suite.revision });
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

  /**
   * Start a run of a suite (or some of its cases) against the agent at `target`, with the variant's
   * overrides. Returns the run as soon as it is recorded; `done` resolves when it finishes.
   */
  async startRun(agent: string, suiteId: string, req: SuiteRunRequest = {}, opts: RunOptions = {}): Promise<{ run: SuiteRun; done: Promise<SuiteRun> }> {
    const suite = await this.getSuite(agent, suiteId);
    if (suite.target.kind !== "agent") throw new AgentSuiteError(`Suites that target a ${suite.target.kind} are not supported yet: only agents`);
    const target = req.target?.trim() || "production";
    const ref = target === "production" ? undefined : target;
    let config: AgentConfig | undefined;
    try { config = await this.deps.resolveAgent(agent, ref); } catch (err) { throw new AgentSuiteError(errorText(err), "NOT_FOUND"); }
    if (!config) throw new AgentSuiteError(`Agent "${agent}" not found`, "NOT_FOUND");
    if (req.repetitions !== undefined && (!Number.isInteger(req.repetitions) || req.repetitions < 1 || req.repetitions > SUITE_LIMITS.maxRepetitions)) {
      throw new AgentSuiteError(`repetitions must be a whole number from 1 to ${SUITE_LIMITS.maxRepetitions}`);
    }
    if (req.baselineRunId) await this.getRun(agent, req.baselineRunId);
    const planned = planSuiteCases(suite, { ...(req.caseIds ? { caseIds: req.caseIds } : {}), ...(req.mode ? { mode: req.mode } : {}), ...(req.repetitions ? { repetitions: req.repetitions } : {}) });
    if (!planned.length) throw new AgentSuiteError(`${suite.name} has no cases to run`);
    const effective = applySuiteOverrides(config, req.overrides);
    const engine = engineOf(effective);
    if (planUsesRealTools(planned) || (engine === "cli" && planned.some((p) => p.mode === "tools"))) {
      if (!opts.allowRealTools) {
        throw new AgentSuiteError("This run would use real tools (a case in mode none or model, unmocked tools run for real, or the CLI engine's own tools): "
          + "it needs the admin scope. Run it in mode all (offline) or tools (mocked tools), or ask an admin.", "FORBIDDEN");
      }
    }
    const version = target === "production" ? await this.deps.productionVersion?.(agent).catch(() => undefined) : target === "draft" ? undefined : target;
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
      trigger: req.trigger ?? "manual",
      status: "queued",
      startedAt: new Date().toISOString(),
      ...(opts.actor ? { actor: opts.actor } : {}),
      planned: planned.map((p) => p.key),
      results: [],
      stats: suiteRunStats([]),
      ...(planned.some((p) => p.attempt) ? { repetitions: Math.max(...planned.map((p) => p.attempt ?? 1)) } : {}),
      notes: [],
    };
    if (engine === "harness") run.notes.push("This agent runs its tasks on a harness; its chats (and these cases) run on Polpo's engine with its model.");
    if (engine === "cli") run.notes.push("CLI engine: the official program's model cannot be scripted; Polpo's tools it calls are mocked, its own tools (Bash, Read, Edit…) run for real.");
    if (planned.some((p) => p.case.scorers?.some((x) => x.type === "llm_judge")) && !this.deps.judge) run.notes.push("No LLM judge on this server: llm_judge scorers error.");
    await this.deps.store.saveRun(run);

    let cancelled: string | undefined;
    const recorders = new Set<CaseRecorder>();
    const done = (async (): Promise<SuiteRun> => {
      await this.acquire();
      try {
        if (cancelled) { run.status = "cancelled"; return run; }
        run.status = "running";
        await this.deps.store.saveRun(run);
        const concurrency = Math.min(SUITE_LIMITS.maxConcurrency, req.concurrency ?? suite.concurrency ?? 1);
        const agentRef = ref ? `${agent}@${ref}` : agent;
        let saving = Promise.resolve();
        await pool(planned, concurrency, async (p) => {
          const result = cancelled
            ? this.skipped(p, engine, variant.id, `Not run: the run was ${cancelled}`)
            : await this.runCase(p, agentRef, engine, variant, suite, (r) => { recorders.add(r); if (cancelled) r.cancelled = cancelled; }, (r) => recorders.delete(r));
          run.results.push(result);
          run.results.sort((a, b) => run.planned.indexOf(a.key) - run.planned.indexOf(b.key));
          run.stats = suiteRunStats(run.results);
          run.aggregates = suiteRunAggregates(run.results, { flakyStddev: suite.evals?.flakyStddev });
          saving = saving.then(() => this.deps.store.saveRun(run)).catch(() => undefined);
          return result;
        });
        await saving;
        run.status = cancelled ? "cancelled" : suiteRunStatus(run.results);
        if (!cancelled) {
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
      trace: { input: [], turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 0, notes: [why] },
      startedAt: new Date().toISOString(), durationMs: 0, costUsd: 0, variantId,
    };
  }

  private async runCase(p: PlannedCase, agentRef: string, engine: SuiteEngine, variant: SuiteVariant, suite: AgentSuite, onStart: (r: CaseRecorder) => void, onEnd: (r: CaseRecorder) => void): Promise<SuiteCaseResult> {
    if (p.case.skip) return this.skipped(p, engine, variant.id, "Skipped (skip: true)");
    if (engine === "cli" && modeMocksModel(p.mode)) {
      const r = this.skipped(p, engine, variant.id, "");
      return { ...r, status: "errored", trace: { ...r.trace, notes: [] }, error: `Mode ${p.mode} scripts the model, which the CLI engine cannot do (the official program calls its own model): use mode tools or none for this agent.` };
    }
    const recorder = new CaseRecorder(p, variant.overrides, engine);
    onStart(recorder);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const messages = caseMessages(p.case.input);
    let reply: SuiteTurnResult | undefined;
    let error: string | undefined;
    try {
      reply = await within(p.budgets.maxDurationMs + 30_000, this.deps.turn(agentRef, messages, recorder), "The case");
    } catch (err) {
      error = errorText(err);
      recorder.cancelled ??= "stopped";
    } finally {
      onEnd(recorder);
    }
    if (recorder.scriptExhausted && p.mocks.model?.onExhausted === "error" && !error) error = "The model script ended before the agent finished (onExhausted: error)";
    // calls that never reached the executor (invalid arguments, a send stopped for a person's yes)
    const seen = new Set(recorder.toolCalls.map((c) => c.id));
    for (const c of reply?.toolCalls ?? []) {
      if (seen.has(c.id)) continue;
      const interactive = c.state === "interrupted";
      if (interactive) recorder.approvals.push({ tool: c.name, kind: "interactive" });
      const turnIdx = Math.max(0, recorder.turns.findIndex((t) => t.toolCalls.some((x) => x.id === c.id)));
      recorder.toolCalls.push({
        id: c.id, turn: turnIdx, name: c.name, args: c.arguments ?? {}, result: c.result ?? (interactive ? "Waiting for a person (not run)" : ""),
        isError: c.state === "error", mocked: false, durationMs: 0, ...(interactive ? { approval: "interactive" as const } : {}),
      });
    }
    if (reply?.finishReason && INTERACTIVE_REASONS.has(reply.finishReason) && !recorder.approvals.some((a) => a.kind === "interactive")) {
      recorder.approvals.push({ tool: reply.finishReason.replace(/_preview$/, "_send"), kind: "interactive", detail: reply.finishReason });
    }
    const usage = recorder.turns.reduce((u, t) => ({
      inputTokens: u.inputTokens + (t.usage?.inputTokens ?? 0), outputTokens: u.outputTokens + (t.usage?.outputTokens ?? 0), costUsd: u.costUsd + (t.usage?.costUsd ?? 0),
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const trace: SuiteTrace = {
      input: messages,
      turns: recorder.turns,
      toolCalls: recorder.toolCalls.sort((a, b) => a.turn - b.turn),
      text: reply?.text ?? "",
      finishReason: recorder.stoppedBy ? "budget" : reply?.finishReason ?? (error ? "error" : undefined),
      approvals: recorder.approvals,
      usage: { ...usage, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 },
      durationMs: Date.now() - t0,
      notes: recorder.notes,
    };
    const assertions = error ? [] : p.case.assertions.map((a) => evaluateAssertion(a, trace));
    // the scorers (evals) run after the turn, outside the case's hooks: a judge calls its real model
    const scores = error || !p.case.scorers?.length ? undefined : await scoreSuiteCase(p.case.scorers, { trace, input: p.case.input, ...(p.row ? { row: p.row.values } : {}) }, {
      ...(this.deps.judge ? { judge: this.deps.judge } : {}), ...(this.deps.customScorer ? { custom: this.deps.customScorer } : {}),
      ...(suite.evals?.judgeModel ? { judgeModel: suite.evals.judgeModel } : {}),
    });
    const scorerError = scores?.find((x) => x.error);
    if (scorerError && !error) error = `Scorer ${scorerError.id}: ${scorerError.error}`;
    if (!error && !assertions.length && !scores?.length) trace.notes.push("This case has no assertions: it passes when it runs without errors");
    const score = caseOverallScore(scores);
    return {
      key: p.key, caseId: p.case.id, caseName: p.case.name, ...(p.row ? { row: p.row } : {}), ...(p.attempt ? { attempt: p.attempt } : {}),
      status: error ? "errored" : assertions.every((a) => a.passed) && (scores ?? []).every((x) => x.passed) ? "passed" : "failed",
      mode: p.mode, engine, assertions, ...(scores ? { scores } : {}), ...(score !== undefined ? { score } : {}), trace,
      ...(error ? { error } : {}),
      startedAt, durationMs: trace.durationMs, costUsd: trace.usage.costUsd, variantId: variant.id,
    };
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
    const picked = pickSuiteBaseline(await this.deps.store.listRuns(run.agent, { suiteId: run.suiteId }), run, suite.evals?.baseline ?? "previous");
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
    const suite = await this.deps.store.getSuite(agent, run.suiteId);
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
    const config = await this.deps.resolveAgent(agent, run.target === "production" ? undefined : run.target).catch(() => undefined)
      ?? (await this.deps.agents()).find((a) => a.name === agent);
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

  /** The agent was removed: drop its suites and runs. */
  forget(agent: string): Promise<void> { return this.deps.store.deleteAgent(agent); }
}


/** Run a turn under a case's hooks (the host's `turn` wraps the completions call with this). */
export { runAsSuiteCase };
