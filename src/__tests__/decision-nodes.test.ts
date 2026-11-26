/**
 * Mission (and playbook) decision nodes in the mission executor: the branch tasks wait for the
 * decision, which starts once the after tasks finished; the chosen branch goes on (the decision in
 * its tasks' description), the other branches and the tasks that only depend on them are skipped;
 * an uncertain answer (or a failed decision) waits for a person at a checkpoint (resume takes the
 * suggestion, or a person picks a branch) or takes the onUncertain branch. Documents without
 * decisions are unchanged.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionExecutor } from "../core/mission-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createMockStores } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { Mission, PolpoConfig, Task } from "../core/types.js";
import type { DecisionAnswer, MissionDecider } from "@polpo-ai/core";
import { FileCheckpointStore } from "../stores/file-checkpoint-store.js";
import { FileDelayStore } from "../stores/file-delay-store.js";
import { FileDecisionNodeStore } from "../stores/file-decision-node-store.js";
import { instantiatePlaybook, validatePlaybookDefinition } from "../core/playbook.js";

function makeCtx(dir: string): OrchestratorContext {
  const store = new InMemoryTaskStore();
  const missions = new Map<string, Mission>();
  let n = 0;
  const registry = Object.assign(store, {
    saveMission: async (o: { name: string; data: string; status?: string }) => {
      const m: Mission = { id: `mission-${++n}`, name: o.name, data: o.data, status: (o.status as Mission["status"]) ?? "draft", createdAt: "", updatedAt: "" };
      missions.set(m.id, m);
      return m;
    },
    getMission: async (id: string) => missions.get(id),
    getMissionByName: async (name: string) => [...missions.values()].find((m) => m.name === name),
    getAllMissions: async () => [...missions.values()],
    updateMission: async (id: string, u: Partial<Mission>) => Object.assign(missions.get(id)!, u),
    deleteMission: async (id: string) => missions.delete(id),
    nextMissionName: async () => `mission-${n + 1}`,
  });
  const config: PolpoConfig = { version: "1", project: "t", teams: [{ name: "t", agents: [{ name: "a" }] }], tasks: [], settings: { maxRetries: 2, workDir: dir, logLevel: "quiet" } };
  const { teamStore, agentStore } = createMockStores(config.teams);
  return {
    emitter: new TypedEmitter(), registry, runStore: new InMemoryRunStore(), hooks: new HookRegistry(), config, teamStore, agentStore,
    workDir: dir, agentWorkDir: dir, polpoDir: dir, assessFn: vi.fn(),
    checkpointStore: new FileCheckpointStore(dir), delayStore: new FileDelayStore(dir), decisionNodeStore: new FileDecisionNodeStore(dir),
  } as unknown as OrchestratorContext;
}

const DOC = {
  tasks: [
    { title: "Triage", description: "Read the ticket" },
    { title: "Refund", description: "Refund it", dependsOn: ["Triage"] },
    { title: "Reply", description: "Answer it", dependsOn: ["Triage"] },
    { title: "Follow up", description: "Check back", dependsOn: ["Reply"] },
    { title: "Close", description: "Close it", dependsOn: ["Refund", "Reply"] },
  ],
  decisions: [{
    name: "route", afterTasks: ["Triage"], state: "Ticket: {{tasks.Triage}}",
    question: { type: "choice", instructions: "Which team?", choices: [{ value: "billing" }, { value: "support" }] },
    branches: { billing: ["Refund"], support: ["Reply"] }, threshold: 0.7,
  }],
};

const choice = (c: string, p: number): DecisionAnswer => ({ name: "decision", type: "choice", choice: c, probabilities: { [c]: p, other: 1 - p }, confidence: p, threshold: 0.7, uncertain: p < 0.7 });

describe("mission decision nodes", () => {
  let dir: string;
  let ctx: OrchestratorContext;
  let exec: MissionExecutor;
  const events: Array<{ status: string; branch?: string | null; suggested?: string | null }> = [];
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-decision-nodes-"));
    ctx = makeCtx(dir);
    exec = new MissionExecutor(ctx, new TaskManager(ctx), new AgentManager(ctx));
    await exec.ready;
    events.length = 0;
    ctx.emitter.on("decision:node", (e) => events.push(e));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function start(doc: unknown = DOC, decider?: MissionDecider) {
    if (decider) exec.setDecider(decider);
    const m = await exec.saveMission({ data: JSON.stringify(doc), name: "ticket" });
    const { tasks, group } = await exec.executeMission(m.id);
    const byTitle = (t: string) => tasks.find((x) => x.title === t)!;
    const all = () => ctx.registry.getAllTasks();
    const finish = async (title: string, stdout: string) => {
      await ctx.registry.updateTask(byTitle(title).id, { result: { exitCode: 0, stdout, stderr: "", duration: 1 } });
      await ctx.registry.unsafeSetStatus(byTitle(title).id, "done", "test");
    };
    const blocking = async (title: string) => exec.getBlockingDecision(group, title, byTitle(title).id, await all());
    return { m, group, byTitle, all, finish, blocking };
  }

  test("branch tasks wait; the decision starts when the after tasks finish; the chosen branch goes on, the others (and what only depends on them) are skipped", async () => {
    const decider = vi.fn<MissionDecider>(async () => ({ id: "dec_abc123", answers: [choice("billing", 0.9)], calibrated: true, model: "vercel-ai-gateway:typesafe-ai/jev" }));
    const s = await start(DOC, decider);
    expect(await s.blocking("Refund")).toMatchObject({ decision: { name: "route" } });
    expect(decider).not.toHaveBeenCalled();
    expect(await s.blocking("Triage")).toBeUndefined();
    await s.finish("Triage", "Customer was charged twice");
    expect((await s.blocking("Refund"))?.state?.status).toBe("deciding");
    await vi.waitFor(() => expect(events.some((e) => e.status === "decided")).toBe(true));
    expect(decider).toHaveBeenCalledTimes(1);
    const req = decider.mock.calls[0][0];
    expect(req.state).toBe("Ticket: Customer was charged twice");
    expect(req.questions[0]).toMatchObject({ name: "decision", type: "choice", threshold: 0.7 });
    expect(req.caller).toMatchObject({ kind: "mission", id: s.m.id });

    expect(await s.blocking("Refund")).toBeUndefined();
    const tasks = await s.all();
    const t = (title: string) => tasks.find((x) => x.title === title)!;
    expect(t("Refund").description).toContain('## Decision "route"');
    expect(t("Refund").description).toContain("Answer: decision: billing (0.90)");
    expect(t("Reply")).toMatchObject({ status: "done", result: { stdout: expect.stringContaining('Skipped: the decision "route" took the branch "billing"') } });
    expect(t("Follow up").status).toBe("done");
    expect(t("Follow up").result?.stdout).toContain("Skipped");
    expect(t("Close").status).toBe("pending");
    expect(events.map((e) => e.status)).toEqual(["deciding", "decided"]);
    expect(events[1]).toMatchObject({ branch: "billing" });
    expect(exec.hasPendingDecisions()).toBe(false);
  });

  test("uncertain → a person chooses: the mission pauses at a checkpoint; resuming it takes the suggestion", async () => {
    const s = await start(DOC, async () => ({ id: "dec_x", answers: [choice("support", 0.55)], calibrated: true, model: "m" }));
    await s.finish("Triage", "unclear");
    await s.blocking("Reply");
    await vi.waitFor(() => expect(events.some((e) => e.status === "awaiting")).toBe(true));
    const node = exec.listDecisionNodes()[0];
    expect(node).toMatchObject({ suggested: "support", reason: expect.stringContaining("uncertain") });
    expect(exec.hasPendingDecisions()).toBe(true);
    expect(exec.getCheckpoints(s.group).map((c) => c.name)).toEqual(["Decision: route"]);
    const cp = await exec.getBlockingCheckpoint(s.group, "Reply", s.byTitle("Reply").id, await s.all());
    expect(cp?.checkpoint.message).toContain("Resume to take \"support\"");
    expect((await ctx.registry.getMission!(s.m.id))?.status).toBe("paused");
    expect(await exec.resumeCheckpoint(s.group, "Decision: route", "ada@example.com")).toBe(true);
    expect(exec.listDecisionNodes()[0]).toMatchObject({ status: "decided", branch: "support", decidedBy: "ada@example.com" });
    expect((await ctx.registry.getMission!(s.m.id))?.status).toBe("active");
    const tasks = await s.all();
    expect(tasks.find((x) => x.title === "Refund")?.result?.stdout).toContain("Skipped");
    expect(tasks.find((x) => x.title === "Reply")?.description).toContain('chosen by ada@example.com');
  });

  test("a failed decision waits for a person too; the person may choose another branch (or none)", async () => {
    const s = await start(DOC, async () => { throw new Error("No decision model is configured"); });
    await s.finish("Triage", "x");
    await s.blocking("Refund");
    await vi.waitFor(() => expect(events.some((e) => e.status === "awaiting")).toBe(true));
    expect(exec.listDecisionNodes()[0].reason).toContain("The decision failed: No decision model");
    await expect(exec.resolveDecisionNode(s.group, "route", "sales", "ada")).rejects.toThrow(/not a branch/);
    const done = await exec.resolveDecisionNode(s.group, "route", null, "ada");
    expect(done).toMatchObject({ status: "decided", branch: null });
    const tasks = await s.all();
    expect(tasks.filter((x) => x.result?.stdout?.startsWith("Skipped")).map((x) => x.title).sort()).toEqual(["Close", "Follow up", "Refund", "Reply"]);
    expect(exec.getCheckpoints(s.group)).toEqual([]);
    await expect(exec.resolveDecisionNode(s.group, "route", "billing", "ada")).rejects.toThrow(/not waiting/);
  });

  test("onUncertain { branch } takes that branch without a person", async () => {
    const doc = { ...DOC, decisions: [{ ...DOC.decisions[0], onUncertain: { branch: "support" } }] };
    const s = await start(doc, async () => ({ id: "d", answers: [choice("billing", 0.5)], calibrated: false, model: "Polpo" }));
    await s.finish("Triage", "x");
    await s.blocking("Refund");
    await vi.waitFor(() => expect(events.some((e) => e.status === "decided")).toBe(true));
    expect(exec.listDecisionNodes()[0]).toMatchObject({ branch: "support", decidedBy: "onUncertain", suggested: "billing", calibrated: false });
    expect(exec.getCheckpoints(s.group)).toEqual([]);
  });

  test("a rank node: items from a task's result, the sorted list goes to its branch", async () => {
    const doc = {
      tasks: [{ title: "Find", description: "List plans" }, { title: "Pick", description: "Use the best", dependsOn: ["Find"] }],
      decisions: [{ name: "best", afterTasks: ["Find"], question: { type: "rank", instructions: "Best plan for a startup?", items: "{{tasks.Find}}" }, branches: { ranked: ["Pick"] } }],
    };
    const decider = vi.fn<MissionDecider>(async () => ({ id: "d", calibrated: true, model: "m", answers: [{ name: "decision", type: "rank", uncertain: false, ranking: [{ id: "2", label: "Pro", score: 3.1 }, { id: "1", label: "Basic", score: 1.2 }] }] }));
    const s = await start(doc, decider);
    await s.finish("Find", "1. Basic\n2. Pro");
    await s.blocking("Pick");
    await vi.waitFor(() => expect(events.some((e) => e.status === "decided")).toBe(true));
    expect(decider.mock.calls[0][0].questions[0].items).toEqual([{ id: "1", label: "Basic" }, { id: "2", label: "Pro" }]);
    expect((await s.all()).find((x) => x.title === "Pick")?.description).toContain("1. Pro (score 3.10)\n2. Basic (score 1.20)");
  });

  test("a mission without decisions is unaffected; a restart keeps a decided node (the store)", async () => {
    const plain = await start({ tasks: [{ title: "A", description: "a" }, { title: "B", description: "b", dependsOn: ["A"] }] });
    expect(await plain.blocking("B")).toBeUndefined();
    const s = await start(DOC, async () => ({ id: "d", answers: [choice("support", 0.95)], calibrated: true, model: "m" }));
    await s.finish("Triage", "x");
    await s.blocking("Reply");
    await vi.waitFor(() => expect(events.some((e) => e.status === "decided")).toBe(true));
    const again = new MissionExecutor(ctx, new TaskManager(ctx), new AgentManager(ctx));
    await again.ready;
    expect(again.listDecisionNodes()).toEqual([expect.objectContaining({ node: "route", status: "decided", branch: "support" })]);
    const mission = await ctx.registry.getMission!(s.m.id);
    expect(await again.getBlockingDecision(s.group, "Reply", s.byTitle("Reply").id, await s.all() as Task[], mission!.data)).toBeUndefined();
  });
});

describe("playbooks with decision nodes", () => {
  test("{{tasks.<title>}} is a run-time reference, not a parameter; other placeholders still need parameters", () => {
    const def = {
      name: "route-ticket", description: "Route a ticket", parameters: [{ name: "ticket", description: "The ticket", required: true }],
      mission: { ...DOC, tasks: [{ title: "Triage", description: "Read {{ticket}}" }, ...DOC.tasks.slice(1)] },
    };
    expect(validatePlaybookDefinition(def)).toEqual([]);
    const out = instantiatePlaybook(def, { ticket: "T-1" });
    expect(JSON.parse(out.data).decisions[0].state).toBe("Ticket: {{tasks.Triage}}");
    expect(JSON.parse(out.data).tasks[0].description).toBe("Read T-1");
    expect(validatePlaybookDefinition({ ...def, parameters: [] })).toEqual([expect.stringContaining('"{{ticket}}"')]);
  });
});
