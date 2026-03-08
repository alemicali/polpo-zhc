import type { OrchestratorContext } from "./orchestrator-context.js";
import type { NotificationRouterPort } from "./notification-router-port.js";
import type { MissionQualityGate, QualityMetrics, Task, Mission, AssessmentResult } from "./types.js";

/**
 * QualityController — manages quality gates within missions and aggregates
 * quality metrics across tasks, agents, and missions.
 */
export class QualityController {
  private metrics = new Map<string, QualityMetrics>();
  private evaluatedGates = new Set<string>();
  private registeredGateRules = new Set<string>();
  private notificationRouter?: NotificationRouterPort;

  constructor(
    private ctx: OrchestratorContext,
  ) {}

  setNotificationRouter(router: NotificationRouterPort): void {
    this.notificationRouter = router;
  }

  init(): void {
    this.ctx.hooks.register({
      hook: "assessment:complete",
      phase: "after",
      priority: 200,
      name: "quality-controller:collect-metrics",
      handler: (hookCtx) => {
        const { taskId, task, assessment, passed } = hookCtx.data;
        this.recordAssessment(taskId, "task", assessment, passed);
        if (task.assignTo) {
          this.recordAssessment(task.assignTo, "agent", assessment, passed);
        }
      },
    });

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

        if (task.assignTo) {
          const agentKey = this.metricsKey("agent", task.assignTo);
          const am = this.getOrCreate(agentKey, task.assignTo, "agent");
          am.totalRetries++;
          am.updatedAt = new Date().toISOString();
        }
      },
    });
  }

  evaluateGate(
    missionId: string,
    gate: MissionQualityGate,
    tasks: Task[],
  ): { passed: boolean; reason?: string; avgScore?: number } {
    const gateKey = `${missionId}:${gate.name}`;

    this.ensureGateNotificationRules(gateKey, gate);

    if (this.evaluatedGates.has(gateKey)) {
      return { passed: true };
    }

    const afterTasks = tasks.filter(t => gate.afterTasks.includes(t.title) || gate.afterTasks.includes(t.id));

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
      return { passed: true, threshold };
    }

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

    if (assessment.scores) {
      for (const ds of assessment.scores) {
        if (!m.dimensionScores[ds.dimension]) {
          m.dimensionScores[ds.dimension] = ds.score;
        } else {
          m.dimensionScores[ds.dimension] =
            (m.dimensionScores[ds.dimension] * (m.totalAssessments - 1) + ds.score) / m.totalAssessments;
        }
      }
    }

    if (entityType === "task" && assessment.trigger === "fix") {
      m.totalFixes++;
    }

    m.updatedAt = new Date().toISOString();
  }

  getMetrics(entityType: "task" | "agent" | "mission", entityId: string): QualityMetrics | undefined {
    return this.metrics.get(this.metricsKey(entityType, entityId));
  }

  getAllMetrics(entityType?: "task" | "agent" | "mission"): QualityMetrics[] {
    const all = [...this.metrics.values()];
    if (entityType) return all.filter(m => m.entityType === entityType);
    return all;
  }

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

  private getScoresArray(m: QualityMetrics): number[] {
    if (m.avgScore !== undefined && m.totalAssessments > 0) {
      return Array(m.totalAssessments - 1).fill(m.avgScore);
    }
    return [];
  }

  private ensureGateNotificationRules(gateKey: string, gate: MissionQualityGate): void {
    if (!this.notificationRouter) return;
    if (!gate.notifyChannels || gate.notifyChannels.length === 0) return;
    if (this.registeredGateRules.has(gateKey)) return;

    this.registeredGateRules.add(gateKey);

    this.notificationRouter.addRule({
      id: `qgate-pass-${gateKey}`,
      name: `Quality Gate "${gate.name}" Passed (auto-registered)`,
      events: ["quality:gate:passed"],
      condition: { field: "gateName", op: "==", value: gate.name },
      channels: gate.notifyChannels,
      severity: "info",
    });

    this.notificationRouter.addRule({
      id: `qgate-fail-${gateKey}`,
      name: `Quality Gate "${gate.name}" Failed (auto-registered)`,
      events: ["quality:gate:failed"],
      condition: { field: "gateName", op: "==", value: gate.name },
      channels: gate.notifyChannels,
      severity: "critical",
    });
  }

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
