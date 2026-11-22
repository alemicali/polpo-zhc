import { describe, expect, it, vi } from "vitest";
import {
  describeMcpMessages, handleMcpRequest, hasScope, matchesOperationPath, resolveToolsets,
  type ApiResponse, type McpDeps, type McpPrincipal,
} from "../server/mcp.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

const OPENAPI = {
  paths: {
    "/api/v1/tasks": { get: { summary: "List tasks", tags: ["Tasks"] }, post: { summary: "Create a task", tags: ["Tasks"] } },
    "/api/v1/tasks/{taskId}": { get: { summary: "Get a task", tags: ["Tasks"] }, delete: { summary: "Delete a task", tags: ["Tasks"] } },
    "/api/v1/tasks/{taskId}/retry": { post: { summary: "Retry a task", tags: ["Tasks"] } },
    "/api/v1/missions": { get: { summary: "List missions", tags: ["Missions"] } },
  },
};

type Choice = Record<string, unknown>;
interface Fake {
  api: McpDeps["api"];
  calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }>;
  /** Stored messages per session. */
  sessions: Map<string, Array<Record<string, unknown>>>;
  /** What the next completions answer (default: a plain reply). */
  next: Choice[];
}

/** A fake instance API: agents, tasks, a drive, sessions that store turns, and completions that may stop at an interactive tool. */
function fakeApi(): Fake {
  const calls: Fake["calls"] = [];
  const sessions = new Map<string, Array<Record<string, unknown>>>([["s1", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]]]);
  const fake: Fake = { api: undefined as never, calls, sessions, next: [] };
  let seq = 0;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, body, headers: new Headers(headers) });
  fake.api = vi.fn(async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    if (path === "/api/v1/openapi.json") return reply(200, OPENAPI);
    if (path === "/api/v1/agents") return reply(200, { ok: true, data: [{ name: "coach", role: "Health coach", model: "anthropic:claude-opus-5-5" }] });
    if (path.startsWith("/api/v1/tasks?") && method === "GET") return reply(200, { ok: true, data: { tasks: [
      { id: "t2", title: "Log meals", status: "in_progress", assignTo: "coach", updatedAt: "2026-10-25" },
    ], nextCursor: "2026-10-25", hasMore: true } });
    if (path === "/api/v1/tasks" && method === "GET") return reply(200, { ok: true, data: [
      { id: "t1", title: "Plan the week", status: "done", assignTo: "coach", updatedAt: "2026-10-24" },
      { id: "t2", title: "Log meals", status: "in_progress", assignTo: "coach", updatedAt: "2026-10-25" },
    ] });
    if (path === "/api/v1/drive/coach") return reply(200, { ok: true, data: {
      drive: { enabled: true }, self: "I help Ada eat well.",
      plan: [{ id: "g1", title: "Eat vegetables every day", horizon: "month", status: "doing", progress: 40 }],
      intentions: [{ id: "chk_1", prompt: "wish Grazia a happy birthday", why: "Happy birthday to Grazia", state: "proposed", nextRunAt: "2026-10-26T07:30:00.000Z", everyMinutes: 0 }],
      journal: [],
    } });
    if (path === "/api/v1/drive/coach/intentions/chk_1/confirm") return reply(200, { ok: true, data: { intention: { id: "chk_1", state: "active" } } });
    if (path === "/api/v1/chat/sessions") return reply(200, { ok: true, data: { sessions: [...sessions.keys()].map((id) => ({ id, ...(id.startsWith("agent-") ? { agent: "coach" } : {}) })) } });
    const msgs = path.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/messages$/);
    if (msgs) {
      const s = sessions.get(decodeURIComponent(msgs[1]!));
      return s ? reply(200, { ok: true, data: s }) : reply(404, { ok: false, error: "Session not found" });
    }
    if (path === "/v1/chat/completions") {
      const req = body as { messages: Array<{ role: string; content: string }>; agent?: string };
      let id = headers?.["x-session-id"] ?? "new";
      if (id === "new") { id = req.agent ? `agent-${++seq}` : `s-new-${++seq}`; sessions.set(id, []); }
      const stored = sessions.get(id)!;
      stored.push({ role: "user", content: req.messages.at(-1)!.content });
      const choice = fake.next.shift() ?? { message: { content: "Done: 2 tasks planned." }, finish_reason: "stop" };
      const toolCalls = interruptedCall(choice);
      stored.push({ id: `m${stored.length}`, role: "assistant", content: (choice.message as { content: string }).content, ...(toolCalls ? { toolCalls } : {}) });
      return reply(200, { choices: [choice] }, { "x-session-id": id });
    }
    if (path === "/api/v1/missions" && method === "POST") return reply(201, { ok: true, data: { id: "m-1", name: (body as { name: string }).name, status: "draft" } });
    if (path === "/api/v1/missions/m-1/execute") return reply(200, { ok: true, data: { group: "x" } });
    if (path === "/api/v1/email/send") return reply(200, { ok: true, data: { id: "mail-1" } });
    if (path === "/api/v1/whatsapp/send") return reply(200, { ok: true, data: { id: "wa-1" } });
    return reply(200, { ok: true, data: { echoed: { method, path, body } } });
  });
  return fake;
}

/** The tool call a completion choice stopped at, as the server stores it. */
function interruptedCall(choice: Choice): Array<Record<string, unknown>> | undefined {
  const map: Record<string, [string, string]> = {
    ask_user: ["ask_user", "ask_user"], mission_preview: ["create_mission", "mission_preview"],
    email_preview: ["email_send", "email_preview"], whatsapp_preview: ["whatsapp_send", "whatsapp_preview"], vault_preview: ["set_vault_entry", "vault_preview"],
  };
  const m = map[String(choice.finish_reason)];
  if (!m) return undefined;
  const args = { ...(choice[m[1]] as Record<string, unknown>) };
  if (m[0] === "create_mission") args.data = JSON.stringify(args.data);
  return [{ id: `call_${m[0]}`, name: m[0], arguments: args, state: "interrupted" }];
}

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}, id = 1) {
  const res = await handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }), deps);
  return { status: res.status, body: await res.json() as { result?: any; error?: any } };
}

/** A tool call, its result checked as the official MCP client checks it (structuredContent against the outputSchema). */
const call = async (deps: McpDeps, name: string, args: Record<string, unknown> = {}) => {
  const result = (await rpc(deps, "tools/call", { name, arguments: args })).body.result;
  await expectValidOutput(deps, async () => (await rpc(deps, "tools/list")).body.result.tools, name, result);
  return result;
};
const toolNames = async (deps: McpDeps) => ((await rpc(deps, "tools/list")).body.result.tools as Array<{ name: string }>).map((t) => t.name);

describe("Polpo MCP server", () => {
  it("initializes and lists the default toolsets, named polpo_*, annotated and typed", async () => {
    const { api } = fakeApi();
    const deps = { api, version: "0.5.1" };
    const init = await rpc(deps, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body.result).toMatchObject({ serverInfo: { name: "polpo", version: "0.5.1" }, capabilities: { tools: expect.anything() } });
    expect(init.body.result.instructions).toContain("polpo_answer");

    const tools = (await rpc(deps, "tools/list")).body.result.tools as Array<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown; inputSchema: { properties?: Record<string, { description?: string }> } }>;
    expect(tools.map((t) => t.name)).toEqual([
      "polpo_ask", "polpo_agent_chat", "polpo_answer",
      "polpo_agents_list", "polpo_agent_show", "agent_card_refresh", "agent_intention_decide",
      "polpo_approvals_list", "polpo_approval_resolve",
      "polpo_tasks_list", "polpo_task_get", "polpo_task_create", "polpo_task_update", "polpo_task_retry", "polpo_task_kill", "polpo_task_delete", "polpo_task_direct", "polpo_task_wait", "polpo_task_logs",
      "polpo_missions_list", "polpo_mission_get", "polpo_mission_create", "polpo_mission_update", "polpo_mission_run", "polpo_mission_abort", "polpo_mission_delete", "polpo_mission_wait", "polpo_playbooks_list", "polpo_playbook_run",
      "polpo_task_show", "polpo_mission_show",
      "polpo_artifacts_list", "polpo_artifact_get", "polpo_artifact_create",
      "polpo_data_sources_list", "polpo_data_query", "polpo_data_source_get", "polpo_data_source_save", "polpo_data_source_test", "polpo_data_source_delete",
      "polpo_data_activity", "polpo_data_sql", "polpo_data_mutate", "polpo_data_views_list", "polpo_data_view_get", "polpo_data_view_save", "polpo_data_view_delete",
      "polpo_files_list", "polpo_files_search", "polpo_file_read", "polpo_file_write", "polpo_file_manage",
      "polpo_agent_get", "polpo_agent_create", "polpo_agent_update", "polpo_agent_delete", "polpo_agent_avatar_set", "polpo_teams_list", "polpo_team_save", "polpo_team_delete",
      "polpo_config_get", "polpo_config_update", "polpo_branding_get", "polpo_branding_update", "polpo_providers_list", "polpo_models_list",
      "polpo_sandbox_get", "polpo_sandbox_update", "polpo_sandbox_provider_test", "polpo_policies_get", "polpo_policies_update",
      "polpo_approval_gate_save", "polpo_approval_gate_delete", "polpo_members_list", "polpo_members_invite", "polpo_members_remove",
      "polpo_mcp_access_list", "polpo_mcp_grant_revoke", "polpo_sync_status", "polpo_sync_update", "polpo_sync_disconnect", "polpo_sync_test",
      "polpo_sync_run", "polpo_custom_providers_list", "polpo_custom_provider_save", "polpo_custom_provider_remove", "polpo_provider_disconnect",
      "polpo_channel_save", "polpo_channel_remove",
      "polpo_channel_routes_list", "polpo_channel_route_set", "polpo_telegram_verify", "polpo_channel_invite",
      "polpo_channel_peers", "polpo_channel_allowlist", "polpo_channel_pairing", "polpo_whatsapp_login", "polpo_whatsapp_login_wait", "polpo_whatsapp_logout",
      "polpo_setup_wait",
      "polpo_rooms_list", "polpo_room_create", "polpo_room_update", "polpo_room_delete", "polpo_room_messages", "polpo_room_post", "polpo_room_wait",
      "polpo_chat_sessions_list", "polpo_chat_messages", "polpo_chat_session_update", "polpo_chat_session_delete",
      "polpo_memory_get", "polpo_memory_update",
      "polpo_skills_list", "polpo_skill_get", "polpo_skill_create", "polpo_skill_update", "polpo_skill_install", "polpo_skill_delete", "polpo_skill_assign",
      "polpo_schedules_list", "polpo_schedule_create", "polpo_schedule_update", "polpo_schedule_delete", "polpo_schedule_run",
      "polpo_checks_list", "polpo_check_create", "polpo_check_update", "polpo_check_cancel", "polpo_check_delete",
      "polpo_connectors_list", "polpo_connector_catalog", "polpo_connector_add", "polpo_connector_update", "polpo_connector_test", "polpo_connector_connect", "polpo_connector_disconnect", "polpo_connector_remove",
      "polpo_channels_list", "polpo_channel_test", "polpo_message_send", "polpo_notification_rule_save", "polpo_notification_rule_delete",
      "polpo_computers_list", "polpo_computer_save", "polpo_computer_control", "polpo_egress_status", "polpo_computer_delete",
      "polpo_harnesses_get", "polpo_harnesses_update", "polpo_harness_sessions_list", "polpo_harness_session_control",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.polpo_file_write!.annotations).toMatchObject({ destructiveHint: true, title: "Write a file" });
    expect(byName.polpo_tasks_list!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    expect(byName.polpo_ask!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.polpo_answer!.annotations).toMatchObject({ destructiveHint: true });
    // every tool that returns data declares it; every parameter is described
    for (const t of tools) {
      if (t.name !== "polpo_file_read") expect(t.outputSchema, t.name).toBeTruthy();
      for (const [param, schema] of Object.entries(t.inputSchema.properties ?? {})) expect(schema.description, `${t.name}.${param}`).toBeTruthy();
    }
  });

  it("polpo_ask continues a conversation: the history goes with the message, the session comes back", async () => {
    const { api, calls } = fakeApi();
    const res = await call({ api, version: "x" }, "polpo_ask", { message: "plan my week", session_id: "s1" });
    expect(res.content[0].text).toBe("Done: 2 tasks planned.\n\n[session_id: s1 — pass it to continue this conversation]");
    expect(res.structuredContent).toEqual({ status: "replied", reply: "Done: 2 tasks planned.", session_id: "s1" });
    const completion = calls.find((c) => c.path === "/v1/chat/completions")!;
    expect(completion.headers).toEqual({ "x-session-id": "s1" });
    expect((completion.body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "plan my week" },
    ]);
    // a new conversation and an agent
    const agent = await call({ api, version: "x" }, "polpo_agent_chat", { agent: "coach", message: "ciao" });
    const second = calls.filter((c) => c.path === "/v1/chat/completions")[1]!;
    expect(second.headers).toEqual({ "x-session-id": "new" });
    expect(second.body).toMatchObject({ agent: "coach", messages: [{ role: "user", content: "ciao" }] });
    expect(agent.structuredContent).toMatchObject({ status: "replied", agent: "coach", session_id: "agent-1" });
    // an unknown conversation
    expect(await call({ api, version: "x" }, "polpo_ask", { message: "x", session_id: "nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Omit session_id/) }] });
  });

  it("returns Polpo's questions and takes the answers, continuing the conversation", async () => {
    const fake = fakeApi();
    const deps = { api: fake.api, version: "x" };
    fake.next.push({ message: { content: "A couple of questions first." }, finish_reason: "ask_user", ask_user: { questions: [
      { id: "where", question: "Where should the report go?", header: "Destination", options: [{ label: "Email" }, { label: "Slack" }] },
      { id: "when", question: "When?", options: [{ label: "Now" }, { label: "Monday" }] },
    ] } });
    const asked = await call(deps, "polpo_ask", { message: "send the weekly report" });
    expect(asked.structuredContent).toMatchObject({
      status: "needs_input", reply: "A couple of questions first.",
      pending: { id: "call_ask_user", kind: "questions", actions: ["answer"], questions: [{ id: "where", options: [{ label: "Email" }, { label: "Slack" }] }, { id: "when" }] },
    });
    expect(asked.content[0].text).toContain("[where] Where should the report go?");
    expect(asked.content[0].text).toContain("polpo_answer");
    const session = asked.structuredContent.session_id as string;

    expect(await call(deps, "polpo_answer", { session_id: session, answers: [{ question_id: "nope", text: "x" }] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Unknown question ids: nope/) }] });
    expect(await call(deps, "polpo_answer", { session_id: session, pending_id: "other" })).toMatchObject({ isError: true });

    const answered = await call(deps, "polpo_answer", { session_id: session, pending_id: "call_ask_user", answers: [{ question_id: "where", selected: ["Slack"], text: "#reports" }] });
    expect(answered.structuredContent).toMatchObject({ status: "replied", session_id: session });
    const turn = fake.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)!;
    expect(turn.headers).toEqual({ "x-session-id": session });
    expect((turn.body as { messages: Array<{ content: string }> }).messages.at(-1)!.content)
      .toBe("Destination: Slack — #reports\nWhen?: Skipped — decide on your own based on best practices");
    // answered: nothing waits any more
    expect(await call(deps, "polpo_answer", { session_id: session, answers: [] })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Nothing is waiting/) }] });
  });

  it("a mission preview is executed only with confirm, through the missions API, then the conversation goes on", async () => {
    const fake = fakeApi();
    const deps = { api: fake.api, version: "x" };
    const plan = { tasks: [{ title: "Research", description: "Find sources", assignTo: "coach" }, { title: "Write", description: "Draft", dependsOn: ["Research"] }] };
    fake.next.push({ message: { content: "Here is the plan." }, finish_reason: "mission_preview", mission_preview: { name: "Report", data: plan, prompt: "weekly report" } });
    const asked = await call(deps, "polpo_ask", { message: "make a mission for the report" });
    expect(asked.structuredContent.pending).toMatchObject({ kind: "mission_preview", actions: ["execute", "save_draft", "refine", "cancel"], mission: { name: "Report", plan } });
    expect(asked.content[0].text).toContain("1. Research → coach");
    const session = asked.structuredContent.session_id as string;

    expect(await call(deps, "polpo_answer", { session_id: session, action: "send" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/execute, save_draft, refine, cancel/) }] });
    expect(await call(deps, "polpo_answer", { session_id: session, action: "execute" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    expect(fake.calls.some((c) => c.path === "/api/v1/missions")).toBe(false);

    const done = await call(deps, "polpo_answer", { session_id: session, action: "execute", confirm: true });
    expect(fake.calls.find((c) => c.path === "/api/v1/missions")!.body).toEqual({ data: JSON.stringify(plan), name: "Report", prompt: "weekly report", status: "draft" });
    expect(fake.calls.some((c) => c.path === "/api/v1/missions/m-1/execute" && c.method === "POST")).toBe(true);
    expect(done.structuredContent).toMatchObject({ status: "replied", done: { mission_id: "m-1", mission_status: "running" } });
    const last = (fake.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ content: string }> }).messages.at(-1)!.content;
    expect(last).toMatch(/I approved and executed the mission "Report" \(ID: m-1\)/);
  });

  it("refining a preview needs feedback and sends it to Polpo", async () => {
    const fake = fakeApi();
    const deps = { api: fake.api, version: "x" };
    fake.next.push({ message: { content: "Plan:" }, finish_reason: "mission_preview", mission_preview: { name: "R", data: { tasks: [{ title: "a", description: "b" }] } } });
    const session = (await call(deps, "polpo_ask", { message: "plan" })).structuredContent.session_id;
    expect(await call(deps, "polpo_answer", { session_id: session, action: "refine" })).toMatchObject({ isError: true });
    await call(deps, "polpo_answer", { session_id: session, action: "refine", feedback: "add a review step" });
    const last = (fake.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ content: string }> }).messages.at(-1)!.content;
    expect(last).toBe("Please refine the mission plan with these changes:\nadd a review step");
  });

  it("an email preview is sent only with confirm; in an agent's conversation as that agent", async () => {
    const fake = fakeApi();
    const deps = { api: fake.api, version: "x" };
    fake.next.push({ message: { content: "Ready." }, finish_reason: "email_preview", email_preview: { to: ["ada@example.com"], subject: "Weekly", body: "Hi Ada" } });
    const asked = await call(deps, "polpo_agent_chat", { agent: "coach", message: "email Ada the summary" });
    expect(asked.structuredContent.pending).toMatchObject({ kind: "email_preview", email: { to: ["ada@example.com"], subject: "Weekly" } });
    const session = asked.structuredContent.session_id as string;
    expect(await call(deps, "polpo_answer", { session_id: session, action: "send" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/cannot be undone/) }] });
    const sent = await call(deps, "polpo_answer", { session_id: session, action: "send", confirm: true });
    expect(fake.calls.find((c) => c.path === "/api/v1/email/send")!.body).toEqual({ to: ["ada@example.com"], subject: "Weekly", body: "Hi Ada", agent: "coach", sessionId: session });
    expect(sent.structuredContent).toMatchObject({ done: { sent: true, message_id: "mail-1" }, agent: "coach" });
    expect(fake.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)!.body).toMatchObject({ agent: "coach" });
  });

  it("a secret is never shown or saved through MCP: the person gets the dashboard link", async () => {
    const fake = fakeApi();
    const deps = { api: fake.api, version: "x", publicUrl: "https://polpo.example.com" };
    fake.next.push({ message: { content: "Save this?" }, finish_reason: "vault_preview", vault_preview: { agent: "coach", service: "stripe", type: "api_key", credentials: { key: "sk_live_123" } } });
    const asked = await call(deps, "polpo_ask", { message: "store my stripe key sk_live_123" });
    expect(JSON.stringify(asked.structuredContent)).not.toContain("sk_live_123");
    expect(asked.content[0].text).not.toContain("sk_live_123");
    expect(asked.structuredContent.pending).toMatchObject({ kind: "vault_preview", actions: ["cancel"], vault: { fields: ["key"] }, dashboard_url: "https://polpo.example.com/agents/coach" });
    const session = asked.structuredContent.session_id as string;
    expect(await call(deps, "polpo_answer", { session_id: session, action: "execute", confirm: true })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo.example.com\/agents\/coach/) }] });
    expect((await call(deps, "polpo_answer", { session_id: session, action: "cancel" })).isError).toBeFalsy();
  });

  it("links a reply points to come back as links", async () => {
    const fake = fakeApi();
    fake.next.push({ message: { content: "Opened it." }, finish_reason: "navigate_to", navigate_to: { target: "tasks", id: "t1" } });
    const res = await call({ api: fake.api, version: "x", publicUrl: "https://p.example.com" }, "polpo_ask", { message: "show me t1" });
    expect(res.structuredContent).toMatchObject({ status: "replied", links: [{ kind: "dashboard", target: "https://p.example.com/tasks/t1" }] });
  });

  it("curated reads are compact text with structured content", async () => {
    const { api } = fakeApi();
    const agents = await call({ api, version: "x" }, "polpo_agents_list");
    expect(agents.content[0].text).toBe("- coach: Health coach (anthropic:claude-opus-5-5)");
    expect(agents.structuredContent.items).toEqual([{ name: "coach", role: "Health coach", model: "anthropic:claude-opus-5-5" }]);
    const tasks = await call({ api, version: "x" }, "polpo_tasks_list", { status: "in_progress", limit: 1 });
    expect(tasks.content[0].text).toMatch(/^- t2 \[in_progress\] Log meals → coach/);
    expect(tasks.structuredContent.next_cursor).toEqual(expect.any(String));
    expect(await call({ api, version: "x" }, "polpo_tasks_list", { cursor: "%%%" })).toMatchObject({ isError: true });
  });

  it("matches templated paths", () => {
    expect(matchesOperationPath("/tasks/{taskId}/retry", "/tasks/abc/retry")).toBe(true);
    expect(matchesOperationPath("/tasks/{taskId}", "/tasks/abc/retry")).toBe(false);
    expect(matchesOperationPath("/tasks/{taskId}", "/tasks/")).toBe(false);
  });

  it("rejecting an approval needs feedback; the decision is recorded as the caller", async () => {
    const { api, calls } = fakeApi();
    const principal: McpPrincipal = { kind: "oauth", actor: "ada@example.com via Claude", subject: "ada@example.com", client: "Claude", scopes: ["polpo"] };
    expect(await call({ api, version: "x", principal }, "polpo_approval_resolve", { id: "a1", decision: "reject" })).toMatchObject({ isError: true });
    await call({ api, version: "x", principal }, "polpo_approval_resolve", { id: "a1", decision: "reject", note: "missing tests" });
    expect(calls.at(-1)).toMatchObject({ path: "/api/v1/approvals/a1/reject", body: { resolvedBy: "ada@example.com via Claude", feedback: "missing tests" } });
  });
});

describe("toolsets and scopes", () => {
  it("resolves configured toolsets", () => {
    const defaults = ["core", "tasks", "missions", "artifacts", "data", "files", "team", "config", "rooms", "chat", "memory", "skills", "automation", "connectors", "channels", "computers", "settings"];
    expect(resolveToolsets()).toEqual(defaults);
    expect(resolveToolsets("core, admin")).toEqual(["core", "admin"]);
    expect(resolveToolsets(undefined, ["all"])).toEqual([...defaults, "brain", "learning", "watchers", "vault", "apps", "admin"]);
    expect(resolveToolsets("default,admin")).toEqual([...defaults, "admin"]);
    expect(resolveToolsets("default,brain,vault")).toEqual([...defaults, "brain", "vault"]);
    expect(resolveToolsets("nonsense")).toEqual(resolveToolsets());
    expect(resolveToolsets("tasks", ["admin"])).toEqual(["tasks"]); // the env wins over settings
  });

  it("offers only the configured toolsets", async () => {
    const { api } = fakeApi();
    expect(await toolNames({ api, version: "x", toolsets: ["missions"] })).toEqual(["polpo_missions_list", "polpo_mission_get", "polpo_mission_create", "polpo_mission_update", "polpo_mission_run", "polpo_mission_abort", "polpo_mission_delete", "polpo_mission_wait", "polpo_playbooks_list", "polpo_playbook_run", "polpo_mission_show"]);
    const withAdmin = await toolNames({ api, version: "x", toolsets: ["core", "admin"] });
    expect(withAdmin).toContain("polpo_api_get");
    expect(withAdmin).toContain("polpo_agent_show");
    expect(withAdmin).not.toContain("polpo_tasks_list");
  });

  it("a read-only principal gets only the read tools", async () => {
    const { api } = fakeApi();
    const principal: McpPrincipal = { kind: "oauth", actor: "x", scopes: ["polpo:read"] };
    const names = await toolNames({ api, version: "x", principal, toolsets: ["all"] });
    expect(names).toContain("polpo_tasks_list");
    expect(names).toContain("agent_card_refresh");
    expect(names).not.toContain("polpo_task_create");
    expect(names).not.toContain("polpo_ask");
    expect(names).not.toContain("agent_intention_decide");
    expect(names).not.toContain("polpo_api_get"); // admin needs polpo:admin
    expect(hasScope({ kind: "key", actor: "k", scopes: ["polpo"] }, "polpo:admin")).toBe(true);
    expect(hasScope({ kind: "key", actor: "k", scopes: ["polpo:admin"] }, "polpo:work")).toBe(true);
    expect(hasScope({ kind: "key", actor: "k", scopes: ["polpo:work"] }, "polpo:admin")).toBe(false);
  });
});

describe("the admin toolset (read-only REST)", () => {
  const deps = (api: McpDeps["api"]) => ({ api, version: "x", toolsets: ["admin"], routes: () => [
    { method: "GET", path: "/api/v1/artifacts" },
    { method: "POST", path: "/api/v1/artifacts/:id/restore/:version" },
    { method: "GET", path: "/api/v1/tasks" },
    { method: "ALL", path: "/api/v1/*" },
    { method: "GET", path: "/mcp" },
  ] });

  it("searches every operation, OpenAPI and plain routes", async () => {
    const { api } = fakeApi();
    const found = await call(deps(api), "polpo_api_search", { q: "artifacts" });
    expect(found.content[0].text).toBe("GET /artifacts\nPOST /artifacts/{id}/restore/{version}");
    expect(found.structuredContent.items).toEqual([
      { method: "GET", path: "/artifacts", summary: "", tags: ["artifacts"], readable: true },
      { method: "POST", path: "/artifacts/{id}/restore/{version}", summary: "", tags: ["artifacts"], readable: false },
    ]);
    expect((await call(deps(api), "polpo_api_search", { tag: "missions" })).content[0].text).toBe("GET /missions — List missions");
  });

  it("reads with GET only, with path parameters and a query", async () => {
    const { api, calls } = fakeApi();
    expect((await call(deps(api), "polpo_api_get", { path: "/tasks/{taskId}", params: { taskId: "t 1" } })).isError).toBeFalsy();
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/tasks/t%201" });
    await call(deps(api), "polpo_api_get", { path: "/api/v1/tasks", query: { status: "done" } });
    expect(calls.at(-1)!.path).toBe("/api/v1/tasks?status=done");
    expect(await call(deps(api), "polpo_api_get", { path: "/tasks/{taskId}" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Missing values for \{taskId\}/) }] });
    const n = calls.length;
    expect(await call(deps(api), "polpo_api_get", { path: "/tasks/t1/retry" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/accepts POST/) }] });
    expect(await call(deps(api), "polpo_api_get", { path: "/artifacts/a/restore/2" })).toMatchObject({ isError: true });
    expect(await call(deps(api), "polpo_api_get", { path: "/vault/secrets" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/polpo_api_search/) }] });
    expect(await call(deps(api), "polpo_api_get", { path: "/tasks/../config" })).toMatchObject({ isError: true });
    // nothing but the operations index was called
    expect(calls.slice(n).every((c) => c.path === "/api/v1/openapi.json")).toBe(true);
    // there is no generic write tool at all
    expect(await toolNames({ api, version: "x", toolsets: ["all"] })).not.toContain("call_operation");
  });
});

describe("the agent card (MCP App)", () => {
  it("polpo_agent_show links to a ui:// resource; the card's own tools are only for its UI", async () => {
    const { api } = fakeApi();
    const tools = (await rpc({ api, version: "1" }, "tools/list")).body.result.tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }>;
    const show = tools.find((t) => t.name === "polpo_agent_show")!;
    expect(show._meta?.ui?.resourceUri).toBe("ui://polpo/agent-card.html");
    expect(show._meta?.ui?.visibility).toBeUndefined();
    expect(tools.find((t) => t.name === "agent_card_refresh")!._meta?.ui?.visibility).toEqual(["app"]);
    expect(tools.find((t) => t.name === "agent_intention_decide")!._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("serves the widget as one HTML document with the MCP App mime type", async () => {
    const { api } = fakeApi();
    const deps = { api, version: "1" };
    const list = (await rpc(deps, "resources/list")).body.result.resources as Array<{ uri: string; mimeType: string }>;
    expect(list).toContainEqual(expect.objectContaining({ uri: "ui://polpo/agent-card.html", mimeType: "text/html;profile=mcp-app" }));
    const read = (await rpc(deps, "resources/read", { uri: "ui://polpo/agent-card.html" })).body.result.contents[0];
    expect(read.mimeType).toBe("text/html;profile=mcp-app");
    expect(read.text).toMatch(/^<!doctype html>/);
    expect(read.text).toContain('<meta name="color-scheme" content="light dark">');
    // nothing loaded from elsewhere: no external scripts or stylesheets
    expect(read.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(read._meta.ui).toMatchObject({ prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } });
  });

  it("polpo_agent_show returns text for the model and the card for the UI", async () => {
    const { api } = fakeApi();
    const res = await call({ api, version: "1" }, "polpo_agent_show", { agent: "Coach" });
    expect(res.content[0].text).toContain("coach — Health coach: waiting for a person.");
    expect(res.content[0].text).toContain("Next: 2026-10-26T07:30:00.000Z — Happy birthday to Grazia (proposed, to confirm).");
    expect(res.structuredContent).toMatchObject({
      agent: { name: "coach", role: "Health coach" },
      current: { id: "t2", active: true },
      goal: { title: "Eat vegetables every day", progress: 40 },
      next: { id: "chk_1", proposed: true },
      key: { createdAt: expect.any(Number), seq: expect.any(Number) },
    });
    expect(await call({ api, version: "1" }, "polpo_agent_show", { agent: "nobody" })).toMatchObject({ isError: true });
  });

  it("the official MCP SDK client (Client.callTool, Ajv) accepts the card: no 'data must NOT have additional properties' (Claude Code, Cursor)", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createPolpoMcpServer } = await import("../server/mcp.js");
    const { api } = fakeApi();
    const server = createPolpoMcpServer({ api, version: "1" });
    const client = new Client({ name: "e2e", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const tools = (await client.listTools()).tools;
      // every output schema is open: a field the API adds later never breaks a client
      for (const t of tools.filter((x) => x.outputSchema)) expect(t.outputSchema!.additionalProperties, t.name).not.toBe(false);
      const shown = await client.callTool({ name: "polpo_agent_show", arguments: { agent: "coach" } });
      expect(shown.structuredContent).toMatchObject({ agent: { name: "coach" }, goals: expect.any(Array), journal: expect.any(Array), today: expect.any(Object) });
      expect((await client.callTool({ name: "agent_card_refresh", arguments: { agent: "coach" } })).isError).toBeFalsy();
      expect((await client.callTool({ name: "agent_intention_decide", arguments: { agent: "coach", id: "chk_1", action: "confirm" } })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("the UI confirms an intention and gets the card back", async () => {
    const { api, calls } = fakeApi();
    const res = await call({ api, version: "1" }, "agent_intention_decide", { agent: "coach", id: "chk_1", action: "confirm" });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/drive/coach/intentions/chk_1/confirm")).toBe(true);
    expect(res.structuredContent.agent.name).toBe("coach");
  });
});

describe("MCP request log", () => {
  it("one line per message, without contents: the client, whether it shows apps, the tools and resources used", () => {
    expect(describeMcpMessages({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2026-07-28", clientInfo: { name: "claude-ai", version: "0.1.0" },
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    } })).toEqual(["initialize claude-ai 0.1.0 (protocol 2026-07-28; apps: text/html;profile=mcp-app)"]);
    expect(describeMcpMessages([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "polpo_agent_show", arguments: { agent: "secret stuff" } } },
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "ui://polpo/agent-card.html" } },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ])).toEqual(["tools/call polpo_agent_show", "resources/read ui://polpo/agent-card.html", "tools/list"]);
    expect(describeMcpMessages(null)).toEqual([]);
  });
});
