import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteRunStore } from "../stores/sqlite-run-store.js";
import type { RunRecord } from "../core/run-store.js";
import type { AgentActivity, TaskResult } from "../core/types.js";

const TEST_DIR = "/tmp/orchestra-run-store-test";
const DB_PATH = join(TEST_DIR, "state.db");

function createTestActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    lastUpdate: new Date().toISOString(),
    ...overrides,
  };
}

function createTestRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    pid: 12345,
    agentName: "agent-1",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activity: createTestActivity(),
    configPath: "/tmp/run-1.json",
    ...overrides,
  };
}

describe("SqliteRunStore", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = new SqliteRunStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("upsertRun", () => {
    it("inserts a new run", () => {
      const run = createTestRun();
      store.upsertRun(run);
      const retrieved = store.getRun("run-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.taskId).toBe("task-1");
      expect(retrieved!.pid).toBe(12345);
      expect(retrieved!.agentName).toBe("agent-1");
      expect(retrieved!.status).toBe("running");
    });

    it("updates existing run on conflict", () => {
      const run = createTestRun();
      store.upsertRun(run);

      const updated = createTestRun({ pid: 99999, status: "running" });
      store.upsertRun(updated);

      const retrieved = store.getRun("run-1");
      expect(retrieved!.pid).toBe(99999);
    });
  });

  describe("updateActivity", () => {
    it("updates activity for a run", () => {
      store.upsertRun(createTestRun());

      const newActivity = createTestActivity({
        lastTool: "Write",
        lastFile: "/src/foo.ts",
        toolCalls: 5,
      });
      store.updateActivity("run-1", newActivity);

      const retrieved = store.getRun("run-1");
      expect(retrieved!.activity.lastTool).toBe("Write");
      expect(retrieved!.activity.lastFile).toBe("/src/foo.ts");
      expect(retrieved!.activity.toolCalls).toBe(5);
    });
  });

  describe("completeRun", () => {
    it("marks a run as completed with result", () => {
      store.upsertRun(createTestRun());

      const result: TaskResult = {
        exitCode: 0,
        stdout: "done",
        stderr: "",
        duration: 5000,
      };
      store.completeRun("run-1", "completed", result);

      const retrieved = store.getRun("run-1");
      expect(retrieved!.status).toBe("completed");
      expect(retrieved!.result).toBeDefined();
      expect(retrieved!.result!.exitCode).toBe(0);
      expect(retrieved!.result!.stdout).toBe("done");
    });

    it("marks a run as failed", () => {
      store.upsertRun(createTestRun());
      store.completeRun("run-1", "failed", {
        exitCode: 1, stdout: "", stderr: "error", duration: 100,
      });
      expect(store.getRun("run-1")!.status).toBe("failed");
    });

    it("marks a run as killed", () => {
      store.upsertRun(createTestRun());
      store.completeRun("run-1", "killed", {
        exitCode: 1, stdout: "", stderr: "killed", duration: 100,
      });
      expect(store.getRun("run-1")!.status).toBe("killed");
    });
  });

  describe("getRunByTaskId", () => {
    it("finds run by task ID", () => {
      store.upsertRun(createTestRun({ id: "run-1", taskId: "task-abc" }));
      const found = store.getRunByTaskId("task-abc");
      expect(found).toBeDefined();
      expect(found!.id).toBe("run-1");
    });

    it("returns undefined for unknown task", () => {
      expect(store.getRunByTaskId("nonexistent")).toBeUndefined();
    });

    it("returns most recent run for a task", () => {
      store.upsertRun(createTestRun({
        id: "run-old",
        taskId: "task-1",
        startedAt: "2024-01-01T00:00:00Z",
      }));
      store.upsertRun(createTestRun({
        id: "run-new",
        taskId: "task-1",
        startedAt: "2024-12-01T00:00:00Z",
      }));
      const found = store.getRunByTaskId("task-1");
      expect(found!.id).toBe("run-new");
    });
  });

  describe("getActiveRuns", () => {
    it("returns only running runs", () => {
      store.upsertRun(createTestRun({ id: "run-1", status: "running" }));
      store.upsertRun(createTestRun({ id: "run-2", taskId: "task-2", status: "running" }));
      store.upsertRun(createTestRun({ id: "run-3", taskId: "task-3", status: "completed" }));
      store.upsertRun(createTestRun({ id: "run-4", taskId: "task-4", status: "failed" }));

      const active = store.getActiveRuns();
      expect(active).toHaveLength(2);
      expect(active.map(r => r.id).sort()).toEqual(["run-1", "run-2"]);
    });

    it("returns empty array when no running runs", () => {
      store.upsertRun(createTestRun({ id: "run-1", status: "completed" }));
      expect(store.getActiveRuns()).toHaveLength(0);
    });
  });

  describe("getTerminalRuns", () => {
    it("returns completed, failed, and killed runs", () => {
      store.upsertRun(createTestRun({ id: "run-1", status: "running" }));
      store.upsertRun(createTestRun({ id: "run-2", taskId: "task-2", status: "completed" }));
      store.upsertRun(createTestRun({ id: "run-3", taskId: "task-3", status: "failed" }));
      store.upsertRun(createTestRun({ id: "run-4", taskId: "task-4", status: "killed" }));

      const terminal = store.getTerminalRuns();
      expect(terminal).toHaveLength(3);
      expect(terminal.map(r => r.id).sort()).toEqual(["run-2", "run-3", "run-4"]);
    });
  });

  describe("deleteRun", () => {
    it("removes a run", () => {
      store.upsertRun(createTestRun());
      store.deleteRun("run-1");
      expect(store.getRun("run-1")).toBeUndefined();
    });

    it("no-op for nonexistent run", () => {
      expect(() => store.deleteRun("nonexistent")).not.toThrow();
    });
  });

  describe("concurrent access", () => {
    it("two stores can access the same DB", () => {
      const store2 = new SqliteRunStore(DB_PATH);
      try {
        store.upsertRun(createTestRun({ id: "run-1" }));
        const fromStore2 = store2.getRun("run-1");
        expect(fromStore2).toBeDefined();
        expect(fromStore2!.id).toBe("run-1");

        store2.updateActivity("run-1", createTestActivity({ toolCalls: 10 }));
        const fromStore1 = store.getRun("run-1");
        expect(fromStore1!.activity.toolCalls).toBe(10);
      } finally {
        store2.close();
      }
    });
  });
});
