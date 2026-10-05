import { describe, expect, test } from "vitest";
import {
  compactContextMessages,
  contextBudgetForModel,
  estimateContextTokens,
  selectCompactionCut,
  summarizeContextMessages,
} from "../../packages/core/src/context-compaction.js";

const textMessage = (role: string, text: string) => ({ role, content: text });

describe("context compaction", () => {
  test("reserves output space and a safety margin", () => {
    expect(contextBudgetForModel({ contextWindow: 1_000_000, maxTokens: 128_000 })).toEqual({
      hardLimit: 1_000_000,
      softLimit: 800_000,
      targetTokens: 500_000,
      keepRecentTokens: 100_000,
    });
    expect(contextBudgetForModel({ contextWindow: 272_000, maxTokens: 128_000 })).toEqual({
      hardLimit: 272_000,
      softLimit: 204_000,
      targetTokens: 136_000,
      keepRecentTokens: 54_400,
    });
  });

  test("includes system prompt and tool schemas in the estimate", () => {
    const estimate = estimateContextTokens({
      systemPrompt: "s".repeat(3_000),
      messages: [textMessage("user", "m".repeat(3_000))],
      tools: [{ name: "large_tool", description: "t".repeat(3_000), parameters: { type: "object" } }],
    });
    expect(estimate).toBeGreaterThanOrEqual(3_000);
  });

  test("never cuts between an assistant tool call and its tool result", () => {
    const messages = [
      textMessage("user", "old request ".repeat(2_000)),
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "result ".repeat(2_000) }] },
      { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
    ];

    const cut = selectCompactionCut(messages, 1_000);
    expect(cut).not.toBe(2);
    expect(messages[cut]?.role).not.toBe("toolResult");
  });

  test("replaces old context with a checkpoint and retains the recent suffix", () => {
    const messages = [
      textMessage("user", "old request"),
      textMessage("user", "old answer"),
      textMessage("user", "recent request"),
      textMessage("user", "recent answer"),
    ];
    const compacted = compactContextMessages(messages, 2, "Structured summary");

    expect(compacted).toHaveLength(3);
    expect(compacted[0]).toMatchObject({ role: "user" });
    expect(String(compacted[0].content)).toContain("Structured summary");
    expect(compacted.slice(1)).toEqual(messages.slice(2));
  });

  test("bounds summaries and retains the end of large tool output", () => {
    const summary = summarizeContextMessages([{
      role: "toolResult",
      toolName: "bash",
      content: `START ${"x".repeat(20_000)} FINAL_ERROR`,
    }], 1_000);

    expect(summary.length).toBeLessThanOrEqual(1_050);
    expect(summary).toContain("START");
    expect(summary).toContain("FINAL_ERROR");
  });
});
