/**
 * Security: .polpo/.env writes must not allow line injection or regex
 * replacement-pattern expansion, and API-key routes must not let the client
 * pick the target directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistToEnvFile, removeFromEnvFile, moveEnvEntries, takeApiWrittenEnvKeys,
} from "../setup/env-persistence.js";
import { providerRoutes } from "../server/routes/providers.js";

let tmp: string;
let polpoDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "polpo-env-sec-"));
  polpoDir = join(tmp, ".polpo");
  mkdirSync(polpoDir, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const envFile = () => readFileSync(join(polpoDir, ".env"), "utf-8");

describe("persistToEnvFile", () => {
  it.each(["sk-1\nEVIL=1", "sk-1\rEVIL=1", "sk-1\u0000", "a\u001bb"])("rejects control characters (%j)", (value) => {
    expect(() => persistToEnvFile(polpoDir, "OPENAI_API_KEY", value)).toThrow(/control characters/);
    expect(existsSync(join(polpoDir, ".env"))).toBe(false);
  });

  it.each(["BAD-NAME", "1ABC", "A B", "A=B", "A\nB", ""])("rejects invalid key %j", (key) => {
    expect(() => persistToEnvFile(polpoDir, key, "v")).toThrow(/Invalid environment variable name/);
  });

  it("writes $-patterns literally on update (no String.replace expansion)", () => {
    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "old");
    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "a$&b$1c$$d$'e$`f");
    expect(envFile()).toBe("OPENAI_API_KEY=a$&b$1c$$d$'e$`f\n");
  });

  it("upserts without touching other lines and dedupes the key", () => {
    writeFileSync(join(polpoDir, ".env"), "# comment\nFOO=1\nOPENAI_API_KEY=a\nBAR=2\nOPENAI_API_KEY=b\n");
    persistToEnvFile(polpoDir, "OPENAI_API_KEY", "new");
    expect(envFile()).toBe("# comment\nFOO=1\nOPENAI_API_KEY=new\nBAR=2\n");
    persistToEnvFile(polpoDir, "NEW_KEY", "x");
    expect(envFile()).toBe("# comment\nFOO=1\nOPENAI_API_KEY=new\nBAR=2\nNEW_KEY=x\n");
  });

  it("does not treat the key as a regex", () => {
    writeFileSync(join(polpoDir, ".env"), "AXB=keep\n");
    persistToEnvFile(polpoDir, "A_B", "v");
    removeFromEnvFile(polpoDir, "A.B");
    expect(envFile()).toBe("AXB=keep\nA_B=v\n");
  });

  it("removeFromEnvFile removes only the exact key", () => {
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=a\nOPENAI_API_KEY_2=b\n");
    removeFromEnvFile(polpoDir, "OPENAI_API_KEY");
    expect(envFile()).toBe("OPENAI_API_KEY_2=b\n");
  });

  it("moveEnvEntries moves only the requested keys and removes them from the source", () => {
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=sk-1\nOTHER=x\n");
    const dest = join(tmp, "other", ".polpo");
    expect(moveEnvEntries(polpoDir, dest, [{ key: "OPENAI_API_KEY", previous: undefined }])).toEqual(["OPENAI_API_KEY"]);
    expect(readFileSync(join(dest, ".env"), "utf-8")).toBe("OPENAI_API_KEY=sk-1\n");
    expect(envFile()).toBe("OTHER=x\n");
  });
});

describe("provider API-key routes", () => {
  const ENV = "OPENAI_API_KEY";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("ignores body workDir and always writes the server's project .env", async () => {
    const app = providerRoutes(polpoDir);
    const attackerDir = join(tmp, "attacker");
    mkdirSync(attackerDir, { recursive: true });
    const res = await app.request("/openai/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-123", workDir: attackerDir }),
    });
    expect(res.status).toBe(200);
    expect(envFile()).toContain("OPENAI_API_KEY=sk-test-123");
    expect(existsSync(join(attackerDir, ".polpo", ".env"))).toBe(false);
    // Recorded (with "did not exist before") so setup can move exactly this key.
    expect(takeApiWrittenEnvKeys(polpoDir)).toEqual([{ key: "OPENAI_API_KEY", previous: undefined }]);
  });

  it("setup flow: a key saved via the API is moved (not copied) to the initialized project", async () => {
    writeFileSync(join(polpoDir, ".env"), "PRE_EXISTING=keep\n");
    const app = providerRoutes(polpoDir);
    await app.request("/openai/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-setup-1" }),
    });
    const target = join(tmp, "chosen", ".polpo");
    moveEnvEntries(polpoDir, target, takeApiWrittenEnvKeys(polpoDir));
    expect(readFileSync(join(target, ".env"), "utf-8")).toBe("OPENAI_API_KEY=sk-setup-1\n");
    expect(envFile()).toBe("PRE_EXISTING=keep\n");
  });

  it("setup flow: a key that already existed in the starting .env is restored, not deleted", async () => {
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=sk-original\nOTHER=1\n");
    const app = providerRoutes(polpoDir);
    for (const k of ["sk-setup-1", "sk-setup-2"]) {
      await app.request("/openai/api-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: k }),
      });
    }
    expect(envFile()).toContain("OPENAI_API_KEY=sk-setup-2");
    const target = join(tmp, "chosen", ".polpo");
    moveEnvEntries(polpoDir, target, takeApiWrittenEnvKeys(polpoDir));
    expect(readFileSync(join(target, ".env"), "utf-8")).toBe("OPENAI_API_KEY=sk-setup-2\n");
    expect(envFile()).toBe("OPENAI_API_KEY=sk-original\nOTHER=1\n");
  });

  it("nothing recorded (e.g. after a restart) → nothing moved or deleted", () => {
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=sk-original\n");
    const target = join(tmp, "chosen", ".polpo");
    expect(moveEnvEntries(polpoDir, target, takeApiWrittenEnvKeys(polpoDir))).toEqual([]);
    expect(envFile()).toBe("OPENAI_API_KEY=sk-original\n");
    expect(existsSync(join(target, ".env"))).toBe(false);
  });

  it("rejects API keys with newlines (env line injection)", async () => {
    const app = providerRoutes(polpoDir);
    const res = await app.request("/openai/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-1\nPOLPO_VAULT_KEY=attacker" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(polpoDir, ".env"))).toBe(false);
    expect(process.env[ENV]).toBe(saved);
  });

  it("DELETE ignores body workDir", async () => {
    writeFileSync(join(polpoDir, ".env"), "OPENAI_API_KEY=sk-1\n");
    const other = join(tmp, "other", ".polpo");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, ".env"), "OPENAI_API_KEY=keep\n");
    const app = providerRoutes(polpoDir);
    const res = await app.request("/openai/api-key", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workDir: join(tmp, "other") }),
    });
    expect(res.status).toBe(200);
    expect(envFile()).toBe("");
    expect(readFileSync(join(other, ".env"), "utf-8")).toBe("OPENAI_API_KEY=keep\n");
  });
});
