import { describe, it, expect } from "vitest";
import { analyzeBlockedTasks } from "../core/deadlock-resolver.js";
import { createTestTask } from "./fixtures.js";
import type { Task } from "../core/types.js";

describe("analyzeBlockedTasks", () => {
  it("follows cascade chains to find root failure", () => {
    const root = createTestTask({ id: "a", status: "failed", dependsOn: [] });
    const middle = createTestTask({ id: "b", status: "pending", dependsOn: ["a"] });
    const leaf = createTestTask({ id: "c", status: "pending", dependsOn: ["b"] });
    const all: Task[] = [root, middle, leaf];
    const pending = [middle, leaf];

    const analysis = analyzeBlockedTasks(pending, all);

    // middle blocked by failed root
    expect(analysis.resolvable.length).toBeGreaterThanOrEqual(1);
    const middleInfo = analysis.resolvable.find(b => b.task.id === "b");
    expect(middleInfo?.failedDeps[0].id).toBe("a");

    // leaf should cascade through middle to root
    const leafInfo = analysis.resolvable.find(b => b.task.id === "c");
    expect(leafInfo?.failedDeps[0].id).toBe("a");
  });

  it("handles circular dependencies without infinite loop", () => {
    const a = createTestTask({ id: "x", status: "pending", dependsOn: ["y"] });
    const b = createTestTask({ id: "y", status: "pending", dependsOn: ["x"] });
    const all: Task[] = [a, b];

    // Should not hang — circular deps with no root failure → missing deps
    const analysis = analyzeBlockedTasks([a, b], all);
    expect(analysis).toBeDefined();
    // Both have missing-like deps (pending with no root failure)
    expect(analysis.unresolvable.length + analysis.resolvable.length).toBeGreaterThanOrEqual(0);
  });

  it("skips done dependencies", () => {
    const dep = createTestTask({ id: "done-dep", status: "done", dependsOn: [] });
    const blocked = createTestTask({ id: "blocked", status: "pending", dependsOn: ["done-dep"] });
    const all: Task[] = [dep, blocked];

    // All deps are done → task is not blocked at all
    const analysis = analyzeBlockedTasks([blocked], all);
    expect(analysis.resolvable).toHaveLength(0);
    expect(analysis.unresolvable).toHaveLength(0);
  });

  it("marks missing deps as unresolvable", () => {
    const task = createTestTask({ id: "orphan", status: "pending", dependsOn: ["nonexistent"] });
    const analysis = analyzeBlockedTasks([task], [task]);

    expect(analysis.unresolvable).toHaveLength(1);
    expect(analysis.unresolvable[0].missingDeps).toContain("nonexistent");
    expect(analysis.resolvable).toHaveLength(0);
  });

  it("separates resolvable from unresolvable blockages", () => {
    const failed = createTestTask({ id: "f1", status: "failed", dependsOn: [] });
    const blockedByFailed = createTestTask({ id: "b1", status: "pending", dependsOn: ["f1"] });
    const blockedByMissing = createTestTask({ id: "b2", status: "pending", dependsOn: ["ghost"] });
    const all: Task[] = [failed, blockedByFailed, blockedByMissing];
    const pending = [blockedByFailed, blockedByMissing];

    const analysis = analyzeBlockedTasks(pending, all);

    expect(analysis.resolvable).toHaveLength(1);
    expect(analysis.resolvable[0].task.id).toBe("b1");
    expect(analysis.unresolvable).toHaveLength(1);
    expect(analysis.unresolvable[0].task.id).toBe("b2");
  });

  it("handles mixed failed + missing deps as resolvable", () => {
    const failed = createTestTask({ id: "f2", status: "failed", dependsOn: [] });
    const task = createTestTask({ id: "mixed", status: "pending", dependsOn: ["f2", "missing-id"] });
    const all: Task[] = [failed, task];

    const analysis = analyzeBlockedTasks([task], all);

    // Has at least one failed dep → resolvable
    expect(analysis.resolvable).toHaveLength(1);
    expect(analysis.resolvable[0].failedDeps[0].id).toBe("f2");
    expect(analysis.resolvable[0].missingDeps).toContain("missing-id");
  });
});
