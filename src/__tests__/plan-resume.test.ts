import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { InMemoryRunStore, createTestAgent } from "./fixtures.js";

const TEST_DIR = join(process.cwd(), ".test-polpo-plan-resume");

describe("Plan resume (Orchestrator)", () => {
  let store: SqliteTaskStore;
  let runStore: InMemoryRunStore;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    store = new SqliteTaskStore(TEST_DIR);
    runStore = new InMemoryRunStore();

    orchestrator = new Orchestrator({
      workDir: TEST_DIR,
      store,
      runStore,
      assessFn: async () => ({
        passed: true,
        checks: [],
        metrics: [],
        timestamp: new Date().toISOString(),
      }),
    });

    await orchestrator.initInteractive("test-project", {
      name: "test-team",
      agents: [createTestAgent({ name: "dev" })],
    });
  });

  afterEach(() => {
    store.close();
    runStore.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("getResumablePlans", () => {
    it("returns empty array when no plans exist", () => {
      expect(orchestrator.getResumablePlans()).toEqual([]);
    });

    it("returns empty array for draft plans", () => {
      orchestrator.savePlan({ data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }), status: "draft" });
      expect(orchestrator.getResumablePlans()).toEqual([]);
    });

    it("returns empty array for completed plans", () => {
      const plan = orchestrator.savePlan({ data: JSON.stringify({ tasks: [{ title: "T1", assignTo: "dev" }] }), status: "draft" });
      orchestrator.updatePlan(plan.id, { status: "completed" });
      expect(orchestrator.getResumablePlans()).toEqual([]);
    });

    it("returns active plan with pending tasks", () => {
      const data = JSON.stringify({ tasks: [{ title: "Task1", description: "Do something", assignTo: "dev" }] });
      const plan = orchestrator.savePlan({ data });
      orchestrator.executePlan(plan.id);

      const resumable = orchestrator.getResumablePlans();
      // After execution, tasks start as pending — plan is resumable
      expect(resumable.length).toBe(1);
      expect(resumable[0].id).toBe(plan.id);
    });

    it("returns failed plan with failed tasks", () => {
      const data = JSON.stringify({ tasks: [{ title: "FailTask", description: "Will fail", assignTo: "dev" }] });
      const plan = orchestrator.savePlan({ data });
      orchestrator.executePlan(plan.id);

      // Manually fail the task
      const state = store.getState();
      const task = state.tasks.find(t => t.group === plan.name);
      expect(task).toBeDefined();
      store.transition(task!.id, "assigned");
      store.transition(task!.id, "in_progress");
      store.transition(task!.id, "review");
      store.transition(task!.id, "failed");
      orchestrator.updatePlan(plan.id, { status: "failed" });

      const resumable = orchestrator.getResumablePlans();
      expect(resumable.length).toBe(1);
      expect(resumable[0].name).toBe(plan.name);
    });

    it("excludes cancelled plans", () => {
      const data = JSON.stringify({ tasks: [{ title: "T", description: "d", assignTo: "dev" }] });
      const plan = orchestrator.savePlan({ data });
      orchestrator.executePlan(plan.id);
      orchestrator.updatePlan(plan.id, { status: "cancelled" });

      expect(orchestrator.getResumablePlans()).toEqual([]);
    });
  });

  describe("resumePlan", () => {
    it("throws for non-existent plan", () => {
      expect(() => orchestrator.resumePlan("nonexistent")).toThrow("Plan not found");
    });

    it("resumes a failed plan and retries failed tasks", () => {
      const data = JSON.stringify({ tasks: [{ title: "ResumableTask", description: "Will be resumed", assignTo: "dev" }] });
      const plan = orchestrator.savePlan({ data });
      orchestrator.executePlan(plan.id);

      // Fail the task
      const state = store.getState();
      const task = state.tasks.find(t => t.group === plan.name)!;
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "failed");
      orchestrator.updatePlan(plan.id, { status: "failed" });

      const result = orchestrator.resumePlan(plan.id, { retryFailed: true });
      expect(result.retried).toBe(1);

      // Plan should be back to active
      const updated = orchestrator.getPlan(plan.id);
      expect(updated?.status).toBe("active");

      // Task should be back to pending
      const taskAfter = store.getTask(task.id);
      expect(taskAfter?.status).toBe("pending");
    });

    it("resumes without retrying when retryFailed is false", () => {
      const data = JSON.stringify({ tasks: [{ title: "NoRetryTask", description: "d", assignTo: "dev" }] });
      const plan = orchestrator.savePlan({ data });
      orchestrator.executePlan(plan.id);

      const state = store.getState();
      const task = state.tasks.find(t => t.group === plan.name)!;
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "failed");
      orchestrator.updatePlan(plan.id, { status: "failed" });

      const result = orchestrator.resumePlan(plan.id, { retryFailed: false });
      expect(result.retried).toBe(0);

      // Task stays failed
      const taskAfter = store.getTask(task.id);
      expect(taskAfter?.status).toBe("failed");
    });

    it("emits plan:resumed event", () => {
      const data = JSON.stringify({ tasks: [{ title: "EventTask", description: "d", assignTo: "dev" }] });
      const plan = orchestrator.savePlan({ data });
      orchestrator.executePlan(plan.id);
      orchestrator.updatePlan(plan.id, { status: "failed" });

      // Fail the task
      const task = store.getState().tasks.find(t => t.group === plan.name)!;
      store.transition(task.id, "assigned");
      store.transition(task.id, "in_progress");
      store.transition(task.id, "review");
      store.transition(task.id, "failed");

      let event: any;
      orchestrator.on("plan:resumed", (e) => { event = e; });

      orchestrator.resumePlan(plan.id, { retryFailed: true });
      expect(event).toBeDefined();
      expect(event.planId).toBe(plan.id);
      expect(event.retried).toBe(1);
    });
  });
});
