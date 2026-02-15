import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { Plan, PlanStatus, PlanReport, Task, TaskExpectation } from "./types.js";
import { sanitizeExpectations } from "./schemas.js";

interface PlanDocument {
  tasks?: Array<{
    title: string;
    description: string;
    assignTo?: string;
    dependsOn?: string[];
    expectations?: TaskExpectation[];
    metrics?: unknown[];
    maxRetries?: number;
    maxDuration?: number;
    retryPolicy?: { escalateAfter?: number; fallbackAgent?: string };
  }>;
  team?: Array<{
    name: string;
    adapter?: string;
    role?: string;
    model?: string;
    systemPrompt?: string;
    skills?: string[];
  }>;
}

/**
 * Plan CRUD + execution + resume + group lifecycle.
 */
export class PlanExecutor {
  private cleanedGroups = new Set<string>();

  constructor(
    private ctx: OrchestratorContext,
    private taskMgr: TaskManager,
    private agentMgr: AgentManager,
  ) {}

  savePlan(opts: { data: string; prompt?: string; name?: string; status?: PlanStatus }): Plan {
    if (!this.ctx.registry.savePlan) throw new Error("Store does not support plans");
    const name = opts.name ?? this.ctx.registry.nextPlanName?.() ?? `plan-${Date.now()}`;
    const plan = this.ctx.registry.savePlan({
      name,
      data: opts.data,
      prompt: opts.prompt,
      status: opts.status ?? "draft",
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

  updatePlan(planId: string, updates: { data?: string; status?: PlanStatus; name?: string }): Plan {
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
            this.agentMgr.addVolatileAgent({
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
        this.agentMgr.addVolatileAgent({
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
        assignTo: t.assignTo || this.ctx.config.team.agents[0]?.name || "default",
        dependsOn: deps,
        expectations,
        group,
        maxDuration: t.maxDuration,
        retryPolicy: t.retryPolicy,
      });
      titleToId.set(t.title, task.id);
      tasks.push(task);
    }

    // Mark plan as active
    this.ctx.registry.updatePlan?.(planId, { status: "active" });
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
        const allDone = groupTasks.every(t => t.status === "done");
        this.ctx.registry.updatePlan?.(plan.id, { status: allDone ? "completed" : "failed" });
        const report = this.buildPlanReport(plan.id, group, groupTasks, allDone);
        this.ctx.emitter.emit("plan:completed", { planId: plan.id, group, allPassed: allDone, report });
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
}
