/**
 * A task's optional tool scope (Task.toolScope): inherit by default, narrow only, never grant;
 * checked against the agent on create / update; applied to the agent config a run gets.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTaskToolScope, buildRunContext, describeTaskRun, describeTaskToolScope, narrowAllowedTools, normalizeTaskToolScope,
  parseMissionDocument, taskToolScopeGrantProblems, taskToolScopeProblems, type ConnectorConfig, type Task,
} from "@polpo-ai/core";
import { checkTaskToolScope, knownBuiltinTools, scopedAgentForRun, TaskToolScopeError, requireTaskToolScope } from "../core/task-tool-scope.js";

const connector = (id: string, name: string, agents: string[] | "*", extra: Partial<ConnectorConfig> & { account?: string } = {}): ConnectorConfig =>
  ({ id, name, kind: "mcp", transport: { type: "http", url: "https://example.com/mcp" }, auth: { type: "none" }, access: { agents, polpo: false }, enabled: true, createdAt: "2026-01-01", ...extra }) as ConnectorConfig;

const connectors = [
  connector("linear", "Linear", "*", { toolPolicy: { delete_issue: "off" } }),
  connector("gmail", "Gmail", ["alice"]),
  connector("gmail-2", "Gmail 2", ["alice"], { account: "info@acme.com" } as never),
  connector("notion", "Notion", ["bob"]),
];

describe("shape and normalization", () => {
  it("absent or empty means inherit (no scope)", () => {
    expect(taskToolScopeProblems(undefined)).toEqual([]);
    expect(normalizeTaskToolScope(undefined)).toBeUndefined();
    expect(normalizeTaskToolScope({})).toBeUndefined();
    expect(normalizeTaskToolScope({ connectorTools: { linear: "*" } })).toBeUndefined();
  });

  it("rejects malformed values with clear messages", () => {
    expect(taskToolScopeProblems([])).toEqual([expect.stringMatching(/must be an object/)]);
    expect(taskToolScopeProblems({ connectors: "all" })).toEqual([expect.stringMatching(/connectors must be "none" or a list/)]);
    expect(taskToolScopeProblems({ connectors: ["Bad Id"] })).toEqual([expect.stringMatching(/"Bad Id" is not a connector id/)]);
    expect(taskToolScopeProblems({ connectorTools: { linear: "some" } })).toEqual([expect.stringMatching(/must be "\*" or a list/)]);
    expect(taskToolScopeProblems({ allowedTools: "read" })).toEqual([expect.stringMatching(/allowedTools must be a list/)]);
    expect(taskToolScopeProblems({ tools: [] })).toEqual([expect.stringMatching(/unknown field "tools"/)]);
  });

  it("dedupes lists and turns an empty connector list into none", () => {
    expect(normalizeTaskToolScope({ connectors: ["linear", "linear"], allowedTools: ["read", "read"] })).toEqual({ connectors: ["linear"], allowedTools: ["read"] });
    expect(normalizeTaskToolScope({ connectors: [] })).toEqual({ connectors: "none" });
    expect(normalizeTaskToolScope({ allowedTools: [] })).toEqual({ allowedTools: [] });
  });
});

describe("narrow only: grant checks", () => {
  const alice = { name: "alice" };
  const check = (scope: unknown, agent: { name: string; allowedTools?: string[]; connectorTools?: Record<string, "*" | string[]> } = alice, toolNames?: Record<string, string[]>) =>
    taskToolScopeGrantProblems(normalizeTaskToolScope(scope), {
      agent, connectors, connectorToolNames: (id) => toolNames?.[id],
      knownTools: ["read", "write", "edit", "bash", "glob", "grep", "ls", "http_fetch", "http_download", "browser_navigate", "browser_click", "email_send"],
    });

  it("accepts what the agent has", () => {
    expect(check({ connectors: ["gmail-2"] })).toEqual([]);
    expect(check({ connectors: ["linear"], connectorTools: { linear: ["create_issue"] } }, alice, { linear: ["create_issue", "list_issues"] })).toEqual([]);
    expect(check({ connectors: "none", allowedTools: ["read", "grep"] })).toEqual([]);
    expect(check({ allowedTools: ["browser_click"] }, { name: "alice", allowedTools: ["read", "browser_*"] })).toEqual([]);
    expect(check({ allowedTools: ["browser_*"] }, { name: "alice", allowedTools: ["browser_click"] })).toEqual([]);
  });

  it("rejects connectors the agent has no access to, or that do not exist", () => {
    expect(check({ connectors: ["notion"] })).toEqual([expect.stringMatching(/agent "alice" has no access to Notion \(notion\)/)]);
    expect(check({ connectors: ["jira"] })).toEqual([expect.stringMatching(/there is no connector "jira"/)]);
    expect(check({ connectorTools: { notion: ["search"] } })).toEqual([expect.stringMatching(/no access to Notion/)]);
  });

  it("names the account of a connector in messages", () => {
    expect(check({ connectors: ["gmail-2"] }, { name: "bob" })).toEqual([expect.stringMatching(/Gmail 2 – info@acme\.com \(gmail-2\)/)]);
  });

  it("rejects tools the agent does not get, turned-off tools, unknown tools", () => {
    const narrowed = { name: "alice", connectorTools: { linear: ["list_issues"] } };
    expect(check({ connectorTools: { linear: ["create_issue"] } }, narrowed)).toEqual([expect.stringMatching(/does not get "create_issue" of Linear/)]);
    expect(check({ connectorTools: { linear: ["delete_issue"] } })).toEqual([expect.stringMatching(/"delete_issue" of Linear \(linear\) is turned off/)]);
    expect(check({ connectorTools: { linear: ["nope"] } }, alice, { linear: ["create_issue"] })).toEqual([expect.stringMatching(/Linear \(linear\) has no tool "nope"/)]);
    // unknown names pass when the connector's tools cannot be listed now
    expect(check({ connectorTools: { linear: ["nope"] } })).toEqual([]);
  });

  it("rejects connectorTools for a connector the scope leaves out", () => {
    expect(check({ connectors: ["gmail"], connectorTools: { linear: ["x"] } })).toEqual([expect.stringMatching(/not among the task's connectors/)]);
    expect(check({ connectors: "none", connectorTools: { linear: ["x"] } })).toEqual([expect.stringMatching(/not among the task's connectors/)]);
  });

  it("rejects built-in tools the agent lacks, unknown ones and connector patterns", () => {
    expect(check({ allowedTools: ["browser_click"] })).toEqual([expect.stringMatching(/does not have "browser_click" \(an agent without allowedTools gets only the default tools\)/)]);
    expect(check({ allowedTools: ["bash"] }, { name: "alice", allowedTools: ["read"] })).toEqual([expect.stringMatching(/does not have "bash" \(its allowedTools do not list it\)/)]);
    expect(check({ allowedTools: ["teleport"] })).toEqual([expect.stringMatching(/there is no built-in tool "teleport"/)]);
    expect(check({ allowedTools: ["mcp__linear__*"] })).toEqual([expect.stringMatching(/is a connector tool/)]);
  });
});

describe("applied to the run's agent config", () => {
  const ids = connectors.map((c) => c.id);

  it("no scope: the agent config is returned unchanged (inherit)", () => {
    const agent = { name: "alice", allowedTools: ["read"], connectorTools: { linear: ["a"] } };
    expect(applyTaskToolScope(agent, undefined, ids)).toBe(agent);
  });

  it("connectors: the ones left out get an empty selection; picked tools narrow the agent's", () => {
    const agent = { name: "alice", connectorTools: { linear: ["a", "b"] } };
    const run = applyTaskToolScope(agent, { connectors: ["linear", "gmail-2"], connectorTools: { linear: ["b", "c"] } }, ids);
    expect(run.connectorTools).toEqual({ linear: ["b"], gmail: [], notion: [] });
    expect(run.allowedTools).toBeUndefined();
    expect(applyTaskToolScope({ name: "a" }, { connectors: "none" }, ids).connectorTools).toEqual({ linear: [], gmail: [], "gmail-2": [], notion: [] });
    // connectorTools only: the other connectors stay as the agent has them
    expect(applyTaskToolScope({ name: "a" }, { connectorTools: { linear: ["x"] } }, ids).connectorTools).toEqual({ linear: ["x"] });
  });

  it("allowedTools: the intersection with the agent's, connector patterns kept", () => {
    expect(narrowAllowedTools(undefined, ["read", "grep"])).toEqual(["read", "grep", "mcp__*"]);
    expect(narrowAllowedTools(["read", "bash", "browser_*", "mcp__linear__*"], ["read", "browser_click", "email_send"])).toEqual(["read", "browser_click", "mcp__linear__*"]);
    expect(narrowAllowedTools(["browser_click", "browser_navigate"], ["browser_*"])).toEqual(["browser_click", "browser_navigate"]);
    expect(narrowAllowedTools(["*"], ["read"])).toEqual(["read", "mcp__*"]);
    expect(narrowAllowedTools(["read"], [])).toEqual([]);
  });

  it("scopedAgentForRun reads every connector of the workspace", () => {
    const polpoDir = mkdtempSync(join(tmpdir(), "polpo-scope-"));
    try {
      writeFileSync(join(polpoDir, "connectors.json"), JSON.stringify({ connectors }));
      const agent = { name: "alice" };
      const task = { toolScope: { connectors: ["gmail-2"] } } as Task;
      expect(scopedAgentForRun({ agent, task, polpoDir }).connectorTools).toEqual({ linear: [], gmail: [], notion: [] });
      expect(scopedAgentForRun({ agent, task: {} as Task, polpoDir })).toBe(agent);
    } finally {
      rmSync(polpoDir, { recursive: true, force: true });
    }
  });
});

describe("validation against the live agent and connectors", () => {
  const host = {
    agents: () => [{ name: "alice", allowedTools: ["read", "bash", "mcp__*"] }, { name: "carol" }] as never,
    connectors: () => connectors,
    listConnectorTools: async (id: string) => (id === "linear" ? ["create_issue", "list_issues"] : undefined),
  };

  it("returns the normalized scope, or the problems", async () => {
    expect(await checkTaskToolScope(host, "alice", { connectors: ["linear", "linear"] })).toEqual({ scope: { connectors: ["linear"] }, problems: [] });
    expect((await checkTaskToolScope(host, "alice", { connectorTools: { linear: ["nope"] } }, { live: true })).problems).toEqual([expect.stringMatching(/has no tool "nope"/)]);
    expect((await checkTaskToolScope(host, "alice", { allowedTools: ["write"] })).problems).toEqual([expect.stringMatching(/does not have "write"/)]);
    expect((await checkTaskToolScope(host, "carol", { allowedTools: ["data_query"] })).problems).toEqual([expect.stringMatching(/does not have "data_query"/)]);
    // an agent not known yet (a mission's volatile team): shape checks only
    expect(await checkTaskToolScope(host, "ghost", { connectors: ["notion"] })).toEqual({ scope: { connectors: ["notion"] }, problems: [] });
    await expect(requireTaskToolScope(host, "alice", { connectors: ["notion"] })).rejects.toBeInstanceOf(TaskToolScopeError);
    await expect(requireTaskToolScope(host, "alice", undefined)).resolves.toBeUndefined();
  });

  it("knows Polpo's built-in tool names (core, extended, data, artifacts, brain, storage)", async () => {
    const known = await knownBuiltinTools();
    for (const name of ["read", "bash", "browser_click", "email_send", "data_query", "artifact_create", "brain_search", "storage_read"]) expect(known).toContain(name);
  });
});

describe("missions and run records", () => {
  it("a mission task's toolScope is validated with the document", () => {
    const base = { tasks: [{ title: "A", description: "do", toolScope: { connectors: ["gmail-2"], connectorTools: { "gmail-2": ["send"] } } }] };
    expect(parseMissionDocument(base).tasks[0]!.toolScope).toEqual({ connectors: ["gmail-2"], connectorTools: { "gmail-2": ["send"] } });
    expect(() => parseMissionDocument({ tasks: [{ title: "A", description: "do", toolScope: { connectors: "all" } }] })).toThrow(/connectors must be "none" or a list/);
  });

  it("the run context records the scope the run had", () => {
    const ctx = buildRunContext({ runId: "r1", agent: { name: "alice" }, toolScope: { connectors: ["linear"], connectorTools: { linear: ["a", "b"] }, allowedTools: ["read"] } });
    expect(ctx.toolScope).toEqual({ connectors: ["linear"], connectorTools: { linear: ["a", "b"] }, allowedTools: ["read"] });
    expect(describeTaskRun(ctx)).toMatch(/tools restricted \(connectors linear; linear: 2; built-in read\)/);
    expect(buildRunContext({ runId: "r2", agent: { name: "alice" } }).toolScope).toBeUndefined();
  });

  it("describes a scope in one line, with names and accounts", () => {
    expect(describeTaskToolScope(undefined)).toBe("inherited from the agent");
    expect(describeTaskToolScope({ connectors: ["linear", "gmail-2"], connectorTools: { linear: ["a", "b", "c"] } }, connectors as never))
      .toBe("restricted: Linear (3 tools), Gmail 2 – info@acme.com");
    expect(describeTaskToolScope({ connectors: "none", allowedTools: ["read"] })).toBe("restricted: no connectors; built-in: read");
  });
});
