import { describe, it, expect, vi, beforeEach } from "vitest";

const connected = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("../setup/providers.js", () => ({
  detectProviders: () => ["anthropic", "openai", "groq"].map((name) => ({ name, envVar: undefined, hasKey: connected.names.includes(name), source: "env" })),
}));
vi.mock("../llm/pi-client.js", () => ({
  resolveModelSpec: (spec: unknown) => (typeof spec === "string" ? spec : (spec as { primary?: string } | undefined)?.primary),
  listModels: (provider: string) => ({
    anthropic: [{ id: "claude-fable-5" }, { id: "claude-haiku-4-5" }, { id: "claude-sonnet-5-5" }],
    openai: [{ id: "chat-latest" }, { id: "gpt-6.1-sol" }],
    groq: [{ id: "llama-x" }],
  } as Record<string, { id: string }[]>)[provider] ?? [],
}));

import { effectiveOrchestratorModel, requireOrchestratorModel, NoOrchestratorModelError } from "../llm/orchestrator-model.js";

describe("effectiveOrchestratorModel", () => {
  beforeEach(() => { connected.names = []; });

  it("keeps the configured model, string or with fallbacks", () => {
    connected.names = ["anthropic"];
    expect(effectiveOrchestratorModel("openai-codex:gpt-6-astra")).toBe("openai-codex:gpt-6-astra");
    const cfg = { primary: "openai:gpt-6.1-sol", fallbacks: ["anthropic:claude-sonnet-5-5"] };
    expect(effectiveOrchestratorModel(cfg)).toBe(cfg);
  });

  it("falls back to the preferred model of a connected provider when unset", () => {
    connected.names = ["groq", "anthropic"];
    expect(effectiveOrchestratorModel(null)).toBe("anthropic:claude-sonnet-5-5");
    expect(effectiveOrchestratorModel({ fallbacks: [] })).toBe("anthropic:claude-sonnet-5-5");
    connected.names = ["openai"];
    expect(effectiveOrchestratorModel(undefined)).toBe("openai:gpt-6.1-sol");
    connected.names = ["groq"];
    expect(effectiveOrchestratorModel(undefined)).toBe("groq:llama-x");
  });

  it("throws a readable NO_MODEL error when nothing is configured or connected", () => {
    expect(effectiveOrchestratorModel(undefined)).toBeUndefined();
    expect(() => requireOrchestratorModel(undefined)).toThrow(NoOrchestratorModelError);
    expect(() => requireOrchestratorModel(undefined)).toThrow(/Settings → Orchestrator/);
  });
});
