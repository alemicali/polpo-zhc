import { describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "@polpo-ai/core";
import type { ApprovalRequest, ApprovalStatus } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";

class MemoryApprovalStore {
  rows = new Map<string, ApprovalRequest>();
  async upsert(r: ApprovalRequest) { this.rows.set(r.id, { ...r }); }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : undefined; }
  async list(status?: ApprovalStatus) { return [...this.rows.values()].filter((r) => !status || r.status === status); }
  async listByTask(taskId: string) { return [...this.rows.values()].filter((r) => r.taskId === taskId); }
  async delete(id: string) { return this.rows.delete(id); }
}

describe("approvals asked by the system (escalation)", () => {
  it("are stored, announced, and approving one moves the task on", async () => {
    const emitter = new TypedEmitter();
    const transition = vi.fn(async () => ({}));
    const ctx = { config: { settings: {} }, emitter, registry: { transition } } as never;
    const store = new MemoryApprovalStore();
    const manager = new ApprovalManager(ctx, store as never);
    const requested: unknown[] = [];
    emitter.on("approval:requested", (p) => requested.push(p));

    const request = await manager.requestHumanApproval({ gateId: "escalation", gateName: "Escalation: Report", taskId: "t1" });

    expect(store.rows.get(request.id)?.status).toBe("pending");
    expect(requested).toEqual([{ requestId: request.id, gateId: "escalation", gateName: "Escalation: Report", taskId: "t1", missionId: undefined }]);
    expect((await manager.getPending()).map((r) => r.id)).toEqual([request.id]);

    const resolved = await manager.approve(request.id, "telegram:42");
    expect(resolved?.status).toBe("approved");
    expect(transition).toHaveBeenCalledWith("t1", "assigned");
  });
});
