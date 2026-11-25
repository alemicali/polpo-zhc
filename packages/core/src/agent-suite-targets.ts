/**
 * Agent suites, phase 4 — suites for other targets than an agent.
 *
 *   Hosted MCP server   its saved tests ARE its suite ("saved-tests"): each test is a case that
 *                       calls one of the server's tools (the draft or a version) with arguments and
 *                       checks the result; the upstream API is answered by HTTP mocks. The tests stay
 *                       in the server's tests.json (no second copy): this module maps them both ways.
 *   Mission             a suite owned by a mission: each case runs the mission in test mode — its
 *                       tasks in dependency order, each a turn of its agent with that agent's mocks —
 *                       and checks the tasks' outcomes, their order, who did what, the artifacts.
 *
 * Suites of a target are kept under an owner key (`mcp-server:<id>`, `mission:<id>`) where an
 * agent's are kept under its name. Pure.
 */
import { renderSuiteTemplate, suiteToolMatches, type AgentSuite, type HttpMock, type SuiteAssertion, type SuiteCase, type SuiteDataset, type SuiteGate, type SuiteMockMode, type SuiteScorer, type SuiteTarget, type UnmockedToolPolicy } from "./agent-suites.js";

// ── Owners ───────────────────────────────────────────────────────────

export type SuiteOwnerKind = SuiteTarget["kind"];

/** The key a target's suites and runs are kept under: the agent's name, `mcp-server:<id>`, `mission:<id>`. */
export function suiteOwnerKey(kind: SuiteOwnerKind, id: string): string {
  return kind === "agent" ? id : `${kind}:${id}`;
}

/** What an owner key stands for. */
export function parseSuiteOwner(key: string): { kind: SuiteOwnerKind; id: string } {
  const m = /^(mcp-server|mission|team):(.+)$/.exec(key);
  return m ? { kind: m[1] as SuiteOwnerKind, id: m[2] } : { kind: "agent", id: key };
}

/** The target a suite of this owner tests. */
export function suiteTargetFor(owner: string): SuiteTarget {
  const o = parseSuiteOwner(owner);
  switch (o.kind) {
    case "mcp-server": return { kind: "mcp-server", server: o.id };
    case "mission": return { kind: "mission", mission: o.id };
    case "team": return { kind: "team", team: o.id };
    default: return { kind: "agent" };
  }
}

// ── Hosted MCP servers ───────────────────────────────────────────────

/** The one suite of a hosted server: its saved tests. */
export const HOSTED_SERVER_SUITE_ID = "saved-tests";

/** A saved test of a hosted server (tests.json), with the phase 4 fields. */
export interface HostedServerTest {
  id: string;
  name?: string;
  tool: string;
  input: Record<string, unknown>;
  /** ok (default): the call must succeed; error: it must fail; any: no implicit check (the assertions decide). */
  expect?: "ok" | "error" | "any";
  /** The result text must contain this. */
  contains?: string;
  /** More checks (text_contains, text_regex, http_called, tool_failed, max_duration…). */
  assertions?: SuiteAssertion[];
  scorers?: SuiteScorer[];
  /** The upstream API's answers for this test (before the suite's). */
  http?: HttpMock[];
  /** all / tools (default all): HTTP mocked; none / model: real HTTP (admins). */
  mode?: SuiteMockMode;
  dataset?: string;
  description?: string;
  skip?: boolean;
}

/** The suite's settings a hosted server keeps (in its server.json). */
export interface HostedServerSuiteSettings {
  /** Shared HTTP mocks. */
  http?: HttpMock[];
  unmockedHttp?: UnmockedToolPolicy;
  defaultMode?: SuiteMockMode;
  datasets?: SuiteDataset[];
  /** Required before a version reaches production (the deploy gate). */
  gate?: SuiteGate;
  revision?: number;
  updatedAt?: string;
  updatedBy?: string;
}

const LEGACY_EXPECT = "saved-expect";
const LEGACY_CONTAINS = "saved-contains";

/** A saved test as a case: `expect` and `contains` become assertions (ids saved-expect, saved-contains). */
export function hostedTestToCase(t: HostedServerTest): SuiteCase {
  const legacy: SuiteAssertion[] = [
    ...(t.expect === "any" ? [] : [t.expect === "error" ? { id: LEGACY_EXPECT, type: "tool_failed" as const } : { id: LEGACY_EXPECT, type: "no_tool_errors" as const }]),
    ...(t.contains ? [{ id: LEGACY_CONTAINS, type: "text_contains" as const, value: t.contains, caseSensitive: true }] : []),
  ];
  return {
    id: t.id, name: t.name ?? t.tool,
    ...(t.description ? { description: t.description } : {}),
    input: { kind: "tool", message: "", tool: t.tool, args: t.input ?? {} },
    ...(t.mode ? { mode: t.mode } : {}),
    ...(t.http?.length ? { mocks: { http: t.http } } : {}),
    assertions: [...legacy, ...(t.assertions ?? [])],
    ...(t.scorers?.length ? { scorers: t.scorers } : {}),
    ...(t.dataset ? { dataset: t.dataset } : {}),
    ...(t.skip ? { skip: true } : {}),
  };
}

/** A case back to a saved test (the inverse of {@link hostedTestToCase}). */
export function caseToHostedTest(c: SuiteCase): HostedServerTest {
  if (c.input.kind !== "tool" || !c.input.tool) throw new Error(`Case "${c.name}": a hosted server's test calls one of its tools (input.kind tool, input.tool)`);
  const expect = c.assertions.find((a) => a.id === LEGACY_EXPECT);
  const contains = c.assertions.find((a) => a.id === LEGACY_CONTAINS);
  const rest = c.assertions.filter((a) => a.id !== LEGACY_EXPECT && a.id !== LEGACY_CONTAINS);
  return {
    id: c.id, ...(c.name && c.name !== c.input.tool ? { name: c.name } : {}), tool: c.input.tool, input: c.input.args ?? {},
    ...(expect?.type === "tool_failed" ? { expect: "error" as const } : expect ? {} : { expect: "any" as const }),
    ...(contains?.type === "text_contains" && typeof contains.value === "string" ? { contains: contains.value } : {}),
    ...(rest.length ? { assertions: rest } : {}),
    ...(c.scorers?.length ? { scorers: c.scorers } : {}),
    ...(c.mocks?.http?.length ? { http: c.mocks.http } : {}),
    ...(c.mode ? { mode: c.mode } : {}),
    ...(c.dataset ? { dataset: c.dataset } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.skip ? { skip: true } : {}),
  };
}

/** A hosted server's suite (its saved tests and settings), as every other suite. */
export function hostedServerSuite(server: { id: string; name?: string; createdAt?: string }, tests: HostedServerTest[], settings: HostedServerSuiteSettings = {}): AgentSuite {
  const now = new Date().toISOString();
  return {
    id: HOSTED_SERVER_SUITE_ID,
    agent: suiteOwnerKey("mcp-server", server.id),
    name: `${server.name ?? server.id} — saved tests`,
    description: "The hosted server's saved tests: each calls one of its tools and checks the result; the upstream API is answered by HTTP mocks.",
    target: { kind: "mcp-server", server: server.id },
    defaultMode: settings.defaultMode ?? "all",
    ...(settings.http?.length || settings.unmockedHttp ? { mocks: { ...(settings.http?.length ? { http: settings.http } : {}), ...(settings.unmockedHttp ? { unmockedHttp: settings.unmockedHttp } : {}) } } : {}),
    cases: tests.map(hostedTestToCase),
    datasets: settings.datasets ?? [],
    ...(settings.gate ? { gate: settings.gate } : {}),
    revision: settings.revision ?? 1,
    createdAt: server.createdAt ?? settings.updatedAt ?? now,
    updatedAt: settings.updatedAt ?? now,
    ...(settings.updatedBy ? { updatedBy: settings.updatedBy } : {}),
  };
}

/** A validated suite back to the server's storage: tests.json and the settings in server.json. */
export function hostedServerStorage(suite: AgentSuite): { tests: HostedServerTest[]; settings: HostedServerSuiteSettings } {
  return {
    tests: suite.cases.map(caseToHostedTest),
    settings: {
      ...(suite.mocks?.http?.length ? { http: suite.mocks.http } : {}),
      ...(suite.mocks?.unmockedHttp ? { unmockedHttp: suite.mocks.unmockedHttp } : {}),
      ...(suite.defaultMode !== "all" ? { defaultMode: suite.defaultMode } : {}),
      ...(suite.datasets.length ? { datasets: suite.datasets } : {}),
      ...(suite.gate ? { gate: suite.gate } : {}),
      revision: suite.revision, updatedAt: suite.updatedAt, ...(suite.updatedBy ? { updatedBy: suite.updatedBy } : {}),
    },
  };
}

/**
 * The HTTP mock that answers a request, if any: the first whose method and URL (a glob, or a
 * substring) match and that has answers left (`used`: index → count, updated).
 */
export function findHttpMock(mocks: HttpMock[], method: string, url: string, used: Map<number, number>): { mock: HttpMock; index: number } | undefined {
  for (const [index, mock] of mocks.entries()) {
    if (mock.method && mock.method.toUpperCase() !== method.toUpperCase()) continue;
    const hit = /[*?]/.test(mock.url) ? suiteToolMatches(mock.url, url) : url.includes(mock.url);
    if (!hit) continue;
    const n = used.get(index) ?? 0;
    if (mock.times !== undefined && n >= mock.times) continue;
    used.set(index, n + 1);
    return { mock, index };
  }
  return undefined;
}

/** The response an HTTP mock gives (templated with the case's row and the request). */
export function httpMockResponse(mock: HttpMock, vars: Record<string, unknown>): { status: number; body: string; headers: Record<string, string> } {
  const body = renderSuiteTemplate(mock.body, vars);
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const headers = { ...(typeof body === "string" || body === undefined ? { "content-type": "text/plain" } : { "content-type": "application/json" }), ...(mock.headers ?? {}) };
  return { status: mock.status ?? 200, body: text, headers };
}

// ── Missions ─────────────────────────────────────────────────────────

/** A mission task as the test run needs it. */
export interface MissionTaskLike { title: string; description: string; assignTo?: string; dependsOn?: string[] }

/**
 * The message an agent gets for a mission task in test mode: the task framing, the outputs of the
 * tasks it depends on, and the case's extra context.
 */
export function missionTaskMessage(task: MissionTaskLike, done: Array<{ title: string; text: string }>, opts: { mission?: string; extra?: string } = {}): string {
  const deps = (task.dependsOn ?? []).map((d) => done.find((x) => x.title === d)).filter((x): x is { title: string; text: string } => !!x);
  return [
    `## Task: ${task.title}${opts.mission ? ` (mission ${opts.mission})` : ""}`,
    task.description,
    deps.length ? `## What the tasks before produced\n${deps.map((d) => `### ${d.title}\n${d.text.slice(0, 4000)}`).join("\n\n")}` : "",
    opts.extra ? `## Context\n${opts.extra}` : "",
    "Complete this task, then report what you did.",
  ].filter(Boolean).join("\n\n");
}

/** The agents a mission's tasks need (assignTo, else the default agent). */
export function missionAgents(tasks: MissionTaskLike[], fallback?: string): string[] {
  return [...new Set(tasks.map((t) => t.assignTo ?? fallback).filter((x): x is string => !!x))];
}
