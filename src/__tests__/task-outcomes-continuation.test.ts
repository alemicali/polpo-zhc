/**
 * Task outcomes across runs: a continuation ("continue" direction) keeps the previous runs'
 * outcomes and appends its own; a new execution (retry, fix) replaces them. The same for Polpo's
 * engine and the agent harnesses (both hand their outcomes to the runner the same way).
 */
import { describe, expect, test } from "vitest";
import { TaskRunner } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";

const outcome = (id: string, label: string) => ({ id, type: "text", label, text: label, producedBy: "register_outcome", producedAt: "now" });

function setup(directions: any[]) {
  const task: any = { id: "t1", status: "in_progress", outcomes: [outcome("o1", "first run")] };
  const runs: any[] = [{
    id: "run-2", taskId: "t1", agentName: "dev", status: "completed", pid: 1, startedAt: new Date().toISOString(),
    activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "now" },
    outcomes: [outcome("o2", "second run")],
    result: { exitCode: 0, stdout: "ok", stderr: "", duration: 1 },
  }];
  const ctx = {
    emitter: new TypedEmitter(),
    runStore: { getTerminalRuns: async () => runs.splice(0), deleteRun: async () => undefined },
    registry: {
      getTask: async () => task,
      updateTask: async (_id: string, u: any) => { Object.assign(task, u); return task; },
    },
    taskControlStore: { listDirections: async () => directions },
  } as never;
  return { runner: new TaskRunner(ctx), task };
}

describe("task outcomes after a run", () => {
  test("a continuation appends to the previous runs' outcomes", async () => {
    const { runner, task } = setup([{ id: "d1", taskId: "t1", runId: "run-2", mode: "continue", status: "applied", message: "go on", createdAt: "now" }]);
    await runner.collectResults(() => {});
    expect(task.outcomes.map((o: any) => o.label)).toEqual(["first run", "second run"]);
  });

  test("a new execution (no continuation) replaces them", async () => {
    const { runner, task } = setup([{ id: "d0", taskId: "t1", runId: "run-1", mode: "continue", status: "applied", message: "old", createdAt: "now" }]);
    await runner.collectResults(() => {});
    expect(task.outcomes.map((o: any) => o.label)).toEqual(["second run"]);
  });
});
