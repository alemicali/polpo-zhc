import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { VaultEntry } from "../core/types.js";
import type { VaultStore } from "../core/vault-store.js";
import { customProviderRoutes } from "../server/routes/custom-providers.js";
import { loadPolpoConfig, parseProviders, savePolpoSettings, mutatePolpoProviders, parseConfig } from "../core/config.js";
import { completeSimpleWithAuth, resolveModel, setProviderOverrides } from "../llm/pi-client.js";
import {
  refreshCustomProviderSecretStatus,
  resetCustomProvidersForTests,
  setProviderSecretsSource,
} from "../llm/custom-providers.js";
import { readProviderSecrets } from "../llm/provider-secrets.js";
import { sanitizeProviderError, suggestCompatFromError } from "../llm/custom-provider-probe.js";
import { startFakeLlmServer, type FakeLlmServer } from "./helpers/fake-llm-server.js";

class MemoryVault implements VaultStore {
  data = new Map<string, VaultEntry>();
  private k(a: string, s: string) { return `${a}\u0000${s}`; }
  async get(agent: string, service: string) { return this.data.get(this.k(agent, service)); }
  async getAllForAgent(agent: string) {
    const out: Record<string, VaultEntry> = {};
    for (const [k, v] of this.data) if (k.startsWith(`${agent}\u0000`)) out[k.split("\u0000")[1]] = v;
    return out;
  }
  async set(agent: string, service: string, entry: VaultEntry) { this.data.set(this.k(agent, service), structuredClone(entry)); }
  async patch(agent: string, service: string, partial: any) {
    const cur = this.data.get(this.k(agent, service)) ?? { type: partial.type ?? "custom", credentials: {} };
    const next = { ...cur, ...partial, credentials: { ...cur.credentials, ...(partial.credentials ?? {}) } };
    this.data.set(this.k(agent, service), next);
    return Object.keys(next.credentials);
  }
  async remove(agent: string, service: string) { return this.data.delete(this.k(agent, service)); }
  async list() { return []; }
  async hasEntries() { return this.data.size > 0; }
  async renameAgent() {}
  async removeAgent() {}
  async migrateFromConfigs() { return 0; }
}

let server: FakeLlmServer;
let dir: string;
let polpoDir: string;
let vault: MemoryVault;
let app: OpenAPIHono;

async function applyProviders() {
  const raw = loadPolpoConfig(polpoDir);
  setProviderOverrides(raw?.providers ? parseProviders(raw.providers as Record<string, unknown>) : {});
  await refreshCustomProviderSecretStatus();
}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/v1/providers/custom${path === "/" ? "" : path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as any, text: "" };
}

beforeAll(async () => {
  server = await startFakeLlmServer({ models: ["llama-3", "qwen-2"] });
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetCustomProvidersForTests();
  dir = mkdtempSync(join(tmpdir(), "polpo-custom-prov-"));
  polpoDir = join(dir, ".polpo");
  mkdirSync(polpoDir, { recursive: true });
  writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({
    project: "p",
    settings: { maxRetries: 3, workDir: ".", logLevel: "normal", orchestratorModel: "anthropic:claude-sonnet-4-5" },
    providers: { anthropic: { baseUrl: "https://corp-proxy.example.com" } },
  }, null, 2));
  vault = new MemoryVault();
  setProviderSecretsSource({ get: (id) => readProviderSecrets(vault, id) });
  app = new OpenAPIHono();
  app.route("/api/v1/providers/custom", customProviderRoutes(() => ({
    isInitialized: () => true,
    getPolpoDir: () => polpoDir,
    getVaultStore: () => vault,
    applyProviders,
    getModelUsage: async () => ["local-llm:llama-3"],
  })));
});

afterEach(() => {
  setProviderOverrides({});
  resetCustomProvidersForTests();
  rmSync(dir, { recursive: true, force: true });
});

const draft = () => ({
  label: "Local LLM",
  preset: "vllm",
  api: "openai-completions",
  baseUrl: `${server.url}/v1/chat/completions`,
  auth: { type: "bearer" },
  allowPrivateNetwork: true,
  compat: { supportsStore: false, maxTokensField: "max_tokens", notAFlag: true },
  models: [{ id: "llama-3", contextWindow: 32768 }],
});

describe("custom provider routes", () => {
  it("creates a provider: config in polpo.json without secrets, key in the vault, nothing secret in the response", async () => {
    const r = await call("POST", "/", { id: "local-llm", provider: draft(), secrets: { apiKey: "sk-local-0123456789abcdef", secretHeaders: { "X-Org-Token": "org-secret" } } });
    expect(r.status).toBe(201);
    const body = JSON.stringify(r.json);
    expect(body).not.toContain("sk-local-0123456789abcdef");
    expect(body).not.toContain("org-secret");
    expect(r.json.data).toMatchObject({ id: "local-llm", hasKey: true, keyHint: "cdef", secretHeaderNames: ["X-Org-Token"], configured: true, keySource: "vault" });
    // Base URL normalized, compat whitelisted
    expect(r.json.data.baseUrl).toBe(`${server.url}/v1`);
    expect(r.json.data.compat).toEqual({ supportsStore: false, maxTokensField: "max_tokens" });

    const file = readFileSync(join(polpoDir, "polpo.json"), "utf-8");
    expect(file).not.toContain("sk-local");
    expect(file).not.toContain("org-secret");
    const json = JSON.parse(file);
    expect(json.providers.anthropic).toEqual({ baseUrl: "https://corp-proxy.example.com" }); // untouched
    expect(json.providers["local-llm"].auth).toEqual({ type: "bearer" });

    const stored = await vault.get("$providers", "local-llm");
    expect(stored?.credentials).toEqual({ apiKey: "sk-local-0123456789abcdef", "header:X-Org-Token": "org-secret" });

    // Runtime picks it up immediately
    const res = await completeSimpleWithAuth(resolveModel("local-llm:llama-3"), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
    expect(res.stopReason).not.toBe("error");
    const req = server.requests.at(-1)!;
    expect(req.headers.authorization).toBe("Bearer sk-local-0123456789abcdef");
    expect(req.headers["x-org-token"]).toBe("org-secret");
  });

  it("rejects built-in ids, bad slugs, secret-looking static headers and private targets without the toggle", async () => {
    expect((await call("POST", "/", { id: "openai", provider: draft() })).status).toBe(400);
    expect((await call("POST", "/", { id: "Bad_Id", provider: draft() })).status).toBe(400);
    const secretHeader = await call("POST", "/", { id: "gw", provider: { ...draft(), headers: { Authorization: "Bearer x" } } });
    expect(secretHeader.status).toBe(400);
    expect(secretHeader.json.error).toMatch(/secret headers/);
    const priv = await call("POST", "/", { id: "gw", provider: { ...draft(), allowPrivateNetwork: false } });
    expect(priv.status).toBe(400);
    expect(priv.json.error).toMatch(/Allow private network/);
    const meta = await call("POST", "/", { id: "gw", provider: { ...draft(), baseUrl: "http://169.254.169.254/v1" } });
    expect(meta.status).toBe(400);
    const env = await call("POST", "/", { id: "gw", provider: { ...draft(), auth: { type: "bearer", envVar: "POLPO_VAULT_KEY" } } });
    expect(env.status).toBe(400);
  });

  it("updates keep the stored key unless replaced; empty string removes it", async () => {
    await call("POST", "/", { id: "local-llm", provider: draft(), secrets: { apiKey: "first-key-abcdefghijkl" } });
    const upd = await call("PUT", "/local-llm", { provider: { ...draft(), label: "Renamed" } });
    expect(upd.status).toBe(200);
    expect(upd.json.data).toMatchObject({ label: "Renamed", hasKey: true });
    const cleared = await call("PUT", "/local-llm", { provider: draft(), secrets: { apiKey: "" } });
    expect(cleared.json.data.hasKey).toBe(false);
    expect(cleared.json.data.warnings.join(" ")).toMatch(/LOCAL_LLM_API_KEY/);
    expect(await vault.get("$providers", "local-llm")).toBeUndefined();
  });

  it("tests a draft connection and suggests compat flags for strict proxies", async () => {
    server.rejectFields.add("store");
    const { compat: _c, ...noCompat } = draft();
    const r = await call("POST", "/test", { provider: { ...noCompat, auth: { type: "none" } } });
    expect(r.status).toBe(200);
    expect(r.json.data.ok).toBe(true);
    expect(r.json.data.suggestedCompat).toMatchObject({ supportsStore: false });
    expect(typeof r.json.data.latencyMs).toBe("number");
  });

  it("test reports sanitized errors and hints", async () => {
    server.next.set("/v1/chat/completions", { status: 401, body: JSON.stringify({ error: { message: "Invalid API key: sk-live-SECRETSECRET123" } }) });
    const r = await call("POST", "/test", { provider: draft(), secrets: { apiKey: "sk-live-SECRETSECRET123" } });
    expect(r.json.data.ok).toBe(false);
    expect(JSON.stringify(r.json)).not.toContain("SECRETSECRET123");
    expect(r.json.data.hints.join(" ")).toMatch(/Authentication failed/);
  });

  it("discovers models (OpenAI /models, LiteLLM /model/info, Ollama /api/tags)", async () => {
    const openai = await call("POST", "/discover", { provider: { ...draft(), auth: { type: "none" } } });
    expect(openai.json.data.models.map((m: any) => m.id)).toEqual(["llama-3", "qwen-2"]);
    expect(openai.json.data.models[0]).toMatchObject({ contextWindow: 32768 });
    const litellm = await call("POST", "/discover", { provider: { ...draft(), preset: "litellm", auth: { type: "none" } } });
    expect(litellm.json.data.models[0]).toMatchObject({ id: "llama-3", contextWindow: 65536, maxTokens: 4096, input: ["text", "image"], cost: { input: 1, output: 2 } });
    const ollama = await call("POST", "/discover", { provider: { ...draft(), preset: "ollama", auth: { type: "none" } } });
    expect(ollama.json.data.models.map((m: any) => m.id)).toEqual(["llama-3", "qwen-2"]);
    expect(server.requests.some((r) => r.path === "/api/tags")).toBe(true);
  });

  it("saved-provider discovery uses stored secrets; drafts never borrow another provider's key", async () => {
    await call("POST", "/", { id: "local-llm", provider: draft(), secrets: { apiKey: "stored-key-0123456789" } });
    server.requests.length = 0;
    await call("POST", "/local-llm/discover", {});
    expect(server.requests[0].headers.authorization).toBe("Bearer stored-key-0123456789");
    server.requests.length = 0;
    await call("POST", "/discover", { provider: draft() });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("deletes provider + vault entry and warns about references", async () => {
    await call("POST", "/", { id: "local-llm", provider: draft(), secrets: { apiKey: "k-0123456789abcdef" } });
    const del = await call("DELETE", "/local-llm");
    expect(del.status).toBe(200);
    expect(del.json.data.warnings[0]).toMatch(/local-llm:llama-3/);
    expect(await vault.get("$providers", "local-llm")).toBeUndefined();
    const json = JSON.parse(readFileSync(join(polpoDir, "polpo.json"), "utf-8"));
    expect(json.providers["local-llm"]).toBeUndefined();
    expect(json.providers.anthropic).toBeDefined();
    expect((await call("GET", "/local-llm")).status).toBe(404);
  });
});

describe("config round-trip", () => {
  it("parseProviders keeps custom provider fields and drops junk", () => {
    const parsed = parseProviders({
      gw: {
        label: "GW", preset: "litellm", api: "openai-completions", baseUrl: "https://gw.example.com/v1",
        auth: { type: "header", headerName: "api-key", envVar: "GW_API_KEY" },
        headers: { "X-Team": "a" }, compat: { supportsStore: false, evil: "x" },
        allowPrivateNetwork: true, timeoutMs: 60000, maxRetries: 1, apiKey: "should-be-dropped",
        models: [{ id: "m1", name: "M1", compat: { maxTokensField: "max_tokens" } }, { nope: true }],
      },
      __proto__: { baseUrl: "x" },
    } as any);
    expect(parsed.gw).toEqual({
      label: "GW", preset: "litellm", api: "openai-completions", baseUrl: "https://gw.example.com/v1",
      auth: { type: "header", headerName: "api-key", envVar: "GW_API_KEY" },
      headers: { "X-Team": "a" }, compat: { supportsStore: false },
      allowPrivateNetwork: true, timeoutMs: 60000, maxRetries: 1,
      models: [{ id: "m1", name: "M1", compat: { maxTokensField: "max_tokens" } }],
    });
  });

  it("parseConfig round-trips providers from disk", async () => {
    mutatePolpoProviders(polpoDir, (p) => { p.gw = { preset: "ollama", api: "openai-completions", baseUrl: "http://localhost:11434/v1", auth: { type: "none" }, allowPrivateNetwork: true, models: [{ id: "llama3", name: "llama3" }] }; });
    const cfg = await parseConfig(dir);
    expect(cfg.providers?.gw).toMatchObject({ preset: "ollama", auth: { type: "none" }, allowPrivateNetwork: true });
    expect(cfg.providers?.anthropic).toEqual({ baseUrl: "https://corp-proxy.example.com" });
  });

  it("savePolpoSettings (PATCH /config/settings) does not erase provider fields or write env-only values", () => {
    mutatePolpoProviders(polpoDir, (p) => { p.gw = { preset: "litellm", baseUrl: "https://gw.example.com/v1", auth: { type: "bearer" }, headers: { "X-A": "1" } }; });
    const before = JSON.parse(readFileSync(join(polpoDir, "polpo.json"), "utf-8"));
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:pass@db/x";
    try {
      savePolpoSettings(polpoDir, { ...before.settings, reasoning: "high", databaseUrl: "postgres://user:pass@db/x" });
    } finally {
      if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
    }
    const after = JSON.parse(readFileSync(join(polpoDir, "polpo.json"), "utf-8"));
    expect(after.providers).toEqual(before.providers);
    expect(after.settings.reasoning).toBe("high");
    expect(after.settings.databaseUrl).toBeUndefined();
  });
});

describe("probe helpers", () => {
  it("sanitizes keys out of error messages", () => {
    const msg = sanitizeProviderError('401 {"error":"bad key sk-abcdef1234567890"} Authorization: Bearer abcdefghijkl', ["mysecretvalue"]);
    expect(msg).not.toMatch(/abcdef1234567890|abcdefghijkl/);
    expect(sanitizeProviderError("x mysecretvalue y", ["mysecretvalue"])).toBe("x *** y");
  });
  it("maps proxy rejections to compat flags", () => {
    expect(suggestCompatFromError("openai-completions", "400 Unrecognized request argument supplied: store")).toEqual([
      expect.objectContaining({ flag: "supportsStore", value: false }),
    ]);
    expect(suggestCompatFromError("openai-completions", "max_completion_tokens is not supported").map((s) => s.flag)).toEqual(["maxTokensField"]);
  });
});
