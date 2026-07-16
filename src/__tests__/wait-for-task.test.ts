import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { Orchestrator } from "../core/orchestrator.js";
import type { Task, TaskStatus } from "../core/types.js";
import {
  ALL_ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
} from "../llm/orchestrator-tools.js";

function makeTask(status: TaskStatus = "in_progress"): Task {
  return {
    id: "task-wait-1",
    title: "Long running task",
    description: "Exercise wait_for_task",
    assignTo: "agent-1",
    dependsOn: [],
    status,
    expectations: [],
    metrics: [],
    retries: 0,
    maxRetries: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeOrchestrator(initialStatus: TaskStatus = "in_progress") {
  const emitter = new EventEmitter();
  let task = makeTask(initialStatus);
  const getTask = vi.fn(async (id: string) => id === task.id ? task : undefined);
  const polpo = Object.assign(emitter, {
    getStore: () => ({ getTask }),
  }) as unknown as Orchestrator;

  return {
    polpo,
    getTask,
    transition(to: TaskStatus) {
      const from = task.status;
      task = { ...task, status: to, updatedAt: new Date().toISOString() };
      emitter.emit("task:transition", { taskId: task.id, from, to, task });
    },
  };
}

describe("wait_for_task orchestrator tool", () => {
  test("is exposed as a read-only orchestrator tool", () => {
    expect(ALL_ORCHESTRATOR_TOOLS.some((tool) => tool.name === "wait_for_task")).toBe(true);
  });

  test("keeps the tool call active and wakes on task transition events", async () => {
    const fixture = makeOrchestrator();
    const onProgress = vi.fn();

    const waiting = executeOrchestratorTool("wait_for_task", {
      taskId: "task-wait-1",
      pollIntervalMs: 10_000,
    }, fixture.polpo, { onProgress });

    await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
    fixture.transition("done");

    await expect(waiting).resolves.toContain('"status": "done"');
    expect(fixture.getTask).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-wait-1",
      status: "in_progress",
    }));
    expect(fixture.polpo.listenerCount("task:transition")).toBe(0);
  });

  test("returns a tool error when the configured timeout expires", async () => {
    const fixture = makeOrchestrator();

    const result = await executeOrchestratorTool("wait_for_task", {
      taskId: "task-wait-1",
      pollIntervalMs: 10_000,
      timeoutMs: 20,
    }, fixture.polpo);

    expect(result).toContain("Error: Timed out waiting for task");
    expect(fixture.polpo.listenerCount("task:transition")).toBe(0);
  });

  test("propagates cancellation and removes its transition listener", async () => {
    const fixture = makeOrchestrator();
    const controller = new AbortController();

    const waiting = executeOrchestratorTool("wait_for_task", {
      taskId: "task-wait-1",
      pollIntervalMs: 10_000,
    }, fixture.polpo, { signal: controller.signal });

    await vi.waitFor(() => expect(fixture.getTask).toHaveBeenCalled());
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.polpo.listenerCount("task:transition")).toBe(0);
  });
});
