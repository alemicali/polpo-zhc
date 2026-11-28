/**
 * A task chooses which of its agent's computers it runs on (Task.sandbox.computer): REST create /
 * update with validation, the run resolving that computer (task level beats mission level), and
 * the MCP `computer` argument. Live bug (2026-11-28): POST /tasks dropped `sandbox` and the task
 * ran on the agent's default computer.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { TaskRunner, requireTaskSandbox, taskComputerProblem, TaskComputerError, normalizeTaskSandbox } from "@polpo-ai/core";
import { TypedEmitter } from "../core/events.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { withComputer } from "../server/mcp-server/tasks.js";

const computers = [
  { id: "ms-nina-01", name: "Nina", kind: "daytona" },
  { id: "daytona-box", name: "Daytona box", kind: "daytona" },
  { id: "other-box", name: "Other", kind: "daytona" },
];
const nina = { name: "nina", role: "Builder", computers: ["ms-nina-01", "daytona-box"], defaultComputer: "ms-nina-01" };

/** Just enough of the orchestrator for spawnForTask to record where the run executes. */
function runner(task: any, missionData?: unknown) {
  const runs = new Map<string, any>();
  const ctx = {
    emitter: new TypedEmitter(),
    polpoDir: "/tmp/polpo-test",
    agentWorkDir: "/tmp/polpo-test/work",
    config: { project: "p", settings: { computers } },
    hooks: { runBeforeSync: () => ({ cancelled: false }) },
    agentStore: { getAgent: async () => nina },
    memoryStore: { get: async () => "" },
    sandboxProviders: () => new Set(["local", "bwrap", "daytona", "e2b"]),
    spawner: { spawn: async () => ({ pid: 4242, configPath: "/tmp/c.json" }), isAlive: () => true, kill: () => {} },
    runStore: {
      upsertRun: async (r: any) => { runs.set(r.id, r); },
      getActiveRuns: async () => [...runs.values()].filter((r) => r.status === "running"),
      getTerminalRuns: async () => [],
      deleteRun: async (id: string) => { runs.delete(id); },
    },
    taskControlStore: { listDirections: async () => [] },
    registry: {
      transition: async (_id: string, to: string) => { task.status = to; },
      updateTask: async (_id: string, patch: any) => { Object.assign(task, patch); return task; },
      getTask: async () => task,
      getAllTasks: async () => [task],
      setState: async () => {},
      getMission: async () => (missionData ? { data: JSON.stringify(missionData) } : undefined),
    },
  } as never;
  return new TaskRunner(ctx);
}

const baseTask = (extra: Record<string, unknown> = {}) => ({ id: "t1", title: "Build it", description: "x", assignTo: "nina", status: "pending", phase: "execution", dependsOn: [], ...extra }) as any;

async function computerOfRun(task: any, missionData?: unknown): Promise<string | undefined> {
  await runner(task, missionData).spawnForTask(task);
  return task.runs?.[0]?.computer?.id;
}

describe("validation (core)", () => {
  test("one of the agent's computers, host or ephemeral; anything else is refused with the choices", () => {
    for (const id of ["ms-nina-01", "daytona-box", "host", "ephemeral"]) expect(taskComputerProblem(nina, id)).toBeNull();
    expect(taskComputerProblem(nina, "other-box")).toMatch(/Computer "other-box" is not one agent "nina" may use \(its computers: host, ms-nina-01, daytona-box/);
    expect(taskComputerProblem(nina, "Not An Id")).toMatch(/must be a computer id/);
    expect(taskComputerProblem(undefined, "daytona-box", "ghost")).toMatch(/Agent "ghost" not found/);
    expect(() => requireTaskSandbox(nina, { computer: "other-box" })).toThrow(TaskComputerError);
    expect(requireTaskSandbox(nina, { computer: "daytona-box", warm: { e2b: 1 }, junk: 1 })).toEqual({ computer: "daytona-box" });
    expect(normalizeTaskSandbox({ allowedProviders: ["e2b"] })).toBeUndefined();
  });
});

describe("the run uses the task's computer", () => {
  test("a standalone task: its own computer, else the agent's default", async () => {
    expect(await computerOfRun(baseTask({ sandbox: { computer: "daytona-box" } }))).toBe("daytona-box");
    expect(await computerOfRun(baseTask())).toBe("ms-nina-01");
  });

  test("mission tasks: the task's entry beats the mission's, Task.sandbox beats both", async () => {
    const doc = { sandbox: { computer: "ms-nina-01" }, tasks: [{ title: "Build it", sandbox: { computer: "daytona-box" } }, { title: "Other" }] };
    expect(await computerOfRun(baseTask({ missionId: "m1", group: "m" }), doc)).toBe("daytona-box");
    // a task without an entry of its own: the mission level
    expect(await computerOfRun(baseTask({ title: "Other", missionId: "m1", group: "m" }), { ...doc, sandbox: { computer: "daytona-box" } })).toBe("daytona-box");
    // Task.sandbox (set with PATCH /tasks/:id) wins over the mission document
    expect(await computerOfRun(baseTask({ missionId: "m1", group: "m", sandbox: { computer: "host" } }), doc)).toBe("host");
  });
});

describe("REST", () => {
  let tmpDir: string;
  let app: Hono;
  let orchestrator: Orchestrator;
  const api = (path: string) => `/api/v1${path}`;
  const jsonReq = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "polpo-task-computer-"));
    await mkdir(join(tmpDir, ".polpo"), { recursive: true });
    const team = { name: "team", agents: [nina, { name: "writer", role: "Writer" }] };
    await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "task-computer", team, settings: { maxRetries: 2, logLevel: "quiet", computers } }));
    const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
    const { SSEBridge } = await import("../server/sse-bridge.js");
    const { createApp } = await import("../server/app.js");
    orchestrator = new OrchestratorClass(tmpDir);
    await orchestrator.initInteractive("task-computer", team as never);
    const sseBridge = new SSEBridge(orchestrator);
    sseBridge.start();
    app = createApp(orchestrator, sseBridge);
  }, 30_000);

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test("POST /tasks keeps sandbox.computer, GET returns it, and its run uses that computer", async () => {
    let res = await app.request(api("/tasks"), jsonReq("POST", { title: "On the box", description: "x", assignTo: "nina", draft: true, sandbox: { computer: "daytona-box" } }));
    expect(res.status).toBe(201);
    expect((await res.json()).data.sandbox).toEqual({ computer: "daytona-box" });
    const id = (await orchestrator.getStore().getAllTasks()).find((t) => t.title === "On the box")!.id;
    res = await app.request(api(`/tasks/${id}`));
    const task = (await res.json()).data;
    expect(task.sandbox).toEqual({ computer: "daytona-box" });
    expect(await computerOfRun({ ...task, status: "pending", phase: "execution" })).toBe("daytona-box");
  });

  test("a computer the agent may not use: 400 INVALID_COMPUTER, nothing created", async () => {
    const res = await app.request(api("/tasks"), jsonReq("POST", { title: "Wrong box", description: "x", assignTo: "nina", draft: true, sandbox: { computer: "other-box" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_COMPUTER");
    expect(body.error).toMatch(/not one agent "nina" may use/);
    expect(body.allowed).toEqual(["host", "ms-nina-01", "daytona-box", "ephemeral"]);
    expect((await orchestrator.getStore().getAllTasks()).some((t) => t.title === "Wrong box")).toBe(false);
    // the writer has no computers of its own: only host / ephemeral
    const w = await app.request(api("/tasks"), jsonReq("POST", { title: "Writer box", description: "x", assignTo: "writer", draft: true, sandbox: { computer: "daytona-box" } }));
    expect(w.status).toBe(400);
  });

  test("PATCH /tasks/:id sets, refuses and clears the computer", async () => {
    let res = await app.request(api("/tasks"), jsonReq("POST", { title: "Patch me", description: "x", assignTo: "nina", draft: true }));
    const id = (await res.json()).data.id;
    res = await app.request(api(`/tasks/${id}`), jsonReq("PATCH", { sandbox: { computer: "daytona-box" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.sandbox).toEqual({ computer: "daytona-box" });
    res = await app.request(api(`/tasks/${id}`), jsonReq("PATCH", { sandbox: { computer: "other-box" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_COMPUTER");
    res = await app.request(api(`/tasks/${id}`), jsonReq("PATCH", { sandbox: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.sandbox).toBeUndefined();
  });

  test("a mission whose task names a computer its agent may not use: 400 INVALID_COMPUTER", async () => {
    const data = (computer: string) => JSON.stringify({ tasks: [{ title: "Boxed", description: "do it", assignTo: "nina", sandbox: { computer } }] });
    let res = await app.request(api("/missions"), jsonReq("POST", { data: data("other-box"), name: "computer-mission-bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_COMPUTER");
    res = await app.request(api("/missions"), jsonReq("POST", { data: data("daytona-box"), name: "computer-mission-ok" }));
    expect(res.status).toBe(201);
  });
});

describe("MCP: the computer argument", () => {
  function fake() {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const task: any = { id: "t9", title: "Boxed", status: "draft", assignTo: "nina", description: "x", sandbox: { computer: "daytona-box", network: { mode: "open" } } };
    const reply = (status: number, body: unknown): ApiResponse => ({ status, body, headers: new Headers() });
    const api: McpDeps["api"] = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const p = new URL(path, "http://x").pathname.replace(/^\/api\/v1/, "");
      if (p === "/agents") return reply(200, { ok: true, data: [{ name: "nina" }] });
      if (p === "/tasks" && method === "POST") {
        const b = body as any;
        if (b.sandbox?.computer === "other-box") return reply(400, { ok: false, error: 'Computer "other-box" is not one agent "nina" may use', code: "INVALID_COMPUTER" });
        return reply(201, { ok: true, data: { ...b, id: "t10", status: "pending" } });
      }
      if (p === "/tasks/t9" && method === "GET") return reply(200, { ok: true, data: { ...task } });
      if (p === "/tasks/t9" && method === "PATCH") { task.sandbox = (body as any).sandbox ?? undefined; return reply(200, { ok: true, data: { ...task } }); }
      return reply(404, { ok: false, error: "not found", code: "NOT_FOUND" });
    });
    return { calls, api };
  }
  const call = async (f: ReturnType<typeof fake>, name: string, args: Record<string, unknown>) => {
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), { api: f.api, version: "x", pollIntervalMs: 5 } as McpDeps);
    return (await res.json()).result;
  };

  test("polpo_task_create maps computer to sandbox.computer; a refused computer explains how to fix it", async () => {
    const f = fake();
    const made = await call(f, "polpo_task_create", { title: "Boxed", description: "x", assignTo: "nina", computer: "daytona-box" });
    expect(made.isError).toBeFalsy();
    expect(f.calls.find((c) => c.method === "POST")!.body).toMatchObject({ sandbox: { computer: "daytona-box" } });
    expect(made.content[0].text).toMatch(/on daytona-box/);
    const bad = await call(f, "polpo_task_create", { title: "Bad", description: "x", assignTo: "nina", computer: "other-box" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/polpo_agents_get/);
  });

  test("polpo_task_update changes only the computer (other sandbox settings stay); default_computer drops it", async () => {
    const f = fake();
    let r = await call(f, "polpo_task_update", { id: "t9", computer: "ms-nina-01" });
    expect(r.structuredContent.changed).toEqual(["computer"]);
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ sandbox: { network: { mode: "open" }, computer: "ms-nina-01" } });
    r = await call(f, "polpo_task_update", { id: "t9", default_computer: true });
    expect(f.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ sandbox: { network: { mode: "open" } } });
    expect(withComputer({ computer: "x" }, undefined)).toBeNull();
  });
});
