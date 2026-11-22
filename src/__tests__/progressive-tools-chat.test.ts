/**
 * Progressive tool discovery in the chat completions route (agents and Polpo): what each model
 * request carries, mid-turn loads, persistence across turns. The model is scripted (no provider).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionRoutes, type CompletionRouteDeps } from "@polpo-ai/server";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { FileSessionStore } from "../stores/file-session-store.js";
import { mockModel, mockTextResponse, mockToolCallResponse, mockTurnSequence } from "./helpers/mock-llm.js";

const tool = (name: string, description = `Does ${name}.`) => ({
  name, label: name, description, parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
});
const coreTools = Array.from({ length: 30 }, (_, i) => tool(`core_${i}`));
const linearTools = [
  tool("mcp__linear__create_issue", "Create a new issue in a Linear team."),
  tool("mcp__linear__list_issues", "List issues of a Linear team."),
];

interface Call { systemPrompt: string; messages: any[]; tools: any[] }

let dir: string;
let sessions: FileSessionStore;
let calls: Call[];
let executed: string[];
let script: ReturnType<typeof mockTurnSequence>;
let settings: Record<string, unknown>;
let agent: Record<string, unknown>;

function deps(): CompletionRouteDeps {
  return {
    getAgents: async () => [agent],
    getConfig: () => ({ settings }),
    getMemoryStore: () => undefined,
    getSessionStore: () => sessions,
    getStore: () => undefined,
    emit: () => {},
    connectorNames: () => ({ linear: "Linear" }),
    resolveAgentModel: async () => ({ model: mockModel(), streamOpts: {} }),
    buildAgentPrompt: () => "You are the test agent.",
    resolveAgentTools: async () => ({
      tools: [...coreTools, ...linearTools],
      executor: async (name: string) => { executed.push(name); return `${name} ran`; },
    }),
    resolveOrchestratorContext: async () => ({
      systemPrompt: "You are Polpo.",
      model: mockModel(),
      streamOpts: {},
      tools: [...coreTools, tool("get_status"), tool("data_query", "Query a data source with SQL."), tool("data_list_sources"), ...linearTools],
      executor: async (name: string) => { executed.push(name); return `${name} ran`; },
      isInteractive: () => false,
    }),
    streamLLM: (_model: unknown, context: { systemPrompt: string; messages: any[]; tools: any[] }) => {
      calls.push({ systemPrompt: context.systemPrompt, messages: [...context.messages], tools: context.tools });
      return script() as any;
    },
  };
}

async function post(body: Record<string, unknown>, sessionId?: string) {
  const app = completionRoutes(deps);
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(sessionId ? { "x-session-id": sessionId } : {}) },
    body: JSON.stringify({ stream: false, ...body }),
  });
  expect(res.status).toBe(200);
  return { json: await res.json() as any, sessionId: res.headers.get("x-session-id")! };
}

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-progressive-"));
  sessions = new FileSessionStore(dir);
  calls = [];
  executed = [];
  settings = {};
  agent = { name: "a1" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("chat completions: progressive tools", () => {
  it("gives every tool up front when the run is at or below the threshold", async () => {
    settings = { tools: { progressiveThreshold: 40 } };
    script = mockTurnSequence([mockTextResponse("hi")]);
    await post({ agent: "a1", messages: [{ role: "user", content: "hello" }] });
    expect(names(calls[0].tools)).toHaveLength(32);
    expect(names(calls[0].tools)).not.toContain("tools_search");
    expect(calls[0].systemPrompt).not.toContain("More tools on demand");
  });

  it("an agent with progressiveTools: never keeps every tool even above the threshold", async () => {
    agent = { name: "a1", progressiveTools: "never" };
    script = mockTurnSequence([mockTextResponse("hi")]);
    await post({ agent: "a1", messages: [{ role: "user", content: "hello" }] });
    expect(names(calls[0].tools)).toContain("mcp__linear__create_issue");
  });

  it("searches, loads mid-turn as a toolsAdded system message, and keeps the top-level list stable", async () => {
    script = mockTurnSequence([
      mockToolCallResponse("tools_search", { query: "linear issue" }),
      mockToolCallResponse("tools_load", { names: ["mcp__linear__create_issue"] }),
      mockToolCallResponse("mcp__linear__create_issue", {}),
      mockTextResponse("Created."),
    ]);
    const { json, sessionId } = await post({ agent: "a1", messages: [{ role: "user", content: "file a bug in Linear" }] });
    expect(json.choices[0].message.content).toContain("Created.");
    expect(calls).toHaveLength(4);

    // first request: core tools + the meta tools, the connector listed in the prompt
    const first = names(calls[0].tools);
    expect(first).toContain("tools_search");
    expect(first).toContain("tools_load");
    expect(first.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(calls[0].systemPrompt).toContain("## More tools on demand");
    expect(calls[0].systemPrompt).toContain("Connector Linear (`mcp__linear__*`): 2 tools");

    // the search result names the tool; the meta tools never reach the agent's executor
    const searchResult = calls[1].messages.find((m) => m.role === "toolResult" && m.toolName === "tools_search");
    expect(searchResult.content[0].text).toContain("Linear [connector linear]");
    expect(searchResult.content[0].text).toContain("- mcp__linear__create_issue — ");

    // after tools_load: the same top-level tools, the new one declared in the transcript
    for (const call of calls) expect(names(call.tools)).toEqual(first);
    const third = calls[2].messages;
    const loadIndex = third.findIndex((m) => m.role === "toolResult" && m.toolName === "tools_load");
    expect(third[loadIndex + 1]).toMatchObject({ role: "system", content: "" });
    expect(names(third[loadIndex + 1].toolsAdded)).toEqual(["mcp__linear__create_issue"]);
    // as pi-ai replays it: the loaded tool is current from that point on
    const replayed = getCurrentTools([{ role: "system", content: "", toolsAdded: calls[2].tools, timestamp: 0 }, ...third] as Message[]);
    expect(names(replayed)).toContain("mcp__linear__create_issue");
    expect(names(replayed)).not.toContain("mcp__linear__list_issues");
    expect(executed).toEqual(["mcp__linear__create_issue"]);

    // next turn of the session: what was loaded is in the top-level list from the start
    calls = [];
    script = mockTurnSequence([mockTextResponse("ok")]);
    await post({ agent: "a1", messages: [{ role: "user", content: "file a bug in Linear" }, { role: "assistant", content: "Created." }, { role: "user", content: "again" }] }, sessionId);
    expect(names(calls[0].tools)).toContain("mcp__linear__create_issue");
    expect(names(calls[0].tools)).not.toContain("mcp__linear__list_issues");
  });

  it("refuses tools the agent was not given", async () => {
    script = mockTurnSequence([
      mockToolCallResponse("tools_load", { names: ["mcp__gmail__send_email"] }),
      mockTextResponse("done"),
    ]);
    await post({ agent: "a1", messages: [{ role: "user", content: "send a mail" }] });
    const result = calls[1].messages.find((m) => m.role === "toolResult" && m.toolName === "tools_load");
    expect(result.content[0].text).toMatch(/^Error: Not found: mcp__gmail__send_email/);
    expect(calls[1].messages.some((m) => m.role === "system" && m.toolsAdded)).toBe(false);
  });

  it("Polpo defers its optional areas and connectors", async () => {
    script = mockTurnSequence([
      mockToolCallResponse("tools_load", { names: ["data"] }),
      mockTextResponse("done"),
    ]);
    await post({ messages: [{ role: "user", content: "query the sales data" }] });
    const first = names(calls[0].tools);
    expect(first).toContain("get_status");
    expect(first).toContain("tools_load");
    expect(first).not.toContain("data_query");
    expect(first).not.toContain("mcp__linear__create_issue");
    expect(calls[0].systemPrompt).toContain("Data sources and views (group `data`): 2 tools");
    const announcement = calls[1].messages.find((m) => m.role === "system" && m.toolsAdded);
    expect(names(announcement.toolsAdded)).toEqual(["data_query", "data_list_sources"]);
  });
});
