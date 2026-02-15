import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypedEmitter } from "../core/events.js";
import { NotificationRouter } from "../notifications/index.js";
import { defaultTitle, defaultBody } from "../notifications/templates.js";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { QualityController } from "../quality/quality-controller.js";
import { HookRegistry } from "../core/hooks.js";
import { InMemoryTaskStore, InMemoryRunStore, createTestTask } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { OrchestraConfig, NotificationsConfig, PlanQualityGate } from "../core/types.js";
import type { NotificationChannel, Notification } from "../notifications/types.js";

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

function createMockCtx(): OrchestratorContext {
  return {
    emitter: new TypedEmitter(),
    registry: new InMemoryTaskStore(),
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

/** Mock channel that captures sent notifications */
class MockChannel implements NotificationChannel {
  readonly type = "mock";
  sent: Notification[] = [];
  async send(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
  async test(): Promise<boolean> { return true; }
}

// ── Template Tests ───────────────────────────────────

describe("Notification Templates — Phase B events", () => {
  describe("defaultTitle", () => {
    it("formats sla:warning", () => {
      const title = defaultTitle({
        event: "sla:warning",
        data: { entityId: "task-1", entityType: "task", percentUsed: 0.85 },
        severity: "warning",
      });
      expect(title).toContain("SLA Warning");
      expect(title).toContain("85%");
    });

    it("formats sla:violated", () => {
      const title = defaultTitle({
        event: "sla:violated",
        data: { entityId: "task-1", entityType: "task" },
        severity: "critical",
      });
      expect(title).toContain("SLA Violated");
      expect(title).toContain("overdue");
    });

    it("formats sla:met", () => {
      const title = defaultTitle({
        event: "sla:met",
        data: { entityId: "task-1", entityType: "task" },
        severity: "info",
      });
      expect(title).toContain("SLA Met");
      expect(title).toContain("on time");
    });

    it("formats quality:gate:passed", () => {
      const title = defaultTitle({
        event: "quality:gate:passed",
        data: { planId: "p1", gateName: "integration-gate" },
        severity: "info",
      });
      expect(title).toContain("Quality Gate Passed");
      expect(title).toContain("integration-gate");
    });

    it("formats quality:gate:failed", () => {
      const title = defaultTitle({
        event: "quality:gate:failed",
        data: { planId: "p1", gateName: "integration-gate", reason: "score too low" },
        severity: "critical",
      });
      expect(title).toContain("Quality Gate Failed");
      expect(title).toContain("integration-gate");
    });

    it("formats quality:threshold:failed", () => {
      const title = defaultTitle({
        event: "quality:threshold:failed",
        data: { planId: "p1", avgScore: 2.5, threshold: 3.5 },
        severity: "critical",
      });
      expect(title).toContain("Quality Below Threshold");
      expect(title).toContain("2.5");
      expect(title).toContain("3.5");
    });

    it("formats schedule:triggered", () => {
      const title = defaultTitle({
        event: "schedule:triggered",
        data: { scheduleId: "s1", planId: "p1", expression: "0 2 * * *" },
        severity: "info",
      });
      expect(title).toContain("Schedule Triggered");
    });

    it("formats schedule:created", () => {
      const title = defaultTitle({
        event: "schedule:created",
        data: { scheduleId: "s1", planId: "p1" },
        severity: "info",
      });
      expect(title).toContain("Schedule Created");
    });

    it("formats schedule:completed", () => {
      const title = defaultTitle({
        event: "schedule:completed",
        data: { scheduleId: "s1", planId: "p1" },
        severity: "info",
      });
      expect(title).toContain("Schedule Completed");
    });
  });

  describe("defaultBody", () => {
    it("formats sla:warning with remaining time", () => {
      const body = defaultBody({
        event: "sla:warning",
        data: { entityId: "task-1", entityType: "task", percentUsed: 0.85, remaining: 30000, deadline: "2026-01-01T00:00:00Z" },
        severity: "warning",
      });
      expect(body).toContain("85%");
      expect(body).toContain("30s");
      expect(body).toContain("task-1");
    });

    it("formats sla:violated with overdue time", () => {
      const body = defaultBody({
        event: "sla:violated",
        data: { entityId: "task-1", entityType: "task", overdueMs: 120000, deadline: "2026-01-01T00:00:00Z" },
        severity: "critical",
      });
      expect(body).toContain("exceeded");
      expect(body).toContain("120s");
    });

    it("formats quality:gate:failed with reason", () => {
      const body = defaultBody({
        event: "quality:gate:failed",
        data: { planId: "p1", gateName: "tests-gate", reason: "avg score 2.0 below threshold 3.5", avgScore: 2.0 },
        severity: "critical",
      });
      expect(body).toContain("tests-gate");
      expect(body).toContain("avg score 2.0 below threshold 3.5");
    });

    it("formats schedule:triggered with expression", () => {
      const body = defaultBody({
        event: "schedule:triggered",
        data: { scheduleId: "s1", planId: "p1", expression: "0 2 * * *" },
        severity: "info",
      });
      expect(body).toContain("0 2 * * *");
      expect(body).toContain("p1");
    });
  });
});

// ── getAllEventNames coverage ─────────────────────────

describe("NotificationRouter — Phase B event subscriptions", () => {
  it("subscribes to sla:* events via glob pattern", () => {
    const emitter = new TypedEmitter();
    const router = new NotificationRouter(emitter);
    const channel = new MockChannel();

    router.init({
      channels: { mock: { type: "webhook", url: "http://test" } },
      rules: [{
        id: "sla-rule",
        name: "SLA events",
        events: ["sla:*"],
        channels: ["mock"],
        severity: "warning",
      }],
    });
    router.registerChannel("mock", channel);
    router.start();

    // Emit an SLA warning
    emitter.emit("sla:warning", {
      entityId: "task-1",
      entityType: "task" as const,
      deadline: "2026-01-01T00:00:00Z",
      elapsed: 90000,
      remaining: 10000,
      percentUsed: 0.9,
    });

    // Give async dispatch a tick
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(channel.sent.length).toBe(1);
        expect(channel.sent[0].sourceEvent).toBe("sla:warning");
        router.dispose();
        resolve();
      }, 10);
    });
  });

  it("subscribes to quality:* events via glob pattern", () => {
    const emitter = new TypedEmitter();
    const router = new NotificationRouter(emitter);
    const channel = new MockChannel();

    router.init({
      channels: { mock: { type: "webhook", url: "http://test" } },
      rules: [{
        id: "quality-rule",
        name: "Quality events",
        events: ["quality:**"],
        channels: ["mock"],
      }],
    });
    router.registerChannel("mock", channel);
    router.start();

    emitter.emit("quality:gate:failed", {
      planId: "p1",
      gateName: "my-gate",
      reason: "score too low",
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(channel.sent.length).toBe(1);
        expect(channel.sent[0].sourceEvent).toBe("quality:gate:failed");
        router.dispose();
        resolve();
      }, 10);
    });
  });

  it("subscribes to schedule:* events via glob pattern", () => {
    const emitter = new TypedEmitter();
    const router = new NotificationRouter(emitter);
    const channel = new MockChannel();

    router.init({
      channels: { mock: { type: "webhook", url: "http://test" } },
      rules: [{
        id: "sched-rule",
        name: "Schedule events",
        events: ["schedule:*"],
        channels: ["mock"],
      }],
    });
    router.registerChannel("mock", channel);
    router.start();

    emitter.emit("schedule:triggered", {
      scheduleId: "s1",
      planId: "p1",
      expression: "0 2 * * *",
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(channel.sent.length).toBe(1);
        router.dispose();
        resolve();
      }, 10);
    });
  });
});

// ── Dynamic Rule Registration ────────────────────────

describe("NotificationRouter — dynamic addRule subscriptions", () => {
  it("addRule after start() subscribes to new event patterns", () => {
    const emitter = new TypedEmitter();
    const router = new NotificationRouter(emitter);
    const channel = new MockChannel();

    router.init({
      channels: { mock: { type: "webhook", url: "http://test" } },
      rules: [],  // no rules initially
    });
    router.registerChannel("mock", channel);
    router.start();

    // Now add a rule dynamically (as SLAMonitor/QualityController would)
    router.addRule({
      id: "dynamic-sla",
      name: "Dynamic SLA rule",
      events: ["sla:warning"],
      channels: ["mock"],
      severity: "warning",
    });

    // Emit the event
    emitter.emit("sla:warning", {
      entityId: "task-1",
      entityType: "task" as const,
      deadline: "2026-01-01T00:00:00Z",
      elapsed: 90000,
      remaining: 10000,
      percentUsed: 0.9,
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(channel.sent.length).toBe(1);
        expect(channel.sent[0].ruleId).toBe("dynamic-sla");
        router.dispose();
        resolve();
      }, 10);
    });
  });
});

// ── SLAMonitor Channel Routing ───────────────────────

describe("SLAMonitor — notification channel routing", () => {
  it("registers dynamic rules for warningChannels and violationChannels", () => {
    const ctx = createMockCtx();
    const router = new NotificationRouter(ctx.emitter);
    const channel = new MockChannel();

    router.init({
      channels: { ops: { type: "webhook", url: "http://test" } },
      rules: [],
    });
    router.registerChannel("ops", channel);
    router.start();

    const monitor = new SLAMonitor(ctx, {
      checkIntervalMs: 0,
      warningChannels: ["ops"],
      violationChannels: ["ops"],
    });
    monitor.setNotificationRouter(router);
    monitor.init();

    // Check that rules were registered
    const rules = router.getRules();
    expect(rules.some(r => r.id === "sla-auto-warning")).toBe(true);
    expect(rules.some(r => r.id === "sla-auto-violated")).toBe(true);
    expect(rules.some(r => r.id === "sla-auto-met")).toBe(true);

    // Now emit an SLA warning and verify it gets dispatched
    ctx.emitter.emit("sla:warning", {
      entityId: "task-1",
      entityType: "task" as const,
      deadline: "2026-01-01T00:00:00Z",
      elapsed: 90000,
      remaining: 10000,
      percentUsed: 0.9,
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(channel.sent.length).toBe(1);
        expect(channel.sent[0].sourceEvent).toBe("sla:warning");
        router.dispose();
        monitor.dispose();
        resolve();
      }, 10);
    });
  });

  it("does not register rules when no channels configured", () => {
    const ctx = createMockCtx();
    const router = new NotificationRouter(ctx.emitter);
    router.init({ channels: {}, rules: [] });
    router.start();

    const monitor = new SLAMonitor(ctx, { checkIntervalMs: 0 });
    monitor.setNotificationRouter(router);
    monitor.init();

    expect(router.getRules().length).toBe(0);
    router.dispose();
    monitor.dispose();
  });
});

// ── QualityController Gate Channel Routing ────────────

describe("QualityController — gate notification channel routing", () => {
  it("registers dynamic rules for gate notifyChannels on first evaluation", () => {
    const ctx = createMockCtx();
    const router = new NotificationRouter(ctx.emitter);
    const channel = new MockChannel();

    router.init({
      channels: { dev: { type: "webhook", url: "http://test" } },
      rules: [],
    });
    router.registerChannel("dev", channel);
    router.start();

    const ctrl = new QualityController(ctx);
    ctrl.setNotificationRouter(router);
    ctrl.init();

    const gate: PlanQualityGate = {
      name: "test-gate",
      afterTasks: ["Task A"],
      blocksTasks: ["Task B"],
      notifyChannels: ["dev"],
      requireAllPassed: true,
    };

    // Evaluate the gate (with a failed task to trigger gate:failed)
    const failedTask = createTestTask({ title: "Task A", status: "failed" });
    ctrl.evaluateGate("plan-1", gate, [failedTask]);

    // Check rules were registered
    const rules = router.getRules();
    expect(rules.some(r => r.id.startsWith("qgate-pass-"))).toBe(true);
    expect(rules.some(r => r.id.startsWith("qgate-fail-"))).toBe(true);

    // The quality:gate:failed event should have been dispatched to the channel
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(channel.sent.length).toBe(1);
        expect(channel.sent[0].sourceEvent).toBe("quality:gate:failed");
        router.dispose();
        ctrl.dispose();
        resolve();
      }, 10);
    });
  });

  it("does not register rules for gates without notifyChannels", () => {
    const ctx = createMockCtx();
    const router = new NotificationRouter(ctx.emitter);
    router.init({ channels: {}, rules: [] });
    router.start();

    const ctrl = new QualityController(ctx);
    ctrl.setNotificationRouter(router);
    ctrl.init();

    const gate: PlanQualityGate = {
      name: "no-notify-gate",
      afterTasks: ["Task A"],
      blocksTasks: ["Task B"],
      // no notifyChannels
    };

    const doneTask = createTestTask({ title: "Task A", status: "done" });
    ctrl.evaluateGate("plan-1", gate, [doneTask]);

    expect(router.getRules().length).toBe(0);
    router.dispose();
    ctrl.dispose();
  });
});
