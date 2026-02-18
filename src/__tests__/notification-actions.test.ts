import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationRouter } from "../notifications/index.js";
import { TypedEmitter } from "../core/events.js";
import type { NotificationRule, NotificationAction } from "../core/types.js";

describe("NotificationRouter — action triggers", () => {
  let emitter: TypedEmitter;
  let router: NotificationRouter;
  let actionExecutor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitter = new TypedEmitter();
    router = new NotificationRouter(emitter);
    actionExecutor = vi.fn().mockResolvedValue("ok");
    router.setActionExecutor(actionExecutor);

    // Init with a dummy channel
    router.init({
      channels: {},
      rules: [],
    });
  });

  // ── addRule / removeRule ──

  it("adds a rule programmatically", () => {
    router.addRule({
      id: "test-rule",
      name: "Test Rule",
      events: ["task:transition"],
      channels: [],
    });

    const rules = router.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("test-rule");
  });

  it("removes a rule by ID", () => {
    router.addRule({
      id: "test-rule",
      name: "Test Rule",
      events: ["task:transition"],
      channels: [],
    });

    expect(router.removeRule("test-rule")).toBe(true);
    expect(router.getRules()).toHaveLength(0);
  });

  it("removeRule returns false for non-existent rule", () => {
    expect(router.removeRule("nope")).toBe(false);
  });

  // ── Action triggers ──

  it("executes actions when a rule fires", async () => {
    const action: NotificationAction = {
      type: "create_task",
      title: "Triggered task",
      description: "Auto-created",
      assignTo: "agent-1",
    };

    router.addRule({
      id: "action-rule",
      name: "Action Rule",
      events: ["task:transition"],
      channels: [],
      actions: [action],
    });
    router.start();

    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "done",
      task: {} as any,
    });

    // Allow async action execution
    await vi.waitFor(() => {
      expect(actionExecutor).toHaveBeenCalledWith(action);
    });
  });

  it("executes multiple actions for one rule", async () => {
    const action1: NotificationAction = { type: "run_script", command: "echo 1" };
    const action2: NotificationAction = {
      type: "send_notification",
      channel: "slack",
      title: "Done",
      body: "Task completed",
    };

    router.addRule({
      id: "multi-action",
      name: "Multi Action",
      events: ["plan:completed"],
      channels: [],
      actions: [action1, action2],
    });
    router.start();

    emitter.emit("plan:completed", {
      planId: "p1",
      group: "g1",
      allPassed: true,
      report: {} as any,
    });

    await vi.waitFor(() => {
      expect(actionExecutor).toHaveBeenCalledTimes(2);
      expect(actionExecutor).toHaveBeenCalledWith(action1);
      expect(actionExecutor).toHaveBeenCalledWith(action2);
    });
  });

  it("does NOT execute actions when condition fails", () => {
    router.addRule({
      id: "cond-rule",
      name: "Conditional Rule",
      events: ["task:transition"],
      channels: [],
      condition: { field: "to", op: "==", value: "failed" },
      actions: [{ type: "run_script", command: "echo fail" }],
    });
    router.start();

    // Emit with to=done (condition wants to=failed)
    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "done",
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
  });

  it("executes actions when condition passes", async () => {
    const action: NotificationAction = { type: "run_script", command: "echo fail" };

    router.addRule({
      id: "cond-rule",
      name: "Conditional Rule",
      events: ["task:transition"],
      channels: [],
      condition: { field: "to", op: "==", value: "failed" },
      actions: [action],
    });
    router.start();

    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "failed",
      task: {} as any,
    });

    await vi.waitFor(() => {
      expect(actionExecutor).toHaveBeenCalledWith(action);
    });
  });

  it("emits action:triggered on success", async () => {
    const listener = vi.fn();
    emitter.on("action:triggered", listener);

    router.addRule({
      id: "trigger-rule",
      name: "Trigger Rule",
      events: ["task:transition"],
      channels: [],
      actions: [{ type: "run_script", command: "echo ok" }],
    });
    router.start();

    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "done",
      task: {} as any,
    });

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        ruleId: "trigger-rule",
        actionType: "run_script",
        result: "ok",
      }));
    });
  });

  it("emits action:triggered with error on failure", async () => {
    actionExecutor.mockRejectedValueOnce(new Error("script failed"));

    const listener = vi.fn();
    emitter.on("action:triggered", listener);

    router.addRule({
      id: "fail-rule",
      name: "Fail Rule",
      events: ["task:transition"],
      channels: [],
      actions: [{ type: "run_script", command: "exit 1" }],
    });
    router.start();

    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "done",
      task: {} as any,
    });

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        ruleId: "fail-rule",
        actionType: "run_script",
        error: "script failed",
      }));
    });
  });

  it("respects cooldown for action triggers", () => {
    router.addRule({
      id: "cool-rule",
      name: "Cooldown Rule",
      events: ["task:transition"],
      channels: [],
      cooldownMs: 60_000, // 60s cooldown
      actions: [{ type: "run_script", command: "echo once" }],
    });
    router.start();

    // First fire
    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "done",
      task: {} as any,
    });

    // Second fire (within cooldown)
    emitter.emit("task:transition", {
      taskId: "t2",
      from: "review",
      to: "done",
      task: {} as any,
    });

    expect(actionExecutor).toHaveBeenCalledTimes(1);
  });

  // ── Rules without actions ──

  it("rules without actions don't call executor", () => {
    router.addRule({
      id: "no-action",
      name: "No Action",
      events: ["task:transition"],
      channels: [],
      // No actions
    });
    router.start();

    emitter.emit("task:transition", {
      taskId: "t1",
      from: "review",
      to: "done",
      task: {} as any,
    });

    expect(actionExecutor).not.toHaveBeenCalled();
  });

  // ── Glob patterns ──

  it("supports glob event patterns for actions", async () => {
    const action: NotificationAction = { type: "run_script", command: "echo glob" };

    router.addRule({
      id: "glob-rule",
      name: "Glob Rule",
      events: ["task:*"],
      channels: [],
      actions: [action],
    });
    router.start();

    emitter.emit("task:created", {
      task: {} as any,
    });

    await vi.waitFor(() => {
      expect(actionExecutor).toHaveBeenCalledWith(action);
    });
  });
});
