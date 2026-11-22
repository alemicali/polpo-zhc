/**
 * The MCP tools for tasks, missions, playbooks, the team and the configuration, against a fake API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { expectValidOutput } from "./helpers/mcp-output.js";
import { fetchPublicImage, sniffImage } from "../server/mcp-server/config.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

type Task = { id: string; title: string; status: string; assignTo: string; description: string; missionId?: string; group?: string; updatedAt: string; maxRetries?: number; sideEffects?: boolean };
type Mission = { id: string; name: string; status: string; data: string; prompt?: string; updatedAt: string; executionCount?: number; schedule?: string };

function fakeInstance() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const tasks = new Map<string, Task>();
  const missions = new Map<string, Mission>();
  const schedules = new Map<string, { missionId: string; expression: string; recurring: boolean; enabled: boolean; nextRunAt?: string }>();
  const activity: Array<Record<string, unknown>> = Array.from({ length: 45 }, (_, i) => ({ type: "assistant", ts: `2026-11-21T10:00:${String(i).padStart(2, "0")}Z`, text: `step ${i + 1}` }));
  let settings: Record<string, unknown> = { orchestratorModel: "anthropic:claude-opus-5-5", reasoning: "medium", maxRetries: 2, notifications: { channels: { ops: { type: "telegram", botToken: "[REDACTED]" } }, rules: [{ id: "r1", name: "Failures", events: ["task:failed"], channels: ["ops"] }] }, approvalGates: [{ id: "g1", name: "Deploy", hook: "task:complete", handler: "human" }] };
  let branding: Record<string, string> = { productName: "Acme" };
  let logo: { type: string; bytes: number } | undefined;
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 10, 21, 10, 0, ++seq)).toISOString();
  const reply = (status: number, body: unknown, bytes?: Uint8Array, headers: Record<string, string> = {}): ApiResponse => ({ status, body, headers: new Headers(headers), ...(bytes ? { bytes } : {}) });
  const okData = (data: unknown, status = 200) => reply(status, { ok: true, data });
  const notFound = (what: string) => reply(404, { ok: false, error: `${what} not found`, code: "NOT_FOUND" });
  for (const t of [
    { id: "t1", title: "Plan the week", status: "done", assignTo: "coach", description: "Plan" },
    { id: "t2", title: "Log meals", status: "in_progress", assignTo: "coach", description: "Log" },
    { id: "t3", title: "Weigh in", status: "failed", assignTo: "coach", description: "Weigh" },
  ]) tasks.set(t.id, { ...t, updatedAt: now() });

  const api: McpDeps["api"] = vi.fn(async (method, path, body) => {
    calls.push({ method, path, body });
    const url = new URL(path, "http://x");
    const p = url.pathname.replace(/^\/api\/v1/, "");
    const q = url.searchParams;
    let m: RegExpMatchArray | null;
    if (p === "/agents" && method === "GET") return okData([{ name: "coach", role: "Health coach" }, { name: "writer", role: "Writer" }]);
    if (p === "/agents" && method === "POST") return okData({ added: true }, 201);
    if ((m = p.match(/^\/agents\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]!);
      if (!["coach", "writer", "analyst"].includes(name) || (name === "analyst" && !calls.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/agents")))) return notFound("Agent");
      if (method === "PATCH") return okData({ updated: true });
      const patched = calls.filter((c) => c.method === "PATCH" && c.path === `/api/v1/agents/${name}`).reduce((a, c) => ({ ...a, ...(c.body as object) }), {});
      return okData({ name, role: name === "coach" ? "Health coach" : "x", model: "anthropic:claude-opus-5-5", ...patched });
    }
    if ((m = p.match(/^\/agents\/processes\/([^/]+)\/activity$/))) return okData(m[1] === "t2" ? activity : []);
    if (p === "/tasks" && method === "GET") {
      let all = [...tasks.values()];
      if (q.get("status")) all = all.filter((t) => t.status === q.get("status"));
      if (q.get("assignTo")) all = all.filter((t) => t.assignTo === q.get("assignTo"));
      all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!q.get("limit")) return okData(all);
      const limit = Number(q.get("limit"));
      if (q.get("cursor")) all = all.filter((t) => t.updatedAt < q.get("cursor")!);
      const slice = all.slice(0, limit);
      return okData({ tasks: slice, hasMore: all.length > limit, nextCursor: all.length > limit ? slice.at(-1)!.updatedAt : null });
    }
    if (p === "/tasks" && method === "POST") {
      const b = body as Task & { dependsOn?: string[] };
      const missingDeps = (b.dependsOn ?? []).filter((id) => !tasks.has(id));
      if (missingDeps.length) return reply(400, { ok: false, error: `dependsOn: there is no task "${missingDeps[0]}"`, code: "UNKNOWN_DEPENDENCY" });
      if ([...tasks.values()].some((t) => t.title === b.title && t.status !== "done")) return reply(409, { ok: false, error: "A task with this title already exists", code: "CONFLICT" });
      const t = { ...b, id: `t${tasks.size + 1}`, status: "pending", updatedAt: now() };
      tasks.set(t.id, t);
      return okData(t, 201);
    }
    if ((m = p.match(/^\/tasks\/([^/]+)(\/[a-z-]+)?$/))) {
      const t = tasks.get(decodeURIComponent(m[1]!));
      if (!t) return notFound("Task");
      const action = m[2];
      if (!action && method === "GET") return okData({ ...t });
      if (!action && method === "PATCH") { Object.assign(t, body, { updatedAt: now() }); return okData(t); }
      if (!action && method === "DELETE") { tasks.delete(t.id); return okData({ removed: true }); }
      if (action === "/retry") { t.status = "pending"; return okData({ retried: true }); }
      if (action === "/kill") { t.status = "failed"; return okData({ killed: true }); }
      if (action === "/directions") {
        if (t.status === "done" && (body as { mode?: string }).mode === "steer") return reply(409, { ok: false, error: "Cannot steer a finished task", code: "INVALID_STATE" });
        return okData({ action: t.status === "done" ? "continue" : "steer", direction: { id: "d1", message: (body as { message: string }).message } }, 202);
      }
    }
    if (p === "/missions" && method === "GET") return okData([...missions.values()].map(({ data: _d, ...x }) => x));
    if (p === "/missions" && method === "POST") {
      const b = body as Mission;
      const mi = { id: `m${missions.size + 1}`, name: b.name, status: b.status ?? "draft", data: b.data, prompt: b.prompt, updatedAt: now() };
      missions.set(mi.id, mi);
      return okData(mi, 201);
    }
    if ((m = p.match(/^\/missions\/([^/]+)(\/[a-z]+)?$/))) {
      const mi = missions.get(m[1]!);
      if (!mi) return notFound("Mission");
      const action = m[2];
      if (!action && method === "GET") return okData(mi);
      if (!action && method === "PATCH") { Object.assign(mi, body, { updatedAt: now() }); return okData(mi); }
      if (!action && method === "DELETE") { missions.delete(mi.id); for (const t of [...tasks.values()]) if (t.missionId === mi.id) tasks.delete(t.id); return okData({ deleted: true }); }
      if (action === "/execute") {
        mi.status = "active";
        for (const [i, pt] of (JSON.parse(mi.data).tasks as Array<{ title: string; assignTo?: string }>).entries()) {
          tasks.set(`${mi.id}-${i}`, { id: `${mi.id}-${i}`, title: pt.title, description: "", status: "pending", assignTo: pt.assignTo ?? "coach", missionId: mi.id, group: mi.name, updatedAt: now() });
        }
        return okData({ group: mi.name, tasks: [] });
      }
      if (action === "/resume") { mi.status = "active"; return okData({ resumed: true }); }
      if (action === "/abort") { mi.status = "cancelled"; let n = 0; for (const t of tasks.values()) if (t.missionId === mi.id && t.status !== "done") { t.status = "failed"; n++; } return okData({ aborted: n }); }
    }
    if (p === "/playbooks" && method === "GET") return okData([{ name: "weekly-report", description: "A weekly report", parameters: [{ name: "topic", description: "What about", required: true }] }]);
    if ((m = p.match(/^\/playbooks\/([^/]+)\/run$/))) {
      if (m[1] !== "weekly-report") return notFound("Playbook");
      if (!(body as { params: Record<string, unknown> }).params.topic) return reply(400, { ok: false, error: "Parameter validation failed", code: "VALIDATION_ERROR", details: ["topic is required"] });
      return okData({ mission: { id: "m-pb", name: "weekly-report" }, tasks: 2 });
    }
    if (p === "/config" && method === "GET") return okData({ project: "demo", settings: { ...settings, branding } });
    if (p === "/config/settings" && method === "PATCH") {
      const b = body as Record<string, unknown>;
      if (b.branding) { for (const [k, v] of Object.entries(b.branding as Record<string, string>)) { if (v === "") delete branding[k]; else branding[k] = v; } }
      const { branding: _b, ...rest } = b;
      settings = { ...settings, ...rest };
      return okData({ project: "demo", settings: { ...settings, branding } });
    }
    if (p === "/config/branding") return okData({ ...branding, ...(logo ? { logoUrl: "/api/v1/config/branding/logo" } : {}) });
    if (p === "/config/instance-logo" && method === "POST") {
      const blob = body as Blob;
      logo = { type: blob.type, bytes: blob.size };
      return okData({});
    }
    if (p === "/config/instance-logo" && method === "DELETE") { logo = undefined; return okData({}); }
    if (p === "/files/read") return q.get("path") === "assets/logo.png" ? reply(200, "", new Uint8Array(PNG), { "content-type": "image/png" }) : reply(404, { ok: false, error: "File not found" });
    if (p === "/providers") return okData([{ name: "anthropic", hasKey: true, source: "env", envVar: "ANTHROPIC_API_KEY" }, { name: "openai", hasKey: false, source: "none", envVar: "OPENAI_API_KEY" }]);
    if (p === "/providers/models") return okData([
      { id: "claude-haiku-4-5", name: "Claude Haiku", provider: "anthropic", contextWindow: 200000, reasoning: false },
      { id: "claude-opus-5-5", name: "Claude Opus", provider: "anthropic", contextWindow: 1000000, reasoning: true },
      { id: "gpt-6", name: "GPT-6", provider: "openai", contextWindow: 400000, reasoning: true },
    ].filter((x) => !q.get("provider") || x.provider === q.get("provider")));
    if ((m = p.match(/^\/schedules\/([^/]+)$/)) && method === "GET") {
      const s = schedules.get(decodeURIComponent(m[1]!));
      return s ? okData(s) : notFound("Schedule");
    }
    return reply(404, { ok: false, error: `No route ${method} ${p}` });
  });
  return { api, calls, tasks, missions, schedules, logo: () => logo };
}

type Fake = ReturnType<typeof fakeInstance>;

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}) {
  const res = await handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), deps);
  return res;
}
/** A tool call, its result checked as the official MCP client checks it (structuredContent against the outputSchema). */
const call = async (deps: McpDeps, name: string, args: Record<string, unknown> = {}) => {
  const result = (await (await rpc(deps, "tools/call", { name, arguments: args })).json()).result;
  await expectValidOutput(deps, async () => (await (await rpc(deps, "tools/list")).json()).result.tools, name, result);
  return result;
};
const deps = (f: Fake, extra: Partial<McpDeps> = {}): McpDeps => ({ api: f.api, version: "x", pollIntervalMs: 5, publicUrl: "https://polpo.example.com", ...extra });

describe("the tools offered", () => {
  it("lists every default toolset, with honest annotations", async () => {
    const f = fakeInstance();
    const tools = (await (await rpc(deps(f), "tools/list")).json()).result.tools as Array<{ name: string; annotations: Record<string, unknown>; outputSchema?: unknown }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "polpo_tasks_list", "polpo_task_get", "polpo_task_create", "polpo_task_update", "polpo_task_retry", "polpo_task_kill", "polpo_task_direct", "polpo_task_wait", "polpo_task_logs",
      "polpo_missions_list", "polpo_mission_get", "polpo_mission_create", "polpo_mission_update", "polpo_mission_run", "polpo_mission_abort", "polpo_mission_wait",
      "polpo_playbooks_list", "polpo_playbook_run",
      "polpo_agent_get", "polpo_agent_create", "polpo_agent_update",
      "polpo_config_get", "polpo_config_update", "polpo_branding_get", "polpo_branding_update", "polpo_providers_list", "polpo_models_list",
    ]));
    expect(names).not.toContain("polpo_api_get");
    const a = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const n of ["polpo_task_kill", "polpo_mission_abort"]) expect(a[n]).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    for (const n of ["polpo_task_wait", "polpo_mission_wait", "polpo_task_logs", "polpo_config_get", "polpo_models_list"]) expect(a[n]).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    for (const n of ["polpo_task_update", "polpo_config_update", "polpo_branding_update", "polpo_agent_update"]) expect(a[n]).toMatchObject({ idempotentHint: true, destructiveHint: false });
    expect(a.polpo_mission_run).toMatchObject({ openWorldHint: true });
    for (const t of tools) if (t.name !== "polpo_file_read") expect(t.outputSchema, t.name).toBeTruthy();
    for (const n of ["polpo_task_delete", "polpo_mission_delete"]) expect(a[n]).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.length).toBeLessThanOrEqual(101);
  });

  it("config and team changes need the admin scope; reads do not", async () => {
    const f = fakeInstance();
    const names = ((await (await rpc(deps(f, { principal: { kind: "oauth", actor: "x", scopes: ["polpo:read", "polpo:work"] } }), "tools/list")).json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["polpo_config_get", "polpo_branding_get", "polpo_agent_get", "polpo_task_create", "polpo_mission_run"]));
    for (const n of ["polpo_config_update", "polpo_branding_update", "polpo_agent_create", "polpo_agent_update"]) expect(names).not.toContain(n);
  });
});

describe("tasks", () => {
  it("lists with filters and pages with cursors", async () => {
    const f = fakeInstance();
    const first = await call(deps(f), "polpo_tasks_list", { limit: 2 });
    expect(first.structuredContent.items.map((t: Task) => t.id)).toEqual(["t3", "t2"]);
    expect(first.structuredContent.next_cursor).toEqual(expect.any(String));
    const second = await call(deps(f), "polpo_tasks_list", { limit: 2, cursor: first.structuredContent.next_cursor });
    expect(second.structuredContent).toMatchObject({ items: [{ id: "t1" }], next_cursor: null });
    expect((await call(deps(f), "polpo_tasks_list", { status: "failed" })).structuredContent.items).toEqual([expect.objectContaining({ id: "t3" })]);
    expect(await call(deps(f), "polpo_tasks_list", { cursor: "not-a-cursor" })).toMatchObject({ isError: true });
  });

  it("gets a task with its recent activity", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_task_get", { id: "t2", activity: 3 });
    expect(r.structuredContent.task).toMatchObject({ id: "t2", status: "in_progress" });
    expect(r.structuredContent.recent_activity.map((e: { text: string }) => e.text)).toEqual(["step 43", "step 44", "step 45"]);
    expect(r.content[0].text).toContain("recent activity:");
    expect(await call(deps(f), "polpo_task_get", { id: "nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_tasks_list/) }] });
  });

  it("creates a task, refusing unknown agents and duplicate titles with a way out", async () => {
    const f = fakeInstance();
    const bad = await call(deps(f), "polpo_task_create", { title: "x", description: "y", assignTo: "ghost" });
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'No agent "ghost". Agents: coach, writer.' }] });
    const made = await call(deps(f), "polpo_task_create", { title: "Draft post", description: "A post", assignTo: "writer", max_duration_minutes: 2, side_effects: true });
    expect(made.structuredContent.task).toMatchObject({ title: "Draft post", status: "pending", assignTo: "writer" });
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/tasks")!.body).toMatchObject({ maxDuration: 120000, sideEffects: true });
    expect(await call(deps(f), "polpo_task_create", { title: "Draft post", description: "Again", assignTo: "writer" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/another title/) }] });
    // input validation by the schema
    expect(await call(deps(f), "polpo_task_create", { title: "", description: "y", assignTo: "coach" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Input validation error/) }] });
  });

  it("updates only the fields given and says what changed", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_task_update", { id: "t2", assignTo: "writer", max_retries: 3 });
    expect(r.structuredContent.changed).toEqual(["assignTo", "maxRetries"]);
    expect(await call(deps(f), "polpo_task_update", { id: "t2" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Nothing to change/) }] });
    expect(await call(deps(f), "polpo_task_update", { id: "t2", start: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not a draft/) }] });
  });

  it("retries only failed tasks", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_task_retry", { id: "t2" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/only failed tasks/) }] });
    expect((await call(deps(f), "polpo_task_retry", { id: "t3" })).structuredContent).toEqual({ id: "t3", status: "pending" });
  });

  it("stops a task only with confirm", async () => {
    const f = fakeInstance();
    const unconfirmed = await call(deps(f), "polpo_task_kill", { id: "t2" });
    expect(unconfirmed).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(f.calls.some((c) => c.path.endsWith("/kill"))).toBe(false);
    expect((await call(deps(f), "polpo_task_kill", { id: "t2", confirm: true })).structuredContent).toEqual({ id: "t2", killed: true, previous_status: "in_progress" });
    expect(await call(deps(f), "polpo_task_kill", { id: "t1", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/already done/) }] });
  });

  it("sends directions, explaining a refusal", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_task_direct", { id: "t2", message: "use metric units" })).structuredContent).toMatchObject({ action: "steer" });
    expect(f.calls.at(-1)!.body).toEqual({ message: "use metric units", mode: "auto" });
    expect(await call(deps(f), "polpo_task_direct", { id: "t1", message: "x", mode: "steer" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/cannot take this direction/) }] });
  });

  it("waits until the task settles, or times out with its current state", async () => {
    const f = fakeInstance();
    setTimeout(() => { f.tasks.get("t2")!.status = "review"; }, 30);
    const reached = await call(deps(f), "polpo_task_wait", { id: "t2", timeout_seconds: 5 });
    expect(reached.structuredContent).toMatchObject({ reached: true, timed_out: false, task: { id: "t2", status: "review" } });
    const timedOut = await call(deps(f), "polpo_task_wait", { id: "t2", until: ["done"], timeout_seconds: 1 });
    expect(timedOut.structuredContent).toMatchObject({ reached: false, timed_out: true, task: { status: "review" } });
    expect(timedOut.content[0].text).toMatch(/call polpo_task_wait again/);
    expect(await call(deps(f), "polpo_task_wait", { id: "t2", timeout_seconds: 120 })).toMatchObject({ isError: true }); // over the limit
  });

  it("sends progress notifications while waiting, when the client asks", async () => {
    const f = fakeInstance();
    setTimeout(() => { f.tasks.get("t2")!.status = "done"; }, 30);
    const res = await rpc(deps(f), "tools/call", { name: "polpo_task_wait", arguments: { id: "t2", timeout_seconds: 5 }, _meta: { progressToken: "p1" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const progress = events.filter((e) => e.method === "notifications/progress");
    expect(progress.map((e) => e.params.message)).toEqual(["t2: in_progress", "t2: done"]);
    expect(progress[0].params.progressToken).toBe("p1");
    expect(events.at(-1).result.structuredContent).toMatchObject({ reached: true, task: { status: "done" } });
  });

  it("pages the activity backwards from the newest", async () => {
    const f = fakeInstance();
    const last = await call(deps(f), "polpo_task_logs", { id: "t2", limit: 20 });
    expect(last.structuredContent.items.map((e: { text: string }) => e.text).at(-1)).toBe("step 45");
    expect(last.structuredContent.items).toHaveLength(20);
    const older = await call(deps(f), "polpo_task_logs", { id: "t2", limit: 20, cursor: last.structuredContent.next_cursor });
    expect(older.structuredContent.items[0].text).toBe("step 6");
    const oldest = await call(deps(f), "polpo_task_logs", { id: "t2", limit: 20, cursor: older.structuredContent.next_cursor });
    expect(oldest.structuredContent).toMatchObject({ next_cursor: null, total: 45 });
    expect(oldest.structuredContent.items.map((e: { text: string }) => e.text)).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5"]);
    expect((await call(deps(f), "polpo_task_logs", { id: "t1" })).content[0].text).toMatch(/No activity yet/);
  });
});

describe("missions", () => {
  const plan = { tasks: [
    { title: "Research", description: "Find sources", assignTo: "writer" },
    { title: "Write", description: "Draft", assignTo: "writer", dependsOn: ["Research"] },
  ] };

  it("validates the plan as the executor does, and names what to fix", async () => {
    const f = fakeInstance();
    const dup = await call(deps(f), "polpo_mission_create", { name: "R", tasks: [{ title: "A", description: "a" }, { title: "A", description: "b" }] });
    expect(dup).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Duplicate task title "A"/) }] });
    const cycle = await call(deps(f), "polpo_mission_create", { name: "R", tasks: [{ title: "A", description: "a", dependsOn: ["B"] }, { title: "B", description: "b", dependsOn: ["A"] }] });
    expect(cycle).toMatchObject({ isError: true });
    const badCheckpoint = await call(deps(f), "polpo_mission_create", { name: "R", ...plan, checkpoints: [{ name: "Review", afterTasks: ["Research"], blocksTasks: ["Nope"] }] });
    expect(badCheckpoint).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unknown task "Nope"/) }] });
    expect(await call(deps(f), "polpo_mission_create", { name: "R", tasks: [{ title: "A", description: "a", assignTo: "ghost" }] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No agent "ghost"/) }] });
    expect(f.missions.size).toBe(0);
  });

  it("creates a draft, reads it with its tasks, updates and runs it, waits and aborts with confirm", async () => {
    const f = fakeInstance();
    const made = await call(deps(f), "polpo_mission_create", { name: "Report", goal: "A weekly report", ...plan });
    expect(made.structuredContent).toMatchObject({ started: false, mission: { id: "m1", status: "draft" } });
    expect(JSON.parse(f.missions.get("m1")!.data)).toEqual(plan);

    const renamed = await call(deps(f), "polpo_mission_update", { id: "m1", name: "Weekly report", tasks: [...plan.tasks, { title: "Publish", description: "Post it", dependsOn: ["Write"] }] });
    expect(renamed.structuredContent.changed).toEqual(["name", "tasks"]);
    expect(await call(deps(f), "polpo_mission_update", { id: "m1", tasks: [{ title: "X", description: "x", dependsOn: ["Y"] }, { title: "Y", description: "y", dependsOn: ["X"] }] })).toMatchObject({ isError: true });

    const run = await call(deps(f), "polpo_mission_run", { id: "m1" });
    expect(run.structuredContent).toMatchObject({ id: "m1", action: "execute" });
    expect(await call(deps(f), "polpo_mission_run", { id: "m1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/already running/) }] });
    expect(await call(deps(f), "polpo_mission_update", { id: "m1", tasks: plan.tasks })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Abort it first/) }] });

    const got = await call(deps(f), "polpo_mission_get", { id: "m1" });
    expect(got.structuredContent).toMatchObject({ mission: { status: "active" }, task_counts: { pending: 3 } });
    expect(got.structuredContent.mission.data).toBeUndefined();
    expect(got.content[0].text).toContain("3. Publish (after Write)");
    expect((await call(deps(f), "polpo_tasks_list", { mission_id: "m1" })).structuredContent.items).toHaveLength(3);

    const waited = await call(deps(f), "polpo_mission_wait", { id: "m1", timeout_seconds: 1 });
    expect(waited.structuredContent).toMatchObject({ reached: false, timed_out: true, mission: { status: "active" }, task_counts: { pending: 3 } });

    const unconfirmed = await call(deps(f), "polpo_mission_abort", { id: "m1" });
    expect(unconfirmed).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/stops 3 unfinished task\(s\).*confirm: true/s) }] });
    expect(f.missions.get("m1")!.status).toBe("active");
    expect((await call(deps(f), "polpo_mission_abort", { id: "m1", confirm: true })).structuredContent).toEqual({ id: "m1", aborted_tasks: 3 });
    expect((await call(deps(f), "polpo_mission_wait", { id: "m1" })).structuredContent).toMatchObject({ reached: true, mission: { status: "cancelled" } });
  });

  it("polpo_mission_wait returns for a recurring mission once its run finished, with the run's outcome (live: it never settled)", async () => {
    const f = fakeInstance();
    f.missions.set("mr", { id: "mr", name: "Digest", status: "recurring", data: JSON.stringify(plan), updatedAt: "2026-11-21T10:00:00Z", executionCount: 2, schedule: "0 3 1 1 *" });
    f.schedules.set("mr", { missionId: "mr", expression: "0 3 1 1 *", recurring: true, enabled: true, nextRunAt: "2027-01-01T03:00:00.000Z" });
    // run #1 finished long ago; run #2 is under way
    f.tasks.set("r1", { id: "r1", title: "Write", description: "", status: "done", assignTo: "coach", missionId: "mr", group: "Digest", updatedAt: "2026-11-21T09:00:00Z" } as Task);
    f.tasks.set("r2", { id: "r2", title: "Write", description: "", status: "in_progress", assignTo: "coach", missionId: "mr", group: "Digest #2", updatedAt: "2026-11-21T10:00:00Z" } as Task);
    const running = await call(deps(f), "polpo_mission_wait", { id: "mr", timeout_seconds: 1 });
    expect(running.structuredContent).toMatchObject({ reached: false, timed_out: true });
    expect(running.content[0].text).toMatch(/a run in progress/);
    // the run ends (a failure counts: the run is over)
    f.tasks.get("r2")!.status = "failed";
    const done = await call(deps(f), "polpo_mission_wait", { id: "mr", timeout_seconds: 5 });
    expect(done.structuredContent).toMatchObject({ reached: true, timed_out: false, mission: { status: "recurring" }, run: { number: 2, outcome: "failed", task_counts: { failed: 1 } } });
    expect(done.content[0].text).toMatch(/run #2 failed .* runs again on its schedule \(0 3 1 1 \*\), next at 2027-01-01T03:00/);
    // paused: it does not say it runs again (live: "It runs again on its schedule" on a paused one)
    f.schedules.get("mr")!.enabled = false;
    const paused = await call(deps(f), "polpo_mission_wait", { id: "mr", timeout_seconds: 5 });
    expect(paused.content[0].text).toMatch(/schedule \(0 3 1 1 \*\) is paused: it does not run again until resumed/);
    expect(paused.content[0].text).not.toMatch(/runs again on its schedule/);
    // never ran: it waits for its first run (and says how to start one)
    f.missions.set("mn", { id: "mn", name: "Never", status: "recurring", data: JSON.stringify(plan), updatedAt: "2026-11-21T10:00:00Z", executionCount: 0 });
    const never = await call(deps(f), "polpo_mission_wait", { id: "mn", timeout_seconds: 1 });
    expect(never.structuredContent).toMatchObject({ reached: false });
    expect(never.content[0].text).toMatch(/not run yet.*polpo_schedule_run/);
    f.schedules.set("mn", { missionId: "mn", expression: "0 3 1 1 *", recurring: true, enabled: false, nextRunAt: "2027-01-01T03:00:00.000Z" });
    const neverPaused = await call(deps(f), "polpo_mission_wait", { id: "mn", timeout_seconds: 1 });
    expect(neverPaused.content[0].text).toMatch(/not run yet, and its schedule is paused/);
  });

  it("polpo_mission_delete and polpo_task_delete: confirm, not while running, then gone", async () => {
    const f = fakeInstance();
    await call(deps(f), "polpo_mission_create", { name: "Old", ...plan, run: true });
    expect(await call(deps(f), "polpo_mission_delete", { id: "m1", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/abort it first/) }] });
    await call(deps(f), "polpo_mission_abort", { id: "m1", confirm: true });
    expect(await call(deps(f), "polpo_mission_delete", { id: "m1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/"Old" \(cancelled, \d+ tasks\).*confirm: true/) }] });
    expect(f.missions.has("m1")).toBe(true);
    expect((await call(deps(f), "polpo_mission_delete", { id: "m1", confirm: true })).structuredContent).toEqual({ deleted: "m1" });
    expect(f.missions.has("m1")).toBe(false);
    expect(await call(deps(f), "polpo_mission_delete", { id: "m1", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/There is no mission m1/) }] });

    expect(await call(deps(f), "polpo_task_delete", { id: "t2", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/in_progress: stop it first with polpo_task_kill/) }] });
    expect(await call(deps(f), "polpo_task_delete", { id: "t1" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect((await call(deps(f), "polpo_task_delete", { id: "t1", confirm: true })).structuredContent).toEqual({ deleted: "t1" });
    expect(f.tasks.has("t1")).toBe(false);
  });

  it("polpo_task_create refuses a dependsOn that names no task, with the next step", async () => {
    const f = fakeInstance();
    const bad = await call(deps(f), "polpo_task_create", { title: "E2E bad dep", description: "x", assignTo: "coach", dependsOn: ["no-such-task-e2e"] });
    expect(bad).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/there is no task "no-such-task-e2e".*polpo_tasks_list/) }] });
    expect([...f.tasks.values()].some((t) => t.title === "E2E bad dep")).toBe(false);
    expect((await call(deps(f), "polpo_task_create", { title: "After", description: "x", assignTo: "coach", dependsOn: ["t1"] })).isError).toBeFalsy();
  });

  it("polpo_agent_update clears an agent's computers with null or []", async () => {
    const f = fakeInstance();
    for (const computers of [null, []]) {
      const r = await call(deps(f), "polpo_agent_update", { name: "coach", computers });
      expect(r.isError).toBeFalsy();
      expect(f.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ computers });
    }
  });

  it("creates and starts at once with run: true; lists missions", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_mission_create", { name: "Now", ...plan, run: true })).structuredContent).toMatchObject({ started: true });
    expect((await call(deps(f), "polpo_missions_list", { status: "active" })).structuredContent.items).toEqual([expect.objectContaining({ id: "m1", name: "Now" })]);
  });

  it("runs playbooks with their parameters", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_playbooks_list")).content[0].text).toContain("params: topic*");
    expect(await call(deps(f), "polpo_playbook_run", { name: "weekly-report" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/topic is required/) }] });
    expect(await call(deps(f), "polpo_playbook_run", { name: "nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_playbooks_list/) }] });
    expect((await call(deps(f), "polpo_playbook_run", { name: "weekly-report", params: { topic: "sales" } })).content[0].text).toMatch(/as mission m-pb/);
  });
});

describe("the team", () => {
  it("creates an agent once, reads and updates it", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_agent_create", { name: "coach" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/already an agent/) }] });
    expect(await call(deps(f), "polpo_agent_create", { name: "bad name!" })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_agent_create", { name: "analyst", role: "Analyst", model: "anthropic:claude-opus-5-5" })).isError).toBeFalsy();
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/agents")!.body).toEqual({ name: "analyst", role: "Analyst", model: "anthropic:claude-opus-5-5" });
    const upd = await call(deps(f), "polpo_agent_update", { name: "coach", role: "Nutrition coach" });
    expect(upd.structuredContent.changed).toEqual(["role"]);
    expect((await call(deps(f), "polpo_agent_get", { name: "coach" })).structuredContent.agent.role).toBe("Nutrition coach");
  });
});

describe("configuration", () => {
  it("reads settings and summaries without secrets", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_config_get");
    expect(r.structuredContent).toMatchObject({
      project: "demo", settings: { orchestratorModel: "anthropic:claude-opus-5-5", reasoning: "medium", maxRetries: 2 },
      channels: [{ name: "ops", type: "telegram" }], rules: [{ id: "r1", name: "Failures" }], gates: [{ id: "g1", hook: "task:complete" }],
    });
    expect(JSON.stringify(r)).not.toContain("botToken");
  });

  it("updates settings, checking models, and says what changed", async () => {
    const f = fakeInstance();
    expect(await call(deps(f), "polpo_config_update", {})).toMatchObject({ isError: true });
    expect(await call(deps(f), "polpo_config_update", { orchestrator_model: "anthropic:claude-nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_models_list/) }] });
    const r = await call(deps(f), "polpo_config_update", { orchestrator_model: { primary: "anthropic:claude-opus-5-5", fallbacks: ["openai:gpt-6"] }, reasoning: "medium" });
    expect(r.structuredContent.changed).toEqual(["orchestratorModel"]);
    expect((await call(deps(f), "polpo_config_update", { orchestrator_model: "gateway:own-model", allow_unlisted: true })).isError).toBeFalsy();
  });

  it("updates the name and tagline, and the logo from base64 or a file", async () => {
    const f = fakeInstance();
    const text = await call(deps(f), "polpo_branding_update", { product_name: "Acme Ops", tagline: "Agents at work" });
    expect(text.structuredContent).toMatchObject({ changed: ["productName", "tagline"], branding: { productName: "Acme Ops", tagline: "Agents at work" } });
    const b64 = await call(deps(f), "polpo_branding_update", { logo: { base64: PNG.toString("base64"), mime_type: "image/png" } });
    expect(b64.structuredContent).toMatchObject({ changed: ["logo"], branding: { logoUrl: "/api/v1/config/branding/logo" } });
    expect(f.logo()).toEqual({ type: "image/png", bytes: PNG.byteLength });
    expect(await call(deps(f), "polpo_branding_update", { logo: { base64: PNG.toString("base64"), mime_type: "image/jpeg" } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/mime_type image\/png/) }] });
    expect(await call(deps(f), "polpo_branding_update", { logo: { base64: Buffer.from("hello").toString("base64"), mime_type: "image/png" } })).toMatchObject({ isError: true });
    expect((await call(deps(f), "polpo_branding_update", { logo: { path: "assets/logo.png" } })).structuredContent.changed).toEqual(["logo"]);
    expect(await call(deps(f), "polpo_branding_update", { logo: { path: "missing.png" } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_files_search/) }] });
    expect((await call(deps(f), "polpo_branding_update", { remove_logo: true })).structuredContent.branding.logoUrl).toBeUndefined();
    expect((await call(deps(f), "polpo_branding_get")).structuredContent).toEqual({ productName: "Acme Ops", tagline: "Agents at work" });
  });

  it("lists providers with the dashboard link for keys, and models with filters", async () => {
    const f = fakeInstance();
    const p = await call(deps(f), "polpo_providers_list");
    expect(p.structuredContent).toMatchObject({ setup_url: "https://polpo.example.com/config?section=providers", items: [{ name: "anthropic", configured: true }, { name: "openai", configured: false }] });
    expect((await call(deps(f), "polpo_providers_list", { configured: false })).structuredContent.items).toEqual([expect.objectContaining({ name: "openai" })]);
    const m = await call(deps(f), "polpo_models_list", { provider: "anthropic", text: "opus" });
    expect(m.structuredContent.items).toEqual([expect.objectContaining({ spec: "anthropic:claude-opus-5-5", reasoning: true })]);
    const keyed = await call(deps(f), "polpo_models_list", { configured: true, limit: 1 });
    expect(keyed.structuredContent).toMatchObject({ items: [{ spec: "anthropic:claude-haiku-4-5", configured: true }], total: 2 });
  });
});

describe("the logo from a URL", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
      if (req.url === "/moved") { res.writeHead(302, { location: "/logo.png" }); res.end(); return; }
      if (req.url === "/to-private") { res.writeHead(302, { location: "https://intranet.example/logo.png" }); res.end(); return; }
      if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); return; }
      if (req.url === "/huge") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("fetches it (following redirects) and uploads it", async () => {
    const f = fakeInstance();
    const r = await call(deps(f, { allowPrivateFetch: true }), "polpo_branding_update", { logo: { url: `${base}/moved` } });
    expect(r.structuredContent.changed).toEqual(["logo"]);
    expect(f.logo()).toEqual({ type: "image/png", bytes: PNG.byteLength });
  });

  it("refuses pages that are not images and images over the limit", async () => {
    const f = fakeInstance();
    expect(await call(deps(f, { allowPrivateFetch: true }), "polpo_branding_update", { logo: { url: `${base}/page` } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not point to a PNG/) }] });
    expect(await call(deps(f, { allowPrivateFetch: true }), "polpo_branding_update", { logo: { url: `${base}/huge` } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/larger than 4 MB/) }] });
    expect(f.logo()).toBeUndefined();
  });

  it("never fetches private addresses, also after a redirect, and only https", async () => {
    const f = fakeInstance();
    // without the test switch, the local server is private
    expect(await call(deps(f), "polpo_branding_update", { logo: { url: `${base}/logo.png` } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/must be https/) }] });
    const resolveHost = async (h: string) => (h === "intranet.example" ? ["10.0.0.7"] : h === "cdn.example" ? ["93.184.216.34"] : []);
    const viaDns = await fetchPublicImage({ api: f.api, version: "x", resolveHost }, "https://intranet.example/logo.png");
    expect(viaDns).toMatchObject({ ok: false, error: expect.stringMatching(/private or local/) });
    expect(await fetchPublicImage({ api: f.api, version: "x", resolveHost }, "https://127.0.0.1/logo.png")).toMatchObject({ ok: false, error: expect.stringMatching(/private/) });
    // a public host that redirects inside the network
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://intranet.example/logo.png" } })) as unknown as typeof fetch;
    expect(await fetchPublicImage({ api: f.api, version: "x", resolveHost, fetch: fetchImpl }, "https://cdn.example/logo.png")).toMatchObject({ ok: false, error: expect.stringMatching(/private or local/) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recognises image types by their bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg"))).toBeUndefined();
  });
});
