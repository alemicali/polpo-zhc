/**
 * Commands run for agents never inherit the server's environment: no provider keys, no tokens,
 * no Polpo keys. Each path that runs one on this machine is checked with secrets set in
 * process.env: they stay out, PATH and HOME stay in, a variable granted to the run gets there.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSandbox } from "@polpo-ai/core/sandbox";
import { NodeShell } from "../adapters/node-shell.js";
import { commandEnv, safeEnv } from "../tools/safe-env.js";
import { createWorkspace } from "../sandbox/manager.js";
import { runCommand } from "../sandbox/process-tree.js";
import { hostHarnessMachine, isolatedHostEnv } from "../harness/sandbox-session.js";
import { appRuntimeEnv } from "../server/app-runtime-manager.js";
import { runCheck } from "../assessment/assessor.js";

const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-server-secret",
  OPENAI_API_KEY: "sk-openai-server-secret",
  AWS_BEARER_TOKEN_BEDROCK: "bedrock-server-secret",
  POLPO_MCP_KEY: "polpo-mcp-server-secret",
  POLPO_VAULT_KEY: "vault-master-server-secret",
  RESEND_API_KEY: "re-server-secret",
  FOO_SECRET: "foo-server-secret",
};
const SECRET_VALUES = Object.values(SECRETS);
const GRANT = { GRANTED_TOKEN: "granted-for-this-run" };

/** `env` output parsed (one NAME=value per line; values with newlines are not used here). */
function parseEnv(out: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

function expectClean(out: string, expected: { home?: string } = {}) {
  for (const value of SECRET_VALUES) expect(out).not.toContain(value);
  const env = parseEnv(out);
  for (const name of Object.keys(SECRETS)) expect(env[name]).toBeUndefined();
  expect(env.PATH).toBeTruthy();
  expect(env.HOME).toBe(expected.home ?? process.env.HOME);
  expect(env.GRANTED_TOKEN).toBe(GRANT.GRANTED_TOKEN);
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; }
  saved.LC_MESSAGES = process.env.LC_MESSAGES;
  saved.ALL_PROXY = process.env.ALL_PROXY;
  process.env.LC_MESSAGES = "C";
  process.env.ALL_PROXY = "socks5h://proxy.example:1080";
});
afterEach(() => {
  for (const k of [...Object.keys(SECRETS), "LC_MESSAGES", "ALL_PROXY"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "polpo-cmd-env-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the filtered environment", () => {
  it("keeps the system set, locale and proxy settings; drops the rest", () => {
    const env = safeEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.LC_MESSAGES).toBe("C");
    expect(env.ALL_PROXY).toBe("socks5h://proxy.example:1080");
    for (const name of Object.keys(SECRETS)) expect(env[name]).toBeUndefined();
  });

  it("commandEnv adds the caller's variables and drops unset ones", () => {
    const env = commandEnv({ ...GRANT, UNSET: undefined });
    expect(env.GRANTED_TOKEN).toBe(GRANT.GRANTED_TOKEN);
    expect("UNSET" in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("commands on this machine", () => {
  it("NodeShell (bash tool without a sandbox, checks)", async () => {
    const r = await new NodeShell().execute("env", { cwd: dir, env: GRANT });
    expect(r.exitCode).toBe(0);
    expectClean(r.stdout);
    // the locale categories and the proxy settings pass
    expect(parseEnv(r.stdout).LC_MESSAGES).toBe("C");
    expect(parseEnv(r.stdout).ALL_PROXY).toBe("socks5h://proxy.example:1080");
  });

  it("a check's command (assessor through NodeShell)", async () => {
    const leak = await runCheck({ type: "script", command: '[ -z "$ANTHROPIC_API_KEY$POLPO_MCP_KEY$FOO_SECRET" ]' }, dir);
    expect(leak.passed).toBe(true);
  });

  it("the local workspace", async () => {
    const sandbox: EffectiveSandbox = { provider: "local", network: { mode: "unrestricted" }, resources: {}, providerOptions: {}, denied: [] };
    const ws = createWorkspace(sandbox, { root: dir } as any);
    try {
      const r = await ws.exec("env", { env: GRANT });
      expect(r.exitCode).toBe(0);
      expectClean(r.stdout);
    } finally { await ws.dispose(); }
  });

  it("the agent harnesses' host processes (isolated HOME)", async () => {
    const home = join(dir, "harness-home");
    const m = hostHarnessMachine({ workDir: dir, home });
    try {
      const r = await m.exec("env", { env: GRANT });
      expect(r.exitCode).toBe(0);
      expectClean(r.stdout, { home });
      // proxy settings pass, with this machine reached directly
      const env = parseEnv(r.stdout);
      expect(env.ALL_PROXY).toBe("socks5h://proxy.example:1080");
      expect(env.NO_PROXY).toContain("127.0.0.1");
    } finally { m.close(); }
  });

  it("app services and deployments", async () => {
    const env = { ...appRuntimeEnv({ id: "app-1", slug: "demo" }), ...GRANT };
    const r = await runCommand(["/bin/sh", "-c", "env"], { env, cwd: dir });
    expect(r.exitCode).toBe(0);
    expectClean(r.stdout);
    expect(parseEnv(r.stdout).POLPO_APP_ID).toBe("app-1");
  });
});

describe("harness env without proxy settings", () => {
  it("adds no NO_PROXY of its own", () => {
    const env = isolatedHostEnv("/iso/home", { PATH: "/usr/bin", LC_ALL: "C.UTF-8", TZ: "UTC" });
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.TZ).toBe("UTC");
  });
});
