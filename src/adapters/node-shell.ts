/**
 * Node.js Shell implementation — wraps execa.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 */
import { execaCommand } from "execa";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { bashSafeEnv } from "../tools/safe-env.js";

export class NodeShell implements Shell {
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    try {
      const result = await execaCommand(command, {
        shell: true,
        cwd: options?.cwd,
        env: { ...bashSafeEnv(), ...options?.env },
        timeout: options?.timeout,
        reject: false,
      });
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
}
