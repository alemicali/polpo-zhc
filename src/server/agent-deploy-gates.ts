/**
 * Deploy gates (docs/agent-suites.md, "CI gate"): before a version of an agent reaches production,
 * the suites marked `gate.required` run against it (trigger "deploy"). The production pointer moves
 * only when every one passes its gate (pass rate, regression versus the baseline, scorer
 * thresholds); otherwise the deploy is blocked and recorded in the deploy history. While the suites
 * run the deploy is pending ("in verifica"): progress is saved and emitted (agent:gate), and it can
 * be cancelled. An admin may deploy anyway with a reason (an override, recorded too). Rollbacks are
 * never gated: a rollback stops the verifications in flight.
 *
 * Publish checks: suites with `gate.onPublish` also run when a version is published (non-blocking):
 * the version shows the result before anyone deploys it.
 *
 * Runs go through the suite runner (its limit of two runs at a time per instance applies). Suites
 * that would use real tools are not run by the gate unless `gate.allowRealTools` (set by an admin).
 */
import { randomUUID } from "node:crypto";
import {
  AgentSuiteError, AgentVersionError,
  deployGateFailures, deployGateRef, deployGateSummary, evaluateSuiteGate, gateFailedCases, planSuiteCases, planUsesRealTools,
  publishCheckSuites, requiredGateSuites, suiteGateThresholds, versionGateStatuses,
  type AgentDeployEntry, type AgentDeployGate, type AgentDeployGateHook, type AgentDeployOutcome, type AgentDeployRequest,
  type AgentSuite, type AgentSuiteStore, type AgentVersionGateStatus, type AgentVersioning, type DeployGateSuite, type DeployGateTrigger,
  type SuiteRun, type SuiteRunRequest,
} from "@polpo-ai/core";
import type { RunOptions } from "./agent-suites.js";

/** What the gates need from the suite runner. */
export interface DeployGateRunner {
  readonly store: AgentSuiteStore;
  startRun(agent: string, suiteId: string, req: SuiteRunRequest, opts: RunOptions): Promise<{ run: SuiteRun; done: Promise<SuiteRun> }>;
  cancelRun(agent: string, runId: string): Promise<SuiteRun>;
}

export interface DeployGateDeps {
  runner: () => DeployGateRunner;
  versioning: () => AgentVersioning;
  /** The deploy itself (ungated): written live, recorded in the history with this id. */
  deploy: (agent: string, version: string, opts: { actor: string; note?: string; id?: string }) => Promise<AgentDeployEntry>;
  /** agent:gate (progress and decisions), for live clients. */
  emit?: (gate: AgentDeployGate) => void;
  /** The agent changed (a deploy, a block in the history): agent:updated. */
  changed?: (agent: string) => void;
}

const OVERRIDE_REASON_MIN = 3;

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LiveGate {
  gate: AgentDeployGate;
  runs: Map<string, string>; // suiteId → runId
  cancelled?: string;
  saving: Promise<void>;
  done: Promise<AgentDeployGate>;
}

export class AgentDeployGates implements AgentDeployGateHook {
  private live = new Map<string, LiveGate>();

  constructor(private readonly deps: DeployGateDeps) {}

  private get store(): AgentSuiteStore { return this.deps.runner().store; }

  /** The agent's required suites (they gate its deploys). */
  async requiredSuites(agent: string): Promise<AgentSuite[]> {
    return requiredGateSuites(await this.store.listSuites(agent));
  }

  async applies(agent: string): Promise<boolean> {
    return (await this.requiredSuites(agent)).length > 0;
  }

  // ── reads ──

  /** A gate left running by a previous process is finished as errored (the runs died with it). */
  private async settle(g: AgentDeployGate): Promise<AgentDeployGate> {
    if (g.status !== "running" || this.live.has(g.id)) return this.live.get(g.id)?.gate ?? g;
    const fixed: AgentDeployGate = {
      ...g, status: "errored", finishedAt: new Date().toISOString(),
      error: "The server restarted during the verification: nothing was deployed. Deploy again.",
      suites: g.suites.map((s) => s.status === "running" || s.status === "queued" ? { ...s, status: "cancelled", reasons: ["the server restarted"] } : s),
    };
    await this.store.saveGate(fixed);
    return fixed;
  }

  async list(agent: string, opts: { version?: string; limit?: number } = {}): Promise<AgentDeployGate[]> {
    const gates = await this.store.listGates(agent, opts);
    return Promise.all(gates.map((g) => this.settle(g)));
  }

  async get(agent: string, id: string): Promise<AgentDeployGate> {
    const live = this.live.get(id);
    if (live && live.gate.agent === agent) return structuredClone(live.gate);
    const g = await this.store.getGate(agent, id);
    if (!g) throw new AgentSuiteError(`${agent} has no deploy gate "${id}"`, "NOT_FOUND");
    return this.settle(g);
  }

  /** Each version's latest gate (✓ passed, ✗ blocked / failed, in verifica, override). */
  async versionStatuses(agent: string): Promise<Record<string, AgentVersionGateStatus>> {
    return versionGateStatuses(await this.list(agent));
  }

  /** The verification in flight for the agent's deploys, if any. */
  async pending(agent: string): Promise<AgentDeployGate | undefined> {
    for (const l of this.live.values()) if (l.gate.agent === agent && l.gate.trigger !== "publish" && l.gate.status === "running") return structuredClone(l.gate);
    return undefined;
  }

  /** The deploy history with each entry's gate (the deploy it verified, the block, the override). */
  async attach<E extends AgentDeployEntry>(agent: string, entries: E[]): Promise<E[]> {
    if (!entries.length) return entries;
    const gates = await this.store.listGates(agent);
    const byEntry = new Map<string, AgentDeployGate>();
    for (const g of gates) {
      if (g.deployId) byEntry.set(g.deployId, g);
      if (g.blockedEntryId) byEntry.set(g.blockedEntryId, g);
    }
    return entries.map((e) => {
      const g = byEntry.get(e.id);
      return g ? { ...e, gate: deployGateRef(g) } : e;
    });
  }

  /** Wait (up to ms) for a gate to finish; the gate as it is then. */
  async wait(agent: string, id: string, ms: number): Promise<AgentDeployGate> {
    const live = this.live.get(id);
    if (live && ms > 0) await Promise.race([live.done.catch(() => undefined), sleep(ms)]);
    return this.get(agent, id);
  }

  // ── deploys ──

  /**
   * Deploy a version through the gate: no required suites → deployed now; else the suites start and
   * the deploy is pending (production moves when they pass). `override` (admins, with a reason)
   * deploys at once, recording which gates had failed or were not verified.
   */
  async request(agent: string, version: string, req: AgentDeployRequest): Promise<AgentDeployOutcome> {
    const versioning = this.deps.versioning();
    if (!(await versioning.getVersion(agent, version))) throw new AgentVersionError(`${agent} has no version ${version}`, "NOT_FOUND");
    if (req.override) return this.overrideVersion(agent, version, req);
    const required = await this.requiredSuites(agent);
    if (!required.length) {
      const entry = await this.deps.deploy(agent, version, { actor: req.actor, ...(req.note ? { note: req.note } : {}) });
      return { status: "deployed", entry, message: `Deployed ${agent}@${version} to production${entry.from ? ` (was ${entry.from})` : ""}.` };
    }
    const inFlight = await this.pending(agent);
    if (inFlight) {
      if (inFlight.version === version) return await this.outcome(inFlight);
      throw new AgentSuiteError(`${agent}@${inFlight.version} is being verified (${inFlight.progress.done}/${inFlight.progress.total} cases): wait for it or cancel it first`, "CONFLICT");
    }
    const gate = await this.start(agent, version, required, { trigger: req.trigger ?? "deploy", actor: req.actor, ...(req.note ? { note: req.note } : {}) });
    const settled = req.waitMs && req.waitMs > 0 ? await this.wait(agent, gate.id, req.waitMs) : gate;
    return await this.outcome(settled);
  }

  /** A version was published: its publish checks (required suites with gate.onPublish), non-blocking. */
  async published(agent: string, version: string, actor: string): Promise<AgentDeployGate | undefined> {
    const suites = publishCheckSuites(await this.store.listSuites(agent));
    if (!suites.length) return undefined;
    for (const l of this.live.values()) {
      if (l.gate.agent === agent && l.gate.version === version && l.gate.status === "running") return structuredClone(l.gate);
    }
    return this.start(agent, version, suites, { trigger: "publish", actor });
  }

  /** A rollback is never gated: the verifications in flight stop (they would deploy over it). */
  async rollingBack(agent: string, actor: string): Promise<void> {
    const ids = [...this.live.values()].filter((l) => l.gate.agent === agent && l.gate.trigger !== "publish" && l.gate.status === "running").map((l) => l.gate.id);
    for (const id of ids) await this.cancel(agent, id, `${actor} (rollback)`).catch(() => undefined);
  }

  /** Stop a verification: its runs are cancelled, nothing is deployed. */
  async cancel(agent: string, id: string, actor: string): Promise<AgentDeployGate> {
    const live = this.live.get(id);
    if (!live || live.gate.agent !== agent) {
      const g = await this.get(agent, id);
      if (g.status === "running") return g;
      throw new AgentSuiteError(`The gate of ${agent}@${g.version} is not running (${g.status})`, "CONFLICT");
    }
    if (!live.cancelled) {
      live.cancelled = actor;
      live.gate.cancelledBy = actor;
      await Promise.all([...live.runs.values()].map((runId) => this.deps.runner().cancelRun(agent, runId).catch(() => undefined)));
    }
    return live.done;
  }

  /**
   * Deploy a gate's version anyway: an admin, with a reason. A verification in flight is cancelled
   * first; the gate records the override (who, when, why, which gates had failed).
   */
  async override(agent: string, id: string, req: { actor: string; reason: string; admin?: boolean; note?: string }): Promise<AgentDeployOutcome> {
    this.checkOverride(req);
    let gate = await this.get(agent, id);
    if (gate.deployId) throw new AgentSuiteError(`${agent}@${gate.version} was already deployed by this gate`, "CONFLICT");
    if (gate.status === "running") gate = await this.cancel(agent, id, `${req.actor} (override)`);
    return this.deployOverride(agent, gate, req);
  }

  private checkOverride(req: { admin?: boolean; reason?: string }): void {
    if (req.admin !== true) throw new AgentSuiteError("Only an admin can deploy past the required suites (an override)", "FORBIDDEN");
    if (!req.reason || req.reason.trim().length < OVERRIDE_REASON_MIN) throw new AgentSuiteError("An override needs a reason (why deploy although the suites did not pass)", "INVALID");
  }

  /** request() with override: the version's latest unfinished or failed gate, else a record of an unverified deploy. */
  private async overrideVersion(agent: string, version: string, req: AgentDeployRequest): Promise<AgentDeployOutcome> {
    this.checkOverride({ admin: req.admin, reason: req.override?.reason });
    const latest = (await this.list(agent, { version, limit: 20 })).find((g) => g.trigger !== "publish" || g.status !== "passed");
    if (latest && !latest.deployId && latest.status !== "passed") {
      return this.override(agent, latest.id, { actor: req.actor, reason: req.override!.reason, admin: true, ...(req.note ? { note: req.note } : {}) });
    }
    const required = await this.requiredSuites(agent);
    if (!required.length) {
      const entry = await this.deps.deploy(agent, version, { actor: req.actor, ...(req.note ? { note: req.note } : {}) });
      return { status: "deployed", entry, message: `Deployed ${agent}@${version} to production (${agent} has no required suites: nothing to override).` };
    }
    // deployed without running the suites
    const now = new Date().toISOString();
    const gate: AgentDeployGate = {
      id: randomUUID(), agent, version, trigger: req.trigger ?? "deploy", status: "cancelled",
      requestedBy: req.actor, requestedAt: now, finishedAt: now, ...(req.note ? { note: req.note } : {}),
      ...(await this.deps.versioning().pointer(agent).then((from) => from ? { from } : {}).catch(() => ({}))),
      suites: required.map((s) => this.suiteEntry(s, 0, { status: "not_run", reasons: ["not verified: deployed with an override"] })),
      progress: { done: 0, total: 0 }, notes: [],
    };
    return this.deployOverride(agent, gate, { actor: req.actor, reason: req.override!.reason, ...(req.note ? { note: req.note } : {}) });
  }

  private async deployOverride(agent: string, gate: AgentDeployGate, req: { actor: string; reason: string; note?: string }): Promise<AgentDeployOutcome> {
    const failed = deployGateFailures(gate);
    const reason = req.reason.trim();
    const entry = await this.deps.deploy(agent, gate.version, {
      actor: req.actor, id: randomUUID(),
      note: [req.note?.trim() || gate.note, `Override: ${reason}`].filter(Boolean).join(" · "),
    });
    const next: AgentDeployGate = {
      ...gate, status: "override", deployId: entry.id, finishedAt: gate.finishedAt ?? entry.at,
      override: { by: req.actor, at: entry.at, reason, failed: failed.length ? failed : ["every required suite had passed"] },
    };
    await this.store.saveGate(next);
    await this.markRuns(next, { decision: "override", reason, by: req.actor });
    this.deps.emit?.(next);
    this.deps.changed?.(agent);
    return { status: "deployed", entry: { ...entry, gate: deployGateRef(next) }, gate: next, message: `Deployed ${agent}@${gate.version} to production with an override: "${reason}"${failed.length ? ` (failed: ${failed.join(" · ")})` : ""}.` };
  }

  /** What a deploy request did, from its gate (pending, deployed with its history entry, blocked). */
  async outcome(gate: AgentDeployGate): Promise<AgentDeployOutcome> {
    if (gate.status === "running") {
      return { status: "pending", gate, message: `${gate.agent}@${gate.version} is being verified by ${gate.suites.length} required suite(s) (${gate.progress.done}/${gate.progress.total} cases): production moves when they pass.` };
    }
    const entryId = gate.deployId ?? gate.blockedEntryId;
    const entry = entryId ? (await this.deps.versioning().deploys(gate.agent, { limit: 100 }).catch(() => [])).find((e) => e.id === entryId) : undefined;
    if ((gate.status === "passed" || gate.status === "override") && gate.deployId) {
      return { status: "deployed", gate, ...(entry ? { entry: { ...entry, gate: deployGateRef(gate) } } : {}), message: `${deployGateSummary(gate)}.` };
    }
    return {
      status: "blocked", gate, ...(entry ? { entry: { ...entry, gate: deployGateRef(gate) } } : {}),
      message: gate.status === "blocked" ? `${deployGateSummary(gate)}. Production stays on ${gate.from ?? "its version"}.` : `${deployGateSummary(gate)}. Nothing was deployed.`,
    };
  }

  // ── running a gate ──

  private suiteEntry(suite: AgentSuite, total: number, extra: Partial<DeployGateSuite> = {}): DeployGateSuite {
    return {
      suiteId: suite.id, suiteName: suite.name, suiteRevision: suite.revision, status: "queued", reasons: [], failedCases: [],
      thresholds: suiteGateThresholds(suite.gate), progress: { done: 0, total }, ...extra,
    };
  }

  /** The run a suite's regressions are measured against: its marked baseline, else its latest finished run on production. */
  private async baselineRun(agent: string, suiteId: string): Promise<string | undefined> {
    const runs = await this.store.listRuns(agent, { suiteId, excludeBenchmarks: true });
    return runs.find((r) => r.isBaseline)?.id
      ?? runs.find((r) => r.target === "production" && ["passed", "failed", "errored"].includes(r.status) && r.trigger !== "deploy" && r.trigger !== "publish")?.id
      ?? runs.find((r) => r.target === "production" && ["passed", "failed", "errored"].includes(r.status))?.id;
  }

  private save(live: LiveGate): Promise<void> {
    live.gate.progress = live.gate.suites.reduce((p, s) => ({ done: p.done + s.progress.done, total: p.total + s.progress.total }), { done: 0, total: 0 });
    const snapshot = structuredClone(live.gate);
    live.saving = live.saving.then(() => this.store.saveGate(snapshot)).catch(() => undefined);
    this.deps.emit?.(snapshot);
    return live.saving;
  }

  private async start(agent: string, version: string, suites: AgentSuite[], opts: { trigger: DeployGateTrigger; actor: string; note?: string }): Promise<AgentDeployGate> {
    const from = await this.deps.versioning().pointer(agent).catch(() => undefined);
    const gate: AgentDeployGate = {
      id: randomUUID(), agent, version, ...(from ? { from } : {}), trigger: opts.trigger, status: "running",
      requestedBy: opts.actor, requestedAt: new Date().toISOString(), ...(opts.note ? { note: opts.note } : {}),
      suites: [], progress: { done: 0, total: 0 }, notes: [],
    };
    const runnable: Array<{ suite: AgentSuite; index: number }> = [];
    for (const suite of suites) {
      let total = 0;
      let realTools = false;
      try {
        const planned = planSuiteCases(suite);
        total = planned.length;
        realTools = planUsesRealTools(planned);
      } catch { /* an invalid plan errors at start below */ }
      if (realTools && suite.gate?.allowRealTools !== true) {
        gate.suites.push(this.suiteEntry(suite, 0, {
          status: "not_run",
          reasons: ["it uses real tools (modes none / model, or unmocked tools run for real): the gate runs it only with gate.allowRealTools, set by an admin"],
        }));
        continue;
      }
      runnable.push({ suite, index: gate.suites.length });
      gate.suites.push(this.suiteEntry(suite, total));
    }
    const live: LiveGate = { gate, runs: new Map(), saving: Promise.resolve(), done: Promise.resolve(gate) };
    this.live.set(gate.id, live);
    await this.save(live);

    const runs: Array<Promise<void>> = [];
    for (const { suite, index } of runnable) {
      const entry = gate.suites[index];
      try {
        const baselineRunId = suite.gate?.maxRegression !== undefined ? await this.baselineRun(agent, suite.id) : undefined;
        if (baselineRunId) entry.baselineRunId = baselineRunId;
        const { run, done } = await this.deps.runner().startRun(agent, suite.id, {
          target: version, trigger: opts.trigger === "publish" ? "publish" : "deploy", ...(baselineRunId ? { baselineRunId } : {}),
        }, {
          actor: opts.actor,
          allowRealTools: suite.gate?.allowRealTools === true,
          onProgress: (r) => {
            if (live.gate.status !== "running") return;
            entry.status = "running";
            entry.progress = { done: r.results.length, total: r.planned.length };
            void this.save(live);
          },
        });
        entry.runId = run.id;
        entry.progress.total = run.planned.length;
        live.runs.set(suite.id, run.id);
        runs.push(done.then(() => undefined, () => undefined));
      } catch (err) {
        entry.status = "not_run";
        entry.reasons = [`it could not run: ${errorText(err)}`];
      }
    }
    await this.save(live);
    live.done = (async () => {
      await Promise.all(runs);
      try { await this.finish(live); } catch (err) {
        live.gate.status = "errored";
        live.gate.error = errorText(err);
        live.gate.finishedAt = new Date().toISOString();
        await this.save(live);
      } finally {
        this.live.delete(gate.id);
      }
      return structuredClone(live.gate);
    })();
    return structuredClone(gate);
  }

  /** Every run finished: decide, then deploy (passed), record the block, or stop (cancelled). */
  private async finish(live: LiveGate): Promise<void> {
    const gate = live.gate;
    const suites = new Map((await this.store.listSuites(gate.agent)).map((s) => [s.id, s]));
    for (const entry of gate.suites) {
      if (!entry.runId) continue;
      const run = await this.store.getRun(gate.agent, entry.runId);
      if (!run) { entry.status = "errored"; entry.reasons = ["its run is gone"]; continue; }
      entry.progress = { done: run.results.length, total: run.planned.length };
      entry.passRate = run.stats.passRate;
      if (run.aggregates?.score !== undefined) entry.score = run.aggregates.score;
      entry.failedCases = gateFailedCases(run);
      if (run.status === "cancelled") {
        entry.status = "cancelled";
        entry.reasons = [live.cancelled ? `cancelled by ${live.cancelled}` : "the run was cancelled"];
        continue;
      }
      // the thresholds as the suite has them now (an edit during the run applies)
      const verdict = evaluateSuiteGate(suites.get(entry.suiteId)?.gate, run);
      entry.status = verdict.passed ? "passed" : run.status === "errored" && run.error ? "errored" : "failed";
      entry.reasons = verdict.reasons;
      if (!live.cancelled) {
        run.gate = { decision: verdict.passed ? "pass" : "fail", gateId: gate.id, ...(verdict.passed ? {} : { reason: verdict.reasons.join("; ") }) };
        await this.store.saveRun(run).catch(() => undefined);
      }
    }
    gate.finishedAt = new Date().toISOString();
    if (live.cancelled) {
      gate.status = "cancelled";
      gate.cancelledBy = live.cancelled;
      await this.save(live);
      return;
    }
    const passed = gate.suites.every((s) => s.status === "passed");
    if (gate.trigger === "publish") {
      gate.status = passed ? "passed" : "failed";
      await this.save(live);
      this.deps.changed?.(gate.agent);
      return;
    }
    if (passed) {
      try {
        const entry = await this.deps.deploy(gate.agent, gate.version, { actor: gate.requestedBy, id: gate.id, ...(gate.note ? { note: gate.note } : {}) });
        gate.deployId = entry.id;
        gate.status = "passed";
      } catch (err) {
        gate.status = "errored";
        gate.error = `The suites passed but the deploy failed: ${errorText(err)}`;
      }
    } else {
      gate.status = "blocked";
      const entry = await this.deps.versioning().recordBlocked(gate.agent, gate.version, {
        actor: gate.requestedBy, id: gate.id, note: deployGateSummary(gate).slice(0, 2000),
      }).catch((err) => { gate.notes.push(`The block could not be recorded in the deploy history: ${errorText(err)}`); return undefined; });
      if (entry) gate.blockedEntryId = entry.id;
    }
    await this.save(live);
    this.deps.changed?.(gate.agent);
  }

  /** Write the gate's decision on its runs (run.gate). */
  private async markRuns(gate: AgentDeployGate, decision: { decision: "override"; reason: string; by: string }): Promise<void> {
    for (const s of gate.suites) {
      if (!s.runId) continue;
      const run = await this.store.getRun(gate.agent, s.runId).catch(() => undefined);
      if (!run) continue;
      run.gate = { ...decision, gateId: gate.id };
      await this.store.saveRun(run).catch(() => undefined);
    }
  }
}
