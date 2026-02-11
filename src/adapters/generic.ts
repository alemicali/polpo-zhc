import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentAdapter, AgentHandle } from "../core/adapter.js";
import { createActivity, registerAdapter } from "./registry.js";

const DEFAULT_TIMEOUT = 10 * 60 * 1000;

export function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Generic process adapter.
 * Spawns any command as a child process. Works with Aider, OpenCode,
 * custom scripts, or any CLI tool.
 *
 * Command template supports:
 *   {prompt}    — replaced with shell-escaped prompt text
 *   {taskFile}  — replaced with path to a temp file containing the prompt
 */
class GenericAdapter implements AgentAdapter {
  readonly name = "generic";

  spawn(agent: AgentConfig, task: Task, cwd: string): AgentHandle {
    const activity = createActivity();
    let alive = true;

    const command = agent.command;
    if (!command) {
      throw new Error(`Agent "${agent.name}" uses generic adapter but has no command defined`);
    }

    const prompt = `${task.title}\n\n${task.description}`;

    // Write prompt to temp file for {taskFile}
    const tmpDir = join(cwd, ".polpo", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, `prompt-${randomBytes(8).toString("hex")}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");

    // Replace placeholders
    let cmd = command;
    cmd = cmd.replace("{prompt}", shellEscape(prompt));
    cmd = cmd.replace("{taskFile}", tmpFile);

    const start = Date.now();

    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      activity.lastUpdate = new Date().toISOString();
      // Try to extract useful info from stdout
      const text = chunk.toString();
      if (text.trim()) {
        activity.summary = text.trim().slice(-200);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5_000);
    }, DEFAULT_TIMEOUT);

    const cleanup = () => {
      alive = false;
      try { unlinkSync(tmpFile); } catch {}
    };

    const done = new Promise<TaskResult>((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        cleanup();
        const duration = Date.now() - start;
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();

        if (killed) {
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr: stderr + `\n[polpo] Process timed out after ${DEFAULT_TIMEOUT}ms`,
            duration,
          });
          return;
        }

        resolve({ exitCode: code ?? 0, stdout, stderr, duration });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        cleanup();
        resolve({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: err.message,
          duration: Date.now() - start,
        });
      });
    });

    return {
      agentName: agent.name,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      pid: child.pid ?? 0,
      activity,
      done,
      isAlive: () => alive,
      kill: () => {
        if (alive) {
          child.kill("SIGTERM");
          setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
        }
      },
    };
  }
}

// Register this adapter
registerAdapter("generic", () => new GenericAdapter());

export { GenericAdapter };
