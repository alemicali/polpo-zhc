import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENT_CATALOG, POLPO_EVENT_NAMES, HIGH_FREQUENCY_EVENTS } from "@polpo-ai/core";
import { POLPO_EVENT_NAMES as SDK_EVENT_NAMES } from "../../packages/client-sdk/src/client/event-names.js";
import { TypedEmitter } from "../core/events.js";
import { NotificationRouter } from "../notifications/index.js";

/** Event names declared in PolpoEventMap, read from its source (the map is types only). */
function declaredEvents(): string[] {
  const source = readFileSync(join(__dirname, "../../packages/core/src/events.ts"), "utf8");
  const map = source.slice(source.indexOf("export interface PolpoEventMap"), source.indexOf("export type PolpoEvent"));
  return [...map.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]!);
}

describe("event catalog", () => {
  it("has one entry per declared event, and nothing else", () => {
    expect([...POLPO_EVENT_NAMES].sort()).toEqual([...new Set(declaredEvents())].sort());
    expect(new Set(POLPO_EVENT_NAMES).size).toBe(POLPO_EVENT_NAMES.length);
  });

  it("gives every event a label, a description and a category", () => {
    for (const def of HOOK_EVENT_CATALOG) {
      expect(def.label, def.name).toBeTruthy();
      expect(def.description, def.name).toBeTruthy();
      expect(def.category, def.name).toBeTruthy();
    }
  });

  it("the browser SDK listens to the whole bus", () => {
    expect([...SDK_EVENT_NAMES].sort()).toEqual([...POLPO_EVENT_NAMES].sort());
  });

  it("streams the whole bus over SSE", () => {
    const source = readFileSync(join(__dirname, "../server/sse-bridge.ts"), "utf8");
    expect(source).toContain("const ALL_EVENTS: PolpoEvent[] = POLPO_EVENT_NAMES;");
  });
});

describe("notification rules over the whole bus", () => {
  function routerWith(events: string[]) {
    const emitter = new TypedEmitter();
    const router = new NotificationRouter(emitter);
    const fired: string[] = [];
    (router as unknown as { handleEvent: (event: string) => void }).handleEvent = (event: string) => { fired.push(event); };
    router.init({ channels: {}, rules: [{ id: "r", name: "r", events, channels: [] }] });
    router.start();
    return { emitter, fired };
  }

  it("a glob reaches events that were missing from the old list", () => {
    const { emitter, fired } = routerWith(["room:*", "peer:*", "file:*"]);
    emitter.emit("room:deleted", { roomId: "g1" });
    emitter.emit("peer:blocked", { peerId: "telegram:1", channel: "telegram", reason: "policy" });
    emitter.emit("file:changed", { path: "a.txt", dir: ".", action: "created", source: "agent" });
    expect(fired).toEqual(["room:deleted", "peer:blocked", "file:changed"]);
  });

  it("globs skip high-frequency events; naming them exactly still works", () => {
    expect(HIGH_FREQUENCY_EVENTS.has("orchestrator:tick")).toBe(true);
    const star = routerWith(["*"]);
    star.emitter.emit("orchestrator:tick", { pending: 0, running: 0, done: 0, failed: 0, queued: 0 });
    star.emitter.emit("room:typing", { roomId: "g1", agent: "a", name: "A", typing: true });
    star.emitter.emit("task:removed", { taskId: "t1" });
    expect(star.fired).toEqual(["task:removed"]);

    const exact = routerWith(["room:typing"]);
    exact.emitter.emit("room:typing", { roomId: "g1", agent: "a", name: "A", typing: true });
    expect(exact.fired).toEqual(["room:typing"]);
  });
});
