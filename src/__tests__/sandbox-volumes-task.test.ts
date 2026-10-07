import { describe, expect, test } from "vitest";
import { TaskRunner, SandboxVolumeGrantError } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";

/** Just enough of the orchestrator for spawnForTask to reach the sandbox resolution. */
function harness(opts: { agentVolumes?: unknown; missionVolumes?: unknown; grant?: boolean }) {
  const emitter = new TypedEmitter();
  const transitions: string[] = [];
  const updates: any[] = [];
  const logs: string[] = [];
  emitter.on("log", (e: any) => logs.push(e.message));
  const volumeCalls: any[] = [];
  const ctx = {
    emitter,
    polpoDir: "/tmp/polpo-test",
    config: { settings: {} },
    hooks: { runBeforeSync: () => ({ cancelled: false }) },
    agentStore: { getAgent: async () => ({ name: "dev", sandbox: { provider: "e2b", volumes: opts.agentVolumes } }) },
    memoryStore: { get: async () => "" },
    sandboxProviders: () => new Set(["local", "bwrap", "e2b"]),
    sandboxVolumes: async (agent: string, selections: any[]) => {
      volumeCalls.push({ agent, selections });
      if (!opts.grant) throw new SandboxVolumeGrantError(selections[0].name);
      return [];
    },
    registry: {
      transition: async (_id: string, to: string) => { transitions.push(to); },
      updateTask: async (_id: string, patch: any) => { updates.push(patch); },
      getMission: async () => ({ data: JSON.stringify({ sandbox: { volumes: opts.missionVolumes } }) }),
      getAllTasks: async () => [],
    },
  } as never;
  return { runner: new TaskRunner(ctx), transitions, updates, logs, volumeCalls };
}

const task = { id: "t1", title: "Do it", description: "x", assignTo: "dev", missionId: "m1", group: "m", status: "pending", phase: "execution" } as any;

describe("tasks and volumes", () => {
  test("a volume the agent is not granted fails the task with a clear message", async () => {
    const h = harness({ agentVolumes: [{ name: "data" }] });
    await h.runner.spawnForTask(task);
    expect(h.volumeCalls).toEqual([{ agent: "dev", selections: [{ name: "data" }] }]);
    expect(h.transitions.at(-1)).toBe("failed");
    expect(h.updates.at(-1).result.stderr).toMatch(/data.*Grant the volume to agent "dev"/s);
  });

  test("a mission selecting a volume outside the agent's list fails the task (narrowing only)", async () => {
    const h = harness({ agentVolumes: [{ name: "data" }], missionVolumes: [{ name: "other" }], grant: true });
    await h.runner.spawnForTask(task);
    expect(h.volumeCalls).toEqual([]);
    expect(h.transitions.at(-1)).toBe("failed");
    expect(h.logs.join(" ")).toMatch(/not granted by the parent policy: other/);
  });
});
