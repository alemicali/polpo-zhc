import { describe, expect, test, vi } from "vitest";
import {
  ContextCompactor,
  buildSummaryPrompt,
  parseSummary,
  isContextOverflowError,
  type ContextSummarizer,
} from "../../packages/core/src/context-compactor.js";
import { contextBudgetForModel, summarizeContextMessages } from "../../packages/core/src/context-compaction.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, name = "bash") => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] });
const result = (id: string, text: string, name = "bash", isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });

/** ~tokens worth of text (the estimate is characters / 3). */
const big = (tokens: number) => "x".repeat(tokens * 3);

const budget = contextBudgetForModel({ contextWindow: 100_000, maxTokens: 8_000 });

function compactor(summarize?: ContextSummarizer, extra: Partial<ConstructorParameters<typeof ContextCompactor>[0]> = {}) {
  return new ContextCompactor({ budget, baseTokens: () => 1_000, summarize, ...extra });
}

describe("ContextCompactor", () => {
  test("below the threshold it changes nothing", async () => {
    const c = compactor();
    const messages = [user("task"), assistant("ok")];
    const out = await c.prepare(messages);
    expect(out.info).toBeNull();
    expect(out.messages).toEqual(messages);
  });

  test("keeps the same projection between calls (stable prefix, cache-friendly)", async () => {
    const summarize = vi.fn(async () => ({ summary: "## Goal\nship it", model: "m" }));
    const c = compactor(summarize);
    const history: any[] = [user("the task"), ...Array.from({ length: 15 }, (_, i) => [assistant(`step ${i} ${big(6_000)}`), user(`ok ${i}`)]).flat()];
    const first = await c.prepare(history);
    expect(first.info?.mode).toBe("summary");
    expect(summarize).toHaveBeenCalledTimes(1);

    // the agent goes on: two small messages more, still under the threshold
    history.push(assistant("next"), user("fine"));
    const second = await c.prepare(history);
    expect(second.info).toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
    // same checkpoint and same retained messages: only new messages at the end
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages.length).toBe(first.messages.length + 2);
  });

  test("never summarizes the anchors (system prompt, the task request)", async () => {
    const seen: any[][] = [];
    const c = compactor(async ({ messages }) => { seen.push(messages); return { summary: "S" }; });
    const history: any[] = [{ role: "system", content: "sys" }, user("THE TASK"), ...Array.from({ length: 10 }, (_, i) => assistant(`${i} ${big(10_000)}`))];
    const out = await c.prepare(history);
    expect(out.messages[0]).toEqual(history[0]);
    expect(out.messages[1]).toEqual(history[1]);
    expect(String((out.messages[2] as any).content)).toContain("Context checkpoint");
    expect(seen[0]!.some((m) => JSON.stringify(m).includes("THE TASK"))).toBe(false);
  });

  test("clears old tool results first and skips the summary when that is enough", async () => {
    const summarize = vi.fn(async () => ({ summary: "S" }));
    const c = compactor(summarize);
    const history: any[] = [user("task")];
    for (let i = 0; i < 8; i += 1) history.push(call(`c${i}`), result(`c${i}`, big(10_000)));
    history.push(call("keep", "register_outcome"), result("keep", big(10_000), "register_outcome"));
    for (let i = 8; i < 11; i += 1) history.push(call(`c${i}`), result(`c${i}`, "short"));
    const out = await c.prepare(history);
    expect(out.info?.mode).toBe("prune");
    expect(out.info?.prunedToolResults).toBeGreaterThan(0);
    expect(summarize).not.toHaveBeenCalled();
    const text = JSON.stringify(out.messages);
    expect(text).toContain("Old tool result cleared");
    // protected tools and the most recent results are kept
    expect(JSON.stringify(out.messages.find((m: any) => m.toolCallId === "keep"))).not.toContain("cleared");
    expect(JSON.stringify(out.messages.find((m: any) => m.toolCallId === "c10"))).toContain("short");
    // a tool call and its result stay paired: every result still follows its call
    for (const [index, message] of out.messages.entries()) {
      if ((message as any).role === "toolResult") expect((out.messages[index - 1] as any).role).toBe("assistant");
    }
  });

  test("a cleared result that was saved to a file keeps the file's path", async () => {
    const c = compactor(async () => ({ summary: "S" }));
    const history: any[] = [user("task")];
    for (let i = 0; i < 8; i += 1) history.push(call(`c${i}`), result(`c${i}`, `${big(10_000)}\nFull output saved to /out/tool-output/bash-${i}.txt. Read it with \`read\``));
    for (let i = 8; i < 11; i += 1) history.push(call(`c${i}`), result(`c${i}`, "short"));
    const out = await c.prepare(history);
    expect(JSON.stringify(out.messages.find((m: any) => m.toolCallId === "c0"))).toContain("still in /out/tool-output/bash-0.txt");
  });

  test("summaries are incremental: the previous summary is passed back", async () => {
    const calls: Array<string | undefined> = [];
    const c = compactor(async ({ previousSummary }) => { calls.push(previousSummary); return { summary: `S${calls.length}` }; });
    const history: any[] = [user("task")];
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 15; i += 1) history.push(assistant(`r${round} ${i} ${big(6_000)}`));
      await c.prepare(history);
    }
    expect(calls).toEqual([undefined, "S1"]);
    expect(c.compactions).toBe(2);
  });

  test("falls back to the deterministic summary when the model fails or times out", async () => {
    const c = compactor(async () => { throw new Error("provider down"); });
    const history: any[] = [user("task"), ...Array.from({ length: 15 }, (_, i) => assistant(`${i} ${big(6_000)}`))];
    const out = await c.prepare(history);
    expect(out.info?.mode).toBe("fallback");
    expect(out.info?.fallbackReason).toContain("provider down");

    const slow = compactor(() => new Promise(() => undefined), { settings: { summaryTimeoutMs: 20 } });
    const timedOut = await slow.prepare(history);
    expect(timedOut.info?.mode).toBe("fallback");
    expect(timedOut.info?.fallbackReason).toContain("timed out");
  });

  test("cuts deep enough that summary + kept messages fit (no compaction again next time)", async () => {
    const c = compactor(async () => ({ summary: "S" }));
    const history: any[] = [user("task"), assistant(big(45_000)), assistant(big(45_000)), user("now answer")];
    const first = await c.prepare(history);
    expect(first.info?.mode).toBe("summary");
    expect(first.info!.afterTokens).toBeLessThan(c.threshold);
    history.push(assistant("answer"), user("next"));
    expect((await c.prepare(history)).info).toBeNull();
  });

  test("uses the provider's real input tokens when known", async () => {
    const c = compactor(async () => ({ summary: "S" }));
    const history: any[] = [user("task"), assistant("small")];
    expect((await c.prepare(history)).info).toBeNull();
    // the provider says the prompt was much bigger than the estimate (images, tokenizer…)
    c.noteUsage(budget.softLimit + 1, history.length);
    history.push(user("one more"));
    const out = await c.prepare(history);
    expect(out.info).not.toBeNull();
  });

  test("overflow and manual requests always compact", async () => {
    const c = compactor(async ({ focus }) => ({ summary: `focus=${focus}` }));
    const history: any[] = [user("task"), assistant("a"), user("b"), assistant("c")];
    const manual = await c.prepare(history, { force: "manual", focus: "the API" });
    expect(manual.info).toMatchObject({ reason: "manual", focus: "the API" });
    expect(JSON.stringify(manual.messages)).toContain("focus=the API");
    const overflow = await c.prepare(history, { force: "overflow" });
    expect(overflow.info?.reason).toBe("overflow");
  });

  test("durable facts go to the callback when memory flush is on", async () => {
    const saved: string[][] = [];
    const c = compactor(async () => ({ summary: "S", durableFacts: ["Alessio prefers Italian"] }), { onDurableFacts: (facts) => { saved.push(facts); } });
    const off = compactor(async () => ({ summary: "S", durableFacts: ["x"] }), { settings: { memoryFlush: false }, onDurableFacts: () => { throw new Error("must not run"); } });
    const history: any[] = [user("task"), ...Array.from({ length: 15 }, (_, i) => assistant(`${i} ${big(6_000)}`))];
    await c.prepare(history);
    await off.prepare(history);
    expect(saved).toEqual([["Alessio prefers Italian"]]);
  });

  test("auto: false only compacts on request", async () => {
    const c = compactor(async () => ({ summary: "S" }), { settings: { auto: false } });
    const history: any[] = [user("task"), ...Array.from({ length: 15 }, (_, i) => assistant(`${i} ${big(6_000)}`))];
    expect((await c.prepare(history)).info).toBeNull();
    expect((await c.prepare(history, { force: "manual" })).info).not.toBeNull();
  });

  test("state survives a restore (chat sessions reuse their checkpoint)", async () => {
    const a = compactor(async () => ({ summary: "S" }));
    const history: any[] = [user("task"), ...Array.from({ length: 15 }, (_, i) => assistant(`${i} ${big(6_000)}`))];
    const first = await a.prepare(history);
    const b = compactor();
    b.restoreState(a.getState());
    expect(b.project(history)).toEqual(first.messages);
  });
});

describe("summary prompt and parsing", () => {
  test("asks for an update when there is a previous summary, in the conversation's language", () => {
    const fresh = buildSummaryPrompt({ messages: [user("ciao")] });
    expect(fresh.systemPrompt).toContain("same language");
    expect(fresh.prompt).toContain("## Durable Facts");
    const update = buildSummaryPrompt({ messages: [user("ciao")], previousSummary: "OLD" });
    expect(update.prompt).toContain("<previous-summary>\nOLD");
  });

  test("tool output is capped for the summarizer", () => {
    const { prompt } = buildSummaryPrompt({ messages: [result("t", big(10_000))] });
    expect(prompt).toContain("[truncated:");
    expect(prompt.length).toBeLessThan(10_000);
  });

  test("splits durable facts from the summary", () => {
    const parsed = parseSummary("## Goal\nX\n\n## Durable Facts\n- one\n- (none)\n- two\n");
    expect(parsed.summary).toBe("## Goal\nX");
    expect(parsed.durableFacts).toEqual(["one", "two"]);
    expect(parseSummary("## Goal\nX").durableFacts).toEqual([]);
  });

  test("recognizes provider overflow errors", () => {
    for (const message of ["prompt is too long: 1107869 tokens > 1000000 maximum", "This model's maximum context length is 128000 tokens", "context_length_exceeded", "input is too long for requested model"]) {
      expect(isContextOverflowError(message)).toBe(true);
    }
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
  });
});

describe("deterministic extract", () => {
  test("when over budget it drops the oldest messages, not the ones next to the cut", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `message-${i} ${"y".repeat(300)}` }));
    const summary = summarizeContextMessages(messages, 3_000);
    expect(summary).toContain("message-49");
    expect(summary).not.toContain("message-0 ");
    expect(summary.split("\n")[0]).toContain("earlier messages omitted");
  });
});
