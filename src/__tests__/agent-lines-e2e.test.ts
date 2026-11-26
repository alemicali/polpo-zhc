/**
 * Communication lines on a real instance (createApp, the real routes): REST (create, update with
 * the versioning flow, GET /agents/lines), MCP (polpo_agent_update talksTo, polpo_agent_lines,
 * the agent card) and Polpo's bridged agent_lines. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { BRIDGED_TOOLS } from "../llm/polpo-mcp-bridge.js";

const PUBLIC = "https://polpo.example.com";
const MCP_KEY = "mcp-key-for-lines";
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-lines-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  // "lead" and "legacy" exist from before the lines: no talksTo
  const team = { name: "t", agents: [{ name: "lead", role: "Leads" }, { name: "legacy", role: "Old agent" }] };
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "lines", team, settings: { logLevel: "quiet" } }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("lines", team);
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
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

describe("communication lines over REST", () => {
  it("a new agent gets org lines; an agent from before keeps talking to anyone", async () => {
    expect((await api("POST", "/agents", { name: "dev", role: "Builds", reportsTo: "lead" })).ok).toBe(true);
    expect((await api("GET", "/agents/dev")).data.talksTo).toEqual({ mode: "org" });
    expect((await api("GET", "/agents/legacy")).data.talksTo).toBeUndefined();
    const lines = (await api("GET", "/agents/lines")).data;
    expect(lines.unrestricted.sort()).toEqual(["lead", "legacy"]);
    expect(lines.agents.find((l: { agent: string }) => l.agent === "dev")).toMatchObject({ mode: "org", explicit: true, manager: "lead", reachable: ["lead"] });
    expect(lines.edges).toContainEqual({ from: "dev", to: "lead", kind: "manager" });
  });

  it("an explicit talksTo on create; a bad one is refused", async () => {
    expect((await api("POST", "/agents", { name: "qa", talksTo: { mode: "list", agents: ["dev", "dev"] } })).ok).toBe(true);
    expect((await api("GET", "/agents/qa")).data.talksTo).toEqual({ mode: "list", agents: ["dev"] });
    const bad = await app.request("/api/v1/agents", { method: "POST", headers: auth, body: JSON.stringify({ name: "x", talksTo: { mode: "everyone" } }) });
    expect(bad.status).toBe(400);
  });

  it("an update goes through the versioning flow: the draft first, production when deployed; null clears the lines", async () => {
    const draft = await api("PATCH", "/agents/dev", { talksTo: { mode: "none" }, publish: false });
    expect(draft.ok).toBe(true);
    expect((await api("GET", "/agents/dev")).data.talksTo).toEqual({ mode: "org" });
    expect((await api("GET", "/agents/dev?view=draft")).data.talksTo).toEqual({ mode: "none" });
    expect((await api("GET", "/agents/dev?view=draft")).data.versioning.draft.changedFields).toContain("talksTo");
    // published and deployed: production runs it
    expect((await api("PATCH", "/agents/dev", { talksTo: { mode: "none" }, deploy: true })).ok).toBe(true);
    expect((await api("GET", "/agents/dev")).data.talksTo).toEqual({ mode: "none" });
    expect((await api("PATCH", "/agents/dev", { talksTo: null, deploy: true })).ok).toBe(true);
    expect((await api("GET", "/agents/dev")).data.talksTo).toBeUndefined();
  });
});

describe("communication lines over MCP", () => {
  it("polpo_agent_update sets talksTo; polpo_agent_lines and polpo_agent_get show them", async () => {
    const set = await tool("polpo_agent_update", { name: "legacy", talksTo: { mode: "org", agents: ["qa"] }, deploy: true });
    expect(set.isError).toBeFalsy();
    const lines = await tool("polpo_agent_lines");
    expect(lines.isError).toBeFalsy();
    expect(text(lines)).toMatch(/legacy · org .* talks to: qa/);
    expect(text(lines)).toMatch(/Not restricted yet \(talk to anyone\): lead, dev\./);
    const one = await tool("polpo_agent_lines", { agent: "legacy" });
    expect(one.structuredContent.chart.agents).toHaveLength(1);
    expect((await tool("polpo_agent_lines", { agent: "ghost" })).isError).toBe(true);
    expect(text(await tool("polpo_agent_get", { name: "legacy" }))).toMatch(/communication lines: org \(manager and direct reports \+ qa\)/);
    expect(text(await tool("polpo_agent_get", { name: "lead" }))).toMatch(/communication lines: anyone \(not set/);
  });

  it("the agent card shows who it talks to", async () => {
    const card = await tool("polpo_agent_show", { agent: "legacy" });
    expect(card.isError).toBeFalsy();
    expect(card.structuredContent.lines).toMatchObject({ mode: "org", explicit: true, reachable: ["qa"] });
    expect(text(card)).toMatch(/Communication lines: org — talks to qa/);
  });

  it("Polpo runs polpo_agent_lines as its own agent_lines", () => {
    expect(BRIDGED_TOOLS).toContainEqual({ mcp: "polpo_agent_lines", name: "agent_lines", group: "learning" });
  });
});
