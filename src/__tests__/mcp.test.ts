import { describe, expect, it, vi } from "vitest";
import { describeMcpMessages, handleMcpRequest, matchesOperationPath, type ApiResponse, type McpDeps } from "../server/mcp.js";

const OPENAPI = {
  paths: {
    "/api/v1/tasks": { get: { summary: "List tasks", tags: ["Tasks"] }, post: { summary: "Create a task", tags: ["Tasks"] } },
    "/api/v1/tasks/{taskId}": { get: { summary: "Get a task", tags: ["Tasks"] }, delete: { summary: "Delete a task", tags: ["Tasks"] } },
    "/api/v1/tasks/{taskId}/retry": { post: { summary: "Retry a task", tags: ["Tasks"] } },
    "/api/v1/missions": { get: { summary: "List missions", tags: ["Missions"] } },
  },
};

function fakeApi() {
  const calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, body, headers: new Headers(headers) });
  const api: McpDeps["api"] = vi.fn(async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    if (path === "/api/v1/openapi.json") return reply(200, OPENAPI);
    if (path === "/api/v1/agents") return reply(200, { ok: true, data: [{ name: "coach", role: "Health coach", model: "anthropic:claude-opus-5-5" }] });
    if (path === "/api/v1/tasks" && method === "GET") return reply(200, { ok: true, data: [
      { id: "t1", title: "Plan the week", status: "done", assignTo: "coach", updatedAt: "2026-10-24" },
      { id: "t2", title: "Log meals", status: "in_progress", assignTo: "coach", updatedAt: "2026-10-25" },
    ] });
    if (path === "/api/v1/tasks/t9/retry") return reply(404, { ok: false, error: "Task not found" });
    if (path === "/api/v1/drive/coach") return reply(200, { ok: true, data: {
      drive: { enabled: true }, self: "I help Ada eat well.",
      plan: [{ id: "g1", title: "Eat vegetables every day", horizon: "month", status: "doing", progress: 40 }],
      intentions: [{ id: "chk_1", prompt: "wish Grazia a happy birthday", why: "Happy birthday to Grazia", state: "proposed", nextRunAt: "2026-10-26T07:30:00.000Z", everyMinutes: 0 }],
      journal: [],
    } });
    if (path === "/api/v1/drive/coach/intentions/chk_1/confirm") return reply(200, { ok: true, data: { intention: { id: "chk_1", state: "active" } } });
    if (path === "/api/v1/chat/sessions/s1/messages") return reply(200, { ok: true, data: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
    if (path === "/v1/chat/completions") return reply(200, { choices: [{ message: { content: "Done: 2 tasks planned." } }] }, { "x-session-id": "s1" });
    return reply(200, { ok: true, data: { echoed: { method, path, body } } });
  });
  return { api, calls };
}

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}, id = 1) {
  const res = await handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }), deps);
  return { status: res.status, body: await res.json() as { result?: any; error?: any } };
}

const call = (deps: McpDeps, name: string, args: Record<string, unknown> = {}) => rpc(deps, "tools/call", { name, arguments: args });

describe("Polpo MCP server", () => {
  it("initializes and lists a small set of curated tools with annotations", async () => {
    const { api } = fakeApi();
    const deps = { api, version: "0.5.1" };
    const init = await rpc(deps, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body.result).toMatchObject({ serverInfo: { name: "polpo", version: "0.5.1" }, capabilities: { tools: expect.anything() } });
    expect(init.body.result.instructions).toContain("ask_polpo");

    const list = await rpc(deps, "tools/list");
    const tools = list.body.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    expect(tools.map((t) => t.name)).toEqual([
      "ask_polpo", "chat_with_agent", "list_agents", "list_tasks", "get_task", "create_task", "list_missions", "get_mission",
      "list_artifacts", "get_artifact", "create_artifact", "list_data_sources", "query_data", "list_approvals", "resolve_approval",
      "show_agent", "agent_card_refresh", "agent_intention_decide",
      "list_files", "search_files", "read_file", "write_file", "manage_file",
      "list_operations", "call_operation",
    ]);
    expect(tools.find((t) => t.name === "write_file")!.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((t) => t.name === "list_tasks")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === "call_operation")!.annotations).toMatchObject({ destructiveHint: true });
  });

  it("ask_polpo continues a conversation: the history goes with the message, the session comes back", async () => {
    const { api, calls } = fakeApi();
    const res = await call({ api, version: "x" }, "ask_polpo", { message: "plan my week", session_id: "s1" });
    expect(res.body.result.content[0].text).toBe("Done: 2 tasks planned.\n\n[session_id: s1 — pass it to continue this conversation]");
    expect(res.body.result.structuredContent).toEqual({ reply: "Done: 2 tasks planned.", session_id: "s1" });
    const completion = calls.find((c) => c.path === "/v1/chat/completions")!;
    expect(completion.headers).toEqual({ "x-session-id": "s1" });
    expect((completion.body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "plan my week" },
    ]);
    // a new conversation and an agent
    await call({ api, version: "x" }, "chat_with_agent", { agent: "coach", message: "ciao" });
    const second = calls.filter((c) => c.path === "/v1/chat/completions")[1]!;
    expect(second.headers).toEqual({ "x-session-id": "new" });
    expect(second.body).toMatchObject({ agent: "coach", messages: [{ role: "user", content: "ciao" }] });
  });

  it("curated reads are compact text", async () => {
    const { api } = fakeApi();
    expect((await call({ api, version: "x" }, "list_agents")).body.result.content[0].text).toBe("- coach: Health coach (anthropic:claude-opus-5-5)");
    expect((await call({ api, version: "x" }, "list_tasks", { status: "in_progress" })).body.result.content[0].text).toBe("- t2 [in_progress] Log meals → coach");
  });

  it("list_operations and call_operation reach every REST operation, and only those", async () => {
    const { api, calls } = fakeApi();
    const deps = { api, version: "x" };
    expect((await call(deps, "list_operations", { q: "task" })).body.result.content[0].text)
      .toBe("GET /tasks — List tasks\nPOST /tasks — Create a task\nDELETE /tasks/{taskId} — Delete a task\nGET /tasks/{taskId} — Get a task\nPOST /tasks/{taskId}/retry — Retry a task");
    expect((await call(deps, "list_operations", { tag: "missions" })).body.result.content[0].text).toBe("GET /missions — List missions");

    const ok = await call(deps, "call_operation", { method: "POST", path: "/api/v1/tasks/t1/retry", body: { reason: "x" } });
    expect(ok.body.result.isError).toBeFalsy();
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/tasks/t1/retry", body: { reason: "x" } });

    expect((await call(deps, "call_operation", { method: "PUT", path: "/tasks/t1" })).body.result).toMatchObject({ isError: true, content: [{ text: "PUT is not allowed on /tasks/t1 (allowed: DELETE, GET)" }] });
    expect((await call(deps, "call_operation", { method: "GET", path: "/vault/secrets" })).body.result.content[0].text).toMatch(/No operation GET \/vault\/secrets/);
    expect((await call(deps, "call_operation", { method: "POST", path: "/tasks/t9/retry" })).body.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^HTTP 404/) }] });
    expect((await call(deps, "call_operation", { method: "GET", path: "/tasks", query: { status: "done" } }))).toBeTruthy();
    expect(calls.at(-1)!.path).toBe("/api/v1/tasks?status=done");
  });

  it("matches templated paths", () => {
    expect(matchesOperationPath("/tasks/{taskId}/retry", "/tasks/abc/retry")).toBe(true);
    expect(matchesOperationPath("/tasks/{taskId}", "/tasks/abc/retry")).toBe(false);
    expect(matchesOperationPath("/tasks/{taskId}", "/tasks/")).toBe(false);
  });

  it("rejecting an approval needs feedback", async () => {
    const { api, calls } = fakeApi();
    expect((await call({ api, version: "x" }, "resolve_approval", { id: "a1", decision: "reject" })).body.result).toMatchObject({ isError: true });
    await call({ api, version: "x" }, "resolve_approval", { id: "a1", decision: "reject", note: "missing tests" });
    expect(calls.at(-1)).toMatchObject({ path: "/api/v1/approvals/a1/reject", body: { resolvedBy: "mcp", feedback: "missing tests" } });
  });
});

describe("routes without an OpenAPI description", () => {
  it("are listed and callable too", async () => {
    const { api, calls } = fakeApi();
    const deps = { api, version: "x", routes: () => [
      { method: "GET", path: "/api/v1/artifacts" },
      { method: "POST", path: "/api/v1/artifacts/:id/restore/:version" },
      { method: "GET", path: "/api/v1/tasks" },
      { method: "ALL", path: "/api/v1/*" },
      { method: "GET", path: "/mcp" },
    ] };
    const listed = (await call(deps, "list_operations", { q: "artifacts" })).body.result.content[0].text;
    expect(listed).toBe("GET /artifacts\nPOST /artifacts/{id}/restore/{version}");
    await call(deps, "call_operation", { method: "POST", path: "/artifacts/art_1/restore/2" });
    expect(calls.at(-1)!.path).toBe("/api/v1/artifacts/art_1/restore/2");
  });
});

describe("the agent card (MCP App)", () => {
  it("show_agent links to a ui:// resource; the card's own tools are only for its UI", async () => {
    const { api } = fakeApi();
    const tools = (await rpc({ api, version: "1" }, "tools/list")).body.result.tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }>;
    const show = tools.find((t) => t.name === "show_agent")!;
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

  it("show_agent returns text for the model and the card for the UI", async () => {
    const { api } = fakeApi();
    const res = (await call({ api, version: "1" }, "show_agent", { agent: "Coach" })).body.result;
    expect(res.content[0].text).toContain("coach — Health coach: waiting for a person.");
    expect(res.content[0].text).toContain("Next: 2026-10-26T07:30:00.000Z — Happy birthday to Grazia (proposed, to confirm).");
    expect(res.structuredContent).toMatchObject({
      agent: { name: "coach", role: "Health coach" },
      current: { id: "t2", active: true },
      goal: { title: "Eat vegetables every day", progress: 40 },
      next: { id: "chk_1", proposed: true },
      key: { createdAt: expect.any(Number), seq: expect.any(Number) },
    });
    expect((await call({ api, version: "1" }, "show_agent", { agent: "nobody" })).body.result).toMatchObject({ isError: true });
  });

  it("the UI confirms an intention and gets the card back", async () => {
    const { api, calls } = fakeApi();
    const res = (await call({ api, version: "1" }, "agent_intention_decide", { agent: "coach", id: "chk_1", action: "confirm" })).body.result;
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
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "show_agent", arguments: { agent: "secret stuff" } } },
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "ui://polpo/agent-card.html" } },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ])).toEqual(["tools/call show_agent", "resources/read ui://polpo/agent-card.html", "tools/list"]);
    expect(describeMcpMessages(null)).toEqual([]);
  });
});
