import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task, TaskExpectation, ExpectedOutcome, RetryPolicy, ReviewContext, ScopedNotificationRules } from "./types.js";
import { setAssessment } from "./types.js";
import { sanitizeExpectations } from "./schemas.js";

/**
 * Task CRUD: add, update, retry, reassess, kill, abort, clear.
 */
export class TaskManager {
  private idMap = new Map<string, string>();

  constructor(private ctx: OrchestratorContext) {}

  addTask(opts: {
    title: string;
    description: string;
    assignTo: string;
    expectations?: TaskExpectation[];
    expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[];
    group?: string;
    maxDuration?: number;
    retryPolicy?: RetryPolicy;
    notifications?: ScopedNotificationRules;
    draft?: boolean;
  }): Task {
    if (!this.ctx.registry) throw new Error("Orchestrator not initialized");

    // Run before:task:create hook (sync — addTask is synchronous)
    const hookResult = this.ctx.hooks.runBeforeSync("task:create", {
      title: opts.title,
      description: opts.description,
      assignTo: opts.assignTo,
      expectations: opts.expectations,
      expectedOutcomes: opts.expectedOutcomes,
      dependsOn: opts.dependsOn,
      group: opts.group,
      maxDuration: opts.maxDuration,
      retryPolicy: opts.retryPolicy,
      notifications: opts.notifications,
      draft: opts.draft,
    });
    if (hookResult.cancelled) {
      throw new Error(`Task creation blocked by hook: ${hookResult.cancelReason ?? "no reason"}`);
    }
    // Apply any modifications from hooks
    const hookData = hookResult.data;

    const rawExps = hookData.expectations ?? [];
    const { valid: expectations, warnings } = sanitizeExpectations(rawExps);
    for (const w of warnings) this.ctx.emitter.emit("log", { level: "warn", message: `[addTask "${hookData.title}"] ${w}` });
    const task = this.ctx.registry.addTask({
      title: hookData.title,
      description: hookData.description,
      assignTo: hookData.assignTo,
      group: hookData.group,
      dependsOn: hookData.dependsOn ?? [],
      expectations,
      expectedOutcomes: hookData.expectedOutcomes,
      metrics: [],
      maxRetries: this.ctx.config.settings.maxRetries,
      maxDuration: hookData.maxDuration,
      retryPolicy: hookData.retryPolicy,
      notifications: hookData.notifications,
      status: hookData.draft ? "draft" : undefined,
    });
    this.ctx.emitter.emit("task:created", { task });

    // Fire after:task:create hook (async, fire-and-forget)
    this.ctx.hooks.runAfter("task:create", {
      title: task.title,
      description: task.description,
      assignTo: task.assignTo,
      expectations: task.expectations,
      dependsOn: task.dependsOn,
      group: task.group,
    }).catch(() => { /* hook errors are logged internally */ });

    return task;
  }

  updateTaskDescription(taskId: string, description: string): void {
    this.ctx.registry.updateTask(taskId, { description });
  }

  updateTaskAssignment(taskId: string, agentName: string): void {
    this.ctx.registry.updateTask(taskId, { assignTo: agentName });
  }

  updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): void {
    const task = this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const editable = ["pending", "failed", "done"];
    if (!editable.includes(task.status)) {
      throw new Error(`Cannot edit expectations of task in "${task.status}" state`);
    }
    const { valid, warnings } = sanitizeExpectations(expectations);
    for (const w of warnings) this.ctx.emitter.emit("log", { level: "warn", message: `[updateExpectations "${taskId}"] ${w}` });
    this.ctx.registry.updateTask(taskId, { expectations: valid });
    this.ctx.emitter.emit("task:updated", { task: this.ctx.registry.getTask(taskId)! });
  }

  retryTask(taskId: string): void {
    const task = this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "failed") throw new Error(`Cannot retry task in "${task.status}" state`);
    this.ctx.registry.transition(taskId, "pending");
  }

  async reassessTask(taskId: string): Promise<void> {
    const task = this.ctx.registry.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "done" && task.status !== "failed") {
      throw new Error(`Cannot reassess task in "${task.status}" state`);
    }
    if (task.expectations.length === 0 && task.metrics.length === 0) {
      throw new Error("Task has no expectations or metrics to assess");
    }

    this.ctx.emitter.emit("assessment:started", { taskId });
    const result = task.result ?? { exitCode: 0, stdout: "", stderr: "", duration: 0 };
    const onProgress = (msg: string) => this.ctx.emitter.emit("assessment:progress", { taskId, message: msg });

    // Build ReviewContext from RunStore (same as initial assessment)
    const run = this.ctx.runStore.getRunByTaskId(taskId);
    const activity = run?.activity;
    const reviewContext: ReviewContext = {
      taskTitle: task.title,
      taskDescription: task.originalDescription ?? task.description,
      agentOutput: result.stdout || undefined,
      filesCreated: activity?.filesCreated,
      filesEdited: activity?.filesEdited,
    };

    try {
      const assessment = await this.ctx.assessFn(task, this.ctx.workDir, onProgress, reviewContext);
      setAssessment(result, assessment, "reassess");
      this.ctx.registry.updateTask(taskId, { result });

      if (assessment.passed) {
        this.ctx.emitter.emit("assessment:complete", {
          taskId,
          passed: true,
          scores: assessment.scores,
          globalScore: assessment.globalScore,
          message: `Reassessment PASSED`,
        });
        if (task.status === "failed") {
          this.ctx.registry.transition(taskId, "pending");
          this.ctx.registry.transition(taskId, "assigned");
          this.ctx.registry.transition(taskId, "in_progress");
          this.ctx.registry.transition(taskId, "review");
          this.ctx.registry.transition(taskId, "done");
        }
      } else {
        const reasons = [
          ...assessment.checks.filter(c => !c.passed).map(c => `${c.type}: ${c.message}`),
          ...assessment.metrics.filter(m => !m.passed).map(m => `${m.name}: ${m.value} < ${m.threshold}`),
        ];
        this.ctx.emitter.emit("assessment:complete", {
          taskId,
          passed: false,
          scores: assessment.scores,
          globalScore: assessment.globalScore,
          message: `Reassessment FAILED — ${reasons.join(", ")}`,
        });
        if (task.status === "done") {
          this.ctx.registry.unsafeSetStatus(taskId, "failed", "reassessment invalidated done task");
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", { level: "error", message: `[${taskId}] Reassessment error: ${message}` });
    }
  }

  killTask(taskId: string): boolean {
    const run = this.ctx.runStore.getRunByTaskId(taskId);
    if (run && run.status === "running" && run.pid > 0) {
      try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
    }
    const task = this.ctx.registry.getTask(taskId);
    if (!task) return false;
    if (task.status !== "done" && task.status !== "failed") {
      try {
        if (task.status === "pending") this.ctx.registry.transition(taskId, "assigned");
        if (task.status === "assigned") this.ctx.registry.transition(taskId, "in_progress");
        this.ctx.registry.transition(taskId, "failed");
      } catch { /* transition race — force status */
        this.ctx.registry.unsafeSetStatus(taskId, "failed", "killTask transition race fallback");
      }
    }
    return true;
  }

  abortGroup(group: string): number {
    const tasks = this.ctx.registry.getAllTasks().filter(t => t.group === group);
    let count = 0;
    for (const task of tasks) {
      if (task.status === "done" || task.status === "failed") continue;
      this.killTask(task.id);
      count++;
    }
    const plan = this.ctx.registry.getPlanByName?.(group);
    if (plan && plan.status === "active") {
      this.ctx.registry.updatePlan?.(plan.id, { status: "cancelled" });
    }
    return count;
  }

  clearTasks(filter: (task: Task) => boolean): number {
    const tasks = this.ctx.registry.getAllTasks().filter(filter);
    for (const task of tasks) {
      const run = this.ctx.runStore.getRunByTaskId(task.id);
      if (run && run.status === "running" && run.pid > 0) {
        try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }
    return this.ctx.registry.removeTasks(filter);
  }

  /** Load initial tasks from config (non-interactive mode). */
  seedTasks(): void {
    if (!this.ctx.config.tasks.length) return;

    for (const ct of this.ctx.config.tasks) {
      const rawExps = ct.expectations ?? [];
      const { valid: expectations, warnings } = sanitizeExpectations(rawExps);
      for (const w of warnings) this.ctx.emitter.emit("log", { level: "warn", message: `[seed "${ct.title}"] ${w}` });

      const task = this.ctx.registry.addTask({
        title: ct.title,
        description: ct.description,
        assignTo: ct.assignTo,
        dependsOn: [],
        expectations,
        metrics: [],
        maxRetries: this.ctx.config.settings.maxRetries,
        maxDuration: ct.maxDuration,
        retryPolicy: ct.retryPolicy,
      });

      this.idMap.set(ct.title, task.id);
      this.idMap.set(task.id, task.id);
      this.ctx.emitter.emit("task:created", { task });
    }

    // Resolve dependencies by title → id
    for (const ct of this.ctx.config.tasks) {
      if (!ct.dependsOn?.length) continue;
      const taskId = this.idMap.get(ct.title);
      if (!taskId) continue;
      const resolved = ct.dependsOn
        .map(dep => this.idMap.get(dep))
        .filter((id): id is string => !!id);
      if (resolved.length > 0) {
        this.ctx.registry.updateTask(taskId, { dependsOn: resolved });
      }
    }
  }

  /** Force a task through the state machine to failed (used by deadlock resolver). */
  forceFailTask(taskId: string): void {
    const task = this.ctx.registry.getTask(taskId);
    if (!task || task.status === "done" || task.status === "failed") return;
    try {
      if (task.status === "pending") this.ctx.registry.transition(taskId, "assigned");
      if (task.status === "assigned") this.ctx.registry.transition(taskId, "in_progress");
      this.ctx.registry.transition(taskId, "failed");
    } catch { /* transition race — force status */
      this.ctx.registry.unsafeSetStatus(taskId, "failed", "forceFailTask transition race fallback");
    }
  }
}
