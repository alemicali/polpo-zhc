import { afterEach, expect, test, vi } from "vitest";
import { EventSourceManager } from "@polpo-ai/sdk";

afterEach(() => vi.unstubAllGlobals());

test("the browser SDK forwards named chat events used for cross-device reconciliation", () => {
  let source: EventTarget;
  class MockEventSource extends EventTarget {
    constructor() { super(); source = this; }
    close() {}
  }
  vi.stubGlobal("EventSource", MockEventSource);
  const onEvent = vi.fn();
  const manager = new EventSourceManager({ url: "http://localhost/events", onEvent, onStatusChange: () => {} });
  manager.connect();
  const names = ["session:created", "session:updated", "session:deleted", "message:added",
    "chat:turn-started", "chat:queue-updated",
    "background-wait:completed", "background-wait:failed", "background-wait:cancelled"];
  for (const name of names) {
    source!.dispatchEvent(new MessageEvent(name, { data: JSON.stringify({ sessionId: "qa" }), lastEventId: name }));
  }
  expect(onEvent.mock.calls.map(([event]) => event.event)).toEqual(names);
  expect(onEvent.mock.calls[3][0]).toMatchObject({ id: "message:added", data: { sessionId: "qa" } });
  manager.disconnect();
});
