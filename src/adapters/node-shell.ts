/**
 * Node.js Shell implementation — wraps child_process.exec.
 *
 * Default implementation for self-hosted mode. Executes real shell commands.
 * Drop-in replacement pattern: swap with JustBashShell, SandboxProxyShell, etc.
 */
import { exec } from "node:child_process";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";

export class NodeShell implements Shell {
  async execute(command: string, options?: ShellOptions): Promise<ShellResult> {
    return new Promise((resolve) => {
      exec(command, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        timeout: options?.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? (error as any).code ?? 1 : 0,
        });
      });
    });
  }
}
