import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  buildRequestAuth,
  resetCustomProvidersForTests,
  setCustomProviderFetchForTests,
  setCustomProviderSecretStatus,
  setProviderSecretsSource,
} from "../llm/custom-providers.js";
import {
  completeSimpleWithAuth,
  listModels,
  resolveModel,
  setProviderOverrides,
  validateProviderKeys,
  hasProviderCredentials,
} from "../llm/pi-client.js";
import { parseProviders } from "../core/config.js";
import type { ProviderConfig } from "../core/types.js";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { startFakeLlmServer, type FakeLlmServer } from "./helpers/fake-llm-server.js";

const ctx = () => ({ messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] });

function textOf(msg: { content: Array<{ type: string; text?: string }> }): string {
  return msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

let server: FakeLlmServer;

beforeAll(async () => {
  server = await startFakeLlmServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  resetCustomProvidersForTests();
  server.requests.length = 0;
  server.rejectFields.clear();
});
afterEach(() => {
  setProviderOverrides({});
  resetCustomProvidersForTests();
  delete process.env.LOCALGW_API_KEY;
  delete process.env.MY_GW_KEY;
});

function local(cfg: Partial<ProviderConfig>): ProviderConfig {
  return {
    preset: "openai-compatible",
    api: "openai-completions",
    baseUrl: `${server.url}/v1`,
    allowPrivateNetwork: true,
    models: [{ id: "fake-model", name: "Fake" }],
    ...cfg,
  };
}

describe("buildRequestAuth", () => {
  it("bearer on OpenAI APIs uses the SDK's own Authorization header", () => {
    expect(buildRequestAuth("openai-completions", { type: "bearer" }, "k1")).toEqual({ apiKey: "k1", headers: {} });
  });
  it("x-api-key on OpenAI APIs suppresses Authorization", () => {
    const r = buildRequestAuth("openai-completions", { type: "x-api-key" }, "k1");
    expect(r.headers).toEqual({ authorization: null, "x-api-key": "k1" });
    expect(r.apiKey).not.toBe("k1");
  });
  it("bearer on Anthropic suppresses x-api-key", () => {
    const r = buildRequestAuth("anthropic-messages", { type: "bearer" }, "k1");
    expect(r.headers).toEqual({ "x-api-key": null, authorization: "Bearer k1" });
  });
  it("custom header with prefix", () => {
    const r = buildRequestAuth("openai-completions", { type: "header", headerName: "cf-aig-authorization", prefix: "Bearer " }, "k1");
    expect(r.headers).toEqual({ authorization: null, "cf-aig-authorization": "Bearer k1" });
  });
  it("keyless suppresses every auth header", () => {
    expect(buildRequestAuth("anthropic-messages", { type: "none" }, undefined).headers).toEqual({ "x-api-key": null, authorization: null });
    expect(buildRequestAuth("openai-completions", { type: "none" }, undefined).headers).toEqual({ authorization: null });
  });
});

describe("custom provider runtime (fake OpenAI-compatible server)", () => {
  it("keyless provider works without any key (no Authorization sent)", async () => {
    setProviderOverrides({ localgw: local({ auth: { type: "none" } }) });
    const res = await completeSimpleWithAuth(resolveModel("localgw:fake-model"), ctx());
    expect(res.stopReason).not.toBe("error");
    expect(textOf(res)).toBe("OK");
    const req = server.requests.find((r) => r.path === "/v1/chat/completions")!;
    expect(req.headers.authorization).toBeUndefined();
  });

  it("sends the vault key + secret headers, applies compat (no store, max_tokens, system role)", async () => {
    setProviderOverrides({
      localgw: local({
        auth: { type: "bearer" },
        headers: { "X-Team": "polpo" },
        compat: { supportsStore: false, maxTokensField: "max_tokens", supportsDeveloperRole: false },
      }),
    });
    setProviderSecretsSource({ get: async (id) => (id === "localgw" ? { apiKey: "vault-key-123", headers: { "X-Secret": "s3cr3t" } } : undefined) });
    const res = await completeSimpleWithAuth(resolveModel("localgw:fake-model"), { systemPrompt: "be brief", ...ctx() }, { maxTokens: 50 } as never);
    expect(res.stopReason).not.toBe("error");
    const req = server.requests.find((r) => r.path === "/v1/chat/completions")!;
    expect(req.headers.authorization).toBe("Bearer vault-key-123");
    expect(req.headers["x-secret"]).toBe("s3cr3t");
    expect(req.headers["x-team"]).toBe("polpo");
    expect(req.body.store).toBeUndefined();
    expect(req.body.max_tokens).toBe(50);
    expect(req.body.max_completion_tokens).toBeUndefined();
    expect(req.body.messages[0].role).toBe("system");
  });

  it("default OpenAI compat sends store + max_completion_tokens (what strict proxies reject)", async () => {
    setProviderOverrides({ localgw: local({ auth: { type: "none" } }) });
    server.rejectFields.add("store");
    const res = await completeSimpleWithAuth(resolveModel("localgw:fake-model"), ctx(), { maxTokens: 10 } as never);
    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toMatch(/store/);
  });

  it("falls back to the env var when no key is in the vault", async () => {
    process.env.MY_GW_KEY = "env-key-456";
    setProviderOverrides({ localgw: local({ auth: { type: "x-api-key", envVar: "MY_GW_KEY" } }) });
    const res = await completeSimpleWithAuth(resolveModel("localgw:fake-model"), ctx());
    expect(res.stopReason).not.toBe("error");
    const req = server.requests.find((r) => r.path === "/v1/chat/completions")!;
    expect(req.headers["x-api-key"]).toBe("env-key-456");
    expect(req.headers.authorization).toBeUndefined();
  });

  it("fails with a clear message when a key is required but missing", async () => {
    setProviderOverrides({ localgw: local({ auth: { type: "bearer" } }) });
    const res = await completeSimpleWithAuth(resolveModel("localgw:fake-model"), ctx());
    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toMatch(/No API key for custom provider "localgw".*LOCALGW_API_KEY/);
    expect(server.requests).toHaveLength(0);
  });

  it("Anthropic-compatible endpoint: bearer auth, /v1/messages path", async () => {
    setProviderOverrides({ antgw: local({ api: "anthropic-messages", baseUrl: server.url, auth: { type: "bearer" } }) });
    setProviderSecretsSource({ get: async () => ({ apiKey: "ant-key-789", headers: {} }) });
    const res = await completeSimpleWithAuth(resolveModel("antgw:fake-model"), ctx());
    expect(res.stopReason).not.toBe("error");
    expect(textOf(res)).toBe("OK");
    const req = server.requests.find((r) => r.path === "/v1/messages")!;
    expect(req.headers.authorization).toBe("Bearer ant-key-789");
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  it("blocks private endpoints unless allowPrivateNetwork is set", async () => {
    setProviderOverrides({ localgw: local({ auth: { type: "none" }, allowPrivateNetwork: undefined }) });
    const res = await completeSimpleWithAuth(resolveModel("localgw:fake-model"), ctx());
    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toMatch(/private\/internal address/);
    expect(server.requests).toHaveLength(0);
  });

  it("legacy entries (baseUrl/api/models only) keep working keyless", async () => {
    const parsed = parseProviders({ ollama: { baseUrl: `${server.url}/v1`, api: "openai-completions", models: [{ id: "fake-model", name: "F" }], allowPrivateNetwork: true } });
    setProviderOverrides(parsed);
    const res = await completeSimpleWithAuth(resolveModel("ollama:fake-model"), ctx());
    expect(res.stopReason).not.toBe("error");
  });
});

describe("custom provider runtime (captured fetch)", () => {
  it("routes through the injected fetch with the expected URL and headers", async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    setCustomProviderFetchForTests((async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const sse = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hey" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);
    setProviderOverrides({
      cfgw: {
        preset: "cloudflare-ai-gateway",
        api: "openai-completions",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
        auth: { type: "header", headerName: "cf-aig-authorization", prefix: "Bearer " },
        models: [{ id: "openai/gpt-4o-mini", name: "mini" }],
      },
    });
    setProviderSecretsSource({ get: async () => ({ apiKey: "cf-token", headers: {} }) });
    const res = await completeSimpleWithAuth(resolveModel("cfgw:openai/gpt-4o-mini"), ctx());
    expect(textOf(res)).toBe("hey");
    expect(calls[0].url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions");
    expect(calls[0].headers.get("cf-aig-authorization")).toBe("Bearer cf-token");
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(calls[0].body.model).toBe("openai/gpt-4o-mini");
  });
});

describe("built-in Cloudflare AI Gateway (env)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("fills account/gateway placeholders and sends cf-aig-authorization", async () => {
    process.env.CLOUDFLARE_API_KEY = "cf-key";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    process.env.CLOUDFLARE_GATEWAY_ID = "gw456";
    const urls: string[] = [];
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", (async (input: any, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      headers.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const model = (getBuiltinModels("cloudflare-ai-gateway" as never) as any[]).find((m) => m.api === "openai-completions" || m.api === "anthropic-messages" || m.api === "openai-responses");
    expect(model).toBeTruthy();
    await completeSimpleWithAuth(model, ctx());
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain("/acct123/gw456/");
    expect(urls[0]).not.toContain("{CLOUDFLARE_");
    expect(headers[0].get("cf-aig-authorization")).toBe("Bearer cf-key");
    expect(headers[0].get("authorization")).toBeNull();
  });
});

describe("validation + catalog", () => {
  it("validateProviderKeys understands custom providers", () => {
    setProviderOverrides({
      keyless: local({ auth: { type: "none" } }),
      keyed: local({ auth: { type: "bearer" } }),
    });
    expect(validateProviderKeys(["keyless:fake-model", "keyed:fake-model"])).toEqual([{ provider: "keyed", modelSpec: "keyed:fake-model" }]);
    setCustomProviderSecretStatus("keyed", { hasKey: true, secretHeaderNames: [] });
    expect(hasProviderCredentials("keyed")).toBe(true);
    expect(validateProviderKeys(["keyed:fake-model"])).toEqual([]);
  });

  it("listModels includes custom models flagged custom/configured", () => {
    setProviderOverrides({ keyless: local({ auth: { type: "none" }, models: [{ id: "a", name: "A", contextWindow: 4096 }] }) });
    const models = listModels().filter((m) => m.custom);
    expect(models).toEqual([expect.objectContaining({ id: "a", provider: "keyless", custom: true, configured: true, contextWindow: 4096 })]);
    expect(listModels("keyless")).toHaveLength(1);
  });

  it("resolveModel applies metadata + compat for custom providers", () => {
    setProviderOverrides({ gw: local({ compat: { supportsStore: false, bogus: 1 } as any, models: [{ id: "m", name: "M", reasoning: true, input: ["text", "image"], compat: { maxTokensField: "max_tokens" } }] }) });
    const m = resolveModel("gw:m") as any;
    expect(m.provider).toBe("gw");
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text", "image"]);
    // Ad-hoc ids still resolve (provider exists, model not pre-defined)
    expect(resolveModel("gw:other").id).toBe("other");
  });

  it("proxy providers reuse the built-in catalog metadata", () => {
    setProviderOverrides({ "ant-proxy": { preset: "proxy", proxyFor: "anthropic", api: "anthropic-messages", baseUrl: "https://proxy.example.com", auth: { type: "x-api-key", envVar: "ANTHROPIC_API_KEY" } } });
    const first = (getBuiltinModels("anthropic" as never) as any[])[0];
    const m = resolveModel(`ant-proxy:${first.id}`);
    expect(m.contextWindow).toBe(first.contextWindow);
    expect(m.baseUrl).toBe("https://proxy.example.com");
    expect(m.provider).toBe("ant-proxy");
  });
});
