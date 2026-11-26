import { describe, expect, it } from "vitest";
import {
  AGENT_FIELD_CLASSIFICATION, agentLinesChart, agentLinesMode, DEFAULT_NEW_AGENT_TALKS_TO, describeReachable, linesRefusal, mayTalk,
  normalizeTalksTo, reachableAgents, resolveAgentLines, talksToProblem, type AgentConfig,
} from "@polpo-ai/core";
import { validateAgents } from "../core/config.js";

/**
 *        ceo
 *       /   \
 *    cto     cmo
 *    /  \      \
 *  dev  qa    writer        legacy (no lines: from before them)
 */
const team = (over: Record<string, Partial<AgentConfig>> = {}): AgentConfig[] => [
  { name: "ceo", talksTo: { mode: "org" } },
  { name: "cto", reportsTo: "ceo", talksTo: { mode: "org" } },
  { name: "cmo", reportsTo: "ceo", talksTo: { mode: "org" } },
  { name: "dev", reportsTo: "cto", talksTo: { mode: "org" } },
  { name: "qa", reportsTo: "cto", talksTo: { mode: "org" } },
  { name: "writer", reportsTo: "cmo", talksTo: { mode: "org" } },
  { name: "legacy" },
].map((a) => ({ ...a, ...(over[a.name] ?? {}) }));

describe("communication lines: policy resolution", () => {
  it("org: its manager and its direct reports, plus extra agents", () => {
    const agents = team();
    expect(resolveAgentLines(agents[1]!, agents)).toMatchObject({ mode: "org", explicit: true, manager: "ceo", reports: ["dev", "qa"], reachable: ["ceo", "dev", "qa"] });
    expect(resolveAgentLines(agents[3]!, agents).reachable).toEqual(["cto"]);
    expect(resolveAgentLines(agents[0]!, agents).reachable).toEqual(["cto", "cmo"]);
    const withExtra = team({ dev: { talksTo: { mode: "org", agents: ["writer", "ghost", "dev"] } } });
    // unknown names and itself are ignored
    expect(resolveAgentLines(withExtra[3]!, withExtra)).toMatchObject({ reachable: ["cto", "writer"], agents: ["writer"] });
  });

  it("list: only the listed agents (not even its manager)", () => {
    const agents = team({ dev: { talksTo: { mode: "list", agents: ["qa"] } } });
    expect(reachableAgents("dev", agents)).toEqual(["qa"]);
    expect(mayTalk({ from: "dev", to: "cto" }, agents)).toBe(false);
  });

  it("anyone: every other agent; none: nobody", () => {
    const agents = team({ dev: { talksTo: { mode: "anyone" } }, qa: { talksTo: { mode: "none" } } });
    expect(reachableAgents("dev", agents)).toEqual(["ceo", "cto", "cmo", "qa", "writer", "legacy"]);
    expect(reachableAgents("qa", agents)).toEqual([]);
  });

  it("migration: an agent without lines talks to anyone (nothing breaks); new agents default to org", () => {
    const agents = team();
    expect(agentLinesMode(agents[6])).toBe("anyone");
    expect(resolveAgentLines(agents[6]!, agents)).toMatchObject({ mode: "anyone", explicit: false });
    expect(mayTalk({ from: "legacy", to: "writer" }, agents)).toBe(true);
    expect(DEFAULT_NEW_AGENT_TALKS_TO).toEqual({ mode: "org" });
    expect(agentLinesChart(agents).unrestricted).toEqual(["legacy"]);
  });

  it("Polpo always talks to everyone and every agent can answer Polpo", () => {
    const agents = team({ qa: { talksTo: { mode: "none", acceptFrom: "lines" } } });
    expect(mayTalk({ to: "qa" }, agents)).toBe(true);
    expect(mayTalk({ from: "polpo", to: "qa" }, agents)).toBe(true);
    expect(mayTalk({ from: "qa", to: "polpo" }, agents)).toBe(true);
  });

  it("escalation always reaches the manager, whatever the lines", () => {
    const agents = team({ dev: { talksTo: { mode: "none" } } });
    expect(mayTalk({ from: "dev", to: "cto" }, agents)).toBe(false);
    expect(mayTalk({ from: "dev", to: "cto", escalation: true }, agents)).toBe(true);
    // only the manager: escalation to someone else is still refused
    expect(mayTalk({ from: "dev", to: "ceo", escalation: true }, agents)).toBe(false);
  });

  it("acceptFrom lines: the receiver refuses senders outside its own lines", () => {
    const agents = team({ writer: { talksTo: { mode: "org", acceptFrom: "lines" } }, dev: { talksTo: { mode: "list", agents: ["writer", "qa"] } } });
    expect(linesRefusal({ from: "dev", to: "writer" }, agents)).toMatch(/^writer only accepts messages from its own communication lines/);
    // the sender's lines say they may: the receiver decides
    expect(reachableAgents("dev", agents)).toEqual(["qa"]);
    // its manager is in its lines
    expect(mayTalk({ from: "cmo", to: "writer" }, agents)).toBe(true);
  });

  it("refusals name who the agent can talk to", () => {
    const agents = team();
    expect(linesRefusal({ from: "dev", to: "writer" }, agents)).toBe("writer is outside your communication lines (org). You can talk to: cto.");
    const none = team({ dev: { talksTo: { mode: "none" } } });
    expect(linesRefusal({ from: "dev", to: "qa" }, none)).toBe("qa is outside your communication lines (none). You cannot talk to other agents. To escalate to your manager (cto), use escalate.");
    expect(describeReachable(resolveAgentLines(team()[6]!, team()))).toBe("You can talk to any agent of the team.");
  });

  it("the chart: directed edges by kind, receivers' refusals left out", () => {
    const agents = team({ dev: { talksTo: { mode: "org", agents: ["writer"] } }, writer: { talksTo: { mode: "org", acceptFrom: "lines" } } });
    const chart = agentLinesChart(agents);
    expect(chart.edges.filter((e) => e.from === "dev")).toEqual([{ from: "dev", to: "cto", kind: "manager" }]);
    expect(chart.edges.filter((e) => e.from === "cto")).toEqual([
      { from: "cto", to: "ceo", kind: "manager" }, { from: "cto", to: "dev", kind: "report" }, { from: "cto", to: "qa", kind: "report" },
    ]);
    expect(chart.edges.filter((e) => e.from === "legacy").every((e) => e.kind === "open")).toBe(true);
  });
});

describe("communication lines: config", () => {
  it("validates and normalizes talksTo", () => {
    expect(talksToProblem(undefined)).toBeUndefined();
    expect(talksToProblem({ mode: "everyone" })).toMatch(/talksTo.mode must be one of org, list, anyone, none/);
    expect(talksToProblem({ mode: "list", agents: [""] })).toMatch(/agent names/);
    expect(talksToProblem({ mode: "org", acceptFrom: "nobody" })).toMatch(/acceptFrom/);
    expect(normalizeTalksTo({ mode: "list", agents: [" a ", "a", "b"], acceptFrom: "anyone" })).toEqual({ mode: "list", agents: ["a", "b"] });
    const agents: any[] = [{ name: "a", talksTo: { mode: "org", agents: ["b", " b"] } }, { name: "b" }];
    validateAgents(agents);
    expect(agents[0].talksTo).toEqual({ mode: "org", agents: ["b"] });
    expect(() => validateAgents([{ name: "a", talksTo: { mode: "x" } }])).toThrow(/Agent "a": talksTo.mode/);
  });

  it("talksTo is a versioned field (draft → publish → deploy, like the other agent fields)", () => {
    expect(AGENT_FIELD_CLASSIFICATION.talksTo).toBe("versioned");
  });
});
