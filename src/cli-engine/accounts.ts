/**
 * CLI accounts on their computer: installed version, sign-in status, sign-out, install. Each runs
 * the official program with the account's config directory; Polpo reads only what the program
 * prints (`claude auth status` JSON, `codex login status`), never the credential files.
 *
 * Signing in is interactive (Anthropic's / OpenAI's own flow): the dashboard opens a terminal on
 * the computer running cliLoginCommand() (server/terminal.ts, agent kind "cli-login").
 */
import { homedir } from "node:os";
import {
  CLI_BINARIES, CLI_CONFIG_ENV, CLI_INSTALL_COMMANDS, CLI_LOGIN_COMMANDS, CLI_LOGOUT_COMMANDS, CLI_STATUS_COMMANDS, HOST_COMPUTER_ID,
  parseCliStatus, parseCliVersion, type CliAccount, type CliAccountStatus, type CliId,
} from "@polpo-ai/core";
import { runCommand } from "../sandbox/process-tree.js";
import { cliHostEnv, expandHome } from "./process.js";

/** Runs a shell command on the account's computer with this environment. */
export type CliCommandRunner = (command: string, env: Record<string, string>, opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** This server: bash -lc with the CLI's minimal environment (the env given is complete). */
export const hostCommandRunner: CliCommandRunner = async (command, env, opts) => {
  const r = await runCommand(["bash", "-c", command], { env, cwd: env.HOME || homedir(), timeoutMs: opts?.timeoutMs ?? 30_000 });
  return { exitCode: r.timedOut ? 124 : r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

/** The environment for an account's commands on this server. */
export function accountHostEnv(account: Pick<CliAccount, "cli" | "configDir">): Record<string, string> {
  return cliHostEnv(account.cli, account);
}

/** The shell prefix that points the CLI at an account on a remote computer (its own $HOME). */
export function remoteAccountPrefix(account: Pick<CliAccount, "cli" | "configDir">): string {
  const dir = account.configDir.startsWith("~/") ? `"$HOME"/${q(account.configDir.slice(2))}` : q(account.configDir);
  return `export ${CLI_CONFIG_ENV[account.cli]}=${dir}; export PATH="$HOME/.local/bin:$PATH"; mkdir -p "$${CLI_CONFIG_ENV[account.cli]}"; `;
}

export interface CliAccountReport {
  id: string;
  installed: boolean;
  version?: string;
  status?: CliAccountStatus;
  error?: string;
}

export interface AccountOps {
  run: CliCommandRunner;
  /** The env (host) or the prefix (remote) for an account's commands. */
  envFor: (a: CliAccount) => Record<string, string>;
  prefixFor: (a: CliAccount) => string;
}

export function hostAccountOps(run: CliCommandRunner = hostCommandRunner): AccountOps {
  return { run, envFor: accountHostEnv, prefixFor: (a) => `mkdir -p ${q(expandHome(a.configDir, process.env.HOME || homedir()))}; ` };
}

/** Installed version and sign-in status of an account (no secret is read). */
export async function cliAccountReport(account: CliAccount, ops: AccountOps): Promise<CliAccountReport> {
  const bin = CLI_BINARIES[account.cli];
  const env = ops.envFor(account);
  const prefix = ops.prefixFor(account);
  const v = await ops.run(`${prefix}${bin} --version`, env, { timeoutMs: 20_000 }).catch((err) => ({ exitCode: 127, stdout: "", stderr: String(err) }));
  if (v.exitCode !== 0) {
    const notFound = v.exitCode === 127 || /not found|ENOENT/i.test(v.stderr);
    return { id: account.id, installed: false, ...(notFound ? {} : { error: (v.stderr || v.stdout).slice(0, 300) }) };
  }
  const version = parseCliVersion(v.stdout || v.stderr);
  const s = await ops.run(`${prefix}${CLI_STATUS_COMMANDS[account.cli]}`, env, { timeoutMs: 20_000 }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String(err) }));
  return { id: account.id, installed: true, ...(version ? { version } : {}), status: parseCliStatus(account.cli, s) };
}

/** Sign the account out with the CLI's own command. */
export async function cliAccountLogout(account: CliAccount, ops: AccountOps): Promise<{ ok: boolean; output: string }> {
  const r = await ops.run(`${ops.prefixFor(account)}${CLI_LOGOUT_COMMANDS[account.cli]}`, ops.envFor(account), { timeoutMs: 30_000 });
  return { ok: r.exitCode === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(0, 500) };
}

/** Install the CLI with its official installer (npm global). */
export async function cliInstall(cli: CliId, ops: Pick<AccountOps, "run">, env: Record<string, string>): Promise<{ ok: boolean; output: string; version?: string }> {
  const r = await ops.run(CLI_INSTALL_COMMANDS[cli], env, { timeoutMs: 300_000 });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  if (r.exitCode !== 0) return { ok: false, output: output.slice(-1500) };
  const v = await ops.run(`${CLI_BINARIES[cli]} --version`, env, { timeoutMs: 20_000 }).catch(() => undefined);
  const version = v ? parseCliVersion(v.stdout || v.stderr) : undefined;
  return { ok: true, output: output.slice(-1500), ...(version ? { version } : {}) };
}

/** The shell command the sign-in terminal runs for an account on this server (cwd: its config dir). */
export function cliLoginCommand(account: Pick<CliAccount, "cli">): string {
  return CLI_LOGIN_COMMANDS[account.cli];
}

export function isHostAccount(a: Pick<CliAccount, "computer">): boolean {
  return a.computer === HOST_COMPUTER_ID;
}
