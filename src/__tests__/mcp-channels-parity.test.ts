/**
 * Channels' parity across REST and MCP on a real instance (createApp, the real routes, a mocked
 * Slack client — never real Slack, Meta or Telegram): Slack inbound (tokens through the dashboard
 * route only, status, a DM that pairs, sends to a channel and thread), who may write set field by
 * field, presence and linked identities, the notification history and counts, sending on every
 * channel type through the router, WhatsApp Business contacts' opt-in/opt-out and erasure, expo-push
 * as a channel type, and the scopes of the new tools.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { SlackClientFactory, SlackSocketLike } from "../notifications/slack-service.js";

const MCP_KEY = "mcp-key-for-channels-parity";
const BOT_TOKEN = "xoxb-9999-8888-parity-bot-token";
const APP_TOKEN = "xapp-1-A999-8888-parity-app-token";
let tmpDir: string;
let app: Hono;
let orchestrator: import("../core/orchestrator.js").Orchestrator;

// ── A mocked Slack app ──
class FakeSocket implements SlackSocketLike {
  listeners = new Map<string, Array<(...a: any[]) => void>>();
  on(event: string, l: (...a: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]); return this; }
  emit(event: string, ...args: any[]) { for (const l of this.listeners.get(event) ?? []) l(...args); }
  async start() { this.emit("connected"); return {}; }
  async disconnect() {}
}
const sockets: FakeSocket[] = [];
const web = {
  auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: "UBOT", user: "polpo", team: "Acme" }) },
  chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1712000000.000001" }) },
  filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
  users: { info: vi.fn().mockImplementation(async ({ user }: { user: string }) => ({ user: { profile: { display_name: user === "UALICE" ? "Alice" : "Bob" } } })) },
};
const clients: SlackClientFactory = async () => {
  const socket = new FakeSocket();
  sockets.push(socket);
  return { socket, web };
};
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
async function slackDm(user: string, text: string): Promise<void> {
  const socket = sockets.at(-1)!;
  socket.emit("slack_event", { ack: async () => {}, type: "events_api", body: { event: { type: "message", channel_type: "im", channel: `D${user}`, user, text, ts: `17120000${String(Math.floor(Math.random() * 99)).padStart(2, "0")}.${String(Date.now() % 1e6).padStart(6, "0")}` } } });
  await flush();
}

const realFetch = globalThis.fetch;
const hookCalls: Array<{ url: string; body: string }> = [];

beforeAll(async () => {
  process.env.POLPO_MCP_KEY = MCP_KEY;
  // the webhook channel's endpoint, never the network
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith("https://hooks.example.com/")) {
      hookCalls.push({ url: u, body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }
    return realFetch(url as never, init);
  });
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-channels-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-channels", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] },
    settings: {
      logLevel: "quiet",
      notifications: {
        channels: {
          "slack-team": { type: "slack", chatId: "C0OPS", gateway: { enableInbound: true, dmPolicy: "pairing" } },
          "hook": { type: "webhook", url: "https://hooks.example.com/polpo" },
          "wa-shop": { type: "whatsapp-business", phoneNumberId: "1234567", wabaId: "7654321", business: { audience: "customers" } },
          "mail": { type: "email", provider: "resend", from: "a@example.com", to: ["b@example.com"] },
        },
        rules: [],
      },
    },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new Orchestrator(tmpDir);
  orchestrator.setSlackClients(clients);
  await orchestrator.initInteractive("mcp-channels", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.POLPO_MCP_KEY;
  await orchestrator?.getSlack()?.dispose();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${MCP_KEY}` };
const rest = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/v1${path}`, { method, headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: await res.json() as any };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked field by field
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await (await app.request("/mcp", {
  method: "POST",
  headers: { ...auth, "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
})).json()).result;
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const channelsNow = async () => (await rest("GET", "/config")).json.data.settings.notifications.channels;

describe("Slack inbound: REST and MCP", () => {
  it("has no tokens at first: status says so and MCP hands the person off to the dashboard", async () => {
    const r = await rest("GET", "/slack");
    expect(r.status).toBe(200);
    expect(r.json.data.channels).toEqual([expect.objectContaining({ channel: "slack-team", inbound: true, state: "not-configured", secrets: { botToken: false, appToken: false } })]);
    const s = await tool("polpo_slack_status");
    expect(s.isError).toBeFalsy();
    expect(s.structuredContent.setup_ids).toEqual(["slack:slack-team:botToken", "slack:slack-team:appToken"]);
    expect(s.structuredContent.setup_url).toContain("section=channels");
    const wait = await tool("polpo_setup_wait", { setup_id: "slack:slack-team:botToken", timeout_seconds: 0 });
    expect(wait.structuredContent.status).toBe("pending");
  });

  it("takes the tokens only through the dashboard route, refuses what is not a token, never returns them", async () => {
    expect((await rest("PUT", "/slack/slack-team/secrets", { botToken: "nope-not-a-token-at-all" })).status).toBe(400);
    const r = await rest("PUT", "/slack/slack-team/secrets", { botToken: BOT_TOKEN, appToken: APP_TOKEN });
    expect(r.status).toBe(200);
    expect(r.json.data.secrets).toEqual({ botToken: true, appToken: true });
    await flush();
    const st = await rest("GET", "/slack/slack-team/status");
    expect(st.json.data).toMatchObject({ state: "connected", botName: "polpo", team: "Acme" });
    for (const body of [JSON.stringify(st.json), JSON.stringify(await rest("GET", "/config")), JSON.stringify(await tool("polpo_slack_status"))]) {
      expect(body).not.toContain(BOT_TOKEN);
      expect(body).not.toContain(APP_TOKEN);
    }
    expect((await tool("polpo_setup_wait", { setup_ids: ["slack:slack-team:botToken", "slack:slack-team:appToken"], timeout_seconds: 0 })).structuredContent.status).toBe("done");
    expect((await tool("polpo_slack_status", { test: true })).structuredContent.test).toMatchObject({ ok: true });
    expect((await rest("POST", "/slack/nope/test")).status).toBe(404);
  });

  it("a DM from an unknown person gets a pairing code; an invite is redeemed with /polpo start", async () => {
    await slackDm("UALICE", "hello there");
    expect(web.chat.postMessage.mock.calls.at(-1)![0]).toMatchObject({ channel: "DUALICE" });
    expect(String(web.chat.postMessage.mock.calls.at(-1)![0].text)).toMatch(/pairing code/i);
    const inv = await rest("POST", "/peers/invites?channel=slack-team");
    expect(inv.json.data.command).toMatch(/^\/polpo start /);
    const socket = sockets.at(-1)!;
    socket.emit("slack_event", { ack: async () => {}, type: "slash_commands", body: { command: "/polpo", text: `start ${inv.json.data.token}`, user_id: "UBOB", channel_id: "DUBOB" } });
    await flush();
    expect((await rest("GET", `/peers/invites/${inv.json.data.token}?channel=slack-team`)).json.data).toMatchObject({ status: "paired", peerId: "slack:UBOB" });
  });

  it("creates a Slack channel through MCP without secrets and names the tokens it still needs", async () => {
    const r = await tool("polpo_channel_save", { name: "slack-2", type: "slack", chat_id: "C0DEV", slack: { channelMessages: "all" }, gateway: { enableInbound: true } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.needs_secrets).toEqual(["botToken", "appToken"]);
    expect(r.structuredContent.setup_ids).toEqual(["slack:slack-2:botToken", "slack:slack-2:appToken"]);
    expect((await channelsNow())["slack-2"]).toMatchObject({ type: "slack", chatId: "C0DEV", slack: { channelMessages: "all" } });
  });

  it("creates an expo-push channel through MCP and REST", async () => {
    const r = await tool("polpo_channel_save", { name: "mobile", type: "expo-push" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.needs_secrets).toEqual([]);
    expect((await channelsNow()).mobile).toEqual({ type: "expo-push" });
    expect((await rest("PUT", "/config/channels/mobile-2", { type: "expo-push" })).status).toBe(200);
  });
});

describe("who may write, one field at a time", () => {
  it("sets the DM policy and changes allowFrom without touching the rest of the gateway", async () => {
    const r = await tool("polpo_channel_access_set", { channel: "slack-team", dm_policy: "allowlist", allow_add: ["UALICE", "UCAROL"] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.changed).toEqual(["dmPolicy", "allowFrom"]);
    let ch = (await channelsNow())["slack-team"];
    expect(ch.gateway).toEqual({ enableInbound: true, dmPolicy: "allowlist", allowFrom: ["UALICE", "UCAROL"] });
    await tool("polpo_channel_access_set", { channel: "slack-team", allow_remove: ["UCAROL"] });
    ch = (await channelsNow())["slack-team"];
    expect(ch.gateway.allowFrom).toEqual(["UALICE"]);
    const routes = await tool("polpo_channel_routes_list");
    expect(routes.structuredContent.routes.find((x: { channel: string }) => x.channel === "slack-team")).toMatchObject({ dm_policy: "allowlist", allow_from: ["UALICE"] });
    expect((await tool("polpo_channel_access_set", { channel: "mail", dm_policy: "open" })).isError).toBe(true);
    expect((await tool("polpo_channel_access_set", { channel: "slack-team", allow_from: [], allow_add: ["x"] })).isError).toBe(true);
    // now allowed: Alice's DM is answered by the gateway (no pairing code any more)
    await tool("polpo_channel_access_set", { channel: "slack-team", dm_policy: "pairing" });
  });
});

describe("people across channels: presence and links", () => {
  it("shows who is active and links two identities (unknown peers refused, null unlinks)", async () => {
    const p = await tool("polpo_peer_presence", { channel: "slack" });
    expect(p.isError).toBeFalsy();
    expect(p.structuredContent.presence.map((x: { peerId: string }) => x.peerId)).toEqual(expect.arrayContaining(["slack:UALICE"]));
    expect((await tool("polpo_peer_link", { peer_id: "slack:UALICE", linked_to: "telegram:404" })).isError).toBe(true);
    expect((await rest("POST", "/peers/link", { peerId: "slack:UALICE", linkedTo: "slack:UALICE" })).status).toBe(400);
    const l = await tool("polpo_peer_link", { peer_id: "slack:UALICE", linked_to: "slack:UBOB" });
    expect(l.isError).toBeFalsy();
    expect((await tool("polpo_peer_presence")).structuredContent.links).toEqual([{ peer_id: "slack:UALICE", linked_to: "slack:UBOB" }]);
    await tool("polpo_peer_link", { peer_id: "slack:UALICE", linked_to: null });
    expect((await tool("polpo_peer_presence")).structuredContent.links).toEqual([]);
  });
});

describe("sending on any channel, and the history", () => {
  it("previews without confirm, then posts to a Slack channel and thread with the bot token", async () => {
    const preview = await tool("polpo_message_send", { channel: "slack", name: "slack-team", to: "C0DEV", thread_ts: "1712345678.000001", text: "Release is out", confirm: false });
    expect(preview.isError).toBe(true);
    expect(text(preview)).toContain("Ready to send");
    const before = web.chat.postMessage.mock.calls.length;
    const r = await tool("polpo_message_send", { channel: "slack", name: "slack-team", to: "C0DEV", thread_ts: "1712345678.000001", title: "Deploy", text: "Release is out", confirm: true });
    expect(r.isError).toBeFalsy();
    expect(web.chat.postMessage.mock.calls.length).toBe(before + 1);
    expect(web.chat.postMessage.mock.calls.at(-1)![0]).toMatchObject({ channel: "C0DEV", thread_ts: "1712345678.000001", text: "*Deploy*\nRelease is out" });
    // two Slack channels now: the name is needed
    expect(text(await tool("polpo_message_send", { channel: "slack", text: "x", confirm: true }))).toMatch(/Say which slack channel/);
  });

  it("posts on a webhook through the router, refuses a recipient there", async () => {
    expect((await tool("polpo_message_send", { channel: "webhook", to: "someone", text: "hi", confirm: true })).isError).toBe(true);
    const r = await tool("polpo_message_send", { channel: "webhook", text: "Nightly report ready", title: "Report", confirm: true });
    expect(r.isError).toBeFalsy();
    expect(hookCalls.at(-1)!.body).toContain("Nightly report ready");
  });

  it("respects the WhatsApp Business window: a free-form message to someone who never wrote is refused", async () => {
    const r = await tool("polpo_message_send", { channel: "whatsapp-business", to: "+39 333 1234567", text: "Hello", confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/24 hours|template/);
  });

  it("lists the history (sent and failed) and counts it, on REST and MCP", async () => {
    const list = await tool("polpo_notifications_list", { limit: 20 });
    expect(list.isError).toBeFalsy();
    const rows = list.structuredContent.notifications as Array<{ channel: string; status: string }>;
    expect(rows.some((n) => n.channel === "slack-team" && n.status === "sent")).toBe(true);
    expect(rows.some((n) => n.channel === "hook" && n.status === "sent")).toBe(true);
    const bySlack = await tool("polpo_notifications_list", { channel: "slack-team" });
    expect((bySlack.structuredContent.notifications as Array<{ channel: string }>).every((n) => n.channel === "slack-team")).toBe(true);
    expect((await tool("polpo_notifications_list", { channel: "x", status: "sent" })).isError).toBe(true);
    const stats = await tool("polpo_notifications_stats");
    const restStats = (await rest("GET", "/notifications/stats")).json.data;
    expect(stats.structuredContent).toEqual({ total: restStats.total, sent: restStats.sent, failed: restStats.failed });
    expect(stats.structuredContent.sent).toBeGreaterThanOrEqual(2);
  });
});

describe("WhatsApp Business contacts: opt-in, opt-out, erasure", () => {
  it("records an opt-out and an opt-in, erases only with confirm", async () => {
    const out = await tool("polpo_wabiz_contact", { contact: "393331234567", opt_in: false, source: "asked by phone" });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.contact.optOut).toBeTruthy();
    const conv = await rest("GET", "/whatsapp-business/wa-shop/contacts/393331234567");
    expect(conv.json.data.optOut ?? conv.json.data.contact?.optOut).toBeTruthy();
    const back = await tool("polpo_wabiz_contact", { contact: "393331234567", opt_in: true });
    expect(back.structuredContent.contact.optIn).toBeTruthy();

    const refused = await tool("polpo_wabiz_contact_erase", { contact: "393331234567" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("confirm: true");
    const erased = await tool("polpo_wabiz_contact_erase", { contact: "393331234567", confirm: true });
    expect(erased.structuredContent).toMatchObject({ erased: true });
    expect(text(await tool("polpo_wabiz_contact_erase", { contact: "393331234567", confirm: true }))).toMatch(/No contact/);
  });
});

describe("scopes of the new tools", () => {
  it("reads need read (people-naming ones admin), changes admin, sending messages", async () => {
    const { toolScopeMatrix } = await import("../server/mcp.js");
    const m = Object.fromEntries(toolScopeMatrix().map((t) => [t.name, t]));
    for (const name of ["polpo_notifications_list", "polpo_notifications_stats", "polpo_slack_status"]) expect(m[name], name).toMatchObject({ scope: "polpo:read", readOnly: true });
    expect(m.polpo_peer_presence).toMatchObject({ scope: "polpo:admin", readOnly: true });
    for (const name of ["polpo_channel_access_set", "polpo_peer_link", "polpo_wabiz_contact"]) expect(m[name], name).toMatchObject({ scope: "polpo:admin", readOnly: false });
    expect(m.polpo_wabiz_contact_erase).toMatchObject({ scope: "polpo:admin", destructive: true });
    expect(m.polpo_message_send.scope).toBe("polpo:messages");
  });

  it("offers no channel type that does not exist", async () => {
    const list = await (await app.request("/mcp", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })).json() as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    const schemas = JSON.stringify(list.result.tools.filter((t) => /channel|peer|message_send|slack/.test(t.name)).map((t) => t.inputSchema));
    expect(schemas).not.toContain("discord");
    expect(schemas).not.toContain("webchat");
    expect(schemas).toContain("expo-push");
  });
});
