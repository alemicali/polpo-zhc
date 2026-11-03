/**
 * Node.js Shell implementation — wraps execa.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 */
import { execa, execaCommand } from "execa";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { bashSafeEnv } from "../tools/safe-env.js";
import { killProcessTree, localShell } from "../sandbox/local-shell.js";

export class NodeShell implements Shell {
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    try {
      const opts = {
        cwd: options?.cwd,
        env: { ...bashSafeEnv(), ...options?.env },
        timeout: options?.timeout,
        reject: false,
      } as const;
      // On Windows, the bash agents' commands run in (local-shell.ts), so a check written for it
      // works there too; without Git's bash, and on every other platform, the system shell as before.
      const bash = process.platform === "win32" && localShell().name !== "cmd.exe" ? localShell().argv(command) : undefined;
      if (bash) return await this.executeInBash(bash, opts);
      const result = await execaCommand(command, { shell: true, ...opts });
      // execa leaves exitCode undefined when the process never exited normally
      // (timeout, killed by a signal, canceled, spawn error). That is a failure,
      // never a success: report exit code 1 and surface the reason.
      const abnormal = result.exitCode === undefined
        && (result.failed || result.timedOut || result.isTerminated || result.isCanceled);
      return {
        stdout: result.stdout,
        stderr: abnormal ? (result.stderr || result.shortMessage || "Command failed") : result.stderr,
        exitCode: result.exitCode ?? (abnormal ? 1 : 0),
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: err.message ?? String(err),
        exitCode: 1,
      };
    }
  }

  /**
   * Windows with Git's bash: a timeout ends bash and every program it started (execa would end
   * bash alone, and the command it runs keeps the output open until it finishes by itself).
   */
  private async executeInBash(argv: string[], opts: { cwd?: string; env: Record<string, string | undefined>; timeout?: number }): Promise<ShellResult> {
    const sub = execa(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, reject: false });
    let timedOut = false;
    const timer = opts.timeout
      ? setTimeout(() => { timedOut = true; if (sub.pid) killProcessTree(sub.pid); }, opts.timeout)
      : undefined;
    const result = await sub;
    if (timer) clearTimeout(timer);
    if (timedOut) {
      return { stdout: result.stdout, stderr: result.stderr || `Command timed out after ${opts.timeout} milliseconds`, exitCode: result.exitCode || 1 };
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  }
}
