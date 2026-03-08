import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Orchestrator } from "../core/orchestrator.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestAgent, createTestActivity } from "./fixtures.js";
import type { RunRecord } from "../core/run-store.js";

function createTestRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    taskId: "task-1",
    pid: 0,
    agentName: "agent-1",
    status: "running",
    startedAt: now,
    updatedAt: now,
    activity: createTestActivity(),
    configPath: "/tmp/run.json",
    ...overrides,
  };
}

describe("Orchestrator Resilience", () => {
  let store: InMemoryTaskStore;
  let runStore: InMemoryRunStore;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new InMemoryTaskStore();
    runStore = new InMemoryRunStore();

    orchestrator = new Orchestrator({
      workDir: "/tmp/orchestra-resilience-test",
      store,
      runStore,
      assessFn: async () => ({
        passed: true,
        checks: [],
        metrics: [],
        timestamp: new Date().toISOString(),
      }),
    });

    const team = {
      name: "test-team",
      agents: [
        createTestAgent({ name: "agent-1" }),
        createTestAgent({ name: "agent-senior" }),
      ],
    };
    await orchestrator.initInteractive("test-project", team);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Task Timeout ────────────────────────────────────────

  describe("Task timeout", () => {
    it("kills agent when task exceeds maxDuration", async () => {
      const task = await orchestrator.addTask({
        title: "Slow task",
        description: "Should timeout",
        assignTo: "agent-1",
        maxDuration: 100,
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal });
        return true;
      }) as any);

      // Add active run in RunStore with old startedAt
      await runStore.upsertRun(createTestRunRecord({
        id: "run-timeout",
        taskId: task.id,
        pid: 12345,
        agentName: "agent-1",
        status: "running",
        startedAt: new Date(Date.now() - 200).toISOString(),
        activity: createTestActivity(),
      }));

      const events: any[] = [];
      orchestrator.on("task:timeout", (e) => events.push(e));

      await orchestrator.tick();

      expect(killCalls.some(c => c.pid === 12345 && c.signal === "SIGTERM")).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].taskId).toBe(task.id);
      expect(events[0].timeout).toBe(100);
    });

    it("does not kill agent before maxDuration", async () => {
      const task = await orchestrator.addTask({
        title: "Quick task",
        description: "Not timeout",
        assignTo: "agent-1",
        maxDuration: 60000,
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const killCalls: number[] = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
        killCalls.push(pid);
        return true;
      }) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-quick",
        taskId: task.id,
        pid: 11111,
        status: "running",
        startedAt: new Date().toISOString(),
        activity: createTestActivity(),
      }));

      await orchestrator.tick();

      // Should not have killed the runner
      expect(killCalls.filter(p => p === 11111)).toHaveLength(0);
    });

    it("uses default taskTimeout from settings", async () => {
      (orchestrator as any).config.settings.taskTimeout = 50;

      const task = await orchestrator.addTask({
        title: "Default timeout",
        description: "Uses settings",
        assignTo: "agent-1",
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal });
        return true;
      }) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-default",
        taskId: task.id,
        pid: 22222,
        status: "running",
        startedAt: new Date(Date.now() - 100).toISOString(),
        activity: createTestActivity(),
      }));

      await orchestrator.tick();

      expect(killCalls.some(c => c.pid === 22222 && c.signal === "SIGTERM")).toBe(true);
    });

    it("skips timeout when maxDuration is 0", async () => {
      const task = await orchestrator.addTask({
        title: "No timeout",
        description: "Disabled",
        assignTo: "agent-1",
        maxDuration: 0,
      });

      // Also disable stale detection
      (orchestrator as any).config.settings.staleThreshold = 0;

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const killCalls: number[] = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
        killCalls.push(pid);
        return true;
      }) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-notimeout",
        taskId: task.id,
        pid: 33333,
        status: "running",
        startedAt: new Date(Date.now() - 999999).toISOString(),
        activity: createTestActivity({ lastUpdate: new Date().toISOString() }),
      }));

      await orchestrator.tick();

      expect(killCalls.filter(p => p === 33333)).toHaveLength(0);
    });
  });

  // ─── Stale Detection ─────────────────────────────────────

  describe("Stale detection", () => {
    it("warns when agent idle exceeds staleThreshold", async () => {
      (orchestrator as any).config.settings.staleThreshold = 100;
      (orchestrator as any).config.settings.taskTimeout = 0; // disable timeout

      const task = await orchestrator.addTask({
        title: "Stale task",
        description: "Agent idle",
        assignTo: "agent-1",
        maxDuration: 0,
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      vi.spyOn(process, "kill").mockImplementation((() => true) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-stale",
        taskId: task.id,
        pid: 44444,
        agentName: "agent-1",
        status: "running",
        startedAt: new Date().toISOString(),
        activity: createTestActivity({
          lastUpdate: new Date(Date.now() - 150).toISOString(),
        }),
      }));

      const staleEvents: any[] = [];
      orchestrator.on("agent:stale", (e) => staleEvents.push(e));

      await orchestrator.tick();

      expect(staleEvents).toHaveLength(1);
      expect(staleEvents[0].action).toBe("warning");
      expect(staleEvents[0].agentName).toBe("agent-1");
    });

    it("kills agent when idle exceeds 2x staleThreshold", async () => {
      (orchestrator as any).config.settings.staleThreshold = 100;
      (orchestrator as any).config.settings.taskTimeout = 0;

      const task = await orchestrator.addTask({
        title: "Very stale",
        description: "Stuck agent",
        assignTo: "agent-1",
        maxDuration: 0,
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal });
        return true;
      }) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-verystale",
        taskId: task.id,
        pid: 55555,
        agentName: "agent-1",
        status: "running",
        startedAt: new Date().toISOString(),
        activity: createTestActivity({
          lastUpdate: new Date(Date.now() - 250).toISOString(),
        }),
      }));

      const staleEvents: any[] = [];
      orchestrator.on("agent:stale", (e) => staleEvents.push(e));

      await orchestrator.tick();

      expect(killCalls.some(c => c.pid === 55555 && c.signal === "SIGTERM")).toBe(true);
      expect(staleEvents).toHaveLength(1);
      expect(staleEvents[0].action).toBe("killed");
    });

    it("warns only once per task", async () => {
      (orchestrator as any).config.settings.staleThreshold = 100;
      (orchestrator as any).config.settings.taskTimeout = 0;

      const task = await orchestrator.addTask({
        title: "Warn once",
        description: "Only one warning",
        assignTo: "agent-1",
        maxDuration: 0,
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      vi.spyOn(process, "kill").mockImplementation((() => true) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-warnonce",
        taskId: task.id,
        pid: 66666,
        agentName: "agent-1",
        status: "running",
        startedAt: new Date().toISOString(),
        activity: createTestActivity({
          lastUpdate: new Date(Date.now() - 150).toISOString(),
        }),
      }));

      const staleEvents: any[] = [];
      orchestrator.on("agent:stale", (e) => staleEvents.push(e));

      await orchestrator.tick();
      await orchestrator.tick();

      expect(staleEvents).toHaveLength(1);
    });
  });

  // ─── Smart Retry ──────────────────────────────────────────

  describe("Smart retry", () => {
    it("escalates to fallback agent after escalateAfter failures", async () => {
      const task = await orchestrator.addTask({
        title: "Escalating",
        description: "Will escalate",
        assignTo: "agent-1",
        retryPolicy: {
          escalateAfter: 1,
          fallbackAgent: "agent-senior",
        },
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");

      const result = {
        exitCode: 1,
        stdout: "",
        stderr: "error occurred",
        duration: 100,
      };

      await (orchestrator as any).retryOrFail(task.id, task, result);

      const updated = (await store.getTask(task.id))!;
      expect(updated.status).toBe("pending");
      expect(updated.assignTo).toBe("agent-senior");
    });

    it("keeps same agent before escalateAfter threshold", async () => {
      const task = await orchestrator.addTask({
        title: "No escalation yet",
        description: "First failure",
        assignTo: "agent-1",
        retryPolicy: {
          escalateAfter: 2,
          fallbackAgent: "agent-senior",
        },
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");

      await (orchestrator as any).retryOrFail(task.id, task, {
        exitCode: 1, stdout: "", stderr: "error", duration: 100,
      });

      const updated = (await store.getTask(task.id))!;
      expect(updated.status).toBe("pending");
      expect(updated.assignTo).toBe("agent-1");
    });

    it("uses defaultRetryPolicy from settings", async () => {
      (orchestrator as any).config.settings.defaultRetryPolicy = {
        escalateAfter: 1,
        fallbackAgent: "agent-senior",
      };

      const task = await orchestrator.addTask({
        title: "Default policy",
        description: "Uses settings",
        assignTo: "agent-1",
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");

      await (orchestrator as any).retryOrFail(task.id, task, {
        exitCode: 1, stdout: "", stderr: "err", duration: 50,
      });

      expect((await store.getTask(task.id))!.assignTo).toBe("agent-senior");
    });

    it("ignores fallback if agent not in team", async () => {
      const task = await orchestrator.addTask({
        title: "Missing fallback",
        description: "Fallback not found",
        assignTo: "agent-1",
        retryPolicy: {
          escalateAfter: 1,
          fallbackAgent: "nonexistent-agent",
        },
      });

      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");
      await store.transition(task.id, "review");

      await (orchestrator as any).retryOrFail(task.id, task, {
        exitCode: 1, stdout: "", stderr: "err", duration: 50,
      });

      // Should keep original agent since fallback doesn't exist
      expect((await store.getTask(task.id))!.assignTo).toBe("agent-1");
    });
  });

  // ─── Orphan Recovery with RunStore ─────────────────────────

  describe("Orphan recovery with RunStore", () => {
    it("cleans up run record when runner PID is dead", async () => {
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === 0) throw new Error("ESRCH");
        return true;
      }) as any);

      await runStore.upsertRun(createTestRunRecord({
        id: "run-dead",
        taskId: "dead-task",
        pid: 99999,
        status: "running",
      }));

      await orchestrator.recoverOrphanedTasks();

      // Dead run gets completed as failed then deleted
      const run = await runStore.getRun("run-dead");
      expect(run).toBeUndefined();
    });

    it("keeps run alive when runner PID is still running", async () => {
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === 0) return true; // Process exists
        return true;
      }) as any);

      const task = await store.addTask({
        title: "Still running",
        description: "Runner alive",
        assignTo: "agent-1",
        dependsOn: [],
        expectations: [],
        metrics: [],
        maxRetries: 2,
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      await runStore.upsertRun(createTestRunRecord({
        id: "run-alive",
        taskId: task.id,
        pid: 88888,
        status: "running",
      }));

      const recovered = await orchestrator.recoverOrphanedTasks();

      // Task should NOT be recovered — runner is still alive
      expect(recovered).toBe(0);
      expect((await store.getTask(task.id))!.status).toBe("in_progress");
      expect((await runStore.getRun("run-alive"))!.status).toBe("running");
    });
  });

  // ─── Backward Compat: Orphan Process Cleanup ──────────────

  describe("Orphan process cleanup (backward compat)", () => {
    it("attempts to kill orphan processes on recovery", async () => {
      const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal });
        return true;
      }) as any);

      await store.setState({
        processes: [
          {
            agentName: "agent-1",
            pid: 99999,
            taskId: "orphan-task",
            startedAt: new Date().toISOString(),
            alive: true,
            activity: createTestActivity(),
          },
        ],
      });

      // Add an orphaned task
      const task = await store.addTask({
        title: "Orphan",
        description: "Left behind",
        assignTo: "agent-1",
        dependsOn: [],
        expectations: [],
        metrics: [],
        maxRetries: 2,
      });
      await store.transition(task.id, "assigned");
      await store.transition(task.id, "in_progress");

      await orchestrator.recoverOrphanedTasks();

      // Should have called kill(99999, 0) for existence check
      // then kill(99999, "SIGTERM")
      const pidCalls = killCalls.filter(c => c.pid === 99999);
      expect(pidCalls.length).toBeGreaterThanOrEqual(2);
      expect(pidCalls[0].signal).toBe(0);
      expect(pidCalls[1].signal).toBe("SIGTERM");
    });

    it("silently skips dead processes", async () => {
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === 0) throw new Error("ESRCH");
        return true;
      }) as any);

      await store.setState({
        processes: [
          {
            agentName: "agent-1",
            pid: 12345,
            taskId: "dead-task",
            startedAt: new Date().toISOString(),
            alive: true,
            activity: createTestActivity(),
          },
        ],
      });

      await expect(orchestrator.recoverOrphanedTasks()).resolves.not.toThrow();
    });

    it("skips processes with pid 0 (in-process agent)", async () => {
      const killCalls: number[] = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
        killCalls.push(pid);
        return true;
      }) as any);

      await store.setState({
        processes: [
          {
            agentName: "sdk-agent",
            pid: 0,
            taskId: "sdk-task",
            startedAt: new Date().toISOString(),
            alive: true,
            activity: createTestActivity(),
          },
        ],
      });

      await orchestrator.recoverOrphanedTasks();

      // pid 0 should be skipped (condition: proc.pid > 0)
      expect(killCalls).toHaveLength(0);
    });

    it("skips processes not marked alive", async () => {
      const killCalls: number[] = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
        killCalls.push(pid);
        return true;
      }) as any);

      await store.setState({
        processes: [
          {
            agentName: "agent-1",
            pid: 55555,
            taskId: "done-task",
            startedAt: new Date().toISOString(),
            alive: false,
            activity: createTestActivity(),
          },
        ],
      });

      await orchestrator.recoverOrphanedTasks();

      expect(killCalls).toHaveLength(0);
    });
  });
});
