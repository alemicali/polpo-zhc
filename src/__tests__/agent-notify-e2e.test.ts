/**
 * Agents' notification channels on a real instance (createApp, the real routes): REST (create and
 * update with notifyChannels / notifyRateLimit, warnings for channels not configured, the versioning
 * flow, bad shapes refused), MCP (polpo_agent_update / _create / _get), Polpo's update_agent, and a
 * send through the instance's sender landing in GET /notifications with its origin. The channel is
 * a fake registered on the router: nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Orchestrator } from "../core/orchestrator.js";
import type { Notification } from "../notifications/types.js";

const PUBLIC = "https://polpo.example.com";
const MCP_KEY = "mcp-key-for-notify";
let tmpDir: string;
let app: Hono;
let orchestrator: Orchestrator;
const delivered: Notification[] = [];

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-notify-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  const team = { name: "t", agents: [{ name: "lead-notifier", role: "Explains leads" }] };
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "notify", team,
    settings: { logLevel: "quiet", notifications: { channels: { "slack-leads": { type: "webhook", url: "https://hooks.example.com/never-called" } }, rules: [] } },
  }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("notify", team);
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
  // the configured channel's sends land here (a fake: no network)
  orchestrator.getNotificationRouter()!.registerChannel("slack-leads", { type: "slack", send: async (n) => { delivered.push(n); }, test: async () => true });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
  await orchestrator?.gracefulStop?.().catch(() => undefined);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- responses are checked field by field
const api = async (method: string, path: string, body?: unknown): Promise<any> =>
  (await app.request(`/api/v1${path}`, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const request = (name: string, args: Record<string, unknown> = {}) => app.request("/mcp", {
  method: "POST",
  headers: { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_KEY}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked field by field
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => (await (await request(name, args)).json()).result;
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("notifyChannels over REST", () => {
  it("an update goes to the draft, then production when deployed; a channel not configured is a warning", async () => {
    const draft = await api("PATCH", "/agents/lead-notifier", {
      notifyChannels: [{ channel: "slack-leads", targets: ["C0LEADBF", "C0LEADBF"] }, { channel: "later" }], notifyRateLimit: 3,
      allowedTools: ["read", "send_notification"], publish: false,
    });
    expect(draft.ok).toBe(true);
    expect(draft.data.warnings).toEqual([expect.stringMatching(/channel "later" is not configured \(yet\)/)]);
    expect((await api("GET", "/agents/lead-notifier")).data.notifyChannels).toBeUndefined();
    const inDraft = (await api("GET", "/agents/lead-notifier?view=draft")).data;
    expect(inDraft.notifyChannels).toEqual([{ channel: "slack-leads", targets: ["C0LEADBF"] }, { channel: "later" }]);
    expect(inDraft.versioning.draft.changedFields).toEqual(expect.arrayContaining(["notifyChannels", "notifyRateLimit"]));
    expect((await api("PATCH", "/agents/lead-notifier", { notifyChannels: [{ channel: "slack-leads", targets: ["C0LEADBF"] }], deploy: true })).ok).toBe(true);
    const live = (await api("GET", "/agents/lead-notifier")).data;
    expect(live.notifyChannels).toEqual([{ channel: "slack-leads", targets: ["C0LEADBF"] }]);
    expect(live.notifyRateLimit).toBe(3);
  });

  it("a bad shape is refused; create takes it too; null clears it", async () => {
    const bad = await app.request("/api/v1/agents/lead-notifier", { method: "PATCH", headers: auth, body: JSON.stringify({ notifyChannels: [{ channel: "slack-leads", to: "C1" }] }) });
    expect(bad.status).toBe(400);
    const tooFast = await app.request("/api/v1/agents/lead-notifier", { method: "PATCH", headers: auth, body: JSON.stringify({ notifyRateLimit: 500 }) });
    expect(tooFast.status).toBe(400);
    const created = await api("POST", "/agents", { name: "pager", allowedTools: ["send_notification"], notifyChannels: "*", notifyRateLimit: 1 });
    expect(created.ok).toBe(true);
    expect(created.data.warnings).toBeUndefined();
    expect((await api("GET", "/agents/pager")).data).toMatchObject({ notifyChannels: "*", notifyRateLimit: 1 });
    expect((await api("PATCH", "/agents/pager", { notifyChannels: null, notifyRateLimit: null, deploy: true })).ok).toBe(true);
    const cleared = (await api("GET", "/agents/pager")).data;
    expect(cleared.notifyChannels).toBeUndefined();
    expect(cleared.notifyRateLimit).toBeUndefined();
  });
});

describe("notifyChannels over MCP and Polpo's chat tools", () => {
  it("polpo_agent_update sets it; polpo_agent_get shows it and warns when the tool is off", async () => {
    const set = await tool("polpo_agent_update", { name: "pager", notifyChannels: [{ channel: "slack-leads" }, { channel: "ghost" }], deploy: true });
    expect(set.isError).toBeFalsy();
    expect(text(set)).toMatch(/channel "ghost" is not configured/);
    const got = text(await tool("polpo_agent_get", { name: "pager" }));
    expect(got).toMatch(/notifications: "slack-leads" \(its default target only, no `to`\); "ghost" .* · max 5\/min/);
    expect(got).not.toMatch(/⚠ off/);
    await tool("polpo_agent_update", { name: "pager", allowedTools: ["read"], deploy: true });
    expect(text(await tool("polpo_agent_get", { name: "pager" }))).toMatch(/⚠ off: add send_notification to allowedTools/);
    const bad = await tool("polpo_agent_update", { name: "pager", notifyChannels: "all" });
    expect(bad.isError).toBe(true);
  });

  it("polpo_agent_create takes the allowlist", async () => {
    const r = await tool("polpo_agent_create", { name: "reporter", role: "Reports", allowedTools: ["send_notification"], notifyChannels: [{ channel: "slack-leads", targets: ["*"] }] });
    expect(r.isError).toBeFalsy();
    expect((await api("GET", "/agents/reporter")).data.notifyChannels).toEqual([{ channel: "slack-leads", targets: ["*"] }]);
  });

  it("Polpo's update_agent: sets, warns about channels and the missing tool, refuses bad shapes", async () => {
    const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
    const r = await executeOrchestratorTool("update_agent", { name: "reporter", notifyChannels: [{ channel: "nowhere" }], allowedTools: ["read"], deploy: true }, orchestrator);
    expect(r).toMatch(/Agent "reporter" updated/);
    expect(r).toMatch(/Warning: notifyChannels: channel "nowhere" is not configured/);
    expect(r).toMatch(/Warning: send_notification is not in its allowedTools/);
    expect((await api("GET", "/agents/reporter")).data.notifyChannels).toEqual([{ channel: "nowhere" }]);
    expect(await executeOrchestratorTool("update_agent", { name: "reporter", notifyChannels: [{ channel: "" }] }, orchestrator)).toMatch(/^Error: notifyChannels\[0\]\.channel/);
  });
});

describe("a send as the agent", () => {
  it("reaches the channel and the history (GET /notifications) with the agent and its chat as origin; a refusal sends nothing", async () => {
    const agent = (await orchestrator.getAgents()).find((a) => a.name === "lead-notifier")!;
    const notifier = orchestrator.getAgentNotifier()!;
    await notifier.send(agent, { channel: "slack-leads", to: "C0LEADBF", body: "Lead ACME looks ready: budget confirmed." }, { sessionId: "chat-7" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sourceData).toMatchObject({ chatId: "C0LEADBF", origin: { kind: "agent", agent: "lead-notifier", sessionId: "chat-7" } });
    await expect(notifier.send(agent, { channel: "slack-leads", to: "C0GENERAL", body: "x" }, {})).rejects.toThrow(/may not post to "C0GENERAL"/);
    expect(delivered).toHaveLength(1);
    const history = (await api("GET", "/notifications?limit=10")).data;
    expect(history[0]).toMatchObject({ channel: "slack-leads", status: "sent", ruleName: "Agent lead-notifier · chat chat-7", origin: { kind: "agent", agent: "lead-notifier", sessionId: "chat-7" } });
  });
});
