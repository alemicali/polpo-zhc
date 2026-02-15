import { describe, it, expect } from "vitest";
import { registerAdapter, getAdapter, createActivity } from "../adapters/registry.js";
import type { AgentAdapter, AgentHandle } from "../core/adapter.js";
import type { AgentConfig, Task } from "../core/types.js";

// Create a minimal mock adapter for testing
function makeMock(name: string): AgentAdapter {
  return {
    name,
    spawn(_agent: AgentConfig, _task: Task, _cwd: string): AgentHandle {
      throw new Error("not implemented in test");
    },
  };
}

describe("adapter-registry", () => {
  // Note: registry is global module state, registrations persist.
  // External adapters (e.g. "claude-sdk") register via side-effect imports.

  it("registerAdapter + getAdapter returns correct instance", () => {
    registerAdapter("test-adapter", () => makeMock("test-adapter"));
    const adapter = getAdapter("test-adapter");
    expect(adapter.name).toBe("test-adapter");
  });

  it("getAdapter throws for unknown adapter", () => {
    expect(() => getAdapter("nonexistent-adapter-xyz"))
      .toThrow(/Unknown adapter: "nonexistent-adapter-xyz"/);
  });

  it("getAdapter error message lists available adapters", () => {
    registerAdapter("list-test", () => makeMock("list-test"));
    try {
      getAdapter("nope");
    } catch (err: any) {
      expect(err.message).toContain("Available:");
      expect(err.message).toContain("list-test");
    }
  });

  it("registerAdapter overwrites existing registration", () => {
    registerAdapter("overwrite-test", () => makeMock("first"));
    registerAdapter("overwrite-test", () => makeMock("second"));
    const adapter = getAdapter("overwrite-test");
    expect(adapter.name).toBe("second");
  });

  it("getAdapter creates a new instance each time (factory pattern)", () => {
    let count = 0;
    registerAdapter("factory-test", () => {
      count++;
      return makeMock("factory-" + count);
    });
    const a1 = getAdapter("factory-test");
    const a2 = getAdapter("factory-test");
    expect(a1.name).toBe("factory-1");
    expect(a2.name).toBe("factory-2");
  });

  describe("createActivity", () => {
    it("returns a fresh activity with empty arrays and zero counts", () => {
      const activity = createActivity();
      expect(activity.filesCreated).toEqual([]);
      expect(activity.filesEdited).toEqual([]);
      expect(activity.toolCalls).toBe(0);
      expect(activity.lastUpdate).toBeDefined();
    });

    it("returns independent objects", () => {
      const a1 = createActivity();
      const a2 = createActivity();
      a1.filesCreated.push("test.ts");
      expect(a2.filesCreated).toEqual([]);
    });
  });
});
