/**
 * Helpers of the agent page's Suites tab (components stay component-only for fast refresh):
 * labels, blank suites and cases, assertion templates, and a case trace as chat messages (the
 * same parts the chat page and Tasks → Execution → Chat draw).
 */
import type { AgentSuiteInput, SuiteAssertionType, SuiteCase, SuiteMockMode, SuiteRun, SuiteTrace } from "@polpo-ai/react";
import type { MessageSegment, ToolCallInfo } from "@/hooks/use-polpo";

export const SUITE_MODES: Array<{ id: SuiteMockMode; label: string; hint: string; realTools: boolean; realModel: boolean }> = [
  { id: "all", label: "Contract (offline)", hint: "Scripted model, mocked tools: no cost, no side effects", realTools: false, realModel: false },
  { id: "tools", label: "Mock tools", hint: "The real model (costs tokens), tools answered by mocks", realTools: false, realModel: true },
  { id: "model", label: "Mock model", hint: "Scripted model turns, real tools (side effects possible)", realTools: true, realModel: false },
  { id: "none", label: "Live", hint: "The real model and real tools (side effects possible)", realTools: true, realModel: true },
];

export function suiteModeLabel(mode: SuiteMockMode): string {
  return SUITE_MODES.find((m) => m.id === mode)?.label ?? mode;
}

/** Would running these cases in this mode touch real tools (the confirmation)? */
export function suiteRunUsesRealTools(cases: Array<Pick<SuiteCase, "mode" | "mocks">>, defaultMode: SuiteMockMode, forced?: SuiteMockMode, suiteUnmocked?: "block" | "real"): boolean {
  return cases.some((c) => {
    const mode = forced ?? c.mode ?? defaultMode;
    if (mode === "none" || mode === "model") return true;
    return mode === "tools" && (c.mocks?.unmockedTools ?? suiteUnmocked) === "real";
  });
}

/** A template for each assertion type (the form adds one, then the fields are edited). */
export const ASSERTION_TEMPLATES: Record<SuiteAssertionType, Record<string, unknown>> = {
  tool_called: { tool: "", args: {} },
  tool_not_called: { tool: "" },
  tool_order: { tools: ["", ""] },
  tool_args: { tool: "", value: {}, match: "partial" },
  no_tool_errors: {},
  outcome_registered: {},
  artifact_created: {},
  approval_requested: {},
  text_contains: { value: "" },
  text_not_contains: { value: "" },
  text_regex: { pattern: "" },
  max_turns: { value: 10 },
  max_cost: { usd: 0.1 },
  max_duration: { ms: 60000 },
};

export const ASSERTION_LABELS: Record<SuiteAssertionType, string> = {
  tool_called: "Tool called",
  tool_not_called: "Tool not called",
  tool_order: "Tools in order",
  tool_args: "Tool arguments",
  no_tool_errors: "No tool errors",
  outcome_registered: "Outcome registered",
  artifact_created: "Artifact created",
  approval_requested: "Approval requested",
  text_contains: "Reply contains",
  text_not_contains: "Reply does not contain",
  text_regex: "Reply matches",
  max_turns: "Max model turns",
  max_cost: "Max cost",
  max_duration: "Max duration",
};

export function blankCase(n: number): SuiteCase {
  return {
    id: `case-${n}`,
    name: `Case ${n}`,
    input: { kind: "chat", message: "" },
    mocks: { model: { turns: [{ text: "" }] } },
    assertions: [],
  };
}

export function blankSuite(name = "New suite"): AgentSuiteInput {
  return { name, defaultMode: "all", cases: [blankCase(1)], datasets: [] };
}

/** A suite without its bookkeeping (what the JSON view edits). */
export function editableSuite<T extends { agent?: unknown; createdAt?: unknown; updatedAt?: unknown; updatedBy?: unknown; revision?: unknown }>(s: T): Omit<T, "agent" | "createdAt" | "updatedAt" | "updatedBy" | "revision"> {
  const { agent: _a, createdAt: _c, updatedAt: _u, updatedBy: _b, revision: _r, ...rest } = s;
  return rest;
}

export function formatUsd(n: number): string {
  return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function runTargetLabel(run: Pick<SuiteRun, "target" | "version">): string {
  if (run.target === "draft") return "draft";
  if (run.target === "production") return run.version ? `production · v${run.version}` : "production";
  return `v${run.target}`;
}

export function runIsLive(run: Pick<SuiteRun, "status">): boolean {
  return run.status === "running" || run.status === "queued";
}

/** The case's trace as a chat: the user's message, then one assistant message with text and tool calls in order. */
export function traceAsChat(trace: SuiteTrace): { user: string; segments: MessageSegment[] } {
  const user = [...trace.input].reverse().find((m) => m.role === "user")?.content ?? "";
  const segments: MessageSegment[] = [];
  const byTurn = new Map<number, SuiteTrace["toolCalls"]>();
  for (const c of trace.toolCalls) byTurn.set(c.turn, [...(byTurn.get(c.turn) ?? []), c]);
  const toolInfo = (c: SuiteTrace["toolCalls"][number]): ToolCallInfo => ({
    id: c.id,
    name: c.name,
    arguments: c.args,
    result: c.mocked ? `[${c.mocked}${c.mockId ? ` ${c.mockId}` : ""}] ${c.result}` : c.result,
    state: c.approval === "interactive" ? "interrupted" : c.isError ? "error" : "completed",
  });
  if (!trace.turns.length) {
    for (const c of trace.toolCalls) segments.push({ type: "tool", tool: toolInfo(c) });
    if (trace.text) segments.push({ type: "text", content: trace.text });
    return { user, segments };
  }
  trace.turns.forEach((turn) => {
    if (turn.thinking) segments.push({ type: "thinking", content: turn.thinking });
    if (turn.text) segments.push({ type: "text", content: turn.text });
    if (turn.error) segments.push({ type: "text", content: `**Model error:** ${turn.error}` });
    for (const c of byTurn.get(turn.index) ?? []) segments.push({ type: "tool", tool: toolInfo(c) });
  });
  return { user, segments };
}
