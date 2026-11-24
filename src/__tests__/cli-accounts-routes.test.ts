/**
 * CLI accounts over REST (/harnesses/cli) and the sign-in terminal: accounts are config
 * directories owned by the member who signs in; status comes from the fake CLIs; the login
 * terminal runs the official login command with the account's directory and no server secrets.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliSettings, type CliSettings } from "@polpo-ai/core";
import { cliAccountRoutes } from "../server/routes/cli-accounts.js";
import { hostCommandRunner } from "../cli-engine/accounts.js";
import { cliLoginInvocation } from "../server/terminal.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.POLPO_AUTH_ENABLED; });

function app(o: { member?: string; who?: { member?: string }; auth?: boolean; agents?: any[] } = {}) {
  const bin = tmp("polpo-bin-");
  for (const [name, file] of [["claude", "fake-claude.mjs"], ["codex", "fake-codex.mjs"]]) {
    writeFileSync(join(bin, name!), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, file!)}" "$@"\n`);
    chmodSync(join(bin, name!), 0o755);
  }
  const home = tmp("polpo-home-");
  let cli: CliSettings | undefined;
  const settings = () => ({ harnesses: { enabled: [], ...(cli ? { cli } : {}) } }) as any;
  const routes = cliAccountRoutes({
    settings,
    agents: async () => o.agents ?? [],
    save: async (next) => { cli = next ? parseCliSettings(next) : undefined; },
    hostRunner: (command, env, opts) => hostCommandRunner(command, { ...env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_CLAUDE_SIGNED_IN: "1" }, opts),
    member: () => o.who?.member ?? o.member,
    instanceAuth: () => !!o.auth,
  });
  const root = new Hono();
  root.route("/harnesses/cli", routes);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await root.request(`/harnesses/cli${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  return { call, get: () => cli, settings };
}

describe("CLI accounts REST", () => {
  it("adds an account owned by the signed-in member, with its default directory, and reports its status", async () => {
    const a = app({ member: "ada@example.com", auth: true });
    const r = await a.call("POST", "/accounts", { cli: "claude", label: "Ada's Max" });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ id: "ada-claude", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-claude", owner: "ada@example.com", label: "Ada's Max" });
    const list = await a.call("GET", "/accounts");
    expect(list.body.data.accounts[0]).toMatchObject({ id: "ada-claude", manageable: true, report: { installed: true, version: "2.1.400", status: { signedIn: true, who: "ada@example.com" } } });
    const login = await a.call("GET", "/accounts/ada-claude/login");
    expect(login.body.data).toMatchObject({ mode: "terminal", terminal: { agent: "cli-login", cli_account: "ada-claude" }, command: "CLAUDE_CONFIG_DIR=~/.polpo-cli/claude/ada-claude claude auth login" });
    expect((await a.call("POST", "/accounts/ada-claude/logout")).body.data.ok).toBe(true);
  });

  it("refuses an account for another member, and another member's changes or sign-in", async () => {
    const who = { member: "ada@example.com" };
    const a = app({ who, auth: true });
    expect((await a.call("POST", "/accounts", { cli: "claude", owner: "bob@example.com" })).status).toBe(403);
    await a.call("POST", "/accounts", { cli: "claude" });
    who.member = "bob@example.com";
    expect((await a.call("GET", "/accounts/ada-claude/login")).status).toBe(403);
    expect((await a.call("POST", "/accounts/ada-claude/logout")).status).toBe(403);
    expect((await a.call("DELETE", "/accounts/ada-claude")).status).toBe(403);
    expect((await a.call("GET", "/accounts")).body.data.accounts[0].manageable).toBe(false);
  });

  it("refuses removing an account agents use, and secrets in its fields", async () => {
    const a = app({ agents: [{ name: "dev", engine: { type: "cli", cli: "claude", account: "instance-claude" } }] });
    expect((await a.call("POST", "/accounts", { cli: "claude" })).body.data.owner).toBe("instance");
    expect((await a.call("DELETE", "/accounts/instance-claude")).status).toBe(409);
    expect((await a.call("POST", "/accounts", { cli: "claude", configDir: "/tmp/$(rm -rf ~)" })).status).toBe(400);
  });

  it("toggles instance Codex accounts", async () => {
    const a = app();
    expect((await a.call("PATCH", "/settings", { allowInstanceCodex: true })).status).toBe(200);
    expect(a.get()?.allowInstanceCodex).toBe(true);
  });
});

describe("sign-in terminal", () => {
  const orch = (accounts: unknown[]) => ({ getConfig: () => ({ settings: { harnesses: { enabled: [], cli: { accounts } } } }) }) as any;
  it("runs the official login with the account's directory and none of the server's secrets", () => {
    const home = tmp("polpo-home-");
    const inv = cliLoginInvocation(orch([{ id: "ada-max", cli: "claude", owner: "ada@example.com" }]), "ada-max", undefined, { HOME: home, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret" });
    expect(inv.command).toBe("claude auth login");
    expect(inv.cwd).toBe(join(home, ".polpo-cli/claude/ada-max"));
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe(inv.cwd);
    expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
    const codex = cliLoginInvocation(orch([{ id: "g", cli: "codex", owner: "instance" }]), "g", undefined, { HOME: home, PATH: "/usr/bin" });
    expect(codex.command).toBe("codex login --device-auth");
    expect(codex.env.CODEX_HOME).toBe(join(home, ".polpo-cli/codex/g"));
  });
  it("only the owner signs in a personal account when members sign in", () => {
    process.env.POLPO_AUTH_ENABLED = "1";
    const o = orch([{ id: "ada-max", cli: "claude", owner: "ada@example.com" }]);
    const home = tmp("polpo-home-");
    expect(() => cliLoginInvocation(o, "ada-max", "bob@example.com", { HOME: home })).toThrow(/Only ada@example.com/);
    expect(cliLoginInvocation(o, "ada-max", "ada@example.com", { HOME: home }).account.id).toBe("ada-max");
    expect(() => cliLoginInvocation(o, "nope", "ada@example.com", { HOME: home })).toThrow(/Unknown CLI account/);
  });
});
