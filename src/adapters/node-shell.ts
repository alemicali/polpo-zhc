/**
 * Node.js Shell implementation — commands on this machine.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 *
 * A timeout or an abort stops the command with everything it started (process-tree.ts): a
 * server or a `sleep` it left behind neither keeps running nor keeps the call waiting.
 */
import { execaCommand } from "execa";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { bashSafeEnv } from "../tools/safe-env.js";
import { localShell } from "../sandbox/local-shell.js";
import { runCommand } from "../sandbox/process-tree.js";

export class NodeShell implements Shell {
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    try {
      // the environment execa gave these commands: this process's, the safe set, the caller's
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, ...bashSafeEnv(), ...options?.env })) if (v !== undefined) env[k] = v;
      // On Windows, the bash agents' commands run in (local-shell.ts), so a check written for it
      // works there too; without it, cmd.exe as before. Everywhere else the system shell.
      if (process.platform === "win32" && localShell().name === "cmd.exe") return await this.executeInCmd(command, env, options);
      const argv = process.platform === "win32" ? localShell().argv(command) : ["/bin/sh", "-c", command];
      const r = await runCommand(argv, { cwd: options?.cwd, env, timeoutMs: options?.timeout, signal: options?.signal });
      let stderr = stripFinalNewline(r.stderr);
      // a command that never exited normally is a failure with a reason, never a silent one
      if (!stderr && !r.timedOut) {
        if (options?.signal?.aborted) stderr = "Command was aborted";
        else if (r.signal) stderr = `Command was killed with ${r.signal}`;
      }
      return {
        stdout: stripFinalNewline(r.stdout),
        stderr,
        exitCode: r.exitCode,
        ...(r.timedOut ? { timedOut: true } : {}),
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: err.message ?? String(err),
        exitCode: 1,
      };
    }
  }

  /** Windows without a bash: cmd.exe through execa, as before. */
  private async executeInCmd(command: string, env: Record<string, string>, options?: ShellOptions): Promise<ShellResult> {
    const result = await execaCommand(command, {
      shell: true, cwd: options?.cwd, env, timeout: options?.timeout, reject: false,
      ...(options?.signal ? { cancelSignal: options.signal } : {}),
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
      ...(result.timedOut ? { timedOut: true } : {}),
    };
  }
}

/** One trailing newline off, as execa did. */
function stripFinalNewline(s: string): string {
  return s.endsWith("\r\n") ? s.slice(0, -2) : s.endsWith("\n") ? s.slice(0, -1) : s;
}
