/**
 * What a mission cost (every recorded run of its tasks: retries and continuations included) and
 * its budget: the orchestrator stops starting its tasks and pauses it when the budget is spent,
 * and lets it go on when the budget is raised or cleared.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OrchestratorEngine, MAX_TASK_RUNS, computeMissionCost, describeMissionCost, missionSpentUsd, runUsd, summarizeMissionCost, tasksOfMission,
  type TaskRunContext,
} from "@polpo-ai/core";
import type { Mission, Task } from "../core/types.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore } from "./fixtures.js";

let seq = 0;
function run(engine: TaskRunContext["engine"], cost: TaskRunContext["cost"], extra: Partial<TaskRunContext> = {}): TaskRunContext {
  return {
    runId: `r${++seq}`, startedAt: "2026-11-22T10:00:00.000Z", status: "completed", engine,
    computer: { id: "host", kind: "host" }, egress: { mode: "direct" }, ...(cost ? { cost } : {}), ...extra,
  };
}

const task = (id: string, assignTo: string, runs: TaskRunContext[]) => ({ id, assignTo, runs });

describe("computeMissionCost", () => {
  it("sums every run of every task (retries, continuations), harness estimate and model cost apart, by agent and by engine", () => {
    const cost = computeMissionCost([
      // a Claude Code task that failed once and was retried, then continued
      task("t1", "coder", [
        run("claude-code", { harnessUsd: 0.5, tokens: 1000 }, { status: "failed" }),
        run("claude-code", { harnessUsd: 0.25, tokens: 500 }),
        run("claude-code", { harnessUsd: 0.1, tokens: 100 }, { continuation: true }),
      ]),
      // Polpo's engine: the provider's model cost
      task("t2", "writer", [run("polpo", { modelUsd: 0.04, tokens: 2000 })]),
      // Codex, then reassigned: the run says which agent ran it
      task("t3", "writer", [run("codex", { harnessUsd: 1, tokens: 300 }, { agent: "reviewer" })]),
      // a run that is starting: no cost yet
      task("t4", "writer", [run("polpo", undefined, { status: "running" })]),
      // never ran
      task("t5", "writer", []),
    ]);
    expect(cost).toMatchObject({
      currency: "USD", usd: 1.89, harnessUsd: 1.85, modelUsd: 0.04, tokens: 3900, runs: 6, tasks: 4,
      unpricedRuns: 1, runsActive: 1, partial: false,
    });
    expect(cost.byEngine).toEqual([
      { engine: "claude-code", usd: 0.85, harnessUsd: 0.85, modelUsd: 0, tokens: 1600, runs: 3 },
      { engine: "codex", usd: 1, harnessUsd: 1, modelUsd: 0, tokens: 300, runs: 1 },
      { engine: "polpo", usd: 0.04, harnessUsd: 0, modelUsd: 0.04, tokens: 2000, runs: 2 },
    ].sort((a, b) => b.usd - a.usd));
    expect(cost.byAgent.map((a) => [a.agent, a.usd, a.runs])).toEqual([["reviewer", 1, 1], ["coder", 0.85, 3], ["writer", 0.04, 2]]);
    expect(cost.budgetUsd).toBeUndefined();
    expect(describeMissionCost(cost)).toMatch(/cost: \$1\.89 · 3,900 tokens · 6 runs over 4 tasks \(harness estimate \$1\.85, model cost \$0\.04\)/);
  });

  it("measures it against the budget", () => {
    const tasks = [task("t1", "coder", [run("claude-code", { harnessUsd: 3 }), run("claude-code", { harnessUsd: 1.5 })])];
    expect(computeMissionCost(tasks, { budgetUsd: 10 })).toMatchObject({ usd: 4.5, budgetUsd: 10, remainingUsd: 5.5, budgetUsed: 0.45, overBudget: false });
    const over = computeMissionCost(tasks, { budgetUsd: 4 });
    expect(over).toMatchObject({ remainingUsd: -0.5, overBudget: true });
    expect(describeMissionCost(over)).toMatch(/budget: \$4\.00 · 113% used · OVER BUDGET/);
    expect(summarizeMissionCost(over)).toEqual({ usd: 4.5, tokens: 0, runs: 2, budgetUsd: 4, overBudget: true });
  });

  it("says the total may be partial when a task kept only its latest runs, and takes the harness cost back from the usage records", () => {
    const capped = Array.from({ length: MAX_TASK_RUNS }, () => run("claude-code", { harnessUsd: 0.1, tokens: 10 }));
    const mixed = [...Array.from({ length: MAX_TASK_RUNS - 1 }, () => run("claude-code", { harnessUsd: 0.1 })), run("polpo", { modelUsd: 0.1 })];
    const tasks = [task("t1", "coder", capped), task("t2", "coder", mixed), task("t3", "coder", [run("polpo", { modelUsd: 1 })])];

    const plain = computeMissionCost(tasks);
    expect(plain).toMatchObject({ partial: true, partialTaskIds: ["t1", "t2"], usd: 5 });

    // 25 harness turns were recorded for t1 (5 runs dropped): its total comes back, nothing is lost
    const recovered = computeMissionCost(tasks, { harnessUsage: { t1: { usd: 2.5, tokens: 250 }, t2: { usd: 3, tokens: 0 } } });
    expect(recovered).toMatchObject({ usd: 6.6, recoveredUsd: 1.6, partial: true, partialTaskIds: ["t2"] });
    // the harness records say nothing was lost for t1
    expect(computeMissionCost([task("t1", "coder", capped)], { harnessUsage: { t1: { usd: 2, tokens: 200 } } })).toMatchObject({ usd: 2, partial: false });
    expect(describeMissionCost(plain)).toMatch(/partial: older runs dropped/);
  });

  it("offers the agents' harness budgets as an upper bound when the mission has none, only when every task's agent has one", () => {
    const agentBudgets = { coder: 2, writer: 0.5, chatty: undefined };
    expect(computeMissionCost([task("t1", "coder", []), task("t2", "writer", [])], { agentBudgets }).agentBudgetCapUsd).toBe(2.5);
    expect(computeMissionCost([task("t1", "coder", []), task("t2", "chatty", [])], { agentBudgets }).agentBudgetCapUsd).toBeUndefined();
    // a draft: its plan's agents
    expect(computeMissionCost([], { agentBudgets, plannedAgents: ["coder", "coder"] }).agentBudgetCapUsd).toBe(4);
    // a budget wins: no cap shown
    expect(computeMissionCost([task("t1", "coder", [])], { agentBudgets, budgetUsd: 1 }).agentBudgetCapUsd).toBeUndefined();
  });

  it("finds a mission's tasks by mission id, or by group for older tasks (recurring runs too)", () => {
    const m = { id: "m1", name: "Digest" };
    const tasks = [
      { id: "a", missionId: "m1", group: "Digest" }, { id: "b", group: "Digest" }, { id: "c", group: "Digest #2" },
      { id: "d", missionId: "m2", group: "Digest" }, { id: "e", group: "Digester" },
    ];
    expect(tasksOfMission(m, tasks).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(runUsd(run("polpo", undefined))).toBeUndefined();
    expect(missionSpentUsd([{ runs: [run("polpo", { modelUsd: 0.2 }), run("codex", { harnessUsd: 0.3 })] }])).toBe(0.5);
  });
});

// ── Enforcement in the supervisor tick ──

class MissionTaskStore extends InMemoryTaskStore {
  missions = new Map<string, Mission>();
  async getMission(id: string): Promise<Mission | undefined> { return this.missions.get(id); }
  async getMissionByName(name: string): Promise<Mission | undefined> { return [...this.missions.values()].find((m) => m.name === name); }
}

async function budgetSetup(budgetUsd: number | undefined) {
  const emitter = new TypedEmitter();
  const store = new MissionTaskStore();
  const mission: Mission = {
    id: "m1", name: "Launch", data: "{}", status: "active", ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    createdAt: "2026-11-22T10:00:00.000Z", updatedAt: "2026-11-22T10:00:00.000Z",
  };
  store.missions.set("m1", mission);
  const base = { description: "d", assignTo: "coder", dependsOn: [], expectations: [], metrics: [], maxRetries: 2, group: "Launch", missionId: "m1" };
  const done = await store.addTask({ ...base, title: "Research" });
  for (const s of ["assigned", "in_progress", "review", "done"] as const) await store.transition(done.id, s);
  await store.updateTask(done.id, { runs: [run("claude-code", { harnessUsd: 1.2 }, { status: "failed" }), run("claude-code", { harnessUsd: 0.8 })] });
  const next = await store.addTask({ ...base, title: "Write" });
  const updateMission = vi.fn(async (id: string, updates: Partial<Mission>) => {
    const m = store.missions.get(id)!;
    Object.assign(m, updates);
    for (const [k, v] of Object.entries(updates)) if (v === undefined) delete (m as Record<string, unknown>)[k];
    return { ...m };
  });
  const taskRunner = {
    collectResults: vi.fn(async () => {}), enforceHealthChecks: vi.fn(async () => {}),
    spawnForTask: vi.fn(async () => {}), syncProcessesFromRunStore: vi.fn(async () => {}), recoverOrphanedTasks: vi.fn(async () => 0),
  };
  const engine = new OrchestratorEngine({
    ctx: { emitter, registry: store, runStore: new InMemoryRunStore(), config: { project: "p", teams: [], settings: { maxRetries: 2, logLevel: "quiet" } } } as never,
    taskManager: {} as never,
    agentManager: { getAgents: async () => [], findAgent: async () => ({ name: "coder" }) } as never,
    missionExecutor: {
      cleanupCompletedGroups: vi.fn(async () => {}), getQualityGates: () => [], getCheckpoints: () => [], getDelays: () => [],
      restoreCheckpointDefinitions: async () => [], getActiveCheckpoints: () => [], getActiveDelays: () => [], updateMission,
    } as never,
    taskRunner,
    assessmentOrchestrator: { handleResult: () => {}, retryOrFail: async () => {} },
  });
  const events: Array<[string, unknown]> = [];
  emitter.on("mission:budget-exceeded", (e) => events.push(["exceeded", e]));
  emitter.on("mission:budget-resumed", (e) => events.push(["resumed", e]));
  return { engine, store, mission, next, taskRunner, events, updateMission };
}

describe("mission budget enforcement", () => {
  it("over its budget, a mission starts no new task and pauses with a reason, once; raising the budget lets it go on", async () => {
    const s = await budgetSetup(1.5);
    await s.engine.tick();
    expect(s.taskRunner.spawnForTask).not.toHaveBeenCalled();
    expect(s.mission).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(s.events).toEqual([["exceeded", { missionId: "m1", name: "Launch", spentUsd: 2, budgetUsd: 1.5, reason: expect.stringMatching(/spent \$2\.00 of its \$1\.50 budget/) }]]);

    // still over: it stays paused, nothing announced again, no deadlock
    await s.engine.tick();
    expect(s.events).toHaveLength(1);
    expect(s.taskRunner.spawnForTask).not.toHaveBeenCalled();
    expect((await s.store.getTask(s.next.id))!.status).toBe("pending");

    s.mission.budgetUsd = 5;
    await s.engine.tick();
    expect(s.mission.status).toBe("active");
    expect(s.mission.pauseReason).toBeUndefined();
    expect(s.events[1]).toEqual(["resumed", { missionId: "m1", name: "Launch", spentUsd: 2, budgetUsd: 5 }]);
    expect(s.taskRunner.spawnForTask).toHaveBeenCalledTimes(1);
  });

  it("clearing the budget lets a mission it paused go on", async () => {
    const s = await budgetSetup(2);
    await s.engine.tick();
    expect(s.mission.status).toBe("paused");
    delete s.mission.budgetUsd;
    await s.engine.tick();
    expect(s.mission.status).toBe("active");
    expect(s.events.map((e) => e[0])).toEqual(["exceeded", "resumed"]);
    expect(s.taskRunner.spawnForTask).toHaveBeenCalledTimes(1);
  });

  it("under its budget (or with none) nothing changes; a mission paused for another reason is left alone", async () => {
    const under = await budgetSetup(10);
    await under.engine.tick();
    expect(under.mission.status).toBe("active");
    expect(under.taskRunner.spawnForTask).toHaveBeenCalledTimes(1);
    expect(under.updateMission).not.toHaveBeenCalled();

    const checkpoint = await budgetSetup(1);
    checkpoint.mission.status = "paused";
    await checkpoint.engine.tick();
    expect(checkpoint.mission.status).toBe("paused");
    expect(checkpoint.mission.pauseReason).toBeUndefined();
    expect(checkpoint.events).toEqual([]);
  });
});
