/**
 * What a task cost: every recorded run of it (first run, retries, continuations, directions), not
 * the latest only — and its mission's cost adds the same numbers up.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TASK_RUNS, computeMissionCost, computeTaskCost, describeTaskCost, harnessUsageByTask, summarizeTaskCost, taskMayHaveDroppedRuns,
  type TaskRunContext,
} from "@polpo-ai/core";

let seq = 0;
function run(engine: TaskRunContext["engine"], cost: TaskRunContext["cost"], extra: Partial<TaskRunContext> = {}): TaskRunContext {
  return {
    runId: `r${++seq}`, startedAt: "2026-11-22T10:00:00.000Z", status: "completed", engine,
    computer: { id: "host", kind: "host" }, egress: { mode: "direct" }, ...(cost ? { cost } : {}), ...extra,
  };
}

describe("computeTaskCost", () => {
  it("sums every run (a failure, its retry, a continuation), the latest run apart, by engine and per run", () => {
    const runs = [
      run("claude-code", { harnessUsd: 0.5, tokens: 1000, costSource: "runtime" }, { status: "failed", durationMs: 60_000, model: "claude-haiku-4-5" }),
      run("polpo", { modelUsd: 0.04, tokens: 2000 }, { durationMs: 5000 }),
      run("claude-code", { harnessUsd: 0.25, tokens: 500 }, { continuation: true, agent: "reviewer" }),
    ];
    const cost = computeTaskCost({ assignTo: "coder", runs });
    expect(cost).toMatchObject({
      currency: "USD", usd: 0.79, harnessUsd: 0.75, modelUsd: 0.04, tokens: 3500, runs: 3, unpricedRuns: 0, runsActive: 0,
      lastRunUsd: 0.25, partial: false,
    });
    expect(cost.recoveredUsd).toBeUndefined();
    expect(cost.byEngine).toEqual([
      { engine: "claude-code", usd: 0.75, harnessUsd: 0.75, modelUsd: 0, tokens: 1500, runs: 2 },
      { engine: "polpo", usd: 0.04, harnessUsd: 0, modelUsd: 0.04, tokens: 2000, runs: 1 },
    ]);
    expect(cost.perRun).toEqual([
      { runId: runs[0]!.runId, startedAt: runs[0]!.startedAt, status: "failed", engine: "claude-code", agent: "coder", model: "claude-haiku-4-5", durationMs: 60_000, usd: 0.5, tokens: 1000, costSource: "runtime" },
      { runId: runs[1]!.runId, startedAt: runs[1]!.startedAt, status: "completed", engine: "polpo", agent: "coder", durationMs: 5000, usd: 0.04, tokens: 2000 },
      { runId: runs[2]!.runId, startedAt: runs[2]!.startedAt, status: "completed", engine: "claude-code", agent: "reviewer", continuation: true, usd: 0.25, tokens: 500 },
    ]);
    expect(summarizeTaskCost(cost)).toEqual({ usd: 0.79, tokens: 3500, runs: 3 });
    const text = describeTaskCost(cost, { perRun: true });
    expect(text).toMatch(/^cost: \$0\.79 in all · 3 runs · latest \$0\.25 · 3,500 tokens/);
    expect(text).toMatch(/by engine: Claude Code \$0\.75 \(2\), Polpo \$0\.04 \(1\)/);
    expect(text).toMatch(/1\. r\d+ \[failed\] Claude Code claude-haiku-4-5 · \$0\.50 · 1,000 tokens · 60 s/);
    expect(text).toMatch(/3\. r\d+ \[completed\] continuation Claude Code · \$0\.25/);
  });

  it("a run starting (no cost yet) and a task never run", () => {
    const cost = computeTaskCost({ runs: [run("codex", { harnessUsd: 1 }), run("codex", undefined, { status: "running" })] });
    expect(cost).toMatchObject({ usd: 1, runs: 2, unpricedRuns: 1, runsActive: 1, partial: false });
    expect(cost.lastRunUsd).toBeUndefined();
    expect(cost.perRun[1]!.usd).toBeUndefined();
    expect(computeTaskCost({})).toMatchObject({ usd: 0, runs: 0, perRun: [], byEngine: [], partial: false });
    expect(describeTaskCost(computeTaskCost({}))).toBe("cost: not run yet");
  });

  it("partial when it holds MAX_TASK_RUNS runs (older ones dropped); the harness part recovered from the usage records", () => {
    const harness = Array.from({ length: MAX_TASK_RUNS }, () => run("claude-code", { harnessUsd: 0.1, tokens: 100 }, { agent: "coder" }));
    expect(taskMayHaveDroppedRuns({ runs: harness })).toBe(true);
    expect(taskMayHaveDroppedRuns({ runs: harness.slice(1) })).toBe(false);
    // no usage records: partial
    expect(computeTaskCost({ runs: harness })).toMatchObject({ usd: 2, runs: MAX_TASK_RUNS, partial: true });
    // the usage records hold every run (25 × $0.10): the 5 dropped ones come back, nothing is lost
    const recovered = computeTaskCost({ runs: harness }, { harnessUsage: { usd: 2.5, tokens: 2500 } });
    expect(recovered).toMatchObject({ usd: 2.5, harnessUsd: 2.5, tokens: 2500, runs: MAX_TASK_RUNS, partial: false, recoveredUsd: 0.5 });
    expect(recovered.recovered).toEqual({ usd: 0.5, tokens: 500, agent: "coder", engine: "claude-code" });
    expect(recovered.byEngine).toEqual([{ engine: "claude-code", usd: 2.5, harnessUsd: 2.5, modelUsd: 0, tokens: 2500, runs: MAX_TASK_RUNS }]);
    expect(describeTaskCost(recovered)).toMatch(/\(\$0\.50 of dropped runs from usage records\)/);
    // usage records with nothing more: nothing was lost
    expect(computeTaskCost({ runs: harness }, { harnessUsage: { usd: 2, tokens: 2000 } })).toMatchObject({ usd: 2, partial: false });
    // some runs on Polpo's engine: usage records cannot give those back
    const mixed = [...harness.slice(1), run("polpo", { modelUsd: 0.01 })];
    expect(computeTaskCost({ runs: mixed }, { harnessUsage: { usd: 3, tokens: 0 } })).toMatchObject({ partial: true, recoveredUsd: 1.1 });
  });

  it("a mission's cost is its tasks' costs added up", () => {
    const tasks = [
      { id: "t1", assignTo: "coder", runs: [run("claude-code", { harnessUsd: 0.3, tokens: 10 }, { status: "failed" }), run("claude-code", { harnessUsd: 0.2, tokens: 5 })] },
      { id: "t2", assignTo: "writer", runs: [run("polpo", { modelUsd: 0.05, tokens: 40 }), run("polpo", { modelUsd: 0.05, tokens: 40 }, { continuation: true })] },
      { id: "t3", assignTo: "coder", runs: Array.from({ length: MAX_TASK_RUNS }, () => run("codex", { harnessUsd: 0.01, tokens: 1 })) },
    ];
    const harnessUsage = { t3: { usd: 0.5, tokens: 50 } };
    const mission = computeMissionCost(tasks, { harnessUsage });
    const perTask = tasks.map((t) => computeTaskCost(t, harnessUsage[t.id as "t3"] ? { harnessUsage: harnessUsage[t.id as "t3"] } : {}));
    expect(mission.usd).toBeCloseTo(perTask.reduce((s, c) => s + c.usd, 0), 6);
    expect(mission.tokens).toBe(perTask.reduce((s, c) => s + c.tokens, 0));
    expect(mission.runs).toBe(perTask.reduce((s, c) => s + c.runs, 0));
    expect(mission.recoveredUsd).toBeCloseTo(0.3, 6);
    expect(mission.partial).toBe(false);
    expect(mission.byEngine.find((e) => e.engine === "codex")!.usd).toBeCloseTo(0.5, 6);
    expect(mission.byAgent.find((a) => a.agent === "coder")!.usd).toBeCloseTo(1, 6);
  });
});

describe("harnessUsageByTask", () => {
  it("sums the agent_harness records of the given tasks (the task id as session)", () => {
    expect(harnessUsageByTask([
      { source: "agent_harness", sessionId: "t1", cost: 0.2, totalTokens: 100 },
      { source: "agent_harness", sessionId: "t1", cost: 0.3, totalTokens: 50 },
      { source: "agent_harness", sessionId: "t2", cost: 9, totalTokens: 9 },
      { source: "chat", sessionId: "t1", cost: 5, totalTokens: 5 },
      { source: "agent_harness", cost: 1, totalTokens: 1 },
    ], ["t1"])).toEqual({ t1: { usd: 0.5, tokens: 150 } });
  });
});
