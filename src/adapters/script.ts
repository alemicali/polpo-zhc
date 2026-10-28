/**
 * Script tasks (@polpo-ai/core script-task.ts): Polpo runs the task's shell command itself, in the
 * task's sandbox and working directory, instead of an agent. No model is involved.
 *
 * Everything the command prints goes to script.log in the task's output folder (the tasks that
 * depend on it can read it) and to the run's transcript, as one "script" tool call.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCRIPT_ASSIGNEE } from "@polpo-ai/core";
import type { RunnerConfig, Task, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import type { Workspace } from "@polpo-ai/core/sandbox";
import { createActivity } from "./engine.js";
import { createWorkspace } from "../sandbox/manager.js";

/** The command's whole output, in the task's output folder. */
export const SCRIPT_LOG = "script.log";
/** Output kept in the task result and the transcript (the whole output is in script.log). */
const KEPT_OUTPUT_CHARS = 16_000;
/** A command that prints nothing is still working: keep the run's activity fresh for the stale check. */
const HEARTBEAT_MS = 30_000;

export function spawnScript(
  script: NonNullable<RunnerConfig["script"]>,
  task: Task,
  cwd: string,
  ctx: SpawnContext,
): AgentHandle {
  const activity = createActivity();
  const abort = new AbortController();
  let alive = true;

  const handle: AgentHandle = {
    agentName: SCRIPT_ASSIGNEE,
    taskId: task.id,
    startedAt: new Date().toISOString(),
    pid: 0, // the command runs in a child process of this runner
    activity,
    done: null as any, // set below
    isAlive: () => alive,
    kill: () => {
      abort.abort();
      alive = false;
    },
  };

  handle.done = (async (): Promise<TaskResult> => {
    const start = Date.now();
    // the runner sets onTranscript right after this function returns
    await Promise.resolve();
    const toolId = `script-${start}`;
    const firstLine = script.command.trim().split(/\r?\n/)[0] ?? "";
    activity.lastTool = "script";
    activity.toolCalls = 1;
    activity.summary = `Running: ${firstLine}`;
    handle.onTranscript?.({ type: "tool_use", tool: "script", toolId, input: { command: script.command } });

    const heartbeat = setInterval(() => { activity.lastUpdate = new Date().toISOString(); }, HEARTBEAT_MS);
    let workspace: Workspace | undefined;
    let logPath: string | undefined;
    let output = "";
    const keep = (text: string) => {
      output += text;
      if (output.length > KEPT_OUTPUT_CHARS * 2) output = output.slice(-KEPT_OUTPUT_CHARS);
    };
    const finish = (exitCode: number, stdout: string, stderr: string, note: string): TaskResult => {
      if (logPath) try { appendFileSync(logPath, `\n[${note}]\n`); } catch { /* best effort */ }
      const shown = tail(output) || "(no output)";
      handle.onTranscript?.({ type: "tool_result", toolId, tool: "script", content: `${shown}\n[${note}]`, isError: exitCode !== 0 });
      if (exitCode !== 0) handle.onTranscript?.({ type: "error", message: `Script ${note}${stderr ? `: ${tail(stderr, 500)}` : ""}` });
      activity.summary = note;
      activity.lastUpdate = new Date().toISOString();
      return { exitCode, stdout: tail(stdout), stderr: tail(stderr), duration: Date.now() - start };
    };

    try {
      const sandbox = ctx.sandbox;
      if (!sandbox) throw new Error("Script tasks need the sandbox resolved by the orchestrator");
      // remote VMs keep their files there: the output folder and the dependencies' folders would be missing
      if (sandbox.provider === "daytona" || sandbox.provider === "e2b") {
        throw new Error(`Script tasks run on this machine: the "${sandbox.provider}" sandbox is not supported for them. Use local, bwrap or docker for this task.`);
      }
      const outputDir = resolve(ctx.outputDir ?? join(cwd, "output"));
      mkdirSync(outputDir, { recursive: true });
      logPath = join(outputDir, SCRIPT_LOG);
      writeFileSync(logPath, `$ ${script.command}\n\n`);

      workspace = createWorkspace(sandbox, {
        root: cwd,
        writable: [outputDir],
        // skills and playbooks may ship the scripts it runs; the rest of .polpo stays hidden
        readable: [join(ctx.polpoDir, "skills"), join(ctx.polpoDir, "playbooks")],
        volumes: ctx.volumes ?? [],
        hide: [ctx.polpoDir],
        onNetworkDenied: ctx.onNetworkDenied,
      });
      // the deadline comes from the task's timeout, so the command stops before the run is killed
      const timeoutMs = script.deadline ? Math.max(1000, script.deadline - Date.now()) : undefined;
      const result = await workspace.exec(script.command, {
        env: script.env,
        timeoutMs,
        signal: abort.signal,
        onOutput: (chunk) => {
          keep(chunk);
          try { appendFileSync(logPath!, chunk); } catch { /* best effort */ }
          activity.lastUpdate = new Date().toISOString();
        },
      });
      if (abort.signal.aborted) return finish(1, result.stdout, result.stderr || "Stopped", "stopped");
      if (result.timedOut) {
        const seconds = Math.round((timeoutMs ?? 0) / 1000);
        return finish(result.exitCode || 124, result.stdout, `Timed out after ${seconds}s${result.stderr ? `\n${result.stderr}` : ""}`, `timed out after ${seconds}s`);
      }
      return finish(result.exitCode, result.stdout, result.stderr, `exit code ${result.exitCode}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      keep(message);
      return finish(1, "", message, "could not run");
    } finally {
      clearInterval(heartbeat);
      alive = false;
      await workspace?.dispose().catch(() => undefined);
    }
  })();

  return handle;
}

function tail(text: string, max = KEPT_OUTPUT_CHARS): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
