import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { safeEnv, bashSafeEnv, mcpSafeEnv } from "../tools/safe-env.js";

describe("safeEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set test env vars
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/test";
    process.env.USER = "test";
    process.env.SHELL = "/bin/bash";
    process.env.NODE_ENV = "test";
    // Simulate secrets
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-key";
    process.env.OPENAI_API_KEY = "sk-openai-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.DATABASE_URL = "postgres://user:pass@host/db";
    process.env.GITHUB_TOKEN = "ghp_token123";
    process.env.POLPO_SECRET = "internal-secret";
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it("includes system-essential vars", () => {
    const env = safeEnv();
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.USER).toBe("test");
    expect(env.SHELL).toBe("/bin/bash");
    expect(env.NODE_ENV).toBe("test");
  });

  it("excludes API keys and secrets", () => {
    const env = safeEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.POLPO_SECRET).toBeUndefined();
  });

  it("includes explicitly allowed vars via allowVars", () => {
    const env = safeEnv(undefined, ["GITHUB_TOKEN"]);
    expect(env.GITHUB_TOKEN).toBe("ghp_token123");
    // Others still excluded
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("applies extra overrides", () => {
    const env = safeEnv({ MY_CUSTOM: "value", PATH: "/custom/path" });
    expect(env.MY_CUSTOM).toBe("value");
    expect(env.PATH).toBe("/custom/path"); // extra overrides system
  });

  it("extra vars override allowVars from process.env", () => {
    const env = safeEnv({ GITHUB_TOKEN: "override" }, ["GITHUB_TOKEN"]);
    expect(env.GITHUB_TOKEN).toBe("override");
  });

  it("skips undefined system vars gracefully", () => {
    delete process.env.TMPDIR;
    delete process.env.TZ;
    const env = safeEnv();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.TZ).toBeUndefined();
  });
});

describe("bashSafeEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PATH = "/usr/bin";
    process.env.ANTHROPIC_API_KEY = "secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns safe env without secrets", () => {
    const env = bashSafeEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("mcpSafeEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PATH = "/usr/bin";
    process.env.ANTHROPIC_API_KEY = "secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns safe env with MCP config overrides", () => {
    const env = mcpSafeEnv({ MY_MCP_TOKEN: "tok123" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.MY_MCP_TOKEN).toBe("tok123");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("returns safe env without config overrides", () => {
    const env = mcpSafeEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
