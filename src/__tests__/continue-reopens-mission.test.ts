/**
 * A human continuation of a task of a finished mission runs it again and reopens the mission.
 * Seen live (sitoinchat, 2026-11-28 07:09 UTC): POST /tasks/:id/directions {mode: "continue"} on a
 * done task of a completed mission answered ok, the task went pending, and ~1.4 s later it was
 * failed with no new run and the direction queued forever: the tick never starts a pending task
 * of a completed mission, so it found it stuck and force-failed it as a deadlock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { Orchestrator } from "../core/orchestrator.js";
import { executeOrchestratorTool } from "../llm/orchestrator-tools.js";
import { InMemoryTaskStore, InMemoryRunStore, InMemoryTaskControlStore, createTestAgent } from "./fixtures.js";
import type { Mission, Task } from "../core/types.js";

const WORK_DIR = "/tmp/polpo-test-continue-reopens-mission";

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

describe("a continuation reopens the task's finished mission", () => {
  let store: MissionTaskStore;
  let runStore: InMemoryRunStore;
  let controls: InMemoryTaskControlStore;
  let orchestrator: Orchestrator;
  let spawned: Array<{ taskId: string; runId: string }>;
  let passes: boolean;

  beforeEach(async () => {
    store = new MissionTaskStore();
    runStore = new InMemoryRunStore();
    controls = new InMemoryTaskControlStore();
    spawned = [];
    passes = true;
    orchestrator = new Orchestrator({
      workDir: WORK_DIR,
      store,
      runStore,
      taskControlStore: controls,
      spawner: {
        spawn: async (config: { taskId: string; runId: string }) => {
          spawned.push({ taskId: config.taskId, runId: config.runId });
          return { pid: 4242, configPath: "/tmp/run.json" };
        },
        isAlive: () => true,
        kill: () => {},
      } as never,
      assessFn: async () => ({ passed: passes, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await orchestrator.initInteractive("test-project", { name: "team", agents: [createTestAgent({ name: "agent-1" })] });
  });

  afterEach(() => {
    if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  });

  /** A one-task mission that ran and ended with its task in `status`. */
  async function finishedMission(status: "done" | "failed"): Promise<{ missionId: string; task: Task }> {
    const mission = await orchestrator.saveMission({
      name: "Sito · test",
      data: JSON.stringify({ tasks: [{ title: "Build the site", description: "Build it", assignTo: "agent-1" }] }),
    });
    const { tasks } = await orchestrator.executeMission(mission.id);
    const task = tasks[0]!;
    await store.transition(task.id, "assigned");
    await store.transition(task.id, "in_progress");
    if (status === "done") await store.transition(task.id, "review");
    await store.transition(task.id, status);
    await orchestrator.tick();
    expect((await orchestrator.getMission(mission.id))?.status).toBe(status === "done" ? "completed" : "failed");
    return { missionId: mission.id, task };
  }

  /** The runner subprocess: claims the queued directions, applies them, then ends its run. */
  async function finishRun(runId: string, exitCode: number): Promise<void> {
    const run = (await runStore.getRun(runId))!;
    for (const d of await controls.claimDirections(run.taskId, runId)) await controls.markDirectionApplied(d.id);
    await runStore.upsertRun({
      ...run,
      status: exitCode === 0 ? "completed" : "failed",
      result: { exitCode, stdout: "ok", stderr: "", duration: 10 },
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

  const statusOf = async (taskId: string) => (await store.getTask(taskId))?.status;
  const missionStatus = async (missionId: string) => (await orchestrator.getMission(missionId))?.status;

  it("done task of a completed mission: a new run claims the direction, the mission is active while it runs and completed after", async () => {
    const { missionId, task } = await finishedMission("done");
    const updates: Array<{ status: string; prevStatus?: string }> = [];
    orchestrator.on("mission:updated", (e) => updates.push({ status: e.status, prevStatus: e.prevStatus }));

    const result = await orchestrator.sendDirection(task.id, "Change the hero title", { mode: "continue" });
    expect(result.action).toBe("continue");
    expect(result.reopenedMission).toEqual({ id: missionId, name: "Sito · test", prevStatus: "completed" });
    expect(await statusOf(task.id)).toBe("pending");
    expect(await missionStatus(missionId)).toBe("active");
    expect(updates).toContainEqual({ status: "active", prevStatus: "completed" });

    // the next tick starts it (before the fix: force-failed as a deadlock, no run)
    await orchestrator.tick();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.taskId).toBe(task.id);
    expect(await statusOf(task.id)).not.toBe("failed");
    expect(await missionStatus(missionId)).toBe("active");

    await finishRun(spawned[0]!.runId, 0);
    const [direction] = await controls.listDirections(task.id);
    expect(direction).toMatchObject({ mode: "continue", runId: spawned[0]!.runId });
    expect(direction!.status).toBe("applied");

    await tickUntil(async () => (await missionStatus(missionId)) === "completed");
    expect(await statusOf(task.id)).toBe("done");
    expect(updates.at(-1)).toEqual({ status: "completed", prevStatus: "active" });
  });

  it("the continuation fails: the mission ends failed", async () => {
    const { missionId, task } = await finishedMission("done");
    await orchestrator.sendDirection(task.id, "Try again differently", { mode: "continue" });
    await orchestrator.tick();
    expect(spawned).toHaveLength(1);
    passes = false;
    // every run fails (the first and its automatic retries) until the task gives up
    const finished = new Set<string>();
    await tickUntil(async () => {
      for (const { runId } of spawned) {
        if (!finished.has(runId)) { finished.add(runId); await finishRun(runId, 1); }
      }
      return (await missionStatus(missionId)) === "failed" && (await statusOf(task.id)) === "failed";
    });
  });

  it("failed task of a failed mission: continued, it runs and the mission completes", async () => {
    const { missionId, task } = await finishedMission("failed");
    const result = await orchestrator.sendDirection(task.id, "Fix the build", { mode: "continue" });
    expect(result.reopenedMission?.prevStatus).toBe("failed");
    expect(await missionStatus(missionId)).toBe("active");
    await orchestrator.tick();
    expect(spawned).toHaveLength(1);
    await finishRun(spawned[0]!.runId, 0);
    await tickUntil(async () => (await missionStatus(missionId)) === "completed");
    expect(await statusOf(task.id)).toBe("done");
  });

  it("a run that ends before any tick sees it running still closes the reopened mission", async () => {
    const { missionId, task } = await finishedMission("done");
    await orchestrator.sendDirection(task.id, "Quick fix", { mode: "continue" });
    // the task ends without the tick ever seeing it non-terminal
    await store.transition(task.id, "assigned");
    await store.transition(task.id, "in_progress");
    await store.transition(task.id, "review");
    await store.transition(task.id, "done");
    await orchestrator.tick();
    expect(await missionStatus(missionId)).toBe("completed");
  });

  it("retrying a failed task of a failed mission reopens it too", async () => {
    const { missionId, task } = await finishedMission("failed");
    await orchestrator.retryTask(task.id);
    expect(await missionStatus(missionId)).toBe("active");
    await orchestrator.tick();
    expect(spawned).toHaveLength(1);
  });

  it("follow_up on a finished task says to use continue; a cancelled mission is not reopened", async () => {
    const { missionId, task } = await finishedMission("done");
    await expect(orchestrator.sendDirection(task.id, "One more thing", { mode: "follow_up" }))
      .rejects.toThrow(/no active runner to steer \(it is done\).*mode "continue"/);

    await orchestrator.updateMission(missionId, { status: "cancelled" });
    await expect(orchestrator.sendDirection(task.id, "Go on", { mode: "continue" })).rejects.toThrow(/cancelled/);
    expect(await statusOf(task.id)).toBe("done");
    expect(await controls.listDirections(task.id)).toEqual([]);
  });

  it("the chat tool says the mission was reopened", async () => {
    const { task } = await finishedMission("done");
    const out = await executeOrchestratorTool("send_task_direction", { taskId: task.id, message: "Go on", mode: "continue" }, orchestrator as never);
    expect(out).toContain("using continue mode");
    expect(out).toContain('Mission "Sito · test" was completed and is active again');
  });
});
