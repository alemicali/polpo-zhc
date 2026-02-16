import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { Server } from "node:net";
import { parseConfig, loadPolpoConfig } from "./config.js";
import { FileTaskStore } from "../stores/file-task-store.js";
import { FileRunStore } from "../stores/file-run-store.js";
import { FileMemoryStore } from "../stores/file-memory-store.js";
import { FileLogStore } from "../stores/file-log-store.js";
import { FileSessionStore } from "../stores/file-session-store.js";
import type { SessionStore } from "./session-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import { assessTask } from "../assessment/assessor.js";
import { analyzeBlockedTasks, resolveDeadlock, isResolving } from "./deadlock-resolver.js";
import { TypedEmitter } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type {
  PolpoConfig,
  AgentConfig,
  Task,
  TaskResult,
  TaskExpectation,
  ExpectedOutcome,
  Team,
  Plan,
  PlanStatus,
  RetryPolicy,
} from "./types.js";
import { AgentManager } from "./agent-manager.js";
import { TaskManager } from "./task-manager.js";
import { PlanExecutor } from "./plan-executor.js";
import { TaskRunner } from "./task-runner.js";
import { AssessmentOrchestrator } from "./assessment-orchestrator.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import {
  buildFixPrompt,
  buildRetryPrompt,
  sleep,
} from "./assessment-prompts.js";
import type { AssessFn } from "./orchestrator-context.js";
import { setProviderOverrides, validateProviderKeys } from "../llm/pi-client.js";
import { startNotificationServer } from "./notification.js";
import { HookRegistry } from "./hooks.js";
import { ApprovalManager } from "./approval-manager.js";
import { FileApprovalStore } from "../stores/file-approval-store.js";
import { NotificationRouter } from "../notifications/index.js";
import { FileNotificationStore } from "../stores/file-notification-store.js";
import { TelegramCallbackPoller } from "../notifications/channels/telegram.js";
import type { ApprovalCallbackResolver } from "../notifications/channels/telegram.js";
import { EscalationManager } from "./escalation-manager.js";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { QualityController } from "../quality/quality-controller.js";
import { Scheduler } from "../scheduling/scheduler.js";
import type { ApprovalRequest, ApprovalStatus } from "./types.js";

// Re-export for backward compatibility (consumed by core/index.ts and external modules)
export { buildFixPrompt, buildRetryPrompt };
export type { AssessFn };

const POLL_INTERVAL = 5000; // 5s safety net (push notification is primary)

export interface OrchestratorOptions {
  workDir?: string;
  store?: TaskStore;
  runStore?: RunStore;
  assessFn?: AssessFn;
}

export class Orchestrator extends TypedEmitter {
  private registry!: TaskStore;
  private runStore!: RunStore;
  private config!: PolpoConfig;
  private polpoDir: string;
  private workDir: string;
  private interactive = false;
  private stopped = false;
  private assessFn: AssessFn;
  private injectedStore?: TaskStore;
  private injectedRunStore?: RunStore;
  private memoryStore!: MemoryStore;
  private logStore!: LogStore;
  private sessionStore!: SessionStore;
  private notificationServer?: Server;
  private hookRegistry = new HookRegistry();
  private approvalMgr?: ApprovalManager;
  private notificationRouter?: NotificationRouter;
  private escalationMgr?: EscalationManager;
  private slaMonitor?: SLAMonitor;
  private qualityController?: QualityController;
  private scheduler?: Scheduler;
  private telegramPoller?: TelegramCallbackPoller;

  // Managers
  private agentMgr!: AgentManager;
  private taskMgr!: TaskManager;
  private planExec!: PlanExecutor;
  private runner!: TaskRunner;
  private assessor!: AssessmentOrchestrator;

  getWorkDir(): string { return this.workDir; }
  getHooks(): HookRegistry { return this.hookRegistry; }
  getNotificationRouter(): NotificationRouter | undefined { return this.notificationRouter; }
  getSLAMonitor(): SLAMonitor | undefined { return this.slaMonitor; }
  getQualityController(): QualityController | undefined { return this.qualityController; }
  getScheduler(): Scheduler | undefined { return this.scheduler; }

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

  /** Create task + run stores based on the configured storage backend. */
  private async createStores(storage?: "file" | "sqlite"): Promise<{ task: TaskStore; run: RunStore }> {
    if (storage === "sqlite") {
      const { join } = await import("node:path");
      const { SqliteTaskStore } = await import("../stores/sqlite-task-store.js");
      const { SqliteRunStore } = await import("../stores/sqlite-run-store.js");
      return {
        task: new SqliteTaskStore(this.polpoDir),
        run: new SqliteRunStore(join(this.polpoDir, "state.db")),
      };
    }
    return {
      task: new FileTaskStore(this.polpoDir),
      run: new FileRunStore(this.polpoDir),
    };
  }

  async init(): Promise<void> {
    this.config = await parseConfig(this.workDir);

    // Apply provider overrides from config
    if (this.config.providers) {
      setProviderOverrides(this.config.providers);
    }

    // Validate API keys for all configured models
    this.validateProviders();

    const stores = this.injectedStore
      ? { task: this.injectedStore, run: this.injectedRunStore! }
      : await this.createStores(this.config.settings.storage);
    this.registry = stores.task;
    this.runStore = stores.run;
    this.memoryStore = new FileMemoryStore(this.polpoDir);
    this.initLogStore();
    this.initSessionStore();
    this.initManagers();
  }

  private validateProviders(): void {
    const modelSpecs: string[] = [];
    // Default model
    if (process.env.POLPO_MODEL) modelSpecs.push(process.env.POLPO_MODEL);
    // Orchestrator model
    if (this.config.settings.orchestratorModel) {
      modelSpecs.push(this.config.settings.orchestratorModel);
    }
    // Judge model
    if (process.env.POLPO_JUDGE_MODEL) modelSpecs.push(process.env.POLPO_JUDGE_MODEL);
    // Per-agent models
    for (const agent of this.config.team.agents) {
      if (agent.model) modelSpecs.push(agent.model);
    }

    if (modelSpecs.length === 0) return;

    const missing = validateProviderKeys(modelSpecs);
    if (missing.length > 0) {
      const details = missing
        .map(m => `  - ${m.provider} (model: ${m.modelSpec})`)
        .join("\n");
      this.emit("log", {
        level: "warn",
        message: `Missing API keys for providers:\n${details}\nSet the corresponding env vars or add them to .polpo/polpo.json providers section`,
      });
    }
  }

  /** Create manager instances with shared context. */
  private initManagers(): void {
    const ctx: OrchestratorContext = {
      emitter: this,
      registry: this.registry,
      runStore: this.runStore,
      memoryStore: this.memoryStore,
      logStore: this.logStore,
      sessionStore: this.sessionStore,
      hooks: this.hookRegistry,
      config: this.config,
      workDir: this.workDir,
      polpoDir: this.polpoDir,
      assessFn: this.assessFn,
    };
    this.agentMgr = new AgentManager(ctx);
    this.taskMgr = new TaskManager(ctx);
    this.planExec = new PlanExecutor(ctx, this.taskMgr, this.agentMgr);
    this.runner = new TaskRunner(ctx);
    this.assessor = new AssessmentOrchestrator(ctx);

    // Start push notification server (runners notify on completion)
    this.notificationServer = startNotificationServer(
      this.polpoDir,
      () => {
        this.runner.collectResults((id, res) => this.assessor.handleResult(id, res));
      },
    );

    // Initialize approval gates if configured
    if (this.config.settings.approvalGates && this.config.settings.approvalGates.length > 0) {
      const approvalStore = new FileApprovalStore(this.polpoDir);
      this.approvalMgr = new ApprovalManager(ctx, approvalStore);
      this.approvalMgr.init();
    }

    // Initialize notification router if configured
    if (this.config.settings.notifications) {
      this.notificationRouter = new NotificationRouter(this);
      this.notificationRouter.init(this.config.settings.notifications);
      // Attach persistent notification store
      const notifStore = new FileNotificationStore(this.polpoDir);
      this.notificationRouter.setStore(notifStore);
      this.notificationRouter.start();
    }

    // Wire notification router to approval manager (must happen after both are created)
    if (this.approvalMgr && this.notificationRouter) {
      this.approvalMgr.setNotificationRouter(this.notificationRouter);

      // Set outcome resolver so approval notifications can include task outcomes
      this.notificationRouter.setOutcomeResolver((taskId: string) => {
        const task = this.registry.getTask(taskId);
        return task?.outcomes;
      });

      // Start Telegram callback poller for interactive approval buttons
      this.startTelegramApprovalPoller();
    }

    // Initialize escalation manager if configured
    if (this.config.settings.escalationPolicy) {
      this.escalationMgr = new EscalationManager(ctx, this.approvalMgr);
      this.escalationMgr.init();
    }

    // Initialize SLA monitor if configured
    if (this.config.settings.sla) {
      this.slaMonitor = new SLAMonitor(ctx, this.config.settings.sla);
      // Wire notification router so SLA channels (warningChannels/violationChannels) work
      if (this.notificationRouter) {
        this.slaMonitor.setNotificationRouter(this.notificationRouter);
      }
      this.slaMonitor.init();
    }

    // Initialize quality controller (always available — zero-cost when unused)
    this.qualityController = new QualityController(ctx);
    // Wire notification router so per-gate notifyChannels work
    if (this.notificationRouter) {
      this.qualityController.setNotificationRouter(this.notificationRouter);
    }
    this.qualityController.init();
    this.planExec.setQualityController(this.qualityController);

    // Initialize scheduler if enabled or any plan has a schedule
    const hasScheduledPlans = (this.config.settings.enableScheduler !== false) &&
      (this.registry.getAllPlans?.() ?? []).some(p => !!p.schedule);
    if (this.config.settings.enableScheduler || hasScheduledPlans) {
      this.scheduler = new Scheduler(ctx);
      this.scheduler.setExecutor((planId) => this.planExec.executePlan(planId));
      this.scheduler.init();
    }
  }

  /**
   * Initialize for interactive/TUI mode.
   * Creates .polpo dir and a minimal config from provided team info.
   */
  async initInteractive(project: string, team: Team): Promise<void> {
    if (!existsSync(this.polpoDir)) {
      mkdirSync(this.polpoDir, { recursive: true });
    }

    // Load persistent config if available
    const polpoConfig = loadPolpoConfig(this.polpoDir);
    const settings = polpoConfig?.settings ?? { maxRetries: 2, workDir: ".", logLevel: "normal" as const };

    const stores = this.injectedStore
      ? { task: this.injectedStore, run: this.injectedRunStore! }
      : await this.createStores(settings.storage);
    this.registry = stores.task;
    this.runStore = stores.run;
    this.memoryStore = new FileMemoryStore(this.polpoDir);
    this.initLogStore();
    this.initSessionStore();

    this.config = {
      version: "1",
      project: polpoConfig?.project ?? project,
      team: polpoConfig?.team ?? team,
      tasks: [],
      settings,
      providers: polpoConfig?.providers,
    };

    // Apply provider overrides
    if (this.config.providers) {
      setProviderOverrides(this.config.providers);
    }

    this.initManagers();
    this.interactive = true;
    this.registry.setState({
      project,
      team,
      startedAt: new Date().toISOString(),
    });

    // Recover any tasks left in limbo from a previous crash
    const recovered = this.runner.recoverOrphanedTasks();
    if (recovered > 0) {
      this.emit("log", { level: "warn", message: `Recovered ${recovered} orphaned task(s) from previous session` });
    }
  }

  // ── Task Management (delegates to TaskManager) ──

  addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[]; group?: string; maxDuration?: number; retryPolicy?: RetryPolicy;
  }): Task { return this.taskMgr.addTask(opts); }
  updateTaskDescription(taskId: string, description: string): void { this.taskMgr.updateTaskDescription(taskId, description); }
  updateTaskAssignment(taskId: string, agentName: string): void { this.taskMgr.updateTaskAssignment(taskId, agentName); }
  updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): void { this.taskMgr.updateTaskExpectations(taskId, expectations); }
  retryTask(taskId: string): void { this.taskMgr.retryTask(taskId); }
  reassessTask(taskId: string): Promise<void> { return this.taskMgr.reassessTask(taskId); }
  killTask(taskId: string): boolean { return this.taskMgr.killTask(taskId); }
  deleteTask(taskId: string): boolean { return this.registry.removeTask(taskId); }
  abortGroup(group: string): number { return this.taskMgr.abortGroup(group); }
  clearTasks(filter: (task: Task) => boolean): number { return this.taskMgr.clearTasks(filter); }
  forceFailTask(taskId: string): void { this.taskMgr.forceFailTask(taskId); }

  // ── Approval Management ──

  approveRequest(requestId: string, resolvedBy?: string, note?: string): ApprovalRequest | null {
    return this.approvalMgr?.approve(requestId, resolvedBy, note) ?? null;
  }
  rejectRequest(requestId: string, feedback: string, resolvedBy?: string): ApprovalRequest | null {
    return this.approvalMgr?.reject(requestId, feedback, resolvedBy) ?? null;
  }
  canRejectRequest(requestId: string): { allowed: boolean; rejectionCount: number; maxRejections: number } {
    return this.approvalMgr?.canReject(requestId) ?? { allowed: false, rejectionCount: 0, maxRejections: 0 };
  }
  getPendingApprovals(): ApprovalRequest[] {
    return this.approvalMgr?.getPending() ?? [];
  }
  getAllApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    return this.approvalMgr?.getAll(status) ?? [];
  }
  getApprovalRequest(id: string): ApprovalRequest | undefined {
    return this.approvalMgr?.getRequest(id);
  }

  // ── Store Accessors ──

  getStore(): TaskStore { return this.registry; }
  getRunStore(): RunStore { return this.runStore; }
  getPolpoDir(): string { return this.polpoDir; }

  // ── Agent Management (delegates to AgentManager) ──

  getAgents(): AgentConfig[] { return this.agentMgr.getAgents(); }
  getTeam(): Team { return this.agentMgr.getTeam(); }
  getConfig(): PolpoConfig | null { return this.config; }
  renameTeam(newName: string): void { this.agentMgr.renameTeam(newName); }
  addAgent(agent: AgentConfig): void { this.agentMgr.addAgent(agent); }
  removeAgent(name: string): boolean { return this.agentMgr.removeAgent(name); }
  addVolatileAgent(agent: AgentConfig, group: string): void { this.agentMgr.addVolatileAgent(agent, group); }
  cleanupVolatileAgents(group: string): number { return this.agentMgr.cleanupVolatileAgents(group); }


  // ─── Plan Management (delegates to PlanExecutor) ──

  savePlan(opts: { data: string; prompt?: string; name?: string; status?: PlanStatus }): Plan { return this.planExec.savePlan(opts); }
  getPlan(planId: string): Plan | undefined { return this.planExec.getPlan(planId); }
  getPlanByName(name: string): Plan | undefined { return this.planExec.getPlanByName(name); }
  getAllPlans(): Plan[] { return this.planExec.getAllPlans(); }
  updatePlan(planId: string, updates: { data?: string; status?: PlanStatus; name?: string }): Plan { return this.planExec.updatePlan(planId, updates); }
  deletePlan(planId: string): boolean { return this.planExec.deletePlan(planId); }

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
    try { this.logStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  /** Get the chat session store. */
  getSessionStore(): SessionStore | undefined {
    return this.sessionStore;
  }

  /** Initialize the chat session store. */
  private initSessionStore(): void {
    this.sessionStore = new FileSessionStore(this.polpoDir);
    try { this.sessionStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  // ─── Plan Resume / Execute (delegates to PlanExecutor) ──

  getResumablePlans(): Plan[] { return this.planExec.getResumablePlans(); }
  resumePlan(planId: string, opts?: { retryFailed?: boolean }): { retried: number; pending: number } { return this.planExec.resumePlan(planId, opts); }
  executePlan(planId: string): { tasks: Task[]; group: string } { return this.planExec.executePlan(planId); }

  /** Stop the supervisor loop (non-graceful — use gracefulStop for clean shutdown) */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Graceful shutdown: SIGTERM all runner subprocesses, wait for them to write results,
   * preserve completed work, leave in-progress tasks for recovery on restart.
   */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    await this.hookRegistry.runBefore("orchestrator:shutdown", {});
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

    // Clear process list in state and close stores
    this.registry.setState({ processes: [], completedAt: new Date().toISOString() });
    this.telegramPoller?.stop();
    this.notificationServer?.close();
    this.approvalMgr?.dispose();
    this.notificationRouter?.dispose();
    this.escalationMgr?.dispose();
    this.slaMonitor?.dispose();
    this.qualityController?.dispose();
    this.scheduler?.dispose();
    this.registry.close?.();
    this.runStore.close();
    this.emit("orchestrator:shutdown", {});
    await this.hookRegistry.runAfter("orchestrator:shutdown", {});
    this.logStore?.close();
    this.sessionStore?.close();
  }

  /**
   * Recover orphaned tasks on startup.
   * Checks RunStore for active runs — if the runner PID is still alive,
   * let it keep running (zero work lost). If PID is dead, clean up the run.
   * Then requeue orphaned tasks to "pending" WITHOUT burning retry count
   * (shutdown interrupts are not real failures).
   */
  recoverOrphanedTasks(): number { return this.runner.recoverOrphanedTasks(); }

  /**
   * Start a Telegram callback poller if a telegram channel + approval gates are configured.
   * The poller listens for inline keyboard button presses and routes them
   * to the ApprovalManager for approve/reject/revise actions.
   */
  private startTelegramApprovalPoller(): void {
    if (!this.approvalMgr || !this.notificationRouter) return;

    // Find the Telegram channel instance from notification config
    const telegramConfigKey = Object.keys(this.config.settings.notifications?.channels ?? {})
      .find(k => this.config.settings.notifications?.channels[k]?.type === "telegram");
    if (!telegramConfigKey) return;

    const ch = this.notificationRouter!.getChannel(telegramConfigKey);
    if (!ch || ch.type !== "telegram") return;
    const telegramChannel = ch as import("../notifications/channels/telegram.js").TelegramChannel;

    const botToken = telegramChannel.getBotToken();
    const chatId = telegramChannel.getChatId();
    const approvalMgr = this.approvalMgr;

    const poller = new TelegramCallbackPoller(botToken, chatId);

    const resolver: ApprovalCallbackResolver = {
      approve: async (requestId, resolvedBy) => {
        const result = approvalMgr.approve(requestId, resolvedBy);
        return result ? { ok: true } : { ok: false, error: "Not found or already resolved" };
      },
      reject: async (requestId, feedback, resolvedBy) => {
        const result = approvalMgr.reject(requestId, feedback, resolvedBy);
        return result ? { ok: true } : { ok: false, error: "Not found, already resolved, or max rejections reached" };
      },
    };

    poller.setResolver(resolver);
    poller.start(2000); // Poll every 2 seconds
    this.telegramPoller = poller;

    this.emit("log", { level: "info", message: "Telegram approval callback poller started" });
  }

  private seedTasks(): void {
    this.taskMgr.seedTasks();
    // Also set initial state for non-interactive mode
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
    const awaitingApproval = tasks.filter(t => t.status === "awaiting_approval");
    const inProgress = tasks.filter(t => t.status === "in_progress" || t.status === "assigned" || t.status === "review");

    // Check if all tasks are terminal (done or failed)
    // awaiting_approval tasks are NOT terminal — they're waiting for human action
    const terminal = tasks.filter(t => t.status === "done" || t.status === "failed");
    if (terminal.length === tasks.length) {
      // Must run cleanup BEFORE returning — assessment transitions happen async
      // between ticks, so this may be the first tick that sees all tasks terminal.
      this.planExec.cleanupCompletedGroups(tasks);
      this.runner.syncProcessesFromRunStore();
      return true;
    }

    // 1. Collect results from finished runners
    this.runner.collectResults((id, res) => this.assessor.handleResult(id, res));

    // 2. Enforce health checks (timeouts + stale detection)
    this.runner.enforceHealthChecks();

    // 2b. SLA deadline checks
    this.slaMonitor?.check();

    // 2c. Scheduler checks (trigger due plans)
    this.scheduler?.check();

    // 3. Spawn agents for ready tasks (skip tasks from cancelled/completed plans)
    const ready = pending.filter(task => {
      if (task.group) {
        const plan = this.registry.getPlanByName?.(task.group);
        if (plan && (plan.status === "cancelled" || plan.status === "completed")) return false;

        // Check quality gates — task may be blocked by a gate even if deps are done
        if (this.qualityController) {
          const gates = this.planExec.getQualityGates(task.group);
          if (gates.length > 0) {
            const blocking = this.qualityController.getBlockingGate(
              plan?.id ?? task.group,
              task.title,
              task.id,
              gates,
              tasks,
            );
            if (blocking) return false; // Blocked by quality gate
          }
        }
      }
      return task.dependsOn.every(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status === "done";
      });
    });

    // Check for deadlock: no tasks ready, none running, but some pending
    // Don't consider it a deadlock if tasks are awaiting approval
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0 && awaitingApproval.length === 0) {
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

    // Concurrency-aware spawn loop
    const activeRuns = this.runStore.getActiveRuns();
    const globalMax = this.config.settings.maxConcurrency ?? Infinity;
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
      const existingRun = this.runStore.getRunByTaskId(task.id);
      if (existingRun && existingRun.status === "running") continue;

      // Per-agent concurrency limit
      const agentName = task.assignTo;
      const agentConfig = this.config.team.agents.find(a => a.name === agentName);
      if (agentConfig?.maxConcurrency) {
        if ((agentActiveCounts.get(agentName) ?? 0) >= agentConfig.maxConcurrency) {
          queued++;
          continue;
        }
      }

      this.runner.spawnForTask(task);
      totalActive++;
      agentActiveCounts.set(agentName, (agentActiveCounts.get(agentName) ?? 0) + 1);
    }

    // Emit tick stats
    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    this.emit("orchestrator:tick", {
      pending: pending.length,
      running: inProgress.length,
      done,
      failed,
      queued,
    });

    // Clean up volatile agents for completed plan groups.
    // Re-read tasks fresh — assessment callbacks (async) may have transitioned
    // tasks to done/failed since the snapshot at the top of tick().
    this.planExec.cleanupCompletedGroups(this.registry.getAllTasks());

    // Sync process list from RunStore for backward compat with TUI
    this.runner.syncProcessesFromRunStore();

    return false;
  }

  // Assessment pipeline delegated to AssessmentOrchestrator
  /** @internal — test access only */
  private retryOrFail(taskId: string, task: Task, result: TaskResult): void {
    this.assessor.retryOrFail(taskId, task, result);
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

