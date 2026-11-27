import { describe, expect, it, vi } from "vitest";
import { ApprovalManager, HookRegistry } from "@polpo-ai/core";
import type { ApprovalGate, ApprovalRequest, ApprovalStatus } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";

class MemoryApprovalStore {
  rows = new Map<string, ApprovalRequest>();
  async upsert(r: ApprovalRequest) { this.rows.set(r.id, { ...r }); }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : undefined; }
  async list(status?: ApprovalStatus) { return [...this.rows.values()].filter((r) => !status || r.status === status); }
  async listByTask(taskId: string) { return [...this.rows.values()].filter((r) => r.taskId === taskId); }
  async delete(id: string) { return this.rows.delete(id); }
}

function gate(condition: string): ApprovalGate {
  return {
    id: "zone-scrittura",
    name: "Zone scrittura",
    handler: "human",
    hook: "task:complete",
    condition: { expression: condition },
  } as ApprovalGate;
}

function setup() {
  const hooks = new HookRegistry();
  const emitter = new TypedEmitter();
  const store = new MemoryApprovalStore();
  const task = { id: "t1", title: "Scrivi la zona nord", description: "d", revisionCount: 0 };
  const registry = {
    transition: vi.fn(async () => ({})),
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async () => ({})),
  };
  const config = { settings: { approvalGates: [] as ApprovalGate[] } };
  const ctx = { config, emitter, registry, hooks } as never;
  const requested: unknown[] = [];
  emitter.on("approval:requested", (p) => requested.push(p));

  /** What the orchestrator does on a config reload after PUT/DELETE /config/gates/:id. */
  let manager: ApprovalManager | undefined;
  const save = async (gates: ApprovalGate[]) => {
    manager?.dispose();
    config.settings.approvalGates = gates;
    manager = new ApprovalManager(ctx, store as never);
    await manager.init();
    return manager;
  };
  const complete = () => hooks.runBefore("task:complete", { taskId: task.id, task, result: {} } as never);
  const pending = async () => store.list("pending");
  return { hooks, store, save, complete, pending, requested, ctx, config };
}

describe("approval gate saved several times while running", () => {
  it("asks for one approval per completion, not one per save", async () => {
    const s = setup();
    await s.save([gate("task.title.includes('zona')")]);
    await s.save([gate("task.title.includes('zona nord')")]);
    await s.save([gate("task.title.includes('nord')")]);

    expect(s.hooks.list().filter((h) => h.hook === "task:complete")).toHaveLength(1);

    const result = await s.complete();
    expect(result.cancelled).toBe(true);
    expect(await s.pending()).toHaveLength(1);
    expect(s.requested).toHaveLength(1);
  });

  it("replaces the hook even when the previous manager was never disposed", async () => {
    const s = setup();
    s.config.settings.approvalGates = [gate("true")];
    for (let i = 0; i < 3; i++) await new ApprovalManager(s.ctx, s.store as never).init();

    expect(s.hooks.list().filter((h) => h.hook === "task:complete")).toHaveLength(1);
    await s.complete();
    expect(await s.pending()).toHaveLength(1);
  });

  it("uses the latest condition after an update", async () => {
    const s = setup();
    await s.save([gate("task.title.includes('zona')")]);
    await s.save([gate("task.title.includes('altro')")]);

    const result = await s.complete();
    expect(result.cancelled).toBe(false);
    expect(await s.pending()).toHaveLength(0);
  });

  it("stops gating once the gate is deleted", async () => {
    const s = setup();
    await s.save([gate("true")]);
    await s.save([]);

    expect(s.hooks.list()).toHaveLength(0);
    const result = await s.complete();
    expect(result.cancelled).toBe(false);
    expect(await s.pending()).toHaveLength(0);
  });
});

describe("a task completing again while its approval is pending", () => {
  it("stays blocked on the same request instead of adding another", async () => {
    const s = setup();
    await s.save([gate("true")]);

    await s.complete();
    const second = await s.complete();

    const pending = await s.pending();
    expect(pending).toHaveLength(1);
    expect(second.cancelled).toBe(true);
    expect(second.cancelReason).toContain(pending[0].id);
    expect(s.requested).toHaveLength(1);
  });

  it("recognises a request still pending from before a restart", async () => {
    const s = setup();
    await s.save([gate("true")]);
    await s.complete();
    // A fresh manager (restart / reload) reads the pending request back from the store.
    await s.save([gate("true")]);
    await s.complete();

    expect(await s.pending()).toHaveLength(1);
  });

  it("asks again after the request was rejected and the task completes a new revision", async () => {
    const s = setup();
    const manager = await s.save([gate("true")]);
    await s.complete();
    const [first] = await s.pending();
    await manager.reject(first.id, "rifai");

    await s.complete();
    const pending = await s.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(first.id);
  });
});
