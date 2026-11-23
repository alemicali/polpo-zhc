/**
 * What a live verification of Polpo (the orchestrator chat) found, fixed:
 * - create_task makes a draft (not a mission) and says whether the task's tools are restricted;
 * - a tool scope never grants: connectors_list { agent } and the create / update errors say which
 *   connector the agent has no access to and how to grant it first;
 * - list_tasks has dates and since-filters, and why a task failed;
 * - "since" parsing (relative or ISO);
 * - the signed-in account of a connector, from its whoami-like tool when the sign-in did not say.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { parseSince } from "@polpo-ai/core/iso-duration";
import { taskToolScopeMissingGrants, type ConnectorConfig } from "@polpo-ai/core";
import type { Orchestrator } from "../core/orchestrator.js";
import { accountFromToolResult, pickIdentityTool } from "../mcp/account-identity.js";
import { ConnectorManager } from "../mcp/manager.js";

const connector = (id: string, name: string, agents: string[] | "*", extra: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
  id, name, kind: "mcp", transport: { type: "http", url: "http://127.0.0.1:1/mcp" }, auth: { type: "none" },
  access: { agents, polpo: false }, enabled: true, createdAt: "2026-01-01", ...extra,
} as ConnectorConfig);

describe("parseSince", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  it("relative durations back from now", () => {
    expect(parseSince("24h", now)).toBe(now - 24 * 3_600_000);
    expect(parseSince("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2w", now)).toBe(now - 14 * 86_400_000);
    expect(parseSince("90 minutes", now)).toBe(now - 90 * 60_000);
    expect(parseSince("PT24H", now)).toBe(now - 24 * 3_600_000);
  });
  it("ISO dates and date-times", () => {
    expect(parseSince("2026-11-21T08:00:00Z", now)).toBe(Date.parse("2026-11-21T08:00:00Z"));
    expect(parseSince("2026-11-21", now)).toBe(Date.parse("2026-11-21"));
  });
  it("anything else: undefined", () => {
    for (const bad of ["", "yesterday", "24", "24x", "2026-13-45"]) expect(parseSince(bad, now)).toBeUndefined();
  });
});

describe("taskToolScopeMissingGrants", () => {
  const all = [connector("linear", "Linear", ["writer"]), connector("notion", "Notion", []), connector("gmail", "Gmail", "*", { enabled: false, account: "a@acme.com" })];
  it("names the connectors the scope picks that the agent is not granted (or that are off)", () => {
    expect(taskToolScopeMissingGrants({ connectors: ["linear"] }, "writer", all)).toEqual([]);
    expect(taskToolScopeMissingGrants({ connectors: ["linear", "notion"], connectorTools: { gmail: ["send"] } }, "writer", all)).toEqual([
      { id: "notion", label: "Notion (notion)", enabled: true },
      { id: "gmail", label: "Gmail – a@acme.com (gmail)", enabled: false },
    ]);
    // unknown connectors are another problem (no such connector), not a missing grant
    expect(taskToolScopeMissingGrants({ connectors: ["jira"] }, "writer", all)).toEqual([]);
    expect(taskToolScopeMissingGrants(undefined, "writer", all)).toEqual([]);
  });
});

describe("account identity", () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, inputSchema: { type: "object" }, ...extra });
  it("picks an obvious, read-only identity tool that needs no argument", () => {
    expect(pickIdentityTool([tool("list_issues"), tool("whoami")])?.name).toBe("whoami");
    expect(pickIdentityTool([tool("get_me")])?.name).toBe("get_me");
    expect(pickIdentityTool([tool("users-get_current_user")])?.name).toBe("users-get_current_user");
    expect(pickIdentityTool([tool("slack_auth_test")])?.name).toBe("slack_auth_test");
    // exact names beat prefixed ones
    expect(pickIdentityTool([tool("users_get_me"), tool("whoami")])?.name).toBe("whoami");
  });
  it("never a tool that needs arguments, may change something, or only looks alike", () => {
    expect(pickIdentityTool([tool("get_me", { inputSchema: { type: "object", required: ["id"] } })])).toBeUndefined();
    expect(pickIdentityTool([tool("whoami", { annotations: { destructiveHint: true } })])).toBeUndefined();
    expect(pickIdentityTool([tool("whoami", { annotations: { readOnlyHint: false } })])).toBeUndefined();
    expect(pickIdentityTool([tool("get_user"), tool("update_me"), tool("delete_me"), tool("send_message"), tool("reset_whoami"), tool("set_get_me")])).toBeUndefined();
  });
  it("reads an email, else a login, from JSON, structured or plain text answers", () => {
    expect(accountFromToolResult({ content: [{ type: "text", text: JSON.stringify({ viewer: { name: "Ada", email: "ada@acme.com" } }) }] })).toBe("ada@acme.com");
    expect(accountFromToolResult({ content: [], structuredContent: { login: "octocat", name: "The Octocat" } })).toBe("octocat");
    expect(accountFromToolResult({ content: [{ type: "text", text: "You are signed in as bob@acme.com (workspace Acme)" }] })).toBe("bob@acme.com");
    expect(accountFromToolResult({ content: [{ type: "text", text: JSON.stringify({ ok: true, user: "ada", team: "Acme" }) }] })).toBe("ada");
    expect(accountFromToolResult({ content: [{ type: "text", text: JSON.stringify({ displayName: "Ada Lovelace" }) }] })).toBe("Ada Lovelace");
    expect(accountFromToolResult({ isError: true, content: [{ type: "text", text: "ada@acme.com" }] })).toBeUndefined();
    expect(accountFromToolResult({ content: [{ type: "text", text: "ok" }] })).toBeUndefined();
  });
});

describe("the account from a whoami tool after connecting (a real MCP server)", () => {
  let server: Server;
  let base: string;
  const calls: string[] = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const s = new McpServer({ name: "linearish", version: "1.0.0" });
      s.registerTool("whoami", { description: "The signed-in user" }, async () => {
        calls.push("whoami");
        return { content: [{ type: "text", text: JSON.stringify({ id: "u1", name: "Ada", email: "ada@acme.com" }) }] };
      });
      s.registerTool("delete_issue", { description: "Delete", inputSchema: { id: z.string() } }, async () => {
        calls.push("delete_issue");
        return { content: [{ type: "text", text: "deleted" }] };
      });
      res.on("close", () => { void transport.close(); void s.close(); });
      await s.connect(transport);
      await transport.handleRequest(req as never, res, raw ? JSON.parse(raw) : undefined);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("connects, calls whoami once, labels the connector; nothing else is called and a known account is kept", async () => {
    const polpoDir = mkdtempSync(join(tmpdir(), "polpo-account-"));
    const events: Array<{ id: string; action?: string }> = [];
    const manager = new ConnectorManager({ polpoDir, settings: () => ({ connectors: { allowPrivateNetwork: true } }) as never, emit: (e) => events.push(e), log: () => undefined });
    try {
      manager.store.create({ ...connector("linear", "Linear", []), transport: { type: "http", url: `${base}/mcp` } });
      expect((await manager.test("linear")).ok).toBe(true);
      expect(manager.store.get("linear")?.account).toBe("ada@acme.com");
      expect(calls).toEqual(["whoami"]);
      expect(events.some((e) => e.id === "linear" && e.action === "updated")).toBe(true);
      // known now: not asked again
      expect((await manager.test("linear")).ok).toBe(true);
      expect(calls).toEqual(["whoami"]);
      // a tool the person turned off is never called
      manager.store.update("linear", { account: undefined, toolPolicy: { whoami: "off" } });
      await manager.test("linear");
      expect(calls).toEqual(["whoami"]);
      expect(manager.store.get("linear")?.account).toBeUndefined();
    } finally {
      await manager.closeAll();
      rmSync(polpoDir, { recursive: true, force: true });
    }
  });
});

describe("Polpo's tools", () => {
  let tmpDir: string;
  let polpo: Orchestrator;
  let run: (name: string, args?: Record<string, unknown>) => Promise<string>;
  let app: { request: (path: string) => Promise<Response> };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "polpo-live-verification-"));
    await mkdir(join(tmpDir, ".polpo"), { recursive: true });
    const team = { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] };
    await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "live", team, settings: { logLevel: "quiet" } }));
    await writeFile(join(tmpDir, ".polpo", "connectors.json"), JSON.stringify({ connectors: [
      connector("linear", "Linear", ["agent-1"]),
      connector("notion", "Notion", [], { account: "ops@acme.com" }),
    ] }));
    const { Orchestrator } = await import("../core/orchestrator.js");
    const { SSEBridge } = await import("../server/sse-bridge.js");
    const { createApp } = await import("../server/app.js");
    const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
    polpo = new Orchestrator(tmpDir);
    await polpo.initInteractive("live", team);
    app = createApp(polpo, new SSEBridge(polpo), { workDir: tmpDir }) as never;
    run = (name, args = {}) => executeOrchestratorTool(name, args, polpo);
  }, 30_000);

  afterAll(async () => {
    const { setPolpoApi } = await import("../llm/polpo-mcp-bridge.js");
    setPolpoApi(undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  const idOf = (text: string) => text.match(/\[([^\]]+)\]/)![1]!;

  it("create_task draft: true saves a draft task (not a mission); update_task start: true starts it", async () => {
    const missionsBefore = (await polpo.getAllMissions()).length;
    const made = await run("create_task", { title: "Draft one", description: "d", assignTo: "agent-1", draft: true });
    expect(made).toMatch(/^Task created: .* \(draft: not started; update_task with start: true starts it\)/);
    const id = idOf(made);
    expect((await polpo.getStore().getTask(id))!.status).toBe("draft");
    expect((await polpo.getAllMissions()).length).toBe(missionsBefore);
    expect(await run("update_task", { taskId: id, start: true })).toMatch(/started \(draft → pending\)/);
    expect((await polpo.getStore().getTask(id))!.status).toBe("pending");
    expect(await run("update_task", { taskId: id, start: true })).toMatch(/^Error: .* not a draft/);
    await polpo.deleteTask(id);
  });

  it("create_task says whether the tools are restricted: only when toolScope was set", async () => {
    const scoped = await run("create_task", { title: "Only Linear", description: "d", assignTo: "agent-1", draft: true, toolScope: { connectors: ["linear"] } });
    expect(scoped).toMatch(/tools restricted: Linear/);
    const open = await run("create_task", { title: "Everything", description: "d", assignTo: "agent-1", draft: true });
    expect(open).toMatch(/tools: everything the agent has \(no toolScope set\)/);
    expect(open).not.toMatch(/restricted/);
    await polpo.deleteTask(idOf(scoped));
    await polpo.deleteTask(idOf(open));
  });

  it("a scope on a connector the agent has no access to: not created, and how to grant it first", async () => {
    const before = (await polpo.getStore().getAllTasks()).length;
    const refused = await run("create_task", { title: "Notion only", description: "d", assignTo: "agent-1", toolScope: { connectors: ["notion"] } });
    expect(refused).toMatch(/^Error: Invalid toolScope: connectors: agent "agent-1" has no access to Notion – ops@acme\.com \(notion\)/);
    expect(refused).toContain('connector_update_access { id: "notion", addAgents: ["agent-1"] }');
    expect(refused).toMatch(/Offer the person to grant the access first/);
    expect(refused).toMatch(/NOT created/);
    expect((await polpo.getStore().getAllTasks()).length).toBe(before);

    const made = await run("create_task", { title: "Then scoped", description: "d", assignTo: "agent-1", draft: true });
    const updated = await run("update_task", { taskId: idOf(made), toolScope: { connectors: ["notion"] } });
    expect(updated).toContain('connector_update_access { id: "notion", addAgents: ["agent-1"] }');
    expect(updated).toMatch(/tool scope was NOT changed/);
    expect((await polpo.getStore().getTask(idOf(made)))!.toolScope).toBeUndefined();
    await polpo.deleteTask(idOf(made));
  });

  it("connectors_list { agent }: what it may use and what it has no access to (grant first)", async () => {
    const out = await run("connectors_list", { agent: "agent-1" });
    expect(out).toMatch(/Connectors agent-1 may use:\n- Linear \[linear\].*agent-1 gets all its tools/);
    expect(out).toMatch(/agent-1 has no access to: Notion – ops@acme\.com \(notion\)\./);
    expect(out).toMatch(/offer the person to grant it first \(connector_update_access \{ id, addAgents: \["agent-1"\] \}\)/);
    expect(await run("connectors_list", { agent: "nobody" })).toMatch(/^No agent "nobody"/);
    // the plain list shows the signed-in account
    expect(await run("connectors_list", {})).toMatch(/- Notion – ops@acme\.com \[notion\]/);
  });

  it("list_tasks: newest first, with dates, since-filters and why a task failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let oldId: string;
    try {
      vi.setSystemTime(new Date(Date.now() - 3 * 86_400_000));
      oldId = idOf(await run("create_task", { title: "Old work", description: "d", assignTo: "agent-1", draft: true }));
    } finally {
      vi.useRealTimers();
    }
    const failedId = idOf(await run("create_task", { title: "Broken work", description: "d", assignTo: "agent-1", draft: true }));
    await polpo.getStore().updateTask(failedId, { result: { exitCode: 1, stdout: "", stderr: "Linear: 401 Unauthorized — the token was revoked", duration: 10 } });
    await polpo.getStore().unsafeSetStatus(failedId, "failed", "test");

    const all = await run("list_tasks");
    expect(all.indexOf("Broken work")).toBeLessThan(all.indexOf("Old work"));
    expect(all).toMatch(/Old work → agent-1 · created \d{4}-\d{2}-\d{2}T[^ ]+ · updated \d{4}-\d{2}-\d{2}T/);
    expect(all).toMatch(/Broken work .* — failed \(\w+\): Linear: 401 Unauthorized — the token was revoked/);

    const recent = await run("list_tasks", { updatedSince: "24h" });
    expect(recent).toMatch(/^1 task\(s\) updated since /);
    expect(recent).toContain("Broken work");
    expect(recent).not.toContain("Old work");
    expect(await run("list_tasks", { since: "7d" })).toContain("Old work");
    expect(await run("list_tasks", { createdSince: "1d", status: "failed" })).toContain("Broken work");
    expect(await run("list_tasks", { updatedSince: new Date(Date.now() + 60_000).toISOString() })).toMatch(/^No tasks found \(updated since /);
    expect(await run("list_tasks", { updatedSince: "yesterday" })).toMatch(/^Error: updatedSince "yesterday"/);

    // the REST API: GET /tasks?updatedSince= (legacy list and pages)
    const titles = async (q: string) => {
      const body = await (await app.request(`/api/v1/tasks?${q}`)).json() as { data: Array<{ title: string }> | { tasks: Array<{ title: string }>; hasMore: boolean } };
      return (Array.isArray(body.data) ? body.data : body.data.tasks).map((t) => t.title);
    };
    expect(await titles("updatedSince=24h&slim=true")).toEqual(["Broken work"]);
    expect((await titles("updatedSince=7d")).sort()).toEqual(["Broken work", "Old work"]);
    expect(await titles("updatedSince=24h&limit=1")).toEqual(["Broken work"]);
    const paged = await (await app.request("/api/v1/tasks?updatedSince=24h&limit=5")).json() as { data: { hasMore: boolean; nextCursor: string | null } };
    expect(paged.data).toMatchObject({ hasMore: false, nextCursor: null });
    const bad = await app.request("/api/v1/tasks?updatedSince=soon");
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("INVALID_SINCE");
    await polpo.deleteTask(oldId!);
    await polpo.deleteTask(failedId);
  });
});
