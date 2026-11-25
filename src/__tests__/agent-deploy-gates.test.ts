/**
 * Deploy gates (agent suites phase 3), unit level: the gate's decision (pass rate, regression
 * versus the baseline, scorer thresholds), the deploy manager over a fake suite runner (no model,
 * no connector): deployed when the required suites pass, blocked and recorded otherwise, an
 * admin's override (and a non-admin refused), rollbacks never gated, a pending verification
 * cancelled, real-tools suites not run, publish checks, one verification at a time.
 */
import { describe, expect, it } from "vitest";
import {
  AgentVersioning, InMemoryAgentSuiteStore, InMemoryAgentVersionStore, evaluateSuiteGate, parseAgentSuite, suiteRunAggregates, suiteRunStats,
  versionGateStatuses,
  type AgentConfig, type AgentDeployGate, type AgentUpdate, type SuiteCaseResult, type SuiteRun, type SuiteRunRequest,
} from "@polpo-ai/core";
import { AgentDeployGates, type DeployGateRunner } from "../server/agent-deploy-gates.js";
import type { RunOptions } from "../server/agent-suites.js";

const EMPTY_TRACE = { input: [], turns: [], toolCalls: [], text: "", approvals: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 1, notes: [] };

function result(key: string, passed: boolean, score?: number): SuiteCaseResult {
  return {
    key, caseId: key, caseName: `Case ${key}`, status: passed ? "passed" : "failed", mode: "all", engine: "native",
    assertions: passed ? [] : [{ assertion: { type: "text_contains", value: "4.99" }, description: "the reply contains 4.99", passed: false, message: "not found" }],
    ...(score !== undefined ? { score, scores: [{ scorer: { type: "exact", expected: "x" }, id: "judge", description: "judge", score, threshold: 0.5, weight: 1, passed: score >= 0.5 }] } : {}),
    trace: EMPTY_TRACE, startedAt: new Date().toISOString(), durationMs: 1, costUsd: 0, variantId: "v",
  } as SuiteCaseResult;
}

function run(over: Partial<SuiteRun> & { results: SuiteCaseResult[] }): Pick<SuiteRun, "status" | "stats" | "aggregates" | "baseline" | "error"> {
  return { status: "passed", stats: suiteRunStats(over.results), aggregates: suiteRunAggregates(over.results), ...over };
}

describe("evaluateSuiteGate", () => {
  it("passes at the minimum pass rate (default 1), fails below it", () => {
    expect(evaluateSuiteGate({ required: true }, run({ results: [result("a", true), result("b", true)] }))).toEqual({ passed: true, reasons: [] });
    const half = run({ status: "failed", results: [result("a", true), result("b", false)] });
    expect(evaluateSuiteGate({ required: true }, half)).toEqual({ passed: false, reasons: ["pass rate 50% < 100% (1/2 passed)"] });
    expect(evaluateSuiteGate({ required: true, minPassRate: 0.5 }, half).passed).toBe(true);
  });

  it("fails on a drop versus the baseline beyond maxRegression (pass rate or score)", () => {
    const r = run({ results: [result("a", true)], baseline: { runId: "b", source: "production", tolerance: 0.05, passRateDelta: -0.2, scoreDelta: -0.01, costDelta: 0, durationDelta: 0, regressions: 1, improvements: 0, cases: [], scorers: [] } });
    expect(evaluateSuiteGate({ required: true, maxRegression: 0.1 }, r)).toEqual({ passed: false, reasons: ["pass rate dropped 20 pts versus the baseline (max 10 pts)"] });
    expect(evaluateSuiteGate({ required: true, maxRegression: 0.25 }, r).passed).toBe(true);
    const score = run({ results: [result("a", true)], baseline: { runId: "b", source: "marked", tolerance: 0.05, passRateDelta: 0, scoreDelta: -0.3, costDelta: 0, durationDelta: 0, regressions: 1, improvements: 0, cases: [], scorers: [] } });
    expect(evaluateSuiteGate({ required: true, maxRegression: 0.1 }, score).reasons).toEqual(["score dropped 0.30 versus the baseline (max 0.10)"]);
  });

  it("checks scorer thresholds by id ('score': the overall score), a missing scorer fails", () => {
    const r = run({ results: [result("a", true, 0.6), result("b", true, 0.8)] });
    expect(evaluateSuiteGate({ required: true, scoreThresholds: { judge: 0.7 } }, r).passed).toBe(true);
    expect(evaluateSuiteGate({ required: true, scoreThresholds: { judge: 0.75, score: 0.9 } }, r).reasons).toEqual(["judge 0.70 < 0.75", "overall score 0.70 < 0.9"]);
    expect(evaluateSuiteGate({ required: true, scoreThresholds: { tone: 0.5 } }, r).reasons).toEqual(['no scores for "tone" (threshold 0.5)']);
  });

  it("a cancelled or crashed run never passes", () => {
    expect(evaluateSuiteGate({ required: true }, run({ status: "cancelled", results: [] })).reasons).toEqual(["the run was cancelled"]);
    expect(evaluateSuiteGate({ required: true }, run({ status: "errored", error: "boom", results: [result("a", true)] })).reasons).toEqual(["the run failed: boom"]);
  });

  it("validates gate settings when a suite is saved", () => {
    const s = parseAgentSuite({ name: "S", gate: { required: true, minPassRate: 0.9, onPublish: true, allowRealTools: true, scoreThresholds: { judge: 0.7 } } }, "shop");
    expect(s.gate).toEqual({ required: true, minPassRate: 0.9, onPublish: true, allowRealTools: true, scoreThresholds: { judge: 0.7 } });
    expect(() => parseAgentSuite({ name: "S", gate: { scoreThresholds: { judge: 2 } } }, "shop")).toThrow("gate.scoreThresholds.judge must be a number from 0 to 1");
    expect(parseAgentSuite({ name: "S", gate: {} }, "shop").gate).toBeUndefined();
  });
});

/** A fake suite runner: each suite's outcome is scripted; a "hold" suite runs until cancelled. */
class FakeRunner implements DeployGateRunner {
  readonly store = new InMemoryAgentSuiteStore();
  outcomes = new Map<string, boolean[]>();
  hold = new Set<string>();
  started: Array<{ suiteId: string; req: SuiteRunRequest; opts: RunOptions }> = [];
  private cancels = new Map<string, () => void>();
  private n = 0;

  async startRun(agent: string, suiteId: string, req: SuiteRunRequest, opts: RunOptions) {
    this.started.push({ suiteId, req, opts });
    const suite = (await this.store.getSuite(agent, suiteId))!;
    const outcome = this.outcomes.get(suiteId) ?? suite.cases.map(() => true);
    const run: SuiteRun = {
      id: `sr-${++this.n}`, agent, suiteId, suiteName: suite.name, suiteRevision: suite.revision, target: req.target ?? "production", version: req.target,
      variant: { id: "v", agent, version: req.target ?? "production" }, trigger: req.trigger ?? "manual", status: "running", startedAt: new Date(Date.now() + this.n).toISOString(),
      planned: outcome.map((_, i) => `c${i}`), results: [], stats: suiteRunStats([]), notes: [],
    };
    await this.store.saveRun(run);
    const done = (async () => {
      if (this.hold.has(suiteId)) {
        run.results.push(result("c0", true));
        opts.onProgress?.(run);
        await new Promise<void>((resolve) => this.cancels.set(run.id, resolve));
        run.status = "cancelled";
      } else {
        for (const [i, ok] of outcome.entries()) { run.results.push(result(`c${i}`, ok)); opts.onProgress?.(run); }
        run.status = outcome.every(Boolean) ? "passed" : "failed";
      }
      run.stats = suiteRunStats(run.results);
      run.aggregates = suiteRunAggregates(run.results);
      run.finishedAt = new Date().toISOString();
      await this.store.saveRun(run);
      return run;
    })();
    return { run: { ...run }, done };
  }

  async cancelRun(agent: string, runId: string) {
    this.cancels.get(runId)?.();
    return (await this.store.getRun(agent, runId))!;
  }
}

function setup() {
  const agents = new Map<string, AgentConfig>([["shop", { name: "shop", role: "Shop", systemPrompt: "Quote shipping." }]]);
  const writeLive = async (name: string, updates: AgentUpdate) => {
    const merged = { ...agents.get(name)!, ...updates } as Record<string, unknown>;
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    agents.set(name, merged as unknown as AgentConfig);
    return merged as unknown as AgentConfig;
  };
  const versioning = new AgentVersioning(new InMemoryAgentVersionStore(), { getAgent: async (n) => agents.get(n), getAgents: async () => [...agents.values()], writeLive });
  const runner = new FakeRunner();
  const events: AgentDeployGate[] = [];
  const gates = new AgentDeployGates({
    runner: () => runner,
    versioning: () => versioning,
    deploy: (name, version, o) => versioning.deploy(name, version, o),
    emit: (g) => events.push(structuredClone(g)),
  });
  const suite = async (input: Record<string, unknown>) => runner.store.saveSuite(parseAgentSuite({ cases: [{ name: "one", input: { kind: "chat", message: "hi" } }, { name: "two", input: { kind: "chat", message: "hi" } }], ...input }, "shop"));
  /** 1.0.0 in production, 1.1.0 published (not deployed). */
  const publish = async () => {
    await versioning.ensureInitial("shop");
    await versioning.updateDraft("shop", { systemPrompt: "Quote shipping, politely." }, "person:ada");
    return versioning.publish("shop", { actor: "person:ada" });
  };
  return { agents, versioning, runner, gates, events, suite, publish };
}

const ADMIN = { actor: "person:ada@example.com", admin: true };

describe("deploy gates", () => {
  it("no required suites: the deploy is immediate", async () => {
    const { gates, publish, versioning, suite } = setup();
    await suite({ name: "Optional" });
    const v = await publish();
    const o = await gates.request("shop", v.version, ADMIN);
    expect(o.status).toBe("deployed");
    expect(await versioning.pointer("shop")).toBe("1.0.1");
  });

  it("required suites pass: pending (in verifica) with progress, then production moves; the history carries the gate", async () => {
    const { gates, publish, versioning, suite, runner, events } = setup();
    await suite({ name: "Shipping", gate: { required: true } });
    const v = await publish();
    const o = await gates.request("shop", v.version, { ...ADMIN, note: "ship it" });
    expect(o.status).toBe("pending");
    expect(o.gate).toMatchObject({ status: "running", version: "1.0.1", from: "1.0.0", trigger: "deploy" });
    expect(runner.started[0]).toMatchObject({ suiteId: "shipping", req: { target: "1.0.1", trigger: "deploy" } });
    const done = await gates.wait("shop", o.gate!.id, 5000);
    expect(done).toMatchObject({ status: "passed", progress: { done: 2, total: 2 }, suites: [{ suiteId: "shipping", status: "passed", passRate: 1 }] });
    expect(done.deployId).toBe(done.id);
    expect(await versioning.pointer("shop")).toBe("1.0.1");
    // live progress was emitted (agent:gate), and the decision
    expect(events.some((e) => e.status === "running" && e.progress.done === 1)).toBe(true);
    expect(events.at(-1)!.status).toBe("passed");
    const [entry] = await gates.attach("shop", await versioning.deploys("shop", { limit: 1 }));
    expect(entry).toMatchObject({ to: "1.0.1", action: "deploy", note: "ship it", gate: { status: "passed", suites: [{ suiteName: "Shipping", status: "passed" }] } });
    const r = (await runner.store.listRuns("shop"))[0]!;
    expect(r.gate).toMatchObject({ decision: "pass", gateId: done.id });
  });

  it("a failing required suite blocks the deploy: production unchanged, recorded as blocked with the failing cases", async () => {
    const { gates, publish, versioning, suite, runner } = setup();
    await suite({ name: "Shipping", gate: { required: true } });
    runner.outcomes.set("shipping", [true, false]);
    const v = await publish();
    const o = await gates.request("shop", v.version, { ...ADMIN, waitMs: 5000 });
    expect(o.status).toBe("blocked");
    expect(o.message).toContain("Blocked by suites: Shipping: pass rate 50% < 100% (1/2 passed)");
    expect(o.message).toContain("Production stays on 1.0.0");
    expect(o.gate!.suites[0]!.failedCases).toEqual([{ key: "c1", caseName: "Case c1", failed: ["the reply contains 4.99: not found"] }]);
    expect(await versioning.pointer("shop")).toBe("1.0.0");
    const [entry] = await gates.attach("shop", await versioning.deploys("shop", { limit: 1 }));
    expect(entry).toMatchObject({ action: "blocked", from: "1.0.0", to: "1.0.1", gate: { status: "blocked", failed: ["Shipping: pass rate 50% < 100% (1/2 passed)"] } });
    expect(versionGateStatuses(await gates.list("shop"))["1.0.1"]).toMatchObject({ status: "blocked" });
    expect((await runner.store.listRuns("shop"))[0]!.gate).toMatchObject({ decision: "fail" });
    // a rollback after a block goes back to the deploy before (the block is not a deploy)
    await versioning.deploy("shop", "1.0.1", { actor: "x" });
    expect((await versioning.rollback("shop", { actor: "x" })).to).toBe("1.0.0");
  });

  it("a regression beyond maxRegression versus production's run blocks; scorer thresholds too", async () => {
    const { gates, publish, suite, runner } = setup();
    await suite({ name: "Shipping", gate: { required: true, minPassRate: 0.5, maxRegression: 0.1 } });
    // the latest run on production: everything passed
    const prod = await runner.startRun("shop", "shipping", { target: "production" }, {});
    await prod.done;
    runner.outcomes.set("shipping", [true, false]);
    const v = await publish();
    // the fake runner does not compare: give the gate's run the comparison the real runner would
    const orig = runner.startRun.bind(runner);
    runner.startRun = async (agent, suiteId, req, opts) => {
      expect(req.baselineRunId).toBe(prod.run.id);
      const r = await orig(agent, suiteId, req, opts);
      return { run: r.run, done: r.done.then(async (x) => {
        x.baseline = { runId: prod.run.id, source: "request", tolerance: 0.05, passRateDelta: -0.5, costDelta: 0, durationDelta: 0, regressions: 1, improvements: 0, cases: [], scorers: [] };
        await runner.store.saveRun(x);
        return x;
      }) };
    };
    const o = await gates.request("shop", v.version, { ...ADMIN, waitMs: 5000 });
    expect(o.status).toBe("blocked");
    expect(o.gate!.suites[0]!.reasons).toEqual(["pass rate dropped 50 pts versus the baseline (max 10 pts)"]);
  });

  it("override: refused without admin rights or a reason; an admin deploys a blocked version, recorded with who, why and what failed", async () => {
    const { gates, publish, versioning, suite, runner } = setup();
    await suite({ name: "Shipping", gate: { required: true } });
    runner.outcomes.set("shipping", [false, false]);
    const v = await publish();
    const blocked = await gates.request("shop", v.version, { ...ADMIN, waitMs: 5000 });
    expect(blocked.status).toBe("blocked");
    await expect(gates.override("shop", blocked.gate!.id, { actor: "agent:writer", reason: "please", admin: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(gates.request("shop", v.version, { actor: "agent:writer", admin: false, override: { reason: "please" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(gates.override("shop", blocked.gate!.id, { actor: "person:ada", reason: " ", admin: true })).rejects.toMatchObject({ code: "INVALID" });
    expect(await versioning.pointer("shop")).toBe("1.0.0");

    const o = await gates.request("shop", v.version, { actor: "person:ada@example.com", admin: true, override: { reason: "Hotfix for the outage" } });
    expect(o.status).toBe("deployed");
    expect(await versioning.pointer("shop")).toBe("1.0.1");
    expect(o.gate).toMatchObject({ id: blocked.gate!.id, status: "override", override: { by: "person:ada@example.com", reason: "Hotfix for the outage", failed: ["Shipping: pass rate 0% < 100% (0/2 passed)"] } });
    const history = await gates.attach("shop", await versioning.deploys("shop", { limit: 2 }));
    expect(history.map((e) => [e.action, e.gate?.status])).toEqual([["deploy", "override"], ["blocked", "override"]]);
    expect(history[0]!.note).toBe("Override: Hotfix for the outage");
    expect((await runner.store.listRuns("shop"))[0]!.gate).toMatchObject({ decision: "override", reason: "Hotfix for the outage", by: "person:ada@example.com" });
    await expect(gates.override("shop", blocked.gate!.id, { actor: "person:ada", reason: "again", admin: true })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("async: a pending verification can be cancelled (nothing deployed); another version waits its turn; a rollback cancels it and is never gated", async () => {
    const { gates, publish, versioning, suite, runner } = setup();
    await suite({ name: "Slow", gate: { required: true } });
    runner.hold.add("slow");
    const v = await publish();
    const o = await gates.request("shop", v.version, ADMIN);
    expect(o.status).toBe("pending");
    expect((await gates.pending("shop"))?.id).toBe(o.gate!.id);
    // the same version again: the same verification; another version: refused while it runs
    expect((await gates.request("shop", v.version, ADMIN)).gate!.id).toBe(o.gate!.id);
    await versioning.updateDraft("shop", { role: "Shop v2" }, "person:ada");
    const v2 = await versioning.publish("shop", { actor: "person:ada" });
    await expect(gates.request("shop", v2.version, ADMIN)).rejects.toMatchObject({ code: "CONFLICT" });

    const cancelled = await gates.cancel("shop", o.gate!.id, "person:ada");
    expect(cancelled).toMatchObject({ status: "cancelled", cancelledBy: "person:ada", suites: [{ status: "cancelled" }] });
    expect(await versioning.pointer("shop")).toBe("1.0.0");
    expect((await versioning.deploys("shop")).some((d) => d.action === "blocked")).toBe(false);

    // a rollback while a verification runs: it stops it, and rolls back without any suite
    await versioning.deploy("shop", v2.version, { actor: "x" });
    const again = await gates.request("shop", v.version, ADMIN);
    expect(again.status).toBe("pending");
    const startedBefore = runner.started.length;
    await gates.rollingBack("shop", "person:ada");
    const rolled = await versioning.rollback("shop", { actor: "person:ada" });
    expect(rolled).toMatchObject({ action: "rollback", to: "1.0.0" });
    expect(runner.started.length).toBe(startedBefore);
    expect((await gates.get("shop", again.gate!.id)).status).toBe("cancelled");
  });

  it("a suite that needs real tools is not run by the gate unless gate.allowRealTools: it blocks without running", async () => {
    const { gates, publish, suite, runner } = setup();
    await suite({ name: "Live", defaultMode: "none", gate: { required: true } });
    const v = await publish();
    const o = await gates.request("shop", v.version, { ...ADMIN, waitMs: 5000 });
    expect(runner.started).toHaveLength(0);
    expect(o.status).toBe("blocked");
    expect(o.gate!.suites[0]).toMatchObject({ status: "not_run", reasons: [expect.stringContaining("gate.allowRealTools")] });

    await suite({ name: "Live", defaultMode: "none", gate: { required: true, allowRealTools: true } });
    const o2 = await gates.request("shop", v.version, { ...ADMIN, waitMs: 5000 });
    expect(runner.started[0]).toMatchObject({ suiteId: "live", opts: { allowRealTools: true } });
    expect(o2.status).toBe("deployed");
  });

  it("publish checks: suites with gate.onPublish run on publish (non-blocking) and annotate the version", async () => {
    const { gates, publish, versioning, suite, runner } = setup();
    await suite({ name: "Shipping", gate: { required: true, onPublish: true } });
    await suite({ name: "Tone", gate: { required: true } });
    const v = await publish();
    const check = await gates.published("shop", v.version, "person:ada");
    expect(check).toMatchObject({ trigger: "publish", status: "running", suites: [{ suiteId: "shipping" }] });
    expect(runner.started[0]!.req.trigger).toBe("publish");
    const done = await gates.wait("shop", check!.id, 5000);
    expect(done.status).toBe("passed");
    expect(done.deployId).toBeUndefined();
    expect(await versioning.pointer("shop")).toBe("1.0.0");
    expect((await gates.versionStatuses("shop"))["1.0.1"]).toMatchObject({ status: "passed", trigger: "publish" });
  });
});
