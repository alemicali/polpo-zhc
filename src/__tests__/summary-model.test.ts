import { describe, expect, test } from "vitest";
import { resolveModel, resolveSummaryModel } from "../llm/pi-client.js";

describe("compaction summary model", () => {
  test("defaults to a cheaper model of the conversation's provider", () => {
    expect(resolveSummaryModel(resolveModel("anthropic:claude-opus-4-8"), undefined, 20_000).id).toBe("claude-haiku-4-5");
    expect(resolveSummaryModel(resolveModel("openai-codex:gpt-6-astra"), undefined, 20_000).id).toBe("gpt-6-luna");
  });

  test("the configured model wins", () => {
    const model = resolveSummaryModel(resolveModel("anthropic:claude-opus-4-8"), "anthropic:claude-sonnet-5", 20_000);
    expect(model.id).toBe("claude-sonnet-5");
  });

  test("a summary prompt too big for the small model goes to the conversation's model", () => {
    const opus = resolveModel("anthropic:claude-opus-4-8");
    const big = Math.floor(200_000 * 0.95);
    expect(resolveSummaryModel(opus, undefined, big).id).toBe(opus.id);
  });

  test("a model already in the preferences, or a provider without one, keeps itself", () => {
    const haiku = resolveModel("anthropic:claude-haiku-4-5");
    expect(resolveSummaryModel(haiku, undefined, 1_000).id).toBe("claude-haiku-4-5");
  });
});
