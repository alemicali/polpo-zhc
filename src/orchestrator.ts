import { resolve, join, dirname } from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { parseConfig } from "./config.js";
import { SqliteTaskStore } from "./stores/sqlite-task-store.js";
import { SqliteRunStore } from "./stores/sqlite-run-store.js";
import { assessTask } from "./assessment/assessor.js";
import { TypedEmitter } from "./core/events.js";
import type { TaskStore } from "./core/task-store.js";
import type { RunStore, RunRecord } from "./core/run-store.js";
import { parse as parseYaml } from "yaml";
import type {
  OrchestraConfig,
  AgentConfig,
  Task,
  TaskResult,
  TaskExpectation,
  Team,
  AssessmentResult,
  Plan,
  PlanStatus,
  RetryPolicy,
  RunnerConfig,
} from "./core/types.js";

const POLL_INTERVAL = 2000; // 2 seconds

export type AssessFn = (task: Task, cwd: string) => Promise<AssessmentResult>;

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
  private orchestraDir: string;
  private workDir: string;
  private idMap = new Map<string, string>();
  private cleanedGroups = new Set<string>(); // groups already cleaned up
  private staleWarned = new Set<string>();   // taskIds warned for stale
  private interactive = false;
  private stopped = false;
  private assessFn: AssessFn;
  private injectedStore?: TaskStore;
  private injectedRunStore?: RunStore;

  constructor(workDirOrOptions?: string | OrchestratorOptions) {
    super();
    if (typeof workDirOrOptions === "string" || workDirOrOptions === undefined) {
      const workDir = workDirOrOptions ?? ".";
      this.workDir = resolve(workDir);
      this.orchestraDir = resolve(workDir, ".orchestra");
      this.assessFn = assessTask;
    } else {
      const opts = workDirOrOptions;
      this.workDir = resolve(opts.workDir ?? ".");
      this.orchestraDir = resolve(this.workDir, ".orchestra");
      this.assessFn = opts.assessFn ?? assessTask;
      this.injectedStore = opts.store;
      this.injectedRunStore = opts.runStore;
    }
  }

  async init(): Promise<void> {
    const configPath = resolve(this.workDir, "orchestra.yml");
    this.config = await parseConfig(configPath);
    this.registry = this.injectedStore ?? new SqliteTaskStore(this.orchestraDir);
    this.runStore = this.injectedRunStore ?? new SqliteRunStore(join(this.orchestraDir, "state.db"));
  }

  /**
   * Initialize for interactive/TUI mode without requiring orchestra.yml.
   * Creates .orchestra dir and a minimal config from provided team info.
   */
  initInteractive(project: string, team: Team): void {
    if (!existsSync(this.orchestraDir)) {
      mkdirSync(this.orchestraDir, { recursive: true });
    }
    this.registry = this.injectedStore ?? new SqliteTaskStore(this.orchestraDir);
    this.runStore = this.injectedRunStore ?? new SqliteRunStore(join(this.orchestraDir, "state.db"));
    this.config = {
      version: "1",
      project,
      team,
      tasks: [],
      settings: { maxRetries: 2, workDir: ".", logLevel: "normal" },
    };
    this.interactive = true;
    this.registry.setState({
      project,
      team,
      startedAt: new Date().toISOString(),
    });

    // Recover any tasks left in limbo from a previous crash
    const recovered = this.recoverOrphanedTasks();
    if (recovered > 0) {
      this.emit("log", { level: "warn", message: `Recovered ${recovered} orphaned task(s) from previous session` });
    }
  }

  /**
   * Add a task dynamically (for interactive/TUI mode).
   * The supervisor loop will pick it up on the next tick.
   */
  addTask(opts: {
    title: string;
    description: string;
    assignTo: string;
    expectations?: TaskExpectation[];
    dependsOn?: string[];
    group?: string;
    maxDuration?: number;
    retryPolicy?: RetryPolicy;
  }): Task {
    if (!this.registry) throw new Error("Orchestrator not initialized");
    const task = this.registry.addTask({
      title: opts.title,
      description: opts.description,
      assignTo: opts.assignTo,
      group: opts.group,
      dependsOn: opts.dependsOn ?? [],
      expectations: opts.expectations ?? [],
      metrics: [],
      maxRetries: this.config.settings.maxRetries,
      maxDuration: opts.maxDuration,
      retryPolicy: opts.retryPolicy,
    });
    this.emit("task:created", { task });
    return task;
  }

  /** Update a task's description (for editing pending/failed tasks) */
  updateTaskDescription(taskId: string, description: string): void {
    this.registry.updateTask(taskId, { description });
  }

  /** Reassign a task to a different agent */
  updateTaskAssignment(taskId: string, agentName: string): void {
    this.registry.updateTask(taskId, { assignTo: agentName });
  }

  /** Force-retry a failed task by transitioning it back to pending */
  retryTask(taskId: string): void {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "failed") throw new Error(`Cannot retry task in "${task.status}" state`);
    this.registry.transition(taskId, "pending");
  }

  /** Re-run assessment only on a done/failed task (does not re-run the agent) */
  async reassessTask(taskId: string): Promise<void> {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "done" && task.status !== "failed") {
      throw new Error(`Cannot reassess task in "${task.status}" state`);
    }
    if (task.expectations.length === 0 && task.metrics.length === 0) {
      throw new Error("Task has no expectations or metrics to assess");
    }

    this.emit("assessment:started", { taskId });
    const result = task.result ?? { exitCode: 0, stdout: "", stderr: "", duration: 0 };

    try {
      const assessment = await this.assessFn(task, this.workDir);
      result.assessment = assessment;
      this.registry.updateTask(taskId, { result });

      if (assessment.passed) {
        this.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: assessment.scores,
          globalScore: assessment.globalScore,
          message: `Reassessment PASSED`,
        });
        if (task.status === "failed") {
          this.registry.transition(taskId, "pending");
          this.registry.transition(taskId, "assigned");
          this.registry.transition(taskId, "in_progress");
          this.registry.transition(taskId, "review");
          this.registry.transition(taskId, "done");
        }
      } else {
        const reasons = [
          ...assessment.checks.filter(c => !c.passed).map(c => `${c.type}: ${c.message}`),
          ...assessment.metrics.filter(m => !m.passed).map(m => `${m.name}: ${m.value} < ${m.threshold}`),
        ];
        this.emit("assessment:complete", {
          taskId,
          passed: false,
          scores: assessment.scores,
          globalScore: assessment.globalScore,
          message: `Reassessment FAILED — ${reasons.join(", ")}`,
        });
        if (task.status === "done") {
          this.registry.updateTask(taskId, { status: "failed" as any });
        }
      }
    } catch (err: any) {
      this.emit("log", { level: "error", message: `[${taskId}] Reassessment error: ${err.message}` });
    }
  }

  /** Get the task store (for external consumers like TUI) */
  getStore(): TaskStore {
    return this.registry;
  }

  /** Get the run store (for external consumers like TUI) */
  getRunStore(): RunStore {
    return this.runStore;
  }

  /** Get list of configured agents */
  getAgents(): AgentConfig[] {
    return this.config?.team.agents ?? [];
  }

  /** Get current team */
  getTeam(): Team {
    return this.config?.team ?? { name: "", agents: [] };
  }

  /** Add an agent to the team dynamically */
  addAgent(agent: AgentConfig): void {
    if (!this.config) throw new Error("Orchestrator not initialized");
    const existing = this.config.team.agents.find(a => a.name === agent.name);
    if (existing) throw new Error(`Agent "${agent.name}" already exists`);
    this.config.team.agents.push(agent);
    this.registry.setState({ team: this.config.team });
    this.emit("log", { level: "info", message: `Agent added: ${agent.name} (${agent.adapter})` });
  }

  /** Remove an agent from the team */
  removeAgent(name: string): boolean {
    if (!this.config) throw new Error("Orchestrator not initialized");
    const idx = this.config.team.agents.findIndex(a => a.name === name);
    if (idx < 0) return false;
    this.config.team.agents.splice(idx, 1);
    this.registry.setState({ team: this.config.team });
    this.emit("log", { level: "info", message: `Agent removed: ${name}` });
    return true;
  }

  /** Add a volatile agent tied to a plan group. Auto-removed when group completes. */
  addVolatileAgent(agent: AgentConfig, group: string): void {
    if (!this.config) throw new Error("Orchestrator not initialized");
    const existing = this.config.team.agents.find(a => a.name === agent.name);
    if (existing) return; // skip if name collision
    const volatileAgent: AgentConfig = { ...agent, volatile: true, planGroup: group };
    this.config.team.agents.push(volatileAgent);
    this.registry.setState({ team: this.config.team });
    this.emit("log", { level: "info", message: `Volatile agent added: ${agent.name} (${agent.adapter}) for ${group}` });
  }

  /** Remove all volatile agents tied to a plan group */
  cleanupVolatileAgents(group: string): number {
    if (!this.config) return 0;
    const before = this.config.team.agents.length;
    this.config.team.agents = this.config.team.agents.filter(
      a => !(a.volatile && a.planGroup === group)
    );
    const removed = before - this.config.team.agents.length;
    if (removed > 0) {
      this.registry.setState({ team: this.config.team });
      this.emit("log", { level: "debug", message: `Cleaned up ${removed} volatile agent(s) from ${group}` });
    }
    return removed;
  }

  /** Kill a running agent for a task and mark it as failed */
  killTask(taskId: string): boolean {
    // Kill via RunStore — find the run and SIGTERM the runner PID
    const run = this.runStore.getRunByTaskId(taskId);
    if (run && run.status === "running" && run.pid > 0) {
      try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
    }

    const task = this.registry.getTask(taskId);
    if (!task) return false;
    // Force to failed regardless of current state
    if (task.status !== "done" && task.status !== "failed") {
      try {
        if (task.status === "pending") this.registry.transition(taskId, "assigned");
        if (task.status === "assigned") this.registry.transition(taskId, "in_progress");
        this.registry.transition(taskId, "failed");
      } catch {
        // Force-set if transitions don't work
        this.registry.updateTask(taskId, { status: "failed" as any });
      }
    }
    return true;
  }

  /** Abort all tasks in a group: kill running agents, fail non-terminal tasks, remove pending */
  abortGroup(group: string): number {
    const tasks = this.registry.getAllTasks().filter(t => t.group === group);
    let count = 0;
    for (const task of tasks) {
      if (task.status === "done" || task.status === "failed") continue;
      this.killTask(task.id);
      count++;
    }
    // Update plan status
    const plan = this.registry.getPlanByName?.(group);
    if (plan && plan.status === "active") {
      this.registry.updatePlan?.(plan.id, { status: "cancelled" });
    }
    return count;
  }

  /** Remove tasks matching a filter. Kills running agents first. */
  clearTasks(filter: (task: Task) => boolean): number {
    const tasks = this.registry.getAllTasks().filter(filter);
    for (const task of tasks) {
      const run = this.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && run.pid > 0) {
        try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }
    return this.registry.removeTasks(filter);
  }

  // ─── Plan Management ────────────────────────────────────

  /** Save a plan (draft by default) */
  savePlan(opts: { yaml: string; prompt?: string; name?: string; status?: PlanStatus }): Plan {
    if (!this.registry.savePlan) throw new Error("Store does not support plans");
    const name = opts.name ?? this.registry.nextPlanName?.() ?? `plan-${Date.now()}`;
    const plan = this.registry.savePlan({
      name,
      yaml: opts.yaml,
      prompt: opts.prompt,
      status: opts.status ?? "draft",
    });
    this.emit("plan:saved", { planId: plan.id, name: plan.name, status: plan.status });
    return plan;
  }

  /** Get a plan by ID */
  getPlan(planId: string): Plan | undefined {
    return this.registry.getPlan?.(planId);
  }

  /** Get a plan by group name */
  getPlanByName(name: string): Plan | undefined {
    return this.registry.getPlanByName?.(name);
  }

  /** List all plans */
  getAllPlans(): Plan[] {
    return this.registry.getAllPlans?.() ?? [];
  }

  /** Update plan fields */
  updatePlan(planId: string, updates: { yaml?: string; status?: PlanStatus; name?: string }): Plan {
    if (!this.registry.updatePlan) throw new Error("Store does not support plans");
    return this.registry.updatePlan(planId, updates);
  }

  /** Delete a plan */
  deletePlan(planId: string): boolean {
    if (!this.registry.deletePlan) throw new Error("Store does not support plans");
    const result = this.registry.deletePlan(planId);
    if (result) this.emit("plan:deleted", { planId });
    return result;
  }

  /**
   * Execute a saved plan: parse YAML, create tasks, register volatile agents.
   * Sets plan status to "active". The supervisor loop picks up the tasks.
   */
  executePlan(planId: string): { tasks: Task[]; group: string } {
    const plan = this.registry.getPlan?.(planId);
    if (!plan) throw new Error("Plan not found");
    if (plan.status === "active") throw new Error("Plan already active");

    const doc = parseYaml(plan.yaml) as any;
    if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
      throw new Error("Plan has no tasks");
    }

    const group = plan.name;

    // Register volatile agents from the plan's team section
    if (doc.team && Array.isArray(doc.team)) {
      for (const a of doc.team) {
        if (!a.name || !a.adapter) continue;
        this.addVolatileAgent({
          name: a.name,
          adapter: a.adapter,
          model: a.model,
          role: a.role,
          systemPrompt: a.systemPrompt,
          skills: a.skills,
        }, group);
      }
    }

    // Create tasks with dependency resolution
    const titleToId = new Map<string, string>();
    const tasks: Task[] = [];
    for (const t of doc.tasks) {
      const deps = (t.dependsOn || [])
        .map((title: string) => titleToId.get(title))
        .filter((id: string | undefined): id is string => !!id);

      const task = this.addTask({
        title: t.title,
        description: t.description || t.title,
        assignTo: t.assignTo || this.config.team.agents[0]?.name || "default",
        dependsOn: deps,
        expectations: t.expectations || [],
        group,
        maxDuration: t.maxDuration,
        retryPolicy: t.retryPolicy,
      });
      titleToId.set(t.title, task.id);
      tasks.push(task);
    }

    // Mark plan as active
    this.registry.updatePlan?.(planId, { status: "active" });
    this.emit("plan:executed", { planId, group, taskCount: tasks.length });

    return { tasks, group };
  }

  /** Stop the supervisor loop (non-graceful — use gracefulStop for clean shutdown) */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Graceful shutdown: SIGTERM all runner subprocesses, wait for them to write results,
   * mark remaining orphaned tasks as failed, persist final state.
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

      // Force-mark any remaining active runs
      for (const run of this.runStore.getActiveRuns()) {
        this.runStore.completeRun(run.id, "killed", {
          exitCode: 1, stdout: "", stderr: "Killed during shutdown", duration: 0,
        });
      }
    }

    // Mark orphaned tasks as failed
    for (const run of this.runStore.getTerminalRuns()) {
      const task = this.registry.getTask(run.taskId);
      if (task && task.status !== "done" && task.status !== "failed") {
        try {
          if (task.status === "pending") this.registry.transition(run.taskId, "assigned");
          if (task.status === "assigned") this.registry.transition(run.taskId, "in_progress");
          this.registry.transition(run.taskId, "failed");
        } catch {
          this.registry.updateTask(run.taskId, { status: "failed" as any });
        }
      }
      this.runStore.deleteRun(run.id);
    }

    // Clear process list in state and close store
    this.registry.setState({ processes: [], completedAt: new Date().toISOString() });
    this.registry.close?.();
    this.runStore.close();
    this.emit("orchestrator:shutdown", {});
  }

  /**
   * Recover orphaned tasks on startup.
   * Checks RunStore for active runs — if the runner PID is still alive,
   * let it keep running (zero work lost). If PID is dead, mark as failed for retry.
   * Also handles backward-compat with old processes table.
   */
  recoverOrphanedTasks(): number {
    // Check RunStore active runs first
    const activeRuns = this.runStore.getActiveRuns();
    for (const run of activeRuns) {
      if (this.isProcessAlive(run.pid)) {
        // Runner still alive — leave it running, work is NOT lost!
        this.emit("log", { level: "info", message: `Runner PID ${run.pid} still alive for task ${run.taskId} — reconnecting` });
      } else {
        // Runner died — mark run as failed
        this.runStore.completeRun(run.id, "failed", {
          exitCode: 1, stdout: "", stderr: "Runner process died", duration: 0,
        });
      }
    }

    // Backward compat: kill orphan OS processes from old processes table
    const state = this.registry.getState();
    for (const proc of state.processes) {
      if (proc.pid > 0 && proc.alive) {
        this.killOrphanProcess(proc.pid, proc.agentName);
      }
    }

    const tasks = this.registry.getAllTasks();
    const orphanStates: Set<string> = new Set(["assigned", "in_progress", "review"]);
    let recovered = 0;

    for (const task of tasks) {
      if (!orphanStates.has(task.status)) continue;

      // Check if there's a live runner for this task
      const run = this.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && this.isProcessAlive(run.pid)) {
        // Runner still working — skip recovery for this task
        continue;
      }

      if (task.retries < task.maxRetries) {
        this.emit("task:recovered", { taskId: task.id, title: task.title, previousStatus: task.status });
        try {
          if (task.status === "assigned") this.registry.transition(task.id, "in_progress");
          if (task.status === "in_progress" || task.status === "review") {
            // Can go to failed directly
          }
          this.registry.transition(task.id, "failed");
          this.registry.transition(task.id, "pending");
        } catch {
          this.registry.updateTask(task.id, { status: "pending" as any });
        }
        recovered++;
      } else {
        this.emit("log", { level: "error", message: `Orphaned task "${task.title}" has no retries left — marking failed` });
        try {
          if (task.status === "assigned") this.registry.transition(task.id, "in_progress");
          this.registry.transition(task.id, "failed");
        } catch {
          this.registry.updateTask(task.id, { status: "failed" as any });
        }
      }
    }

    // Clear stale process list
    if (recovered > 0 || tasks.some(t => orphanStates.has(t.status))) {
      this.registry.setState({ processes: [] });
    }

    return recovered;
  }

  private isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private killOrphanProcess(pid: number, agentName: string): void {
    try {
      process.kill(pid, 0); // existence check (signal 0)
      this.emit("log", { level: "warn", message: `Killing orphan process PID ${pid} (${agentName})` });
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }, 3000);
    } catch {
      // Process already dead
    }
  }

  private seedTasks(): void {
    const existing = this.registry.getAllTasks();
    if (existing.length > 0) {
      for (const task of existing) this.idMap.set(task.title, task.id);
      return;
    }

    for (const taskDef of this.config.tasks) {
      const created = this.registry.addTask({
        title: taskDef.title,
        description: taskDef.description,
        assignTo: taskDef.assignTo,
        dependsOn: [],
        expectations: taskDef.expectations,
        metrics: taskDef.metrics,
        maxRetries: taskDef.maxRetries ?? this.config.settings.maxRetries,
      });
      this.idMap.set(taskDef.id, created.id);
    }

    for (const taskDef of this.config.tasks) {
      const registryId = this.idMap.get(taskDef.id);
      if (!registryId) continue;
      const resolvedDeps = taskDef.dependsOn
        .map((depId) => this.idMap.get(depId))
        .filter((id): id is string => !!id);
      if (resolvedDeps.length > 0) {
        this.registry.updateTask(registryId, { dependsOn: resolvedDeps });
      }
    }

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

    // Supervisor loop
    while (!this.stopped) {
      try {
        const allDone = this.tick();
        if (allDone && !this.interactive) break;
      } catch (err: any) {
        this.emit("log", { level: "error", message: `[supervisor] Error in tick: ${err.message}` });
      }
      await sleep(POLL_INTERVAL);
    }
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
    this.collectResults();

    // 2. Enforce health checks (timeouts + stale detection)
    this.enforceHealthChecks();

    // 3. Spawn agents for ready tasks
    const ready = pending.filter(task =>
      task.dependsOn.every(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status === "done";
      })
    );

    // Check for deadlock
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0) {
      this.emit("orchestrator:deadlock", { taskIds: pending.map(t => t.id) });
      for (const t of pending) {
        this.registry.transition(t.id, "assigned");
        this.registry.transition(t.id, "in_progress");
        this.registry.transition(t.id, "failed");
      }
      return true;
    }

    for (const task of ready) {
      // Check if already has an active run
      const existingRun = this.runStore.getRunByTaskId(task.id);
      if (existingRun && existingRun.status === "running") continue;
      this.spawnForTask(task);
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
    this.cleanupCompletedGroups(tasks);

    // Sync process list from RunStore for backward compat with TUI
    this.syncProcessesFromRunStore();

    return false;
  }

  /**
   * Collect results from terminal runs in the RunStore and process them.
   */
  private collectResults(): void {
    const terminalRuns = this.runStore.getTerminalRuns();
    for (const run of terminalRuns) {
      if (run.result) {
        this.handleResult(run.taskId, run.result);
      }
      this.runStore.deleteRun(run.id);
      this.staleWarned.delete(run.taskId);
    }
  }

  /**
   * Enforce task timeouts and detect stale agents via RunStore active runs.
   * - Hard kill at maxDuration (or default taskTimeout)
   * - Warn at staleThreshold, kill at 2x staleThreshold
   */
  private enforceHealthChecks(): void {
    const defaultTimeout = this.config.settings.taskTimeout ?? 30 * 60 * 1000;
    const staleThreshold = this.config.settings.staleThreshold ?? 5 * 60 * 1000;

    const activeRuns = this.runStore.getActiveRuns();
    for (const run of activeRuns) {
      // 1. Task timeout (hard kill)
      const task = this.registry.getTask(run.taskId);
      const timeout = task?.maxDuration ?? defaultTimeout;
      if (timeout > 0) {
        const elapsed = Date.now() - new Date(run.startedAt).getTime();
        if (elapsed > timeout) {
          this.emit("log", { level: "warn", message: `[${run.taskId}] Timed out (${Math.round(elapsed / 1000)}s)` });
          this.emit("task:timeout", { taskId: run.taskId, elapsed, timeout });
          if (run.pid > 0) {
            try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
          }
          this.staleWarned.delete(run.taskId);
          continue;
        }
      }

      // 2. Stale detection (warning at 1x, kill at 2x)
      if (staleThreshold > 0 && run.activity.lastUpdate) {
        const idle = Date.now() - new Date(run.activity.lastUpdate).getTime();

        if (idle > staleThreshold * 2) {
          this.emit("log", { level: "error", message: `[${run.taskId}] Agent unresponsive for ${Math.round(idle / 1000)}s — killing` });
          this.emit("agent:stale", { taskId: run.taskId, agentName: run.agentName, idleMs: idle, action: "killed" });
          if (run.pid > 0) {
            try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
          }
          this.staleWarned.delete(run.taskId);
        } else if (idle > staleThreshold && !this.staleWarned.has(run.taskId)) {
          this.emit("agent:stale", { taskId: run.taskId, agentName: run.agentName, idleMs: idle, action: "warning" });
          this.emit("log", { level: "warn", message: `[${run.taskId}] Agent idle for ${Math.round(idle / 1000)}s — may be stuck` });
          this.staleWarned.add(run.taskId);
        }
      }
    }
  }

  /** Sync process list from RunStore into the old processes table for TUI backward compat */
  private syncProcessesFromRunStore(): void {
    const active = this.runStore.getActiveRuns();
    this.registry.setState({
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

  private handleResult(taskId: string, result: TaskResult): void {
    const task = this.registry.getTask(taskId);
    if (!task) return;

    // Skip if already terminal
    if (task.status === "done" || task.status === "failed") return;

    this.emit("agent:finished", {
      taskId,
      agentName: task.assignTo,
      exitCode: result.exitCode,
      duration: result.duration,
    });

    // Ensure we're in review state
    if (task.status === "in_progress") {
      this.registry.transition(taskId, "review");
    }

    if (task.expectations.length > 0 || task.metrics.length > 0) {
      this.emit("assessment:started", { taskId });
      this.assessFn(task, this.workDir).then(assessment => {
        result.assessment = assessment;
        this.registry.updateTask(taskId, { result });

        if (assessment.passed) {
          this.emit("assessment:complete", {
            taskId,
            passed: true,
            scores: assessment.scores,
            globalScore: assessment.globalScore,
            message: task.title,
          });
          this.emit("task:transition", {
            taskId,
            from: "review",
            to: "done",
            task: { ...task, status: "done" },
          });
          this.registry.transition(taskId, "done");
        } else {
          const reasons = [
            ...assessment.checks.filter(c => !c.passed).map(c => `${c.type}: ${c.message}`),
            ...assessment.metrics.filter(m => !m.passed).map(m => `${m.name}: ${m.value} < ${m.threshold}`),
          ];
          this.emit("assessment:complete", {
            taskId,
            passed: false,
            scores: assessment.scores,
            globalScore: assessment.globalScore,
            message: reasons.join(", "),
          });
          this.retryOrFail(taskId, task, result);
        }
      }).catch(err => {
        this.emit("log", { level: "error", message: `[${taskId}] Assessment error: ${err.message}` });
        this.registry.updateTask(taskId, { result });
        this.retryOrFail(taskId, task, result);
      });
    } else {
      this.registry.updateTask(taskId, { result });
      if (result.exitCode === 0) {
        this.emit("task:transition", {
          taskId,
          from: "review",
          to: "done",
          task: { ...task, status: "done" },
        });
        this.registry.transition(taskId, "done");
      } else {
        this.retryOrFail(taskId, task, result);
      }
    }
  }

  private retryOrFail(taskId: string, task: Task, result: TaskResult): void {
    const current = this.registry.getTask(taskId);
    if (!current) return;

    if (current.retries < current.maxRetries) {
      const policy = current.retryPolicy ?? this.config.settings.defaultRetryPolicy;
      const nextAttempt = current.retries + 1;

      // Check if we should escalate to a different agent
      let assignTo = current.assignTo;
      if (policy?.escalateAfter !== undefined && nextAttempt >= policy.escalateAfter) {
        if (policy.fallbackAgent) {
          const fallback = this.config.team.agents.find(a => a.name === policy.fallbackAgent);
          if (fallback) {
            assignTo = policy.fallbackAgent;
            this.emit("log", { level: "info", message: `[${taskId}] Escalating to ${assignTo} (attempt ${nextAttempt})` });
          }
        }
      }

      this.emit("task:retry", { taskId, attempt: nextAttempt, maxRetries: current.maxRetries });
      this.registry.transition(taskId, "failed");
      this.registry.transition(taskId, "pending");
      this.registry.updateTask(taskId, {
        description: buildRetryPrompt(task, result),
        assignTo,
      });
    } else {
      this.emit("task:maxRetries", { taskId });
      this.registry.transition(taskId, "failed");
    }
  }

  private spawnForTask(task: Task): void {
    const agent = this.config.team.agents.find(a => a.name === task.assignTo);
    if (!agent) {
      this.emit("log", { level: "error", message: `No agent "${task.assignTo}" for task "${task.title}"` });
      this.registry.transition(task.id, "assigned");
      this.registry.transition(task.id, "in_progress");
      this.registry.transition(task.id, "failed");
      return;
    }

    this.registry.transition(task.id, "assigned");
    this.registry.transition(task.id, "in_progress");

    const runId = nanoid();
    const tmpDir = join(this.orchestraDir, "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    const configPath = join(tmpDir, `run-${runId}.json`);

    const runnerConfig: RunnerConfig = {
      runId,
      taskId: task.id,
      agent,
      task,
      dbPath: join(this.orchestraDir, "state.db"),
      cwd: this.workDir,
    };

    try {
      writeFileSync(configPath, JSON.stringify(runnerConfig, null, 2));

      const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "runner.js");
      const child = cpSpawn(process.execPath, [runnerPath, "--config", configPath], {
        detached: true,
        stdio: "ignore",
        cwd: this.workDir,
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
        activity: { filesCreated: [], filesEdited: [], toolCalls: 0, lastUpdate: now },
        configPath,
      };
      this.runStore.upsertRun(runRecord);

      this.emit("agent:spawned", {
        taskId: task.id,
        agentName: agent.name,
        adapter: agent.adapter,
        taskTitle: task.title,
      });
    } catch (err: any) {
      this.emit("log", { level: "error", message: `[${task.id}] Failed to spawn runner: ${err.message}` });
      this.registry.transition(task.id, "failed");
    }
  }

  /** Check if any plan groups have all tasks terminal, and clean up their volatile agents */
  private cleanupCompletedGroups(tasks: Task[]): void {
    const groups = new Set<string>();
    for (const t of tasks) {
      if (t.group) groups.add(t.group);
    }
    for (const group of groups) {
      if (this.cleanedGroups.has(group)) continue;
      const groupTasks = tasks.filter(t => t.group === group);
      const allTerminal = groupTasks.every(t => t.status === "done" || t.status === "failed");
      if (allTerminal) {
        this.cleanupVolatileAgents(group);
        this.cleanedGroups.add(group);

        // Auto-update plan status
        const plan = this.registry.getPlanByName?.(group);
        if (plan && plan.status === "active") {
          const allDone = groupTasks.every(t => t.status === "done");
          this.registry.updatePlan?.(plan.id, { status: allDone ? "completed" : "failed" });
          this.emit("plan:completed", { planId: plan.id, group, allPassed: allDone });
        }
      }
    }
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

/** Build the retry prompt with feedback from the previous attempt. */
export function buildRetryPrompt(task: Task, result: TaskResult): string {
  const parts = [
    task.description,
    ``,
    `PREVIOUS ATTEMPT FAILED:`,
    `Exit code: ${result.exitCode}`,
  ];
  if (result.stderr) parts.push(`Stderr: ${result.stderr.slice(0, 2000)}`);
  if (result.assessment) {
    const failed = result.assessment.checks.filter(c => !c.passed);
    if (failed.length > 0) {
      parts.push(`Failed checks:`);
      for (const c of failed) parts.push(`- ${c.type}: ${c.message} ${c.details || ""}`);
    }
    // Include dimension scores for targeted feedback
    if (result.assessment.scores && result.assessment.scores.length > 0) {
      parts.push(``, `EVALUATION SCORES (1-5):`);
      for (const s of result.assessment.scores) {
        parts.push(`- ${s.dimension}: ${s.score}/5 — ${s.reasoning}`);
      }
      if (result.assessment.globalScore !== undefined) {
        parts.push(`Global score: ${result.assessment.globalScore}/5`);
      }
      parts.push(``, `Focus on improving the lowest-scoring dimensions.`);
    } else if (result.assessment.llmReview) {
      parts.push(``, `LLM Reviewer feedback:`, result.assessment.llmReview);
    }
  }
  parts.push(``, `Please fix the issues and try again.`);
  return parts.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
