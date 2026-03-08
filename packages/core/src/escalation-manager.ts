import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task, EscalationPolicy, EscalationLevel } from "./types.js";
import { findAgent } from "./types.js";
import type { ApprovalManager } from "./approval-manager.js";

/**
 * Manages the escalation chain when tasks fail repeatedly.
 *
 * 4-level hybrid escalation:
 *   Level 0: Retry with same agent (handled by AssessmentOrchestrator — not managed here)
 *   Level 1: Escalate to fallback agent (handled by RetryPolicy — not managed here)
 *   Level 2: Orchestrator LLM analysis — reformulate the task and retry
 *   Level 3: Human-in-the-loop — notify humans and create approval request
 */
export class EscalationManager {
  private taskLevels = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private ctx: OrchestratorContext,
    private approvalMgr?: ApprovalManager,
  ) {}

  init(): void {
    const policy = this.ctx.config.settings.escalationPolicy;
    if (!policy) return;

    this.ctx.hooks.register({
      hook: "task:fail",
      phase: "before",
      priority: 60,
      name: "escalation-manager",
      handler: (hookCtx) => {
        const { taskId, task, reason } = hookCtx.data;
        if (reason !== "maxRetries") return;

        const currentLevel = this.taskLevels.get(taskId) ?? this.getStartLevel(policy);
        const level = policy.levels.find(l => l.level === currentLevel);
        if (!level) return;

        hookCtx.cancel(`Escalating to level ${currentLevel}: ${level.handler}`);

        this.escalate(taskId, task, level, policy).catch(err => {
          const msg = err instanceof Error ? err.message : String(err);
          this.ctx.emitter.emit("log", {
            level: "error",
            message: `[escalation] Level ${currentLevel} failed for task ${taskId}: ${msg}`,
          });
        });
      },
    });
  }

  private getStartLevel(policy: EscalationPolicy): number {
    for (const level of policy.levels) {
      if (level.handler !== "agent") return level.level;
    }
    return policy.levels[policy.levels.length - 1]?.level ?? 0;
  }

  private async escalate(
    taskId: string,
    task: Task,
    level: EscalationLevel,
    policy: EscalationPolicy,
  ): Promise<void> {
    this.taskLevels.set(taskId, level.level);

    this.ctx.emitter.emit("escalation:triggered", {
      taskId,
      level: level.level,
      handler: level.handler,
      target: level.target,
    });

    if (level.notifyChannels && level.notifyChannels.length > 0) {
      this.ctx.emitter.emit("escalation:human", {
        taskId,
        message: `Task "${task.title}" escalated to level ${level.level} (${level.handler})`,
        channels: level.notifyChannels,
      });
    }

    switch (level.handler) {
      case "agent":
        await this.escalateToAgent(taskId, task, level, policy);
        break;
      case "orchestrator":
        await this.escalateToOrchestrator(taskId, task, level, policy);
        break;
      case "human":
        await this.escalateToHuman(taskId, task, level, policy);
        break;
    }
  }

  private async escalateToAgent(
    taskId: string,
    task: Task,
    level: EscalationLevel,
    policy: EscalationPolicy,
  ): Promise<void> {
    const targetAgent = level.target;
    if (!targetAgent) {
      this.ctx.emitter.emit("log", {
        level: "warn",
        message: `[escalation] Agent level ${level.level} has no target — skipping to next level`,
      });
      await this.advanceLevel(taskId, task, level, policy);
      return;
    }

    const agent = findAgent(this.ctx.config.teams, targetAgent);
    if (!agent) {
      this.ctx.emitter.emit("log", {
        level: "warn",
        message: `[escalation] Agent "${targetAgent}" not found — skipping to next level`,
      });
      await this.advanceLevel(taskId, task, level, policy);
      return;
    }

    await this.ctx.registry.updateTask(taskId, { assignTo: targetAgent });
    await this.ctx.registry.unsafeSetStatus(taskId, "pending", `escalation level ${level.level}: reassign to ${targetAgent}`);

    this.ctx.emitter.emit("escalation:resolved", {
      taskId,
      level: level.level,
      action: `reassigned to agent "${targetAgent}"`,
    });

    if (level.timeoutMs) {
      this.startTimer(taskId, task, level, policy, level.timeoutMs);
    }
  }

  private async escalateToOrchestrator(
    taskId: string,
    task: Task,
    level: EscalationLevel,
    policy: EscalationPolicy,
  ): Promise<void> {
    if (!this.ctx.queryLLM) {
      this.ctx.emitter.emit("log", {
        level: "warn",
        message: `[escalation] No LLM query function available — skipping to next level`,
      });
      await this.advanceLevel(taskId, task, level, policy);
      return;
    }

    try {
      const failureContext = this.buildFailureContext(task);
      const prompt = [
        "A task in an automated development pipeline has failed after all retry attempts.",
        "Analyze the failure and suggest a reformulated task description that might succeed.",
        "",
        `Task title: ${task.title}`,
        `Original description: ${task.originalDescription ?? task.description}`,
        `Agent: ${task.assignTo}`,
        `Retries: ${task.retries}/${task.maxRetries}`,
        "",
        "Failure details:",
        failureContext,
        "",
        "Provide a reformulated task description that addresses the failure.",
        "Focus on being more specific, adding constraints, or simplifying the scope.",
        "Return ONLY the new description text, no explanation.",
      ].join("\n");

      const newDescription = (await this.ctx.queryLLM(
        prompt,
        this.ctx.config.settings.orchestratorModel,
      )).text;

      if (newDescription && newDescription.length > 20) {
        await this.ctx.registry.updateTask(taskId, {
          description: `[Escalation: Reformulated by orchestrator]\n\n${newDescription}`,
          phase: "execution",
          fixAttempts: 0,
        });
        await this.ctx.registry.unsafeSetStatus(taskId, "pending", `escalation level ${level.level}: orchestrator reformulation`);

        this.ctx.emitter.emit("escalation:resolved", {
          taskId,
          level: level.level,
          action: "task reformulated by orchestrator LLM",
        });

        if (level.timeoutMs) {
          this.startTimer(taskId, task, level, policy, level.timeoutMs);
        }
      } else {
        await this.advanceLevel(taskId, task, level, policy);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", {
        level: "error",
        message: `[escalation] Orchestrator analysis failed: ${msg}`,
      });
      await this.advanceLevel(taskId, task, level, policy);
    }
  }

  private async escalateToHuman(
    taskId: string,
    task: Task,
    level: EscalationLevel,
    _policy: EscalationPolicy,
  ): Promise<void> {
    const failureContext = this.buildFailureContext(task);

    await this.ctx.registry.unsafeSetStatus(taskId, "awaiting_approval", `escalation level ${level.level}: human intervention`);

    this.ctx.emitter.emit("escalation:human", {
      taskId,
      message: [
        `Task "${task.title}" has failed after all automated attempts and requires human intervention.`,
        "",
        `Agent: ${task.assignTo}`,
        `Retries: ${task.retries}/${task.maxRetries}`,
        "",
        "Failure details:",
        failureContext,
        "",
        "Actions available:",
        "- Approve: retry with current description",
        "- Reject: mark as permanently failed",
        "- Modify: update description/assignment via API",
      ].join("\n"),
      channels: level.notifyChannels,
    });

    this.ctx.emitter.emit("escalation:resolved", {
      taskId,
      level: level.level,
      action: "awaiting human intervention",
    });

    if (this.approvalMgr) {
      this.ctx.emitter.emit("approval:requested", {
        requestId: `esc-${taskId}`,
        gateId: "escalation",
        gateName: `Escalation: ${task.title}`,
        taskId,
      });
    }
  }

  private async advanceLevel(
    taskId: string,
    task: Task,
    currentLevel: EscalationLevel,
    policy: EscalationPolicy,
  ): Promise<void> {
    const nextLevel = policy.levels.find(l => l.level > currentLevel.level);
    if (nextLevel) {
      try {
        await this.escalate(taskId, task, nextLevel, policy);
      } catch {
        await this.finalFail(taskId);
      }
    } else {
      await this.finalFail(taskId);
    }
  }

  private async finalFail(taskId: string): Promise<void> {
    this.taskLevels.delete(taskId);
    this.clearTimer(taskId);

    const task = await this.ctx.registry.getTask(taskId);
    if (!task) return;

    if (task.status !== "done" && task.status !== "failed" && task.status !== "awaiting_approval") {
      await this.ctx.registry.unsafeSetStatus(taskId, "failed", "escalation exhausted");
    }
  }

  private buildFailureContext(task: Task): string {
    const lines: string[] = [];

    if (task.result) {
      if (task.result.exitCode !== 0) {
        lines.push(`Exit code: ${task.result.exitCode}`);
      }
      if (task.result.stderr) {
        const stderr = task.result.stderr.slice(-500);
        lines.push(`Last stderr: ${stderr}`);
      }
      if (task.result.assessment) {
        const a = task.result.assessment;
        lines.push(`Assessment: ${a.passed ? "PASSED" : "FAILED"}`);
        if (a.globalScore !== undefined) {
          lines.push(`Score: ${a.globalScore.toFixed(1)}/5`);
        }
        for (const check of a.checks.filter(c => !c.passed)) {
          lines.push(`  Failed: ${check.type} — ${check.message}`);
        }
      }
    }

    return lines.join("\n") || "No failure details available.";
  }

  private startTimer(
    taskId: string,
    task: Task,
    currentLevel: EscalationLevel,
    policy: EscalationPolicy,
    ms: number,
  ): void {
    this.clearTimer(taskId);
    const timer = setTimeout(async () => {
      this.timers.delete(taskId);
      const currentTask = await this.ctx.registry.getTask(taskId);
      if (currentTask && (currentTask.status === "pending" || currentTask.status === "in_progress" || currentTask.status === "failed")) {
        this.ctx.emitter.emit("log", {
          level: "warn",
          message: `[escalation] Level ${currentLevel.level} timed out for task ${taskId} — advancing`,
        });
        await this.advanceLevel(taskId, task, currentLevel, policy);
      }
    }, ms);
    this.timers.set(taskId, timer);
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.taskLevels.clear();
  }
}
