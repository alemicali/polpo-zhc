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
  /** Other tasks' run logs (as GET /agents/processes/:id/activity returns them). */
  const logs = new Map<string, Array<Record<string, unknown>>>();
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
    if ((m = p.match(/^\/agents\/processes\/([^/]+)\/activity$/))) return okData(m[1] === "t2" ? activity : (logs.get(m[1]!) ?? []));
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
      const scope = (b as { toolScope?: { connectors?: unknown } }).toolScope;
      if (Array.isArray(scope?.connectors) && scope.connectors.includes("notion")) return reply(400, { ok: false, error: 'Invalid toolScope: connectors: agent "writer" has no access to Notion (notion)', code: "INVALID_TOOL_SCOPE" });
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
        return okData({
          action: t.status === "done" ? "continue" : "steer", direction: { id: "d1", message: (body as { message: string }).message },
          ...(t.status === "done" ? { reopenedMission: { id: "m1", name: "Sito", prevStatus: "completed" } } : {}),
        }, 202);
      }
    }
    if (p === "/missions" && method === "GET") return okData([...missions.values()].map(({ data: _d, ...x }) => x));
    if (p === "/missions" && method === "POST") {
      const b = body as Mission;
      const mi = { id: `m${missions.size + 1}`, name: b.name, status: b.status ?? "draft", data: b.data, prompt: b.prompt, updatedAt: now(), ...(b.budgetUsd !== undefined ? { budgetUsd: b.budgetUsd } : {}) };
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
    const lin = { id: "lin", name: "Lin", transport: { type: "http", url: "https://mcp.lin.example/mcp" }, auth: { type: "none" }, access: { agents: ["coach"], polpo: false }, enabled: true, status: "connected", toolCount: 3, toolPolicy: { delete_issue: "off" } };
    const notion = { ...lin, id: "notion", name: "Notion", access: { agents: ["writer"], polpo: true } };
    if (p === "/connectors" && method === "GET") return okData({ connectors: [lin, notion] });
    if (p === "/connectors/lin" && method === "GET") return okData(lin);
    if (p === "/connectors/lin/tools" && method === "GET") return okData({ tools: [
      { name: "create_issue", description: "Create an issue", policy: "allow" }, { name: "list_issues", policy: "allow" }, { name: "delete_issue", policy: "off" },
    ] });
    return reply(404, { ok: false, error: `No route ${method} ${p}` });
  });
  return { api, calls, tasks, missions, schedules, logs, logo: () => logo };
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
    // every Configuration section is on by default (the settings toolset), the task and mission cards, computer_get and computer_webhooks, WhatsApp Business (7), skill bundles (4), skill versions (3), agent versions (8), artifact uploads (2), hosted MCP servers (12: templates and install), agent tests (1), agent suites (10: list, get, save, delete, run, run_get; evals: trend, baseline, review, the suite card), deploy gates (1), agent suites phase 4 (8: record, replay, cassette, cassette_edit, generate; target_suites, target_suite_save, target_suite_run for hosted servers and missions), agent suites phase 5 (9: benchmark_save, benchmark_delete, benchmark_run, benchmark_get, benchmark_leaderboard, benchmark_compare, playground_send, playground_promote, the benchmark card benchmark_show), triggers (10: list, get, deliveries, create, update, delete, test, run_actions, auth, the trigger card trigger_show), decisions (4: decide, decisions, decision_resolve, the decision card decision_show), channels parity (8: channel_access_set, peer_presence, peer_link, slack_status, notifications_list, notifications_stats, wabiz_contact, wabiz_contact_erase), communication lines (1: agent_lines): 245 tools at most for a full-access client; media (5: image_generate, image_edit, media_log, media_status, the media card image_show), computers' live view (4: computer_desktop, computer_takeover, computer_release, the computer card computer_show); data transactions (1: data_transaction)
    expect(tools.length).toBeLessThanOrEqual(261);
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

  it("lists by time (updated_since: relative or ISO) with when each was updated", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_tasks_list", { updated_since: "24h" });
    const path = f.calls.filter((c) => c.path.startsWith("/api/v1/tasks?")).at(-1)!.path;
    const since = new URL(path, "http://x").searchParams.get("updatedSince")!;
    expect(Math.abs(Date.parse(since) - (Date.now() - 24 * 3_600_000))).toBeLessThan(60_000);
    expect(r.content[0].text).toMatch(/t3 \[failed\] Weigh in → coach · updated 2026-11-21T10:00:0\d\.000Z/);
    expect(r.structuredContent.items[0]).toMatchObject({ id: "t3", updatedAt: expect.any(String) });
    await call(deps(f), "polpo_tasks_list", { updated_since: "2026-11-20T00:00:00Z" });
    expect(new URL(f.calls.filter((c) => c.path.startsWith("/api/v1/tasks?")).at(-1)!.path, "http://x").searchParams.get("updatedSince")).toBe("2026-11-20T00:00:00.000Z");
    expect(await call(deps(f), "polpo_tasks_list", { updated_since: "last week" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/neither a duration/) }] });
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

  it("maps connectors / connector_tools / allowed_tools to the task's toolScope, and inherit_tools clears it", async () => {
    const f = fakeInstance();
    const made = await call(deps(f), "polpo_task_create", {
      title: "Send recap", description: "Email the recap", assignTo: "writer",
      connectors: ["gmail-2"], connector_tools: { "gmail-2": ["send_email"] }, allowed_tools: ["read"],
    });
    expect(made.isError).toBeFalsy();
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/tasks")!.body).toMatchObject({
      toolScope: { connectors: ["gmail-2"], connectorTools: { "gmail-2": ["send_email"] }, allowedTools: ["read"] },
    });
    expect(made.content[0].text).toMatch(/tools restricted: gmail-2 \(1 tool\); built-in: read/);
    // no scope arguments: no toolScope sent (the task inherits the agent's tools)
    await call(deps(f), "polpo_task_create", { title: "Plain", description: "d", assignTo: "writer" });
    expect(f.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/tasks").at(-1)!.body).not.toHaveProperty("toolScope");
    // a grant is refused by the server with a way out
    const bad = await call(deps(f), "polpo_task_create", { title: "Notion", description: "d", assignTo: "writer", connectors: ["notion"] });
    expect(bad).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/no access to Notion[\s\S]*polpo_connectors_list \{ agent \}/) }] });
    // update: replace, then clear
    const id = made.structuredContent.task.id;
    let r = await call(deps(f), "polpo_task_update", { id, connectors: "none" });
    expect(r.structuredContent.changed).toEqual(["toolScope"]);
    expect(f.calls.at(-1)!.body).toEqual({ toolScope: { connectors: "none" } });
    r = await call(deps(f), "polpo_task_update", { id, inherit_tools: true });
    expect(f.calls.at(-1)!.body).toEqual({ toolScope: null });
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
    // continuing a task of a finished mission reopens it: the tool says so
    const continued = await call(deps(f), "polpo_task_direct", { id: "t1", message: "go on", mode: "continue" });
    expect(continued.structuredContent).toMatchObject({ action: "continue", reopened_mission: { id: "m1", name: "Sito", previous_status: "completed" } });
    expect(continued.content[0].text).toMatch(/mission "Sito" was completed and is active again/);
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

  it("a harness run (Claude Code): its transcript, Polpo tools (host) and usage in the logs; where and with what it ran in get and logs", async () => {
    const f = fakeInstance();
    const run = {
      runId: "r1", startedAt: "2026-11-22T14:55:55.499Z", endedAt: "2026-11-22T14:56:22.828Z", status: "completed", engine: "claude-code",
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", auth: { kind: "bedrock", region: "us-east-1" }, permissionMode: "allow-all",
      computer: { id: "coder-box", kind: "daytona", provider: "daytona", daytonaApi: "v2", remoteId: "vm-1" },
      sandbox: { provider: "daytona", ephemeral: false }, egress: { mode: "proxy", proxy: "home", tailscale: true },
      session: { resumed: false, bootstrapMs: 14800 }, cost: { harnessUsd: 0.0723, tokens: 144585 }, budgetUsd: 2, durationMs: 26626, exitCode: 0,
    };
    f.tasks.set("t9", { id: "t9", title: "Verify Claude Code", status: "done", assignTo: "coder", description: "Write hello.txt", updatedAt: "2026-11-22T14:56:23Z", runs: [run] } as any);
    // the run log as the runner writes it for a harness run (lumea, task M5hgPb1B0ORvFKD7lgJgg)
    f.logs.set("t9", [
      { _run: true, runId: "r1", taskId: "t9", agentName: "coder", startedAt: "2026-11-22T14:55:55.499Z" },
      { ts: "2026-11-22T14:55:55.534Z", event: "spawned" },
      { ts: "2026-11-22T14:56:13.597Z", type: "log", message: "Claude Code session started in 14.8 s on coder-box" },
      { ts: "2026-11-22T14:56:18.724Z", type: "assistant", text: "Creo il file hello.txt" },
      { ts: "2026-11-22T14:56:18.830Z", type: "tool_use", tool: "write", toolId: "c1", input: { file_path: "hello.txt", content: "ciao" } },
      { ts: "2026-11-22T14:56:18.840Z", type: "tool_result", toolId: "c1", tool: "write", content: "{\"type\":\"create\"}" },
      { ts: "2026-11-22T14:56:21.000Z", type: "tool_use", tool: "register_outcome", toolId: "c2", input: { type: "text", label: "hello" }, host: true },
      { ts: "2026-11-22T14:56:22.156Z", type: "usage", harness: "claude-code", inputTokens: 144154, outputTokens: 431, cacheReadTokens: 95726, cacheWriteTokens: 48411, totalTokens: 144585, costUsd: 0.07225835 },
      { ts: "2026-11-22T14:56:22.828Z", event: "done", data: { status: "completed", exitCode: 0, duration: 26626 } },
    ]);
    const logs = await call(deps(f), "polpo_task_logs", { id: "t9" });
    expectValidOutput(logs);
    expect(logs.structuredContent.total).toBe(9);
    expect(logs.structuredContent.items.find((e: any) => e.tool === "register_outcome")).toMatchObject({ host: true });
    const text = logs.content[0].text as string;
    expect(text).toMatch(/tool_use: write \{"file_path":"hello\.txt"/);
    expect(text).toMatch(/tool_use: register_outcome \(Polpo tool\)/);
    expect(text).toMatch(/usage: 144154 in, 431 out, 95726 cache read, \$0\.0723 \(claude-code\)/);
    expect(text).toMatch(/log: Claude Code session started in 14\.8 s/);
    expect(text).toMatch(/runs:\n- r1 \[completed\] us\.anthropic\.claude-haiku[^\n]* \(Claude Code · Harness\) via Bedrock \(us-east-1\) · on computer coder-box \(daytona v2\) · egress home via Tailscale · new session \(14\.8 s\) · \$0\.0723 of \$2/);
    expect(logs.structuredContent.runs).toEqual([expect.objectContaining({ engine: "claude-code", computer: expect.objectContaining({ id: "coder-box" }) })]);

    const got = await call(deps(f), "polpo_task_get", { id: "t9", activity: 0 });
    expectValidOutput(got);
    expect(got.structuredContent.runs).toEqual([expect.objectContaining({ engine: "claude-code", auth: { kind: "bedrock", region: "us-east-1" }, session: { resumed: false, bootstrapMs: 14800 } })]);
    expect(got.content[0].text).toMatch(/runs \(where and with what\):\n- r1 \[completed\] us\.anthropic\.claude-haiku[^\n]* \(Claude Code · Harness\)/);
    // a task on Polpo's engine without runs recorded yet: an empty list
    expect((await call(deps(f), "polpo_task_get", { id: "t1", activity: 0 })).structuredContent.runs).toEqual([]);
  });

  it("what every run of a task cost in all (not the latest): polpo_task_get text and structured, polpo_tasks_list rows", async () => {
    const f = fakeInstance();
    const base = { computer: { id: "host", kind: "host" }, egress: { mode: "direct" } };
    const runs = [
      { ...base, runId: "k1", startedAt: "2026-11-22T10:00:00Z", status: "failed", engine: "claude-code", cost: { harnessUsd: 1.2, tokens: 9000 } },
      { ...base, runId: "k2", startedAt: "2026-11-22T10:05:00Z", status: "completed", engine: "claude-code", continuation: true, cost: { harnessUsd: 0.3, tokens: 1000 } },
    ];
    f.tasks.set("t7", { id: "t7", title: "Costly task", status: "done", assignTo: "coder", description: "x", updatedAt: "2026-11-22T10:06:00Z", runs } as any);
    const got = await call(deps(f), "polpo_task_get", { id: "t7", activity: 0 });
    expectValidOutput(got);
    expect(got.structuredContent.cost).toMatchObject({ usd: 1.5, harnessUsd: 1.5, tokens: 10000, runs: 2, lastRunUsd: 0.3, partial: false });
    expect(got.structuredContent.cost.perRun.map((r: any) => [r.runId, r.usd])).toEqual([["k1", 1.2], ["k2", 0.3]]);
    expect(got.content[0].text).toMatch(/cost: \$1\.50 in all · 2 runs · latest \$0\.30 · 10,000 tokens/);
    const list = await call(deps(f), "polpo_tasks_list", {});
    expectValidOutput(list);
    expect(list.structuredContent.items.find((t: any) => t.id === "t7").cost).toEqual({ usd: 1.5, tokens: 10000, runs: 2 });
    expect(list.content[0].text).toMatch(/t7 \[done\] Costly task → coder · \$1\.50 over 2 runs/);
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

  it("sets a mission's budget, and shows what it cost (text and structured) in the list and in the mission", async () => {
    const f = fakeInstance();
    const made = await call(deps(f), "polpo_mission_create", { name: "Report", ...plan, budget_usd: 5 });
    expect(f.calls.find((c) => c.method === "POST" && c.path.endsWith("/missions"))!.body).toMatchObject({ budgetUsd: 5 });
    expect(made.structuredContent.mission).toMatchObject({ budgetUsd: 5 });

    const cost = {
      currency: "USD", usd: 6.2, harnessUsd: 6, modelUsd: 0.2, tokens: 12000, runs: 4, tasks: 2, unpricedRuns: 0, runsActive: 0,
      byAgent: [{ agent: "coach", usd: 6, harnessUsd: 6, modelUsd: 0, tokens: 2000, runs: 3 }, { agent: "writer", usd: 0.2, harnessUsd: 0, modelUsd: 0.2, tokens: 10000, runs: 1 }],
      byEngine: [{ engine: "claude-code", usd: 6, harnessUsd: 6, modelUsd: 0, tokens: 2000, runs: 3 }, { engine: "polpo", usd: 0.2, harnessUsd: 0, modelUsd: 0.2, tokens: 10000, runs: 1 }],
      partial: false, budgetUsd: 5, remainingUsd: -1.2, budgetUsed: 1.24, overBudget: true,
    };
    Object.assign(f.missions.get("m1")!, { status: "paused", pauseReason: "budget", cost });
    const got = await call(deps(f), "polpo_mission_get", { id: "m1" });
    expect(got.structuredContent.cost).toMatchObject({ usd: 6.2, overBudget: true });
    expect(got.structuredContent.mission.cost).toBeUndefined();
    expect(got.content[0].text).toMatch(/\[paused: over budget\]/);
    expect(got.content[0].text).toMatch(/cost: \$6\.20 · 12,000 tokens · 4 runs over 2 tasks/);
    expect(got.content[0].text).toMatch(/budget: \$5\.00 · 124% used · OVER BUDGET/);
    expect(got.content[0].text).toMatch(/by engine: Claude Code \$6\.00 \(3\), Polpo \$0\.20 \(1\)/);

    f.missions.get("m1")!.cost = { usd: 6.2, tokens: 12000, runs: 4, budgetUsd: 5, overBudget: true } as never;
    const listed = await call(deps(f), "polpo_missions_list", {});
    expect(listed.structuredContent.items[0]).toMatchObject({ id: "m1", cost_usd: 6.2, budget_usd: 5, over_budget: true });
    expect(listed.content[0].text).toMatch(/- m1 \[paused: budget\] Report · \$6\.20 of \$5\.00 \(over budget\)/);

    // raising it: the update says the mission goes on by itself
    const raised = await call(deps(f), "polpo_mission_update", { id: "m1", budget_usd: 10 });
    expect(raised.structuredContent.changed).toEqual(["budget"]);
    expect(raised.content[0].text).toMatch(/goes on by itself/);
    expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", body: { budgetUsd: 10 } });
    // clearing it
    await call(deps(f), "polpo_mission_update", { id: "m1", budget_usd: null });
    expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", body: { budgetUsd: null } });
    expect(await call(deps(f), "polpo_mission_create", { name: "Bad", ...plan, budget_usd: -3 })).toMatchObject({ isError: true });
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
  }, 20_000); // runs a mission and waits for it: slow on CI runners

  it("tasks a decision left out are not reached (never done): polpo_mission_get counts, polpo_tasks_list rows, polpo_task_get", async () => {
    const f = fakeInstance();
    f.missions.set("md", { id: "md", name: "Ticket", status: "completed", data: JSON.stringify(plan), updatedAt: "2026-11-21T10:00:00Z" });
    const skipped = { reason: "decision", node: "route", branch: "support", answer: "decision: support (0.81)", confidence: 0.81 };
    const at = "2026-11-21T11:00:00Z";
    f.tasks.set("d1", { id: "d1", title: "Triage", status: "done", assignTo: "coach", description: "x", missionId: "md", group: "Ticket", updatedAt: at, result: { exitCode: 0, stdout: "read", stderr: "", duration: 1 } } as never);
    f.tasks.set("d2", { id: "d2", title: "Refund", status: "done", assignTo: "coach", description: "x", missionId: "md", group: "Ticket", updatedAt: at, result: { exitCode: 0, stdout: 'Skipped: the decision "route" took the branch "support" (decision: support (0.81))', stderr: "", duration: 0, skipped } } as never);
    // skipped before the marker existed: only the result text
    f.tasks.set("d3", { id: "d3", title: "Escalate", status: "done", assignTo: "coach", description: "x", missionId: "md", group: "Ticket", updatedAt: at, result: { exitCode: 0, stdout: 'Skipped: the decision "route" took the branch "support" (decision: support (0.81))', stderr: "", duration: 0 } } as never);
    const got = await call(deps(f), "polpo_mission_get", { id: "md" });
    expect(got.structuredContent.task_counts).toEqual({ done: 1, not_reached: 2 });
    expect(got.content[0].text).toContain("tasks: 1 done, 2 not reached");
    expect(got.content[0].text).toMatch(/d2 \[not reached\] Refund.*Not reached: the decision "route" chose "support"/);
    const list = await call(deps(f), "polpo_tasks_list", { mission_id: "md" });
    expect(list.structuredContent.items.find((x: { id: string }) => x.id === "d3")).toMatchObject({ status: "done", not_reached: { node: "route", branch: "support" } });
    expect(list.structuredContent.items.find((x: { id: string }) => x.id === "d1").not_reached).toBeUndefined();
    const one = await call(deps(f), "polpo_task_get", { id: "d2", activity: 0 });
    expect(one.structuredContent.not_reached).toMatchObject({ node: "route", branch: "support", confidence: 0.81 });
    expect(one.content[0].text).toMatch(/^d2 \[not reached\] Refund/);
    expect(one.content[0].text).toContain("closed without running");
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
  }, 20_000); // waits on a real scheduled run: slow on CI runners

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
  }, 20_000); // many tool calls through the whole MCP server: slow on busy CI runners

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

  it("a plan task's connectors / connector_tools / allowed_tools become its toolScope", async () => {
    const f = fakeInstance();
    const r = await call(deps(f), "polpo_mission_create", { name: "Scoped", tasks: [
      { title: "Send", description: "send it", assignTo: "writer", connectors: ["gmail-2"], connector_tools: { "gmail-2": ["send_email"] } },
      { title: "Plain", description: "no scope", assignTo: "writer" },
    ] });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse((f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/missions")!.body as { data: string }).data);
    expect(data.tasks[0]).toMatchObject({ title: "Send", toolScope: { connectors: ["gmail-2"], connectorTools: { "gmail-2": ["send_email"] } } });
    expect(data.tasks[0]).not.toHaveProperty("connectors");
    expect(data.tasks[1]).not.toHaveProperty("toolScope");
    const bad = await call(deps(f), "polpo_mission_create", { name: "Bad", tasks: [{ title: "A", description: "a", connectors: "all" }] });
    expect(bad).toMatchObject({ isError: true });
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

describe("connector tools per agent", () => {
  it("polpo_agent_create / polpo_agent_update take connector_tools and send connectorTools; null clears it", async () => {
    const f = fakeInstance();
    expect((await call(deps(f), "polpo_agent_create", { name: "analyst", connector_tools: { lin: ["create_issue"], notion: "*" } })).isError).toBeFalsy();
    expect(f.calls.find((c) => c.method === "POST" && c.path === "/api/v1/agents")!.body).toEqual({ name: "analyst", connectorTools: { lin: ["create_issue"], notion: "*" } });
    const upd = await call(deps(f), "polpo_agent_update", { name: "coach", connector_tools: { lin: ["create_issue", "gone_tool"] } });
    expect(upd.isError).toBeFalsy();
    expect(upd.structuredContent.changed).toEqual(["connectorTools"]);
    expect(f.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ connectorTools: { lin: ["create_issue", "gone_tool"] } });
    expect((await call(deps(f), "polpo_agent_update", { name: "writer", connector_tools: null })).isError).toBeFalsy();
    expect(f.calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({ connectorTools: null });
    expect((await call(deps(f), "polpo_agent_update", { name: "coach", connector_tools: { "Bad Id": "*" } })).isError).toBe(true);
  });

  it("polpo_agent_get returns the selection and reports stale tool names", async () => {
    const f = fakeInstance();
    await call(deps(f), "polpo_agent_update", { name: "coach", connector_tools: { lin: ["create_issue", "gone_tool"] } });
    const r = await call(deps(f), "polpo_agent_get", { name: "coach" });
    expect(r.structuredContent.agent.connectorTools).toEqual({ lin: ["create_issue", "gone_tool"] });
    expect(r.structuredContent.stale_connector_tools).toEqual({ lin: ["gone_tool"] });
    expect(r.content[0].text).toContain("connector tools: lin: create_issue, gone_tool (stale: gone_tool)");
  });

  it("polpo_connectors_list with agent: only its connectors, and the tools it gets", async () => {
    const f = fakeInstance();
    await call(deps(f), "polpo_agent_update", { name: "coach", connector_tools: { lin: ["create_issue", "delete_issue", "gone_tool"] } });
    const list = await call(deps(f), "polpo_connectors_list", { agent: "coach" });
    expect(list.structuredContent.items.map((c: { id: string }) => c.id)).toEqual(["lin"]);
    expect(list.structuredContent.items[0].agent_tools).toEqual(["create_issue", "delete_issue", "gone_tool"]);
    // what it has no access to, and to grant it before scoping a task to it
    expect(list.structuredContent.no_access).toEqual(["notion"]);
    expect(list.content[0].text).toMatch(/coach has no access to: notion[\s\S]*polpo_connector_update \{ id, add_agents: \["coach"\] \}/);
    expect((await call(deps(f), "polpo_connectors_list", { agent: "writer" })).structuredContent.items[0]).toMatchObject({ id: "notion", agent_tools: "*" });
    const one = await call(deps(f), "polpo_connectors_list", { id: "lin", agent: "coach" });
    expect(one.structuredContent.tools).toEqual([
      { name: "create_issue", description: "Create an issue", policy: "allow", agent_gets: true },
      { name: "list_issues", policy: "allow", agent_gets: false },
      { name: "delete_issue", policy: "off", agent_gets: false },
    ]);
    expect(one.structuredContent.stale_tools).toEqual(["gone_tool"]);
    const denied = await call(deps(f), "polpo_connectors_list", { id: "lin", agent: "writer" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/Agent "writer" has no access to connector lin[\s\S]*polpo_connector_update \{ id: "lin", add_agents: \["writer"\] \}/);
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
    expect((await call(deps(f), "polpo_branding_get")).structuredContent).toMatchObject({ productName: "Acme Ops", tagline: "Agents at work" });
  }, 15_000);

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
