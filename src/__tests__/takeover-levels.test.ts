/**
 * Soft and hard computer takeover requests (request_computer_takeover level).
 *
 * Seen live: Nina's TikTok sign-up stalled on a verification, her takeover request expired with
 * nobody taking it and the task ended. Now a soft request (optional help) that nobody takes tells
 * the agent to finish without it and say what it could not do; a hard one (blocking: CAPTCHA,
 * phone/app verification, login wall) pauses the task ("waiting for takeover") with the request
 * left open, and the task resumes as a continuation when the person completes the takeover — or
 * when someone resumes it by hand (the request is then cancelled).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, ComputerConfig } from "@polpo-ai/core";
import { ComputerControlStore, TAKEOVER_HARD_GRACE_MS, describeTakeoverWait, type ComputerTakeoverRequest } from "../sandbox/computer-control.js";
import { createComputerTakeoverTools, waitForTakeover, type ComputerTakeoverAccess } from "../tools/computer-takeover-tools.js";
import { ComputerTakeoverService, handleTakeoverWire, TAKEOVER_PAUSE_REASON } from "../core/computer-takeover.js";
import { Orchestrator } from "../core/orchestrator.js";
import { InMemoryTaskStore, InMemoryRunStore, InMemoryTaskControlStore } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "polpo-takeover-levels-")); dirs.push(d); return d; };

const NINA_PC: ComputerConfig = { id: "ms-nina-01", name: "Nina", kind: "daytona" };
const NINA: AgentConfig = { name: "nina", allowedTools: ["browser_*"], defaultComputer: "ms-nina-01", browserHeaded: true };

describe("the control store", () => {
  it("defaults the wait by level; a hard request of a task gets a grace, a parked one never expires; close leaves it open", async () => {
    let now = Date.parse("2026-11-28T10:00:00Z");
    const store = new ComputerControlStore(tmp(), () => now);
    const soft = await store.open({ computerId: "ms-nina-01", agent: "nina", reason: "check the draft" });
    const hard = await store.open({ computerId: "ms-nina-01", agent: "nina", reason: "TikTok asks for an SMS code", level: "hard", taskId: "t1" });
    expect(soft).toMatchObject({ level: "soft", expiresAt: "2026-11-28T10:30:00.000Z" });
    expect(hard).toMatchObject({ level: "hard", expiresAt: "2026-11-28T10:15:00.000Z" });

    now = Date.parse("2026-11-28T10:16:00Z");
    // the wait is over but the run has a grace to park it
    expect(store.request(hard.id)?.status).toBe("pending");
    expect(describeTakeoverWait(store.request(hard.id)!, now)).toMatch(/^blocking · waits until .*time is up.*its task pauses/);
    const parked = await store.park(hard.id);
    expect(parked?.parkedAt).toBeTruthy();
    // the run's abort after the pause closes nothing
    expect((await store.close(hard.id, "cancelled"))?.status).toBe("pending");
    now += TAKEOVER_HARD_GRACE_MS + 24 * 3_600_000;
    expect(store.request(hard.id)?.status).toBe("pending");
    expect(store.get("ms-nina-01").open.map((r) => r.id)).toEqual([hard.id]);
    expect(store.request(soft.id)?.status).toBe("timeout");
    expect(describeTakeoverWait(store.request(hard.id)!)).toMatch(/task is paused/);
    // someone resumed the task: the request is cancelled
    expect((await store.close(hard.id, "cancelled", { parked: true }))?.status).toBe("cancelled");

    // a hard request whose run is gone (never parked) still expires after the grace
    const orphan = await store.open({ computerId: "ms-nina-01", agent: "nina", reason: "CAPTCHA", level: "hard", taskId: "t2", timeoutMinutes: 1 });
    now += 60_000 + TAKEOVER_HARD_GRACE_MS + 1;
    expect(store.request(orphan.id)?.status).toBe("timeout");
    expect((await store.park(orphan.id))?.parkedAt).toBeUndefined();
  });
});

describe("request_computer_takeover levels", () => {
  /** An access over a real store; the tool's clock moves a minute per look (the store reads it). */
  function setup(o: { park?: boolean } = {}) {
    let now = Date.parse("2026-11-28T10:00:00Z");
    const store = new ComputerControlStore(tmp(), () => now);
    const parkCalls: string[] = [];
    const access: ComputerTakeoverAccess = {
      request: (ask) => store.open({ computerId: NINA_PC.id, agent: NINA.name, taskId: "t1", ...ask }),
      get: (id) => store.request(id),
      close: (id, s) => store.close(id, s),
      ...(o.park ? { park: async (id: string) => { parkCalls.push(id); return store.park(id); } } : {}),
    };
    const clock = () => (now += 60_000);
    const [tool] = createComputerTakeoverTools(NINA, NINA_PC, access, { pollMs: 1, now: clock });
    return { tool: tool!, store, parkCalls };
  }

  it("soft: nobody came, the request is closed and the agent finishes without it, saying what it could not do", async () => {
    const { tool, store } = setup({ park: true });
    const updates: string[] = [];
    const res = await tool.execute("1", { reason: "Review the cover image" }, undefined, (u: { content: Array<{ text: string }> }) => updates.push(u.content[0]!.text));
    expect(res.details).toMatchObject({ outcome: "timeout", level: "soft" });
    expect(res.content[0]!.text).toMatch(/optional help: go on and finish the task/);
    expect(res.content[0]!.text).toMatch(/say clearly what you could not do because nobody took over \("Review the cover image"\)/);
    expect(store.request(res.details.requestId as string)?.status).toBe("timeout");
    // it reported progress while waiting (the run is not stale)
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]).toMatch(/Still waiting for a person/);
  });

  it("hard in a task: nobody came, the request is parked (still open) and the agent told its task is paused", async () => {
    const { tool, store, parkCalls } = setup({ park: true });
    const res = await tool.execute("1", { reason: "TikTok asks for an SMS code", level: "hard" });
    expect(parkCalls).toHaveLength(1);
    expect(res.details).toMatchObject({ outcome: "parked", level: "hard" });
    expect(res.content[0]!.text).toMatch(/your task is now PAUSED \("waiting for takeover"\).*Stop here: do not call any more tools/);
    const r = store.request(res.details.requestId as string)!;
    expect(r.status).toBe("pending");
    expect(r.parkedAt).toBeTruthy();
  });

  it("hard without a task (a chat): the request is closed and the agent told the step is blocked", async () => {
    const { tool, store } = setup();
    const res = await tool.execute("1", { reason: "CAPTCHA", level: "hard" });
    expect(res.details).toMatchObject({ outcome: "timeout", level: "hard" });
    expect(res.content[0]!.text).toMatch(/blocking and nobody did it: do not pretend it was done/);
    expect(store.request(res.details.requestId as string)?.status).toBe("timeout");
  });

  it("the description and parameters tell agents to choose hard for CAPTCHA, verification and login walls", () => {
    const { tool } = setup();
    expect(tool.description).toMatch(/"hard" when you cannot go on without it — a CAPTCHA, a phone or app verification/);
    expect(JSON.stringify(tool.parameters)).toContain("\"hard\"");
  });

  it("waitForTakeover keeps a hard request open when the wait ends (it is parked, not closed)", async () => {
    const closed: string[] = [];
    const base: ComputerTakeoverRequest = { id: "tko_1", computerId: "ms-nina-01", agent: "nina", reason: "x", createdAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(), status: "pending", level: "hard" };
    let now = 0;
    const t = await waitForTakeover({ get: () => base, close: async (_id, s) => { closed.push(s); } }, base, { pollMs: 1, now: () => (now += 30_000), keepOpenOnTimeout: true });
    expect(t.outcome).toBe("timeout");
    expect(closed).toEqual([]);
  });
});

describe("hard takeover → paused task → resumed", () => {
  let store: InMemoryTaskStore;
  let runStore: InMemoryRunStore;
  let controls: InMemoryTaskControlStore;
  let orchestrator: Orchestrator;
  let service: ComputerTakeoverService;
  let spawned: Array<{ taskId: string; runId: string }>;
  let children: ChildProcess[];
  let workDir: string;

  beforeEach(async () => {
    workDir = tmp();
    store = new InMemoryTaskStore();
    runStore = new InMemoryRunStore();
    controls = new InMemoryTaskControlStore();
    spawned = [];
    children = [];
    orchestrator = new Orchestrator({
      workDir, store, runStore, taskControlStore: controls,
      spawner: {
        spawn: async (config: { taskId: string; runId: string }) => {
          const child = spawn("sleep", ["30"], { stdio: "ignore" });
          children.push(child);
          spawned.push({ taskId: config.taskId, runId: config.runId });
          return { pid: child.pid!, configPath: "/tmp/run.json" };
        },
        isAlive: () => true,
        kill: () => {},
      } as never,
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await orchestrator.initInteractive("takeover-levels", { name: "team", agents: [NINA] });
    (orchestrator as unknown as { config: { settings: { computers: ComputerConfig[] } } }).config.settings.computers = [NINA_PC];
    service = orchestrator.getComputerTakeover()!;
    // no live view to start in a test
    (service as unknown as { deps: { startDesktop?: unknown } }).deps.startDesktop = undefined;
  });
  afterEach(() => {
    for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  });

  /** Nina's task runs; its run asks for a hard takeover over the wire (as the runner does). */
  async function runningTaskWithHardRequest(): Promise<{ taskId: string; runId: string; requestId: string }> {
    const task = await orchestrator.addTask({ title: "Sign up on TikTok", description: "Create the account", assignTo: "nina" });
    await orchestrator.tick();
    const { runId } = spawned[0]!;
    const wire = {
      service,
      run: (id: string) => runStore.getRun(id),
      task: (id: string) => store.getTask(id),
      agentFor: async () => NINA,
    };
    const asked = await handleTakeoverWire({ type: "computer_takeover", op: "request", runId, computerId: NINA_PC.id, reason: "TikTok asks for an SMS code", level: "hard", timeoutMinutes: 1 }, wire);
    expect(asked).toMatchObject({ ok: true, request: { level: "hard", taskId: task.id, status: "pending" } });
    const requestId = (asked as { request: { id: string } }).request.id;
    // the wait ended with nobody: the run parks it
    const parked = await handleTakeoverWire({ type: "computer_takeover", op: "park", runId, requestId }, wire);
    expect(parked).toMatchObject({ ok: true, request: { parkedAt: expect.any(String) } });
    // a soft request cannot be parked
    const soft = await handleTakeoverWire({ type: "computer_takeover", op: "request", runId, computerId: NINA_PC.id, reason: "optional" }, wire);
    expect(await handleTakeoverWire({ type: "computer_takeover", op: "park", runId, requestId: (soft as { request: { id: string } }).request.id }, wire)).toMatchObject({ ok: false });
    await service.close((soft as { request: { id: string } }).request.id, "cancelled");
    return { taskId: task.id, runId, requestId };
  }

  /** The runner ends after the pause's SIGTERM. */
  async function runEnds(runId: string): Promise<void> {
    const run = (await runStore.getRun(runId))!;
    await runStore.upsertRun({ ...run, status: "killed", sessionId: "sess-nina", result: { exitCode: 1, stdout: "", stderr: "Killed by SIGTERM", duration: 5 } });
    await orchestrator.tick();
  }

  it("nobody took over in time: the task is paused (waiting for takeover), the request stays open; the person completes it and the task continues", async () => {
    const events: string[] = [];
    orchestrator.on("computer:takeover", (e) => events.push(`${e.action}:${e.level ?? ""}`));
    const { taskId, runId, requestId } = await runningTaskWithHardRequest();
    const paused = (await store.getTask(taskId))!;
    expect(paused.status).toBe("paused");
    expect(paused.pause).toMatchObject({ reason: TAKEOVER_PAUSE_REASON, by: "nina", runId, takeover: { requestId, computerId: NINA_PC.id } });
    expect(events).toContain("parked:hard");
    await runEnds(runId);
    expect((await store.getTask(taskId))!.status).toBe("paused");
    expect(service.store.request(requestId)).toMatchObject({ status: "pending", parkedAt: expect.any(String) });

    // the person takes control and gives it back with a note: the task resumes as a continuation
    await service.takeover(NINA_PC.id, "ale@acme.com");
    expect((await store.getTask(taskId))!.status).toBe("paused");
    await service.release(NINA_PC.id, "ale@acme.com", "Code entered, you are on the profile setup page");
    const resumed = (await store.getTask(taskId))!;
    expect(resumed.status).toBe("pending");
    expect(resumed.pause).toMatchObject({ resumedBy: "ale@acme.com" });
    const [direction] = await controls.listDirections(taskId);
    expect(direction).toMatchObject({ mode: "continue", status: "queued" });
    expect(direction!.message).toContain("ale@acme.com completed the takeover you asked for");
    expect(direction!.message).toContain("Code entered, you are on the profile setup page");
    expect(service.store.request(requestId)?.status).toBe("released");
    await orchestrator.tick();
    expect(spawned.filter((s) => s.taskId === taskId)).toHaveLength(2);
  });

  it("resumed by hand while nobody took over: the request is cancelled and the agent told nobody completed it", async () => {
    const { taskId, runId, requestId } = await runningTaskWithHardRequest();
    await runEnds(runId);
    const r = await orchestrator.resumeTask(taskId, { by: "bob@acme.com", message: "I solved it from my phone" });
    expect(r.continued).toBe(true);
    expect(r.direction!.message).toContain("Nobody completed the takeover you asked for");
    expect(r.direction!.message).toContain("bob@acme.com resumed your task anyway");
    expect(r.direction!.message).toContain("I solved it from my phone");
    expect(service.store.request(requestId)?.status).toBe("cancelled");
  });

  it("killing a task paused for a takeover cancels its request", async () => {
    const { taskId, runId, requestId } = await runningTaskWithHardRequest();
    await runEnds(runId);
    await orchestrator.killTask(taskId);
    expect((await store.getTask(taskId))!.status).toBe("failed");
    expect(service.store.request(requestId)?.status).toBe("cancelled");
  });
});
