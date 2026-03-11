import { join, dirname } from "node:path";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task, TaskResult, RunnerConfig } from "./types.js";
import { findAgent } from "./types.js";
import { agentMemoryScope } from "./memory-store.js";
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
  /** Tracks files already seen per task to emit incremental file:changed events */
  private knownFiles = new Map<string, Set<string>>();

  constructor(private ctx: OrchestratorContext) {}

  /**
   * Collect results from terminal runs and pass them to the callback.
   * The callback is typically the assessment pipeline (handleResult).
   */
  async collectResults(onResult: (taskId: string, result: TaskResult) => void): Promise<void> {
    const terminalRuns = await this.ctx.runStore.getTerminalRuns();
    for (const run of terminalRuns) {
      // Persist sessionId on the task before deleting the run
      const sid = run.sessionId ?? run.activity.sessionId;
      if (sid) {
        try { await this.ctx.registry.updateTask(run.taskId, { sessionId: sid }); } catch { /* task may already be gone */ }
      }
      // Persist auto-collected outcomes on the task.
      // REPLACE (not append) — each execution produces its own definitive outcomes.
      // Appending caused "exponential outcome" accumulation across retries/fix cycles.
      if (run.outcomes && run.outcomes.length > 0) {
        try {
          await this.ctx.registry.updateTask(run.taskId, { outcomes: run.outcomes });
        } catch { /* task may already be gone */ }
      }
      if (run.result) {
        // A killed run must never be treated as successful — force exitCode=1
        // even if the adapter resolved cleanly before the kill took effect.
        if (run.status === "killed" && run.result.exitCode === 0) {
          run.result.exitCode = 1;
          run.result.stderr = (run.result.stderr ? run.result.stderr + "\n" : "") + "Run was killed (timeout or shutdown)";
        }
        // For killed runs, build a diagnosis from the activity log so the retry
        // prompt tells the agent exactly what went wrong (e.g. "you got stuck
        // running `python3 server.py &` for 120s").
        if (run.status === "killed") {
          const diagnosis = this.buildTimeoutDiagnosis(run);
          if (diagnosis) {
            run.result.stderr = (run.result.stderr ? run.result.stderr + "\n" : "") + diagnosis;
          }
        }
        onResult(run.taskId, run.result);
      }
      await this.ctx.runStore.deleteRun(run.id);
      this.staleWarned.delete(run.taskId);
    }
  }

  /**
   * Read the JSONL activity log for a killed run and produce a human-readable
   * diagnosis of what the agent was doing when it timed out.
   * This gets appended to stderr so buildRetryPrompt includes it automatically.
   */
  private buildTimeoutDiagnosis(run: RunRecord): string | null {
    try {
      const logPath = join(this.ctx.polpoDir, "logs", `run-${run.id}.jsonl`);
      if (!existsSync(logPath)) return null;

      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      // Parse last N entries (skip header)
      const entries: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      if (entries.length === 0) return null;

      // Gather stats
      const toolUses = entries.filter(e => e.type === "tool_use");
      const toolResults = entries.filter(e => e.type === "tool_result");
      const assistantMsgs = entries.filter(e => e.type === "assistant");
      const activitySnaps = entries.filter(e => e.event === "activity");

      // Find the last tool_use (likely the one that blocked)
      const lastToolUse = toolUses[toolUses.length - 1];
      const lastToolResult = toolResults[toolResults.length - 1];

      // Check if last tool_use has no matching result (= it was the blocking call)
      const lastToolId = lastToolUse?.toolId as string | undefined;
      const lastResultId = lastToolResult?.toolId as string | undefined;
      const wasBlocking = lastToolId && lastToolId !== lastResultId;

      // Get activity stats from last snapshot
      const lastSnap = activitySnaps[activitySnaps.length - 1];
      const snapData = lastSnap?.data as Record<string, unknown> | undefined;

      const parts = [
        ``,
        `TIMEOUT DIAGNOSIS:`,
        `- Total tool calls attempted: ${toolUses.length}`,
        `- Total tool results received: ${toolResults.length}`,
        `- Files created: ${(snapData?.filesCreated as string[] | undefined)?.length ?? 0}`,
        `- Files edited: ${(snapData?.filesEdited as string[] | undefined)?.length ?? 0}`,
      ];

      if (wasBlocking && lastToolUse) {
        const tool = lastToolUse.tool as string;
        const input = lastToolUse.input as Record<string, unknown> | undefined;
        parts.push(
          ``,
          `BLOCKED ON: tool="${tool}"`,
        );
        if (tool === "bash" && input?.command) {
          const cmd = String(input.command);
          parts.push(
            `Command that hung: ${cmd.slice(0, 500)}`,
            ``,
            `DO NOT repeat this command. It blocks forever.`,
            `If you need to start a server, use: nohup <cmd> > /tmp/server.log 2>&1 & echo "PID=$!"`,
            `Then verify with a SEPARATE bash call: curl --max-time 5 http://127.0.0.1:<port>/`,
            `NEVER combine server start + verification in one command.`,
            `NEVER use lsof or netstat to check servers — use curl.`,
          );
        } else {
          parts.push(`Input: ${JSON.stringify(input ?? {}).slice(0, 500)}`);
        }
      } else {
        // Last tool completed — agent might have been in a loop or LLM was slow
        const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
        if (lastAssistant?.text) {
          parts.push(`Last agent message: ${String(lastAssistant.text).slice(0, 300)}`);
        }
        if (lastToolUse) {
          parts.push(`Last completed tool: ${lastToolUse.tool}`);
        }
      }

      // List files created so agent knows what's already done
      const filesCreated = (snapData?.filesCreated as string[] | undefined) ?? [];
      const filesEdited = (snapData?.filesEdited as string[] | undefined) ?? [];
      if (filesCreated.length > 0 || filesEdited.length > 0) {
        parts.push(``, `WORK ALREADY DONE (do not redo):`);
        if (filesCreated.length > 0) parts.push(`Created: ${filesCreated.join(", ")}`);
        if (filesEdited.length > 0) parts.push(`Edited: ${filesEdited.join(", ")}`);
      }

      return parts.join("\n");
    } catch {
      return null;
    }
  }

  /**
   * Enforce task timeouts and detect stale agents via RunStore active runs.
   * - Hard kill at maxDuration (or default taskTimeout)
   * - Warn at staleThreshold, kill at 2x staleThreshold
   */
  async enforceHealthChecks(): Promise<void> {
    const defaultTimeout = this.ctx.config.settings.taskTimeout ?? 30 * 60 * 1000;
    const staleThreshold = this.ctx.config.settings.staleThreshold ?? 5 * 60 * 1000;

    const activeRuns = await this.ctx.runStore.getActiveRuns();
    for (const run of activeRuns) {
      // 1. Task timeout (hard kill)
      const task = await this.ctx.registry.getTask(run.taskId);
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
          await this.ctx.runStore.completeRun(run.id, "killed", {
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
          await this.ctx.runStore.completeRun(run.id, "killed", {
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
  async syncProcessesFromRunStore(): Promise<void> {
    const active = await this.ctx.runStore.getActiveRuns();

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

        // Emit file:changed for newly created/edited files
        let known = this.knownFiles.get(r.taskId);
        if (!known) { known = new Set(); this.knownFiles.set(r.taskId, known); }
        for (const f of r.activity.filesCreated ?? []) {
          if (!known.has(f)) {
            known.add(f);
            this.ctx.emitter.emit("file:changed", { path: f, dir: dirname(f), action: "created", source: "agent" });
          }
        }
        for (const f of r.activity.filesEdited ?? []) {
          if (!known.has(f)) {
            known.add(f);
            this.ctx.emitter.emit("file:changed", { path: f, dir: dirname(f), action: "modified", source: "agent" });
          }
        }
      }
    }

    // Cleanup stale entries for tasks no longer active
    for (const taskId of this.lastActivity.keys()) {
      if (!seenTaskIds.has(taskId)) {
        this.lastActivity.delete(taskId);
        this.knownFiles.delete(taskId);
      }
    }

    await this.ctx.registry.setState({
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
  async recoverOrphanedTasks(): Promise<number> {
    // Check RunStore active runs first
    const activeRuns = await this.ctx.runStore.getActiveRuns();
    for (const run of activeRuns) {
      if (this.isProcessAlive(run.pid)) {
        // Runner still alive — leave it running, work is NOT lost!
        this.ctx.emitter.emit("log", { level: "info", message: `Runner PID ${run.pid} still alive for task ${run.taskId} — reconnecting` });
      } else {
        // Runner died — clean up the run record
        await this.ctx.runStore.completeRun(run.id, "failed", {
          exitCode: 1, stdout: "", stderr: "Runner process died", duration: 0,
        });
        await this.ctx.runStore.deleteRun(run.id);
      }
    }

    // Backward compat: kill orphan OS processes from old processes table
    const state = await this.ctx.registry.getState();
    for (const proc of state.processes) {
      if (proc.pid > 0 && proc.alive) {
        this.killOrphanProcess(proc.pid, proc.agentName);
      }
    }

    const tasks = await this.ctx.registry.getAllTasks();
    const orphanStates: Set<string> = new Set(["assigned", "in_progress", "review"]);
    let recovered = 0;

    for (const task of tasks) {
      if (!orphanStates.has(task.status)) continue;

      // Check if there's a live runner for this task
      const run = await this.ctx.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && this.isProcessAlive(run.pid)) {
        // Runner still working — skip recovery for this task
        continue;
      }

      // Recover: reset to pending WITHOUT incrementing retries.
      // Shutdown interrupts are not real failures — unsafeSetStatus bypasses
      // transition(failed → pending) which would burn a retry.
      this.ctx.emitter.emit("task:recovered", { taskId: task.id, title: task.title, previousStatus: task.status });
      await this.ctx.registry.unsafeSetStatus(task.id, "pending", "orphan recovery — shutdown interrupt");
      recovered++;
    }

    // Clear stale process list
    if (recovered > 0 || tasks.some(t => orphanStates.has(t.status))) {
      await this.ctx.registry.setState({ processes: [] });
    }

    return recovered;
  }

  isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; /* process not found */ }
  }

  async spawnForTask(task: Task): Promise<void> {
    const agent = findAgent(this.ctx.config.teams, task.assignTo);
    if (!agent) {
      this.ctx.emitter.emit("log", { level: "error", message: `No agent "${task.assignTo}" for task "${task.title}"` });
      await this.ctx.registry.transition(task.id, "assigned");
      await this.ctx.registry.transition(task.id, "in_progress");
      await this.ctx.registry.transition(task.id, "failed");
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
        await this.ctx.registry.transition(task.id, "assigned");
        await this.ctx.registry.transition(task.id, "in_progress");
        await this.ctx.registry.transition(task.id, "failed");
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

    await this.ctx.registry.transition(task.id, "assigned");
    await this.ctx.registry.transition(task.id, "in_progress");

    // Set phase if not already set (new tasks start in execution phase)
    if (!task.phase) {
      await this.ctx.registry.updateTask(task.id, { phase: "execution" });
    }

    const runId = nanoid();

    // Create per-task output directory for deliverables
    const outputDir = join(this.ctx.polpoDir, "output", task.id);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const tmpDir = join(this.ctx.polpoDir, "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    const configPath = join(tmpDir, `run-${runId}.json`);

    // Inject context into task description for agent awareness.
    // Context is prepended using XML-like tags that the agent prompt can reference.
    const taskWithContext = { ...task };
    const contextParts: string[] = [];

    // 1. Shared memory (persistent cross-session knowledge, visible to all agents)
    const sharedMemory = (await this.ctx.memoryStore?.get()) ?? "";
    if (sharedMemory) {
      contextParts.push(`<shared-memory>\n${sharedMemory}\n</shared-memory>`);
    }

    // 1b. Agent-specific memory (private knowledge for the assigned agent)
    if (task.assignTo) {
      const agentMem = (await this.ctx.memoryStore?.get(agentMemoryScope(task.assignTo))) ?? "";
      if (agentMem) {
        contextParts.push(`<agent-memory agent="${task.assignTo}">\n${agentMem}\n</agent-memory>`);
      }
    }

    // 2. System context (standing instructions from .polpo/system-context.md)
    try {
      const systemContextPath = join(this.ctx.polpoDir, "system-context.md");
      if (existsSync(systemContextPath)) {
        const systemContext = readFileSync(systemContextPath, "utf-8").trim();
        if (systemContext) {
          contextParts.push(`<system-context>\n${systemContext}\n</system-context>`);
        }
      }
    } catch { /* best effort */ }

    // 3. Mission context — if this task belongs to a mission, include the mission goal and sibling tasks
    if (task.group) {
      try {
        // Resolve mission via direct ID (preferred) or group name (legacy fallback)
        const mission = task.missionId
          ? await this.ctx.registry.getMission?.(task.missionId)
          : await this.ctx.registry.getMissionByName?.(task.group);
        const missionParts: string[] = [];

        // Original user prompt that generated this mission (the "why")
        if (mission?.prompt) {
          missionParts.push(`Mission goal: ${mission.prompt}`);
        }

        // Sibling tasks — just titles and statuses for awareness, not full descriptions
        const allTasks = await this.ctx.registry.getAllTasks();
        const siblings = allTasks.filter(t => t.group === task.group && t.id !== task.id);
        if (siblings.length > 0) {
          missionParts.push(`Other tasks in this mission:`);
          for (const s of siblings) {
            const marker = s.status === "done" ? "[done]"
              : s.status === "in_progress" ? "[in progress]"
              : s.status === "failed" ? "[failed]"
              : "[pending]";
            missionParts.push(`  ${marker} "${s.title}" → ${s.assignTo}`);
          }
        }

        if (missionParts.length > 0) {
          contextParts.push(`<mission-context>\n${missionParts.join("\n")}\n</mission-context>`);
        }
      } catch { /* best effort — mission may have been deleted */ }
    }

    if (contextParts.length > 0) {
      taskWithContext.description = contextParts.join("\n\n") + "\n\n" + task.description;
    }

    // WhatsApp tools: if agent has whatsapp_* in allowedTools and a WhatsApp channel is configured,
    // pass the DB path and profile path so the runner can create its own store + connection
    let whatsappDbPath: string | undefined;
    let whatsappProfilePath: string | undefined;
    if (agent.allowedTools?.some(t => t.toLowerCase().startsWith("whatsapp_"))) {
      const channels = this.ctx.config.settings.notifications?.channels;
      if (channels) {
        const waKey = Object.keys(channels).find(k => channels[k]?.type === "whatsapp");
        if (waKey) {
          whatsappDbPath = join(this.ctx.polpoDir, "whatsapp.db");
          const profileName = channels[waKey].profileDir ?? "default";
          whatsappProfilePath = join(this.ctx.polpoDir, "whatsapp-profiles", profileName);
        }
      }
    }

    const runnerConfig: RunnerConfig = {
      runId,
      taskId: task.id,
      agent,
      task: taskWithContext,
      polpoDir: this.ctx.polpoDir,
      cwd: this.ctx.agentWorkDir,
      outputDir,
      storage: this.ctx.config.settings.storage,
      databaseUrl: this.ctx.config.settings.databaseUrl,
      notifySocket: getSocketPath(this.ctx.polpoDir),
      emailAllowedDomains: agent.emailAllowedDomains ?? this.ctx.config.settings.emailAllowedDomains,
      reasoning: this.ctx.config.settings.reasoning,
      whatsappDbPath,
      whatsappProfilePath,
    };

    try {
      writeFileSync(configPath, JSON.stringify(runnerConfig, null, 2), { mode: 0o600 });

      // Resolve runner path: prefer compiled .js, fall back to .ts via tsx (dev mode)
      const baseDir = dirname(fileURLToPath(import.meta.url));
      const runnerJs = join(baseDir, "runner.js");
      const runnerTs = join(baseDir, "runner.ts");
      const useTs = !existsSync(runnerJs) && existsSync(runnerTs);
      const runnerPath = useTs ? runnerTs : runnerJs;

      let spawnArgs: string[];
      if (useTs) {
        // Dev mode: use tsx to run TypeScript directly.
        // Resolve tsx the same way npx does — find the CLI entry point.
        const tsxCli = join(baseDir, "../../node_modules/tsx/dist/cli.mjs");
        spawnArgs = existsSync(tsxCli)
          ? [process.execPath, tsxCli, runnerPath, "--config", configPath]
          : [process.execPath, runnerPath, "--config", configPath]; // fallback
      } else {
        spawnArgs = [process.execPath, runnerPath, "--config", configPath];
      }
      const child = cpSpawn(spawnArgs[0], spawnArgs.slice(1), {
        detached: true,
        stdio: "ignore",
        cwd: this.ctx.agentWorkDir,
      });
      child.unref();

      const now = new Date().toISOString();
      const runRecord: RunRecord = {
        id: runId,
        taskId: task.id,
        pid: child.pid ?? 0,
        agentName: agent.name,
      status: "running",
        startedAt: now,
        updatedAt: now,
        activity: { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now },
        configPath,
      };
      await this.ctx.runStore.upsertRun(runRecord);

      this.ctx.emitter.emit("agent:spawned", {
        taskId: task.id,
        agentName: agent.name,
        taskTitle: task.title,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", { level: "error", message: `[${task.id}] Failed to spawn runner: ${message}` });
      await this.ctx.registry.transition(task.id, "failed");
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
