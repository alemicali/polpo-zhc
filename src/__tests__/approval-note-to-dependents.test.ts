/**
 * An approval gate's resolution reaches the tasks that depend on the gated task: the outcome, the
 * note the person wrote (the decision), who resolved it and when. Seen live (sitoinchat,
 * 2026-11-27): "Ranking: scelta di Alessio" depended on the gated "Ranking: proposta", had to apply
 * the choice written in the gate note, and found no note in its context.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalManager, HookRegistry, TaskRunner, describeApproval, latestApprovalResolution, renderDependencyResults, renderTaskResult, taskApprovals,
} from "@polpo-ai/core";
import type { ApprovalGate, ApprovalRequest, ApprovalStatus } from "@polpo-ai/core";
import type { Task } from "../core/types.js";
import { TypedEmitter } from "../core/events.js";
import { createTestTask } from "./fixtures.js";

class MemoryApprovalStore {
  rows = new Map<string, ApprovalRequest>();
  async upsert(r: ApprovalRequest) { this.rows.set(r.id, { ...r }); }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : undefined; }
  async list(status?: ApprovalStatus) { return [...this.rows.values()].filter((r) => !status || r.status === status); }
  async listByTask(taskId: string) { return [...this.rows.values()].filter((r) => r.taskId === taskId); }
  async delete(id: string) { return this.rows.delete(id); }
}

const NOTE = "Studio Ionio 3 → scartato; da verificare restano da valutare Villa Aurora e Corte dei Mille";

const gate: ApprovalGate = { id: "ranking-scelta", name: "ranking-scelta", handler: "human", hook: "task:complete" } as ApprovalGate;

/** The live shape: the gated proposal, and the choice that depends on it. */
function liveTasks(): { proposta: Task; scelta: Task } {
  const proposta = createTestTask({
    id: "t-proposta", title: "Ranking: proposta", assignTo: "ranker", status: "awaiting_approval" as never,
    result: { exitCode: 0, stdout: "1. Villa Aurora\n2. Studio Ionio 3\n3. Corte dei Mille", stderr: "", duration: 1_000 },
  });
  const scelta = createTestTask({
    id: "t-scelta", title: "Ranking: scelta di Alessio", assignTo: "ranker", status: "pending",
    dependsOn: [proposta.id], description: "Apply exactly the choice in the gate note.",
  });
  return { proposta, scelta };
}

/** Just enough of the orchestrator: the approval manager and the runner share the approval store. */
function orchestrator(tasks: Task[]) {
  const spawned: any[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const hooks = new HookRegistry();
  const store = new MemoryApprovalStore();
  const registry = {
    transition: vi.fn(async (id: string, to: string) => { byId.get(id)!.status = to as never; }),
    updateTask: vi.fn(async (id: string, patch: any) => Object.assign(byId.get(id)!, patch)),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    getAllTasks: async () => tasks,
    setState: async () => {},
  };
  const ctx = {
    emitter: new TypedEmitter(),
    polpoDir: "/tmp/polpo-test",
    agentWorkDir: "/tmp/polpo-test/work",
    config: { project: "p", settings: { approvalGates: [gate] } },
    hooks,
    approvalStore: store,
    agentStore: { getAgent: async () => ({ name: "ranker" }) },
    memoryStore: { get: async () => "" },
    sandboxProviders: () => new Set(["local"]),
    spawner: { spawn: async (c: any) => { spawned.push(c); return { pid: 4242, configPath: "/tmp/c.json" }; }, isAlive: () => true, kill: () => {} },
    runStore: { upsertRun: async () => {}, getActiveRuns: async () => [], getTerminalRuns: async () => [], deleteRun: async () => {} },
    taskControlStore: { listDirections: async () => [] },
    registry,
  } as never;
  const approvals = new ApprovalManager(ctx, store as never);
  return { runner: new TaskRunner(ctx), approvals, store, hooks, spawned };
}

/** The gate asks a person when the proposal completes. */
async function gated(o: ReturnType<typeof orchestrator>, proposta: Task): Promise<string> {
  await o.approvals.init();
  const r = await o.hooks.runBefore("task:complete", { taskId: proposta.id, task: proposta, result: proposta.result } as never);
  expect(r.cancelled).toBe(true);
  const [pending] = await o.store.list("pending");
  return pending.id;
}

describe("approval resolution reaches the dependent tasks", () => {
  it("approved with a note: the dependent task's prompt holds the note, the approver and when", async () => {
    const { proposta, scelta } = liveTasks();
    const o = orchestrator([proposta, scelta]);
    const id = await gated(o, proposta);
    await o.approvals.approve(id, "alessio@polpo.sh", NOTE);
    expect(proposta.status).toBe("done");

    await o.runner.spawnForTask(scelta);
    const desc: string = o.spawned[0].task.description;
    const section = desc.slice(desc.indexOf("<dependency-results>"), desc.indexOf("</dependency-results>"));
    expect(section).toContain(NOTE);
    expect(section).toContain('Approval gate "ranking-scelta": approved by alessio@polpo.sh at ');
    expect(section).toContain("Approver's note");
    // the proposal's result is still there, and the note sits under the proposal's heading
    expect(section).toContain("Studio Ionio 3");
    expect(section.indexOf(NOTE)).toBeGreaterThan(section.indexOf('"Ranking: proposta"'));
  });

  it("a long note is never cut away by the dependency results budget", () => {
    const { proposta } = liveTasks();
    proposta.status = "done";
    proposta.result!.stdout = "x".repeat(20_000);
    const approvals = new Map([[proposta.id, [{
      requestId: "r1", gateId: "g", gateName: "ranking-scelta", status: "approved" as const,
      note: `${NOTE} ${"dettaglio ".repeat(150)}`.trim(), resolvedBy: "alessio", requestedAt: "2026-11-27T09:00:00Z", resolvedAt: "2026-11-27T10:00:00Z",
    }]]]);
    const section = renderDependencyResults([proposta], { perTaskChars: 500, totalChars: 1_000, approvals });
    expect(section).toContain(NOTE);
    expect(section).toContain("dettaglio dettaglio");
    expect(section).toContain("…[truncated]"); // the result was cut, not the note
  });

  it("approved without a note: the outcome and the approver, no empty note section", async () => {
    const { proposta, scelta } = liveTasks();
    const o = orchestrator([proposta, scelta]);
    const id = await gated(o, proposta);
    await o.approvals.approve(id, "alessio");

    await o.runner.spawnForTask(scelta);
    const desc: string = o.spawned[0].task.description;
    expect(desc).toContain('Approval gate "ranking-scelta": approved by alessio');
    expect(desc).not.toContain("Approver's note");
    expect(desc).not.toMatch(/Note:\s*$/m);
    expect(desc).not.toContain("<approval>");
  });

  it("a dependency that never met a gate: no approval line", () => {
    const { proposta } = liveTasks();
    proposta.status = "done";
    expect(renderDependencyResults([proposta])).not.toContain("Approval gate");
    expect(renderDependencyResults([proposta], { approvals: new Map() })).not.toContain("Approval gate");
  });

  it("rejection: the feedback still goes to the gated task's description and it runs again", async () => {
    const { proposta, scelta } = liveTasks();
    const o = orchestrator([proposta, scelta]);
    const id = await gated(o, proposta);
    const rejected = await o.approvals.reject(id, "Manca Villa Aurora", "alessio");
    expect(rejected?.status).toBe("rejected");
    expect(proposta.description).toContain("**Rejection #1 feedback:** Manca Villa Aurora");
    expect(proposta.revisionCount).toBe(1);
    expect(proposta.status).toBe("pending");

    // its own re-run gets the feedback once (in the description), not a second <approval> block
    await o.runner.spawnForTask(proposta);
    const desc: string = o.spawned[0].task.description;
    expect(desc.match(/Manca Villa Aurora/g)).toHaveLength(1);
    expect(desc).not.toContain("<approval>");
  });

  it("the gated task's own run after an approval with a note gets the note", async () => {
    const { proposta } = liveTasks();
    proposta.status = "pending";
    const o = orchestrator([proposta]);
    await o.store.upsert({
      id: "r1", gateId: "before-spawn", gateName: "Prima di partire", taskId: proposta.id, status: "approved",
      payload: null, requestedAt: "2026-11-27T09:00:00Z", resolvedAt: "2026-11-27T09:05:00Z", resolvedBy: "alessio", note: "Usa solo fonti ufficiali",
    });
    await o.runner.spawnForTask(proposta);
    const desc: string = o.spawned[0].task.description;
    expect(desc).toContain("<approval>");
    expect(desc).toContain("Usa solo fonti ufficiali");
    expect(desc).toContain("approved by alessio at 2026-11-27T09:05:00Z");
  });
});

describe("approval helpers", () => {
  const req = (over: Partial<ApprovalRequest>): ApprovalRequest => ({
    id: "r", gateId: "g", gateName: "G", taskId: "t", status: "pending", payload: { big: true }, requestedAt: "2026-11-27T09:00:00Z", ...over,
  });

  it("taskApprovals drops the payload, keeps the resolution, oldest first", () => {
    const list = taskApprovals([
      req({ id: "b", requestedAt: "2026-11-27T10:00:00Z", status: "approved", note: "  ok  ", resolvedBy: "a", resolvedAt: "2026-11-27T10:01:00Z" }),
      req({ id: "a", status: "rejected", note: "no", resolvedAt: "2026-11-27T09:01:00Z" }),
    ]);
    expect(list.map((a) => a.requestId)).toEqual(["a", "b"]);
    expect(list[1]).toEqual({ requestId: "b", gateId: "g", gateName: "G", status: "approved", note: "ok", resolvedBy: "a", requestedAt: "2026-11-27T10:00:00Z", resolvedAt: "2026-11-27T10:01:00Z" });
    expect("payload" in list[0]).toBe(false);
  });

  it("the latest resolution wins; pending requests are not a resolution", () => {
    const list = taskApprovals([
      req({ id: "a", status: "rejected", note: "no", resolvedAt: "2026-11-27T09:01:00Z" }),
      req({ id: "b", requestedAt: "2026-11-27T10:00:00Z", status: "approved", resolvedAt: "2026-11-27T10:01:00Z" }),
      req({ id: "c", requestedAt: "2026-11-27T11:00:00Z" }),
    ]);
    expect(latestApprovalResolution(list)?.requestId).toBe("b");
    expect(latestApprovalResolution(taskApprovals([req({})]))).toBeUndefined();
    expect(describeApproval(list[0])).toBe('Approval gate "G": rejected at 2026-11-27T09:01:00Z\nNote:\nno');
  });

  it("task_result shows the approval too", () => {
    const { proposta } = liveTasks();
    const text = renderTaskResult(proposta, { approvals: taskApprovals([req({ taskId: proposta.id, status: "approved", note: NOTE, resolvedBy: "alessio", resolvedAt: "2026-11-27T10:00:00Z" })]) });
    expect(text).toContain(NOTE);
  });
});
