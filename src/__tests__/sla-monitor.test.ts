import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { OrchestraConfig, Task, Plan } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────

function createMinimalConfig(): OrchestraConfig {
  return {
    version: "1",
    project: "test",
    team: { name: "test-team", agents: [{ name: "test-agent" }] },
    tasks: [],
    settings: { maxRetries: 2, workDir: "/tmp/test", logLevel: "quiet" },
  };
}

function createMockCtx(store?: InMemoryTaskStore): OrchestratorContext {
  return {
    emitter: new TypedEmitter(),
    registry: store ?? new InMemoryTaskStore(),
    runStore: new InMemoryRunStore(),
    memoryStore: { exists: () => false, get: () => "", save: () => {}, append: () => {} },
    logStore: { startSession: () => "s", getSessionId: () => "s", append: () => {}, getSessionEntries: () => [], listSessions: () => [], prune: () => 0, close: () => {} },
    sessionStore: { create: () => "s1", addMessage: () => ({ id: "m1", role: "user" as const, content: "", ts: "" }), getMessages: () => [], getRecentMessages: () => [], listSessions: () => [], getSession: () => undefined, getLatestSession: () => undefined, deleteSession: () => false, prune: () => 0, close: () => {} },
    hooks: new HookRegistry(),
    config: createMinimalConfig(),
    workDir: "/tmp/test",
    polpoDir: "/tmp/test/.polpo",
    assessFn: vi.fn(),
  };
}

describe("SLAMonitor", () => {
  let ctx: OrchestratorContext;
  let store: InMemoryTaskStore;
  let monitor: SLAMonitor;

  beforeEach(() => {
    store = new InMemoryTaskStore();
    ctx = createMockCtx(store);
    monitor = new SLAMonitor(ctx, {
      warningThreshold: 0.8,
      checkIntervalMs: 0, // no throttle in tests
    });
    monitor.init();
  });

  afterEach(() => {
    monitor.dispose();
  });

  it("emits sla:warning when threshold is reached", () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    // Task created 100 seconds ago, deadline 10 seconds from now
    // percentUsed = 100 / (100+10) = 0.909 > 0.8
    const createdAt = new Date(Date.now() - 100_000).toISOString();
    const deadline = new Date(Date.now() + 10_000).toISOString();

    store.addTask({
      title: "Urgent task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    // Override createdAt
    const task = store.getAllTasks()[0];
    (task as any).createdAt = createdAt;

    monitor.check();

    expect(emitSpy).toHaveBeenCalledWith("sla:warning", expect.objectContaining({
      entityType: "task",
      deadline,
    }));
  });

  it("emits sla:violated when deadline passes", () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const createdAt = new Date(Date.now() - 100_000).toISOString();
    const deadline = new Date(Date.now() - 1_000).toISOString(); // already past

    store.addTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = store.getAllTasks()[0];
    (task as any).createdAt = createdAt;

    monitor.check();

    expect(emitSpy).toHaveBeenCalledWith("sla:violated", expect.objectContaining({
      entityType: "task",
      deadline,
    }));
  });

  it("does not re-emit for the same entity", () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const deadline = new Date(Date.now() - 1_000).toISOString();
    store.addTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = store.getAllTasks()[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();

    monitor.check();
    monitor.check();

    const violationCalls = emitSpy.mock.calls.filter(c => c[0] === "sla:violated");
    expect(violationCalls.length).toBe(1);
  });

  it("skips terminal tasks", () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const deadline = new Date(Date.now() - 1_000).toISOString();
    store.addTask({
      title: "Done task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = store.getAllTasks()[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();

    // Transition to done
    store.transition(task.id, "assigned");
    store.transition(task.id, "in_progress");
    store.transition(task.id, "review");
    store.transition(task.id, "done");

    monitor.check();

    const violationCalls = emitSpy.mock.calls.filter(c => c[0] === "sla:violated");
    expect(violationCalls.length).toBe(0);
  });

  it("emits sla:met when task completes before deadline", async () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");
    const deadline = new Date(Date.now() + 60_000).toISOString();

    const task = createTestTask({ id: "t1", deadline });

    await ctx.hooks.runAfter("task:complete", {
      taskId: "t1",
      task,
    });

    expect(emitSpy).toHaveBeenCalledWith("sla:met", expect.objectContaining({
      entityId: "t1",
      entityType: "task",
      deadline,
    }));
  });

  it("force-fails tasks when violationAction is 'fail'", () => {
    const failMonitor = new SLAMonitor(ctx, {
      checkIntervalMs: 0,
      violationAction: "fail",
    });
    failMonitor.init();

    const deadline = new Date(Date.now() - 1_000).toISOString();
    store.addTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = store.getAllTasks()[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();
    // Move task to in_progress (so unsafeSetStatus to failed works meaningfully)
    store.transition(task.id, "assigned");
    store.transition(task.id, "in_progress");

    failMonitor.check();

    expect(store.getTask(task.id)!.status).toBe("failed");
    failMonitor.dispose();
  });

  it("clearEntity resets tracking for an entity", () => {
    const emitSpy = vi.spyOn(ctx.emitter, "emit");

    const deadline = new Date(Date.now() - 1_000).toISOString();
    store.addTask({
      title: "Overdue task",
      description: "Test",
      assignTo: "test-agent",
      dependsOn: [],
      expectations: [],
      metrics: [],
      maxRetries: 2,
      deadline,
    });
    const task = store.getAllTasks()[0];
    (task as any).createdAt = new Date(Date.now() - 100_000).toISOString();

    monitor.check();
    const callsBefore = emitSpy.mock.calls.filter(c => c[0] === "sla:violated").length;

    monitor.clearEntity(task.id);
    monitor.check();

    const callsAfter = emitSpy.mock.calls.filter(c => c[0] === "sla:violated").length;
    expect(callsAfter).toBe(callsBefore + 1);
  });
});
