/**
 * OrchestratorEngine — pure orchestration logic extracted from the root Orchestrator.
 *
 * Contains:
 * - tick() loop + run() polling
 * - Result collection + assessment delegation
 * - Task, Agent, Mission, Memory, Approval, Checkpoint, Delay delegation facades
 * - Store accessors and status
 *
 * ZERO Node.js imports. All runtime-specific behavior is injected via
 * OrchestratorContext and the port interfaces defined below.
 */

import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { ApprovalManager } from "./approval-manager.js";
import type { Scheduler } from "./scheduler.js";
import type { SLAMonitor } from "./sla-monitor.js";
import type { QualityController } from "./quality-controller.js";
import type { EscalationManager } from "./escalation-manager.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import type { SessionStore } from "./session-store.js";
import type { TeamStore } from "./team-store.js";
import type { AgentStore } from "./agent-store.js";
import { agentMemoryScope } from "./memory-store.js";
import type {
  PolpoConfig,
  AgentConfig,
  Task,
  TaskResult,
  TaskExpectation,
  ExpectedOutcome,
  Team,
  Mission,
  MissionStatus,
  MissionCheckpoint,
  MissionDelay,
  MissionQualityGate,
  RetryPolicy,
  ScopedNotificationRules,
  ApprovalRequest,
  ApprovalStatus,
} from "./types.js";

// ── Port Interfaces ──────────────────────────────────────────────────────
// These define what the engine needs from runtime-specific classes
// (TaskRunner, AssessmentOrchestrator, MissionExecutor) that live in the shell.

/**
 * Port for task spawning, result collection, and health monitoring.
 * Implemented by TaskRunner in the shell layer.
 */
export interface TaskRunnerPort {
  collectResults(onResult: (taskId: string, result: TaskResult) => void): Promise<void>;
  enforceHealthChecks(): Promise<void>;
  spawnForTask(task: Task): Promise<void>;
  syncProcessesFromRunStore(): Promise<void>;
  recoverOrphanedTasks(): Promise<number>;
}

/**
 * Port for the assessment pipeline.
 * Implemented by AssessmentOrchestrator in the shell layer.
 */
export interface AssessmentOrchestratorPort {
  handleResult(taskId: string, result: TaskResult): void;
  retryOrFail(taskId: string, task: Task, result: TaskResult): Promise<void>;
}

/**
 * Port for mission lifecycle management.
 * Implemented by MissionExecutor in the shell layer.
 */
export interface MissionExecutorPort {
  readonly ready: Promise<void>;
  saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules }): Promise<Mission>;
  getMission(missionId: string): Promise<Mission | undefined>;
  getMissionByName(name: string): Promise<Mission | undefined>;
  getAllMissions(): Promise<Mission[]>;
  updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission>;
  deleteMission(missionId: string): Promise<boolean>;
  executeMission(missionId: string): Promise<{ tasks: Task[]; group: string }>;
  resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }>;
  getResumableMissions(): Promise<Mission[]>;
  cleanupCompletedGroups(tasks: Task[]): Promise<void>;
  getQualityGates(group: string): MissionQualityGate[];
  getCheckpoints(group: string): MissionCheckpoint[];
  getBlockingCheckpoint(group: string, taskTitle: string, taskId: string, allTasks: Task[]): Promise<{ checkpoint: MissionCheckpoint; reachedAt: string } | undefined>;
  getDelays(group: string): MissionDelay[];
  getBlockingDelay(group: string, taskTitle: string, taskId: string, allTasks: Task[]): Promise<{ delay: MissionDelay; startedAt: string; expiresAt: string } | undefined>;
  getActiveCheckpoints(): Array<{ group: string; checkpointName: string; checkpoint: MissionCheckpoint; reachedAt: string }>;
  getActiveDelays(): Array<{ group: string; delayName: string; delay: MissionDelay; startedAt: string; expiresAt: string }>;
  resumeCheckpoint(group: string, checkpointName: string): Promise<boolean>;
  // Atomic mission data operations
  addMissionTask(missionId: string, task: { title: string; description: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission>;
  updateMissionTask(missionId: string, taskTitle: string, updates: { title?: string; description?: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission>;
  removeMissionTask(missionId: string, taskTitle: string): Promise<Mission>;
  reorderMissionTasks(missionId: string, titles: string[]): Promise<Mission>;
  addMissionCheckpoint(missionId: string, cp: { name: string; afterTasks: string[]; blocksTasks: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission>;
  updateMissionCheckpoint(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission>;
  removeMissionCheckpoint(missionId: string, name: string): Promise<Mission>;
  addMissionQualityGate(missionId: string, gate: { name: string; afterTasks: string[]; blocksTasks: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission>;
  updateMissionQualityGate(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission>;
  removeMissionQualityGate(missionId: string, name: string): Promise<Mission>;
  addMissionDelay(missionId: string, delay: { name: string; afterTasks: string[]; blocksTasks: string[]; duration: string; notifyChannels?: string[]; message?: string }): Promise<Mission>;
  updateMissionDelay(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; duration?: string; notifyChannels?: string[]; message?: string }): Promise<Mission>;
  removeMissionDelay(missionId: string, name: string): Promise<Mission>;
  addMissionTeamMember(missionId: string, member: { name: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission>;
  updateMissionTeamMember(missionId: string, memberName: string, updates: { name?: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission>;
  removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission>;
  updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Promise<Mission>;
}

/**
 * Port for deadlock analysis and resolution.
 * Implemented by the deadlock-resolver module in the shell layer.
 */
export interface DeadlockResolverPort {
  isResolving(): boolean;
  analyzeBlockedTasks(pending: Task[], allTasks: Task[]): { resolvable: unknown[]; unresolvable: unknown[] };
  resolveDeadlock(analysis: { resolvable: unknown[]; unresolvable: unknown[] }, facade: DeadlockFacade): Promise<void>;
}

/**
 * Minimal facade the deadlock resolver needs from the engine.
 * The shell's resolveDeadlock() originally took an Orchestrator —
 * this interface provides the same surface.
 */
export interface DeadlockFacade {
  getConfig(): PolpoConfig | null;
  getMemory(): Promise<string>;
  getStore(): TaskStore;
  emit(event: string, payload: unknown): boolean;
  forceFailTask(taskId: string): Promise<void>;
  addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[]; group?: string;
  }): Promise<Task>;
}

/**
 * Port for the task watcher manager.
 * Implemented by TaskWatcherManager in the shell layer.
 */
export interface TaskWatcherManagerPort {
  // Engine only needs the type reference — watcher is wired in the shell
}

// ── Engine Dependencies ──────────────────────────────────────────────────

export interface OrchestratorEngineDeps {
  ctx: OrchestratorContext;
  taskManager: TaskManager;
  agentManager: AgentManager;
  missionExecutor: MissionExecutorPort;
  taskRunner: TaskRunnerPort;
  assessmentOrchestrator: AssessmentOrchestratorPort;
  approvalManager?: ApprovalManager;
  scheduler?: Scheduler;
  slaMonitor?: SLAMonitor;
  qualityController?: QualityController;
  escalationManager?: EscalationManager;
  deadlockResolver?: DeadlockResolverPort;
}

// ── Utility ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const POLL_INTERVAL = 5000; // 5s safety net (push notification is primary)

// ── OrchestratorEngine ──────────────────────────────────────────────────

/**
 * Pure orchestration engine — no Node.js dependencies.
 *
 * The root Orchestrator creates an instance of this class and delegates
 * all pure-logic methods to it, keeping Node.js-specific init/setup/shutdown
 * in the shell layer.
 */
export class OrchestratorEngine {
  private ctx: OrchestratorContext;
  private taskMgr: TaskManager;
  private agentMgr: AgentManager;
  private missionExec: MissionExecutorPort;
  private runner: TaskRunnerPort;
  private assessor: AssessmentOrchestratorPort;
  private approvalMgr?: ApprovalManager;
  private scheduler?: Scheduler;
  private slaMonitor?: SLAMonitor;
  private qualityController?: QualityController;
  private escalationMgr?: EscalationManager;
  private deadlockResolver?: DeadlockResolverPort;
  private stopped = false;

  constructor(deps: OrchestratorEngineDeps) {
    this.ctx = deps.ctx;
    this.taskMgr = deps.taskManager;
    this.agentMgr = deps.agentManager;
    this.missionExec = deps.missionExecutor;
    this.runner = deps.taskRunner;
    this.assessor = deps.assessmentOrchestrator;
    this.approvalMgr = deps.approvalManager;
    this.scheduler = deps.scheduler;
    this.slaMonitor = deps.slaMonitor;
    this.qualityController = deps.qualityController;
    this.escalationMgr = deps.escalationManager;
    this.deadlockResolver = deps.deadlockResolver;
  }

  // ── Mutable setters (for hot-reload) ─────────────────────────────────

  setScheduler(scheduler: Scheduler | undefined): void { this.scheduler = scheduler; }
  setSLAMonitor(slaMonitor: SLAMonitor | undefined): void { this.slaMonitor = slaMonitor; }
  setQualityController(qualityController: QualityController | undefined): void { this.qualityController = qualityController; }
  setEscalationManager(escalationManager: EscalationManager | undefined): void { this.escalationMgr = escalationManager; }
  setApprovalManager(approvalManager: ApprovalManager | undefined): void { this.approvalMgr = approvalManager; }
  setDeadlockResolver(deadlockResolver: DeadlockResolverPort | undefined): void { this.deadlockResolver = deadlockResolver; }

  // ── Core tick loop ───────────────────────────────────────────────────

  /**
   * Main supervisor loop. Runs until all tasks are done/failed.
   * In interactive mode, keeps running and waits for new tasks.
   *
   * @param interactive - Whether to keep running after all tasks complete
   * @param onBeforeLoop - Shell hook called before the loop starts (e.g. to install process handlers)
   * @param onAfterLoop - Shell hook called after the loop exits (e.g. to clean up process handlers)
   */
  async run(interactive: boolean, onBeforeLoop?: () => void, onAfterLoop?: () => void): Promise<void> {
    this.ctx.emitter.emit("orchestrator:started", {
      project: this.ctx.config.project,
      agents: (await this.agentMgr.getAgents()).map((a: AgentConfig) => a.name),
    });

    this.stopped = false;
    onBeforeLoop?.();

    // Supervisor loop
    while (!this.stopped) {
      try {
        const allDone = await this.tick();
        if (allDone && !interactive) break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.emitter.emit("log", { level: "error", message: `[supervisor] Error in tick: ${message}` });
      }
      await sleep(POLL_INTERVAL);
    }

    onAfterLoop?.();
  }

  /**
   * Single tick of the supervisor loop. Returns true when all work is done.
   */
  async tick(): Promise<boolean> {
    // Scheduler checks FIRST — must run before early-return guards because
    // scheduled/recurring missions have zero tasks until triggered, and the
    // scheduler is what creates them via executeMission.
    this.scheduler?.check();

    const tasks = await this.ctx.registry.getAllTasks();
    if (tasks.length === 0) return !this.isStopped();

    const pending = tasks.filter(t => t.status === "pending");
    const awaitingApproval = tasks.filter(t => t.status === "awaiting_approval");
    const inProgress = tasks.filter(t => t.status === "in_progress" || t.status === "assigned" || t.status === "review");

    // Check if all active tasks are terminal (done or failed)
    // draft tasks are excluded — they don't participate in orchestration
    // awaiting_approval tasks are NOT terminal — they're waiting for human action
    const activeTasks = tasks.filter(t => t.status !== "draft");
    const terminal = activeTasks.filter(t => t.status === "done" || t.status === "failed");
    if (activeTasks.length > 0 && terminal.length === activeTasks.length) {
      // Must run cleanup BEFORE returning — assessment transitions happen async
      // between ticks, so this may be the first tick that sees all tasks terminal.
      await this.missionExec.cleanupCompletedGroups(tasks);
      await this.runner.syncProcessesFromRunStore();
      return true;
    }

    // 1. Collect results from finished runners
    await this.runner.collectResults((id, res) => this.assessor.handleResult(id, res));

    // 2. Enforce health checks (timeouts + stale detection)
    await this.runner.enforceHealthChecks();

    // 2b. SLA deadline checks
    this.slaMonitor?.check();

    // 3. Spawn agents for ready tasks (skip tasks from cancelled/completed/paused missions)
    const readyList: Task[] = [];
    for (const task of pending) {
      let isReady = true;
      if (task.group) {
        // Resolve mission via direct ID (preferred) or group name (legacy fallback)
        const mission = task.missionId
          ? await this.ctx.registry.getMission?.(task.missionId)
          : await this.ctx.registry.getMissionByName?.(task.group);
        if (mission && (mission.status === "cancelled" || mission.status === "completed" || mission.status === "paused")) { isReady = false; }

        // Check quality gates — task may be blocked by a gate even if deps are done
        if (isReady && this.qualityController) {
          const gates = this.missionExec.getQualityGates(task.group);
          if (gates.length > 0) {
            const blocking = this.qualityController.getBlockingGate(
              mission?.id ?? task.group,
              task.title,
              task.id,
              gates,
              tasks,
            );
            if (blocking) isReady = false; // Blocked by quality gate
          }
        }

        // Check checkpoints — task may be blocked by a checkpoint awaiting human resume
        if (isReady) {
          const checkpoints = this.missionExec.getCheckpoints(task.group);
          if (checkpoints.length > 0) {
            const blockingCp = await this.missionExec.getBlockingCheckpoint(
              task.group,
              task.title,
              task.id,
              tasks,
            );
            if (blockingCp) isReady = false; // Blocked by checkpoint
          }
        }

        // Check delays — task may be blocked by a timed delay
        if (isReady) {
          const delays = this.missionExec.getDelays(task.group);
          if (delays.length > 0) {
            const blockingDelay = await this.missionExec.getBlockingDelay(
              task.group,
              task.title,
              task.id,
              tasks,
            );
            if (blockingDelay) isReady = false; // Blocked by delay
          }
        }
      }
      if (isReady) {
        isReady = task.dependsOn.every(depId => {
          const dep = tasks.find(t => t.id === depId);
          return dep && dep.status === "done";
        });
      }
      if (isReady) readyList.push(task);
    }
    const ready = readyList;

    // Check for deadlock: no tasks ready, none running, but some pending
    // Don't consider it a deadlock if tasks are awaiting approval, blocked by checkpoints, or waiting on delays
    const hasActiveCheckpoints = this.missionExec.getActiveCheckpoints().length > 0;
    const hasActiveDelays = this.missionExec.getActiveDelays().length > 0;
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0 && awaitingApproval.length === 0 && !hasActiveCheckpoints && !hasActiveDelays) {
      if (this.deadlockResolver) {
        // Async resolution already in progress — wait for next tick
        if (this.deadlockResolver.isResolving()) return false;

        const analysis = this.deadlockResolver.analyzeBlockedTasks(pending, tasks);

        if (analysis.resolvable.length > 0) {
          this.ctx.emitter.emit("deadlock:detected", {
            taskIds: pending.map(t => t.id),
            resolvableCount: analysis.resolvable.length,
          });

          // Build the facade that the deadlock resolver needs
          const facade = this.buildDeadlockFacade();

          // Async LLM resolution (same pattern as question detection)
          this.deadlockResolver.resolveDeadlock(analysis, facade).catch(async err => {
            this.ctx.emitter.emit("log", { level: "error", message: `Deadlock resolution failed: ${(err as Error).message}` });
            for (const t of pending) await this.forceFailTask(t.id);
          });

          return false; // Don't terminate loop — resolution pending
        }
      }

      // Only missing deps (unresolvable) → force-fail all
      this.ctx.emitter.emit("orchestrator:deadlock", { taskIds: pending.map(t => t.id) });
      for (const t of pending) await this.forceFailTask(t.id);
      return true;
    }

    // Concurrency-aware spawn loop
    const activeRuns = await this.ctx.runStore.getActiveRuns();
    const globalMax = this.ctx.config.settings.maxConcurrency ?? Infinity;
    let totalActive = activeRuns.length;

    // Per-agent active counts
    const agentActiveCounts = new Map<string, number>();
    for (const run of activeRuns) {
      agentActiveCounts.set(run.agentName, (agentActiveCounts.get(run.agentName) ?? 0) + 1);
    }

    let queued = 0;
    for (const task of ready) {
      // Global concurrency limit
      if (totalActive >= globalMax) {
        queued += ready.length - ready.indexOf(task);
        break;
      }

      // Skip if already running
      const existingRun = await this.ctx.runStore.getRunByTaskId(task.id);
      if (existingRun && existingRun.status === "running") continue;

      // Per-agent concurrency limit
      const agentName = task.assignTo;
      const agentConfig = await this.agentMgr.findAgent(agentName);
      if (agentConfig?.maxConcurrency) {
        if ((agentActiveCounts.get(agentName) ?? 0) >= agentConfig.maxConcurrency) {
          queued++;
          continue;
        }
      }

      await this.runner.spawnForTask(task);
      totalActive++;
      agentActiveCounts.set(agentName, (agentActiveCounts.get(agentName) ?? 0) + 1);
    }

    // Emit tick stats
    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    this.ctx.emitter.emit("orchestrator:tick", {
      pending: pending.length,
      running: inProgress.length,
      done,
      failed,
      queued,
    });

    // Clean up volatile agents for completed mission groups.
    // Re-read tasks fresh — assessment callbacks (async) may have transitioned
    // tasks to done/failed since the snapshot at the top of tick().
    await this.missionExec.cleanupCompletedGroups(await this.ctx.registry.getAllTasks());

    // Sync process list from RunStore for backward compat
    await this.runner.syncProcessesFromRunStore();

    return false;
  }

  /** Build the minimal facade that the deadlock resolver needs. */
  private buildDeadlockFacade(): DeadlockFacade {
    return {
      getConfig: () => this.getConfig(),
      getMemory: () => this.getMemory(),
      getStore: () => this.getStore(),
      emit: (event: string, payload: unknown) => this.ctx.emitter.emit(event, payload),
      forceFailTask: (taskId: string) => this.forceFailTask(taskId),
      addTask: (opts) => this.addTask(opts),
    };
  }

  // ── Stop control ────────────────────────────────────────────────────

  stop(): void { this.stopped = true; }
  isStopped(): boolean { return this.stopped; }

  // ── Task Management (delegates to TaskManager) ──────────────────────

  async addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[]; group?: string; maxDuration?: number; retryPolicy?: RetryPolicy;
    notifications?: ScopedNotificationRules; sideEffects?: boolean; draft?: boolean;
  }): Promise<Task> { return this.taskMgr.addTask(opts); }

  async updateTaskDescription(taskId: string, description: string): Promise<void> { return this.taskMgr.updateTaskDescription(taskId, description); }
  async updateTaskAssignment(taskId: string, agentName: string): Promise<void> { return this.taskMgr.updateTaskAssignment(taskId, agentName); }
  async updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): Promise<void> { return this.taskMgr.updateTaskExpectations(taskId, expectations); }
  async retryTask(taskId: string): Promise<void> { return this.taskMgr.retryTask(taskId); }
  reassessTask(taskId: string): Promise<void> { return this.taskMgr.reassessTask(taskId); }
  async killTask(taskId: string): Promise<boolean> { return this.taskMgr.killTask(taskId); }
  async deleteTask(taskId: string): Promise<boolean> { return this.ctx.registry.removeTask(taskId); }

  async abortGroup(group: string): Promise<number> {
    const count = await this.taskMgr.abortGroup(group);
    // Clean up any schedule tied to this mission group — resolve via task.missionId first
    const groupTasks = (await this.ctx.registry.getAllTasks()).filter(t => t.group === group);
    const mid = groupTasks.find(t => t.missionId)?.missionId;
    const mission = mid ? await this.ctx.registry.getMission?.(mid) : await this.ctx.registry.getMissionByName?.(group);
    if (mission) this.scheduler?.unregisterMission(mission.id);
    return count;
  }

  async clearTasks(filter: (task: Task) => boolean): Promise<number> { return this.taskMgr.clearTasks(filter); }
  async forceFailTask(taskId: string): Promise<void> { return this.taskMgr.forceFailTask(taskId); }

  // ── Approval Management ─────────────────────────────────────────────

  async approveRequest(requestId: string, resolvedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    return (await this.approvalMgr?.approve(requestId, resolvedBy, note)) ?? null;
  }
  async rejectRequest(requestId: string, feedback: string, resolvedBy?: string): Promise<ApprovalRequest | null> {
    return (await this.approvalMgr?.reject(requestId, feedback, resolvedBy)) ?? null;
  }
  async canRejectRequest(requestId: string): Promise<{ allowed: boolean; rejectionCount: number; maxRejections: number }> {
    return (await this.approvalMgr?.canReject(requestId)) ?? { allowed: false, rejectionCount: 0, maxRejections: 0 };
  }
  async getPendingApprovals(): Promise<ApprovalRequest[]> {
    return (await this.approvalMgr?.getPending()) ?? [];
  }
  async getAllApprovals(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return (await this.approvalMgr?.getAll(status)) ?? [];
  }
  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    return this.approvalMgr?.getRequest(id);
  }

  // ── Store Accessors ─────────────────────────────────────────────────

  getStore(): TaskStore { return this.ctx.registry; }
  getRunStore(): RunStore { return this.ctx.runStore; }
  getMemoryStore(): MemoryStore { return this.ctx.memoryStore; }
  getConfig(): PolpoConfig | null { return this.ctx.config; }
  getLogStore(): LogStore | undefined { return this.ctx.logStore; }
  getSessionStore(): SessionStore | undefined { return this.ctx.sessionStore; }
  getTeamStore(): TeamStore { return this.ctx.teamStore; }
  getAgentStore(): AgentStore { return this.ctx.agentStore; }

  // ── Agent Management (delegates to AgentManager) ────────────────────

  async getAgents(): Promise<AgentConfig[]> { return this.agentMgr.getAgents(); }
  async getTeams(): Promise<Team[]> { return this.agentMgr.getTeams(); }
  async getTeam(name?: string): Promise<Team | undefined> { return this.agentMgr.getTeam(name); }
  async addTeam(team: Team): Promise<void> { return this.agentMgr.addTeam(team); }
  async removeTeam(name: string): Promise<boolean> { return this.agentMgr.removeTeam(name); }
  async renameTeam(oldName: string, newName: string): Promise<void> { return this.agentMgr.renameTeam(oldName, newName); }
  async addAgent(agent: AgentConfig, teamName?: string): Promise<void> { return this.agentMgr.addAgent(agent, teamName); }
  async removeAgent(name: string): Promise<boolean> { return this.agentMgr.removeAgent(name); }
  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> { return this.agentMgr.updateAgent(name, updates); }
  async findAgentTeam(name: string): Promise<Team | undefined> { return this.agentMgr.findAgentTeam(name); }
  async addVolatileAgent(agent: AgentConfig, group: string): Promise<void> { return this.agentMgr.addVolatileAgent(agent, group); }
  async cleanupVolatileAgents(group: string): Promise<number> { return this.agentMgr.cleanupVolatileAgents(group); }

  // ── Mission Management (delegates to MissionExecutor) ───────────────

  async saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules }): Promise<Mission> { return this.missionExec.saveMission(opts); }
  async getMission(missionId: string): Promise<Mission | undefined> { return this.missionExec.getMission(missionId); }
  async getMissionByName(name: string): Promise<Mission | undefined> { return this.missionExec.getMissionByName(name); }
  async getAllMissions(): Promise<Mission[]> { return this.missionExec.getAllMissions(); }
  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> { return this.missionExec.updateMission(missionId, updates); }
  async deleteMission(missionId: string): Promise<boolean> {
    const result = await this.missionExec.deleteMission(missionId);
    if (result) this.scheduler?.unregisterMission(missionId);
    return result;
  }

  // ── Atomic Mission Data Operations (delegates to MissionExecutor) ───

  async addMissionTask(missionId: string, task: { title: string; description: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission> {
    return this.missionExec.addMissionTask(missionId, task);
  }
  async updateMissionTask(missionId: string, taskTitle: string, updates: { title?: string; description?: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission> {
    return this.missionExec.updateMissionTask(missionId, taskTitle, updates);
  }
  async removeMissionTask(missionId: string, taskTitle: string): Promise<Mission> {
    return this.missionExec.removeMissionTask(missionId, taskTitle);
  }
  async reorderMissionTasks(missionId: string, titles: string[]): Promise<Mission> {
    return this.missionExec.reorderMissionTasks(missionId, titles);
  }
  async addMissionCheckpoint(missionId: string, cp: { name: string; afterTasks: string[]; blocksTasks: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.missionExec.addMissionCheckpoint(missionId, cp);
  }
  async updateMissionCheckpoint(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.missionExec.updateMissionCheckpoint(missionId, name, updates);
  }
  async removeMissionCheckpoint(missionId: string, name: string): Promise<Mission> {
    return this.missionExec.removeMissionCheckpoint(missionId, name);
  }
  async addMissionQualityGate(missionId: string, gate: { name: string; afterTasks: string[]; blocksTasks: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission> {
    return this.missionExec.addMissionQualityGate(missionId, gate);
  }
  async updateMissionQualityGate(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission> {
    return this.missionExec.updateMissionQualityGate(missionId, name, updates);
  }
  async removeMissionQualityGate(missionId: string, name: string): Promise<Mission> {
    return this.missionExec.removeMissionQualityGate(missionId, name);
  }
  async addMissionDelay(missionId: string, delay: { name: string; afterTasks: string[]; blocksTasks: string[]; duration: string; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.missionExec.addMissionDelay(missionId, delay);
  }
  async updateMissionDelay(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; duration?: string; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.missionExec.updateMissionDelay(missionId, name, updates);
  }
  async removeMissionDelay(missionId: string, name: string): Promise<Mission> {
    return this.missionExec.removeMissionDelay(missionId, name);
  }
  async addMissionTeamMember(missionId: string, member: { name: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission> {
    return this.missionExec.addMissionTeamMember(missionId, member);
  }
  async updateMissionTeamMember(missionId: string, memberName: string, updates: { name?: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission> {
    return this.missionExec.updateMissionTeamMember(missionId, memberName, updates);
  }
  async removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission> {
    return this.missionExec.removeMissionTeamMember(missionId, memberName);
  }
  async updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Promise<Mission> {
    return this.missionExec.updateMissionNotifications(missionId, notifications);
  }

  // ── Shared Memory ──────────────────────────────────────────────────

  async hasMemory(): Promise<boolean> {
    return (await this.ctx.memoryStore?.exists()) ?? false;
  }

  async getMemory(): Promise<string> {
    return (await this.ctx.memoryStore?.get()) ?? "";
  }

  async saveMemory(content: string): Promise<void> {
    await this.ctx.memoryStore?.save(content);
  }

  async appendMemory(line: string): Promise<void> {
    await this.ctx.memoryStore?.append(line);
  }

  async updateMemory(oldText: string, newText: string): Promise<true | string> {
    if (!this.ctx.memoryStore) return "No memory store configured.";
    return this.ctx.memoryStore.update(oldText, newText);
  }

  // ── Agent Memory ───────────────────────────────────────────────────

  async hasAgentMemory(agentName: string): Promise<boolean> {
    return (await this.ctx.memoryStore?.exists(agentMemoryScope(agentName))) ?? false;
  }

  async getAgentMemory(agentName: string): Promise<string> {
    return (await this.ctx.memoryStore?.get(agentMemoryScope(agentName))) ?? "";
  }

  async saveAgentMemory(agentName: string, content: string): Promise<void> {
    await this.ctx.memoryStore?.save(content, agentMemoryScope(agentName));
  }

  async appendAgentMemory(agentName: string, line: string): Promise<void> {
    await this.ctx.memoryStore?.append(line, agentMemoryScope(agentName));
  }

  async updateAgentMemory(agentName: string, oldText: string, newText: string): Promise<true | string> {
    if (!this.ctx.memoryStore) return "No memory store configured.";
    return this.ctx.memoryStore.update(oldText, newText, agentMemoryScope(agentName));
  }

  // ── Mission Resume / Execute ───────────────────────────────────────

  async getResumableMissions(): Promise<Mission[]> { return this.missionExec.getResumableMissions(); }
  async resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }> { return this.missionExec.resumeMission(missionId, opts); }
  async executeMission(missionId: string): Promise<{ tasks: Task[]; group: string }> { return this.missionExec.executeMission(missionId); }

  // ── Checkpoints ────────────────────────────────────────────────────

  getActiveCheckpoints() { return this.missionExec.getActiveCheckpoints(); }

  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    return this.missionExec.resumeCheckpoint(group, checkpointName);
  }

  async resumeCheckpointByMissionId(missionId: string, checkpointName: string): Promise<boolean> {
    const mission = await this.missionExec.getMission(missionId);
    if (!mission) return false;
    return this.missionExec.resumeCheckpoint(mission.name, checkpointName);
  }

  // ── Delays ─────────────────────────────────────────────────────────

  getActiveDelays() { return this.missionExec.getActiveDelays(); }

  // ── Recovery ───────────────────────────────────────────────────────

  async recoverOrphanedTasks(): Promise<number> { return this.runner.recoverOrphanedTasks(); }
}
