/**
 * Node.js Shell implementation — wraps execa.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 */
import { execaCommand } from "execa";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { bashSafeEnv } from "../safe-env.js";

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
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
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
