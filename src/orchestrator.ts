import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import chalk from "chalk";
import { parseConfig } from "./config.js";
import { TaskRegistry } from "./task-registry.js";
import { getAdapter, type AgentHandle } from "./adapter.js";
import { assessTask } from "./assessor.js";
import type {
  OrchestraConfig,
  AgentConfig,
  Task,
  TaskResult,
  TaskExpectation,
  Team,
} from "./types.js";

// Import adapters so they self-register
import "./adapter-claude-sdk.js";
import "./adapter-generic.js";

const POLL_INTERVAL = 2000; // 2 seconds

export class Orchestrator {
  private registry!: TaskRegistry;
  private config!: OrchestraConfig;
  private orchestraDir: string;
  private workDir: string;
  private idMap = new Map<string, string>();
  private handles = new Map<string, AgentHandle>(); // taskId → handle
  private cleanedGroups = new Set<string>(); // groups already cleaned up
  private interactive = false;
  private stopped = false;

  constructor(workDir: string = ".") {
    this.workDir = resolve(workDir);
    this.orchestraDir = resolve(workDir, ".orchestra");
  }

  async init(): Promise<void> {
    const configPath = resolve(this.workDir, "orchestra.yml");
    this.config = await parseConfig(configPath);
    this.registry = new TaskRegistry(this.orchestraDir);
  }

  /**
   * Initialize for interactive/TUI mode without requiring orchestra.yml.
   * Creates .orchestra dir and a minimal config from provided team info.
   */
  initInteractive(project: string, team: Team): void {
    if (!existsSync(this.orchestraDir)) {
      mkdirSync(this.orchestraDir, { recursive: true });
    }
    this.registry = new TaskRegistry(this.orchestraDir);
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
      this.log(chalk.yellow(`Recovered ${recovered} orphaned task(s) from previous session`));
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
    });
    this.log(chalk.cyan(`[${task.id}] Task added: ${task.title}`));
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

    this.log(chalk.dim(`[${taskId}] Re-running assessment...`));
    const result = task.result ?? { exitCode: 0, stdout: "", stderr: "", duration: 0 };

    try {
      const assessment = await assessTask(task, this.workDir);
      result.assessment = assessment;
      this.registry.updateTask(taskId, { result });

      if (assessment.passed) {
        const scoreInfo = assessment.globalScore !== undefined
          ? ` (score: ${assessment.globalScore.toFixed(1)}/5)`
          : "";
        this.log(chalk.green(`[${taskId}] Reassessment PASSED${scoreInfo}`));
        if (task.status === "failed") {
          this.registry.transition(taskId, "pending"); // failed→pending
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
        this.log(chalk.red(`[${taskId}] Reassessment FAILED — ${reasons.join(", ")}`));
        if (task.status === "done") {
          // done→failed: need to go through state machine
          // Since we can't go done→failed directly, update status manually
          this.registry.updateTask(taskId, { status: "failed" as any });
        }
      }
    } catch (err: any) {
      this.log(chalk.red(`[${taskId}] Reassessment error: ${err.message}`));
    }
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
    this.log(chalk.cyan(`Agent added: ${agent.name} (${agent.adapter})`));
  }

  /** Remove an agent from the team */
  removeAgent(name: string): boolean {
    if (!this.config) throw new Error("Orchestrator not initialized");
    const idx = this.config.team.agents.findIndex(a => a.name === name);
    if (idx < 0) return false;
    this.config.team.agents.splice(idx, 1);
    this.registry.setState({ team: this.config.team });
    this.log(chalk.cyan(`Agent removed: ${name}`));
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
    this.log(chalk.cyan(`Volatile agent added: ${agent.name} (${agent.adapter}) for ${group}`));
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
      this.log(chalk.dim(`Cleaned up ${removed} volatile agent(s) from ${group}`));
    }
    return removed;
  }

  /** Kill a running agent for a task and mark it as failed */
  killTask(taskId: string): boolean {
    const handle = this.handles.get(taskId);
    if (handle && handle.isAlive()) {
      handle.kill();
      this.handles.delete(taskId);
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
    return count;
  }

  /** Remove tasks matching a filter. Kills running agents first. */
  clearTasks(filter: (task: Task) => boolean): number {
    const tasks = this.registry.getAllTasks().filter(filter);
    for (const task of tasks) {
      const handle = this.handles.get(task.id);
      if (handle && handle.isAlive()) {
        handle.kill();
      }
      this.handles.delete(task.id);
    }
    return this.registry.removeTasks(filter);
  }

  /** Stop the supervisor loop (non-graceful — use gracefulStop for clean shutdown) */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Graceful shutdown: kill all running agents, wait for them to finish,
   * mark orphaned tasks as failed, persist final state.
   */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    this.stopped = true;
    const activeHandles = [...this.handles.entries()].filter(([, h]) => h.isAlive());

    if (activeHandles.length > 0) {
      this.log(chalk.yellow(`Shutting down ${activeHandles.length} running agent(s)...`));

      // Send kill signal to all
      for (const [, handle] of activeHandles) {
        handle.kill();
      }

      // Wait for handles to resolve (with timeout)
      const deadline = Date.now() + timeoutMs;
      for (const [taskId, handle] of activeHandles) {
        const remaining = Math.max(0, deadline - Date.now());
        try {
          await Promise.race([
            handle.done,
            new Promise(r => setTimeout(r, remaining)),
          ]);
        } catch { /* ignore errors during shutdown */ }

        // Mark task as failed so it can be recovered on next startup
        const task = this.registry.getTask(taskId);
        if (task && task.status !== "done" && task.status !== "failed") {
          try {
            if (task.status === "pending") this.registry.transition(taskId, "assigned");
            if (task.status === "assigned") this.registry.transition(taskId, "in_progress");
            this.registry.transition(taskId, "failed");
          } catch {
            this.registry.updateTask(taskId, { status: "failed" as any });
          }
        }
        this.handles.delete(taskId);
      }
    }

    // Clear process list in state
    this.registry.setState({ processes: [], completedAt: new Date().toISOString() });
    this.log(chalk.dim("Orchestra shut down cleanly."));
  }

  /**
   * Recover orphaned tasks on startup.
   * Tasks stuck in assigned/in_progress/review have no live handle,
   * so reset them to pending for retry (if retries remaining).
   */
  recoverOrphanedTasks(): number {
    const tasks = this.registry.getAllTasks();
    const orphanStates: Set<string> = new Set(["assigned", "in_progress", "review"]);
    let recovered = 0;

    for (const task of tasks) {
      if (!orphanStates.has(task.status)) continue;

      // No handle exists for this task — it's orphaned
      if (task.retries < task.maxRetries) {
        this.log(chalk.yellow(`Recovering orphaned task: "${task.title}" (was ${task.status})`));
        // Force transition through the state machine to pending
        try {
          if (task.status === "assigned") this.registry.transition(task.id, "in_progress");
          if (task.status === "in_progress" || task.status === "review") {
            // Can go to failed directly
          }
          this.registry.transition(task.id, "failed");
          this.registry.transition(task.id, "pending");
        } catch {
          // Fallback: force-set status
          this.registry.updateTask(task.id, { status: "pending" as any });
        }
        recovered++;
      } else {
        this.log(chalk.red(`Orphaned task "${task.title}" has no retries left — marking failed`));
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

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${msg}`);
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

    this.log(chalk.bold(`Orchestra started — ${this.config.project}`));
    this.log(chalk.dim(`Team: ${this.config.team.name} | Agents: ${this.config.team.agents.map(a => a.name).join(", ")}`));
    if (!this.interactive) {
      this.log(chalk.dim(`Tasks: ${this.config.tasks.length}`));
    }
    console.log();

    this.stopped = false;

    // Supervisor loop
    while (!this.stopped) {
      try {
        const allDone = this.tick();
        if (allDone && !this.interactive) break;
      } catch (err: any) {
        this.log(chalk.red(`[supervisor] Error in tick: ${err.message}`));
      }
      await sleep(POLL_INTERVAL);
    }

    if (!this.interactive) {
      this.printReport();
    }
  }

  /**
   * Single tick of the supervisor loop. Returns true when all work is done.
   */
  private tick(): boolean {
    const tasks = this.registry.getAllTasks();
    if (tasks.length === 0) return !this.interactive; // no tasks: exit in batch, wait in interactive

    const pending = tasks.filter(t => t.status === "pending");
    const inProgress = tasks.filter(t => t.status === "in_progress" || t.status === "assigned" || t.status === "review");

    // Check if all tasks are terminal (done or failed)
    const terminal = tasks.filter(t => t.status === "done" || t.status === "failed");
    if (terminal.length === tasks.length) return true;

    // 1. Collect results from finished agents
    this.collectResults();

    // 2. Spawn agents for ready tasks
    const ready = pending.filter(task =>
      task.dependsOn.every(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status === "done";
      })
    );

    // Check for deadlock
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0) {
      this.log(chalk.red("Deadlock detected: tasks have unresolvable dependencies."));
      for (const t of pending) {
        this.registry.transition(t.id, "assigned");
        this.registry.transition(t.id, "in_progress");
        this.registry.transition(t.id, "failed");
      }
      return true;
    }

    for (const task of ready) {
      if (this.handles.has(task.id)) continue; // already spawned
      this.spawnForTask(task);
    }

    // Clean up volatile agents for completed plan groups
    this.cleanupCompletedGroups(tasks);

    // Update process list in state with activity info and real PIDs
    const processes = Array.from(this.handles.values()).map(h => ({
      agentName: h.agentName,
      pid: h.pid,
      taskId: h.taskId,
      startedAt: h.startedAt,
      alive: h.isAlive(),
      activity: h.activity,
    }));
    this.registry.setState({ processes });

    return false;
  }

  /**
   * Check all handles for completed agents and process their results.
   */
  private collectResults(): void {
    for (const [taskId, handle] of this.handles) {
      if (handle.isAlive()) continue; // still running

      // Agent finished - process result
      handle.done.then(result => {
        this.handleResult(taskId, result);
      }).catch(err => {
        this.log(chalk.red(`[collect] Error getting result for ${taskId}: ${err.message}`));
        this.handleResult(taskId, {
          exitCode: 1,
          stdout: "",
          stderr: `Orchestra error: ${err.message}`,
          duration: 0,
        });
      });

      this.handles.delete(taskId);
    }
  }

  private handleResult(taskId: string, result: TaskResult): void {
    const task = this.registry.getTask(taskId);
    if (!task) return;

    // Skip if already terminal
    if (task.status === "done" || task.status === "failed") return;

    this.log(`[${taskId}] Agent finished — exit ${result.exitCode} (${(result.duration / 1000).toFixed(1)}s)`);

    // Ensure we're in review state
    if (task.status === "in_progress") {
      this.registry.transition(taskId, "review");
    }

    if (task.expectations.length > 0 || task.metrics.length > 0) {
      this.log(chalk.dim(`[${taskId}] Running assessment...`));
      assessTask(task, this.workDir).then(assessment => {
        result.assessment = assessment;
        this.registry.updateTask(taskId, { result });

        if (assessment.passed) {
          const scoreInfo = assessment.globalScore !== undefined
            ? ` (score: ${assessment.globalScore.toFixed(1)}/5)`
            : "";
          this.log(chalk.green(`[${taskId}] PASSED${scoreInfo} — ${task.title}`));
          this.logResultSummary(taskId, result);
          this.registry.transition(taskId, "done");
        } else {
          const reasons = [
            ...assessment.checks.filter(c => !c.passed).map(c => `${c.type}: ${c.message}`),
            ...assessment.metrics.filter(m => !m.passed).map(m => `${m.name}: ${m.value} < ${m.threshold}`),
          ];
          this.log(chalk.red(`[${taskId}] FAILED — ${reasons.join(", ")}`));
          this.retryOrFail(taskId, task, result);
        }
      }).catch(err => {
        this.log(chalk.red(`[${taskId}] Assessment error: ${err.message}`));
        this.registry.updateTask(taskId, { result });
        this.retryOrFail(taskId, task, result);
      });
    } else {
      this.registry.updateTask(taskId, { result });
      if (result.exitCode === 0) {
        this.log(chalk.green(`[${taskId}] DONE — ${task.title}`));
        this.logResultSummary(taskId, result);
        this.registry.transition(taskId, "done");
      } else {
        this.log(chalk.red(`[${taskId}] FAILED (exit ${result.exitCode}) — ${task.title}`));
        this.retryOrFail(taskId, task, result);
      }
    }
  }

  private logResultSummary(taskId: string, result: TaskResult): void {
    if (!result.stdout) return;
    // Show a condensed version — first 3 non-empty lines
    const lines = result.stdout.split("\n").filter(l => l.trim()).slice(0, 3);
    for (const line of lines) {
      this.log(chalk.dim(`[${taskId}] ${line.slice(0, 120)}`));
    }
    if (result.stdout.split("\n").filter(l => l.trim()).length > 3) {
      this.log(chalk.dim(`[${taskId}] ... (use /result to see full output)`));
    }
  }

  private retryOrFail(taskId: string, task: Task, result: TaskResult): void {
    const current = this.registry.getTask(taskId);
    if (!current) return;

    if (current.retries < current.maxRetries) {
      this.log(chalk.yellow(`[${taskId}] Retrying (${current.retries + 1}/${current.maxRetries})...`));
      this.registry.transition(taskId, "failed");
      this.registry.transition(taskId, "pending");
      this.registry.updateTask(taskId, {
        description: this.buildRetryPrompt(task, result),
      });
    } else {
      this.log(chalk.red(`[${taskId}] Max retries reached — giving up`));
      this.registry.transition(taskId, "failed");
    }
  }

  private spawnForTask(task: Task): void {
    const agent = this.config.team.agents.find(a => a.name === task.assignTo);
    if (!agent) {
      this.log(chalk.red(`No agent "${task.assignTo}" for task "${task.title}"`));
      this.registry.transition(task.id, "assigned");
      this.registry.transition(task.id, "in_progress");
      this.registry.transition(task.id, "failed");
      return;
    }

    this.log(chalk.blue(`[${task.id}] Spawning "${agent.name}" (adapter: ${agent.adapter}) for: ${task.title}`));

    this.registry.transition(task.id, "assigned");
    this.registry.transition(task.id, "in_progress");

    try {
      const adapter = getAdapter(agent.adapter);
      const handle = adapter.spawn(agent, task, this.workDir);

      this.log(chalk.dim(`[${task.id}] Agent started via ${adapter.name}`));
      this.handles.set(task.id, handle);

      // When the handle finishes, it will be picked up in the next tick
      handle.done.then(() => {}).catch(() => {});
    } catch (err: any) {
      this.log(chalk.red(`[${task.id}] Failed to spawn agent: ${err.message}`));
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
      }
    }
  }

  private buildRetryPrompt(task: Task, result: TaskResult): string {
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

  private printReport(): void {
    const tasks = this.registry.getAllTasks();
    const done = tasks.filter(t => t.status === "done");
    const failed = tasks.filter(t => t.status === "failed");

    console.log(chalk.bold(`\n${"=".repeat(50)}`));
    console.log(chalk.bold(`Orchestra Report`));
    console.log(chalk.bold(`${"=".repeat(50)}`));
    console.log(`Total: ${tasks.length} | ${chalk.green(`Done: ${done.length}`)} | ${chalk.red(`Failed: ${failed.length}`)}`);

    for (const task of tasks) {
      const icon = task.status === "done" ? chalk.green("✓") : chalk.red("✗");
      const dur = task.result ? ` (${(task.result.duration / 1000).toFixed(1)}s)` : "";
      const score = task.result?.assessment?.globalScore !== undefined
        ? chalk.dim(` [${task.result.assessment.globalScore.toFixed(1)}/5]`)
        : "";
      console.log(`  ${icon} ${task.title}${dur}${score}`);
      if (task.result?.assessment?.scores) {
        for (const s of task.result.assessment.scores) {
          const color = s.score >= 4 ? chalk.green : s.score >= 3 ? chalk.yellow : chalk.red;
          console.log(chalk.dim(`     ${color(`${s.score}/5`)} ${s.dimension}`));
        }
      }
    }
    console.log(chalk.bold(`${"=".repeat(50)}\n`));
  }

  async status(): Promise<void> {
    await this.init();
    this.printReport();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
