/**
 * Harness sessions follow their task, agent and computer: deleting one resets its sessions (status
 * record and resume state in the vault's $harness namespace), best effort; a sweep resets orphans.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessSessionStore, HARNESS_VAULT_OWNER, type HarnessSessionStatus } from "../harness/session-store.js";
import { HARNESS_SWEEP_GRACE_MS, HarnessSessionJanitor, sweepOrphanHarnessSessions, type HarnessJanitorDeps } from "../harness/janitor.js";
import { liveHarnessSessions } from "../harness/live-sessions.js";

function memoryVault() {
  const m = new Map<string, any>();
  return {
    m,
    get: async (o: string, s: string) => m.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { m.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => m.delete(`${o}/${s}`),
  } as any;
}

let dir: string;
let vault: ReturnType<typeof memoryVault>;
let store: HarnessSessionStore;
let logs: Array<[string, string]>;
let tasks: Set<string>;
let agents: string[] | undefined;
let computers: string[] | undefined;
let ran: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-harness-janitor-"));
  vault = memoryVault();
  store = new HarnessSessionStore(dir, vault);
  logs = [];
  tasks = new Set(["t1", "t2"]);
  agents = ["ada", "bob"];
  computers = ["nina", "box"];
  ran = [];
  liveHarnessSessions.clear();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const deps = (): HarnessJanitorDeps => ({
  polpoDir: () => dir,
  vault: () => vault,
  onComputer: async (id, command) => { ran.push(`${id}: ${command.slice(0, 20)}`); return true; },
  taskExists: async (id) => tasks.has(id),
  agentNames: async () => agents,
  computerIds: () => computers,
  log: (level, message) => { logs.push([level, message]); },
});

async function seed(s: Partial<HarnessSessionStatus> & { key: string }, updatedAt?: string): Promise<void> {
  const now = new Date().toISOString();
  await store.update(s.key, () => ({
    agent: "ada", harness: "claude-code", computerId: "nina", scope: "task", state: "stopped", resumable: true, turns: 1, costUsd: 0.01,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, createdAt: now, updatedAt: now, bridgePort: 4007, ...s,
  }));
  await store.saveResumeState(s.key, { type: "resume-session", data: { bridge: { privateKey: "k" } } } as any);
  if (updatedAt) {
    // backdate (the store stamps updatedAt on every write)
    const { readFileSync, writeFileSync } = await import("node:fs");
    const file = join(dir, "harness-sessions.json");
    const all = JSON.parse(readFileSync(file, "utf8"));
    all[s.key].updatedAt = updatedAt;
    writeFileSync(file, JSON.stringify(all));
  }
}

const keys = () => store.list().map((s) => s.key).sort();
const resumeKept = (key: string) => vault.m.has(`${HARNESS_VAULT_OWNER}/${key}`);

describe("harness session cleanup on delete", () => {
  it("deleting a task resets its session (record and resume state), and only that one", async () => {
    await seed({ key: "task:t1", taskId: "t1" });
    await seed({ key: "task:t2", taskId: "t2" });
    const r = await new HarnessSessionJanitor(deps()).onTaskRemoved("t1");
    expect(r.reset).toEqual(["task:t1"]);
    expect(keys()).toEqual(["task:t2"]);
    expect(resumeKept("task:t1")).toBe(false);
    expect(resumeKept("task:t2")).toBe(true);
    // its parked bridge in the computer was ended (when the computer runs)
    expect(ran).toEqual(["nina: for p in /proc/[0-9]"]);
    expect(logs.some(([l, m]) => l === "info" && /task:t1 after task t1 was deleted/.test(m))).toBe(true);
  });

  it("removing an agent resets all its sessions (tasks and chats)", async () => {
    await seed({ key: "task:t1", taskId: "t1" });
    await seed({ key: "chat:ada:c1", scope: "chat", chatSessionId: "c1" });
    await seed({ key: "task:t2", taskId: "t2", agent: "bob" });
    await new HarnessSessionJanitor(deps()).onAgentRemoved("ada");
    expect(keys()).toEqual(["task:t2"]);
    expect(resumeKept("chat:ada:c1")).toBe(false);
  });

  it("deleting a computer resets the sessions bound to it", async () => {
    await seed({ key: "task:t1", taskId: "t1", computerId: "nina" });
    await seed({ key: "task:t2", taskId: "t2", computerId: "box" });
    await new HarnessSessionJanitor(deps()).onComputerDeleted("nina");
    expect(keys()).toEqual(["task:t2"]);
  });

  it("never throws: a session a task runner still holds is left (logged) for the sweep; a failing vault is logged", async () => {
    await seed({ key: "task:t1", taskId: "t1", pid: process.ppid, state: "running" });
    const r = await new HarnessSessionJanitor(deps()).onTaskRemoved("t1");
    expect(r).toEqual({ reset: [], failed: ["task:t1"] });
    expect(keys()).toEqual(["task:t1"]);
    expect(logs.some(([l, m]) => l === "warn" && /task:t1 was not reset/.test(m))).toBe(true);

    await seed({ key: "task:t2", taskId: "t2" });
    vault.remove = async () => { throw new Error("vault down"); };
    const store2 = new HarnessSessionStore(dir, vault);
    // the store swallows a vault failure on forget; the record still goes
    await expect(new HarnessSessionJanitor(deps()).onTaskRemoved("t2")).resolves.toMatchObject({ reset: ["task:t2"] });
    expect(store2.get("task:t2")).toBeUndefined();
  });

  it("a live session of this server is suspended before it is forgotten", async () => {
    await seed({ key: "chat:ada:c1", scope: "chat", chatSessionId: "c1" });
    const suspend = vi.fn(async () => {});
    const off = liveHarnessSessions.register({ key: "chat:ada:c1", agent: "ada", computerId: "nina", suspend });
    await new HarnessSessionJanitor(deps()).onAgentRemoved("ada");
    expect(suspend).toHaveBeenCalledWith("disk", "reset");
    expect(keys()).toEqual([]);
    off();
  });

  it("follows the orchestrator's events; stop() unsubscribes", async () => {
    await seed({ key: "task:t1", taskId: "t1" });
    await seed({ key: "task:t2", taskId: "t2", computerId: "box" });
    await seed({ key: "task:x", taskId: "x", agent: "bob" });
    const events = new EventEmitter();
    const j = new HarnessSessionJanitor(deps(), 60_000);
    j.start(events as any);
    events.emit("computer:changed", { id: "box", action: "status", status: "running" });
    events.emit("task:removed", { taskId: "t1" });
    await j.sweep();
    expect(keys()).toEqual(["task:t2", "task:x"]);
    events.emit("computer:changed", { id: "box", action: "deleted" });
    await j.sweep();
    expect(keys()).toEqual(["task:x"]);
    j.stop();
    events.emit("agent:removed", { agentName: "bob" });
    await j.sweep();
    expect(keys()).toEqual(["task:x"]);
    expect(events.listenerCount("task:removed")).toBe(0);
  });
});

describe("orphan sweep", () => {
  const old = () => new Date(Date.now() - HARNESS_SWEEP_GRACE_MS - 60_000).toISOString();

  it("resets sessions whose task, agent or computer is gone; keeps the rest", async () => {
    await seed({ key: "task:t1", taskId: "t1" }, old());
    await seed({ key: "task:gone", taskId: "gone" }, old());
    await seed({ key: "task:t2", taskId: "t2", agent: "zed" }, old());
    await seed({ key: "chat:bob:c", scope: "chat", agent: "bob", chatSessionId: "c", computerId: "old-box" }, old());
    await seed({ key: "chat:ada:h", scope: "chat", chatSessionId: "h", computerId: "host" }, old());
    const r = await sweepOrphanHarnessSessions(deps());
    expect(r.reset.sort()).toEqual(["chat:bob:c", "task:gone", "task:t2"]);
    expect(keys()).toEqual(["chat:ada:h", "task:t1"]);
    expect(resumeKept("task:gone")).toBe(false);
  });

  it("skips live sessions, recent ones, and checks it cannot make (no agents read, no computers)", async () => {
    await seed({ key: "task:gone", taskId: "gone" });
    await seed({ key: "task:held", taskId: "held", pid: process.ppid }, old());
    expect((await sweepOrphanHarnessSessions(deps())).reset).toEqual([]);

    await seed({ key: "task:t1", taskId: "t1", agent: "zed", computerId: "old-box" }, old());
    agents = undefined;
    computers = undefined;
    expect((await sweepOrphanHarnessSessions(deps())).reset).toEqual([]);
    agents = [];
    expect((await sweepOrphanHarnessSessions(deps())).reset).toEqual([]);
    // a task store that cannot answer: no reset
    const d = { ...deps(), taskExists: async () => { throw new Error("db down"); } };
    await seed({ key: "task:q", taskId: "q" }, old());
    expect((await sweepOrphanHarnessSessions(d as any)).reset).toEqual([]);
    expect(keys()).toContain("task:q");
  });
});
