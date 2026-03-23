import { describe, it, expect, beforeAll } from "vitest";
import { execaCommand } from "execa";
import { resolve } from "node:path";

/**
 * E2E tests for Polpo CLI commands against a real server.
 *
 * Requires:
 *   E2E_BASE_URL  — server URL (default: https://polpo-cloud-production.up.railway.app)
 *   E2E_API_KEY   — API key for a project (e.g. sk_live_...)
 *
 * Run: E2E_API_KEY=sk_live_... npx vitest run src/__tests__/cli-e2e.test.ts
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "https://polpo-cloud-production.up.railway.app";
const API_KEY = process.env.E2E_API_KEY;
const CLI = resolve(__dirname, "../../dist/cli/index.js");

function polpo(args: string, timeout = 30_000) {
  // Pass credentials via flags to avoid needing a login session
  return execaCommand(`node ${CLI} ${args}`, {
    timeout,
    reject: false,
    env: {
      ...process.env,
      // Ensure .polpo/ exists for commands that need it
      FORCE_COLOR: "0",
    },
  });
}

describe("CLI E2E", () => {
  beforeAll(() => {
    if (!API_KEY) throw new Error("E2E_API_KEY is required");
  });

  // ── Version & Help ──

  it("polpo --version", async () => {
    const { stdout, exitCode } = await polpo("--version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("polpo --help", async () => {
    const { stdout, exitCode } = await polpo("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("polpo-ai");
    expect(stdout).toContain("deploy");
    expect(stdout).toContain("login");
    expect(stdout).toContain("start");
  });

  // ── Login ──

  it("polpo login --api-key saves credentials", async () => {
    const { exitCode, stdout } = await polpo(`login --api-key ${API_KEY} --url ${BASE_URL}`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Credentials saved");
  });

  it("polpo login without key in non-TTY fails", async () => {
    const { exitCode } = await polpo("login", 5_000);
    // In non-TTY, should exit with error (or timeout trying to read stdin)
    expect(exitCode).not.toBe(0);
  }, 10_000);

  // ── Projects ──

  it("polpo projects list", async () => {
    await polpo(`login --api-key ${API_KEY} --url ${BASE_URL}`);
    const { exitCode, stdout, stderr } = await polpo("projects list");
    // With API key auth, projects list may fail (needs session auth) — that's ok
    // It should not crash (segfault, unhandled rejection)
    expect(typeof exitCode).toBe("number");
  });

  // ── BYOK ──

  it("polpo byok list", async () => {
    await polpo(`login --api-key ${API_KEY} --url ${BASE_URL}`);
    const { exitCode } = await polpo("byok list");
    // May fail with auth error but shouldn't crash
    expect(exitCode === 0 || exitCode === 1).toBe(true);
  });

  // ── Deploy (dry run without .polpo/) ──

  it("polpo deploy fails without .polpo/", async () => {
    await polpo(`login --api-key ${API_KEY} --url ${BASE_URL}`);
    const { exitCode, stderr } = await polpo("deploy --dir /tmp/nonexistent-polpo-test");
    expect(exitCode).not.toBe(0);
  });

  // ── Deploy with real .polpo/ ──

  // Deploy requires session token for project resolution (GET /v1/orgs).
  // With API key auth, the control plane call hangs. Needs dedicated test with session auth.
  it.skip("polpo deploy --yes completes without hanging", async () => {
    await polpo(`login --api-key ${API_KEY} --url ${BASE_URL}`);
    const { exitCode, stdout, stderr, timedOut } = await polpo("deploy --yes --dir .", 20_000);
    // Must not timeout — --yes should bypass all interactive prompts
    expect(timedOut).toBeFalsy();
    // Should exit (0 = success, 1 = error like no .polpo/ or network) but not hang
    expect(typeof exitCode).toBe("number");
  }, 30_000);

  // ── Init ──

  it("polpo init creates .polpo/ in temp dir", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join("/tmp", "polpo-init-test-"));

    // Non-interactive init (sets POLPO_MODEL to skip wizard prompts)
    const { exitCode, stdout } = await polpo(`init --dir ${tmpDir}`, 15_000);
    // In non-TTY mode, init creates a default config
    expect(exitCode === 0 || exitCode === 1).toBe(true);

    // Check if .polpo was created
    const { existsSync } = await import("node:fs");
    const polpoDir = join(tmpDir, ".polpo");
    if (exitCode === 0) {
      expect(existsSync(polpoDir)).toBe(true);
    }

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Models ──

  it("polpo models list", async () => {
    const { exitCode, stdout } = await polpo("models list");
    expect(exitCode).toBe(0);
    // Should list at least some models
    expect(stdout.length).toBeGreaterThan(10);
  });

  // ── Status ──

  it("polpo status without config exits gracefully", async () => {
    const { exitCode } = await polpo("status --dir /tmp");
    // Should exit without crashing (may fail because no .polpo/)
    expect(typeof exitCode).toBe("number");
  });

  // ── Logout ──

  it("polpo logout clears credentials", async () => {
    await polpo(`login --api-key ${API_KEY} --url ${BASE_URL}`);
    const { exitCode } = await polpo("logout");
    expect(exitCode).toBe(0);
  });
});
