/**
 * Run a program with an argument list, never letting an argument reach a shell unquoted.
 *
 * On this machine (NodeShell) the program is spawned directly, without a shell. Through any other
 * Shell (a sandbox or a remote VM, which only take a command line) every argument is single-quoted
 * for a POSIX shell, so `$(...)`, backticks, quotes or `;` in a search pattern are plain text.
 */

import { execa } from "execa";
import type { Shell, ShellResult } from "@polpo-ai/core/shell";
import { NodeShell } from "../adapters/node-shell.js";
import { bashSafeEnv } from "./safe-env.js";

/** Single-quote `s` for a POSIX shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The command line `argv` is for a POSIX shell. */
export function argvToCommand(argv: string[]): string {
  return argv.map(shq).join(" ");
}

export interface ArgvResult extends ShellResult {
  /** The program is not installed. */
  missing?: boolean;
}

export async function execArgv(shell: Shell, argv: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {}): Promise<ArgvResult> {
  if (shell instanceof NodeShell) {
    const r = await execa(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      timeout: opts.timeout,
      reject: false,
      env: bashSafeEnv(),
      extendEnv: false,
      stripFinalNewline: false,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    const missing = (r as { code?: string }).code === "ENOENT";
    return {
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : (r.shortMessage ?? ""),
      exitCode: missing ? 127 : r.exitCode ?? 1,
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(missing ? { missing: true } : {}),
    };
  }
  const r = await shell.execute(argvToCommand(argv), { cwd: opts.cwd, timeout: opts.timeout });
  return r.exitCode === 127 && /not found|No such file/i.test(r.stderr) ? { ...r, missing: true } : r;
}
