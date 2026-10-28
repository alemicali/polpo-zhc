import { describe, it, expect } from "vitest";
import { reduceEvent } from "@polpo-ai/sdk";
import type { Mission, StoreState } from "@polpo-ai/sdk";
import { createMockStore, fakeMission } from "./helpers.js";

function stateWith(mission: Mission): StoreState {
  const store = createMockStore();
  store.upsertMission(mission);
  return store.getSnapshot();
}

const event = (name: string, data: unknown) => ({ id: "1", event: name, data, timestamp: new Date().toISOString() });

describe("reduceEvent: mission status from checkpoints and abort", () => {
  it("pauses the mission when its checkpoint is reached, and marks missions stale", () => {
    const next = reduceEvent(stateWith(fakeMission({ id: "m1", status: "active" })), event("checkpoint:reached", { missionId: "m1", group: "g", checkpointName: "review" }));
    expect(next.missions.get("m1")?.status).toBe("paused");
    expect(next.missionsStale).toBe(true);
  });

  it("makes the mission active again when the checkpoint is resumed", () => {
    const next = reduceEvent(stateWith(fakeMission({ id: "m1", status: "paused" })), event("checkpoint:resumed", { missionId: "m1", group: "g", checkpointName: "review" }));
    expect(next.missions.get("m1")?.status).toBe("active");
    expect(next.missionsStale).toBe(true);
  });

  it("marks missions stale when one is aborted", () => {
    const next = reduceEvent(stateWith(fakeMission({ id: "m1", status: "paused" })), event("mission:aborted", { missionId: "m1", group: "g", killedTasks: 1 }));
    expect(next.missionsStale).toBe(true);
  });
});

describe("reduceEvent: pipeline state in agent activity", () => {
  it("keeps the latest pipeline state of a run, and keeps it on activity without one", () => {
    const process = {
      agentName: "writer", pid: 1, taskId: "t1", startedAt: "2025-01-01T00:00:00Z", alive: true,
      activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "2025-01-01T00:00:00Z" },
    };
    const base = { ...createMockStore().getSnapshot(), processes: [process] } as unknown as StoreState;
    const pipeline = { status: "running", pipeline: { steps: [{ loop: "draft" }] }, steps: { "steps.0": { kind: "loop", name: "draft", status: "running", attempt: 1 } }, startedAt: "2025-01-01T00:00:01Z" };

    const withState = reduceEvent(base, event("agent:activity", { taskId: "t1", agentName: "writer", pipeline }));
    expect(withState.processes[0].activity.pipeline).toEqual(pipeline);

    const later = reduceEvent(withState, event("agent:activity", { taskId: "t1", agentName: "writer", tool: "write_file" }));
    expect(later.processes[0].activity.pipeline).toEqual(pipeline);
  });
});
