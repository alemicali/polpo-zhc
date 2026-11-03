import { describe, expect, test, vi } from "vitest";
import { TaskManager } from "../core/task-manager.js";
import { TypedEmitter } from "../core/events.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";

describe("reassessing a task", () => {
  test("its checks get the task's output folder, as on the first assessment ($POLPO_OUTPUT_DIR)", async () => {
    const task = {
      id: "t1", title: "scrivi", description: "x", status: "failed", group: "prova-reassess", missionId: "m1",
      expectations: [{ type: "file_exists", paths: ["$POLPO_OUTPUT_DIR/b.txt"] }], metrics: [],
      result: { exitCode: 0, stdout: "", stderr: "", duration: 1 },
    };
    const assessFn = vi.fn(async () => ({ passed: false, checks: [], metrics: [], timestamp: "" }));
    const ctx = {
      emitter: new TypedEmitter(),
      registry: {
        getTask: async () => task,
        getMission: async () => ({ id: "m1", data: JSON.stringify({ tasks: [{ title: "scrivi" }] }) }),
        updateTask: async () => task,
        transition: async () => task,
      },
      runStore: { getRunByTaskId: async () => undefined },
      config: { settings: {} },
      agentWorkDir: "/w/",
      polpoDir: "/w/.polpo",
      assessFn,
    } as unknown as OrchestratorContext;

    await new TaskManager(ctx).reassessTask("t1");

    expect(assessFn).toHaveBeenCalledOnce();
    const context = (assessFn.mock.calls[0] as unknown[])[3] as { outputDir?: string };
    expect(context.outputDir).toBe("/w/output/prova-reassess/01 - scrivi");
  });
});
