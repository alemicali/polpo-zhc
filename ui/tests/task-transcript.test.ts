// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { RunActivityEntry, TaskDirection, TaskRunContext } from "@polpo-ai/react";
import { buildTaskTranscript, groupActivityRuns, runLabel } from "../src/lib/task-transcript";

const header = (runId: string, startedAt: string): RunActivityEntry => ({ _run: true, runId, startedAt, agentName: "coder" });
const at = (minute: number) => `2026-11-24T10:${String(minute).padStart(2, "0")}:00.000Z`;

const direction = (over: Partial<TaskDirection> & Pick<TaskDirection, "id" | "mode" | "message">): TaskDirection => ({
  taskId: "t1",
  status: "applied",
  createdAt: at(0),
  ...over,
});

const run = (runId: string, startedAt: string, over: Partial<TaskRunContext> = {}): TaskRunContext => ({
  runId,
  startedAt,
  status: "completed",
  engine: "polpo",
  computer: { id: "host", kind: "host" },
  egress: { mode: "direct" },
  ...over,
} as TaskRunContext);

describe("buildTaskTranscript", () => {
  const entries: RunActivityEntry[] = [
    header("r1", at(1)),
    { ts: at(1), event: "spawning" },
    { ts: at(2), type: "reasoning", text: "Let me look at the repo." },
    { ts: at(2), type: "tool_use", tool: "read", toolId: "c1", input: { path: "src/app.ts" } },
    { ts: at(3), type: "tool_result", tool: "read", toolId: "c1", content: "export {}" },
    { ts: at(3), type: "tool_use", tool: "bash", toolId: "c2", input: { command: "npm test" } },
    { ts: at(4), type: "tool_result", tool: "bash", toolId: "c2", content: "1 failed", isError: true },
    { ts: at(4), type: "assistant", text: "Tests fail, fixing." },
    { ts: at(5), event: "direction:applied", data: { directionIds: ["d1"], modes: ["steer"] } },
    { ts: at(6), type: "assistant", text: "Done, as you asked." },
    { ts: at(7), event: "done", data: { status: "failed", error: "timeout" } },
    header("r2", at(10)),
    { ts: at(11), type: "tool_use", tool: "grep", toolId: "c3", input: { pattern: "TODO" } },
  ];
  const directions = [direction({ id: "d1", mode: "steer", message: "Use vitest", runId: "r1", appliedAt: at(5) })];

  test("the instructions open the conversation, then the assistant's reasoning, tools and text in order", () => {
    const transcript = buildTaskTranscript({ prompt: "Fix the tests", createdAt: at(0), entries, directions });
    expect(transcript).toHaveLength(2);
    const [first] = transcript;
    expect(first.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(first.messages[0]).toMatchObject({ role: "user", kind: "prompt", content: "Fix the tests" });
    const reply = first.messages[1];
    expect(reply.segments.map((s) => s.type)).toEqual(["thinking", "tool", "tool", "text"]);
    const tools = reply.segments.filter((s) => s.type === "tool").map((s) => (s as { tool: { name: string; state: string; result?: string } }).tool);
    expect(tools).toEqual([
      expect.objectContaining({ name: "read", state: "completed", result: "export {}", arguments: { path: "src/app.ts" } }),
      expect.objectContaining({ name: "bash", state: "error", result: "1 failed" }),
    ]);
    expect(reply.content).toBe("Tests fail, fixing.");
  });

  test("a direction is a user turn where the run applied it; a failed run says why", () => {
    const [first] = buildTaskTranscript({ prompt: "Fix the tests", entries, directions });
    expect(first.messages[2]).toMatchObject({ role: "user", kind: "steer", content: "Use vitest", directionStatus: "applied" });
    const last = first.messages[3];
    expect(last.segments).toEqual([
      { type: "text", content: "Done, as you asked." },
      { type: "text", content: "**Run failed:** timeout" },
    ]);
    expect(first.status).toBe("failed");
  });

  test("each run is a section: a later run is a retry unless it continued the task", () => {
    const transcript = buildTaskTranscript({ prompt: "p", entries, directions });
    expect(transcript.map((r) => [r.attempt, r.kind])).toEqual([[1, "first"], [2, "retry"]]);
    expect(runLabel(transcript[1])).toBe("Run 2 · retry");

    const continued = buildTaskTranscript({ prompt: "p", entries, directions, runs: [run("r1", at(1)), run("r2", at(10), { continuation: true })] });
    expect(runLabel(continued[1])).toBe("Run 2 · continuation");
  });

  test("a continuation's message opens the run it started", () => {
    const transcript = buildTaskTranscript({
      prompt: "p",
      entries,
      directions: [...directions, direction({ id: "d2", mode: "continue", message: "Now add docs", createdAt: at(9), appliedAt: at(10) })],
    });
    expect(transcript[1].kind).toBe("continuation");
    expect(transcript[1].messages[0]).toMatchObject({ role: "user", kind: "continue", content: "Now add docs" });
  });

  test("tool calls of a run still going stay running; of an ended run, interrupted", () => {
    const live = buildTaskTranscript({ prompt: "p", entries, directions, isActive: true });
    const tool = (t: typeof live) => (t[1].messages[0].segments[0] as { tool: { state: string } }).tool.state;
    expect(tool(live)).toBe("calling");
    expect(live[1].status).toBe("running");
    expect(tool(buildTaskTranscript({ prompt: "p", entries, directions }))).toBe("interrupted");
  });

  test("a queued direction waits at the end; with no run yet the conversation is the instructions", () => {
    const queued = direction({ id: "d9", mode: "steer", message: "Also lint", status: "queued", createdAt: at(12) });
    const transcript = buildTaskTranscript({ prompt: "p", entries, directions: [...directions, queued] });
    const lastRun = transcript[transcript.length - 1];
    expect(lastRun.messages.at(-1)).toMatchObject({ content: "Also lint", directionStatus: "queued" });

    const empty = buildTaskTranscript({ prompt: "Write a haiku", entries: [] });
    expect(empty).toHaveLength(1);
    expect(empty[0].messages).toEqual([expect.objectContaining({ role: "user", kind: "prompt", content: "Write a haiku" })]);
  });

  test("groupActivityRuns splits the log at each run header", () => {
    expect(groupActivityRuns(entries).map((g) => [g.attempt, g.header?.runId, g.entries.length])).toEqual([[1, "r1", 10], [2, "r2", 1]]);
  });
});
