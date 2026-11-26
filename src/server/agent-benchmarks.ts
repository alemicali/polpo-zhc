/**
 * Benchmarks and the Playground (agent suites phase 5; docs/agent-suites.md, "Benchmarks" and
 * "Playground").
 *
 * A benchmark run starts one suite run per (suite, variant, repetition) on the suite runner: the same
 * engine, the same limits (two runs at a time on the instance — the others wait, queued —, each run's
 * case concurrency), each run tagged with the benchmark and its variant. Before it starts, the cost is
 * estimated (from the suite's past runs on that model, else from the prompt size and the model's
 * price): a benchmark that calls a real model needs a confirmation, and its budget cap stops it (the
 * runs not finished are cancelled) once it has spent that much. Progress goes out as the
 * `benchmark:progress` event (SSE).
 *
 * The Playground: 2–4 panes, each a variant with its own mocks; an exchange is a chat turn through
 * the suite runner's path and hooks (src/server/agent-suites.ts, playgroundTurn), its chat deleted
 * afterwards like a case's. Sessions live in memory (ephemeral; dropped after two idle hours).
 */
import { randomUUID } from "node:crypto";
import {
  AgentSuiteError, BENCHMARK_LIMITS, DEFAULT_BENCHMARK_WEIGHTS, benchmarkLeaderboard, benchmarkMatrix, benchmarkProgress, benchmarkVariantStats,
  compareBenchmarkCase, heuristicCaseCostUsd, mergeSuiteMocks, modeMocksModel, parseBenchmark, parseBenchmarkSpec, parsePlaygroundPanes, playgroundCase,
  playgroundPaneMode, promotionFields, summarizeBenchmarkEstimate,
  type AgentSuite, type BenchmarkCaseComparison, type BenchmarkDefinition, type BenchmarkEstimate, type BenchmarkEstimateCell,
  type BenchmarkLeaderboard, type BenchmarkMatrix, type BenchmarkRun, type BenchmarkRunEntry, type BenchmarkSpec, type BenchmarkVariantStats,
  type BenchmarkWeights, type ModelPrice, type PlaygroundExchange, type PlaygroundPane, type PlaygroundSession, type SuiteCase, type SuiteMocks,
  type SuiteRun, type SuiteTraceToolCall, type SuiteTraceTurn, type SuiteVariantOverrides,
} from "@polpo-ai/core/agent-suites";
import { suiteRoleFor, type AgentConfig, type SuiteRole } from "@polpo-ai/core";
import type { AgentSuiteRunner } from "./agent-suites.js";
import type { BenchmarkStore } from "../stores/file-benchmark-store.js";

export interface BenchmarkProgressEvent {
  benchmarkRunId: string;
  benchmarkId?: string;
  name: string;
  status: BenchmarkRun["status"];
  stopReason?: BenchmarkRun["stopReason"];
  progress: BenchmarkRun["progress"];
  spentUsd: number;
  budgetUsd?: number;
  timestamp: string;
}

export interface AgentBenchmarkDeps {
  runner: () => AgentSuiteRunner;
  store: BenchmarkStore;
  agents: () => Promise<AgentConfig[]>;
  /** The agent at a ref (production: undefined, "draft", "1.2.0"). */
  resolveAgent: (name: string, ref?: string) => Promise<AgentConfig | undefined>;
  /** A model's price per million tokens and its id (undefined spec: the default model); undefined when unknown. */
  price?: (spec: string | undefined) => Promise<{ model: string; price: ModelPrice } | undefined>;
  /** The price of the model a suite's judge plays on (its agent's, its model block's, else Polpo's). */
  judgePrice?: (role?: SuiteRole) => Promise<ModelPrice | undefined>;
  /** benchmark:progress (live clients). */
  emit?: (e: BenchmarkProgressEvent) => void;
  /** Write fields into the agent's draft (never deployed): "Promote variant". */
  writeDraft?: (agent: string, fields: Record<string, unknown>, opts: { actor?: string; note?: string }) => Promise<{ draftChanged: boolean }>;
}

export interface StartOptions {
  actor?: string;
  /** May the runs touch real tools (admins, after a confirmation)? */
  allowRealTools?: boolean;
  /** The person saw the estimate and confirmed the cost (needed when a real model is called). */
  confirm?: boolean;
  /** Overrides the definition's budget cap (USD). */
  budgetUsd?: number;
  source?: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const PLAYGROUND_TTL_MS = 2 * 60 * 60 * 1000;
const PLAYGROUND_SESSIONS = 50;

export class AgentBenchmarks {
  private live = new Map<string, { cancel: (reason: "cancelled" | "budget") => Promise<void>; done: Promise<BenchmarkRun> }>();
  private sessions = new Map<string, PlaygroundSession & { lastUsed: number; busy?: boolean }>();

  constructor(private readonly deps: AgentBenchmarkDeps) {}

  private get runner(): AgentSuiteRunner { return this.deps.runner(); }

  // ── definitions ──

  async list(): Promise<BenchmarkDefinition[]> {
    return (await this.deps.store.listDefinitions()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<BenchmarkDefinition> {
    const d = await this.deps.store.getDefinition(id);
    if (!d) throw new AgentSuiteError(`There is no benchmark "${id}"`, "NOT_FOUND");
    return d;
  }

  async save(input: unknown, opts: { actor?: string; revision?: number; create?: boolean; id?: string } = {}): Promise<BenchmarkDefinition> {
    const raw = input && typeof input === "object" ? { ...(input as Record<string, unknown>), ...(opts.id ? { id: opts.id } : {}) } : input;
    const spec = parseBenchmarkSpec(raw);
    const id = spec.id;
    const existing = id ? await this.deps.store.getDefinition(id) : undefined;
    if (existing && opts.create) throw new AgentSuiteError(`There is already a benchmark "${id}"`, "CONFLICT");
    if (existing && opts.revision !== undefined && opts.revision !== existing.revision) {
      throw new AgentSuiteError(`The benchmark changed since you opened it (revision ${existing.revision}, yours ${opts.revision}): reload it and apply your edit again`, "CONFLICT");
    }
    const def = parseBenchmark(raw, existing);
    if (!existing && (await this.deps.store.listDefinitions()).length >= BENCHMARK_LIMITS.definitions) throw new AgentSuiteError(`At most ${BENCHMARK_LIMITS.definitions} benchmarks`, "CONFLICT");
    await this.checkRefs(def);
    if (opts.actor) def.updatedBy = opts.actor;
    await this.deps.store.saveDefinition(def);
    return def;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.deps.store.deleteDefinition(id))) throw new AgentSuiteError(`There is no benchmark "${id}"`, "NOT_FOUND");
  }

  /** Every suite and variant agent exists. */
  private async checkRefs(spec: BenchmarkSpec): Promise<void> {
    const agents = new Set((await this.deps.agents()).map((a) => a.name));
    for (const v of spec.variants) if (!agents.has(v.agent)) throw new AgentSuiteError(`Variant ${v.id}: there is no agent "${v.agent}"`, "NOT_FOUND");
    for (const s of spec.suites) {
      if (!agents.has(s.agent)) throw new AgentSuiteError(`There is no agent "${s.agent}" (suite ${s.suite})`, "NOT_FOUND");
      const suite = await this.runner.getSuite(s.agent, s.suite);
      if (s.dataset && !suite.datasets.some((d) => d.id === s.dataset)) throw new AgentSuiteError(`${suite.name} has no dataset "${s.dataset}"`, "NOT_FOUND");
      if (s.dataset && !suite.cases.some((c) => c.dataset === s.dataset)) throw new AgentSuiteError(`No case of ${suite.name} uses the dataset "${s.dataset}"`);
    }
  }

  /** The spec a request means: a saved benchmark (benchmarkId, or `benchmark`), or an inline one. */
  async specOf(req: { benchmarkId?: string; benchmark?: unknown }): Promise<{ spec: BenchmarkSpec; benchmarkId?: string }> {
    if (req.benchmarkId) {
      const d = await this.get(req.benchmarkId);
      const { revision: _r, createdAt: _c, updatedAt: _u, updatedBy: _b, ...spec } = d;
      return { spec, benchmarkId: d.id };
    }
    if (req.benchmark === undefined) throw new AgentSuiteError("Give benchmarkId (a saved benchmark) or benchmark (an inline one: { name, suites, variants, repetitions? })");
    const spec = parseBenchmarkSpec(req.benchmark);
    await this.checkRefs(spec);
    return { spec };
  }

  private caseIdsFor(suite: AgentSuite, ref: BenchmarkSpec["suites"][number]): string[] | undefined {
    if (ref.dataset) return suite.cases.filter((c) => c.dataset === ref.dataset && (!ref.caseIds || ref.caseIds.includes(c.id))).map((c) => c.id);
    return ref.caseIds;
  }

  // ── estimate ──

  /**
   * What the benchmark would cost: per (suite, variant), the cases, those that call the real model
   * and the judges, priced from the suite's past runs of that variant's model, else from the prompt
   * size and the model's price. Also checks every run can start (versions, cases).
   */
  async estimate(spec: BenchmarkSpec): Promise<BenchmarkEstimate> {
    const cells: BenchmarkEstimateCell[] = [];
    const notes: string[] = [];
    let judgeUnpriced = false;
    for (const ref of spec.suites) {
      const suite = await this.runner.getSuite(ref.agent, ref.suite);
      const judgePrice = await this.deps.judgePrice?.(suiteRoleFor(suite, "judge")).catch(() => undefined);
      const caseIds = this.caseIdsFor(suite, ref);
      const history = await this.runner.listRuns(ref.agent, { suiteId: suite.id, limit: 40 });
      for (const v of spec.variants) {
        const pf = await this.runner.preflight(ref.agent, suite.id, {
          target: v.version, ...(v.overrides ? { overrides: v.overrides } : {}), variant: { id: v.id, agent: v.agent },
          ...(spec.mode ? { mode: spec.mode } : {}), ...(caseIds?.length ? { caseIds } : {}),
        }, { allowRealTools: true });
        const judges = pf.planned.reduce((a, p) => a + (p.case.scorers?.filter((x) => x.type === "llm_judge").length ?? 0), 0);
        if (judges && !judgePrice) judgeUnpriced = true;
        const judgeCost = judges && judgePrice ? heuristicCaseCostUsd({ promptChars: 0, turns: 1, price: { input: 0, output: 0 }, judges, judgePrice }) : 0;
        const priced = pf.realModelCases ? await this.deps.price?.(typeof pf.config?.model === "string" ? pf.config.model : undefined).catch(() => undefined) : undefined;
        let basis: BenchmarkEstimateCell["basis"] = pf.realModelCases ? "unknown" : "offline";
        let perCase = 0;
        if (pf.realModelCases) {
          // the suite's past runs of the same agent and model, real-model cases only
          const model = v.overrides?.model ?? "";
          const past = history.filter((r) => (r.variant.agent ?? r.agent) === v.agent && (r.variant.overrides?.model ?? "") === model && r.status !== "running" && r.status !== "queued");
          const realResults = past.flatMap((r) => r.results.filter((x) => x.status !== "skipped" && !modeMocksModel(x.mode) && x.costUsd > 0));
          if (realResults.length >= 2) {
            basis = "history";
            perCase = realResults.reduce((a, x) => a + x.costUsd, 0) / realResults.length;
          } else if (priced) {
            basis = "heuristic";
            const prompt = (pf.config?.systemPrompt?.length ?? 0);
            const real = pf.planned.filter((p) => !modeMocksModel(p.mode));
            perCase = real.reduce((a, p) => a + heuristicCaseCostUsd({
              promptChars: prompt + p.case.input.message.length + (p.case.input.history ?? []).reduce((n, m) => n + m.content.length, 0),
              turns: Math.min(p.budgets.maxTurns, p.mocks.simulatedUser ? 6 : 3), price: priced.price,
            }), 0) / Math.max(1, real.length);
          }
        }
        cells.push({
          suite: suite.id, owner: ref.agent, variantId: v.id, cases: pf.planned.length, realModelCases: pf.realModelCases, judgeCalls: judges,
          costUsd: Math.round((perCase * pf.realModelCases + judgeCost) * spec.repetitions * 1e6) / 1e6,
          basis, ...(priced ? { model: priced.model } : typeof pf.config?.model === "string" ? { model: pf.config.model } : {}), realTools: pf.realTools,
        });
      }
    }
    if (judgeUnpriced) notes.push("LLM judges score some cases; their model's price is unknown and left out.");
    return summarizeBenchmarkEstimate(cells, spec.repetitions, notes);
  }

  // ── runs ──

  listRuns(opts: { benchmarkId?: string; limit?: number } = {}): Promise<BenchmarkRun[]> { return this.deps.store.listRuns(opts); }

  async getRun(id: string): Promise<BenchmarkRun> {
    const r = await this.deps.store.getRun(id);
    if (!r) throw new AgentSuiteError(`There is no benchmark run "${id}"`, "NOT_FOUND");
    if ((r.status === "running" || r.status === "queued") && !this.live.has(id)) {
      // left over by a restart: its suite runs were finished as cancelled by theirs
      r.status = "cancelled";
      r.stopReason = "cancelled";
      r.finishedAt = new Date().toISOString();
      r.notes.push("Cancelled: the server restarted during the benchmark");
      await this.deps.store.saveRun(r);
    }
    return r;
  }

  /**
   * Start a benchmark run: estimate it, check the confirmation, the budget cap and the real tools,
   * then start every (suite, variant, repetition) run on the suite runner (they wait their turn).
   */
  async start(req: { benchmarkId?: string; benchmark?: unknown }, opts: StartOptions = {}): Promise<{ run: BenchmarkRun; done: Promise<BenchmarkRun>; estimate: BenchmarkEstimate }> {
    const { spec, benchmarkId } = await this.specOf(req);
    const estimate = await this.estimate(spec);
    if (estimate.realTools && !opts.allowRealTools) {
      throw new AgentSuiteError("Some runs of this benchmark would use real tools (a case in mode none or model, unmocked tools run for real, or a CLI engine's own tools): it needs the admin scope and a confirmation. Run it in mode all or tools.", "FORBIDDEN");
    }
    const budgetUsd = opts.budgetUsd ?? spec.budgetUsd;
    if (!estimate.offline && !opts.confirm) {
      throw Object.assign(new AgentSuiteError(`This benchmark calls real models: about $${estimate.costUsd.toFixed(4)} (up to $${estimate.maxCostUsd.toFixed(4)})${estimate.unknownPrice ? " plus models with no known price" : ""}. Confirm the cost to start it (confirm: true).`, "CONFLICT"), { reason: "CONFIRM_COST", estimate });
    }
    if (budgetUsd !== undefined && estimate.costUsd > budgetUsd) {
      throw Object.assign(new AgentSuiteError(`The estimate ($${estimate.costUsd.toFixed(4)}) is above the budget cap ($${budgetUsd.toFixed(2)}): raise the cap, or run fewer variants, repetitions or cases.`, "CONFLICT"), { reason: "OVER_BUDGET", estimate });
    }
    const now = new Date().toISOString();
    const run: BenchmarkRun = {
      id: `br-${randomUUID().slice(0, 12)}`, ...(benchmarkId ? { benchmarkId } : {}), name: spec.name, spec,
      status: "queued", startedAt: now, ...(opts.actor ? { actor: opts.actor } : {}), estimate,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}), spentUsd: 0, runs: [],
      progress: { runsDone: 0, runsTotal: estimate.runs, casesDone: 0, casesTotal: estimate.cases },
      ...(opts.source ? { source: opts.source } : {}), notes: [],
    };
    await this.deps.store.saveRun(run);

    let stop: "cancelled" | "budget" | undefined;
    let saving = Promise.resolve();
    const persist = () => { const copy = JSON.parse(JSON.stringify(run)) as BenchmarkRun; saving = saving.then(() => this.deps.store.saveRun(copy)).catch(() => undefined); };
    const emit = () => {
      try {
        this.deps.emit?.({
          benchmarkRunId: run.id, ...(run.benchmarkId ? { benchmarkId: run.benchmarkId } : {}), name: run.name, status: run.status,
          ...(run.stopReason ? { stopReason: run.stopReason } : {}), progress: run.progress, spentUsd: run.spentUsd,
          ...(run.budgetUsd !== undefined ? { budgetUsd: run.budgetUsd } : {}), timestamp: new Date().toISOString(),
        });
      } catch { /* a listener's problem is not the benchmark's */ }
    };
    const update = (entry: BenchmarkRunEntry, r: SuiteRun) => {
      entry.status = r.status;
      entry.costUsd = r.stats.costUsd;
      entry.passed = r.stats.passed;
      entry.total = r.stats.total - r.stats.skipped;
      entry.done = r.results.length;
      if (r.aggregates?.score !== undefined) entry.score = r.aggregates.score; else delete entry.score;
      if (r.error) entry.error = r.error;
      run.spentUsd = Math.round(run.runs.reduce((a, e) => a + e.costUsd, 0) * 1e6) / 1e6;
      run.progress = benchmarkProgress(run.runs);
      if (run.budgetUsd !== undefined && run.spentUsd >= run.budgetUsd && !stop) void cancelAll("budget");
      persist();
      emit();
    };
    const cancelAll = async (reason: "cancelled" | "budget") => {
      if (stop) return;
      stop = reason;
      run.stopReason = reason;
      if (reason === "budget") run.notes.push(`Stopped: it spent $${run.spentUsd.toFixed(4)}, the budget cap is $${run.budgetUsd?.toFixed(2)}; the runs not finished were cancelled.`);
      await Promise.all(run.runs.filter((e) => e.status === "running" || e.status === "queued").map((e) => this.runner.cancelRun(e.owner, e.runId).catch(() => undefined)));
    };

    // start every (repetition, variant, suite): interleaved, so every variant moves forward together
    const dones: Array<Promise<SuiteRun>> = [];
    run.status = "running";
    try {
      for (let rep = 1; rep <= spec.repetitions; rep++) {
        for (const v of spec.variants) {
          for (const ref of spec.suites) {
            if (stop) break;
            const suite = await this.runner.getSuite(ref.agent, ref.suite);
            const caseIds = this.caseIdsFor(suite, ref);
            const entry: BenchmarkRunEntry = {
              runId: "", owner: ref.agent, suiteId: suite.id, suiteName: suite.name, variantId: v.id, repetition: rep,
              status: "queued", costUsd: 0, passed: 0, total: 0, done: 0, planned: 0,
            };
            const started = await this.runner.startRun(ref.agent, suite.id, {
              target: v.version, ...(v.overrides ? { overrides: v.overrides } : {}), variant: { id: v.id, ...(v.label ? { label: v.label } : {}), agent: v.agent },
              benchmarkRunId: run.id, repetition: rep, trigger: "benchmark",
              ...(spec.mode ? { mode: spec.mode } : {}), ...(spec.concurrency ? { concurrency: spec.concurrency } : {}), ...(caseIds?.length ? { caseIds } : {}),
            }, { ...(opts.actor ? { actor: opts.actor } : {}), allowRealTools: opts.allowRealTools === true, onProgress: (r) => update(entry, r) });
            entry.runId = started.run.id;
            entry.planned = started.run.planned.length;
            run.runs.push(entry);
            dones.push(started.done.then((r) => { update(entry, r); return r; }));
          }
        }
      }
    } catch (err) {
      run.error = `Could not start every run: ${errorText(err)}`;
      await cancelAll("cancelled");
      run.stopReason = "error";
    }
    run.progress = benchmarkProgress(run.runs);
    persist();
    emit();

    const done = (async (): Promise<BenchmarkRun> => {
      try {
        await Promise.allSettled(dones);
        await saving;
        const full = await this.suiteRuns(run);
        const stats = benchmarkVariantStats(full, spec.variants);
        run.leaderboard = benchmarkLeaderboard(stats, spec.weights ?? DEFAULT_BENCHMARK_WEIGHTS);
        run.status = run.stopReason === "error" ? "errored" : stop ? "cancelled" : run.runs.length && run.runs.every((e) => e.status === "errored") ? "errored" : "completed";
      } catch (err) {
        run.status = "errored";
        run.error = errorText(err);
      } finally {
        run.finishedAt = new Date().toISOString();
        run.progress = benchmarkProgress(run.runs);
        await saving;
        await this.deps.store.saveRun(run).catch(() => undefined);
        this.live.delete(run.id);
        emit();
      }
      return run;
    })();
    this.live.set(run.id, { cancel: cancelAll, done });
    return { run: JSON.parse(JSON.stringify(run)) as BenchmarkRun, done, estimate };
  }

  /** Stop a benchmark: its runs not finished are cancelled (cases not started skipped). */
  async cancel(id: string): Promise<BenchmarkRun> {
    const live = this.live.get(id);
    if (!live) return this.getRun(id);
    await live.cancel("cancelled");
    return live.done;
  }

  /** Wait for a benchmark run to finish (at most `ms`); the run as it is then. */
  async wait(id: string, ms: number): Promise<BenchmarkRun> {
    const live = this.live.get(id);
    if (live) await Promise.race([live.done, new Promise((r) => setTimeout(r, Math.max(0, ms)).unref?.())]);
    return this.getRun(id);
  }

  /** The benchmark's suite runs, in full (traces included). */
  private async suiteRuns(run: BenchmarkRun): Promise<SuiteRun[]> {
    const out: SuiteRun[] = [];
    for (const e of run.runs) {
      if (!e.runId) continue;
      const r = await this.runner.store.getRun(e.owner, e.runId);
      if (r) out.push(r);
    }
    return out;
  }

  /** The comparison: per-variant stats, the leaderboard (with these weights) and the case × variant matrix. */
  async report(id: string, weights?: BenchmarkWeights): Promise<{ run: BenchmarkRun; stats: BenchmarkVariantStats[]; leaderboard: BenchmarkLeaderboard; matrix: BenchmarkMatrix }> {
    const run = await this.getRun(id);
    const full = await this.suiteRuns(run);
    const stats = benchmarkVariantStats(full, run.spec.variants);
    return { run, stats, leaderboard: benchmarkLeaderboard(stats, weights ?? run.spec.weights ?? DEFAULT_BENCHMARK_WEIGHTS), matrix: benchmarkMatrix(full, run.spec.variants) };
  }

  /**
   * One case side by side for 2–4 variants (default: every variant, at most four): the result of
   * `repetition` (default the first that has one), tool calls and final answers diffed against the
   * first column.
   */
  async compareCase(id: string, caseKey: string, opts: { variants?: string[]; repetition?: number } = {}): Promise<BenchmarkCaseComparison> {
    const run = await this.getRun(id);
    const full = await this.suiteRuns(run);
    const matrix = benchmarkMatrix(full, run.spec.variants);
    const row = matrix.rows.find((r) => r.key === caseKey) ?? matrix.rows.find((r) => r.caseKey === caseKey || r.caseId === caseKey);
    if (!row) throw new AgentSuiteError(`The benchmark has no case "${caseKey}"`, "NOT_FOUND");
    const wanted = (opts.variants?.length ? opts.variants : run.spec.variants.map((v) => v.id)).slice(0, BENCHMARK_LIMITS.compareColumns);
    const unknown = wanted.filter((v) => !run.spec.variants.some((x) => x.id === v));
    if (unknown.length) throw new AgentSuiteError(`The benchmark has no variant ${unknown.join(", ")}`, "NOT_FOUND");
    const cols = [];
    for (const vid of wanted) {
      const cell = row.cells[vid];
      const pick = cell?.results.find((x) => opts.repetition === undefined || x.repetition === opts.repetition) ?? cell?.results[0];
      if (!pick) continue;
      const suiteRun = full.find((r) => r.id === pick.runId);
      const result = suiteRun?.results.find((x) => x.key === pick.key);
      if (!suiteRun || !result) continue;
      const v = run.spec.variants.find((x) => x.id === vid)!;
      cols.push({ variantId: vid, label: v.label ?? v.id, runId: pick.runId, owner: pick.owner, repetition: pick.repetition, result });
    }
    return compareBenchmarkCase(cols, row.key);
  }

  // ── Playground ──

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastUsed > PLAYGROUND_TTL_MS && !s.busy) this.sessions.delete(id);
    while (this.sessions.size > PLAYGROUND_SESSIONS) {
      const oldest = [...this.sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }
  }

  private view(s: PlaygroundSession & { lastUsed: number; busy?: boolean }): PlaygroundSession {
    const { lastUsed: _l, busy: _b, ...rest } = s;
    return JSON.parse(JSON.stringify(rest)) as PlaygroundSession;
  }

  async createSession(panesInput: unknown, opts: { actor?: string } = {}): Promise<PlaygroundSession> {
    this.prune();
    const panes = parsePlaygroundPanes(panesInput);
    await this.checkPanes(panes);
    const now = new Date().toISOString();
    const s = { id: `pg-${randomUUID().slice(0, 12)}`, panes, exchanges: Object.fromEntries(panes.map((p) => [p.id, [] as PlaygroundExchange[]])), createdAt: now, updatedAt: now, ...(opts.actor ? { actor: opts.actor } : {}), lastUsed: Date.now() };
    this.sessions.set(s.id, s);
    return this.view(s);
  }

  private session(id: string): PlaygroundSession & { lastUsed: number; busy?: boolean } {
    this.prune();
    const s = this.sessions.get(id);
    if (!s) throw new AgentSuiteError(`There is no Playground session "${id}" (sessions are ephemeral: they end after two idle hours or a restart)`, "NOT_FOUND");
    s.lastUsed = Date.now();
    return s;
  }

  getSession(id: string): PlaygroundSession { return this.view(this.session(id)); }

  listSessions(actor?: string): PlaygroundSession[] {
    this.prune();
    return [...this.sessions.values()].filter((s) => !actor || !s.actor || s.actor === actor).map((s) => this.view(s));
  }

  /** Replace the panes: a pane whose variant and toggles are unchanged keeps its conversation. */
  async updateSession(id: string, panesInput: unknown): Promise<PlaygroundSession> {
    const s = this.session(id);
    const panes = parsePlaygroundPanes(panesInput);
    await this.checkPanes(panes);
    const same = (a: PlaygroundPane, b: PlaygroundPane | undefined) => !!b && JSON.stringify({ ...a, label: undefined }) === JSON.stringify({ ...b, label: undefined });
    s.exchanges = Object.fromEntries(panes.map((p) => [p.id, same(p, s.panes.find((x) => x.id === p.id)) ? s.exchanges[p.id] ?? [] : []]));
    s.panes = panes;
    s.updatedAt = new Date().toISOString();
    return this.view(s);
  }

  deleteSession(id: string): void {
    if (!this.sessions.delete(id)) throw new AgentSuiteError(`There is no Playground session "${id}"`, "NOT_FOUND");
  }

  /** Clear a pane's conversation (or every pane's). */
  resetSession(id: string, paneId?: string): PlaygroundSession {
    const s = this.session(id);
    for (const p of s.panes) if (!paneId || p.id === paneId) s.exchanges[p.id] = [];
    return this.view(s);
  }

  private async checkPanes(panes: PlaygroundPane[]): Promise<void> {
    const agents = new Set((await this.deps.agents()).map((a) => a.name));
    for (const p of panes) {
      if (!agents.has(p.variant.agent)) throw new AgentSuiteError(`Pane ${p.id}: there is no agent "${p.variant.agent}"`, "NOT_FOUND");
      if (p.mocks?.suite) await this.runner.getSuite(p.mocks.suite.agent, p.mocks.suite.suite);
    }
  }

  /** A pane's mocks: its inline mocks first, then the suite's case and shared mocks. */
  private async paneMocks(p: PlaygroundPane): Promise<SuiteMocks> {
    let fromSuite: SuiteMocks = {};
    if (p.mocks?.suite) {
      const suite = await this.runner.getSuite(p.mocks.suite.agent, p.mocks.suite.suite);
      const c = p.mocks.suite.caseId ? suite.cases.find((x) => x.id === p.mocks!.suite!.caseId) : undefined;
      if (p.mocks.suite.caseId && !c) throw new AgentSuiteError(`${suite.name} has no case "${p.mocks.suite.caseId}"`, "NOT_FOUND");
      fromSuite = mergeSuiteMocks(suite.mocks, c?.mocks);
    }
    const tools = p.mockTools ? [...(p.mocks?.tools ?? []), ...(fromSuite.tools ?? [])] : [];
    const model = p.mocks?.model ?? fromSuite.model;
    return { ...(tools.length ? { tools } : {}), ...(model ? { model } : {}), unmockedTools: p.realTools ? "real" : "block" };
  }

  /**
   * Send a message to some panes (default every pane) at once; each pane continues its own
   * conversation. Panes with real tools need `allowRealTools` (admins, after a confirmation).
   * `onEvent` streams each pane's reply text, model turns and tool calls.
   */
  async send(id: string, req: { message: string; paneIds?: string[]; allowRealTools?: boolean }, onEvent?: (paneId: string, e: PlaygroundStreamEvent) => void, signal?: AbortSignal): Promise<{ session: PlaygroundSession; exchanges: Record<string, PlaygroundExchange> }> {
    const s = this.session(id);
    const message = req.message?.trim();
    if (!message) throw new AgentSuiteError("message is required");
    if (message.length > 50_000) throw new AgentSuiteError("message is longer than 50,000 characters");
    const panes = req.paneIds?.length ? s.panes.filter((p) => req.paneIds!.includes(p.id)) : s.panes;
    const unknown = (req.paneIds ?? []).filter((x) => !s.panes.some((p) => p.id === x));
    if (unknown.length) throw new AgentSuiteError(`No pane ${unknown.join(", ")}`, "NOT_FOUND");
    if (panes.some((p) => p.realTools) && !req.allowRealTools) {
      throw new AgentSuiteError(`Pane ${panes.filter((p) => p.realTools).map((p) => p.label ?? p.id).join(", ")} runs real tools (side effects possible): it needs the admin scope and a confirmation (allowRealTools: true)`, "FORBIDDEN");
    }
    if (s.busy) throw new AgentSuiteError("This Playground session is answering a message: wait for it", "CONFLICT");
    s.busy = true;
    const mocksByPane = new Map<string, SuiteMocks>();
    try {
      for (const p of panes) mocksByPane.set(p.id, await this.paneMocks(p));
      const results = await Promise.all(panes.map(async (p) => {
        const history = (s.exchanges[p.id] ?? []).flatMap((x) => [{ role: "user" as const, content: x.message }, { role: "assistant" as const, content: x.trace.text }]);
        const messages = [...history, { role: "user" as const, content: message }];
        const mode = playgroundPaneMode(p) as "all" | "tools";
        const t0 = Date.now();
        onEvent?.(p.id, { type: "start", mode });
        let out: { trace: PlaygroundExchange["trace"]; error?: string };
        try {
          out = await this.runner.playgroundTurn({
            agent: p.variant.agent, version: p.variant.version, ...(p.variant.overrides ? { overrides: p.variant.overrides } : {}),
            messages, mode, mocks: mocksByPane.get(p.id)!, realTools: p.realTools,
            onText: (delta) => onEvent?.(p.id, { type: "text", delta }),
            onEvent: (e) => onEvent?.(p.id, e),
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          out = { trace: { input: messages, turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: Date.now() - t0, notes: [] }, error: errorText(err) };
        }
        const ex: PlaygroundExchange = {
          index: (s.exchanges[p.id] ?? []).length, message, at: new Date(t0).toISOString(), trace: out.trace, mode,
          status: out.error ? "error" : out.trace.finishReason === "budget" ? "stopped" : "done", ...(out.error ? { error: out.error } : {}),
          costUsd: out.trace.usage.costUsd, durationMs: out.trace.durationMs, tokens: { input: out.trace.usage.inputTokens, output: out.trace.usage.outputTokens },
        };
        (s.exchanges[p.id] ??= []).push(ex);
        onEvent?.(p.id, { type: "done", exchange: ex });
        return [p.id, ex] as const;
      }));
      s.updatedAt = new Date().toISOString();
      return { session: this.view(s), exchanges: Object.fromEntries(results) };
    } finally {
      s.busy = false;
      s.lastUsed = Date.now();
    }
  }

  /** A headless comparison: a temporary session, one message to every pane, the session dropped. */
  async sendOnce(panes: unknown, req: { message: string; allowRealTools?: boolean }, opts: { actor?: string } = {}): Promise<{ panes: PlaygroundPane[]; exchanges: Record<string, PlaygroundExchange> }> {
    const s = await this.createSession(panes, opts);
    try {
      const r = await this.send(s.id, req);
      return { panes: r.session.panes, exchanges: r.exchanges };
    } finally {
      this.sessions.delete(s.id);
    }
  }

  /**
   * "Save as test case": a pane's exchange as a case (observed tool calls as mocks and checks;
   * `mockModel` also scripts the model). With `suite`, it is added to that suite; otherwise it is
   * returned for review (save it with POST /agents/{name}/suites/{id}/cases).
   */
  async caseFromExchange(id: string, req: { paneId: string; exchange?: number; name?: string; mockModel?: boolean; save?: { agent: string; suite: string } }, opts: { actor?: string } = {}): Promise<{ case: SuiteCase; suite?: AgentSuite }> {
    const s = this.session(id);
    const list = s.exchanges[req.paneId];
    if (!list) throw new AgentSuiteError(`No pane ${req.paneId}`, "NOT_FOUND");
    const ex = req.exchange === undefined ? list[list.length - 1] : list[req.exchange];
    if (!ex) throw new AgentSuiteError(`Pane ${req.paneId} has no exchange${req.exchange !== undefined ? ` ${req.exchange}` : ""} yet`, "NOT_FOUND");
    if (ex.status === "error") throw new AgentSuiteError("This exchange failed: there is nothing to turn into a case");
    const c = playgroundCase(ex, { ...(req.name ? { name: req.name } : {}), mockModel: req.mockModel === true });
    if (!req.save) return { case: c };
    const suite = await this.runner.acceptCases(req.save.agent, req.save.suite, { cases: [c] }, opts.actor ? { actor: opts.actor } : {});
    return { case: suite.cases[suite.cases.length - 1] ?? c, suite };
  }

  /**
   * "Promote variant": write the variant's overrides into the agent's draft (from the agent at the
   * variant's version). Never deploys: publish and deploy the draft as usual (through its gate).
   */
  async promote(req: { agent: string; version?: string; overrides?: SuiteVariantOverrides; note?: string }, opts: { actor?: string } = {}): Promise<{ agent: string; fields: Record<string, unknown>; draftChanged: boolean }> {
    if (!this.deps.writeDraft) throw new AgentSuiteError("Promoting a variant is not available on this server", "CONFLICT");
    if (!req.overrides || !Object.keys(req.overrides).length) throw new AgentSuiteError("The variant has no overrides to promote");
    const version = req.version ?? "production";
    let base: AgentConfig | undefined;
    try { base = await this.deps.resolveAgent(req.agent, version === "production" ? undefined : version); } catch (err) { throw new AgentSuiteError(errorText(err), "NOT_FOUND"); }
    if (!base) throw new AgentSuiteError(`There is no agent "${req.agent}"`, "NOT_FOUND");
    const fields = promotionFields(base as Parameters<typeof promotionFields>[0], req.overrides);
    if (!Object.keys(fields).length) throw new AgentSuiteError("The overrides change nothing at that version");
    const { draftChanged } = await this.deps.writeDraft(req.agent, fields, { ...(opts.actor ? { actor: opts.actor } : {}), note: req.note ?? `Promoted from the Playground (variant of ${version})` });
    return { agent: req.agent, fields, draftChanged };
  }
}

/** What a pane streams while it answers. */
export type PlaygroundStreamEvent =
  | { type: "start"; mode: string }
  | { type: "text"; delta: string }
  | { type: "turn"; turn: SuiteTraceTurn }
  | { type: "tool"; call: SuiteTraceToolCall }
  | { type: "done"; exchange: PlaygroundExchange };

