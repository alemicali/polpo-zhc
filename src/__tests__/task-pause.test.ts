/**
 * Pausing a single task (status "paused"): a pending one is simply not scheduled; a running one's
 * run is stopped (SIGTERM) and ends as "paused" (not failed, not assessed) with its session kept;
 * resuming puts it back to pending and continues the stopped run (a "continue" direction told why
 * it was paused). Dependents wait, its mission stays active without completing, a kill still works.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { Orchestrator } from "../core/orchestrator.js";
import { withEventOrigin } from "../core/events.js";
import { executeOrchestratorTool } from "../llm/orchestrator-tools.js";
import { InMemoryTaskStore, InMemoryRunStore, InMemoryTaskControlStore, createTestAgent } from "./fixtures.js";
import type { Mission, Task } from "../core/types.js";

const WORK_DIR = "/tmp/polpo-test-task-pause";

/** The in-memory task store with missions (copies out, as a real store). */
class MissionTaskStore extends InMemoryTaskStore {
  private missions = new Map<string, Mission>();
  async saveMission(m: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission> {
    const now = new Date().toISOString();
    const saved: Mission = { ...m, id: `m${this.missions.size + 1}`, createdAt: now, updatedAt: now };
    this.missions.set(saved.id, saved);
    return { ...saved };
  }
  async getMission(id: string): Promise<Mission | undefined> {
    const m = this.missions.get(id);
    return m ? { ...m } : undefined;
  }
  async getMissionByName(name: string): Promise<Mission | undefined> {
    const m = [...this.missions.values()].find((x) => x.name === name);
    return m ? { ...m } : undefined;
  }
  async getAllMissions(): Promise<Mission[]> { return [...this.missions.values()].map((m) => ({ ...m })); }
  async updateMission(id: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    const m = this.missions.get(id);
    if (!m) throw new Error("Mission not found");
    Object.assign(m, updates, { updatedAt: new Date().toISOString() });
    return { ...m };
  }
  async deleteMission(id: string): Promise<boolean> { return this.missions.delete(id); }
  async nextMissionName(): Promise<string> { return `mission-${this.missions.size + 1}`; }
}

describe("pausing a task", () => {
  let store: MissionTaskStore;
  let runStore: InMemoryRunStore;
  let controls: InMemoryTaskControlStore;
  let orchestrator: Orchestrator;
  let spawned: Array<{ taskId: string; runId: string; pid: number }>;
  let assessed: string[];
  let children: ChildProcess[];

  beforeEach(async () => {
    store = new MissionTaskStore();
    runStore = new InMemoryRunStore();
    controls = new InMemoryTaskControlStore();
    spawned = [];
    assessed = [];
    children = [];
    orchestrator = new Orchestrator({
      workDir: WORK_DIR,
      store,
      runStore,
      taskControlStore: controls,
      spawner: {
        // a real (harmless) process stands for the runner: the pause's SIGTERM must reach it
        spawn: async (config: { taskId: string; runId: string }) => {
          const child = spawn("sleep", ["30"], { stdio: "ignore" });
          children.push(child);
          spawned.push({ taskId: config.taskId, runId: config.runId, pid: child.pid! });
          return { pid: child.pid!, configPath: "/tmp/run.json" };
        },
        isAlive: () => true,
        kill: () => {},
      } as never,
      assessFn: async (task: Task) => {
        assessed.push(task.id);
        return { passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() };
      },
    });
    await orchestrator.initInteractive("test-project", { name: "team", agents: [createTestAgent({ name: "agent-1" })] });
  });

  afterEach(() => {
    for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
    if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  });

  const statusOf = async (taskId: string) => (await store.getTask(taskId))?.status;
  const exited = (c: ChildProcess) => new Promise<NodeJS.Signals | null>((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve(c.signalCode);
    c.once("exit", (_code, signal) => resolve(signal));
  });

  /** The runner of `runId` ends: claims and applies its directions (a continuation), then its run is terminal. */
  async function endRun(runId: string, status: "completed" | "killed", exitCode = status === "completed" ? 0 : 1): Promise<void> {
    const run = (await runStore.getRun(runId))!;
    for (const d of await controls.claimDirections(run.taskId, runId)) await controls.markDirectionApplied(d.id);
    await runStore.upsertRun({
      ...run, status, sessionId: "sess-1",
      result: { exitCode, stdout: status === "completed" ? "ok" : "", stderr: status === "killed" ? "Killed by SIGTERM (timeout or shutdown)" : "", duration: 10 },
    });
  }

  async function tickUntil(check: () => Promise<boolean>, max = 50): Promise<void> {
    for (let i = 0; i < max; i++) {
      await orchestrator.tick();
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`condition never reached (tasks: ${(await store.getAllTasks()).map((t) => t.status).join(", ")})`);
  }

  it("a pending task is not scheduled while paused, and starts fresh when resumed", async () => {
    const task = await orchestrator.addTask({ title: "Write", description: "Write it", assignTo: "agent-1" });
    const events: string[] = [];
    orchestrator.on("task:paused", (e) => events.push(`paused:${e.from}:${e.reason}:${e.pausedBy}`));
    orchestrator.on("task:resumed", (e) => events.push(`resumed:${e.continued}:${e.resumedBy}`));

    const paused = await withEventOrigin({ source: "api", by: "anna@acme.com" }, () => orchestrator.pauseTask(task.id, { reason: "waiting for the brief" }));
    expect(paused.status).toBe("paused");
    expect(paused.pause).toMatchObject({ by: "anna@acme.com", reason: "waiting for the brief", from: "pending" });
    expect(paused.pause!.runId).toBeUndefined();
    expect((await store.getTask(task.id))!.pause).toMatchObject({ by: "anna@acme.com", reason: "waiting for the brief" });

    for (let i = 0; i < 3; i++) await orchestrator.tick();
    expect(spawned).toHaveLength(0);
    expect(await statusOf(task.id)).toBe("paused");

    const r = await withEventOrigin({ source: "api", by: "bob@acme.com" }, () => orchestrator.resumeTask(task.id));
    expect(r.continued).toBe(false);
    expect(r.task.status).toBe("pending");
    expect(r.task.pause).toMatchObject({ resumedBy: "bob@acme.com", reason: "waiting for the brief" });
    expect(await controls.listDirections(task.id)).toEqual([]);
    await orchestrator.tick();
    expect(spawned).toHaveLength(1);
    expect(events).toEqual(["paused:pending:waiting for the brief:anna@acme.com", "resumed:false:bob@acme.com"]);
  });

  it("a running task: its run is stopped and ends paused (not failed, not assessed); resume continues it", async () => {
    const task = await orchestrator.addTask({ title: "Sign up", description: "Create the account", assignTo: "agent-1" });
    await orchestrator.tick();
    expect(spawned).toHaveLength(1);
    expect(await statusOf(task.id)).toBe("in_progress");
    const first = spawned[0]!;

    const paused = await orchestrator.pauseTask(task.id, { reason: "the client changes the plan", by: "anna@acme.com" });
    expect(paused.pause).toMatchObject({ from: "in_progress", runId: first.runId });
    // the runner got SIGTERM (it stops gracefully, saving its conversation)
    expect(await exited(children[0]!)).toBe("SIGTERM");

    // the runner ends (killed by the signal): the run closes as paused, the task stays paused
    await endRun(first.runId, "killed");
    await orchestrator.tick();
    await orchestrator.tick();
    const after = (await store.getTask(task.id))!;
    expect(after.status).toBe("paused");
    expect(after.retries).toBe(0);
    expect(after.sessionId).toBe("sess-1");
    expect(after.runs?.find((r) => r.runId === first.runId)?.status).toBe("paused");
    expect(assessed).toEqual([]);
    expect(await runStore.getRun(first.runId)).toBeUndefined();
    expect(spawned).toHaveLength(1);

    const r = await orchestrator.resumeTask(task.id, { message: "the plan is final now", by: "bob@acme.com" });
    expect(r.continued).toBe(true);
    expect(r.direction).toMatchObject({ mode: "continue", status: "queued" });
    expect(r.direction!.message).toContain("paused by anna@acme.com (the client changes the plan)");
    expect(r.direction!.message).toContain("resumed by bob@acme.com");
    expect(r.direction!.message).toContain("Message from bob@acme.com: the plan is final now");

    // the next run claims the continuation (same session), and the task completes
    await orchestrator.tick();
    expect(spawned).toHaveLength(2);
    const second = spawned[1]!;
    expect((await store.getTask(task.id))!.runs?.find((x) => x.runId === second.runId)?.continuation).toBe(true);
    await endRun(second.runId, "completed");
    const [direction] = await controls.listDirections(task.id);
    expect(direction).toMatchObject({ runId: second.runId, status: "applied" });
    await tickUntil(async () => (await statusOf(task.id)) === "done");
  });

  it("resume waits for the run its pause stopped to end", async () => {
    const task = await orchestrator.addTask({ title: "Slow", description: "x", assignTo: "agent-1" });
    await orchestrator.tick();
    await orchestrator.pauseTask(task.id);
    const run = spawned[0]!;
    // ends while resume waits
    setTimeout(() => void endRun(run.runId, "killed"), 300);
    const r = await orchestrator.resumeTask(task.id);
    expect(r.continued).toBe(true);
    expect(await statusOf(task.id)).toBe("pending");
  }, 15_000);

  it("dependents wait while a dependency is paused (no deadlock), and run after it is resumed", async () => {
    const a = await orchestrator.addTask({ title: "A", description: "a", assignTo: "agent-1" });
    const b = await orchestrator.addTask({ title: "B", description: "b", assignTo: "agent-1", dependsOn: [a.id] });
    await orchestrator.pauseTask(a.id);
    for (let i = 0; i < 4; i++) await orchestrator.tick();
    expect(await statusOf(a.id)).toBe("paused");
    expect(await statusOf(b.id)).toBe("pending");
    expect(spawned).toHaveLength(0);

    await orchestrator.resumeTask(a.id);
    await orchestrator.tick();
    expect(spawned.map((s) => s.taskId)).toEqual([a.id]);
    await endRun(spawned[0]!.runId, "completed");
    await tickUntil(async () => spawned.some((s) => s.taskId === b.id));
  });

  it("a mission with a paused task stays active and does not complete; it completes after resume", async () => {
    const mission = await orchestrator.saveMission({
      name: "Sito · test",
      data: JSON.stringify({ tasks: [
        { title: "Copy", description: "Write the copy", assignTo: "agent-1" },
        { title: "Logo", description: "Make the logo", assignTo: "agent-1" },
      ] }),
    });
    const { tasks } = await orchestrator.executeMission(mission.id);
    const [copy, logo] = tasks;
    await orchestrator.pauseTask(logo!.id, { reason: "client sends the logo" });
    await store.transition(copy!.id, "assigned");
    await store.transition(copy!.id, "in_progress");
    await store.transition(copy!.id, "review");
    await store.transition(copy!.id, "done");
    for (let i = 0; i < 4; i++) await orchestrator.tick();
    expect((await orchestrator.getMission(mission.id))?.status).toBe("active");
    expect(await statusOf(logo!.id)).toBe("paused");
    // the mission's pause and the task's pause coexist: resuming the mission does not resume the task
    await orchestrator.updateMission(mission.id, { status: "paused" });
    await orchestrator.updateMission(mission.id, { status: "active" });
    expect(await statusOf(logo!.id)).toBe("paused");

    await orchestrator.resumeTask(logo!.id);
    await tickUntil(async () => spawned.some((s) => s.taskId === logo!.id));
    await endRun(spawned.find((s) => s.taskId === logo!.id)!.runId, "completed");
    await tickUntil(async () => (await orchestrator.getMission(mission.id))?.status === "completed");
  });

  it("refuses what makes no sense, and a paused task can still be killed", async () => {
    const task = await orchestrator.addTask({ title: "T", description: "t", assignTo: "agent-1" });
    await expect(orchestrator.resumeTask(task.id)).rejects.toThrow(/not paused/);
    await orchestrator.pauseTask(task.id);
    await expect(orchestrator.pauseTask(task.id)).rejects.toThrow(/already paused/);
    await expect(orchestrator.pauseTask("nope")).rejects.toThrow(/Task not found/);
    expect(await orchestrator.killTask(task.id)).toBe(true);
    expect(await statusOf(task.id)).toBe("failed");
    await expect(orchestrator.pauseTask(task.id)).rejects.toThrow(/only pending, assigned or in-progress/);
  });

  it("Polpo's chat tools pause and resume (recorded as Polpo)", async () => {
    const task = await orchestrator.addTask({ title: "Chat", description: "c", assignTo: "agent-1" });
    const out = await withEventOrigin({ source: "polpo" }, () => executeOrchestratorTool("pause_task", { taskId: task.id, reason: "hold on" }, orchestrator as never));
    expect(out).toContain("paused");
    expect((await store.getTask(task.id))!.pause).toMatchObject({ by: "Polpo", reason: "hold on" });
    const back = await executeOrchestratorTool("resume_task", { taskId: task.id }, orchestrator as never);
    expect(back).toContain("resumed");
    expect(await statusOf(task.id)).toBe("pending");
    expect(await executeOrchestratorTool("resume_task", { taskId: task.id }, orchestrator as never)).toMatch(/^Error: .*not paused/);
  });
});
