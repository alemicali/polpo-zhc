import { afterEach, describe, expect, it, vi } from "vitest";

// Captures the options pi-ai receives (no network).
const calls: Array<Record<string, unknown> | undefined> = [];
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  const fakeMessage = { role: "assistant", content: [], stopReason: "stop", usage: {} };
  return {
    ...actual,
    streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      calls.push(options);
      return { result: async () => fakeMessage, [Symbol.asyncIterator]: async function* () {} };
    },
    completeSimple: async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
      calls.push(options);
      return fakeMessage;
    },
  };
});

import { PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { completeSimpleWithAuth, resolveModel, streamSimpleWithAuth } from "../llm/pi-client.js";

describe("provider attribution (pi 1.6)", () => {
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllEnvs();
  });

  it("drops the pi attribution pi-agent-core adds to agent-loop requests", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const model = resolveModel("openrouter:openai/gpt-4o-mini");
    await streamSimpleWithAuth(model, { messages: [] }, { identity: { attribution: PI_ATTRIBUTION, userAgent: "short" } });
    expect(calls[0]?.identity).toEqual({ attribution: null, userAgent: "short" });
    expect(calls[0]?.apiKey).toBe("test-key");
  });

  it("sends no attribution on one-shot completions either", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    await completeSimpleWithAuth(resolveModel("openrouter:openai/gpt-4o-mini"), { messages: [] });
    expect(calls[0]?.identity).toEqual({ attribution: null });
  });
});
