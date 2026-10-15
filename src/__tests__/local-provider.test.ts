import { describe, it, expect } from "vitest";
import { buildLocalProvider, discoverLocalModels, localProviderId } from "../setup/local-provider.js";
import { generatePolpoConfigDefault } from "../core/config.js";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (!(path in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("local model servers for setup", () => {
  it("builds a keyless, private-network provider from a preset", () => {
    const r = buildLocalProvider({ preset: "ollama", models: [{ id: "qwen3:4b", name: "qwen3:4b" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe("ollama");
    expect(r.config).toMatchObject({
      preset: "ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      auth: { type: "none" },
      allowPrivateNetwork: true,
      models: [{ id: "qwen3:4b", name: "qwen3:4b" }],
    });
    expect(r.config.compat).toMatchObject({ supportsStore: false, supportsDeveloperRole: false });
  });

  it("accepts LAN addresses and custom ports, refuses remote hosts and unknown presets", () => {
    const lan = buildLocalProvider({ preset: "lm-studio", baseUrl: "http://192.168.1.20:1234/v1" });
    expect(lan.ok && lan.config.baseUrl).toBe("http://192.168.1.20:1234/v1");
    expect(buildLocalProvider({ preset: "openai-compatible", baseUrl: "https://api.openai.com/v1" }))
      .toEqual({ ok: false, error: "Only servers on this machine or the local network can be added here" });
    expect(buildLocalProvider({ preset: "openrouter" }).ok).toBe(false);
    expect(localProviderId("openai-compatible")).toBe("local");
  });

  it("discovers Ollama models through /api/tags", async () => {
    const found = await discoverLocalModels(
      { preset: "ollama" },
      fakeFetch({ "/api/tags": { models: [{ name: "qwen3:4b-instruct" }, { name: "gemma4:e4b" }] } }),
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.id).toBe("ollama");
    expect(found.result.models.map((m) => m.id)).toEqual(["gemma4:e4b", "qwen3:4b-instruct"]);
  });

  it("marks Ollama models without tool calling and lists the capable ones first", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/tags") return json({ models: [{ name: "a-chat-only" }, { name: "b-agent" }, { name: "c-unknown" }] });
      if (url.pathname === "/api/show") {
        const model = JSON.parse(String(init?.body)).model as string;
        if (model === "a-chat-only") return json({ capabilities: ["completion"] });
        if (model === "b-agent") return json({ capabilities: ["completion", "tools"] });
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const found = await discoverLocalModels({ preset: "ollama" }, fetchImpl);
    if (!found.ok) throw new Error(found.error);
    expect(found.result.models.map((m) => [m.id, (m as { tools?: boolean }).tools])).toEqual([
      ["b-agent", true],
      ["c-unknown", undefined],
      ["a-chat-only", false],
    ]);
  });

  it("discovers OpenAI-compatible servers through /v1/models and reports an empty server", async () => {
    const lm = await discoverLocalModels(
      { preset: "lm-studio" },
      fakeFetch({ "/v1/models": { data: [{ id: "llama-3.1-8b" }] } }),
    );
    expect(lm.ok && lm.result.models.map((m) => m.id)).toEqual(["llama-3.1-8b"]);

    const empty = await discoverLocalModels({ preset: "vllm" }, fakeFetch({}));
    expect(empty.ok && empty.result.models).toEqual([]);
    expect(empty.ok && empty.result.warnings.length).toBeGreaterThan(0);
  });

  it("ends up in polpo.json with the model as orchestrator and agent model", () => {
    const local = buildLocalProvider({ preset: "ollama", models: [{ id: "qwen3:4b-instruct" }] });
    if (!local.ok) throw new Error(local.error);
    const config = generatePolpoConfigDefault("demo", {
      model: `${local.id}:qwen3:4b-instruct`,
      providers: { [local.id]: local.config },
    });
    expect(config.settings.orchestratorModel).toBe("ollama:qwen3:4b-instruct");
    expect(config.teams[0].agents[0].model).toBe("ollama:qwen3:4b-instruct");
    expect(config.providers?.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });
});
