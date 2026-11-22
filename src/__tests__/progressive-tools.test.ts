import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_GROUPS,
  POLPO_TOOL_GROUPS,
  ProgressiveToolSet,
  declaredTools,
  loadedToolsFromHistory,
  progressiveEnabled,
  progressiveModeFor,
  restoreToolAnnouncements,
} from "@polpo-ai/core/progressive-tools";
import { normalizeToolsSettings } from "../core/config.js";

const tool = (name: string, description = `Does ${name}.`) => ({ name, description, parameters: { type: "object", properties: {} } });
const core = (count: number) => Array.from({ length: count }, (_, i) => tool(`core_${i}`));
const linear = [
  tool("mcp__linear__create_issue", "Create a new issue in a Linear team. Returns the issue id."),
  tool("mcp__linear__list_issues", "List issues, filtered by team, assignee or state."),
  tool("mcp__linear__update_issue", "Update an issue's title, state or assignee."),
];
const gmail = [
  tool("mcp__gmail__send_email", "Send an email from the connected Gmail account."),
  tool("mcp__gmail__search_threads", "Search mail threads with Gmail query syntax."),
];

describe("threshold", () => {
  it("gives every tool up front at or below the threshold (default 30)", () => {
    const set = new ProgressiveToolSet({ tools: [...core(25), ...linear, ...gmail], groups: AGENT_TOOL_GROUPS });
    expect(set.enabled).toBe(false);
    expect(set.initialTools().map((t) => t.name)).toHaveLength(30);
    expect(set.metaTools).toEqual([]);
    expect(set.promptSection()).toBe("");
  });

  it("defers connectors above the threshold and adds the two meta tools", () => {
    const set = new ProgressiveToolSet({ tools: [...core(26), ...linear, ...gmail], groups: AGENT_TOOL_GROUPS, connectorNames: { linear: "Linear" } });
    expect(set.enabled).toBe(true);
    const names = set.initialTools().map((t) => t.name);
    expect(names).toContain("core_0");
    expect(names).toContain("tools_search");
    expect(names).toContain("tools_load");
    expect(names.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(set.promptSection()).toContain("Connector Linear (`mcp__linear__*`): 3 tools");
    expect(set.promptSection()).toContain("Connector gmail (`mcp__gmail__*`): 2 tools");
  });

  it("honours the configured threshold and the modes", () => {
    const tools = [...core(5), ...linear];
    expect(new ProgressiveToolSet({ tools, threshold: 5 }).enabled).toBe(true);
    expect(new ProgressiveToolSet({ tools, threshold: 8 }).enabled).toBe(false);
    expect(new ProgressiveToolSet({ tools, mode: "always" }).enabled).toBe(true);
    expect(new ProgressiveToolSet({ tools: [...core(50), ...linear], mode: "never" }).enabled).toBe(false);
    // nothing to defer: never on
    expect(new ProgressiveToolSet({ tools: core(50), mode: "always" }).enabled).toBe(false);
    expect(progressiveEnabled(31, 1, "auto", undefined)).toBe(true);
    expect(progressiveEnabled(30, 1, "auto", undefined)).toBe(false);
  });

  it("takes the agent's mode over the instance default", () => {
    expect(progressiveModeFor(undefined, undefined)).toBe("auto");
    expect(progressiveModeFor(undefined, { progressive: "never" })).toBe("never");
    expect(progressiveModeFor({ progressiveTools: "always" }, { progressive: "never" })).toBe("always");
  });

  it("parses settings.tools leniently", () => {
    expect(normalizeToolsSettings({ progressiveThreshold: 12.7, progressive: "always", other: 1 })).toEqual({ progressiveThreshold: 12, progressive: "always" });
    expect(normalizeToolsSettings({ progressiveThreshold: -1, progressive: "sometimes" })).toBeUndefined();
  });
});

describe("groups", () => {
  it("defers the optional agent families but keeps the essential tools", () => {
    const tools = [tool("read"), tool("bash"), tool("http_fetch"), tool("vault_get"), tool("search_web"),
      tool("browser_navigate"), tool("browser_click"), tool("email_send"), tool("list_email_accounts"), tool("pdf_read"), tool("excel_read")];
    const set = new ProgressiveToolSet({ tools, groups: AGENT_TOOL_GROUPS, mode: "always" });
    expect(set.initialTools().map((t) => t.name)).toEqual(["read", "bash", "http_fetch", "vault_get", "search_web", "tools_search", "tools_load"]);
    expect(set.groups().map((g) => [g.id, g.tools.length])).toEqual([["browser", 2], ["email", 2], ["documents", 2]]);
  });

  it("defers Polpo's optional areas and keeps tasks, missions and the team on", () => {
    const tools = ["get_status", "create_task", "create_mission", "add_mission_task", "update_mission_task", "update_mission",
      "add_agent", "data_query", "brain_search", "list_playbooks", "phone_call", "computer_start", "browser_navigate", "register_app"].map((n) => tool(n));
    const set = new ProgressiveToolSet({ tools, groups: POLPO_TOOL_GROUPS, mode: "always" });
    expect(set.initialTools().map((t) => t.name)).toEqual(["get_status", "create_task", "create_mission", "update_mission", "add_agent", "tools_search", "tools_load"]);
    expect(set.isDeferred("add_mission_task")).toBe(true);
    expect(set.isDeferred("update_mission")).toBe(false);
  });
});

describe("tools_search", () => {
  const set = new ProgressiveToolSet({
    tools: [...core(3), ...linear, ...gmail, tool("browser_click", "Click an element in the browser page."), tool("pdf_create", "Create a PDF document from text.")],
    groups: AGENT_TOOL_GROUPS, mode: "always", connectorNames: { linear: "Linear", gmail: "Gmail" },
  });

  it("ranks by name, connector and description", () => {
    expect(set.search("create a linear issue")[0].name).toBe("mcp__linear__create_issue");
    expect(set.search("linear").map((h) => h.name).sort()).toEqual(linear.map((t) => t.name).sort());
    expect(set.search("send an email")[0].name).toBe("mcp__gmail__send_email");
    expect(set.search("pdf")[0].name).toBe("pdf_create");
    expect(set.search("mcp__gmail__search_threads")[0].name).toBe("mcp__gmail__search_threads");
    expect(set.search("click")[0].name).toBe("browser_click");
  });

  it("limits the results and never returns tools that are not deferred", () => {
    expect(set.search("click", 1)).toHaveLength(1);
    // three tools tie on "issue": a tie at the page edge stays together
    expect(set.find({ query: "issue", limit: 2 })).toMatchObject({ total: 3, more: false });
    expect(set.search("core_1").map((h) => h.name)).not.toContain("core_1");
    expect(set.search("tools_search").map((h) => h.name)).not.toContain("tools_search");
  });

  it("answers with names, groups and descriptions", () => {
    const text = set.run("tools_search", { query: "linear issues" });
    expect(text).toMatch(/^3 matches for "linear issues"; load with tools_load:/);
    expect(text).toContain("Linear [connector linear] — 3 matches:");
    expect(text).toContain("- mcp__linear__list_issues — List issues, filtered by team, assignee or state.");
    expect(set.run("tools_search", { query: "kubernetes" })).toContain("No tool to load matches");
  });
});

describe("tools_load", () => {
  it("loads names and whole groups, once, and announces them for the next request", () => {
    const set = new ProgressiveToolSet({ tools: [...core(3), ...linear, ...gmail], mode: "always", connectorNames: { gmail: "Gmail" } });
    const text = set.run("tools_load", { names: ["mcp__linear__create_issue", "nope", "core_1"] });
    expect(text).toContain("Loaded 1 tool: mcp__linear__create_issue");
    expect(text).toContain("Already available: core_1");
    expect(text).toContain("Not found: nope");
    const announcement = set.takeAnnouncement();
    expect(announcement).toMatchObject({ role: "system", content: "" });
    expect(announcement!.toolsAdded.map((t) => t.name)).toEqual(["mcp__linear__create_issue"]);
    expect(announcement!.toolsAdded[0]).toEqual({ name: "mcp__linear__create_issue", description: linear[0].description, parameters: linear[0].parameters });
    expect(set.takeAnnouncement()).toBeUndefined();
    // a group by connector name
    set.load(["Gmail"]);
    expect(set.takeNewlyLoaded().map((t) => t.name)).toEqual(gmail.map((t) => t.name));
    expect(set.activeTools().map((t) => t.name)).toContain("mcp__gmail__send_email");
    // loading again is a no-op
    expect(set.run("tools_load", { names: ["mcp__gmail__send_email"] })).toBe("Already available: mcp__gmail__send_email.");
    expect(set.run("tools_load", { names: ["missing"] })).toMatch(/^Error: Not found: missing/);
  });

  it("only knows the tools the run was given (allowedTools and connector access stay enforced)", () => {
    // the agent was granted Linear only: Gmail never reaches the set
    const set = new ProgressiveToolSet({ tools: [...core(3), ...linear], mode: "always" });
    expect(set.search("gmail email")).toEqual([]);
    expect(set.load(["mcp__gmail__send_email", "mcp__gmail"])).toEqual({ loaded: [], already: [], unknown: ["mcp__gmail__send_email", "mcp__gmail"] });
    expect(set.takeAnnouncement()).toBeUndefined();
  });
});

describe("persistence", () => {
  it("restores loaded tools from the stored conversation", () => {
    const history = [
      { toolCalls: [{ name: "tools_search", arguments: { query: "linear" }, state: "completed" }] },
      { toolCalls: [{ name: "tools_load", arguments: { names: ["mcp__linear__create_issue"] }, state: "completed" }] },
      { toolCalls: [{ name: "tools_load", arguments: { names: ["mcp__gmail__send_email"] }, state: "error" }] },
      { toolCalls: [{ name: "mcp__linear__update_issue", arguments: {}, state: "completed" }, { name: "core_1", state: "completed" }] },
    ];
    const loaded = loadedToolsFromHistory(history);
    expect(loaded).toEqual(["mcp__linear__create_issue", "mcp__linear__update_issue", "core_1"]);
    const set = new ProgressiveToolSet({ tools: [...core(3), ...linear, ...gmail], mode: "always", loaded });
    const names = set.initialTools().map((t) => t.name);
    expect(names).toContain("mcp__linear__create_issue");
    expect(names).toContain("mcp__linear__update_issue");
    expect(names).not.toContain("mcp__gmail__send_email");
    expect(set.takeAnnouncement()).toBeUndefined();
  });

  it("re-declares loaded tools that compaction dropped, after the checkpoint", () => {
    const full = [
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
      { role: "system", content: "", toolsAdded: [linear[0]] },
      { role: "toolResult", content: "x" },
    ];
    const projected = [
      { role: "system", content: "prompt" },
      { role: "user", content: "[Context checkpoint: earlier conversation compacted]\n\nsummary" },
      { role: "toolResult", content: "x" },
    ];
    const restored = restoreToolAnnouncements(full, projected);
    expect(restored).toHaveLength(4);
    expect(restored[2]).toMatchObject({ role: "system", toolsAdded: [linear[0]] });
    expect([...declaredTools(restored).keys()]).toEqual(["mcp__linear__create_issue"]);
    // nothing dropped: unchanged
    expect(restoreToolAnnouncements(full, full)).toBe(full);
  });
});
