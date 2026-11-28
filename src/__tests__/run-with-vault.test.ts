/**
 * run_with_vault: agents on an external harness (Claude Code, Codex, OpenCode) have their own shell,
 * which cannot read the vault. Polpo offers them run_with_vault (Polpo's bash with env_from_vault,
 * on the run's computer) and vault_get without values; agents on Polpo's engine keep bash's
 * env_from_vault and never see run_with_vault.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import type { AgentConfig } from "../core/types.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import { loadAgentVaultEntries, resolveAgentVault, type ResolvedVault } from "../vault/resolver.js";
import { createRunSecrets } from "../vault/env-from-vault.js";
import { ALL_EXTENDED_TOOL_NAMES, createAllTools, createRunWithVaultTool, createSystemTools, grantsRunWithVault, RUN_WITH_VAULT_TOOL } from "../tools/system-tools.js";
import { buildAgentToolset } from "../adapters/engine.js";
import { buildHarnessInstructions, RUN_WITH_VAULT_NOTE } from "../adapters/harness-engine.js";
import { toHarnessHostTools } from "../harness/host-tools.js";

const API_KEY = "sk-live-0123456789abcdef";
const SHARED = "npm_shared_token_0123456789";

const previousKey = process.env.POLPO_VAULT_KEY;
let polpoDir: string;
let store: EncryptedVaultStore;
let vault: ResolvedVault;
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const textOf = (r: any): string => (r.content ?? []).map((c: any) => c.text ?? "").join("");

beforeAll(async () => {
  process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");
  polpoDir = mkdtempSync(join(tmpdir(), "polpo-rwv-"));
  writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: "claudio" }] }, settings: {} }));
  store = new EncryptedVaultStore(polpoDir);
  await store.set("claudio", "openai", { type: "api_key", label: "OpenAI", credentials: { api_key: API_KEY, org: "org-polpo" } });
  // shared with claudio by bob; carol's stays hers
  await store.set("bob", "npm", { type: "api_key", allowedAgents: ["claudio"], credentials: { token: SHARED } });
  await store.set("carol", "private", { type: "api_key", credentials: { token: "carol-only-secret" } });
  vault = resolveAgentVault(await loadAgentVaultEntries(store, "claudio"));
});

afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
afterAll(() => {
  rmSync(polpoDir, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env.POLPO_VAULT_KEY; else process.env.POLPO_VAULT_KEY = previousKey;
});

async function toolset(agent: AgentConfig, opts: { harnessHost?: boolean; cwd?: string; shell?: any; sandboxProvider?: string } = {}) {
  const cwd = opts.cwd ?? tmp("polpo-rwv-cwd-");
  const ts = await buildAgentToolset({
    agentConfig: agent, cwd, ctx: { polpoDir, vaultStore: store } as never, sandboxProvider: opts.sandboxProvider ?? "local",
    browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false, ...(opts.shell ? { shell: opts.shell } : {}),
    notifyOrigin: {}, ...(opts.harnessHost ? { harnessHost: true } : {}),
  });
  await ts.connectorManager?.closeAll();
  return { ...ts, cwd };
}

describe("which agents get run_with_vault", () => {
  test("a harness agent's host tools: run_with_vault and a valueless vault_get, never bash", async () => {
    const ts = await toolset({ name: "claudio" }, { harnessHost: true });
    const host = toHarnessHostTools(ts.tools).map((t) => t.name);
    expect(host).toEqual(expect.arrayContaining([RUN_WITH_VAULT_TOOL, "vault_get", "vault_list"]));
    expect(host).not.toContain("bash");
    const get = ts.tools.find((t) => t.name === "vault_get")!;
    expect(get.description).toContain("run_with_vault");
    expect(get.description).not.toContain("bash");
    // even on this server ("local"), no value: key names and non-secret fields only
    const r = textOf(await get.execute("g", { service: "openai" } as any));
    expect(r).not.toContain(API_KEY);
    expect(r).toContain("api_key: ***");
    expect(r).toContain("run_with_vault");
    expect(textOf(await ts.tools.find((t) => t.name === "vault_list")!.execute("l", {} as any))).toContain("run_with_vault's env_from_vault");
  });

  test("Polpo's engine: bash keeps env_from_vault, no run_with_vault; a values-returning vault_get never reaches a harness", async () => {
    const ts = await toolset({ name: "claudio" });
    const names = ts.tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).not.toContain(RUN_WITH_VAULT_TOOL);
    // locally vault_get returns values on Polpo's engine: never offered to a harness
    expect(textOf(await ts.tools.find((t) => t.name === "vault_get")!.execute("g", { service: "openai" } as any))).toContain(API_KEY);
    expect(toHarnessHostTools(ts.tools).map((t) => t.name)).not.toContain("vault_get");
    // createAllTools without harnessHost: none either
    const all = await createAllTools({ cwd: ts.cwd, vault, allowedTools: ["bash", "run_with_vault"] });
    expect(all.map((t) => t.name)).not.toContain(RUN_WITH_VAULT_TOOL);
  });

  test("allowedTools: no list, run_with_vault or bash (wildcards too) grant it; vault_* and file tools do not", async () => {
    expect(grantsRunWithVault(undefined)).toBe(true);
    expect(grantsRunWithVault(["run_with_vault"])).toBe(true);
    expect(grantsRunWithVault(["read", "BASH"])).toBe(true);
    expect(grantsRunWithVault(["run_*"])).toBe(true);
    expect(grantsRunWithVault(["vault_*"])).toBe(false);
    expect(grantsRunWithVault(["read", "write", "browser_*"])).toBe(false);
    expect(grantsRunWithVault([])).toBe(false);
    const names = async (allowedTools: string[]) => (await toolset({ name: "claudio", allowedTools }, { harnessHost: true })).tools.map((t) => t.name);
    expect(await names(["read", "vault_*"])).not.toContain(RUN_WITH_VAULT_TOOL);
    expect(await names(["read", "run_with_vault"])).toContain(RUN_WITH_VAULT_TOOL);
    expect(await names(["bash"])).toContain(RUN_WITH_VAULT_TOOL);
    // vault_get stays a core tool either way
    expect(await names(["read"])).toContain("vault_get");
    // through createAllTools (an agent with extended tools) as well
    const ext = await createAllTools({ cwd: tmp("polpo-rwv-ext-"), vault, allowedTools: ["browser_*", "run_with_vault"], harnessHost: true });
    expect(ext.map((t) => t.name)).toContain(RUN_WITH_VAULT_TOOL);
  });

  test("a known tool name (agent tests, task scopes) and the harness instructions tell when to use it", () => {
    expect(ALL_EXTENDED_TOOL_NAMES).toContain(RUN_WITH_VAULT_TOOL);
    const with_ = buildHarnessInstructions({ agent: { name: "claudio" } as any, cwd: "/w", hostTools: ["vault_get", RUN_WITH_VAULT_TOOL], harness: "claude-code" });
    expect(with_).toContain(RUN_WITH_VAULT_NOTE);
    expect(with_).toMatch(/never copy secrets into files, the chat or outcomes/i);
    expect(buildHarnessInstructions({ agent: { name: "claudio" } as any, cwd: "/w", hostTools: ["vault_get"], harness: "codex" })).not.toContain(RUN_WITH_VAULT_NOTE);
  });
});

describe("running a command with run_with_vault on this server", () => {
  const runTool = async (cwd: string) => (await toolset({ name: "claudio" }, { harnessHost: true, cwd })).tools.find((t) => t.name === RUN_WITH_VAULT_TOOL)!;

  test.skipIf(process.platform === "win32")("the variable reaches that command only, masked in the output; own and shared entries", async () => {
    const cwd = tmp("polpo-rwv-run-");
    const tool = await runTool(cwd);
    const r = await tool.execute("c1", {
      command: 'echo "k=$OPENAI_API_KEY"; echo "len=${#OPENAI_API_KEY}"; printf %s "$OPENAI_API_KEY" | base64; echo "n=$NPM_TOKEN"',
      env_from_vault: { OPENAI_API_KEY: "openai.api_key", NPM_TOKEN: { service: "npm", key: "token" } },
    } as any);
    const out = textOf(r);
    expect(out).toContain("Exit code: 0");
    expect(out).toContain("k=***");
    expect(out).toContain(`len=${API_KEY.length}`);
    expect(out).toContain("n=***");
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(SHARED);
    expect(out).not.toContain(Buffer.from(API_KEY).toString("base64"));
    // only references in details, never values
    expect((r as any).details.envFromVault).toEqual({ OPENAI_API_KEY: "openai.api_key", NPM_TOKEN: "npm.token" });
    expect(JSON.stringify((r as any).details)).not.toContain(API_KEY);
    // never this process's environment, never on disk
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    // a later command does not have it
    const after = await tool.execute("c2", { command: 'echo "k=${OPENAI_API_KEY:-unset}"', env_from_vault: { NPM_TOKEN: "npm.token" } } as any);
    expect(textOf(after)).toContain("k=unset");
  });

  test.skipIf(process.platform === "win32")("cwd: relative to the working directory, or absolute", async () => {
    const cwd = tmp("polpo-rwv-cwd2-");
    const tool = await runTool(cwd);
    const sub = join(cwd, "sub");
    rmSync(sub, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(sub);
    expect(textOf(await tool.execute("c", { command: "pwd", cwd: "sub", env_from_vault: { K: "openai.org" } } as any))).toContain(sub);
    expect(textOf(await tool.execute("c", { command: "pwd", cwd: sub, env_from_vault: { K: "openai.org" } } as any))).toContain(sub);
  });

  test("unknown service or key, someone else's entry, bad names, empty map: an error, and the command does not run", async () => {
    const cwd = tmp("polpo-rwv-err-");
    const tool = await runTool(cwd);
    const marker = join(cwd, "ran");
    const run = (env_from_vault: unknown) => tool.execute("e", { command: `touch ${marker}`, env_from_vault } as any);
    const noEntry = await run({ K: "nope.key" });
    expect((noEntry as any).isError).toBe(true);
    expect(textOf(noEntry)).toMatch(/no vault entry for "nope\.key".*available vault entries: .*openai/s);
    expect(textOf(noEntry)).toContain("The command was not run");
    const noKey = await run({ K: "openai.secret" });
    expect(textOf(noKey)).toContain('vault entry "openai" has no key "secret" (keys: api_key, org)');
    expect(textOf(noKey)).not.toContain(API_KEY);
    expect(textOf(await run({ K: "private.token" }))).toMatch(/no vault entry/);
    expect(textOf(await run({ PATH: "openai.api_key" }))).toContain("reserved");
    const empty = await run({});
    expect((empty as any).isError).toBe(true);
    expect(textOf(empty)).toMatch(/env_from_vault is empty/);
    expect(existsSync(marker)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the run's own secrets (vault_create_login) are masked too", async () => {
    const learned = "generated-password-XYZ987";
    const secrets = createRunSecrets([learned]);
    const tool = createSystemTools(tmp("polpo-rwv-mask-"), undefined, undefined, undefined, vault, undefined, undefined, { harnessHost: true, runMask: secrets.mask })
      .find((t) => t.name === RUN_WITH_VAULT_TOOL)!;
    const out = textOf(await tool.execute("m", { command: `echo "${learned} $K"`, env_from_vault: { K: "openai.api_key" } } as any));
    expect(out).toContain("*** ***");
    expect(out).not.toContain(learned);
  });
});

/** A remote computer's shell (Daytona, E2B): records what runs there; the env exists only in the call. */
class FakeRemoteShell implements Shell {
  calls: Array<{ command: string; options: ShellOptions | undefined }> = [];
  async isRemote() { return true; }
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    this.calls.push({ command, options });
    const env = options?.env ?? {};
    // what the VM prints: the value itself (as a careless command would)
    return { stdout: `on-vm cwd=${options?.cwd} key=${env.OPENAI_API_KEY ?? ""}\n`, stderr: "", exitCode: 0 };
  }
}

describe("run_with_vault on a remote computer", () => {
  test("runs through the computer's shell, in its paths, with the env for that call only, masked", async () => {
    const shell = new FakeRemoteShell();
    const cwd = "/home/daytona/work";
    const ts = await toolset({ name: "claudio" }, { harnessHost: true, cwd, shell, sandboxProvider: "daytona" });
    const tool = toHarnessHostTools(ts.tools).find((t) => t.name === RUN_WITH_VAULT_TOOL)!;
    expect(tool.readOnly).toBeUndefined();
    const out = await tool.execute({ command: "curl -s https://api.openai.com/v1/models", cwd: "repo", env_from_vault: { OPENAI_API_KEY: "openai.api_key" } }, { toolCallId: "r1" } as any);
    expect(out).toContain("on-vm cwd=/home/daytona/work/repo key=***");
    expect(out).not.toContain(API_KEY);
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.options?.cwd).toBe("/home/daytona/work/repo");
    expect(shell.calls[0]!.options?.env).toEqual({ OPENAI_API_KEY: API_KEY });
    // a later command on the computer carries no vault env
    await tool.execute({ command: "true", env_from_vault: { ORG: "openai.org" } }, { toolCallId: "r2" } as any);
    expect(shell.calls[1]!.options?.env).toEqual({ ORG: "org-polpo" });
  });

  test("the tool on its own: the given shell, never this server's", async () => {
    const shell = new FakeRemoteShell();
    const tool = createRunWithVaultTool("/vm", shell, tmp("polpo-rwv-out-"), { vault });
    const r = await tool.execute("x", { command: "echo", env_from_vault: { OPENAI_API_KEY: "openai.api_key" } } as any);
    expect(textOf(r)).toContain("cwd=/vm key=***");
    expect(shell.calls[0]!.options?.cwd).toBe("/vm");
  });
});
