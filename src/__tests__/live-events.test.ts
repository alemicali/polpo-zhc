import { describe, expect, it } from "vitest";
import type { Orchestrator } from "../core/orchestrator.js";
import { TypedEmitter } from "../core/events.js";
import { SSEBridge } from "../server/sse-bridge.js";

describe("live event bridge", () => {
  it("forwards registry, usage, config, and expired schedule events", () => {
    const emitter = new TypedEmitter();
    const bridge = new SSEBridge(emitter as unknown as Orchestrator);
    const received: string[] = [];
    bridge.addClient({
      id: "test",
      send: (event) => received.push(event),
      close: () => undefined,
    });
    bridge.start();

    const timestamp = new Date().toISOString();
    emitter.emit("app:changed", { appId: "app", action: "updated", timestamp });
    emitter.emit("data-source:changed", { sourceId: "source", action: "data", timestamp });
    emitter.emit("data-view:changed", { viewId: "view", action: "created", timestamp });
    emitter.emit("skill:changed", { scope: "agent", action: "indexed", skillName: "reports", timestamp });
    emitter.emit("token-usage:recorded", { timestamp });
    emitter.emit("session:updated", { sessionId: "session", starred: true });
    emitter.emit("session:deleted", { sessionId: "session" });
    emitter.emit("schedule:expired", { scheduleId: "schedule", missionId: "mission" });
    emitter.emit("config:reloaded", { timestamp });

    expect(received).toEqual([
      "app:changed",
      "data-source:changed",
      "data-view:changed",
      "skill:changed",
      "token-usage:recorded",
      "session:updated",
      "session:deleted",
      "schedule:expired",
      "config:reloaded",
    ]);
    bridge.dispose();
  });
});
