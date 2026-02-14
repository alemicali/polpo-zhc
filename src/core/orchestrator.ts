import { resolve, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { parseConfig } from "./config.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteRunStore } from "../stores/sqlite-run-store.js";
import { FileMemoryStore } from "../stores/file-memory-store.js";
import { FileLogStore } from "../stores/file-log-store.js";
import { FileSessionStore } from "../stores/file-session-store.js";
import type { SessionStore } from "./session-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import { assessTask } from "../assessment/assessor.js";
import { analyzeBlockedTasks, resolveDeadlock, isResolving } from "./deadlock-resolver.js";
import { TypedEmitter } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type {
  OrchestraConfig,
  AgentConfig,
  Task,
  TaskResult,
  TaskExpectation,
  Team,
  Plan,
  PlanStatus,
  RetryPolicy,
} from "./types.js";
import { AgentManager } from "./agent-manager.js";
import { TaskManager } from "./task-manager.js";
import { PlanExecutor } from "./plan-executor.js";
import { TaskRunner } from "./task-runner.js";
import { AssessmentOrchestrator } from "./assessment-orchestrator.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import {
  buildFixPrompt,
  buildRetryPrompt,
  sleep,
} from "./assessment-prompts.js";
import type { AssessFn } from "./orchestrator-context.js";

// Re-export for backward compatibility (consumed by core/index.ts and external modules)
export { buildFixPrompt, buildRetryPrompt };
export type { AssessFn };

const POLL_INTERVAL = 2000; // 2 seconds

export interface OrchestratorOptions {
  workDir?: string;
  store?: TaskStore;
  runStore?: RunStore;
  assessFn?: AssessFn;
}

export class Orchestrator extends TypedEmitter {
  private registry!: TaskStore;
  private runStore!: RunStore;
  private config!: OrchestraConfig;
  private polpoDir: string;
  private workDir: string;
  private interactive = false;
  private stopped = false;
  private assessFn: AssessFn;
  private injectedStore?: TaskStore;
  private injectedRunStore?: RunStore;
  private memoryStore!: MemoryStore;
  private logStore!: LogStore;
  private sessionStore!: SessionStore;

  // Managers
  private agentMgr!: AgentManager;
  private taskMgr!: TaskManager;
  private planExec!: PlanExecutor;
  private runner!: TaskRunner;
  private assessor!: AssessmentOrchestrator;

  getWorkDir(): string { return this.workDir; }

  constructor(workDirOrOptions?: string | OrchestratorOptions) {
    super();
    if (typeof workDirOrOptions === "string" || workDirOrOptions === undefined) {
      const workDir = workDirOrOptions ?? ".";
      this.workDir = resolve(workDir);
      this.polpoDir = resolve(workDir, ".polpo");
      this.assessFn = assessTask;
    } else {
      const opts = workDirOrOptions;
      this.workDir = resolve(opts.workDir ?? ".");
      this.polpoDir = resolve(this.workDir, ".polpo");
      this.assessFn = opts.assessFn ?? assessTask;
      this.injectedStore = opts.store;
      this.injectedRunStore = opts.runStore;
    }
  }

  async init(): Promise<void> {
    const configPath = resolve(this.workDir, "polpo.yml");
    this.config = await parseConfig(configPath);
    this.registry = this.injectedStore ?? new SqliteTaskStore(this.polpoDir);
    this.runStore = this.injectedRunStore ?? new SqliteRunStore(join(this.polpoDir, "state.db"));
    this.memoryStore = new FileMemoryStore(this.polpoDir);
    this.initLogStore();
    this.initSessionStore();
    this.initManagers();
  }

  /** Create manager instances with shared context. */
  private initManagers(): void {
    const ctx: OrchestratorContext = {
      emitter: this,
      registry: this.registry,
      runStore: this.runStore,
      memoryStore: this.memoryStore,
      logStore: this.logStore,
      sessionStore: this.sessionStore,
      config: this.config,
      workDir: this.workDir,
      polpoDir: this.polpoDir,
      assessFn: this.assessFn,
    };
    this.agentMgr = new AgentManager(ctx);
    this.taskMgr = new TaskManager(ctx);
    this.planExec = new PlanExecutor(ctx, this.taskMgr, this.agentMgr);
    this.runner = new TaskRunner(ctx);
    this.assessor = new AssessmentOrchestrator(ctx);
  }

  /**
   * Initialize for interactive/TUI mode without requiring polpo.yml.
   * Creates .polpo dir and a minimal config from provided team info.
   */
  initInteractive(project: string, team: Team): void {
    if (!existsSync(this.polpoDir)) {
      mkdirSync(this.polpoDir, { recursive: true });
    }
    this.registry = this.injectedStore ?? new SqliteTaskStore(this.polpoDir);
    this.runStore = this.injectedRunStore ?? new SqliteRunStore(join(this.polpoDir, "state.db"));
    this.memoryStore = new FileMemoryStore(this.polpoDir);
    this.initLogStore();
    this.initSessionStore();
    this.config = {
      version: "1",
      project,
      team,
      tasks: [],
      settings: { maxRetries: 2, workDir: ".", logLevel: "normal" },
    };
    this.initManagers();
    this.interactive = true;
    this.registry.setState({
      project,
      team,
      startedAt: new Date().toISOString(),
    });

    // Recover any tasks left in limbo from a previous crash
    const recovered = this.runner.recoverOrphanedTasks();
    if (recovered > 0) {
      this.emit("log", { level: "warn", message: `Recovered ${recovered} orphaned task(s) from previous session` });
    }
  }

  // ── Task Management (delegates to TaskManager) ──

  addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; dependsOn?: string[];
    group?: string; maxDuration?: number; retryPolicy?: RetryPolicy;
  }): Task { return this.taskMgr.addTask(opts); }
  updateTaskDescription(taskId: string, description: string): void { this.taskMgr.updateTaskDescription(taskId, description); }
  updateTaskAssignment(taskId: string, agentName: string): void { this.taskMgr.updateTaskAssignment(taskId, agentName); }
  updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): void { this.taskMgr.updateTaskExpectations(taskId, expectations); }
  retryTask(taskId: string): void { this.taskMgr.retryTask(taskId); }
  reassessTask(taskId: string): Promise<void> { return this.taskMgr.reassessTask(taskId); }
  killTask(taskId: string): boolean { return this.taskMgr.killTask(taskId); }
  abortGroup(group: string): number { return this.taskMgr.abortGroup(group); }
  clearTasks(filter: (task: Task) => boolean): number { return this.taskMgr.clearTasks(filter); }
  forceFailTask(taskId: string): void { this.taskMgr.forceFailTask(taskId); }

  // ── Store Accessors ──

  getStore(): TaskStore { return this.registry; }
  getRunStore(): RunStore { return this.runStore; }

  // ── Agent Management (delegates to AgentManager) ──

  getAgents(): AgentConfig[] { return this.agentMgr.getAgents(); }
  getTeam(): Team { return this.agentMgr.getTeam(); }
  getConfig(): OrchestraConfig | null { return this.config; }
  renameTeam(newName: string): void { this.agentMgr.renameTeam(newName); }
  addAgent(agent: AgentConfig): void { this.agentMgr.addAgent(agent); }
  removeAgent(name: string): boolean { return this.agentMgr.removeAgent(name); }
  addVolatileAgent(agent: AgentConfig, group: string): void { this.agentMgr.addVolatileAgent(agent, group); }
  cleanupVolatileAgents(group: string): number { return this.agentMgr.cleanupVolatileAgents(group); }


  // ─── Plan Management (delegates to PlanExecutor) ──

  savePlan(opts: { yaml: string; prompt?: string; name?: string; status?: PlanStatus }): Plan { return this.planExec.savePlan(opts); }
  getPlan(planId: string): Plan | undefined { return this.planExec.getPlan(planId); }
  getPlanByName(name: string): Plan | undefined { return this.planExec.getPlanByName(name); }
  getAllPlans(): Plan[] { return this.planExec.getAllPlans(); }
  updatePlan(planId: string, updates: { yaml?: string; status?: PlanStatus; name?: string }): Plan { return this.planExec.updatePlan(planId, updates); }
  deletePlan(planId: string): boolean { return this.planExec.deletePlan(planId); }

  // ─── Project Memory ──────────────────────────────────

  /** Check if project memory exists. */
  hasMemory(): boolean {
    return this.memoryStore?.exists() ?? false;
  }

  /** Get the full project memory content. */
  getMemory(): string {
    return this.memoryStore?.get() ?? "";
  }

  /** Overwrite the project memory. */
  saveMemory(content: string): void {
    this.memoryStore?.save(content);
  }

  /** Append a line to the project memory. */
  appendMemory(line: string): void {
    this.memoryStore?.append(line);
  }

  /** Get the persistent log store. */
  getLogStore(): LogStore | undefined {
    return this.logStore;
  }

  /** Initialize the persistent log store and wire it as event sink. */
  private initLogStore(): void {
    this.logStore = new FileLogStore(this.polpoDir);
    this.logStore.startSession();
    this.setLogSink(this.logStore);
    // Auto-prune: keep last 20 sessions
    try { this.logStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  /** Get the chat session store. */
  getSessionStore(): SessionStore | undefined {
    return this.sessionStore;
  }

  /** Initialize the chat session store. */
  private initSessionStore(): void {
    this.sessionStore = new FileSessionStore(this.polpoDir);
    try { this.sessionStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  // ─── Plan Resume / Execute (delegates to PlanExecutor) ──

  getResumablePlans(): Plan[] { return this.planExec.getResumablePlans(); }
  resumePlan(planId: string, opts?: { retryFailed?: boolean }): { retried: number; pending: number } { return this.planExec.resumePlan(planId, opts); }
  executePlan(planId: string): { tasks: Task[]; group: string } { return this.planExec.executePlan(planId); }

  /** Stop the supervisor loop (non-graceful — use gracefulStop for clean shutdown) */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Graceful shutdown: SIGTERM all runner subprocesses, wait for them to write results,
   * preserve completed work, leave in-progress tasks for recovery on restart.
   */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    this.stopped = true;
    const activeRuns = this.runStore.getActiveRuns();

    if (activeRuns.length > 0) {
      this.emit("log", { level: "warn", message: `Shutting down ${activeRuns.length} running agent(s)...` });

      // Send SIGTERM to all runner subprocesses
      for (const run of activeRuns) {
        if (run.pid > 0) {
          try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
        }
      }

      // Wait for runners to write their results
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stillActive = this.runStore.getActiveRuns();
        if (stillActive.length === 0) break;
        await sleep(200);
      }

      // Force-mark any remaining active runs as killed
      for (const run of this.runStore.getActiveRuns()) {
        this.runStore.completeRun(run.id, "killed", {
          exitCode: 1, stdout: "", stderr: "Killed during shutdown", duration: 0,
        });
      }
    }

    // Only save completed work — leave killed/failed tasks in current state for recovery
    for (const run of this.runStore.getTerminalRuns()) {
      const task = this.registry.getTask(run.taskId);
      if (run.status === "completed" && run.result?.exitCode === 0 && task && task.status !== "done") {
        // Agent finished successfully — save result and mark done (skip async assessment)
        try {
          this.registry.updateTask(run.taskId, { result: run.result });
          if (task.status === "pending") this.registry.transition(run.taskId, "assigned");
          if (task.status === "assigned") this.registry.transition(run.taskId, "in_progress");
          if (task.status === "in_progress") this.registry.transition(run.taskId, "review");
          this.registry.transition(run.taskId, "done");
        } catch { /* leave for recovery on restart */ }
      }
      // For killed/failed runs: task stays in current state (in_progress, assigned, etc.)
      // recoverOrphanedTasks() on restart will handle retry without burning retry count
      this.runStore.deleteRun(run.id);
    }

    // Clear process list in state and close store
    this.registry.setState({ processes: [], completedAt: new Date().toISOString() });
    this.registry.close?.();
    this.runStore.close();
    this.emit("orchestrator:shutdown", {});
    this.logStore?.close();
    this.sessionStore?.close();
  }

  /**
   * Recover orphaned tasks on startup.
   * Checks RunStore for active runs — if the runner PID is still alive,
   * let it keep running (zero work lost). If PID is dead, clean up the run.
   * Then requeue orphaned tasks to "pending" WITHOUT burning retry count
   * (shutdown interrupts are not real failures).
   */
  recoverOrphanedTasks(): number { return this.runner.recoverOrphanedTasks(); }

  private seedTasks(): void {
    this.taskMgr.seedTasks();
    // Also set initial state for non-interactive mode
    this.registry.setState({
      project: this.config.project,
      team: this.config.team,
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Main supervisor loop. Runs until all tasks are done/failed.
   * In interactive mode, keeps running and waits for new tasks.
   */
  async run(): Promise<void> {
    if (!this.interactive) {
      await this.init();
      this.seedTasks();
    }

    this.emit("orchestrator:started", {
      project: this.config.project,
      agents: this.config.team.agents.map(a => a.name),
    });

    this.stopped = false;

    // Catch unhandled promise rejections to prevent silent failures
    const rejectionHandler = (reason: unknown) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.emit("log", { level: "error", message: `Unhandled rejection in supervisor: ${msg}` });
    };
    process.on("unhandledRejection", rejectionHandler);

    // Supervisor loop
    while (!this.stopped) {
      try {
        const allDone = this.tick();
        if (allDone && !this.interactive) break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit("log", { level: "error", message: `[supervisor] Error in tick: ${message}` });
      }
      await sleep(POLL_INTERVAL);
    }

    process.removeListener("unhandledRejection", rejectionHandler);
  }

  /**
   * Single tick of the supervisor loop. Returns true when all work is done.
   */
  tick(): boolean {
    const tasks = this.registry.getAllTasks();
    if (tasks.length === 0) return !this.interactive;

    const pending = tasks.filter(t => t.status === "pending");
    const inProgress = tasks.filter(t => t.status === "in_progress" || t.status === "assigned" || t.status === "review");

    // Check if all tasks are terminal (done or failed)
    const terminal = tasks.filter(t => t.status === "done" || t.status === "failed");
    if (terminal.length === tasks.length) return true;

    // 1. Collect results from finished runners
    this.runner.collectResults((id, res) => this.assessor.handleResult(id, res));

    // 2. Enforce health checks (timeouts + stale detection)
    this.runner.enforceHealthChecks();

    // 3. Spawn agents for ready tasks (skip tasks from cancelled/completed plans)
    const ready = pending.filter(task => {
      if (task.group) {
        const plan = this.registry.getPlanByName?.(task.group);
        if (plan && (plan.status === "cancelled" || plan.status === "completed")) return false;
      }
      return task.dependsOn.every(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status === "done";
      });
    });

    // Check for deadlock: no tasks ready, none running, but some pending
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0) {
      // Async resolution already in progress — wait for next tick
      if (isResolving()) return false;

      const analysis = analyzeBlockedTasks(pending, tasks);

      if (analysis.resolvable.length > 0) {
        this.emit("deadlock:detected", {
          taskIds: pending.map(t => t.id),
          resolvableCount: analysis.resolvable.length,
        });

        // Async LLM resolution (same pattern as question detection)
        resolveDeadlock(analysis, this, this.workDir).catch(err => {
          this.emit("log", { level: "error", message: `Deadlock resolution failed: ${err.message}` });
          for (const t of pending) this.forceFailTask(t.id);
        });

        return false; // Don't terminate loop — resolution pending
      }

      // Only missing deps (unresolvable) → force-fail all
      this.emit("orchestrator:deadlock", { taskIds: pending.map(t => t.id) });
      for (const t of pending) this.forceFailTask(t.id);
      return true;
    }

    for (const task of ready) {
      // Check if already has an active run
      const existingRun = this.runStore.getRunByTaskId(task.id);
      if (existingRun && existingRun.status === "running") continue;
      this.runner.spawnForTask(task);
    }

    // Emit tick stats
    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    this.emit("orchestrator:tick", {
      pending: pending.length,
      running: inProgress.length,
      done,
      failed,
    });

    // Clean up volatile agents for completed plan groups
    this.planExec.cleanupCompletedGroups(tasks);

    // Sync process list from RunStore for backward compat with TUI
    this.runner.syncProcessesFromRunStore();

    return false;
  }

  // Assessment pipeline delegated to AssessmentOrchestrator
  /** @internal — test access only */
  private retryOrFail(taskId: string, task: Task, result: TaskResult): void {
    this.assessor.retryOrFail(taskId, task, result);
  }

  async status(): Promise<void> {
    await this.init();
    // Emit log for CLI to consume
    const tasks = this.registry.getAllTasks();
    const done = tasks.filter(t => t.status === "done");
    const failed = tasks.filter(t => t.status === "failed");
    this.emit("log", { level: "info", message: `Total: ${tasks.length} | Done: ${done.length} | Failed: ${failed.length}` });
  }
}

