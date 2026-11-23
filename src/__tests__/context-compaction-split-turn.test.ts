/**
 * Split-turn summaries and file lists in compaction (ideas from the Pi coding agent,
 * badlogic/pi-mono packages/coding-agent compaction). The model summarizer is mocked.
 */
import { describe, expect, test, vi } from "vitest";
import {
  ContextCompactor,
  TURN_IN_PROGRESS_HEADING,
  buildSummaryPrompt,
  checkpointSummaryText,
  extractFileOperations,
  type SummaryRequest,
} from "../../packages/core/src/context-compactor.js";
import { contextBudgetForModel } from "../../packages/core/src/context-compaction.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, name: string, args: Record<string, unknown> = {}) =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const calls = (...parts: Array<[string, string, Record<string, unknown>]>) =>
  ({ role: "assistant", content: parts.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })) });
const result = (id: string, text: string, name = "read", isError = false) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });

/** ~tokens worth of text (the estimate is characters / 3). */
const big = (tokens: number) => "x".repeat(tokens * 3);

// 100k window: threshold 80k, 20k recent tokens kept verbatim
const budget = contextBudgetForModel({ contextWindow: 100_000, maxTokens: 8_000 });

function mockSummarizer() {
  return vi.fn(async (request: SummaryRequest) => ({
    summary: request.kind === "turn" ? `TURN-SUMMARY(${request.previousSummary ?? "-"})` : `HISTORY-SUMMARY(${request.previousSummary ?? "-"})`,
    model: "mock:summarizer",
  }));
}

function compactor(summarize?: ReturnType<typeof mockSummarizer>) {
  // prune off: these tests are about the summary stage
  return new ContextCompactor({ budget, baseTokens: () => 1_000, summarize, settings: { prune: false } });
}

const textOf = (message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content);

/** Every tool result directly follows the assistant message that made its call. */
function expectCallsPaired(messages: any[]) {
  for (const [index, message] of messages.entries()) {
    if (message.role !== "toolResult") continue;
    let back = index - 1;
    while (back >= 0 && messages[back].role === "toolResult") back -= 1;
    const owner = messages[back];
    expect(owner?.role).toBe("assistant");
    expect(owner.content.some((part: any) => part.type === "toolCall" && part.id === message.toolCallId)).toBe(true);
  }
}

describe("split turn", () => {
  test("a cut inside a turn summarizes the turn's start on its own, right before the kept steps", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [
      user("THE TASK"), // anchor
      assistant(`earlier answer ${big(30_000)}`),
      user("Q2: refactor the parser"),
      call("c0", "read", { path: "src/parser.ts" }), result("c0", big(10_000)),
      call("c1", "grep", { pattern: "parse", path: "src" }), result("c1", big(10_000), "grep"),
      call("c2", "edit", { path: "src/parser.ts", edits: [] }), result("c2", big(10_000), "edit"),
      // parallel calls: the walk back from the end stops on one of their results
      calls(["c3", "read", { path: "src/lexer.ts" }], ["c4", "read", { path: "src/ast.ts" }]),
      result("c3", big(10_000)), result("c4", big(10_000)),
    ];
    const out = await c.prepare(history);
    expect(out.info?.mode).toBe("summary");

    // two summaries: the history before the turn, and the turn's folded start
    expect(summarize).toHaveBeenCalledTimes(2);
    const requests = summarize.mock.calls.map(([request]) => request);
    const historyRequest = requests.find((request) => request.kind !== "turn")!;
    const turnRequest = requests.find((request) => request.kind === "turn")!;
    expect(JSON.stringify(historyRequest.messages)).toContain("earlier answer");
    expect(JSON.stringify(historyRequest.messages)).not.toContain("Q2: refactor");
    expect(turnRequest.messages[0]).toEqual(history[2]);
    expect(turnRequest.messages.at(-1)!.role).toBe("toolResult");
    expect(JSON.stringify(turnRequest.messages)).not.toContain("earlier answer");

    // projection: anchor, one checkpoint (history, then the turn), then the kept steps
    expect(out.messages[0]).toEqual(history[0]);
    const checkpoint = textOf(out.messages[1]);
    expect(checkpoint).toContain("HISTORY-SUMMARY(-)");
    expect(checkpoint).toContain(`${TURN_IN_PROGRESS_HEADING}\nTURN-SUMMARY(-)`);
    expect(checkpoint.indexOf("HISTORY-SUMMARY")).toBeLessThan(checkpoint.indexOf(TURN_IN_PROGRESS_HEADING));
    expect(out.messages[2]).toEqual(history[9]); // the parallel calls, with both results after them
    expect(out.messages.slice(2)).toEqual(history.slice(9));
    expectCallsPaired(out.messages);

    // the summarizer is told it is a turn in progress
    const prompt = buildSummaryPrompt(turnRequest).prompt;
    expect(prompt).toContain("START of a turn that is still in progress");
    expect(prompt).toContain("## Already Done");
  });

  test("the cut never separates a call from its result", async () => {
    // every size of the last result moves the cut, never between the call and the result
    for (const lastTokens of [3_000, 9_000, 15_000, 21_000, 30_000]) {
      const c = compactor(mockSummarizer());
      const history: any[] = [user("THE TASK"), assistant(big(35_000)), user("Q2")];
      for (let i = 0; i < 5; i += 1) history.push(call(`c${i}`, "read", { path: `f${i}.ts` }), result(`c${i}`, big(9_000)));
      history.push(call("last", "read", { path: "last.ts" }), result("last", big(lastTokens)));
      const out = await c.prepare(history);
      expect(out.info).not.toBeNull();
      expectCallsPaired(out.messages);
      expect(out.messages[2]?.role).not.toBe("toolResult");
    }
  });

  test("a later compaction in the same turn updates the turn summary, not the history", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [user("THE TASK"), assistant(big(30_000)), user("Q2")];
    for (let i = 0; i < 5; i += 1) history.push(call(`a${i}`, "read", { path: `a${i}.ts` }), result(`a${i}`, big(10_000)));
    await c.prepare(history);
    expect(summarize).toHaveBeenCalledTimes(2);

    // the turn goes on until the window fills again
    for (let i = 0; i < 6; i += 1) history.push(call(`b${i}`, "read", { path: `b${i}.ts` }), result(`b${i}`, big(10_000)));
    summarize.mockClear();
    const out = await c.prepare(history);
    expect(out.info?.mode).toBe("summary");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0]).toMatchObject({ kind: "turn", previousSummary: "TURN-SUMMARY(-)" });
    const checkpoint = textOf(out.messages[1]);
    expect(checkpoint).toContain("HISTORY-SUMMARY(-)");
    expect(checkpoint).toContain("TURN-SUMMARY(TURN-SUMMARY(-))");
    expectCallsPaired(out.messages);
  });

  test("when the turn has ended, its summary joins the history at the next compaction", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [user("THE TASK"), assistant(big(30_000)), user("Q2")];
    for (let i = 0; i < 5; i += 1) history.push(call(`a${i}`, "read", { path: `a${i}.ts` }), result(`a${i}`, big(10_000)));
    await c.prepare(history);
    history.push(assistant(`done ${big(20_000)}`), user(`Q3 ${big(40_000)}`));
    summarize.mockClear();
    const out = await c.prepare(history);
    expect(summarize).toHaveBeenCalledTimes(1);
    const request = summarize.mock.calls[0]![0];
    expect(request.kind).toBeUndefined();
    expect(request.previousSummary).toContain("HISTORY-SUMMARY(-)");
    expect(request.previousSummary).toContain(`${TURN_IN_PROGRESS_HEADING}\nTURN-SUMMARY(-)`);
    // no turn in progress any more
    expect(textOf(out.messages[1]).split(TURN_IN_PROGRESS_HEADING).length).toBe(2); // only inside the history summary
    expect(c.getState().turnSummary).toBeUndefined();
  });

  test("without a model summary both parts fall back to the deterministic extract", async () => {
    const c = compactor();
    const history: any[] = [user("THE TASK"), assistant(`old ${big(30_000)}`), user("Q2 please")];
    for (let i = 0; i < 5; i += 1) history.push(call(`a${i}`, "read", { path: `a${i}.ts` }), result(`a${i}`, big(10_000)));
    const out = await c.prepare(history);
    expect(out.info).toMatchObject({ mode: "fallback", fallbackReason: "no summarizer" });
    const checkpoint = textOf(out.messages[1]);
    expect(checkpoint).toContain(TURN_IN_PROGRESS_HEADING);
    expect(checkpoint.slice(checkpoint.indexOf(TURN_IN_PROGRESS_HEADING))).toContain("Q2 please");
  });
});

describe("unchanged when the cut is on a turn boundary", () => {
  test("one history summary, no turn section", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [
      user("THE TASK"),
      assistant(`a1 ${big(30_000)}`), user("Q2"), assistant(`a2 ${big(30_000)}`),
      user(`Q3 ${big(25_000)}`),
    ];
    const out = await c.prepare(history);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0].kind).toBeUndefined();
    expect(summarize.mock.calls[0]![0].messages).toEqual(history.slice(1, 4));
    expect(out.messages).toHaveLength(3);
    expect(textOf(out.messages[1])).toBe("[Context checkpoint: earlier conversation compacted]\n\nHISTORY-SUMMARY(-)\n\n[End context checkpoint]");
    expect(out.messages[2]).toEqual(history[4]);
    expect(c.getState().turnSummary).toBeUndefined();
  });

  test("a cut right after the user's message (the assistant has not acted yet) is not split", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [user("THE TASK"), assistant(`a1 ${big(30_000)}`), assistant(`a2 ${big(30_000)}`), user("Q2"), assistant(`a3 ${big(25_000)}`)];
    const out = await c.prepare(history);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0].kind).toBeUndefined();
    expect(summarize.mock.calls[0]![0].messages).toEqual(history.slice(1, 4));
    expect(textOf(out.messages[1])).not.toContain(TURN_IN_PROGRESS_HEADING);
  });

  test("a task run (one long turn whose request is the anchor) is not split", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [user("THE TASK")];
    for (let i = 0; i < 10; i += 1) history.push(call(`c${i}`, "bash", { command: "make" }), result(`c${i}`, big(10_000), "bash"));
    const out = await c.prepare(history);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0].kind).toBeUndefined();
    expect(textOf(out.messages[1])).not.toContain(TURN_IN_PROGRESS_HEADING);
    expectCallsPaired(out.messages);
  });
});

describe("file lists", () => {
  test("extracts reads and writes from coding tool calls, skipping failures and shell commands", () => {
    const ops = extractFileOperations([
      call("r1", "read", { path: "src/a.ts" }), result("r1", "ok"),
      call("r2", "read_file", { path: "src/a.ts" }), result("r2", "ok"),
      calls(["g", "grep", { pattern: "x", path: "src/lib" }], ["l", "ls", { path: "docs" }], ["gl", "glob", { pattern: "*.ts" }]),
      result("g", "ok", "grep"), result("l", "ok", "ls"), result("gl", "ok", "glob"),
      call("e1", "edit", { path: "src/b.ts" }), result("e1", "ok", "edit"),
      call("w1", "write", { path: "src/fail.ts" }), result("w1", "denied", "write", true),
      call("p1", "apply_patch", { patch: "*** Begin Patch\n*** Update File: src/c.ts\n*** Add File: src/d.ts\n*** End Patch" }), result("p1", "ok", "apply_patch"),
      call("b1", "bash", { command: "sed -i s/a/b/ src/e.ts" }), result("b1", "", "bash"),
    ]);
    expect(ops.read).toEqual(["src/a.ts", "src/a.ts", "src/lib", "docs"]);
    expect(ops.modified).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  test("lists are deduplicated, merged across two compactions and survive a saved checkpoint", async () => {
    const summarize = mockSummarizer();
    const c = compactor(summarize);
    const history: any[] = [user("THE TASK")];
    history.push(
      call("r1", "read", { path: "src/a.ts" }), result("r1", big(9_000)),
      call("e1", "edit", { path: "src/b.ts" }), result("e1", big(9_000), "edit"),
      call("r2", "read", { path: "src/b.ts" }), result("r2", big(9_000)),
      call("r3", "read", { path: "src/a.ts" }), result("r3", big(9_000)),
      call("w0", "write", { path: "src/fail.ts" }), result("w0", "permission denied", "write", true),
      call("x1", "bash", { command: "rm -rf build" }), result("x1", big(9_000), "bash"),
      call("k1", "bash", { command: "ls" }), result("k1", big(20_000), "bash"),
      call("k2", "bash", { command: "ls" }), result("k2", big(20_000), "bash"),
    );
    const first = await c.prepare(history);
    expect(first.info?.removedMessages).toBeGreaterThan(0);
    const one = textOf(first.messages[1]);
    expect(one).toContain("<read-files>\nsrc/a.ts\n</read-files>");
    expect(one).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
    expect(one).not.toContain("src/fail.ts");

    // more work, then a second compaction: src/a.ts is now modified too, src/d.ts read
    history.push(
      call("r4", "read", { path: "src/d.ts" }), result("r4", big(15_000)),
      call("w1", "write", { path: "src/a.ts" }), result("w1", big(15_000), "write"),
      call("k3", "bash", { command: "ls" }), result("k3", big(20_000), "bash"),
      call("k4", "bash", { command: "ls" }), result("k4", big(20_000), "bash"),
    );
    summarize.mockClear();
    const second = await c.prepare(history);
    expect(second.info?.removedMessages).toBeGreaterThan(0);
    const two = textOf(second.messages[1]);
    expect(two).toContain("<read-files>\nsrc/d.ts\n</read-files>");
    expect(two).toContain("<modified-files>\nsrc/b.ts\nsrc/a.ts\n</modified-files>");
    // the summarizer gets the previous summary without the lists (they are kept apart)
    expect(summarize.mock.calls[0]![0].previousSummary).toBe("HISTORY-SUMMARY(-)");

    // a chat session saves the checkpoint text and restores it later: the lists come back
    const state = c.getState();
    const restored = compactor(summarize);
    restored.restoreState({ covered: state.covered, summary: checkpointSummaryText(state), pruned: [], count: state.count });
    expect(restored.getState()).toMatchObject({ summary: "HISTORY-SUMMARY(HISTORY-SUMMARY(-))", readFiles: ["src/d.ts"], modifiedFiles: ["src/b.ts", "src/a.ts"] });
    expect(restored.project(history)).toEqual(c.project(history));
  });

  test("long lists are capped with a count of the rest", () => {
    const readFiles = Array.from({ length: 150 }, (_, i) => `r/${i}.ts`);
    const text = checkpointSummaryText({ summary: "S", readFiles, modifiedFiles: [] });
    const block = /<read-files>\n([\s\S]*?)\n<\/read-files>/.exec(text)![1]!.split("\n");
    expect(block[0]).toBe("(+50 more)");
    expect(block).toHaveLength(101);
    expect(block.at(-1)).toBe("r/149.ts");
    expect(text).not.toContain("<modified-files>");
  });
});
