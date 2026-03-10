import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ── env-persistence ────────────────────────────────────────────────

describe("env-persistence", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `polpo-test-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("creates directory and .env file if they don't exist", async () => {
    const { persistToEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");

    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "sk-test123");

    expect(existsSync(join(polpoDir, ".env"))).toBe(true);
    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toBe("OPENAI_API_KEY=sk-test123\n");
  });

  it("upserts existing env var without duplicating", async () => {
    const { persistToEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=old-key\nOTHER=keep\n");

    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "new-key");

    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toContain("OPENAI_API_KEY=new-key");
    expect(content).toContain("OTHER=keep");
    // Must not duplicate
    expect(content.match(/OPENAI_API_KEY/g)?.length).toBe(1);
  });

  it("appends new env var to existing file", async () => {
    const { persistToEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), "EXISTING=value\n");

    persistToEnvFile(polpoDir, "NEW_KEY", "new-value");

    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toContain("EXISTING=value");
    expect(content).toContain("NEW_KEY=new-value");
  });

  it("removeFromEnvFile removes a key", async () => {
    const { persistToEnvFile, removeFromEnvFile } = await import("../setup/env-persistence.js");
    const polpoDir = join(testDir, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), "KEEP=yes\nREMOVE_ME=secret\nALSO_KEEP=yes\n");

    removeFromEnvFile(polpoDir, "REMOVE_ME");

    const content = readFileSync(join(polpoDir, ".env"), "utf-8");
    expect(content).toContain("KEEP=yes");
    expect(content).toContain("ALSO_KEEP=yes");
    expect(content).not.toContain("REMOVE_ME");
  });

  it("removeFromEnvFile is a no-op if file doesn't exist", async () => {
    const { removeFromEnvFile } = await import("../setup/env-persistence.js");
    // Should not throw
    removeFromEnvFile(join(testDir, "nonexistent"), "FOO");
  });
});

// ── providers ──────────────────────────────────────────────────────

// ── detectProviders ────────────────────────────────────────────────

describe("detectProviders", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
  });

  it("detects provider from env var", async () => {
    const { detectProviders } = await import("../setup/providers.js");
    process.env.GROQ_API_KEY = "test-groq-key";

    const providers = detectProviders();
    const groq = providers.find((p) => p.name === "groq");

    expect(groq).toBeDefined();
    expect(groq!.hasKey).toBe(true);
    expect(groq!.source).toBe("env");
    expect(groq!.envVar).toBe("GROQ_API_KEY");
  });

  it("marks providers without keys as source: none", async () => {
    const { detectProviders } = await import("../setup/providers.js");
    delete process.env.CEREBRAS_API_KEY;

    const providers = detectProviders();
    const cerebras = providers.find((p) => p.name === "cerebras");

    expect(cerebras).toBeDefined();
    expect(cerebras!.hasKey).toBe(false);
    expect(cerebras!.source).toBe("none");
  });

  it("returns all catalog providers without deduplication", async () => {
    const { detectProviders } = await import("../setup/providers.js");

    const providers = detectProviders();
    const names = providers.map((p) => p.name);

    // Both openai and openai-codex should appear (no deduplication)
    expect(names).toContain("openai");
    expect(names).toContain("openai-codex");

    // All google variants should appear
    expect(names).toContain("google");
    expect(names).toContain("google-gemini-cli");
    expect(names).toContain("google-antigravity");

    // Standard providers
    expect(names).toContain("anthropic");
    expect(names).toContain("groq");
    expect(names).toContain("mistral");
  });
});

// ── hasOAuthProfilesForProvider (exact match) ─────────────────────

describe("hasOAuthProfilesForProvider", () => {
  it("matches profiles by exact provider name", async () => {
    vi.spyOn(await import("../auth/store.js"), "getAllProfiles").mockReturnValue([
      {
        id: "openai-codex:test-123",
        profile: {
          provider: "openai-codex",
          type: "oauth",
          access: "fake-token",
          refresh: "fake-refresh",
          expires: Date.now() + 86400000,
          createdAt: new Date().toISOString(),
          lastUsed: new Date().toISOString(),
        } as any,
      },
    ]);

    const { hasOAuthProfilesForProvider } = await import("../setup/providers.js");
    // Exact match works
    expect(hasOAuthProfilesForProvider("openai-codex")).toBe(true);
    // Different provider name does NOT match (no cross-mapping)
    expect(hasOAuthProfilesForProvider("openai")).toBe(false);
    expect(hasOAuthProfilesForProvider("anthropic")).toBe(false);

    vi.restoreAllMocks();
  });

  it("returns false when no profiles exist", async () => {
    vi.spyOn(await import("../auth/store.js"), "getAllProfiles").mockReturnValue([]);

    const { hasOAuthProfilesForProvider } = await import("../setup/providers.js");
    expect(hasOAuthProfilesForProvider("openai-codex")).toBe(false);
    expect(hasOAuthProfilesForProvider("anthropic")).toBe(false);

    vi.restoreAllMocks();
  });
});

// ── detectProviders with OAuth profiles ────────────────────────────

describe("detectProviders with OAuth", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
    vi.restoreAllMocks();
  });

  it("detects openai-codex directly from OAuth profile", async () => {
    delete process.env.OPENAI_API_KEY;

    vi.spyOn(await import("../auth/store.js"), "getAllProfiles").mockReturnValue([
      {
        id: "openai-codex:acct-123",
        profile: {
          provider: "openai-codex",
          type: "oauth",
          access: "fake",
          refresh: "fake",
          expires: Date.now() + 86400000,
          createdAt: new Date().toISOString(),
          lastUsed: new Date().toISOString(),
        } as any,
      },
    ]);

    const { detectProviders } = await import("../setup/providers.js");
    const providers = detectProviders();

    // openai-codex detected directly via its own OAuth profile
    const codex = providers.find((p) => p.name === "openai-codex");
    expect(codex).toBeDefined();
    expect(codex!.hasKey).toBe(true);
    expect(codex!.source).toBe("oauth");

    // openai (different provider) should NOT have credentials from openai-codex profile
    const openai = providers.find((p) => p.name === "openai");
    expect(openai).toBeDefined();
    expect(openai!.hasKey).toBe(false);
  });

  it("detects google-gemini-cli directly from OAuth profile", async () => {
    delete process.env.GEMINI_API_KEY;

    vi.spyOn(await import("../auth/store.js"), "getAllProfiles").mockReturnValue([
      {
        id: "google-gemini-cli:test@gmail.com",
        profile: {
          provider: "google-gemini-cli",
          type: "oauth",
          access: "ya29.fake",
          refresh: "1//fake",
          expires: Date.now() + 86400000,
          email: "test@gmail.com",
          createdAt: new Date().toISOString(),
          lastUsed: new Date().toISOString(),
        } as any,
      },
    ]);

    const { detectProviders } = await import("../setup/providers.js");
    const providers = detectProviders();

    // google-gemini-cli detected directly
    const geminiCli = providers.find((p) => p.name === "google-gemini-cli");
    expect(geminiCli).toBeDefined();
    expect(geminiCli!.hasKey).toBe(true);
    expect(geminiCli!.source).toBe("oauth");

    // google (different provider) should NOT have credentials from google-gemini-cli profile
    const google = providers.find((p) => p.name === "google");
    expect(google).toBeDefined();
    expect(google!.hasKey).toBe(false);
  });

  it("env source takes priority over oauth", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    vi.spyOn(await import("../auth/store.js"), "getAllProfiles").mockReturnValue([
      {
        id: "anthropic:default",
        profile: {
          provider: "anthropic",
          type: "oauth",
          access: "fake",
          refresh: "fake",
          expires: Date.now() + 86400000,
          createdAt: new Date().toISOString(),
          lastUsed: new Date().toISOString(),
        } as any,
      },
    ]);

    const { detectProviders } = await import("../setup/providers.js");
    const providers = detectProviders();
    const anthropic = providers.find((p) => p.name === "anthropic");

    expect(anthropic).toBeDefined();
    expect(anthropic!.hasKey).toBe(true);
    expect(anthropic!.source).toBe("env"); // env takes priority
  });
});

// ── auth-options ───────────────────────────────────────────────────

describe("auth-options", () => {
  it("getAuthOptions returns all OAuth providers + manual option", async () => {
    const { getAuthOptions } = await import("../setup/auth-options.js");
    const options = getAuthOptions();

    expect(options.length).toBeGreaterThan(0);

    // Should have OAuth options
    const oauthOptions = options.filter((o) => o.type === "oauth");
    expect(oauthOptions.length).toBeGreaterThanOrEqual(5);

    // Should have manual API key option
    const manualOption = options.find((o) => o.type === "api_key");
    expect(manualOption).toBeDefined();
  });

  it("free providers are correctly classified", async () => {
    const { getAuthOptions, FREE_OAUTH_PROVIDERS } = await import("../setup/auth-options.js");
    const options = getAuthOptions();

    for (const opt of options) {
      if (opt.type === "oauth" && opt.oauthId) {
        if (FREE_OAUTH_PROVIDERS.has(opt.oauthId)) {
          expect(opt.free).toBe(true);
        } else {
          expect(opt.free).toBe(false);
        }
      }
    }
  });

  it("google-antigravity and google-gemini-cli are free", async () => {
    const { FREE_OAUTH_PROVIDERS } = await import("../setup/auth-options.js");
    expect(FREE_OAUTH_PROVIDERS.has("google-antigravity")).toBe(true);
    expect(FREE_OAUTH_PROVIDERS.has("google-gemini-cli")).toBe(true);
  });

  it("anthropic and openai-codex are not free", async () => {
    const { FREE_OAUTH_PROVIDERS } = await import("../setup/auth-options.js");
    expect(FREE_OAUTH_PROVIDERS.has("anthropic" as any)).toBe(false);
    expect(FREE_OAUTH_PROVIDERS.has("openai-codex" as any)).toBe(false);
  });
});

// ── oauth-flow ─────────────────────────────────────────────────────

describe("oauth-flow", () => {
  it("findOAuthProvider returns provider definition for valid IDs", async () => {
    const { findOAuthProvider } = await import("../setup/oauth-flow.js");

    expect(findOAuthProvider("anthropic")).toBeDefined();
    expect(findOAuthProvider("anthropic")!.name).toContain("Anthropic");

    expect(findOAuthProvider("openai-codex")).toBeDefined();
    expect(findOAuthProvider("google-gemini-cli")).toBeDefined();
    expect(findOAuthProvider("github-copilot")).toBeDefined();
  });

  it("findOAuthProvider returns undefined for unknown IDs", async () => {
    const { findOAuthProvider } = await import("../setup/oauth-flow.js");

    expect(findOAuthProvider("not-a-provider")).toBeUndefined();
    expect(findOAuthProvider("openai")).toBeUndefined(); // "openai" is not an OAuth ID
  });

  it("getOAuthProviderList returns all providers with free classification", async () => {
    const { getOAuthProviderList } = await import("../setup/oauth-flow.js");
    const list = getOAuthProviderList();

    expect(list.length).toBeGreaterThanOrEqual(4);

    for (const p of list) {
      expect(p).toHaveProperty("id");
      expect(p).toHaveProperty("name");
      expect(p).toHaveProperty("flow");
      expect(p).toHaveProperty("free");
      expect(typeof p.free).toBe("boolean");
    }

    const freeOnes = list.filter((p) => p.free);
    expect(freeOnes.length).toBeGreaterThanOrEqual(2);
  });

  it("startOAuthLogin rejects unknown provider", async () => {
    const { startOAuthLogin } = await import("../setup/oauth-flow.js");

    await expect(
      startOAuthLogin("totally-fake-provider", {
        onAuthUrl: () => {},
        onPrompt: async () => "",
        onProgress: () => {},
      })
    ).rejects.toThrow("Unknown OAuth provider");
  });
});

// ── models ─────────────────────────────────────────────────────────

describe("models", () => {
  it("formatCost returns 'free' for 0", async () => {
    const { formatCost } = await import("../setup/models.js");
    expect(formatCost(0)).toBe("free");
  });

  it("formatCost formats sub-dollar costs with 2 decimals", async () => {
    const { formatCost } = await import("../setup/models.js");
    expect(formatCost(0.25)).toBe("$0.25/M");
    expect(formatCost(0.5)).toBe("$0.50/M");
  });

  it("formatCost formats dollar+ costs as integers", async () => {
    const { formatCost } = await import("../setup/models.js");
    expect(formatCost(3)).toBe("$3/M");
    expect(formatCost(15)).toBe("$15/M");
  });

  it("modelLabel returns structured data without formatting", async () => {
    const { modelLabel } = await import("../setup/models.js");

    const result = modelLabel({
      name: "test-model",
      id: "test-model",
      provider: "test",
      reasoning: true,
      cost: { input: 3, output: 15 },
    } as any);

    expect(result.name).toBe("test-model");
    expect(result.tags).toContain("reasoning");
    expect(result.costStr).toContain("$3/M");
    expect(result.costStr).toContain("$15/M");
  });

  it("modelLabel marks free models", async () => {
    const { modelLabel } = await import("../setup/models.js");

    const result = modelLabel({
      name: "free-model",
      id: "free-model",
      provider: "test",
      reasoning: false,
      cost: { input: 0, output: 0 },
    } as any);

    expect(result.tags).toContain("free");
    expect(result.costStr).toBe("");
  });

  it("getProviderModels returns sorted models", async () => {
    const { getProviderModels } = await import("../setup/models.js");

    const models = getProviderModels("anthropic");
    if (models.length >= 2) {
      for (let i = 1; i < models.length; i++) {
        expect(models[i].cost.input).toBeGreaterThanOrEqual(models[i - 1].cost.input);
      }
    }
  });
});

// ── Integration: CLI and server use the same detectProviders ───────

describe("integration: shared module consistency", () => {
  it("setup/index.ts re-exports all expected symbols", async () => {
    const setup = await import("../setup/index.js");

    // Providers
    expect(typeof setup.detectProviders).toBe("function");
    expect(typeof setup.hasOAuthProfilesForProvider).toBe("function");

    // Env persistence
    expect(typeof setup.persistToEnvFile).toBe("function");
    expect(typeof setup.removeFromEnvFile).toBe("function");

    // Auth options
    expect(typeof setup.getAuthOptions).toBe("function");
    expect(setup.FREE_OAUTH_PROVIDERS).toBeDefined();

    // OAuth flow
    expect(typeof setup.findOAuthProvider).toBe("function");
    expect(typeof setup.getOAuthProviderList).toBe("function");
    expect(typeof setup.startOAuthLogin).toBe("function");

    // Models
    expect(typeof setup.getProviderModels).toBe("function");
    expect(typeof setup.formatCost).toBe("function");
    expect(typeof setup.modelLabel).toBe("function");
  });

  it("detectProviders returns consistent shape regardless of caller", async () => {
    const { detectProviders } = await import("../setup/index.js");
    const providers = detectProviders();

    for (const p of providers) {
      // Every provider must have all required fields
      expect(typeof p.name).toBe("string");
      expect(p.envVar === undefined || typeof p.envVar === "string").toBe(true);
      expect(typeof p.hasKey).toBe("boolean");
      expect(["env", "oauth", "none"]).toContain(p.source);
    }
  });
});
