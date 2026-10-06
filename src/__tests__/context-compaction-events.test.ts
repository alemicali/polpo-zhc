import { describe, expect, test } from "vitest";
import { TaskRunner } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";

/** A running agent whose activity reports compactions (as the runner subprocess writes it). */
function harness() {
  const emitter = new TypedEmitter();
  const memory = new Map<string, string>();
  const runs: any[] = [{
    id: "run-1", taskId: "t1", agentName: "dev", status: "running", pid: 1,
    activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "now" },
  }];
  const ctx = {
    emitter,
    runStore: { getActiveRuns: async () => runs },
    registry: { getState: async () => ({ processes: [] }), setState: async () => undefined },
    memoryStore: {
      get: async (scope?: string) => memory.get(scope ?? "shared") ?? "",
      append: async (line: string, scope?: string) => { memory.set(scope ?? "shared", `${memory.get(scope ?? "shared") ?? ""}\n${line}`); },
    },
  } as never;
  const runner = new TaskRunner(ctx);
  const events: any[] = [];
  emitter.on("context:compacted", (e) => events.push(e));
  return { runner, runs, events, memory };
}

const info = { reason: "budget", mode: "summary", beforeTokens: 150_000, afterTokens: 40_000, hardLimit: 200_000, removedMessages: 30, prunedToolResults: 4, compactionCount: 1, durationMs: 900, model: "anthropic:haiku" };

describe("task run compactions reach the bus", () => {
  test("one event per new compaction, with new durable facts saved to the agent's memory", async () => {
    const { runner, runs, events, memory } = harness();
    await runner.syncProcessesFromRunStore();
    expect(events).toEqual([]);

    runs[0].activity.compactions = 1;
    runs[0].activity.lastCompaction = { ...info, at: "x", durableFacts: ["Client prefers PDF reports", "Deploys happen on Fridays"] };
    await runner.syncProcessesFromRunStore();
    await runner.syncProcessesFromRunStore(); // same state: no duplicate
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scope: "task", taskId: "t1", runId: "run-1", agentName: "dev", mode: "summary", savedFacts: 2 });
    expect([...memory.values()].join("\n")).toContain("Client prefers PDF reports");

    // the next summary repeats a fact: only the new one is saved
    runs[0].activity.compactions = 2;
    runs[0].activity.lastCompaction = { ...info, compactionCount: 2, at: "y", durableFacts: ["Client prefers PDF reports", "Budget is 5k"] };
    await runner.syncProcessesFromRunStore();
    expect(events).toHaveLength(2);
    expect(events[1].savedFacts).toBe(1);
  });
});
