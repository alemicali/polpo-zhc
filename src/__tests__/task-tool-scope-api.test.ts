/**
 * Task tool scope over REST (own file: the shared server-api app hits the 200 req/min limit).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Orchestrator } from "../core/orchestrator.js";

let tmpDir: string;
let app: Hono;
let orchestrator: Orchestrator;
const api = (path: string) => `/api/v1${path}`;
const jsonReq = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-scope-api-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  const team = { name: "api-team", agents: [{ name: "agent-1", role: "Test agent" }] };
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "scope-api", team, settings: { maxRetries: 2, logLevel: "quiet" } }));
  const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("scope-api", team);
  const sseBridge = new SSEBridge(orchestrator);
  sseBridge.start();
  app = createApp(orchestrator, sseBridge);
}, 30_000);

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("Task tool scope API", () => {
  const writeConnectors = (agents: string[] | "*") => writeFile(join(tmpDir, ".polpo", "connectors.json"), JSON.stringify({
    connectors: [
      { id: "linear", name: "Linear", kind: "mcp", transport: { type: "http", url: "http://127.0.0.1:1/mcp" }, auth: { type: "none" }, access: { agents, polpo: false }, enabled: true, createdAt: "2026-01-01" },
      { id: "notion", name: "Notion", kind: "mcp", transport: { type: "http", url: "http://127.0.0.1:1/mcp" }, auth: { type: "none" }, access: { agents: ["someone-else"], polpo: false }, enabled: true, createdAt: "2026-01-01" },
    ],
  }));
  const create = (title: string, toolScope?: unknown) => app.request(api("/tasks"), jsonReq("POST", {
    title, description: "scope test", assignTo: "agent-1", draft: true, ...(toolScope !== undefined ? { toolScope } : {}),
  }));

  test("no toolScope: the task inherits everything (no field)", async () => {
    await writeConnectors(["agent-1"]);
    const res = await create("scope-inherit");
    expect(res.status).toBe(201);
    expect((await res.json()).data.toolScope).toBeUndefined();
  });

  test("create, read, narrow, clear; grants and unknown tools rejected", async () => {
    await writeConnectors(["agent-1"]);
    let res = await create("scope-narrow", { connectors: ["linear", "linear"], connectorTools: { linear: ["create_issue"] }, allowedTools: ["read", "grep"] });
    expect(res.status).toBe(201);
    const task = (await res.json()).data;
    expect(task.toolScope).toEqual({ connectors: ["linear"], connectorTools: { linear: ["create_issue"] }, allowedTools: ["read", "grep"] });

    res = await app.request(api(`/tasks/${task.id}`));
    expect((await res.json()).data).toMatchObject({ toolScope: { connectors: ["linear"] } });

    // a connector the agent has no access to, a built-in tool it does not have, a connector pattern
    for (const [scope, pattern] of [
      [{ connectors: ["notion"] }, /no access to Notion \(notion\)/],
      [{ connectors: ["jira"] }, /there is no connector "jira"/],
      [{ allowedTools: ["browser_click"] }, /does not have "browser_click"/],
      [{ allowedTools: ["mcp__linear__*"] }, /connector tool/],
    ] as const) {
      res = await create(`scope-bad-${Math.random()}`, scope);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("INVALID_TOOL_SCOPE");
      expect(body.error).toMatch(pattern);
    }
    // malformed: rejected by the schema
    expect((await create("scope-malformed", { connectors: "all" })).status).toBe(400);

    // update: narrow further, reject a grant, clear with null
    res = await app.request(api(`/tasks/${task.id}`), jsonReq("PATCH", { toolScope: { connectors: "none", allowedTools: ["read"] } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.toolScope).toEqual({ connectors: "none", allowedTools: ["read"] });
    res = await app.request(api(`/tasks/${task.id}`), jsonReq("PATCH", { toolScope: { connectors: ["notion"] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_TOOL_SCOPE");
    res = await app.request(api(`/tasks/${task.id}`), jsonReq("PATCH", { toolScope: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.toolScope).toBeUndefined();
  });

  test("what the agent no longer has is listed as stale", async () => {
    await writeConnectors(["agent-1"]);
    const task = (await (await create("scope-stale", { connectors: ["linear"] })).json()).data;
    await writeConnectors(["someone-else"]);
    const body = await (await app.request(api(`/tasks/${task.id}`))).json();
    expect(body.data.toolScope).toEqual({ connectors: ["linear"] });
    expect(body.data.toolScopeStale).toEqual([expect.stringMatching(/agent "agent-1" has no access to Linear \(linear\)/)]);
    await writeConnectors(["agent-1"]);
  });

  test("mission tasks: a tool scope asking for more than the agent has is rejected", async () => {
    await writeConnectors(["agent-1"]);
    const data = (toolScope: unknown) => JSON.stringify({ tasks: [{ title: "Scoped", description: "do it", assignTo: "agent-1", toolScope }] });
    let res = await app.request(api("/missions"), jsonReq("POST", { data: data({ connectors: ["notion"] }), name: "scope-mission-bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_TOOL_SCOPE");
    res = await app.request(api("/missions"), jsonReq("POST", { data: data({ connectors: ["linear"] }), name: "scope-mission-ok" }));
    expect(res.status).toBe(201);
    const mission = (await res.json()).data;
    res = await app.request(api(`/missions/${mission.id}/tasks/${encodeURIComponent("Scoped")}`), jsonReq("PATCH", { toolScope: { allowedTools: ["browser_click"] } }));
    expect(res.status).toBe(400);
    res = await app.request(api(`/missions/${mission.id}/tasks/${encodeURIComponent("Scoped")}`), jsonReq("PATCH", { toolScope: { connectors: "none" } }));
    expect(res.status).toBe(200);
    expect(JSON.parse((await res.json()).data.data).tasks[0].toolScope).toEqual({ connectors: "none" });
  });
});
