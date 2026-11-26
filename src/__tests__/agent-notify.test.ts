/**
 * Agents posting to notification channels (send_notification): the allowlist (notifyChannels +
 * allowedTools), the tool offered only then, refusals naming what is allowed, the per-agent rate
 * limit, the send through the notification router (throwOnError, target, origin in the history),
 * and every engine path: Polpo's engine in a task run (over the runner ↔ orchestrator socket, as
 * the run's agent), a harness host tool, the CLI engine's MCP tool server, and chats in process.
 * Mocks only: no real Slack / Telegram.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  agentHasNotifyTool, agentNotifyChannelWarnings, agentNotifyChannelsProblems, agentNotifyPerMinute, agentNotifyRefusal,
  normalizeAgentNotifyChannels, type AgentConfig, type NotificationRecord, type Task,
} from "@polpo-ai/core";
import { AgentNotifier, registerAgentNotifier, type AgentNotifyRouter } from "../notifications/agent-notify.js";
import { createAgentNotifyTools } from "../tools/notify-tools.js";
import { handleAgentNotifyWire, socketAgentNotify } from "../core/agent-notify-bridge.js";
import { startNotificationServer } from "../core/notification.js";
import { buildAgentToolset } from "../adapters/engine.js";
import { toHarnessHostTools } from "../harness/host-tools.js";
import { openCliToolServer } from "../cli-engine/tool-server.js";
import { NotificationRouter } from "../notifications/index.js";
import { TypedEmitter } from "../core/events.js";
import type { Notification, NotificationChannel } from "../notifications/types.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const LEAD: AgentConfig = {
  name: "lead-notifier",
  allowedTools: ["read", "send_notification"],
  notifyChannels: [{ channel: "slack", targets: ["C0LEADBF"] }, { channel: "telegram" }],
};

/** A router that records what it is asked to send (the real one's sendDirect shape). */
function fakeRouter(opts: { channels?: string[]; fail?: string } = {}) {
  const sent: Array<Parameters<AgentNotifyRouter["sendDirect"]>[0]> = [];
  let n = 0;
  const router: AgentNotifyRouter = {
    getChannelIds: () => opts.channels ?? ["slack", "telegram", "email"],
    sendDirect: async (o) => {
      if (opts.fail) throw new Error(opts.fail);
      sent.push(o);
      return { id: `n${++n}` };
    },
  };
  return { router, sent };
}

describe("the allowlist", () => {
  it("shape, normalization and warnings for channels not configured", () => {
    expect(agentNotifyChannelsProblems("*")).toEqual([]);
    expect(agentNotifyChannelsProblems([{ channel: "slack", targets: ["C1"] }])).toEqual([]);
    expect(agentNotifyChannelsProblems("all")[0]).toMatch(/must be "\*" or a list/);
    expect(agentNotifyChannelsProblems([{ channel: "" }])[0]).toMatch(/channel must be a channel name/);
    expect(agentNotifyChannelsProblems([{ channel: "slack", targets: [""] }])[0]).toMatch(/targets must be a list/);
    expect(agentNotifyChannelsProblems([{ channel: "slack", to: "x" }])[0]).toMatch(/unknown field to/);
    expect(normalizeAgentNotifyChannels([
      { channel: " slack ", targets: ["C1"] }, { channel: "slack", targets: ["C2", "C1"] }, { channel: "tg" }, { channel: "mail", targets: ["a@x.io", "*"] },
    ])).toEqual([{ channel: "slack", targets: ["C1", "C2"] }, { channel: "tg" }, { channel: "mail", targets: ["*"] }]);
    expect(normalizeAgentNotifyChannels([])).toBeUndefined();
    expect(normalizeAgentNotifyChannels("*")).toBe("*");
    expect(agentNotifyChannelWarnings([{ channel: "slack" }, { channel: "later" }], ["slack"])).toEqual([
      expect.stringMatching(/channel "later" is not configured \(yet\)/),
    ]);
    expect(agentNotifyPerMinute({})).toBe(5);
    expect(agentNotifyPerMinute({ notifyRateLimit: 500 })).toBe(60);
  });

  it("the tool needs both: send_notification in allowedTools (a pattern counts) and a channel", () => {
    expect(agentHasNotifyTool(LEAD)).toBe(true);
    expect(agentHasNotifyTool({ ...LEAD, allowedTools: ["read"] })).toBe(false);
    expect(agentHasNotifyTool({ ...LEAD, allowedTools: undefined })).toBe(false);
    expect(agentHasNotifyTool({ ...LEAD, allowedTools: ["send_*"] })).toBe(true);
    expect(agentHasNotifyTool({ ...LEAD, notifyChannels: undefined })).toBe(false);
    expect(agentHasNotifyTool({ ...LEAD, notifyChannels: [] })).toBe(false);
    expect(agentHasNotifyTool({ ...LEAD, notifyChannels: "*" })).toBe(true);
  });

  it("refusals name what is allowed", () => {
    expect(agentNotifyRefusal(LEAD, { channel: "slack", to: "C0LEADBF" })).toBeUndefined();
    expect(agentNotifyRefusal(LEAD, { channel: "telegram" })).toBeUndefined();
    const other = agentNotifyRefusal(LEAD, { channel: "email" })!;
    expect(other).toMatch(/may not post to channel "email"/);
    expect(other).toMatch(/Allowed: "slack" \(to: "C0LEADBF"\); "telegram" \(its default target only/);
    expect(agentNotifyRefusal(LEAD, { channel: "slack", to: "C0GENERAL" })).toMatch(/may not post to "C0GENERAL" on "slack"/);
    expect(agentNotifyRefusal(LEAD, { channel: "slack" })).toMatch(/needs a target \(`to`\)/);
    expect(agentNotifyRefusal(LEAD, { channel: "telegram", to: "-100123" })).toMatch(/only post to the default target of "telegram"/);
    expect(agentNotifyRefusal({ ...LEAD, notifyChannels: [{ channel: "slack", targets: ["*"] }] }, { channel: "slack", to: "C9" })).toBeUndefined();
    const star = { ...LEAD, notifyChannels: "*" as const };
    expect(agentNotifyRefusal(star, { channel: "email" }, ["slack", "email"])).toBeUndefined();
    expect(agentNotifyRefusal(star, { channel: "email", to: "x@y.io" }, ["slack", "email"])).toMatch(/default target/);
    expect(agentNotifyRefusal(star, { channel: "nope" }, ["slack"])).toMatch(/"nope" is not configured/);
    expect(agentNotifyRefusal({ ...LEAD, allowedTools: [] }, { channel: "slack", to: "C0LEADBF" })).toMatch(/needs send_notification in allowedTools/);
  });
});

describe("AgentNotifier: the send, as the agent", () => {
  it("an allowed send reaches the router with the channel, the target, the thread and the origin; errors surface", async () => {
    const { router, sent } = fakeRouter();
    const notifier = new AgentNotifier({ router: () => router });
    const r = await notifier.send(LEAD, { channel: "slack", to: "C0LEADBF", threadTs: "1712345678.000100", title: "Lead ACME", body: "**Why**: …", severity: "warning" },
      { taskId: "t1", missionId: "m1", runId: "r1" });
    expect(r).toEqual({ id: "n1", channel: "slack", to: "C0LEADBF" });
    expect(sent).toEqual([{
      channel: "slack", title: "Lead ACME", body: "**Why**: …", severity: "warning", throwOnError: true,
      ruleName: "Agent lead-notifier · task t1",
      origin: { kind: "agent", agent: "lead-notifier", taskId: "t1", missionId: "m1", runId: "r1" },
      target: { chatId: "C0LEADBF", threadTs: "1712345678.000100" },
    }]);
    // default title, default target (no target object)
    await notifier.send({ ...LEAD, identity: { displayName: "Lia" } } as AgentConfig, { channel: "telegram", body: "hi" }, { sessionId: "s1" });
    expect(sent[1]).toMatchObject({ channel: "telegram", title: "Message from Lia", severity: "info", origin: { kind: "agent", agent: "lead-notifier", sessionId: "s1" }, ruleName: "Agent lead-notifier · chat s1" });
    expect(sent[1]!.target).toBeUndefined();

    const failing = new AgentNotifier({ router: () => fakeRouter({ fail: "channel_not_found" }).router });
    await expect(failing.send(LEAD, { channel: "telegram", body: "x" }, {})).rejects.toThrow(/Not sent to "telegram": channel_not_found/);
  });

  it("refused: a channel or target not allowed, an empty or too long body, a channel not configured, no router", async () => {
    const { router, sent } = fakeRouter({ channels: ["slack"] });
    const notifier = new AgentNotifier({ router: () => router });
    await expect(notifier.send(LEAD, { channel: "email", body: "x" }, {})).rejects.toMatchObject({ code: "NOT_ALLOWED", message: expect.stringMatching(/Allowed:/) });
    await expect(notifier.send(LEAD, { channel: "slack", to: "C0OTHER", body: "x" }, {})).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(notifier.send(LEAD, { channel: "slack", to: "C0LEADBF", body: "  " }, {})).rejects.toMatchObject({ code: "INVALID" });
    await expect(notifier.send(LEAD, { channel: "slack", to: "C0LEADBF", body: "x".repeat(8001) }, {})).rejects.toMatchObject({ code: "INVALID" });
    // allowed by the agent, but the instance has no such channel (yet)
    await expect(notifier.send(LEAD, { channel: "telegram", body: "x" }, {})).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(new AgentNotifier({ router: () => undefined }).send(LEAD, { channel: "slack", body: "x" }, {})).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(sent).toEqual([]);
  });

  it("rate limit: N per minute per agent (default 5, notifyRateLimit), then it frees up", async () => {
    let now = 1_000_000;
    const { router, sent } = fakeRouter();
    const notifier = new AgentNotifier({ router: () => router, now: () => now });
    const agent = { ...LEAD, notifyRateLimit: 2 };
    const send = () => notifier.send(agent, { channel: "telegram", body: "x" }, {});
    await send(); await send();
    await expect(send()).rejects.toMatchObject({ code: "RATE_LIMITED", message: expect.stringMatching(/may send 2 notifications per minute; try again in 60s/) });
    // another agent has its own budget
    await notifier.send({ ...LEAD, name: "other" }, { channel: "telegram", body: "x" }, {});
    now += 60_001;
    await send();
    expect(sent).toHaveLength(4);
    // the default
    const def = new AgentNotifier({ router: () => router, now: () => now });
    for (let i = 0; i < 5; i++) await def.send(LEAD, { channel: "telegram", body: "x" }, {});
    await expect(def.send(LEAD, { channel: "telegram", body: "x" }, {})).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("through the real NotificationRouter: the channel gets it and the history records the agent and its task", async () => {
    const router = new NotificationRouter(new TypedEmitter());
    router.init({ channels: {}, rules: [] });
    const got: Notification[] = [];
    const channel: NotificationChannel = { type: "slack", send: async (n) => { got.push(n); }, test: async () => true };
    router.registerChannel("slack", channel);
    const records: NotificationRecord[] = [];
    router.setStore({ append: async (r) => { records.push(r); }, list: async () => records, listByChannel: async () => [], listByRule: async () => [], listByStatus: async () => [], count: async () => records.length, prune: async () => 0, close: () => {} });
    const notifier = new AgentNotifier({ router: () => router });
    await notifier.send(LEAD, { channel: "slack", to: "C0LEADBF", body: "Review this lead" }, { taskId: "t9" });
    expect(got[0]).toMatchObject({ channel: "slack", body: "Review this lead", sourceData: { chatId: "C0LEADBF", origin: { kind: "agent", agent: "lead-notifier", taskId: "t9" } } });
    expect(records[0]).toMatchObject({ status: "sent", channel: "slack", ruleName: "Agent lead-notifier · task t9", origin: { kind: "agent", agent: "lead-notifier", taskId: "t9" } });
    // a channel that refuses: the agent sees the error, the history keeps the failure with its origin
    router.registerChannel("slack", { type: "slack", send: async () => { throw new Error("not_in_channel"); }, test: async () => true });
    await expect(notifier.send(LEAD, { channel: "slack", to: "C0LEADBF", body: "again" }, { taskId: "t9" })).rejects.toThrow(/not_in_channel/);
    expect(records[1]).toMatchObject({ status: "failed", error: "not_in_channel", origin: { agent: "lead-notifier" } });
  });
});

describe("the tool", () => {
  it("offered only with the allowlist and allowedTools; its description names what is allowed", async () => {
    const sends: unknown[] = [];
    const access = { send: async (req: unknown) => { sends.push(req); return { id: "n1", channel: "slack", to: "C0LEADBF" }; } };
    expect(createAgentNotifyTools({ ...LEAD, allowedTools: ["read"] }, access)).toEqual([]);
    expect(createAgentNotifyTools({ ...LEAD, notifyChannels: undefined }, access)).toEqual([]);
    expect(createAgentNotifyTools(LEAD, undefined)).toEqual([]);
    const [tool] = createAgentNotifyTools(LEAD, access);
    expect(tool!.name).toBe("send_notification");
    expect(tool!.description).toMatch(/Allowed: "slack" \(to: "C0LEADBF"\); "telegram"/);
    expect(tool!.description).toMatch(/At most 5 per minute/);
    const ok = await tool!.execute("c1", { channel: "slack", to: "C0LEADBF", thread_ts: "171.1", body: "hello" });
    expect(ok.content[0]).toMatchObject({ text: 'Notification sent to "slack" (C0LEADBF, thread 171.1) [n1].' });
    expect(sends).toEqual([{ channel: "slack", to: "C0LEADBF", threadTs: "171.1", body: "hello" }]);
    // refused locally (the server checks again): nothing is asked
    const no = await tool!.execute("c2", { channel: "email", body: "x" });
    expect(no.content[0].text).toMatch(/^Error: Agent "lead-notifier" may not post to channel "email"/);
    expect(sends).toHaveLength(1);
  });
});

describe("every engine", () => {
  const task = { id: "t1", title: "T", description: "d", assignTo: "lead-notifier", missionId: "m1", dependsOn: [], status: "in_progress", expectations: [], metrics: [], retries: 0, maxRetries: 1, createdAt: "", updatedAt: "" } as unknown as Task;

  /** The orchestrator's side of the socket: runs, tasks and agents as the server knows them. */
  async function orchestratorSocket(agent: AgentConfig) {
    const dir = tmp("polpo-notify-sock-");
    const { router, sent } = fakeRouter();
    const notifier = new AgentNotifier({ router: () => router });
    const runs: Record<string, { agentName: string; taskId: string; status: string }> = {
      "run-1": { agentName: "lead-notifier", taskId: "t1", status: "running" },
      "run-old": { agentName: "lead-notifier", taskId: "t1", status: "completed" },
    };
    const server = startNotificationServer(dir, () => {}, undefined, undefined, undefined,
      (msg) => handleAgentNotifyWire(msg, { notifier, run: async (id) => runs[id] as never, task: async () => task, agentFor: async () => agent }));
    await new Promise((r) => server.once("listening", r));
    return { socket: join(dir, "orchestrator.sock"), sent, close: () => new Promise((r) => server.close(r)) };
  }

  async function toolset(ctx: Record<string, unknown>, agent: AgentConfig = LEAD, withTask = true) {
    const polpoDir = tmp("polpo-notify-toolset-");
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: agent.name }] }, settings: {} }));
    const ts = await buildAgentToolset({
      agentConfig: agent, cwd: polpoDir, sandboxProvider: "local", browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false,
      ...(withTask ? { task } : { notifyOrigin: { sessionId: "chat-1" } }), ctx: { polpoDir, ...ctx } as never,
    });
    await ts.connectorManager?.closeAll();
    return { tools: ts.tools, polpoDir };
  }

  it("Polpo's engine in a task run: over the socket, sent as the run's agent with the task and mission as origin", async () => {
    const orch = await orchestratorSocket(LEAD);
    try {
      const { tools } = await toolset({ agentNotify: socketAgentNotify(orch.socket, "run-1") });
      const tool = tools.find((t) => t.name === "send_notification")!;
      const r = await tool.execute("c1", { channel: "slack", to: "C0LEADBF", body: "Lead ACME: please review" });
      expect(r.content[0].text).toMatch(/^Notification sent to "slack" \(C0LEADBF\)/);
      expect(orch.sent).toEqual([expect.objectContaining({
        channel: "slack", body: "Lead ACME: please review", target: { chatId: "C0LEADBF" }, throwOnError: true,
        origin: { kind: "agent", agent: "lead-notifier", taskId: "t1", runId: "run-1", missionId: "m1" },
      })]);
      // the server's check, not only the tool's: a run that is not running, an unknown run
      await expect(socketAgentNotify(orch.socket, "run-old").send({ channel: "slack", to: "C0LEADBF", body: "x" })).rejects.toThrow("this run is not running");
      await expect(socketAgentNotify(orch.socket, "run-x").send({ channel: "slack", to: "C0LEADBF", body: "x" })).rejects.toThrow("this run is not running");
    } finally {
      await orch.close();
    }
  });

  it("the server enforces the run's agent's allowlist even if the runner's copy says otherwise", async () => {
    // the server's agent may only post to telegram; the runner (tampered) asks for slack
    const orch = await orchestratorSocket({ ...LEAD, notifyChannels: [{ channel: "telegram" }] });
    try {
      const { tools } = await toolset({ agentNotify: socketAgentNotify(orch.socket, "run-1") });
      const r = await tools.find((t) => t.name === "send_notification")!.execute("c1", { channel: "slack", to: "C0LEADBF", body: "x" });
      expect(r.content[0].text).toMatch(/^Error: Agent "lead-notifier" may not post to channel "slack". Allowed: "telegram"/);
      expect(orch.sent).toEqual([]);
    } finally {
      await orch.close();
    }
  });

  it("not offered without the allowlist or allowedTools, or without a way to send", async () => {
    const access = { send: async () => ({ id: "x", channel: "slack" }) };
    expect((await toolset({ agentNotify: access }, { ...LEAD, allowedTools: ["read"] })).tools.map((t) => t.name)).not.toContain("send_notification");
    expect((await toolset({ agentNotify: access }, { ...LEAD, notifyChannels: undefined })).tools.map((t) => t.name)).not.toContain("send_notification");
    // a runner without the socket and no server sender in this process
    expect((await toolset({})).tools.map((t) => t.name)).not.toContain("send_notification");
  });

  it("in the server process (CLI chats, agent tests): the instance's sender directly, with the chat as origin", async () => {
    const { router, sent } = fakeRouter();
    const polpoDir = tmp("polpo-notify-local-");
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: LEAD.name }] }, settings: {} }));
    const unregister = registerAgentNotifier(polpoDir, new AgentNotifier({ router: () => router }));
    try {
      const ts = await buildAgentToolset({
        agentConfig: LEAD, cwd: polpoDir, sandboxProvider: "local", browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false,
        notifyOrigin: { sessionId: "chat-1" }, ctx: { polpoDir },
      });
      await ts.connectorManager?.closeAll();
      await ts.tools.find((t) => t.name === "send_notification")!.execute("c1", { channel: "telegram", body: "hi" });
      expect(sent[0]).toMatchObject({ channel: "telegram", origin: { kind: "agent", agent: "lead-notifier", sessionId: "chat-1" } });
    } finally {
      unregister();
    }
  });

  it("a harness gets it as a host tool (not gated: the owner's allowlist is the consent) and a CLI over the MCP tool server", async () => {
    const orch = await orchestratorSocket(LEAD);
    try {
      const { tools } = await toolset({ agentNotify: socketAgentNotify(orch.socket, "run-1") });
      const host = toHarnessHostTools(tools, { interactive: true });
      const notify = host.find((t) => t.name === "send_notification")!;
      expect(notify.approval).toBeUndefined();
      expect(await notify.execute({ channel: "slack", to: "C0LEADBF", body: "from the harness" }, { toolCallId: "h1" } as never))
        .toMatch(/^Notification sent to "slack"/);
      expect(await notify.execute({ channel: "slack", to: "C0NOPE", body: "x" }, { toolCallId: "h2" } as never))
        .toMatch(/^Error: Agent "lead-notifier" may not post to "C0NOPE" on "slack"/);

      const cli = await openCliToolServer({ tools: toHarnessHostTools(tools), loopback: true });
      const client = new Client({ name: "t", version: "1" });
      try {
        expect(cli.toolNames).toContain("send_notification");
        await client.connect(new StreamableHTTPClientTransport(new URL(cli.localUrl!), { requestInit: { headers: { Authorization: `Bearer ${cli.token}` } } }));
        const listed = (await client.listTools()).tools.find((t) => t.name === "send_notification")!;
        expect(listed.description).toMatch(/Allowed: "slack"/);
        const ok = await client.callTool({ name: "send_notification", arguments: { channel: "slack", to: "C0LEADBF", body: "from the CLI" } });
        expect(ok.isError).toBeFalsy();
        const refused = await client.callTool({ name: "send_notification", arguments: { channel: "email", body: "x" } });
        expect(refused.isError).toBe(true);
        expect((refused.content as Array<{ text: string }>)[0]!.text).toMatch(/may not post to channel "email"/);
      } finally {
        await client.close().catch(() => undefined);
        await cli.close();
      }
      expect(orch.sent.map((s) => s.body)).toEqual(["from the harness", "from the CLI"]);
    } finally {
      await orch.close();
    }
  });
});

describe("the socket server without a handler", () => {
  it("an old orchestrator answers that notifications cannot be sent from here", async () => {
    const dir = tmp("polpo-notify-nohandler-");
    const server = startNotificationServer(dir, () => {});
    await new Promise((r) => server.once("listening", r));
    try {
      await expect(socketAgentNotify(join(dir, "orchestrator.sock"), "run-1").send({ channel: "slack", body: "x" })).rejects.toThrow("notifications cannot be sent from here");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("no orchestrator listening: the tool says Polpo cannot be reached", async () => {
    const [tool] = createAgentNotifyTools(LEAD, socketAgentNotify(join(tmp("polpo-notify-none-"), "none.sock"), "run-1"));
    const r = await tool!.execute("c", { channel: "telegram", body: "x" });
    expect(r.content[0].text).toMatch(/^Error: Polpo cannot be reached from this run/);
    vi.restoreAllMocks();
  });
});
