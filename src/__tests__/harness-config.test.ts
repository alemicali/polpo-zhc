/**
 * Agent harnesses: settings.harnesses and agent.engine (parsing, refusals, the settings check),
 * and the REST surfaces that apply them (agents API, settings PATCH).
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_SUBSCRIPTION_REFUSAL, agentEngineProblem, agentHarness, parseAgentEngine, parseHarnessesSettings,
} from "@polpo-ai/core";

const ref = { owner: "ops", service: "bedrock" };
const bedrock = { enabled: ["claude-code"], "claude-code": { auth: "bedrock", credentialRef: ref, bedrock: { region: "us-east-1" }, model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" } };
const nina = { id: "nina", name: "Nina", kind: "daytona" };
const box = { id: "box", name: "Box", kind: "e2b" };

describe("settings.harnesses", () => {
  it("parses Bedrock, API key and Vertex settings with vault references", () => {
    expect(parseHarnessesSettings(bedrock)).toEqual(bedrock);
    expect(parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "api-key", credentialRef: { owner: "ops", service: "openai" } } }).codex?.auth).toBe("api-key");
    expect(parseHarnessesSettings({
      enabled: ["claude-code"], allowHost: true,
      "claude-code": { auth: "vertex", credentialRef: ref, vertex: { region: "us-east5", projectId: "polpo-prod" } },
    })).toMatchObject({ allowHost: true, "claude-code": { vertex: { region: "us-east5", projectId: "polpo-prod" } } });
  });

  it("refuses a Claude subscription, with the terms reason", () => {
    for (const auth of ["subscription", "max", "oauth", "claude.ai"]) {
      expect(() => parseHarnessesSettings({ enabled: ["claude-code"], "claude-code": { auth, credentialRef: ref } })).toThrow(CLAUDE_SUBSCRIPTION_REFUSAL);
    }
    expect(CLAUDE_SUBSCRIPTION_REFUSAL).toMatch(/terms/);
  });

  it("refuses a Codex ChatGPT login (not supported yet)", () => {
    expect(() => parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "chatgpt", credentialRef: ref } })).toThrow(/ChatGPT login is not supported/);
  });

  it("never takes a secret in the settings: only a vault reference", () => {
    expect(() => parseHarnessesSettings({ enabled: ["claude-code"], "claude-code": { auth: "api-key", credentialRef: "sk-ant-api03-xyz" } })).toThrow(/vault reference/);
    expect(() => parseHarnessesSettings({ enabled: ["claude-code"], "claude-code": { auth: "api-key", credentialRef: ref, apiKey: "sk-ant" } })).toThrow(/secrets never go in the settings/);
    expect(() => parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "api-key", credentialRef: { owner: "$harness", service: "x" } } })).toThrow(/vault reference/);
  });

  it("refuses an enabled harness without settings, Bedrock without a region, unknown harnesses", () => {
    expect(() => parseHarnessesSettings({ enabled: ["claude-code"] })).toThrow(/enabled but has no settings/);
    expect(() => parseHarnessesSettings({ enabled: ["claude-code"], "claude-code": { auth: "bedrock", credentialRef: ref } })).toThrow(/bedrock\.region/);
    expect(() => parseHarnessesSettings({ enabled: ["cursor"] })).toThrow(/enabled must be a list/);
  });
});

describe("agent.engine", () => {
  it("polpo (or nothing) is Polpo's engine; a harness by name or object", () => {
    expect(parseAgentEngine(undefined)).toBeUndefined();
    expect(parseAgentEngine("polpo")).toBeUndefined();
    expect(parseAgentEngine("codex")).toEqual({ harness: "codex" });
    expect(parseAgentEngine({ harness: "claude-code", model: "sonnet", permissionMode: "allow-edits", effort: "high", maxBudgetUsd: 2 }))
      .toEqual({ harness: "claude-code", model: "sonnet", permissionMode: "allow-edits", effort: "high", maxBudgetUsd: 2 });
    expect(() => parseAgentEngine({ harness: "claude-code", maxBudgetUsd: -1 })).toThrow(/maxBudgetUsd/);
    expect(() => parseAgentEngine({ harness: "claude-code", apiKey: "x" })).toThrow(/secrets never go/);
    expect(agentHarness({ engine: { harness: "codex" } })?.harness).toBe("codex");
    expect(agentHarness({ engine: "nonsense" })).toBeUndefined();
  });

  it("needs the harness enabled and a computer that can run it", () => {
    const agent = (o: Record<string, unknown> = {}) => ({ name: "ada", engine: { harness: "claude-code" }, defaultComputer: "nina", ...o });
    const settings = { harnesses: bedrock, computers: [nina, box] };
    expect(agentEngineProblem(agent(), settings, { daytonaApi: "v2" })).toBeNull();
    expect(agentEngineProblem(agent({ engine: "polpo" }), {})).toBeNull();
    expect(agentEngineProblem(agent({ engine: { harness: "codex" } }), settings)).toMatch(/Codex is not enabled/);
    expect(agentEngineProblem(agent(), { computers: [nina] })).toMatch(/Claude Code is not enabled/);
    // never the server's HOME: this server only with allowHost (isolated HOME)
    expect(agentEngineProblem(agent({ defaultComputer: undefined }), settings)).toMatch(/allowHost/);
    expect(agentEngineProblem(agent({ defaultComputer: "host" }), { ...settings, harnesses: { ...bedrock, allowHost: true } })).toBeNull();
    expect(agentEngineProblem(agent({ defaultComputer: "box" }), settings)).toMatch(/E2B/);
    expect(agentEngineProblem(agent(), settings, { daytonaApi: "v0" })).toMatch(/Daytona v2/);
    expect(agentEngineProblem(agent({ defaultComputer: "ghost" }), settings)).toMatch(/unknown computer/);
  });
});

describe("REST: agents and settings", () => {
  it("settings PATCH takes harnesses (vault refs), refuses a subscription, and never strands an agent on a disabled harness", async () => {
    const { configRoutes } = await import("@polpo-ai/server");
    let config: any = { project: "p", teams: [{ name: "t", agents: [{ name: "ada", engine: { harness: "claude-code" }, defaultComputer: "nina" }] }], settings: { computers: [nina] } };
    const app = configRoutes(() => ({ getConfig: () => config, reloadConfig: async () => true, saveConfig: async (c: any) => { config = c; }, getNotificationRouter: () => null } as any));
    const patch = (harnesses: unknown) => app.request("/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ harnesses }) });
    expect((await patch(bedrock)).status).toBe(200);
    expect(config.settings.harnesses).toEqual(bedrock);
    const sub = await patch({ enabled: ["claude-code"], "claude-code": { auth: "subscription", credentialRef: ref } });
    expect(sub.status).toBe(400);
    expect((await sub.json()).error).toMatch(/Anthropic's terms/);
    const strand = await patch({ enabled: [] });
    expect(strand.status).toBe(400);
    expect((await strand.json()).error).toMatch(/ada \(Claude Code\)/);
    expect(config.settings.harnesses).toEqual(bedrock);
  });

  it("the agents API answers 400 when the engine is not allowed, and saves a valid one", async () => {
    const { agentRoutes } = await import("@polpo-ai/server");
    const { HarnessConfigError, agentEngineProblem: problem } = await import("@polpo-ai/core");
    const agents: any[] = [{ name: "ada", role: "dev" }];
    const settings = { harnesses: bedrock, computers: [nina] };
    const updateAgent = async (name: string, updates: any) => {
      const a = agents.find((x) => x.name === name);
      const p = problem({ ...a, ...updates }, settings, { daytonaApi: "v2" });
      if (p) throw new HarnessConfigError(p);
      Object.assign(a, updates);
      return a;
    };
    const app = agentRoutes(() => ({
      getAgents: async () => agents, addAgent: async () => {}, removeAgent: async () => true, updateAgent,
      getTeams: async () => [], getTeam: async () => undefined, addTeam: async () => {}, removeTeam: async () => true, renameTeam: async () => {},
      taskStore: {}, runStore: {}, polpoDir: "/tmp", computerIds: () => ["nina"],
    }));
    const patch = (body: unknown) => app.request("/ada", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const bad = await patch({ engine: { harness: "codex" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Codex is not enabled/);
    const noComputer = await patch({ engine: { harness: "claude-code" } });
    expect(noComputer.status).toBe(400);
    expect((await patch({ engine: { harness: "claude-code", model: "sonnet" }, defaultComputer: "nina" })).status).toBe(200);
    expect(agents[0].engine).toEqual({ harness: "claude-code", model: "sonnet" });
    // back to Polpo's engine
    expect((await patch({ engine: "polpo" })).status).toBe(200);
    expect(agents[0].engine).toBeUndefined();
  });
});
