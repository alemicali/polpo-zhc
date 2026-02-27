import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { NotificationRouter } from "../notifications/index.js";
import type { MissionQualityGate, QualityMetrics, Task, Mission, AssessmentResult } from "../core/types.js";

/**
 * QualityController — manages quality gates within missions and aggregates
 * quality metrics across tasks, agents, and missions.
 *
 * Responsibilities:
 *  1. Evaluate quality gates defined in mission documents (between task phases)
 *  2. Aggregate quality metrics per entity (task, agent, mission)
 *  3. Enforce mission-level quality thresholds on completion
 *
 * This is a standalone architectural layer — NOT embedded in the assessment pipeline.
 * It consumes assessment results via hooks and emits quality events.
 */
export class QualityController {
  /** In-memory metrics store keyed by "entityType:entityId" */
  private metrics = new Map<string, QualityMetrics>();

  /** Track which quality gates have already been evaluated (prevent re-evaluation) */
  private evaluatedGates = new Set<string>();

  /** Track which gate notification rules have been registered (by gateKey) */
  private registeredGateRules = new Set<string>();

  private notificationRouter?: NotificationRouter;

  constructor(
    private ctx: OrchestratorContext,
  ) {}

  /**
   * Set the notification router — enables per-gate channel routing.
   */
  setNotificationRouter(router: NotificationRouter): void {
    this.notificationRouter = router;
  }

  /**
   * Initialize: register hooks to collect metrics from completed assessments
   * and detect SLA outcomes.
   */
  init(): void {
    // Collect quality metrics when assessments complete
    this.ctx.hooks.register({
      hook: "assessment:complete",
      phase: "after",
      priority: 200,
      name: "quality-controller:collect-metrics",
      handler: (hookCtx) => {
        const { taskId, task, assessment, passed } = hookCtx.data;
        this.recordAssessment(taskId, "task", assessment, passed);

        // Also record against the agent
        if (task.assignTo) {
          this.recordAssessment(task.assignTo, "agent", assessment, passed);
        }
      },
    });

    // Record SLA outcomes (met/missed) when tasks complete
    this.ctx.hooks.register({
      hook: "task:complete",
      phase: "after",
      priority: 210,
      name: "quality-controller:sla-outcome",
      handler: (hookCtx) => {
        const { taskId, task } = hookCtx.data;
        if (task?.deadline) {
          const deadline = new Date(task.deadline).getTime();
          const now = Date.now();
          const key = this.metricsKey("task", taskId);
          const m = this.getOrCreate(key, taskId, "task");
          if (now <= deadline) {
            m.deadlinesMet++;
          } else {
            m.deadlinesMissed++;
          }
          m.updatedAt = new Date().toISOString();
        }
      },
    });

    // Record retries
    this.ctx.hooks.register({
      hook: "task:retry",
      phase: "after",
      priority: 200,
      name: "quality-controller:record-retry",
      handler: (hookCtx) => {
        const { taskId, task } = hookCtx.data;
        const key = this.metricsKey("task", taskId);
        const m = this.getOrCreate(key, taskId, "task");
        m.totalRetries++;
        m.updatedAt = new Date().toISOString();

        // Also record against agent
        if (task.assignTo) {
          const agentKey = this.metricsKey("agent", task.assignTo);
          const am = this.getOrCreate(agentKey, task.assignTo, "agent");
          am.totalRetries++;
          am.updatedAt = new Date().toISOString();
        }
      },
    });
  }

  // ─── Quality Gates ─────────────────────────────────

  /**
   * Evaluate a quality gate defined in a mission.
   * Returns true if the gate passes, false if it fails.
   *
   * Called by MissionExecutor when checking if blocked tasks can proceed.
   */
  evaluateGate(
    missionId: string,
    gate: MissionQualityGate,
    tasks: Task[],
  ): { passed: boolean; reason?: string; avgScore?: number } {
    const gateKey = `${missionId}:${gate.name}`;

    // Register dynamic notification rules for this gate's channels (once per gate)
    this.ensureGateNotificationRules(gateKey, gate);

    // Already evaluated and passed — don't re-evaluate
    if (this.evaluatedGates.has(gateKey)) {
      return { passed: true };
    }

    // Check that all afterTasks are terminal
    const afterTasks = tasks.filter(t => gate.afterTasks.includes(t.title) || gate.afterTasks.includes(t.id));

    // If some referenced tasks are missing from the task list, the gate can't be evaluated
    if (afterTasks.length < gate.afterTasks.length) {
      const foundIds = new Set([...afterTasks.map(t => t.title), ...afterTasks.map(t => t.id)]);
      const missing = gate.afterTasks.filter(ref => !foundIds.has(ref));
      return {
        passed: false,
        reason: `Waiting for tasks to complete: ${missing.join(", ")}`,
      };
    }

    const nonTerminal = afterTasks.filter(t => t.status !== "done" && t.status !== "failed");
    if (nonTerminal.length > 0) {
      return {
        passed: false,
        reason: `Waiting for tasks to complete: ${nonTerminal.map(t => t.title).join(", ")}`,
      };
    }

    // If requireAllPassed, all afterTasks must be "done" (not "failed")
    if (gate.requireAllPassed) {
      const failedTasks = afterTasks.filter(t => t.status === "failed");
      if (failedTasks.length > 0) {
        const reason = `Required tasks failed: ${failedTasks.map(t => t.title).join(", ")}`;
        this.ctx.emitter.emit("quality:gate:failed", {
          missionId,
          gateName: gate.name,
          reason,
        });
        this.ctx.hooks.runAfter("quality:gate", {
          missionId,
          gateName: gate.name,
          allPassed: false,
          tasks: afterTasks.map(t => ({
            taskId: t.id,
            title: t.title,
            status: t.status,
            score: t.result?.assessment?.globalScore,
          })),
        }).catch(() => {/* fire-and-forget */});
        return { passed: false, reason };
      }
    }

    // Check minimum score threshold
    if (gate.minScore !== undefined) {
      const scores = afterTasks
        .map(t => t.result?.assessment?.globalScore)
        .filter((s): s is number => s !== undefined);

      const avgScore = scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : undefined;

      if (avgScore === undefined || avgScore < gate.minScore) {
        const reason = `Average score ${avgScore?.toFixed(2) ?? "N/A"} below threshold ${gate.minScore}`;
        this.ctx.emitter.emit("quality:gate:failed", {
          missionId,
          gateName: gate.name,
          avgScore,
          reason,
        });
        this.ctx.hooks.runAfter("quality:gate", {
          missionId,
          gateName: gate.name,
          avgScore,
          allPassed: false,
          tasks: afterTasks.map(t => ({
            taskId: t.id,
            title: t.title,
            status: t.status,
            score: t.result?.assessment?.globalScore,
          })),
        }).catch(() => {/* fire-and-forget */});
        return { passed: false, reason, avgScore };
      }

      // Gate passed
      this.evaluatedGates.add(gateKey);
      this.ctx.emitter.emit("quality:gate:passed", {
        missionId,
        gateName: gate.name,
        avgScore,
      });
      this.ctx.hooks.runAfter("quality:gate", {
        missionId,
        gateName: gate.name,
        avgScore,
        allPassed: true,
        tasks: afterTasks.map(t => ({
          taskId: t.id,
          title: t.title,
          status: t.status,
          score: t.result?.assessment?.globalScore,
        })),
      }).catch(() => {/* fire-and-forget */});
      return { passed: true, avgScore };
    }

    // No score requirement — just completion check passed
    this.evaluatedGates.add(gateKey);
    this.ctx.emitter.emit("quality:gate:passed", {
      missionId,
      gateName: gate.name,
    });
    this.ctx.hooks.runAfter("quality:gate", {
      missionId,
      gateName: gate.name,
      allPassed: true,
      tasks: afterTasks.map(t => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        score: t.result?.assessment?.globalScore,
      })),
    }).catch(() => {/* fire-and-forget */});
    return { passed: true };
  }

  /**
   * Check if a task is blocked by any quality gate in its mission.
   * Returns the blocking gate if found, undefined if the task can proceed.
   */
  getBlockingGate(
    missionId: string,
    taskTitle: string,
    taskId: string,
    gates: MissionQualityGate[],
    tasks: Task[],
  ): { gate: MissionQualityGate; result: { passed: boolean; reason?: string; avgScore?: number } } | undefined {
    for (const gate of gates) {
      if (!gate.blocksTasks.includes(taskTitle) && !gate.blocksTasks.includes(taskId)) {
        continue;
      }
      const result = this.evaluateGate(missionId, gate, tasks);
      if (!result.passed) {
        return { gate, result };
      }
    }
    return undefined;
  }

  // ─── Mission Quality Threshold ────────────────────────

  /**
   * Check if a completed mission meets its quality threshold.
   * Returns the average score and whether the threshold was met.
   */
  checkMissionThreshold(
    mission: Mission,
    tasks: Task[],
    defaultThreshold?: number,
  ): { avgScore?: number; threshold?: number; passed: boolean } {
    const threshold = mission.qualityThreshold ?? defaultThreshold;
    if (threshold === undefined) return { passed: true };

    const scores = tasks
      .filter(t => t.status === "done")
      .map(t => {
        const score = t.result?.assessment?.globalScore;
        const weight = t.priority ?? 1.0;
        return score !== undefined ? { score, weight } : undefined;
      })
      .filter((s): s is { score: number; weight: number } => s !== undefined);

    if (scores.length === 0) {
      // No scores available — can't evaluate threshold, pass by default
      return { passed: true, threshold };
    }

    // Weighted average
    const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
    const avgScore = totalWeight > 0
      ? scores.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight
      : scores.reduce((sum, s) => sum + s.score, 0) / scores.length;

    const passed = avgScore >= threshold;

    if (!passed) {
      this.ctx.emitter.emit("quality:threshold:failed", {
        missionId: mission.id,
        avgScore,
        threshold,
      });
    }

    return { avgScore, threshold, passed };
  }

  // ─── Metrics Aggregation ───────────────────────────

  /**
   * Record an assessment result into the metrics for an entity.
   */
  private recordAssessment(
    entityId: string,
    entityType: "task" | "agent" | "mission",
    assessment: AssessmentResult,
    passed: boolean,
  ): void {
    const key = this.metricsKey(entityType, entityId);
    const m = this.getOrCreate(key, entityId, entityType);

    m.totalAssessments++;
    if (passed) m.passedAssessments++;

    if (assessment.globalScore !== undefined) {
      const scores = this.getScoresArray(m);
      scores.push(assessment.globalScore);
      m.avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      m.minScore = Math.min(...scores);
      m.maxScore = Math.max(...scores);
    }

    // Per-dimension scores
    if (assessment.scores) {
      for (const ds of assessment.scores) {
        if (!m.dimensionScores[ds.dimension]) {
          m.dimensionScores[ds.dimension] = ds.score;
        } else {
          // Running average
          m.dimensionScores[ds.dimension] =
            (m.dimensionScores[ds.dimension] * (m.totalAssessments - 1) + ds.score) / m.totalAssessments;
        }
      }
    }

    // Record fix attempts from the task
    if (entityType === "task" && assessment.trigger === "fix") {
      m.totalFixes++;
    }

    m.updatedAt = new Date().toISOString();
  }

  /**
   * Get quality metrics for an entity. Returns undefined if no data collected.
   */
  getMetrics(entityType: "task" | "agent" | "mission", entityId: string): QualityMetrics | undefined {
    return this.metrics.get(this.metricsKey(entityType, entityId));
  }

  /**
   * Get all metrics of a given type.
   */
  getAllMetrics(entityType?: "task" | "agent" | "mission"): QualityMetrics[] {
    const all = [...this.metrics.values()];
    if (entityType) return all.filter(m => m.entityType === entityType);
    return all;
  }

  /**
   * Aggregate metrics for a mission from its tasks.
   */
  aggregateMissionMetrics(missionId: string, tasks: Task[]): QualityMetrics {
    const key = this.metricsKey("mission", missionId);
    const m = this.getOrCreate(key, missionId, "mission");

    const scores: number[] = [];
    let totalAssessments = 0;
    let passedAssessments = 0;
    let totalRetries = 0;
    let totalFixes = 0;
    let deadlinesMet = 0;
    let deadlinesMissed = 0;

    for (const task of tasks) {
      const taskMetrics = this.getMetrics("task", task.id);
      if (taskMetrics) {
        totalAssessments += taskMetrics.totalAssessments;
        passedAssessments += taskMetrics.passedAssessments;
        totalRetries += taskMetrics.totalRetries;
        totalFixes += taskMetrics.totalFixes;
        deadlinesMet += taskMetrics.deadlinesMet;
        deadlinesMissed += taskMetrics.deadlinesMissed;
        if (taskMetrics.avgScore !== undefined) {
          scores.push(taskMetrics.avgScore);
        }
      }
    }

    m.totalAssessments = totalAssessments;
    m.passedAssessments = passedAssessments;
    m.totalRetries = totalRetries;
    m.totalFixes = totalFixes;
    m.deadlinesMet = deadlinesMet;
    m.deadlinesMissed = deadlinesMissed;

    if (scores.length > 0) {
      m.avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      m.minScore = Math.min(...scores);
      m.maxScore = Math.max(...scores);
    }

    m.updatedAt = new Date().toISOString();
    return m;
  }

  // ─── Helpers ───────────────────────────────────────

  private metricsKey(entityType: string, entityId: string): string {
    return `${entityType}:${entityId}`;
  }

  private getOrCreate(key: string, entityId: string, entityType: "task" | "agent" | "mission"): QualityMetrics {
    let m = this.metrics.get(key);
    if (!m) {
      m = {
        entityId,
        entityType,
        totalAssessments: 0,
        passedAssessments: 0,
        dimensionScores: {},
        totalRetries: 0,
        totalFixes: 0,
        deadlinesMet: 0,
        deadlinesMissed: 0,
        updatedAt: new Date().toISOString(),
      };
      this.metrics.set(key, m);
    }
    return m;
  }

  /** Reconstruct the scores array from avg/min/max and count for running calculations */
  private getScoresArray(m: QualityMetrics): number[] {
    // We store a running average — reconstruct individual scores isn't possible,
    // but for avg calculation we just need the current count and new value.
    // Use a simple approach: store count in totalAssessments.
    if (m.avgScore !== undefined && m.totalAssessments > 0) {
      // Return a synthetic array that produces the same average
      // This is used only for recalculating the average with a new value
      return Array(m.totalAssessments - 1).fill(m.avgScore);
    }
    return [];
  }

  /**
   * Register dynamic notification rules for a gate's notifyChannels (once per gate).
   * This ensures that quality:gate:passed and quality:gate:failed events for gates
   * with notifyChannels are actually routed to those channels.
   */
  private ensureGateNotificationRules(gateKey: string, gate: MissionQualityGate): void {
    if (!this.notificationRouter) return;
    if (!gate.notifyChannels || gate.notifyChannels.length === 0) return;
    if (this.registeredGateRules.has(gateKey)) return;

    this.registeredGateRules.add(gateKey);

    // Rule for gate passed
    this.notificationRouter.addRule({
      id: `qgate-pass-${gateKey}`,
      name: `Quality Gate "${gate.name}" Passed (auto-registered)`,
      events: ["quality:gate:passed"],
      condition: { field: "gateName", op: "==", value: gate.name },
      channels: gate.notifyChannels,
      severity: "info",
    });

    // Rule for gate failed
    this.notificationRouter.addRule({
      id: `qgate-fail-${gateKey}`,
      name: `Quality Gate "${gate.name}" Failed (auto-registered)`,
      events: ["quality:gate:failed"],
      condition: { field: "gateName", op: "==", value: gate.name },
      channels: gate.notifyChannels,
      severity: "critical",
    });
  }

  /** Clear gate evaluation cache (e.g. when a mission is retried) */
  clearGateCache(missionId?: string): void {
    if (missionId) {
      for (const key of this.evaluatedGates) {
        if (key.startsWith(`${missionId}:`)) {
          this.evaluatedGates.delete(key);
        }
      }
    } else {
      this.evaluatedGates.clear();
    }
  }

  dispose(): void {
    this.metrics.clear();
    this.evaluatedGates.clear();
    this.registeredGateRules.clear();
  }
}
