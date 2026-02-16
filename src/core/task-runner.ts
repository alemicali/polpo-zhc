import { join, dirname } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task, TaskResult, RunnerConfig } from "./types.js";
import type { RunRecord } from "./run-store.js";
import { getSocketPath } from "./notification.js";
import { validateProviderKeys } from "../llm/pi-client.js";

/**
 * Spawns, monitors, and collects results from agent runner subprocesses.
 */
export class TaskRunner {
  private staleWarned = new Set<string>();
  /** Last known activity snapshot per taskId, used to diff and emit SSE events */
  private lastActivity = new Map<string, string>();

  constructor(private ctx: OrchestratorContext) {}

  /**
   * Collect results from terminal runs and pass them to the callback.
   * The callback is typically the assessment pipeline (handleResult).
   */
  collectResults(onResult: (taskId: string, result: TaskResult) => void): void {
    const terminalRuns = this.ctx.runStore.getTerminalRuns();
    for (const run of terminalRuns) {
      // Persist sessionId on the task before deleting the run
      const sid = run.sessionId ?? run.activity.sessionId;
      if (sid) {
        try { this.ctx.registry.updateTask(run.taskId, { sessionId: sid }); } catch { /* task may already be gone */ }
      }
      // Persist auto-collected outcomes on the task
      if (run.outcomes && run.outcomes.length > 0) {
        try {
          const task = this.ctx.registry.getTask(run.taskId);
          const existing = task?.outcomes ?? [];
          this.ctx.registry.updateTask(run.taskId, { outcomes: [...existing, ...run.outcomes] });
        } catch { /* task may already be gone */ }
      }
      if (run.result) {
        // A killed run must never be treated as successful — force exitCode=1
        // even if the adapter resolved cleanly before the kill took effect.
        if (run.status === "killed" && run.result.exitCode === 0) {
          run.result.exitCode = 1;
          run.result.stderr = (run.result.stderr ? run.result.stderr + "\n" : "") + "Run was killed (timeout or shutdown)";
        }
        onResult(run.taskId, run.result);
      }
      this.ctx.runStore.deleteRun(run.id);
      this.staleWarned.delete(run.taskId);
    }
  }

  /**
   * Enforce task timeouts and detect stale agents via RunStore active runs.
   * - Hard kill at maxDuration (or default taskTimeout)
   * - Warn at staleThreshold, kill at 2x staleThreshold
   */
  enforceHealthChecks(): void {
    const defaultTimeout = this.ctx.config.settings.taskTimeout ?? 30 * 60 * 1000;
    const staleThreshold = this.ctx.config.settings.staleThreshold ?? 5 * 60 * 1000;

    const activeRuns = this.ctx.runStore.getActiveRuns();
    for (const run of activeRuns) {
      // 1. Task timeout (hard kill)
      const task = this.ctx.registry.getTask(run.taskId);
      const timeout = task?.maxDuration ?? defaultTimeout;
      if (timeout > 0) {
        const elapsed = Date.now() - new Date(run.startedAt).getTime();
        if (elapsed > timeout) {
          this.ctx.emitter.emit("log", { level: "warn", message: `[${run.taskId}] Timed out (${Math.round(elapsed / 1000)}s)` });
          this.ctx.emitter.emit("task:timeout", { taskId: run.taskId, elapsed, timeout });
          if (run.pid > 0) {
            try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
          }
          // Mark run as killed so we don't retry every tick
          this.ctx.runStore.completeRun(run.id, "killed", {
            exitCode: 1, stdout: "", stderr: `Timed out after ${Math.round(elapsed / 1000)}s`, duration: elapsed,
          });
          this.staleWarned.delete(run.taskId);
          continue;
        }
      }

      // 2. Stale detection (warning at 1x, kill at 2x)
      if (staleThreshold > 0 && run.activity.lastUpdate) {
        const idle = Date.now() - new Date(run.activity.lastUpdate).getTime();

        if (idle > staleThreshold * 2) {
          this.ctx.emitter.emit("log", { level: "error", message: `[${run.taskId}] Agent unresponsive for ${Math.round(idle / 1000)}s — killing` });
          this.ctx.emitter.emit("agent:stale", { taskId: run.taskId, agentName: run.agentName, idleMs: idle, action: "killed" });
          if (run.pid > 0) {
            try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
          }
          // Mark run as killed so we don't retry every tick
          this.ctx.runStore.completeRun(run.id, "killed", {
            exitCode: 1, stdout: "", stderr: `Agent unresponsive for ${Math.round(idle / 1000)}s`, duration: idle,
          });
          this.staleWarned.delete(run.taskId);
        } else if (idle > staleThreshold && !this.staleWarned.has(run.taskId)) {
          this.ctx.emitter.emit("agent:stale", { taskId: run.taskId, agentName: run.agentName, idleMs: idle, action: "warning" });
          this.ctx.emitter.emit("log", { level: "warn", message: `[${run.taskId}] Agent idle for ${Math.round(idle / 1000)}s — may be stuck` });
          this.staleWarned.add(run.taskId);
        }
      }
    }
  }

  /** Sync process list from RunStore into the old processes table for TUI backward compat.
   *  Also emits `agent:activity` SSE events when activity changes (diff-based). */
  syncProcessesFromRunStore(): void {
    const active = this.ctx.runStore.getActiveRuns();

    // Emit agent:activity for each run whose activity snapshot changed
    const seenTaskIds = new Set<string>();
    for (const r of active) {
      seenTaskIds.add(r.taskId);
      const snapshot = JSON.stringify(r.activity);
      const prev = this.lastActivity.get(r.taskId);
      if (prev !== snapshot) {
        this.lastActivity.set(r.taskId, snapshot);
        this.ctx.emitter.emit("agent:activity", {
          taskId: r.taskId,
          agentName: r.agentName,
          tool: r.activity.lastTool,
          file: r.activity.lastFile,
          summary: r.activity.summary,
        });
      }
    }

    // Cleanup stale entries for tasks no longer active
    for (const taskId of this.lastActivity.keys()) {
      if (!seenTaskIds.has(taskId)) this.lastActivity.delete(taskId);
    }

    this.ctx.registry.setState({
      processes: active.map(r => ({
        agentName: r.agentName,
        pid: r.pid,
        taskId: r.taskId,
        startedAt: r.startedAt,
        alive: true,
        activity: r.activity,
      })),
    });
  }

  /**
   * Recover tasks left in limbo from a previous crash.
   * Resets orphaned tasks to pending WITHOUT burning retry count.
   */
  recoverOrphanedTasks(): number {
    // Check RunStore active runs first
    const activeRuns = this.ctx.runStore.getActiveRuns();
    for (const run of activeRuns) {
      if (this.isProcessAlive(run.pid)) {
        // Runner still alive — leave it running, work is NOT lost!
        this.ctx.emitter.emit("log", { level: "info", message: `Runner PID ${run.pid} still alive for task ${run.taskId} — reconnecting` });
      } else {
        // Runner died — clean up the run record
        this.ctx.runStore.completeRun(run.id, "failed", {
          exitCode: 1, stdout: "", stderr: "Runner process died", duration: 0,
        });
        this.ctx.runStore.deleteRun(run.id);
      }
    }

    // Backward compat: kill orphan OS processes from old processes table
    const state = this.ctx.registry.getState();
    for (const proc of state.processes) {
      if (proc.pid > 0 && proc.alive) {
        this.killOrphanProcess(proc.pid, proc.agentName);
      }
    }

    const tasks = this.ctx.registry.getAllTasks();
    const orphanStates: Set<string> = new Set(["assigned", "in_progress", "review"]);
    let recovered = 0;

    for (const task of tasks) {
      if (!orphanStates.has(task.status)) continue;

      // Check if there's a live runner for this task
      const run = this.ctx.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && this.isProcessAlive(run.pid)) {
        // Runner still working — skip recovery for this task
        continue;
      }

      // Recover: reset to pending WITHOUT incrementing retries.
      // Shutdown interrupts are not real failures — unsafeSetStatus bypasses
      // transition(failed → pending) which would burn a retry.
      this.ctx.emitter.emit("task:recovered", { taskId: task.id, title: task.title, previousStatus: task.status });
      this.ctx.registry.unsafeSetStatus(task.id, "pending", "orphan recovery — shutdown interrupt");
      recovered++;
    }

    // Clear stale process list
    if (recovered > 0 || tasks.some(t => orphanStates.has(t.status))) {
      this.ctx.registry.setState({ processes: [] });
    }

    return recovered;
  }

  isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; /* process not found */ }
  }

  spawnForTask(task: Task): void {
    const agent = this.ctx.config.team.agents.find(a => a.name === task.assignTo);
    if (!agent) {
      this.ctx.emitter.emit("log", { level: "error", message: `No agent "${task.assignTo}" for task "${task.title}"` });
      this.ctx.registry.transition(task.id, "assigned");
      this.ctx.registry.transition(task.id, "in_progress");
      this.ctx.registry.transition(task.id, "failed");
      return;
    }

    // Fail fast if the agent's model provider has no API key
    if (agent.model) {
      const missing = validateProviderKeys([agent.model]);
      if (missing.length > 0) {
        const detail = missing.map(m => `${m.provider} (${m.modelSpec})`).join(", ");
        this.ctx.emitter.emit("log", {
          level: "error",
          message: `[${task.id}] Missing API key for ${detail} — cannot spawn agent "${agent.name}"`,
        });
        this.ctx.registry.transition(task.id, "assigned");
        this.ctx.registry.transition(task.id, "in_progress");
        this.ctx.registry.transition(task.id, "failed");
        return;
      }
    }

    // Run before:task:spawn hook (sync — tick loop is synchronous)
    const hookResult = this.ctx.hooks.runBeforeSync("task:spawn", { task, agent });
    if (hookResult.cancelled) {
      this.ctx.emitter.emit("log", {
        level: "info",
        message: `[${task.id}] Spawn blocked by hook: ${hookResult.cancelReason ?? "no reason"}`,
      });
      return;  // task stays pending — will be re-evaluated next tick
    }

    this.ctx.registry.transition(task.id, "assigned");
    this.ctx.registry.transition(task.id, "in_progress");

    // Set phase if not already set (new tasks start in execution phase)
    if (!task.phase) {
      this.ctx.registry.updateTask(task.id, { phase: "execution" });
    }

    const runId = nanoid();
    const tmpDir = join(this.ctx.polpoDir, "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    const configPath = join(tmpDir, `run-${runId}.json`);

    // Inject project memory into task description for agent context
    const taskWithMemory = { ...task };
    const memory = this.ctx.memoryStore?.get() ?? "";
    if (memory) {
      taskWithMemory.description = `<project-memory>\n${memory}\n</project-memory>\n\n${task.description}`;
    }

    const runnerConfig: RunnerConfig = {
      runId,
      taskId: task.id,
      agent,
      task: taskWithMemory,
      polpoDir: this.ctx.polpoDir,
      cwd: this.ctx.workDir,
      storage: this.ctx.config.settings.storage,
      notifySocket: getSocketPath(this.ctx.polpoDir),
    };

    try {
      writeFileSync(configPath, JSON.stringify(runnerConfig, null, 2));

      const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "runner.js");
      const child = cpSpawn(process.execPath, [runnerPath, "--config", configPath], {
        detached: true,
        stdio: "ignore",
        cwd: this.ctx.workDir,
      });
      child.unref();

      const now = new Date().toISOString();
      const runRecord: RunRecord = {
        id: runId,
        taskId: task.id,
        pid: child.pid ?? 0,
        agentName: agent.name,
        adapterType: agent.adapter,
        status: "running",
        startedAt: now,
        updatedAt: now,
        activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now },
        configPath,
      };
      this.ctx.runStore.upsertRun(runRecord);

      this.ctx.emitter.emit("agent:spawned", {
        taskId: task.id,
        agentName: agent.name,
        adapter: agent.adapter,
        taskTitle: task.title,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", { level: "error", message: `[${task.id}] Failed to spawn runner: ${message}` });
      this.ctx.registry.transition(task.id, "failed");
    }
  }

  private killOrphanProcess(pid: number, agentName: string): void {
    try {
      process.kill(pid, 0); // existence check (signal 0)
      this.ctx.emitter.emit("log", { level: "warn", message: `Killing orphan process PID ${pid} (${agentName})` });
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }, 3000);
    } catch { /* process already dead */
    }
  }
}
