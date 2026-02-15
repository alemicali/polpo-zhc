import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task, TaskResult, EscalationPolicy, EscalationLevel } from "./types.js";
import type { ApprovalManager } from "./approval-manager.js";

/**
 * Manages the escalation chain when tasks fail repeatedly.
 *
 * 4-level hybrid escalation:
 *   Level 0: Retry with same agent (handled by AssessmentOrchestrator — not managed here)
 *   Level 1: Escalate to fallback agent (handled by RetryPolicy — not managed here)
 *   Level 2: Orchestrator LLM analysis — reformulate the task and retry
 *   Level 3: Human-in-the-loop — notify humans and create approval request
 *
 * The EscalationManager is called when a task hits maxRetries (all automated
 * retry/escalation exhausted). It takes over and walks the remaining escalation levels.
 */
export class EscalationManager {
  /** Track current escalation level per task. */
  private taskLevels = new Map<string, number>();
  /** Track escalation timers per task. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private ctx: OrchestratorContext,
    private approvalMgr?: ApprovalManager,
  ) {}

  /**
   * Initialize: register a hook on task:fail to intercept maxRetries failures.
   */
  init(): void {
    const policy = this.ctx.config.settings.escalationPolicy;
    if (!policy) return;

    this.ctx.hooks.register({
      hook: "task:fail",
      phase: "before",
      priority: 60,  // Run after approval gates (50) but before user hooks (100)
      name: "escalation-manager",
      handler: (hookCtx) => {
        const { taskId, task, reason } = hookCtx.data;
        // Only intercept maxRetries failures
        if (reason !== "maxRetries") return;

        const currentLevel = this.taskLevels.get(taskId) ?? this.getStartLevel(policy);
        const level = policy.levels.find(l => l.level === currentLevel);
        if (!level) return;  // No more levels — let the task fail normally

        // Block the failure — we'll handle it
        hookCtx.cancel(`Escalating to level ${currentLevel}: ${level.handler}`);

        // Run the escalation asynchronously
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

  /**
   * Determine the starting escalation level.
   * Levels 0 and 1 are handled by the existing retry/fallback system.
   * We start from the first level with handler !== "agent".
   */
  private getStartLevel(policy: EscalationPolicy): number {
    for (const level of policy.levels) {
      if (level.handler !== "agent") return level.level;
    }
    return policy.levels[policy.levels.length - 1]?.level ?? 0;
  }

  /**
   * Execute an escalation level.
   */
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

    // Notify configured channels
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

  /**
   * Level: Agent — reassign to a different agent and retry.
   * This is a fallback for cases where RetryPolicy.fallbackAgent wasn't configured.
   */
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
      this.advanceLevel(taskId, task, level, policy);
      return;
    }

    // Verify agent exists
    const agent = this.ctx.config.team.agents.find(a => a.name === targetAgent);
    if (!agent) {
      this.ctx.emitter.emit("log", {
        level: "warn",
        message: `[escalation] Agent "${targetAgent}" not found — skipping to next level`,
      });
      this.advanceLevel(taskId, task, level, policy);
      return;
    }

    // Reassign and retry (add extra retry budget)
    this.ctx.registry.updateTask(taskId, { assignTo: targetAgent });
    this.ctx.registry.unsafeSetStatus(taskId, "pending", `escalation level ${level.level}: reassign to ${targetAgent}`);

    this.ctx.emitter.emit("escalation:resolved", {
      taskId,
      level: level.level,
      action: `reassigned to agent "${targetAgent}"`,
    });

    // Set timeout to advance if this doesn't work
    if (level.timeoutMs) {
      this.startTimer(taskId, task, level, policy, level.timeoutMs);
    }
  }

  /**
   * Level: Orchestrator — use LLM to analyze the failure and reformulate the task.
   */
  private async escalateToOrchestrator(
    taskId: string,
    task: Task,
    level: EscalationLevel,
    policy: EscalationPolicy,
  ): Promise<void> {
    try {
      const { querySDKText } = await import("../llm/query.js");

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

      const newDescription = await querySDKText(
        prompt,
        this.ctx.workDir,
        this.ctx.config.settings.orchestratorModel,
      );

      if (newDescription && newDescription.length > 20) {
        // Reformulate and retry with extra retry budget
        this.ctx.registry.updateTask(taskId, {
          description: `[Escalation: Reformulated by orchestrator]\n\n${newDescription}`,
          phase: "execution",
          fixAttempts: 0,
        });
        // Give one more retry
        this.ctx.registry.unsafeSetStatus(taskId, "pending", `escalation level ${level.level}: orchestrator reformulation`);

        this.ctx.emitter.emit("escalation:resolved", {
          taskId,
          level: level.level,
          action: "task reformulated by orchestrator LLM",
        });

        // Set timeout to advance to human if this doesn't work
        if (level.timeoutMs) {
          this.startTimer(taskId, task, level, policy, level.timeoutMs);
        }
      } else {
        // LLM couldn't help — advance to next level
        this.advanceLevel(taskId, task, level, policy);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", {
        level: "error",
        message: `[escalation] Orchestrator analysis failed: ${msg}`,
      });
      this.advanceLevel(taskId, task, level, policy);
    }
  }

  /**
   * Level: Human — create an approval request and notify.
   * The task enters awaiting_approval state.
   */
  private async escalateToHuman(
    taskId: string,
    task: Task,
    level: EscalationLevel,
    _policy: EscalationPolicy,
  ): Promise<void> {
    const failureContext = this.buildFailureContext(task);

    // Transition task to awaiting approval
    this.ctx.registry.unsafeSetStatus(taskId, "awaiting_approval", `escalation level ${level.level}: human intervention`);

    // Emit escalation:human event (picked up by NotificationRouter)
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

    // If approval manager is available, create a formal request
    if (this.approvalMgr) {
      // The approval:requested event will be emitted by the approval manager
      // We create it through the store directly since there's no gate
      this.ctx.emitter.emit("approval:requested", {
        requestId: `esc-${taskId}`,
        gateId: "escalation",
        gateName: `Escalation: ${task.title}`,
        taskId,
      });
    }
  }

  /**
   * Advance to the next escalation level.
   */
  private advanceLevel(
    taskId: string,
    task: Task,
    currentLevel: EscalationLevel,
    policy: EscalationPolicy,
  ): void {
    const nextLevel = policy.levels.find(l => l.level > currentLevel.level);
    if (nextLevel) {
      this.escalate(taskId, task, nextLevel, policy).catch(() => {
        // All escalation exhausted — let the task fail
        this.finalFail(taskId);
      });
    } else {
      // No more levels — task fails permanently
      this.finalFail(taskId);
    }
  }

  /**
   * Final failure — all escalation levels exhausted.
   */
  private finalFail(taskId: string): void {
    this.taskLevels.delete(taskId);
    this.clearTimer(taskId);

    const task = this.ctx.registry.getTask(taskId);
    if (!task) return;

    // Only fail if not already in a terminal state or awaiting approval
    if (task.status !== "done" && task.status !== "failed" && task.status !== "awaiting_approval") {
      this.ctx.registry.unsafeSetStatus(taskId, "failed", "escalation exhausted");
    }
  }

  /**
   * Build a failure context string from task result and assessment history.
   */
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

  // ─── Timers ──────────────────────────────────────

  private startTimer(
    taskId: string,
    task: Task,
    currentLevel: EscalationLevel,
    policy: EscalationPolicy,
    ms: number,
  ): void {
    this.clearTimer(taskId);
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      // Check if task is still stuck at this level
      const currentTask = this.ctx.registry.getTask(taskId);
      if (currentTask && (currentTask.status === "pending" || currentTask.status === "in_progress" || currentTask.status === "failed")) {
        this.ctx.emitter.emit("log", {
          level: "warn",
          message: `[escalation] Level ${currentLevel.level} timed out for task ${taskId} — advancing`,
        });
        this.advanceLevel(taskId, task, currentLevel, policy);
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

  /**
   * Cleanup: clear all timers.
   */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.taskLevels.clear();
  }
}
