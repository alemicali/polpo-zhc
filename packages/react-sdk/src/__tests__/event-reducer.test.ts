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
