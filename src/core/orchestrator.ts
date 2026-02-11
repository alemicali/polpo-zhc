import { resolve, join, dirname, basename } from "node:path";
import { mkdirSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { parseConfig } from "./config.js";
import { SqliteTaskStore } from "../stores/sqlite-task-store.js";
import { SqliteRunStore } from "../stores/sqlite-run-store.js";
import { FileMemoryStore } from "../stores/file-memory-store.js";
import { FileLogStore } from "../stores/file-log-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import { assessTask } from "../assessment/assessor.js";
import { looksLikeQuestion, classifyAsQuestion } from "./question-detector.js";
import { generateAnswer } from "../llm/answer-generator.js";
import { querySDKText } from "../llm/query.js";
import { analyzeBlockedTasks, resolveDeadlock, isResolving } from "./deadlock-resolver.js";
import { TypedEmitter } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore, RunRecord } from "./run-store.js";
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
  PlanReport,
} from "./types.js";
import { sanitizeExpectations } from "./schemas.js";

const POLL_INTERVAL = 2000; // 2 seconds

export type AssessFn = (task: Task, cwd: string, onProgress?: (msg: string) => void) => Promise<AssessmentResult>;

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
  private idMap = new Map<string, string>();
  private cleanedGroups = new Set<string>(); // groups already cleaned up
  private staleWarned = new Set<string>();   // taskIds warned for stale
  private interactive = false;
  private stopped = false;
  private assessFn: AssessFn;
  private injectedStore?: TaskStore;
  private injectedRunStore?: RunStore;
  private memoryStore!: MemoryStore;
  private logStore!: LogStore;

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
    const rawExps = opts.expectations ?? [];
    const { valid: expectations, warnings } = sanitizeExpectations(rawExps);
    for (const w of warnings) this.emit("log", { level: "warn", message: `[addTask "${opts.title}"] ${w}` });
    const task = this.registry.addTask({
      title: opts.title,
      description: opts.description,
      assignTo: opts.assignTo,
      group: opts.group,
      dependsOn: opts.dependsOn ?? [],
      expectations,
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

  /** Update a task's expectations (acceptance criteria). Only for pending/failed/done tasks. */
  updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): void {
    const task = this.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const editable = ["pending", "failed", "done"];
    if (!editable.includes(task.status)) {
      throw new Error(`Cannot edit expectations of task in "${task.status}" state`);
    }
    const { valid, warnings } = sanitizeExpectations(expectations);
    for (const w of warnings) this.emit("log", { level: "warn", message: `[updateExpectations "${taskId}"] ${w}` });
    this.registry.updateTask(taskId, { expectations: valid });
    this.emit("task:updated", { task: this.registry.getTask(taskId)! });
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
    const onProgress = (msg: string) => this.emit("assessment:progress", { taskId, message: msg });

    try {
      const assessment = await this.assessFn(task, this.workDir, onProgress);
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
          this.registry.updateTask(taskId, { status: "failed" });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "error", message: `[${taskId}] Reassessment error: ${message}` });
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

  /** Get full orchestrator config (for settings access) */
  getConfig(): OrchestraConfig | null {
    return this.config;
  }

  /** Rename the team */
  renameTeam(newName: string): void {
    if (!this.config) throw new Error("Orchestrator not initialized");
    this.config.team.name = newName;
    this.registry.setState({ team: this.config.team });
    this.emit("log", { level: "info", message: `Team renamed to "${newName}"` });
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
        this.registry.updateTask(taskId, { status: "failed" });
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
    try { this.logStore.prune(20); } catch { /* ignore */ }
  }

  // ─── Plan Resume ────────────────────────────────────

  /**
   * Get plans that can be resumed: active or failed with incomplete tasks.
   */
  getResumablePlans(): Plan[] {
    const plans = this.getAllPlans();
    const state = this.registry.getState();
    return plans.filter(p => {
      if (p.status === "draft" || p.status === "completed" || p.status === "cancelled") return false;
      const tasks = state.tasks.filter(t => t.group === p.name);
      if (tasks.length === 0) return false;
      return tasks.some(t => t.status === "pending" || t.status === "failed");
    });
  }

  /**
   * Resume an interrupted plan.
   * Optionally retries all failed tasks. Sets plan status back to "active".
   * The supervisor loop picks up pending/retried tasks automatically.
   */
  resumePlan(planId: string, opts?: { retryFailed?: boolean }): { retried: number; pending: number } {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error("Plan not found");

    // Re-register volatile agents if they were cleaned up
    this.cleanedGroups.delete(plan.name);
    const enableVolatile = this.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && plan.yaml) {
      try {
        const doc = parseYaml(plan.yaml) as any;
        if (doc?.team && Array.isArray(doc.team)) {
          for (const a of doc.team) {
            if (!a.name || !a.adapter) continue;
            this.addVolatileAgent({
              name: a.name,
              adapter: a.adapter,
              model: a.model,
              role: a.role,
              systemPrompt: a.systemPrompt,
              skills: a.skills,
            }, plan.name);
          }
        }
      } catch (err) {
        this.emit("log", { level: "warn", message: `Failed to re-register volatile agents for ${plan.name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const state = this.registry.getState();
    const tasks = state.tasks.filter(t => t.group === plan.name);
    const failedTasks = tasks.filter(t => t.status === "failed");
    const pendingTasks = tasks.filter(t => t.status === "pending");

    let retried = 0;
    if (opts?.retryFailed) {
      for (const task of failedTasks) {
        try {
          this.retryTask(task.id);
          retried++;
        } catch {
          // Task may have no retries left — skip
        }
      }
    }

    if (plan.status === "failed") {
      this.updatePlan(planId, { status: "active" });
    }

    this.emit("plan:resumed", { planId, name: plan.name, retried, pending: pendingTasks.length });
    return { retried, pending: pendingTasks.length };
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
    const enableVolatile = this.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && doc.team && Array.isArray(doc.team)) {
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
  }

  /**
   * Recover orphaned tasks on startup.
   * Checks RunStore for active runs — if the runner PID is still alive,
   * let it keep running (zero work lost). If PID is dead, clean up the run.
   * Then requeue orphaned tasks to "pending" WITHOUT burning retry count
   * (shutdown interrupts are not real failures).
   */
  recoverOrphanedTasks(): number {
    // Check RunStore active runs first
    const activeRuns = this.runStore.getActiveRuns();
    for (const run of activeRuns) {
      if (this.isProcessAlive(run.pid)) {
        // Runner still alive — leave it running, work is NOT lost!
        this.emit("log", { level: "info", message: `Runner PID ${run.pid} still alive for task ${run.taskId} — reconnecting` });
      } else {
        // Runner died — clean up the run record
        this.runStore.completeRun(run.id, "failed", {
          exitCode: 1, stdout: "", stderr: "Runner process died", duration: 0,
        });
        this.runStore.deleteRun(run.id);
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

      // Recover: reset to pending WITHOUT incrementing retries.
      // Shutdown interrupts are not real failures — use updateTask directly
      // instead of transition(failed → pending) which burns a retry.
      this.emit("task:recovered", { taskId: task.id, title: task.title, previousStatus: task.status });
      this.registry.updateTask(task.id, { status: "pending" });
      recovered++;
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
    this.collectResults();

    // 2. Enforce health checks (timeouts + stale detection)
    this.enforceHealthChecks();

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
      this.registry.updateTask(taskId, { phase: "review" });
    }

    // Question detection: intercept before assessment
    const maxQRounds = this.config.settings.maxQuestionRounds ?? 2;
    const questionRounds = task.questionRounds ?? 0;
    if (result.exitCode === 0 && questionRounds < maxQRounds) {
      // Get activity from RunStore for richer heuristic
      const run = this.runStore.getRunByTaskId(taskId);
      const activity = run?.activity;
      if (looksLikeQuestion(result, activity)) {
        this.handlePossibleQuestion(taskId, task, result);
        return;
      }
    }

    this.proceedToAssessment(taskId, task, result);
  }

  /**
   * LLM-classify a potential question, then either resolve+rerun or proceed to assessment.
   */
  private handlePossibleQuestion(taskId: string, task: Task, result: TaskResult): void {
    classifyAsQuestion(result.stdout, this.workDir, this.config.settings.orchestratorModel).then(classification => {
      if (classification.isQuestion) {
        this.resolveAndRerun(taskId, task, result, classification.question);
      } else {
        this.proceedToAssessment(taskId, task, result);
      }
    }).catch(() => {
      // Classification failed → proceed normally
      this.proceedToAssessment(taskId, task, result);
    });
  }

  /**
   * Auto-answer an agent's question and re-run the task (no retry burn).
   */
  private resolveAndRerun(taskId: string, task: Task, result: TaskResult, question: string): void {
    this.emit("task:question", { taskId, question });

    generateAnswer(this, task, question, this.workDir, this.config.settings.orchestratorModel).then(answer => {
      this.emit("task:answered", { taskId, question, answer });

      const current = this.registry.getTask(taskId);
      if (!current) return;

      // Save original description before first Q&A
      if (!current.originalDescription) {
        this.registry.updateTask(taskId, { originalDescription: current.description });
      }

      // Append Q&A to description and re-run (no retry burn)
      const qaBlock = `\n\n[Polpo Clarification]\nQ: ${question}\nA: ${answer}`;
      this.registry.updateTask(taskId, {
        status: "pending",
        phase: "execution",
        description: current.description + qaBlock,
        questionRounds: (current.questionRounds ?? 0) + 1,
      });
    }).catch(() => {
      // Answer generation failed → proceed to assessment normally
      this.proceedToAssessment(taskId, task, result);
    });
  }

  /**
   * Standard assessment flow: run expectations/metrics, then mark done/failed/fix/retry.
   * Extracted from handleResult to allow question detection to bypass or proceed.
   */
  private proceedToAssessment(taskId: string, task: Task, result: TaskResult): void {
    if (task.expectations.length > 0 || task.metrics.length > 0) {
      this.emit("assessment:started", { taskId });
      const progressCb = (msg: string) => this.emit("assessment:progress", { taskId, message: msg });
      this.assessFn(task, this.workDir, progressCb).then(assessment => {
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
          this.registry.updateTask(taskId, { phase: undefined });
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
          // Execution OK but review failed → try correcting expectations before fix phase
          if (result.exitCode === 0) {
            this.tryAutoCorrectExpectations(taskId, task, result, assessment).then(corrected => {
              if (corrected) return;
              // Heuristic didn't help → LLM judge decides: bad expectations or bad work?
              return this.judgeExpectations(taskId, task, result, assessment).then(judged => {
                if (!judged) this.fixOrRetry(taskId, task, result);
              });
            }).catch(() => {
              this.fixOrRetry(taskId, task, result);
            });
          } else {
            this.retryOrFail(taskId, task, result);
          }
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
        this.registry.updateTask(taskId, { phase: undefined });
      } else {
        this.retryOrFail(taskId, task, result);
      }
    }
  }

  /**
   * Auto-correct expectations when assessment fails due to wrong paths.
   * If the only failures are file_exists checks with incorrect paths, search
   * for the actual files using agent activity + filesystem, update expectations,
   * and re-assess. Returns true if auto-correction succeeded (task is done).
   */
  private async tryAutoCorrectExpectations(
    taskId: string, task: Task, result: TaskResult, assessment: AssessmentResult,
  ): Promise<boolean> {
    // Only attempt if there are failed file_exists checks
    const failedChecks = assessment.checks.filter(c => !c.passed);
    const failedMetrics = assessment.metrics.filter(m => !m.passed);
    if (failedMetrics.length > 0) return false; // metrics failures can't be auto-corrected
    if (failedChecks.length === 0) return false;

    // All failed checks must be file_exists (other types can't be path-corrected)
    const nonFileFailures = failedChecks.filter(c => c.type !== "file_exists");
    if (nonFileFailures.length > 0) return false;

    // Gather agent's actual file list from activity
    const run = this.runStore.getRunByTaskId(taskId);
    const activity = run?.activity;
    const agentFiles = [
      ...(activity?.filesCreated ?? []),
      ...(activity?.filesEdited ?? []),
    ];

    // For each file_exists expectation that failed, try to find the actual path
    const corrections = new Map<number, string[]>(); // expectation index → corrected paths
    let allCorrected = true;

    for (let i = 0; i < task.expectations.length; i++) {
      const exp = task.expectations[i];
      if (exp.type !== "file_exists" || !exp.paths) continue;

      // Check if this expectation's check failed
      const check = assessment.checks.find(c => c.type === "file_exists" && !c.passed);
      if (!check) continue;

      const correctedPaths: string[] = [];
      for (const expectedPath of exp.paths) {
        if (existsSync(expectedPath)) {
          correctedPaths.push(expectedPath);
          continue;
        }

        // Try to find by basename in agent's created/edited files
        const name = basename(expectedPath);
        const match = agentFiles.find(f => basename(f) === name);
        if (match && existsSync(match)) {
          correctedPaths.push(match);
          continue;
        }

        // Try to find by basename in workDir (shallow search in common locations)
        const found = this.findFileByName(name);
        if (found) {
          correctedPaths.push(found);
          continue;
        }

        // Can't find this file — can't auto-correct
        allCorrected = false;
        break;
      }

      if (!allCorrected) break;
      if (correctedPaths.length > 0) {
        corrections.set(i, correctedPaths);
      }
    }

    if (!allCorrected || corrections.size === 0) return false;

    // Apply corrections
    const newExpectations = [...task.expectations];
    for (const [idx, paths] of corrections) {
      newExpectations[idx] = { ...newExpectations[idx], paths };
    }

    this.registry.updateTask(taskId, { expectations: newExpectations });
    this.emit("assessment:corrected", { taskId, corrections: corrections.size });

    // Re-assess with corrected expectations
    const current = this.registry.getTask(taskId);
    if (!current) return false;

    try {
      const progressCb = (msg: string) => this.emit("assessment:progress", { taskId, message: msg });
      const newAssessment = await this.assessFn(current, this.workDir, progressCb);
      result.assessment = newAssessment;
      this.registry.updateTask(taskId, { result });

      if (newAssessment.passed) {
        this.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: newAssessment.scores,
          globalScore: newAssessment.globalScore,
          message: `${task.title} (paths auto-corrected)`,
        });
        this.registry.transition(taskId, "done");
        this.registry.updateTask(taskId, { phase: undefined });
        return true;
      }
    } catch {
      // Re-assessment failed — fall through to fix phase
    }

    return false;
  }

  /** Search for a file by name in common project locations. */
  private findFileByName(name: string): string | null {
    const searchDirs = [this.workDir, join(this.workDir, "src")];
    for (const dir of searchDirs) {
      const found = this.searchDir(dir, name, 4);
      if (found) return found;
    }
    return null;
  }

  /**
   * LLM judge: analyze failed expectations vs agent output and decide whether
   * the expectations are wrong (correct them) or the agent's work is wrong (fix phase).
   * Returns true if expectations were corrected and re-assessment passed.
   */
  private async judgeExpectations(
    taskId: string, task: Task, result: TaskResult, assessment: AssessmentResult,
  ): Promise<boolean> {
    const failedChecks = assessment.checks.filter(c => !c.passed);
    if (failedChecks.length === 0) return false;

    // Don't judge if score is very low — that's clearly bad work
    if (assessment.globalScore !== undefined && assessment.globalScore < 2.5) return false;

    // Gather context
    const run = this.runStore.getRunByTaskId(taskId);
    const activity = run?.activity;

    const prompt = buildJudgePrompt(task, result, assessment, failedChecks, activity);

    let response: string;
    try {
      response = await querySDKText(prompt, this.workDir, this.config.settings.orchestratorModel);
    } catch {
      return false;
    }

    // Parse LLM verdict
    let verdict: JudgeVerdict;
    try {
      const cleaned = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      verdict = JSON.parse(cleaned);
      if (!verdict.corrections || !Array.isArray(verdict.corrections)) return false;
    } catch {
      return false;
    }

    // Apply corrections only if LLM found at least one fixable expectation
    const fixable = verdict.corrections.filter((c: any) => c.verdict === "expectation_wrong" && c.fix);
    if (fixable.length === 0) return false;

    const newExpectations = [...task.expectations];
    let correctionCount = 0;

    for (const fix of fixable) {
      const idx = task.expectations.findIndex(e => e.type === fix.type);
      if (idx < 0 || !fix.fix) continue;

      const exp = newExpectations[idx];
      const f = fix.fix;
      if (fix.type === "file_exists" && f.paths) {
        newExpectations[idx] = { ...exp, paths: f.paths };
        correctionCount++;
      } else if ((fix.type === "test" || fix.type === "script") && f.command) {
        newExpectations[idx] = { ...exp, command: f.command };
        correctionCount++;
      } else if (fix.type === "llm_review" && f.threshold !== undefined) {
        newExpectations[idx] = { ...exp, threshold: f.threshold };
        correctionCount++;
      }
    }

    if (correctionCount === 0) return false;

    this.registry.updateTask(taskId, { expectations: newExpectations });
    this.emit("assessment:corrected", { taskId, corrections: correctionCount });

    // Re-assess with corrected expectations
    const current = this.registry.getTask(taskId);
    if (!current) return false;

    try {
      const progressCb = (msg: string) => this.emit("assessment:progress", { taskId, message: msg });
      const newAssessment = await this.assessFn(current, this.workDir, progressCb);
      result.assessment = newAssessment;
      this.registry.updateTask(taskId, { result });

      if (newAssessment.passed) {
        this.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: newAssessment.scores,
          globalScore: newAssessment.globalScore,
          message: `${task.title} (expectations corrected)`,
        });
        this.registry.transition(taskId, "done");
        this.registry.updateTask(taskId, { phase: undefined });
        return true;
      }
    } catch {
      // Re-assessment failed
    }

    return false;
  }

  /** Recursive directory search (bounded depth). */
  private searchDir(dir: string, name: string, maxDepth: number): string | null {
    if (maxDepth <= 0) return null;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return fullPath;
        if (entry.isDirectory()) {
          const found = this.searchDir(fullPath, name, maxDepth - 1);
          if (found) return found;
        }
      }
    } catch { /* permission error or missing dir */ }
    return null;
  }

  /**
   * Fix phase: when execution succeeded but review failed, try a targeted fix
   * without burning a full retry. After maxFixAttempts, fall back to full retry.
   */
  private fixOrRetry(taskId: string, _task: Task, result: TaskResult): void {
    const current = this.registry.getTask(taskId);
    if (!current) return;

    const maxFix = this.config.settings.maxFixAttempts ?? 2;
    const fixAttempts = (current.fixAttempts ?? 0) + 1;

    if (fixAttempts <= maxFix) {
      // Save original description before first fix/retry
      if (!current.originalDescription) {
        this.registry.updateTask(taskId, { originalDescription: current.description });
      }

      this.emit("task:fix", { taskId, attempt: fixAttempts, maxFix });

      // Use updateTask to set status directly — bypasses retry increment
      // (fix attempts are NOT real failures)
      this.registry.updateTask(taskId, {
        status: "pending",
        phase: "fix",
        fixAttempts,
        description: buildFixPrompt(current, result),
      });
    } else {
      // Fix attempts exhausted → full retry (burns 1 retry)
      this.emit("log", { level: "warn", message: `[${taskId}] Fix attempts exhausted (${maxFix}), falling back to full retry` });
      this.registry.updateTask(taskId, {
        phase: "execution",
        fixAttempts: 0,
      });
      this.retryOrFail(taskId, _task, result);
    }
  }

  private retryOrFail(taskId: string, _task: Task, result: TaskResult): void {
    const current = this.registry.getTask(taskId);
    if (!current) return;

    // Don't retry tasks from cancelled plans
    if (current.group) {
      const plan = this.registry.getPlanByName?.(current.group);
      if (plan && plan.status === "cancelled") {
        this.emit("log", { level: "debug", message: `[${taskId}] Skipping retry — plan cancelled` });
        this.registry.transition(taskId, "failed");
        return;
      }
    }

    if (current.retries < current.maxRetries) {
      const policy = current.retryPolicy ?? this.config.settings.defaultRetryPolicy;
      const nextAttempt = current.retries + 1;

      // Save original description before first retry
      if (!current.originalDescription) {
        this.registry.updateTask(taskId, { originalDescription: current.description });
      }

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
        description: buildRetryPrompt(current, result),
        assignTo,
        phase: "execution",
        fixAttempts: 0,
      });
    } else {
      this.emit("task:maxRetries", { taskId });
      this.registry.transition(taskId, "failed");
      this.registry.updateTask(taskId, { phase: undefined });
    }
  }

  /** Force-fail a task by walking it through the state machine to "failed". */
  forceFailTask(taskId: string): void {
    try {
      const task = this.registry.getTask(taskId);
      if (!task || task.status === "done" || task.status === "failed") return;
      if (task.status === "pending") this.registry.transition(taskId, "assigned");
      const t2 = this.registry.getTask(taskId);
      if (t2 && t2.status === "assigned") this.registry.transition(taskId, "in_progress");
      const t3 = this.registry.getTask(taskId);
      if (t3 && t3.status === "in_progress") this.registry.transition(taskId, "failed");
      else if (t3 && t3.status === "review") this.registry.transition(taskId, "failed");
    } catch { /* already terminal or transition error */ }
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

    // Set phase if not already set (new tasks start in execution phase)
    if (!task.phase) {
      this.registry.updateTask(task.id, { phase: "execution" });
    }

    const runId = nanoid();
    const tmpDir = join(this.polpoDir, "tmp");
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    const configPath = join(tmpDir, `run-${runId}.json`);

    // Inject project memory into task description for agent context
    const taskWithMemory = { ...task };
    const memory = this.getMemory();
    if (memory) {
      taskWithMemory.description = `<project-memory>\n${memory}\n</project-memory>\n\n${task.description}`;
    }

    const runnerConfig: RunnerConfig = {
      runId,
      taskId: task.id,
      agent,
      task: taskWithMemory,
      dbPath: join(this.polpoDir, "state.db"),
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "error", message: `[${task.id}] Failed to spawn runner: ${message}` });
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
        const cleanupPolicy = this.config.settings.volatileCleanup ?? "on_complete";
        if (cleanupPolicy === "on_complete") {
          this.cleanupVolatileAgents(group);
        }
        this.cleanedGroups.add(group);

        // Auto-update plan status
        const plan = this.registry.getPlanByName?.(group);
        if (plan && plan.status === "active") {
          const allDone = groupTasks.every(t => t.status === "done");
          this.registry.updatePlan?.(plan.id, { status: allDone ? "completed" : "failed" });
          const report = this.buildPlanReport(plan.id, group, groupTasks, allDone);
          this.emit("plan:completed", { planId: plan.id, group, allPassed: allDone, report });
        }
      }
    }
  }

  private buildPlanReport(planId: string, group: string, groupTasks: Task[], allPassed: boolean): PlanReport {
    const state = this.registry.getState();
    const processes = state?.processes ?? [];

    const allFilesCreated = new Set<string>();
    const allFilesEdited = new Set<string>();
    let totalDuration = 0;
    const scores: number[] = [];

    const taskReports = groupTasks.map(t => {
      const duration = t.result?.duration ?? 0;
      totalDuration += duration;
      const score = t.result?.assessment?.globalScore;
      if (score !== undefined) scores.push(score);

      // Get file activity from processes (may already be gone for completed tasks)
      const proc = processes.find(p => p.taskId === t.id);
      const filesCreated = proc?.activity?.filesCreated ?? [];
      const filesEdited = proc?.activity?.filesEdited ?? [];
      for (const f of filesCreated) allFilesCreated.add(f);
      for (const f of filesEdited) allFilesEdited.add(f);

      return {
        title: t.title,
        status: t.status as "done" | "failed",
        duration,
        score,
        filesCreated,
        filesEdited,
      };
    });

    const avgScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined;

    return {
      planId,
      group,
      allPassed,
      totalDuration,
      tasks: taskReports,
      filesCreated: [...allFilesCreated],
      filesEdited: [...allFilesEdited],
      avgScore,
    };
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

/** Build a targeted fix prompt — agent's work is on disk, only fix review issues. */
export function buildFixPrompt(task: Task, result: TaskResult): string {
  const base = task.originalDescription ?? task.description;
  const parts = [
    `TARGETED FIX — Your previous execution was successful (exit code 0).`,
    `The code you wrote is already on disk. Do NOT start over.`,
    ``,
    `ORIGINAL TASK: ${base}`,
    ``,
    `The reviewer found these issues:`,
  ];

  if (result.assessment) {
    const failed = result.assessment.checks.filter(c => !c.passed);
    if (failed.length > 0) {
      for (const c of failed) parts.push(`- ${c.type}: ${c.message} ${c.details || ""}`);
    }
    if (result.assessment.scores && result.assessment.scores.length > 0) {
      parts.push(``, `SCORES (1-5):`);
      for (const s of result.assessment.scores) {
        parts.push(`- ${s.dimension}: ${s.score}/5 — ${s.reasoning}`);
      }
      if (result.assessment.globalScore !== undefined) {
        parts.push(`Global score: ${result.assessment.globalScore.toFixed(1)}/5`);
      }
    } else if (result.assessment.llmReview) {
      parts.push(``, `Reviewer feedback:`, result.assessment.llmReview);
    }
  }

  parts.push(``, `Fix ONLY the issues listed above, then the task will be re-assessed.`);
  return parts.join("\n");
}

/** Build the retry prompt with feedback from the previous attempt (full restart). */
export function buildRetryPrompt(task: Task, result: TaskResult): string {
  // Use original description as base (before any fix/retry modifications)
  const base = task.originalDescription ?? task.description;
  const parts = [
    base,
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

// ── Expectation Judge ─────────────────────────────────

interface JudgeCorrectionFix {
  paths?: string[];
  command?: string;
  threshold?: number;
}

interface JudgeCorrection {
  type: string;
  verdict: "expectation_wrong" | "work_wrong";
  reason: string;
  fix?: JudgeCorrectionFix;
}

interface JudgeVerdict {
  corrections: JudgeCorrection[];
}

function buildJudgePrompt(
  task: Task,
  result: TaskResult,
  assessment: AssessmentResult,
  failedChecks: Array<{ type: string; passed: boolean; message: string; details?: string }>,
  activity?: { filesCreated: string[]; filesEdited: string[]; toolCalls: number; summary?: string },
): string {
  const parts = [
    `You are a QA judge for Polpo, an AI agent orchestration framework. An agent completed a coding task but some acceptance criteria (expectations) failed.`,
    `Your job: determine if the EXPECTATIONS are wrong (should be corrected) or if the AGENT'S WORK is wrong (needs fixing).`,
    ``,
    `## Task`,
    `Title: ${task.title}`,
    `Description: ${(task.originalDescription || task.description).slice(0, 800)}`,
    ``,
    `## Agent Output`,
    result.stdout ? `Result (last 800 chars): ${result.stdout.slice(-800)}` : "No output captured.",
  ];

  if (activity) {
    if (activity.filesCreated.length > 0) {
      parts.push(``, `Files created by agent: ${activity.filesCreated.join(", ")}`);
    }
    if (activity.filesEdited.length > 0) {
      parts.push(`Files edited by agent: ${activity.filesEdited.join(", ")}`);
    }
    parts.push(`Tool calls: ${activity.toolCalls}`);
  }

  if (assessment.globalScore !== undefined) {
    parts.push(``, `LLM Review Score: ${assessment.globalScore.toFixed(1)}/5`);
  }

  parts.push(``, `## Failed Expectations`);
  for (const check of failedChecks) {
    const expDef = task.expectations.find(e => e.type === check.type);
    parts.push(`- Type: ${check.type}`);
    parts.push(`  Failure: ${check.message}`);
    if (check.details) parts.push(`  Details: ${check.details.slice(0, 300)}`);
    if (expDef?.paths) parts.push(`  Expected paths: ${expDef.paths.join(", ")}`);
    if (expDef?.command) parts.push(`  Command: ${expDef.command}`);
    if (expDef?.threshold) parts.push(`  Threshold: ${expDef.threshold}`);
  }

  parts.push(
    ``,
    `## Instructions`,
    `For EACH failed expectation, decide:`,
    `- "expectation_wrong": The agent did good work but the expectation is misconfigured (wrong path, wrong command, threshold too strict). Provide a corrected version.`,
    `- "work_wrong": The agent genuinely didn't meet this criterion. No correction needed.`,
    ``,
    `Respond with ONLY a JSON object:`,
    `{`,
    `  "corrections": [`,
    `    {`,
    `      "type": "file_exists|test|script|llm_review",`,
    `      "verdict": "expectation_wrong|work_wrong",`,
    `      "reason": "brief explanation",`,
    `      "fix": { "paths": ["corrected/path.ts"], "command": "corrected command", "threshold": 2.5 }`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Only include "fix" when verdict is "expectation_wrong". Fix fields depend on type:`,
    `- file_exists: { "paths": [...] }`,
    `- test/script: { "command": "..." }`,
    `- llm_review: { "threshold": number }`,
  );

  return parts.join("\n");
}
