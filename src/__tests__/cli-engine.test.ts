/**
 * The CLI engine with fake `claude` and `codex` programs (src/__tests__/fixtures/fake-*.mjs, which
 * speak the recorded stream-json and app-server JSON-RPC shapes; no network, no real account):
 * config validation, the owner policy guard, status parsing, error classification, and the
 * runner (events → transcript, usage, steer, follow-up, continuation, kill, not signed in).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentEngineProblem, agentHarness, classifyCliError, cliAccountUseProblem, parseAgentEngine, parseCliStatus, parseCliVersion,
  parseHarnessesSettings, resolveCliAccount, instanceServesCustomers, buildRunContext, type CliAccount,
} from "@polpo-ai/core";
import { spawnCliEngine, type CliEngineDeps } from "../adapters/cli-engine.js";
import { hostCliProcess, cliHostEnv } from "../cli-engine/process.js";
import { claudeArgs, parseClaudeLine } from "../cli-engine/claude.js";
import { codexItemEvents } from "../cli-engine/codex.js";
import { cliAccountReport, cliAccountLogout, hostAccountOps, hostCommandRunner } from "../cli-engine/accounts.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A bin dir with `claude` and `codex` wrappers around the fake programs. */
function fakeBin(): string {
  const bin = tmp("polpo-fake-bin-");
  for (const [name, file] of [["claude", "fake-claude.mjs"], ["codex", "fake-codex.mjs"]]) {
    writeFileSync(join(bin, name!), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, file!)}" "$@"\n`);
    chmodSync(join(bin, name!), 0o755);
  }
  return bin;
}

const ada: CliAccount = { id: "ada-max", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-max", owner: "ada@example.com" };
const adaCodex: CliAccount = { id: "ada-gpt", cli: "codex", computer: "host", configDir: "~/.polpo-cli/codex/ada-gpt", owner: "ada@example.com" };

describe("config validation", () => {
  it("parses a CLI engine and keeps it off the harness path", () => {
    const e = parseAgentEngine({ type: "cli", cli: "claude", account: "ada-max", model: "opus", permissionMode: "allow-edits", args: ["--effort", "high"] });
    expect(e).toEqual({ type: "cli", cli: "claude", account: "ada-max", model: "opus", permissionMode: "allow-edits", args: ["--effort", "high"] });
    expect(agentHarness({ engine: e })).toBeUndefined();
    expect(() => parseAgentEngine({ type: "cli", cli: "gemini" })).toThrow(/cli must be one of claude, codex/);
    expect(() => parseAgentEngine({ type: "cli", cli: "claude", token: "x" })).toThrow(/not a CLI engine setting/);
    expect(() => parseAgentEngine({ type: "cli", cli: "claude", args: ["--resume", "x"] })).toThrow(/set by Polpo/);
    expect(() => parseAgentEngine({ type: "cli", cli: "claude", args: ["--settings=/tmp/x.json"] })).toThrow(/set by Polpo/);
  });

  it("parses accounts in settings.harnesses.cli: config dirs only, never secrets", () => {
    const s = parseHarnessesSettings({ enabled: [], cli: { accounts: [{ id: "ada-max", cli: "claude", owner: "Ada@Example.com" }, { id: "team-gpt", cli: "codex", owner: "instance", label: "Team" }], allowInstanceCodex: true } });
    expect(s.cli).toEqual({
      accounts: [
        { id: "ada-max", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-max", owner: "ada@example.com" },
        { id: "team-gpt", cli: "codex", computer: "host", configDir: "~/.polpo-cli/codex/team-gpt", owner: "instance", label: "Team" },
      ],
      allowInstanceCodex: true,
    });
    expect(() => parseHarnessesSettings({ enabled: [], cli: { accounts: [{ id: "a", cli: "claude", owner: "x@y.z", oauthToken: "sk-ant-oat" }] } })).toThrow(/holds no secret/);
    expect(() => parseHarnessesSettings({ enabled: [], cli: { accounts: [{ id: "a", cli: "claude", owner: "nobody" }] } })).toThrow(/owner must be the email/);
    expect(() => parseHarnessesSettings({ enabled: [], cli: { accounts: [{ id: "a", cli: "claude", owner: "x@y.z", configDir: "~/../etc" }] } })).toThrow(/configDir/);
    expect(() => parseHarnessesSettings({ enabled: [], cli: { accounts: [{ id: "a", cli: "claude", owner: "x@y.z" }, { id: "a", cli: "codex", owner: "x@y.z" }] } })).toThrow(/appears twice/);
  });

  it("resolves the agent's account on its computer and reports problems on save", () => {
    const settings = { harnesses: { enabled: [], cli: { accounts: [ada, adaCodex] } } };
    expect(resolveCliAccount({ type: "cli", cli: "claude" }, "host", { accounts: [ada] })).toEqual({ account: ada });
    expect(agentEngineProblem({ name: "dev", engine: { type: "cli", cli: "claude" } }, settings)).toBeNull();
    expect(agentEngineProblem({ name: "dev", engine: { type: "cli", cli: "claude", account: "nope" } }, settings)).toMatch(/unknown account "nope"/);
    expect(agentEngineProblem({ name: "dev", engine: { type: "cli", cli: "claude" }, defaultComputer: "vm-1" }, settings)).toMatch(/no account on computer "vm-1"/);
  });

  it("records the run as a CLI run on a subscription", () => {
    const ctx = buildRunContext({ runId: "r1", agent: { name: "dev", engine: { type: "cli", cli: "codex", model: "gpt-5.5" } } });
    expect(ctx).toMatchObject({ engine: "codex-cli", model: "gpt-5.5", auth: { kind: "subscription" }, permissionMode: "allow-all" });
  });
});

describe("policy guard (personal sign-ins)", () => {
  const base = { instanceAuth: true, servesCustomers: false } as const;
  it("allows the owner's own work", () => {
    expect(cliAccountUseProblem(ada, { ...base, origin: "member", initiator: "ADA@example.com" })).toBeNull();
  });
  it("blocks other members, unknown authors, schedules and channel customers", () => {
    expect(cliAccountUseProblem(ada, { ...base, origin: "member", initiator: "bob@example.com" })).toMatch(/belongs to ada@example.com; this work was started by bob@example.com.*legal-and-compliance/);
    expect(cliAccountUseProblem(ada, { ...base, origin: "unknown" })).toMatch(/not started by a member/);
    expect(cliAccountUseProblem(ada, { ...base, origin: "schedule" })).toMatch(/cannot run scheduled work/);
    expect(cliAccountUseProblem(ada, { ...base, origin: "channel-customer", initiator: "ada@example.com" })).toMatch(/cannot answer channel customers/);
  });
  it("blocks instances that serve customers", () => {
    expect(cliAccountUseProblem(ada, { ...base, servesCustomers: true, origin: "member", initiator: "ada@example.com" })).toMatch(/serves customers/);
    expect(instanceServesCustomers({ notifications: { channels: { wa: { type: "whatsapp-business" } } } })).toBe(true);
    expect(instanceServesCustomers({ notifications: { channels: { wa: { type: "whatsapp-business", business: { audience: "operators" } } } } })).toBe(false);
  });
  it("instance-owned accounts: Claude only on a personal installation, Codex only when allowed", () => {
    const inst = { ...ada, owner: "instance" };
    expect(cliAccountUseProblem(inst, { origin: "unknown", instanceAuth: false, servesCustomers: false })).toBeNull();
    expect(cliAccountUseProblem(inst, { origin: "unknown", instanceAuth: true, servesCustomers: false })).toMatch(/several members/);
    const team = { ...adaCodex, owner: "instance" };
    expect(cliAccountUseProblem(team, { origin: "unknown", instanceAuth: true, servesCustomers: false })).toMatch(/allowInstanceCodex/);
    expect(cliAccountUseProblem(team, { origin: "schedule", instanceAuth: true, servesCustomers: false }, { accounts: [team], allowInstanceCodex: true })).toBeNull();
  });
});

describe("status, versions and errors", () => {
  it("parses claude auth status (JSON) and codex login status (text)", () => {
    expect(parseCliStatus("claude", { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "ada@example.com", subscriptionType: "max" }), stderr: "" }))
      .toEqual({ signedIn: true, who: "ada@example.com", method: "claude.ai", plan: "max" });
    expect(parseCliStatus("claude", { exitCode: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), stderr: "" }).signedIn).toBe(false);
    expect(parseCliStatus("codex", { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" })).toMatchObject({ signedIn: true, method: "chatgpt" });
    expect(parseCliStatus("codex", { exitCode: 1, stdout: "", stderr: "Not logged in" }).signedIn).toBe(false);
    expect(parseCliVersion("2.1.400 (Claude Code)")).toBe("2.1.400");
    expect(parseCliVersion("codex-cli 0.90.0")).toBe("0.90.0");
  });
  it("labels not-signed-in and usage limits as not retryable", () => {
    expect(classifyCliError("claude", "Invalid API key · Please run /login", ada)).toMatchObject({ kind: "not-signed-in", retryable: false });
    expect(classifyCliError("claude", "Claude AI usage limit reached|1767225600")).toMatchObject({ kind: "usage-limit", retryable: false });
    expect(classifyCliError("codex", "You've hit your usage limit. Try again at 5:00 PM.").message).toMatch(/usage limit/);
    expect(classifyCliError("codex", "spawn codex ENOENT")).toMatchObject({ kind: "not-installed", retryable: false });
    expect(classifyCliError("claude", "socket hang up")).toMatchObject({ kind: "other", retryable: true });
  });
  it("maps stream-json lines and codex items", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] } })))
      .toEqual({ kind: "events", events: [{ type: "text", text: "hi" }, { type: "tool-call", id: "t", name: "Bash", input: { command: "ls" } }] });
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: { role: "user", content: "steer" }, isReplay: true }))).toEqual({ kind: "replay" });
    expect(codexItemEvents("item/started", { item: { type: "fileChange", id: "f", changes: [{ path: "a.ts", kind: { type: "update" } }] } }))
      .toEqual([{ type: "tool-call", id: "f", name: "apply_patch", input: { path: "a.ts", changes: [{ path: "a.ts", kind: "update" }] } }]);
    expect(claudeArgs({ resume: "s1", model: "opus", instructions: "be good" })).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", "s1", "--model", "opus", "--permission-mode", "bypassPermissions", "--append-system-prompt", "be good"]));
  });
  it("never passes the server's credentials to the CLI", () => {
    const env = cliHostEnv("claude", ada, { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-ant-x", AWS_SECRET_ACCESS_KEY: "y", CLAUDE_CODE_OAUTH_TOKEN: "z" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/x/.polpo-cli/claude/ada-max");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("account operations (fake binaries)", () => {
  it("reports version and status, and signs out with the CLI's own command", async () => {
    const bin = fakeBin();
    const home = tmp("polpo-home-");
    const ops = hostAccountOps(hostCommandRunner);
    const withEnv = { ...ops, envFor: (a: CliAccount) => ({ ...cliHostEnv(a.cli, a, { PATH: `${bin}:${process.env.PATH}`, HOME: home }), FAKE_CLAUDE_SIGNED_IN: "1" }), prefixFor: () => "" };
    expect(await cliAccountReport(ada, withEnv)).toEqual({ id: "ada-max", installed: true, version: "2.1.400", status: { signedIn: true, who: "ada@example.com", method: "claude.ai", plan: "max" } });
    expect(await cliAccountReport(adaCodex, withEnv)).toMatchObject({ installed: true, version: "0.90.0", status: { signedIn: false } });
    expect((await cliAccountLogout(ada, withEnv)).ok).toBe(true);
    const missing = { ...ops, envFor: (a: CliAccount) => cliHostEnv(a.cli, a, { PATH: "/nonexistent", HOME: home }), prefixFor: () => "" };
    expect(await cliAccountReport(ada, missing)).toMatchObject({ installed: false });
  });
});

// ── the runner ─────────────────────────────────────────────────────────────

function setup(o: { accounts?: CliAccount[]; engine?: Record<string, unknown>; requestedBy?: string | null; signedIn?: boolean } = {}) {
  const bin = fakeBin();
  const polpoDir = tmp("polpo-cli-dir-");
  const cwd = tmp("polpo-cli-cwd-");
  const log = join(polpoDir, "fake.log");
  const usage: any[] = [];
  const transcript: any[] = [];
  const settings = { harnesses: { enabled: [], cli: { accounts: o.accounts ?? [ada, adaCodex] } } } as any;
  const deps: CliEngineDeps = {
    settings: () => settings,
    recordUsage: async (r) => { usage.push(r); },
    instanceAuth: () => true,
    launch: async ({ cli, args, cwd: dir, env }) => hostCliProcess(join(bin, cli), args, { cwd: dir, env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLI_LOG: log, ANTHROPIC_API_KEY: "" } }),
  };
  const agent: any = { name: "dev", engine: o.engine ?? { type: "cli", cli: "claude" } };
  const task = (description = "Write out.txt", id = "t1"): any => ({
    id, title: "Do it", description, assignTo: "dev", dependsOn: [], status: "in_progress", retries: 0, maxRetries: 2, expectations: [], metrics: [],
    createdAt: "", updatedAt: "", ...(o.requestedBy === null ? {} : { requestedBy: o.requestedBy ?? "ada@example.com" }),
  });
  const spawn = (t = task(), extra: any = {}) => {
    const h = spawnCliEngine(agent, t, cwd, { polpoDir, ...extra }, deps);
    h.onTranscript = (e) => transcript.push(e);
    return h;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { spawn, task, usage, transcript, calls, polpoDir };
}

describe("runner: Claude Code (fake CLI)", () => {
  it("runs a turn: events become the transcript, tokens are recorded at no cost, the session is kept", async () => {
    const s = setup();
    const h = s.spawn();
    const r = await h.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "Done turn 1" });
    const types = s.transcript.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["reasoning", "tool_use", "tool_result", "assistant", "usage"]));
    expect(s.transcript.find((e) => e.type === "tool_use")).toMatchObject({ tool: "Write", input: { file_path: "out.txt" } });
    expect(h.activity.filesCreated).toEqual(["out.txt"]);
    expect(s.usage).toEqual([expect.objectContaining({ provider: "claude-cli", cost: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, totalTokens: 180 })]);
    expect(h.activity.runContext?.cost).toMatchObject({ costSource: "subscription", tokens: 180 });
    expect(h.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    const call = s.calls().find((c) => c.argv?.[0] === "-p");
    expect(call.configDir).toMatch(/\.polpo-cli\/claude\/ada-max$/);
    expect(call.anthropicKey ?? "").toBe("");
    expect(call.argv).toEqual(expect.arrayContaining(["--append-system-prompt", "--permission-mode", "bypassPermissions"]));
  });

  it("runs follow-ups as further turns over the same input stream, and resumes on a continuation", async () => {
    const s = setup();
    const h = s.spawn();
    h.followUp!("And then this");
    expect((await h.done).stdout).toBe("Done turn 2");
    expect(s.usage).toHaveLength(2);
    const h2 = s.spawn(s.task(), { continuation: { message: "continue please", directionIds: [] } });
    expect((await h2.done).exitCode).toBe(0);
    const resumed = s.calls().filter((c) => c.argv?.[0] === "-p").pop();
    expect(resumed.argv).toEqual(expect.arrayContaining(["--resume", "11111111-2222-3333-4444-555555555555"]));
  });

  it("steers the running turn through the input stream", async () => {
    const s = setup();
    const h = s.spawn(s.task("STEER me"));
    const applied: string[][] = [];
    h.onDirectionApplied = (ids) => { applied.push(ids); };
    await new Promise((r) => setTimeout(r, 600));
    h.steer!("use pnpm", "d1");
    const r = await h.done;
    expect(r.stdout).toBe("Steered: use pnpm");
    expect(applied).toContainEqual(["d1"]);
  });

  it("kill stops the program (process group) and the run ends as killed", async () => {
    const s = setup();
    const h = s.spawn(s.task("SLOW"));
    await new Promise((r) => setTimeout(r, 600));
    h.kill();
    const r = await h.done;
    expect(r).toMatchObject({ exitCode: 1, stderr: "Killed" });
    expect(h.isAlive()).toBe(false);
  });

  it("not signed in fails without retries, saying how to sign in", async () => {
    const s = setup();
    const r = await s.spawn(s.task("NOT_LOGGED_IN")).done;
    expect(r).toMatchObject({ exitCode: 1, retryable: false });
    expect(r.stderr).toMatch(/not signed in.*Settings → Harnesses → CLI accounts/);
  });

  it("usage limit reached fails without retries", async () => {
    const s = setup();
    const r = await s.spawn(s.task("USAGE_LIMIT")).done;
    expect(r).toMatchObject({ exitCode: 1, retryable: false });
    expect(r.stderr).toMatch(/usage limit/);
  });

  it("refuses another member's work before starting the program", async () => {
    const s = setup({ requestedBy: "bob@example.com" });
    const r = await s.spawn().done;
    expect(r).toMatchObject({ exitCode: 1, retryable: false });
    expect(r.stderr).toMatch(/belongs to ada@example.com.*bob@example.com/);
    expect(s.calls()).toHaveLength(0);
    const anon = setup({ requestedBy: null });
    expect((await anon.spawn().done).stderr).toMatch(/not started by a member/);
  });
});

describe("runner: Codex (fake app server)", () => {
  it("runs a turn over JSON-RPC, declines approval requests, records tokens", async () => {
    const s = setup({ engine: { type: "cli", cli: "codex", model: "gpt-5.5-codex", permissionMode: "allow-edits" } });
    const h = s.spawn();
    const r = await h.done;
    expect(r).toMatchObject({ exitCode: 0, stdout: "Codex done 1" });
    expect(s.transcript.find((e) => e.type === "tool_use")).toMatchObject({ tool: "shell", input: { command: "ls" } });
    expect(s.transcript.find((e) => e.type === "tool_result")).toMatchObject({ content: "a.txt\n", isError: false });
    expect(s.transcript.find((e) => e.type === "reasoning")).toMatchObject({ text: "Listing files" });
    expect(s.usage[0]).toMatchObject({ provider: "codex-cli", cost: 0, inputTokens: 100, cacheReadTokens: 20, outputTokens: 30, totalTokens: 150 });
    expect(s.calls().find((c) => c.argv?.[0] === "app-server").codexHome).toMatch(/\.polpo-cli\/codex\/ada-gpt$/);
    expect(h.sessionId).toBe("thr_1");
    expect(s.calls().find((c) => c.approvalReply)?.approvalReply).toEqual({ id: 900, result: { decision: "decline" } });
  });

  it("steers with turn/steer", async () => {
    const s = setup({ engine: { type: "cli", cli: "codex" } });
    const h = s.spawn(s.task("STEER now"));
    await new Promise((r) => setTimeout(r, 600));
    h.steer!("focus on tests", "d2");
    expect((await h.done).stdout).toBe("Steered: focus on tests");
  });

  it("not signed in and usage limits are not retried", async () => {
    const s = setup({ engine: { type: "cli", cli: "codex" } });
    const a = await s.spawn(s.task("NOT_LOGGED_IN")).done;
    expect(a).toMatchObject({ exitCode: 1, retryable: false });
    expect(a.stderr).toMatch(/not signed in/);
    const b = await s.spawn(s.task("USAGE_LIMIT", "t2")).done;
    expect(b.stderr).toMatch(/usage limit/);
  });

  it("kill stops the app server", async () => {
    const s = setup({ engine: { type: "cli", cli: "codex" } });
    const h = s.spawn(s.task("SLOW"));
    await new Promise((r) => setTimeout(r, 600));
    h.kill();
    expect((await h.done).stderr).toBe("Killed");
  });
});
