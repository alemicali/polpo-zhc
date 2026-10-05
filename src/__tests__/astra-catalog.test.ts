import { expect, test } from "vitest";
import { resolveModel, buildStreamOpts } from "../llm/pi-client.js";

test.each(["openai", "openai-codex"])("Astra resolves through %s with native Responses and supported reasoning", provider => {
  const model = resolveModel(`${provider}:gpt-6-astra`);
  expect(model.id).toBe("gpt-6-astra");
  expect(model.provider).toBe(provider);
  expect(model.api).toBe(provider === "openai" ? "openai-responses" : "openai-codex-responses");
  expect(model.reasoning).toBe(true);
  expect(model.input).toContain("image");
  expect(model.contextWindow).toBeGreaterThan(200_000);
  expect(buildStreamOpts(undefined, "high", model.maxTokens)?.reasoning).toBe("high");
  const levels = (model as any).thinkingLevelMap;
  expect(levels.low).toBe("low");
  expect(levels.off).toBeNull();
  expect(levels.minimal).toBe(provider === "openai-codex" ? "low" : null);
});
