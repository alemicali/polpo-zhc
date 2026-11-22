/**
 * The recent features on every MCP surface: where and with what a task ran (engine, model, auth,
 * computer, cost), why it failed (labelled, not retried), its dependencies, a mission's cost
 * against its budget, the connectors (several accounts) an agent may use — in the task and
 * mission cards (MCP App), the agent card, and the tasks tools' text and structured content.
 */
import { describe, expect, it, vi } from "vitest";
import { describeTaskFailure, failureKind, taskFailure } from "@polpo-ai/core/task-failure";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { buildMissionCard, buildTaskCard, missionCardText, taskCardText } from "../server/mcp-work-card.js";
import { agentCardText, buildAgentCard } from "../server/mcp-agent-card.js";
import { modelLabel, runView } from "../server/mcp-run-view.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

const BEDROCK_ERROR = "Bedrock: model \"us.anthropic.claude-sonnet-4-5\" not enabled for this account — its quota for this AWS account is 0 (Service Quotas → Amazon Bedrock; ask AWS Support to raise it) or pick another model (agent engine or Settings → Harnesses). Claude Code: API Error: 403 …\nmore detail";

const harnessRun = {
  runId: "r2", startedAt: "2026-11-22T10:00:00.000Z", endedAt: "2026-11-22T10:01:00.000Z", status: "failed" as const, agent: "dev",
  engine: "claude-code" as const, model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", auth: { kind: "bedrock" as const, region: "eu-west-1" },
  computer: { id: "gpu-box", name: "GPU box", kind: "daytona" as const, provider: "daytona" as const, daytonaApi: "v2" as const, remoteId: "sb-1" },
  sandbox: { provider: "daytona", ephemeral: false }, egress: { mode: "proxy" as const, proxy: "home", tailscale: true },
  session: { resumed: false, bootstrapMs: 4200 }, cost: { harnessUsd: 0.42, tokens: 1200 }, budgetUsd: 2, durationMs: 60_000, exitCode: 1,
};
const polpoRun = {
  runId: "r1", startedAt: "2026-11-22T09:00:00.000Z", status: "completed" as const, agent: "dev", engine: "polpo" as const, model: "anthropic:claude-opus-4-5",
  computer: { id: "host", kind: "host" as const }, egress: { mode: "direct" as const }, cost: { modelUsd: 0.1 },
};

const TASKS = [
  { id: "t1", title: "Collect data", status: "done", assignTo: "dev", missionId: "m1", group: "Report", createdAt: "2026-11-22T08:00:00Z", updatedAt: "2026-11-22T09:10:00Z",
    result: { exitCode: 0, stdout: "42 rows", stderr: "", duration: 1000 }, runs: [polpoRun] },
  { id: "t2", title: "Write report", status: "failed", assignTo: "dev", missionId: "m1", group: "Report", dependsOn: ["t1", "Ghost"], retries: 0, maxRetries: 3,
    createdAt: "2026-11-22T08:01:00Z", updatedAt: "2026-11-22T10:01:00Z",
    result: { exitCode: 1, stdout: "", stderr: BEDROCK_ERROR, duration: 60_000, retryable: false }, runs: [polpoRun, harnessRun],
    outcomes: [{ type: "file", label: "Draft", path: "out/report.md" }] },
];
const MISSION = {
  id: "m1", name: "Report", status: "paused", pauseReason: "budget", prompt: "A weekly report", budgetUsd: 0.5,
  cost: {
    currency: "USD", usd: 0.62, harnessUsd: 0.42, modelUsd: 0.2, tokens: 1200, runs: 3, tasks: 2, unpricedRuns: 0, runsActive: 0, partial: false,
    byAgent: [{ agent: "dev", usd: 0.62, harnessUsd: 0.42, modelUsd: 0.2, tokens: 1200, runs: 3 }],
    byEngine: [
      { engine: "polpo", usd: 0.2, harnessUsd: 0, modelUsd: 0.2, tokens: 0, runs: 2 },
      { engine: "claude-code", usd: 0.42, harnessUsd: 0.42, modelUsd: 0, tokens: 1200, runs: 1 },
    ],
    budgetUsd: 0.5, remainingUsd: -0.12, budgetUsed: 1.24, overBudget: true,
  },
};
const CONNECTORS = [
  { id: "gmail", name: "Gmail", account: "ada@acme.com", status: "connected", enabled: true, access: { agents: ["dev"], polpo: true } },
  { id: "gmail-2", name: "Gmail – info@acme.com", account: "info@acme.com", status: "needs_reauth", enabled: true, access: { agents: "*", polpo: false } },
  { id: "linear", name: "Linear", status: "connected", enabled: true, access: { agents: ["someone-else"], polpo: true } },
];

const withFailure = (t: (typeof TASKS)[number]) => {
  const f = taskFailure(t as never);
  return f ? { ...t, failure: f } : t;
};

function fakeApi() {
  const reply = (status: number, body: unknown): ApiResponse => ({ status, body, headers: new Headers() });
  return vi.fn(async (method: string, path: string): Promise<ApiResponse> => {
    if (path === "/api/v1/agents") return reply(200, { ok: true, data: [{ name: "dev", role: "Developer", model: "anthropic:claude-opus-4-5", engine: { harness: "claude-code", model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }, defaultComputer: "gpu-box", connectorTools: { gmail: ["send", "search"] } }] });
    if (path === "/api/v1/tasks" && method === "GET") return reply(200, { ok: true, data: TASKS });
    if (path === "/api/v1/tasks?slim=true") return reply(200, { ok: true, data: TASKS.map((t) => ({ id: t.id, title: t.title, status: t.status, assignTo: t.assignTo, missionId: t.missionId, group: t.group, ...(withFailure(t) as { failure?: unknown }).failure ? { failure: (withFailure(t) as { failure?: unknown }).failure } : {} })) });
    if (path.startsWith("/api/v1/tasks?")) return reply(200, { ok: true, data: { tasks: TASKS.map(withFailure), nextCursor: null, hasMore: false } });
    const task = path.match(/^\/api\/v1\/tasks\/([^/?]+)$/);
    if (task) {
      const t = TASKS.find((x) => x.id === decodeURIComponent(task[1]!));
      return t ? reply(200, { ok: true, data: withFailure(t) }) : reply(404, { ok: false, error: "Task not found", code: "NOT_FOUND" });
    }
    if (path === "/api/v1/agents/processes/t2/activity") return reply(200, { ok: true, data: [] });
    if (path === "/api/v1/missions/m1") return reply(200, { ok: true, data: MISSION });
    if (path.startsWith("/api/v1/missions/")) return reply(404, { ok: false, error: "Mission not found" });
    if (path === "/api/v1/drive/dev") return reply(200, { ok: true, data: { drive: { enabled: false }, plan: [], intentions: [], journal: [] } });
    if (path === "/api/v1/connectors") return reply(200, { ok: true, data: { connectors: CONNECTORS } });
    return reply(404, { ok: false, error: `not faked: ${method} ${path}` });
  });
}

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}) {
  const res = await handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), deps);
  return (await res.json() as { result?: any }).result;
}
const call = async (deps: McpDeps, name: string, args: Record<string, unknown> = {}) => {
  const result = await rpc(deps, "tools/call", { name, arguments: args });
  await expectValidOutput(deps, async () => (await rpc(deps, "tools/list")).tools, name, result);
  return result;
};

describe("why a task failed", () => {
  it("is the labelled reason of its last run in a line, not retryable when the harness said so, with a kind", () => {
    const f = taskFailure(TASKS[1] as never)!;
    expect(f).toEqual({ reason: BEDROCK_ERROR.split("\n")[0], retryable: false, kind: "model_access" });
    expect(describeTaskFailure(f)).toMatch(/\(not retried: a re-run would fail the same way\)$/);
    expect(taskFailure(TASKS[0] as never)).toBeUndefined();
    expect(failureKind("Anthropic: authentication failed — check the credentials")).toBe("auth");
    expect(failureKind("Claude Code reached its spend limit (engine maxBudgetUsd)")).toBe("budget");
    expect(failureKind("Killed by SIGTERM (timeout or shutdown)")).toBe("killed");
    expect(taskFailure({ status: "failed", result: { exitCode: 0, stdout: "", stderr: "", duration: 1, assessment: { passed: false, checks: [], metrics: [], llmReview: "Too short", timestamp: "" } } } as never))
      .toEqual({ reason: "Assessment: Too short", retryable: true, kind: "assessment" });
  });
});

describe("the task and mission cards", () => {
  const key = { createdAt: 1, seq: 1 };

  it("a run as the cards show it: engine, readable model, auth, computer and cost with their marks", () => {
    expect(runView(harnessRun as never)).toMatchObject({
      engineLabel: "Claude Code", engineMark: "claude-code", modelLabel: "Sonnet 4.5",
      auth: { label: "Bedrock", mark: "bedrock", region: "eu-west-1" },
      computer: { label: "GPU box", kindLabel: "Daytona v2", mark: "daytona", remoteId: "sb-1" },
      egress: { mode: "proxy", label: "home", tailscale: true }, costUsd: 0.42, budgetUsd: 2,
    });
    expect(runView(polpoRun as never)).toMatchObject({ engineMark: "polpo", computer: { label: "this server", mark: "host" }, costUsd: 0.1 });
    expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  });

  it("a task card: failure, runs newest first, dependencies (missing ones too), result and cost", () => {
    const card = buildTaskCard({ task: TASKS[1] as never, tasks: TASKS as never, now: new Date("2026-11-22T11:00:00Z"), key });
    expect(card.kind).toBe("task");
    expect(card.task.failure).toMatchObject({ retryable: false, kind: "model_access" });
    expect(card.runs.map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(card.costUsd).toBeCloseTo(0.52);
    expect(card.dependencies).toEqual([{ id: "t1", title: "Collect data", status: "done", assignTo: "dev" }, { id: "Ghost", title: "Ghost", status: "missing" }]);
    expect(card.outcomes).toEqual([{ type: "file", label: "Draft", ref: "out/report.md" }]);
    const text = taskCardText(card);
    expect(text).toContain("Failed: Bedrock: model");
    expect(text).toContain("(not retried");
    expect(text).toContain("Claude Code · Sonnet 4.5 via Bedrock · on GPU box (Daytona v2) · $0.42 of $2");
    expect(text).toContain("Depends on: Collect data [done], Ghost [missing]");
  });

  it("a mission card: cost against the budget (over), by engine with marks, tasks with their latest run and failure", () => {
    const card = buildMissionCard({ mission: MISSION as never, tasks: TASKS as never, now: new Date(), key });
    expect(card.cost).toMatchObject({ usd: 0.62, budgetUsd: 0.5, overBudget: true, budgetUsed: 1.24 });
    expect(card.cost!.byEngine[0]).toEqual({ engine: "claude-code", label: "Claude Code", mark: "claude-code", usd: 0.42, runs: 1 });
    expect(card.counts).toEqual({ done: 1, failed: 1 });
    expect(card.tasks[1]).toMatchObject({ id: "t2", lastRun: { engineMark: "claude-code", modelLabel: "Sonnet 4.5" }, failure: { kind: "model_access" } });
    const text = missionCardText(card);
    expect(text).toContain("[paused, over budget] Report");
    expect(text).toContain("Cost: $0.62 of $0.50 budget (124%, over budget)");
    expect(text).toContain("By engine: Claude Code $0.42, Polpo $0.20");
  });

  it("the agent card: engine and computer, the task at hand with its run or failure, the connectors with their accounts", () => {
    const card = buildAgentCard({
      agent: { name: "dev", model: "anthropic:claude-opus-4-5", engine: { harness: "claude-code", model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }, defaultComputer: "gpu-box", connectorTools: { gmail: ["send", "search"] } },
      tasks: TASKS as never, connectors: CONNECTORS as never, now: new Date("2026-11-22T11:00:00Z"), key,
    });
    expect(card.agent.engine).toMatchObject({ id: "claude-code", label: "Claude Code", mark: "claude-code", modelLabel: "Sonnet 4.5" });
    expect(card.agent.computer).toBe("gpu-box");
    expect(card.current).toMatchObject({ id: "t2", run: { engineLabel: "Claude Code", computer: { label: "GPU box" } }, failure: { retryable: false } });
    expect(card.connectors).toEqual([
      { id: "gmail", label: "Gmail – ada@acme.com", account: "ada@acme.com", status: "connected", tools: 2 },
      { id: "gmail-2", label: "Gmail – info@acme.com", account: "info@acme.com", status: "needs_reauth", tools: "all" },
    ]);
    const text = agentCardText(card);
    expect(text).toContain("Engine: Claude Code (Sonnet 4.5) on gpu-box.");
    expect(text).toContain("It failed: Bedrock: model");
    expect(text).toContain("Connectors: Gmail – ada@acme.com [gmail] (2 tools), Gmail – info@acme.com [gmail-2].");
  });
});

describe("the cards through MCP", () => {
  const deps = (): McpDeps => ({ api: fakeApi(), version: "1" });

  it("polpo_task_show and polpo_mission_show link to the work card; the document is self-contained, with the brand marks inline", async () => {
    const d = deps();
    const tools = (await rpc(d, "tools/list")).tools as Array<{ name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }>;
    for (const name of ["polpo_task_show", "polpo_mission_show"]) {
      expect(tools.find((t) => t.name === name)!._meta?.ui).toMatchObject({ resourceUri: "ui://polpo/work-card.html" });
    }
    const read = (await rpc(d, "resources/read", { uri: "ui://polpo/work-card.html" })).contents[0];
    expect(read.mimeType).toBe("text/html;profile=mcp-app");
    expect(read.text).toMatch(/^<!doctype html>/);
    expect(read.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    // Daytona's and E2B's own marks as data URIs, the vector marks as paths
    expect(read.text).toContain("data:image/png;base64,");
  });

  it("polpo_task_show: text for the model, the card for the UI; an unknown id is an error with the next step", async () => {
    const d = deps();
    const res = await call(d, "polpo_task_show", { id: "t2" });
    expect(res.content[0].text).toContain("t2 [failed] Write report → dev");
    expect(res.content[0].text).toContain("(not retried");
    expect(res.structuredContent).toMatchObject({ kind: "task", task: { id: "t2", failure: { kind: "model_access", retryable: false } }, runs: [{ engineMark: "claude-code" }, { engineMark: "polpo" }] });
    const missing = await call(d, "polpo_task_show", { id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/polpo_tasks_list/);
  });

  it("polpo_mission_show: cost against the budget, paused over budget, its tasks", async () => {
    const res = await call(deps(), "polpo_mission_show", { id: "m1" });
    expect(res.content[0].text).toContain("over budget");
    expect(res.structuredContent).toMatchObject({ kind: "mission", mission: { id: "m1", pauseReason: "budget" }, cost: { overBudget: true }, tasks: [{ id: "t1" }, { id: "t2" }] });
  });

  it("polpo_agent_show carries the engine, the latest run, the failure and the connectors", async () => {
    const res = await call(deps(), "polpo_agent_show", { agent: "dev" });
    expect(res.structuredContent).toMatchObject({ agent: { engine: { id: "claude-code" } }, connectors: [{ id: "gmail" }, { id: "gmail-2" }] });
    expect(res.content[0].text).toContain("Connectors:");
  });

  it("polpo_task_get says why it failed and what it depends on; polpo_tasks_list shows the failure on the line", async () => {
    const d = deps();
    const got = await call(d, "polpo_task_get", { id: "t2", activity: 0 });
    expect(got.content[0].text).toContain("failed: Bedrock: model");
    expect(got.content[0].text).toContain("depends on: t1 [done] Collect data, Ghost [missing] Ghost");
    expect(got.structuredContent).toMatchObject({ failure: { retryable: false }, dependencies: [{ id: "t1", status: "done" }, { id: "Ghost", status: "missing" }] });
    const list = await call(d, "polpo_tasks_list", {});
    expect(list.content[0].text).toMatch(/t2 \[failed\] Write report → dev .*failed: Bedrock: model.*\(not retried\)/);
    expect(list.structuredContent.items[1]).toMatchObject({ failure: { kind: "model_access" }, last_run: { engine: "claude-code" } });
  });
});
