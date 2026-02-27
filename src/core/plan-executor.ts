import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { Plan, PlanStatus, PlanReport, Task, TaskExpectation, ExpectedOutcome, PlanQualityGate, PlanCheckpoint, ScopedNotificationRules } from "./types.js";
import type { QualityController } from "../quality/quality-controller.js";
import { sanitizeExpectations } from "./schemas.js";
import { validateProviderKeys } from "../llm/pi-client.js";

interface PlanDocument {
  tasks?: Array<{
    title: string;
    description: string;
    assignTo?: string;
    dependsOn?: string[];
    expectations?: TaskExpectation[];
    expectedOutcomes?: ExpectedOutcome[];
    metrics?: unknown[];
    maxRetries?: number;
    maxDuration?: number;
    retryPolicy?: { escalateAfter?: number; fallbackAgent?: string };
    /** Per-task scoped notification rules. */
    notifications?: ScopedNotificationRules;
  }>;
  team?: Array<{
    name: string;
    role?: string;
    model?: string;
    systemPrompt?: string;
    skills?: string[];
    enableGit?: boolean;
    enableBrowser?: boolean;
    enableHttp?: boolean;
    enableMultifile?: boolean;
    enableDeps?: boolean;
    enableExcel?: boolean;
    enablePdf?: boolean;
    enableDocx?: boolean;
    enableEmail?: boolean;
    enableAudio?: boolean;
    enableImage?: boolean;
  }>;
  qualityGates?: PlanQualityGate[];
  /** Checkpoints — planned stopping points for human-in-the-loop review. */
  checkpoints?: PlanCheckpoint[];
  /** Plan-level scoped notification rules — override or extend global rules. */
  notifications?: ScopedNotificationRules;
}

/**
 * Plan CRUD + execution + resume + group lifecycle.
 */
export class PlanExecutor {
  private cleanedGroups = new Set<string>();
  /** Quality gates parsed from plan documents, keyed by plan group name */
  private gatesByGroup = new Map<string, PlanQualityGate[]>();
  /** Checkpoints parsed from plan documents, keyed by plan group name */
  private checkpointsByGroup = new Map<string, PlanCheckpoint[]>();
  /** Checkpoints that have been reached and are waiting for resume, keyed by "group:name" */
  private activeCheckpoints = new Map<string, { checkpoint: PlanCheckpoint; reachedAt: string }>();
  /** Checkpoints that have been resumed (so they don't re-trigger), keyed by "group:name" */
  private resumedCheckpoints = new Set<string>();
  /** Optional quality controller — set by orchestrator after init */
  private qualityCtrl?: QualityController;
  /** Optional notification router — for checkpoint notification rules */
  private notificationRouter?: import("../notifications/index.js").NotificationRouter;
  /** Track which checkpoint notification rules have been registered (by cpKey) */
  private registeredCheckpointRules = new Set<string>();

  constructor(
    private ctx: OrchestratorContext,
    private taskMgr: TaskManager,
    private agentMgr: AgentManager,
  ) {}

  /** Set the quality controller instance (called by Orchestrator after init). */
  setQualityController(ctrl: QualityController): void {
    this.qualityCtrl = ctrl;
  }

  /** Set the notification router — enables per-checkpoint channel routing. */
  setNotificationRouter(router: import("../notifications/index.js").NotificationRouter): void {
    this.notificationRouter = router;
  }

  /** Get quality gates for a plan group. Returns empty array if none defined. */
  getQualityGates(group: string): PlanQualityGate[] {
    return this.gatesByGroup.get(group) ?? [];
  }

  /** Get checkpoints for a plan group. Returns empty array if none defined. */
  getCheckpoints(group: string): PlanCheckpoint[] {
    return this.checkpointsByGroup.get(group) ?? [];
  }

  /**
   * Check if a task is blocked by an active (unresumed) checkpoint.
   * Returns the blocking checkpoint if found, undefined if the task can proceed.
   */
  getBlockingCheckpoint(
    group: string,
    taskTitle: string,
    taskId: string,
    tasks: Task[],
  ): { checkpoint: PlanCheckpoint; reachedAt: string } | undefined {
    const checkpoints = this.checkpointsByGroup.get(group);
    if (!checkpoints) return undefined;

    for (const cp of checkpoints) {
      // Task must be in blocksTasks
      if (!cp.blocksTasks.includes(taskTitle) && !cp.blocksTasks.includes(taskId)) {
        continue;
      }

      const cpKey = `${group}:${cp.name}`;

      // Already resumed — don't block
      if (this.resumedCheckpoints.has(cpKey)) continue;

      // Check if all afterTasks are done
      const afterTasks = tasks.filter(
        t => cp.afterTasks.includes(t.title) || cp.afterTasks.includes(t.id),
      );
      const allDone = afterTasks.length >= cp.afterTasks.length &&
        afterTasks.every(t => t.status === "done" || t.status === "failed");

      if (!allDone) {
        // afterTasks not finished yet — checkpoint not reached, don't block (deps will block naturally)
        continue;
      }

      // Checkpoint reached — activate it if not already active
      if (!this.activeCheckpoints.has(cpKey)) {
        const reachedAt = new Date().toISOString();
        this.activeCheckpoints.set(cpKey, { checkpoint: cp, reachedAt });

        // Pause the plan
        const plan = this.ctx.registry.getPlanByName?.(group);
        if (plan && plan.status === "active") {
          this.ctx.registry.updatePlan?.(plan.id, { status: "paused" });
        }

        // Register notification rules for this checkpoint's channels
        this.ensureCheckpointNotificationRules(cpKey, cp);

        // Emit event (picked up by notification router if rules are configured)
        this.ctx.emitter.emit("checkpoint:reached", {
          planId: plan?.id,
          group,
          checkpointName: cp.name,
          message: cp.message,
          afterTasks: cp.afterTasks,
          blocksTasks: cp.blocksTasks,
          reachedAt,
        });
      }

      // Return the blocking checkpoint
      const active = this.activeCheckpoints.get(cpKey)!;
      return active;
    }

    return undefined;
  }

  /**
   * Resume a checkpoint, unblocking its blocksTasks.
   * Returns true if the checkpoint was active and is now resumed, false if not found.
   */
  resumeCheckpoint(group: string, checkpointName: string): boolean {
    const cpKey = `${group}:${checkpointName}`;
    const active = this.activeCheckpoints.get(cpKey);
    if (!active) return false;

    this.resumedCheckpoints.add(cpKey);
    this.activeCheckpoints.delete(cpKey);

    // Un-pause the plan (back to active)
    const plan = this.ctx.registry.getPlanByName?.(group);
    if (plan && plan.status === "paused") {
      this.ctx.registry.updatePlan?.(plan.id, { status: "active" });
    }

    this.ctx.emitter.emit("checkpoint:resumed", {
      planId: plan?.id,
      group,
      checkpointName,
    });

    return true;
  }

  /** Get all active (unresumed) checkpoints across all plan groups. */
  getActiveCheckpoints(): Array<{ group: string; checkpointName: string; checkpoint: PlanCheckpoint; reachedAt: string }> {
    const result: Array<{ group: string; checkpointName: string; checkpoint: PlanCheckpoint; reachedAt: string }> = [];
    for (const [cpKey, data] of this.activeCheckpoints) {
      const [group, ...nameParts] = cpKey.split(":");
      const checkpointName = nameParts.join(":");
      result.push({ group, checkpointName, checkpoint: data.checkpoint, reachedAt: data.reachedAt });
    }
    return result;
  }

  /** Register dynamic notification rules for a checkpoint's notifyChannels (once per checkpoint). */
  private ensureCheckpointNotificationRules(cpKey: string, cp: PlanCheckpoint): void {
    if (!this.notificationRouter) return;
    if (!cp.notifyChannels || cp.notifyChannels.length === 0) return;
    if (this.registeredCheckpointRules.has(cpKey)) return;

    this.registeredCheckpointRules.add(cpKey);

    // Rule for checkpoint reached
    this.notificationRouter.addRule({
      id: `checkpoint-reached-${cpKey}`,
      name: `Checkpoint "${cp.name}" Reached (auto-registered)`,
      events: ["checkpoint:reached"],
      condition: { field: "checkpointName", op: "==", value: cp.name },
      channels: cp.notifyChannels,
      severity: "warning",
    });

    // Rule for checkpoint resumed
    this.notificationRouter.addRule({
      id: `checkpoint-resumed-${cpKey}`,
      name: `Checkpoint "${cp.name}" Resumed (auto-registered)`,
      events: ["checkpoint:resumed"],
      condition: { field: "checkpointName", op: "==", value: cp.name },
      channels: cp.notifyChannels,
      severity: "info",
    });
  }

  savePlan(opts: { data: string; prompt?: string; name?: string; status?: PlanStatus; notifications?: ScopedNotificationRules }): Plan {
    if (!this.ctx.registry.savePlan) throw new Error("Store does not support plans");
    const name = opts.name ?? this.ctx.registry.nextPlanName?.() ?? `plan-${Date.now()}`;
    const plan = this.ctx.registry.savePlan({
      name,
      data: opts.data,
      prompt: opts.prompt,
      status: opts.status ?? "draft",
      notifications: opts.notifications,
    });
    this.ctx.emitter.emit("plan:saved", { planId: plan.id, name: plan.name, status: plan.status });
    return plan;
  }

  getPlan(planId: string): Plan | undefined {
    return this.ctx.registry.getPlan?.(planId);
  }

  getPlanByName(name: string): Plan | undefined {
    return this.ctx.registry.getPlanByName?.(name);
  }

  getAllPlans(): Plan[] {
    return this.ctx.registry.getAllPlans?.() ?? [];
  }

  updatePlan(planId: string, updates: Partial<Omit<Plan, "id">>): Plan {
    if (!this.ctx.registry.updatePlan) throw new Error("Store does not support plans");
    return this.ctx.registry.updatePlan(planId, updates);
  }

  deletePlan(planId: string): boolean {
    if (!this.ctx.registry.deletePlan) throw new Error("Store does not support plans");
    const result = this.ctx.registry.deletePlan(planId);
    if (result) this.ctx.emitter.emit("plan:deleted", { planId });
    return result;
  }

  getResumablePlans(): Plan[] {
    const plans = this.getAllPlans();
    const state = this.ctx.registry.getState();
    return plans.filter(p => {
      if (p.status === "draft" || p.status === "completed" || p.status === "cancelled") return false;
      const tasks = state.tasks.filter(t => t.group === p.name);
      if (tasks.length === 0) return false;
      return tasks.some(t => t.status === "pending" || t.status === "failed");
    });
  }

  resumePlan(planId: string, opts?: { retryFailed?: boolean }): { retried: number; pending: number } {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error("Plan not found");

    // Re-register volatile agents if they were cleaned up
    this.cleanedGroups.delete(plan.name);
    const enableVolatile = this.ctx.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && plan.data) {
      try {
        const doc = JSON.parse(plan.data) as PlanDocument;
        if (doc?.team && Array.isArray(doc.team)) {
          for (const a of doc.team) {
            if (!a.name) continue;
            const { name, ...rest } = a;
            this.agentMgr.addVolatileAgent({ name, ...rest }, plan.name);
          }
        }
      } catch (err) {
        this.ctx.emitter.emit("log", { level: "warn", message: `Failed to re-register volatile agents for ${plan.name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const state = this.ctx.registry.getState();
    const tasks = state.tasks.filter(t => t.group === plan.name);
    const failedTasks = tasks.filter(t => t.status === "failed");
    const pendingTasks = tasks.filter(t => t.status === "pending");

    let retried = 0;
    if (opts?.retryFailed) {
      for (const task of failedTasks) {
        try {
          this.taskMgr.retryTask(task.id);
          retried++;
        } catch { /* no retries left — skip */
        }
      }
    }

    if (plan.status === "failed") {
      this.updatePlan(planId, { status: "active" });
    }

    this.ctx.emitter.emit("plan:resumed", { planId, name: plan.name, retried, pending: pendingTasks.length });
    return { retried, pending: pendingTasks.length };
  }

  executePlan(planId: string): { tasks: Task[]; group: string } {
    const plan = this.ctx.registry.getPlan?.(planId);
    if (!plan) throw new Error("Plan not found");
    if (plan.status === "active") throw new Error("Plan already active");

    const doc = JSON.parse(plan.data) as PlanDocument;
    if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
      throw new Error("Plan has no tasks");
    }

    const group = plan.name;

    // Run before:plan:execute hook
    const hookResult = this.ctx.hooks.runBeforeSync("plan:execute", {
      planId,
      plan,
      taskCount: doc.tasks.length,
    });
    if (hookResult.cancelled) {
      throw new Error(`Plan execution blocked by hook: ${hookResult.cancelReason ?? "no reason"}`);
    }

    // Register volatile agents from the plan's team section
    const enableVolatile = this.ctx.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && doc.team && Array.isArray(doc.team)) {
      for (const a of doc.team) {
        if (!a.name) continue;
        const { name, ...rest } = a;
        this.agentMgr.addVolatileAgent({ name, ...rest }, group);
      }
    }

    // Validate API keys for all agents referenced in the plan
    const allAgents = this.agentMgr.getAgents();
    const referencedModels: string[] = [];
    for (const t of doc.tasks) {
      const agentName = t.assignTo || allAgents[0]?.name;
      const agent = allAgents.find(a => a.name === agentName);
      if (agent?.model) {
        referencedModels.push(agent.model);
      } else if (!agent) {
        throw new Error(
          `Plan references agent "${agentName}" (task "${t.title}") but no such agent exists. ` +
          `Available agents: ${allAgents.map(a => a.name).join(", ")}`
        );
      }
    }
    if (referencedModels.length > 0) {
      const missing = validateProviderKeys(referencedModels);
      if (missing.length > 0) {
        const details = missing
          .map(m => `${m.provider} (model: ${m.modelSpec})`)
          .join(", ");
        throw new Error(
          `Missing API keys for providers: ${details}. ` +
          `Set the corresponding environment variables or add them to polpo.json providers section.`
        );
      }
    }

    // Create tasks with dependency resolution
    const titleToId = new Map<string, string>();
    const tasks: Task[] = [];
    for (const t of doc.tasks) {
      const deps = (t.dependsOn || [])
        .map((title: string) => titleToId.get(title))
        .filter((id: string | undefined): id is string => !!id);

      // Validate expectations through Zod schemas
      let expectations: TaskExpectation[] = [];
      if (t.expectations && Array.isArray(t.expectations) && t.expectations.length > 0) {
        const { valid, warnings } = sanitizeExpectations(t.expectations);
        expectations = valid;
        for (const w of warnings) {
          this.ctx.emitter.emit("log", { level: "warn", message: `Plan task "${t.title}": ${w}` });
        }
      }

      const task = this.taskMgr.addTask({
        title: t.title,
        description: t.description || t.title,
        assignTo: t.assignTo || this.agentMgr.getAgents()[0]?.name || "default",
        dependsOn: deps,
        expectations,
        expectedOutcomes: t.expectedOutcomes,
        group,
        maxDuration: t.maxDuration,
        retryPolicy: t.retryPolicy,
        notifications: t.notifications,
      });
      titleToId.set(t.title, task.id);
      tasks.push(task);
    }

    // Parse and store quality gates from plan document
    if (doc.qualityGates && Array.isArray(doc.qualityGates) && doc.qualityGates.length > 0) {
      this.gatesByGroup.set(group, doc.qualityGates);
    }

    // Parse and store checkpoints from plan document
    if (doc.checkpoints && Array.isArray(doc.checkpoints) && doc.checkpoints.length > 0) {
      this.checkpointsByGroup.set(group, doc.checkpoints);
    }

    // Persist plan-level notifications from document onto the Plan record
    if (doc.notifications) {
      this.ctx.registry.updatePlan?.(planId, { status: "active", notifications: doc.notifications });
    } else {
      // Mark plan as active
      this.ctx.registry.updatePlan?.(planId, { status: "active" });
    }
    this.ctx.emitter.emit("plan:executed", { planId, group, taskCount: tasks.length });

    return { tasks, group };
  }

  /** Check if any plan groups have all tasks terminal, and clean up their volatile agents */
  cleanupCompletedGroups(tasks: Task[]): void {
    const groups = new Set<string>();
    for (const t of tasks) {
      if (t.group) groups.add(t.group);
    }
    for (const group of groups) {
      const groupTasks = tasks.filter(t => t.group === group);
      const allTerminal = groupTasks.every(t => t.status === "done" || t.status === "failed");

      // If tasks went back to non-terminal (e.g. individual retry via retryTask),
      // clear the cleaned flag so the group will be re-evaluated when done again.
      if (!allTerminal && this.cleanedGroups.has(group)) {
        this.cleanedGroups.delete(group);
        continue;
      }

      if (this.cleanedGroups.has(group)) continue;
      if (!allTerminal) continue;

      const cleanupPolicy = this.ctx.config.settings.volatileCleanup ?? "on_complete";
      if (cleanupPolicy === "on_complete") {
        this.agentMgr.cleanupVolatileAgents(group);
      }
      this.cleanedGroups.add(group);

      // Auto-update plan status
      const plan = this.ctx.registry.getPlanByName?.(group);
      if (plan && plan.status === "active") {
        let allDone = groupTasks.every(t => t.status === "done");

        // Check plan quality threshold (only if all tasks passed structurally)
        if (allDone && this.qualityCtrl) {
          const thresholdResult = this.qualityCtrl.checkPlanThreshold(
            plan,
            groupTasks,
            this.ctx.config.settings.defaultQualityThreshold,
          );
          if (!thresholdResult.passed) {
            allDone = false; // Quality threshold not met — mark plan as failed
            this.ctx.emitter.emit("log", {
              level: "warn",
              message: `Plan "${group}" quality threshold not met: ${thresholdResult.avgScore?.toFixed(2) ?? "N/A"} < ${thresholdResult.threshold}`,
            });
          }
        }

        this.ctx.registry.updatePlan?.(plan.id, { status: allDone ? "completed" : "failed" });
        const report = this.buildPlanReport(plan.id, group, groupTasks, allDone);
        this.ctx.emitter.emit("plan:completed", { planId: plan.id, group, allPassed: allDone, report });

        // Aggregate plan metrics
        this.qualityCtrl?.aggregatePlanMetrics(plan.id, groupTasks);

        // Clean up gate and checkpoint caches
        this.gatesByGroup.delete(group);
        this.checkpointsByGroup.delete(group);
        // Clean up active/resumed checkpoint entries for this group
        for (const key of [...this.activeCheckpoints.keys()]) {
          if (key.startsWith(`${group}:`)) this.activeCheckpoints.delete(key);
        }
        for (const key of [...this.resumedCheckpoints]) {
          if (key.startsWith(`${group}:`)) this.resumedCheckpoints.delete(key);
        }
      }
    }
  }

  buildPlanReport(planId: string, group: string, groupTasks: Task[], allPassed: boolean): PlanReport {
    const state = this.ctx.registry.getState();
    const processes = state?.processes ?? [];

    const allFilesCreated = new Set<string>();
    const allFilesEdited = new Set<string>();
    let totalDuration = 0;
    const scores: number[] = [];
    const allOutcomes: import("./types.js").TaskOutcome[] = [];

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

      // Aggregate outcomes across all tasks
      if (t.outcomes) {
        for (const o of t.outcomes) allOutcomes.push(o);
      }

      return {
        title: t.title,
        status: t.status as "done" | "failed",
        duration,
        score,
        filesCreated,
        filesEdited,
        outcomes: t.outcomes,
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
      outcomes: allOutcomes.length > 0 ? allOutcomes : undefined,
      avgScore,
    };
  }
}
