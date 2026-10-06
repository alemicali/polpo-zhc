import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { InMemoryTaskStore, InMemoryRunStore, InMemoryTaskControlStore, createTestAgent } from "./fixtures.js";
import { getModelAllowlist, getProviderOverrides, isModelAllowed, setModelAllowlist, setProviderOverrides } from "../llm/pi-client.js";
import { isCustomProvider, resetCustomProvidersForTests } from "../llm/custom-providers.js";

describe("Orchestrator.reloadConfig — providers and allowlist", () => {
  let dir: string;
  let orchestrator: Orchestrator;
  const write = (cfg: object) => writeFileSync(join(dir, ".polpo", "polpo.json"), JSON.stringify(cfg, null, 2));
  const base = { project: "p", settings: { maxRetries: 1, workDir: ".", logLevel: "quiet", storage: "file" } };

  beforeEach(async () => {
    resetCustomProvidersForTests();
    dir = mkdtempSync(join(tmpdir(), "polpo-reload-"));
    mkdirSync(join(dir, ".polpo"), { recursive: true });
    write(base);
    orchestrator = new Orchestrator({
      workDir: dir,
      store: new InMemoryTaskStore(),
      runStore: new InMemoryRunStore(),
      taskControlStore: new InMemoryTaskControlStore(),
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await orchestrator.initInteractive("p", { name: "t", agents: [createTestAgent({ name: "a" })] });
  });

  afterEach(async () => {
    await orchestrator.gracefulStop?.(0).catch(() => undefined);
    setProviderOverrides({});
    setModelAllowlist(undefined);
    resetCustomProvidersForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers parsed custom providers, then clears removed providers and the allowlist", async () => {
    write({
      ...base,
      settings: { ...base.settings, modelAllowlist: { "gw:m1": {} } },
      providers: {
        gw: { preset: "litellm", api: "openai-completions", baseUrl: "https://gw.example.com/v1", auth: { type: "bearer" }, unknownField: 1, models: [{ id: "m1", name: "M1" }] },
      },
    });
    expect(await orchestrator.reloadConfig()).toBe(true);
    expect(isCustomProvider("gw")).toBe(true);
    expect(getProviderOverrides().gw).toMatchObject({ preset: "litellm", auth: { type: "bearer" } });
    expect((getProviderOverrides().gw as Record<string, unknown>).unknownField).toBeUndefined();
    expect(orchestrator.getConfig()?.providers?.gw?.preset).toBe("litellm");
    expect(isModelAllowed("anthropic:claude-sonnet-4-5")).toBe(false);

    write(base);
    expect(await orchestrator.reloadConfig()).toBe(true);
    expect(isCustomProvider("gw")).toBe(false);
    expect(getProviderOverrides()).toEqual({});
    expect(orchestrator.getConfig()?.providers).toBeUndefined();
    expect(getModelAllowlist()).toBeUndefined();
    expect(isModelAllowed("anthropic:claude-sonnet-4-5")).toBe(true);
  });
});

describe("Orchestrator.init — vault-only custom provider keys", () => {
  it("does not report a vault-backed custom provider as missing at startup", async () => {
    resetCustomProvidersForTests();
    const prevKey = process.env.POLPO_VAULT_KEY;
    const prevModel = process.env.POLPO_MODEL;
    process.env.POLPO_VAULT_KEY = "11".repeat(32);
    process.env.POLPO_MODEL = "vaultgw:m1";
    const dir = mkdtempSync(join(tmpdir(), "polpo-init-"));
    const polpoDir = join(dir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({
      project: "p",
      settings: { maxRetries: 1, workDir: ".", logLevel: "quiet", storage: "file" },
      providers: { vaultgw: { preset: "litellm", api: "openai-completions", baseUrl: "https://gw.example.com/v1", auth: { type: "bearer" }, models: [{ id: "m1", name: "m1" }] } },
    }));
    const { EncryptedVaultStore } = await import("../vault/encrypted-store.js");
    await new EncryptedVaultStore(polpoDir).set("$providers", "vaultgw", { type: "api_key", credentials: { apiKey: "vault-only-key-0123" } });
    const orchestrator = new Orchestrator({
      workDir: dir,
      store: new InMemoryTaskStore(),
      runStore: new InMemoryRunStore(),
      taskControlStore: new InMemoryTaskControlStore(),
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    const logs: string[] = [];
    orchestrator.on("log", (e: { message: string }) => logs.push(e.message));
    try {
      await orchestrator.init();
      expect(logs.some((m) => /Missing API keys/.test(m) && m.includes("vaultgw"))).toBe(false);
    } finally {
      await orchestrator.gracefulStop?.(0).catch(() => undefined);
      setProviderOverrides({});
      resetCustomProvidersForTests();
      if (prevKey === undefined) delete process.env.POLPO_VAULT_KEY; else process.env.POLPO_VAULT_KEY = prevKey;
      if (prevModel === undefined) delete process.env.POLPO_MODEL; else process.env.POLPO_MODEL = prevModel;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
