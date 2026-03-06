import { resolve } from "node:path";
import { mkdirSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
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
  Mission,
  MissionStatus,
  RetryPolicy,
  ScopedNotificationRules,
} from "./types.js";
import { AgentManager } from "./agent-manager.js";
import { TaskManager } from "./task-manager.js";
import { MissionExecutor } from "./mission-executor.js";
import { TaskRunner } from "./task-runner.js";
import { AssessmentOrchestrator } from "./assessment-orchestrator.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import {
  buildFixPrompt,
  buildRetryPrompt,
  sleep,
} from "./assessment-prompts.js";
import type { AssessFn } from "./orchestrator-context.js";
import { setProviderOverrides, validateProviderKeys, setModelAllowlist } from "../llm/pi-client.js";
import { startNotificationServer } from "./notification.js";
import { HookRegistry } from "./hooks.js";
import { ApprovalManager } from "./approval-manager.js";
import { FileApprovalStore } from "../stores/file-approval-store.js";
import { NotificationRouter } from "../notifications/index.js";
import { FileNotificationStore } from "../stores/file-notification-store.js";
import { TelegramCallbackPoller } from "../notifications/channels/telegram.js";
import type { ApprovalCallbackResolver } from "../notifications/channels/telegram.js";
import { ChannelGateway } from "../notifications/channel-gateway.js";
import { TelegramGatewayAdapter } from "../notifications/telegram-gateway-adapter.js";
import { WhatsAppBridge, WhatsAppChannel } from "../notifications/channels/whatsapp.js";
import { WhatsAppGatewayAdapter } from "../notifications/whatsapp-gateway-adapter.js";
import { WhatsAppStore } from "../stores/whatsapp-store.js";
import { FilePeerStore } from "./peer-store.js";
import type { PeerStore } from "./peer-store.js";
import { EscalationManager } from "./escalation-manager.js";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { QualityController } from "../quality/quality-controller.js";
import { Scheduler } from "../scheduling/scheduler.js";
import { TaskWatcherManager } from "./task-watcher.js";
import type { ApprovalRequest, ApprovalStatus, NotificationAction } from "./types.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";

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
  /** Cached resolved agent working directory (invalidated on config reload). */
  private cachedAgentWorkDir: string | null = null;
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
  private watcherMgr?: TaskWatcherManager;
  private telegramPoller?: TelegramCallbackPoller;
  private whatsappBridge?: WhatsAppBridge;
  private whatsappStore?: WhatsAppStore;
  private peerStore?: PeerStore;
  private channelGateway?: ChannelGateway;
  private configWatcher?: FSWatcher;
  private configReloadTimer?: ReturnType<typeof setTimeout>;
  private vaultStore?: EncryptedVaultStore;

  // Managers
  private agentMgr!: AgentManager;
  private taskMgr!: TaskManager;
  private missionExec!: MissionExecutor;
  private runner!: TaskRunner;
  private assessor!: AssessmentOrchestrator;

  getWorkDir(): string { return this.workDir; }
  getAgentWorkDir(): string {
    if (!this.cachedAgentWorkDir) {
      this.cachedAgentWorkDir = this.resolveAgentWorkDir();
    }
    return this.cachedAgentWorkDir;
  }
  getHooks(): HookRegistry { return this.hookRegistry; }
  getNotificationRouter(): NotificationRouter | undefined { return this.notificationRouter; }
  getPeerStore(): PeerStore | undefined { return this.peerStore; }
  getChannelGateway(): ChannelGateway | undefined { return this.channelGateway; }
  getSLAMonitor(): SLAMonitor | undefined { return this.slaMonitor; }
  getQualityController(): QualityController | undefined { return this.qualityController; }
  getScheduler(): Scheduler | undefined { return this.scheduler; }
  getWatcherManager(): TaskWatcherManager | undefined { return this.watcherMgr; }
  getWhatsAppStore(): WhatsAppStore | undefined { return this.whatsappStore; }
  getWhatsAppBridge(): WhatsAppBridge | undefined { return this.whatsappBridge; }

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

    // Apply model allowlist from settings
    if (this.config.settings.modelAllowlist) {
      setModelAllowlist(this.config.settings.modelAllowlist);
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
    this.initVaultStore();
  }

  private validateProviders(): void {
    const modelSpecs: string[] = [];
    // Default model
    if (process.env.POLPO_MODEL) modelSpecs.push(process.env.POLPO_MODEL);
    // Orchestrator model
    if (this.config.settings.orchestratorModel) {
      const om = this.config.settings.orchestratorModel;
      if (typeof om === "string") {
        modelSpecs.push(om);
      } else {
        if (om.primary) modelSpecs.push(om.primary);
        if (om.fallbacks) modelSpecs.push(...om.fallbacks);
      }
    }
    // Judge model
    if (process.env.POLPO_JUDGE_MODEL) modelSpecs.push(process.env.POLPO_JUDGE_MODEL);
    // Per-agent models
    for (const team of this.config.teams) {
      for (const agent of team.agents) {
        if (agent.model) modelSpecs.push(agent.model);
      }
    }

    if (modelSpecs.length === 0) {
      this.emit("log", {
        level: "warn",
        message: "No model configured for any agent. Agent spawning will fail. Run 'polpo setup' or set POLPO_MODEL env var.",
      });
      return;
    }

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

  /** Resolve the directory where agent processes will run (settings.workDir relative to project root). */
  private resolveAgentWorkDir(): string {
    const settingsWorkDir = this.config.settings.workDir;
    if (!settingsWorkDir || settingsWorkDir === ".") return this.workDir;
    const resolved = resolve(this.workDir, settingsWorkDir);
    if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
    return resolved;
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
      agentWorkDir: this.resolveAgentWorkDir(),
      polpoDir: this.polpoDir,
      assessFn: this.assessFn,
    };
    this.agentMgr = new AgentManager(ctx);
    this.taskMgr = new TaskManager(ctx);
    this.missionExec = new MissionExecutor(ctx, this.taskMgr, this.agentMgr);
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
      this.notificationRouter.init(this.config.settings.notifications, this.polpoDir);
      // Attach persistent notification store
      const notifStore = new FileNotificationStore(this.polpoDir);
      this.notificationRouter.setStore(notifStore);
      this.notificationRouter.start();

      // Set scope resolver so the router can resolve task/mission-level notification rules
      this.notificationRouter.setScopeResolver((data: unknown) => {
        if (!data || typeof data !== "object") return undefined;
        const d = data as Record<string, unknown>;

        // Extract taskId from common event payload shapes
        const taskId = (d.taskId as string | undefined)
          ?? ((d.task as Record<string, unknown> | undefined)?.id as string | undefined);

        // Extract missionId / group
        const group = (d.group as string | undefined)
          ?? (taskId ? this.registry.getTask(taskId)?.group : undefined);

        const taskNotifications = taskId
          ? this.registry.getTask(taskId)?.notifications
          : undefined;

        let missionNotifications: import("./types.js").ScopedNotificationRules | undefined;
        // Resolve mission via task.missionId (direct FK) or event.missionId, fallback to group name
        const taskObj = taskId ? this.registry.getTask(taskId) : undefined;
        const resolvedMissionId = taskObj?.missionId ?? (d.missionId as string | undefined);
        if (resolvedMissionId) {
          const mission = this.registry.getMission?.(resolvedMissionId);
          missionNotifications = mission?.notifications;
        } else if (group) {
          const mission = this.registry.getMissionByName?.(group);
          missionNotifications = mission?.notifications;
        }

        return { taskNotifications, missionNotifications };
      });
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
    } else if (this.notificationRouter && this.hasTelegramGatewayEnabled()) {
      // Start Telegram poller even without approval gates when gateway inbound is enabled
      this.startTelegramApprovalPoller();
    }

    // Start WhatsApp bridge if configured
    if (this.notificationRouter && this.hasWhatsAppConfigured()) {
      this.startWhatsAppBridge();
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
    // Wire notification router so per-gate and per-checkpoint notifyChannels work
    if (this.notificationRouter) {
      this.qualityController.setNotificationRouter(this.notificationRouter);
      this.missionExec.setNotificationRouter(this.notificationRouter);
    }
    this.qualityController.init();
    this.missionExec.setQualityController(this.qualityController);

    // Initialize scheduler (always available — zero cost when no schedules exist)
    if (this.config.settings.enableScheduler !== false) {
      this.scheduler = new Scheduler(ctx);
      this.scheduler.setExecutor((missionId) => this.missionExec.executeMission(missionId));
      this.scheduler.init();
    }

    // Build the shared action executor (used by notification rules and task watchers)
    const actionExecutor = this.buildActionExecutor(ctx);

    // Wire action executor to notification router
    if (this.notificationRouter) {
      this.notificationRouter.setActionExecutor(actionExecutor);
    }

    // Initialize task watcher manager (always available — zero cost when no watchers)
    this.watcherMgr = new TaskWatcherManager(this);
    this.watcherMgr.setActionExecutor(actionExecutor);
    this.watcherMgr.start();
  }

  /**
   * Build the action executor callback — handles create_task, execute_mission,
   * run_script, send_notification actions triggered by notification rules
   * or task watchers.
   */
  private buildActionExecutor(ctx: OrchestratorContext): (action: NotificationAction) => Promise<string> {
    return async (action: NotificationAction): Promise<string> => {
      switch (action.type) {
        case "create_task": {
          const task = this.addTask({
            title: action.title,
            description: action.description,
            assignTo: action.assignTo,
            expectations: action.expectations,
          });
          return `Task created: [${task.id}] "${task.title}" → ${task.assignTo}`;
        }
        case "execute_mission": {
          const mission = this.registry.getMission?.(action.missionId);
          if (!mission) throw new Error(`Mission "${action.missionId}" not found`);
          const result = this.missionExec.executeMission(action.missionId);
          return `Mission "${mission.name}" executed: ${result.tasks.length} tasks created`;
        }
        case "run_script": {
          const { execSync } = await import("node:child_process");
          const timeout = action.timeoutMs ?? 30_000;
          const result = execSync(action.command, {
            cwd: ctx.agentWorkDir,
            timeout,
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 5 * 1024 * 1024,
          });
          return `Script completed: ${result.toString().trim().slice(0, 200)}`;
        }
        case "send_notification": {
          if (!this.notificationRouter) throw new Error("Notification router not available");
          const result = await this.notificationRouter.sendDirect({
            channel: action.channel,
            title: action.title,
            body: action.body,
            severity: action.severity,
          });
          return `Notification sent: ${result.id}`;
        }
        default:
          throw new Error(`Unknown action type: ${(action as { type: string }).type}`);
      }
    };
  }

  /**
   * Initialize for interactive/TUI mode.
   * Creates .polpo dir and a minimal config from provided team info.
   */
  async initInteractive(project: string, teams: Team | Team[]): Promise<void> {
    const teamsArray = Array.isArray(teams) ? teams : [teams];
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
      teams: polpoConfig?.teams ?? teamsArray,
      tasks: [],
      settings,
      providers: polpoConfig?.providers,
    };

    // Apply provider overrides and allowlist
    if (this.config.providers) {
      setProviderOverrides(this.config.providers);
    }
    if (this.config.settings.modelAllowlist) {
      setModelAllowlist(this.config.settings.modelAllowlist);
    }

    this.initManagers();
    this.initVaultStore();
    this.interactive = true;
    this.registry.setState({
      project,
      teams: teamsArray,
      startedAt: new Date().toISOString(),
    });

    // Recover any tasks left in limbo from a previous crash
    const recovered = this.runner.recoverOrphanedTasks();
    if (recovered > 0) {
      this.emit("log", { level: "warn", message: `Recovered ${recovered} orphaned task(s) from previous session` });
    }

    // Watch polpo.json for changes and auto-reload
    this.startConfigWatcher();
  }

  /**
   * Watch `.polpo/polpo.json` for changes and auto-reload the config.
   * Uses a 500ms debounce to avoid reloading multiple times on rapid saves.
   */
  private startConfigWatcher(): void {
    const configPath = join(this.polpoDir, "polpo.json");
    if (!existsSync(configPath)) return;

    try {
      this.configWatcher = watch(configPath, () => {
        // Debounce: wait 500ms after the last change event
        if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
        this.configReloadTimer = setTimeout(() => {
          this.emit("log", { level: "info", message: "[watch] polpo.json changed on disk — auto-reloading config" });
          this.reloadConfig();
        }, 500);
      });

      this.emit("log", { level: "info", message: "[watch] Watching polpo.json for changes" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `[watch] Failed to watch polpo.json: ${msg}` });
    }
  }

  // ── Task Management (delegates to TaskManager) ──

  addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[]; group?: string; maxDuration?: number; retryPolicy?: RetryPolicy;
    notifications?: ScopedNotificationRules; draft?: boolean;
  }): Task { return this.taskMgr.addTask(opts); }
  updateTaskDescription(taskId: string, description: string): void { this.taskMgr.updateTaskDescription(taskId, description); }
  updateTaskAssignment(taskId: string, agentName: string): void { this.taskMgr.updateTaskAssignment(taskId, agentName); }
  updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): void { this.taskMgr.updateTaskExpectations(taskId, expectations); }
  retryTask(taskId: string): void { this.taskMgr.retryTask(taskId); }
  reassessTask(taskId: string): Promise<void> { return this.taskMgr.reassessTask(taskId); }
  killTask(taskId: string): boolean { return this.taskMgr.killTask(taskId); }
  deleteTask(taskId: string): boolean { return this.registry.removeTask(taskId); }
  abortGroup(group: string): number {
    const count = this.taskMgr.abortGroup(group);
    // Clean up any schedule tied to this mission group — resolve via task.missionId first
    const groupTasks = this.registry.getAllTasks().filter(t => t.group === group);
    const mid = groupTasks.find(t => t.missionId)?.missionId;
    const mission = mid ? this.registry.getMission?.(mid) : this.registry.getMissionByName?.(group);
    if (mission) this.scheduler?.unregisterMission(mission.id);
    return count;
  }
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
  getVaultStore(): EncryptedVaultStore | undefined { return this.vaultStore; }

  /**
   * Initialize the encrypted vault store.
   * Credentials are stored in .polpo/vault.enc (AES-256-GCM encrypted).
   * Key: POLPO_VAULT_KEY env var or auto-generated ~/.polpo/vault.key.
   */
  private initVaultStore(): void {
    try {
      this.vaultStore = new EncryptedVaultStore(this.polpoDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `Vault store init failed: ${msg}. Vault features disabled.` });
    }
  }

  // ── Agent Management (delegates to AgentManager) ──

  getAgents(): AgentConfig[] { return this.agentMgr.getAgents(); }
  getTeams(): Team[] { return this.agentMgr.getTeams(); }
  getTeam(name?: string): Team | undefined { return this.agentMgr.getTeam(name); }
  getConfig(): PolpoConfig | null { return this.config; }
  addTeam(team: Team): void { this.agentMgr.addTeam(team); }
  removeTeam(name: string): boolean { return this.agentMgr.removeTeam(name); }
  renameTeam(oldName: string, newName: string): void { this.agentMgr.renameTeam(oldName, newName); }
  addAgent(agent: AgentConfig, teamName?: string): void { this.agentMgr.addAgent(agent, teamName); }
  removeAgent(name: string): boolean { return this.agentMgr.removeAgent(name); }
  findAgentTeam(name: string): Team | undefined { return this.agentMgr.findAgentTeam(name); }
  addVolatileAgent(agent: AgentConfig, group: string): void { this.agentMgr.addVolatileAgent(agent, group); }
  cleanupVolatileAgents(group: string): number { return this.agentMgr.cleanupVolatileAgents(group); }


  // ─── Mission Management (delegates to MissionExecutor) ──

  saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules }): Mission { return this.missionExec.saveMission(opts); }
  getMission(missionId: string): Mission | undefined { return this.missionExec.getMission(missionId); }
  getMissionByName(name: string): Mission | undefined { return this.missionExec.getMissionByName(name); }
  getAllMissions(): Mission[] { return this.missionExec.getAllMissions(); }
  updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Mission { return this.missionExec.updateMission(missionId, updates); }
  deleteMission(missionId: string): boolean {
    const result = this.missionExec.deleteMission(missionId);
    if (result) this.scheduler?.unregisterMission(missionId);
    return result;
  }

  // ─── Atomic Mission Data Operations (delegates to MissionExecutor) ──

  addMissionTask(missionId: string, task: { title: string; description: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Mission {
    return this.missionExec.addMissionTask(missionId, task);
  }
  updateMissionTask(missionId: string, taskTitle: string, updates: { title?: string; description?: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Mission {
    return this.missionExec.updateMissionTask(missionId, taskTitle, updates);
  }
  removeMissionTask(missionId: string, taskTitle: string): Mission {
    return this.missionExec.removeMissionTask(missionId, taskTitle);
  }
  reorderMissionTasks(missionId: string, titles: string[]): Mission {
    return this.missionExec.reorderMissionTasks(missionId, titles);
  }
  addMissionCheckpoint(missionId: string, cp: { name: string; afterTasks: string[]; blocksTasks: string[]; notifyChannels?: string[]; message?: string }): Mission {
    return this.missionExec.addMissionCheckpoint(missionId, cp);
  }
  updateMissionCheckpoint(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; notifyChannels?: string[]; message?: string }): Mission {
    return this.missionExec.updateMissionCheckpoint(missionId, name, updates);
  }
  removeMissionCheckpoint(missionId: string, name: string): Mission {
    return this.missionExec.removeMissionCheckpoint(missionId, name);
  }
  addMissionQualityGate(missionId: string, gate: { name: string; afterTasks: string[]; blocksTasks: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Mission {
    return this.missionExec.addMissionQualityGate(missionId, gate);
  }
  updateMissionQualityGate(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Mission {
    return this.missionExec.updateMissionQualityGate(missionId, name, updates);
  }
  removeMissionQualityGate(missionId: string, name: string): Mission {
    return this.missionExec.removeMissionQualityGate(missionId, name);
  }
  addMissionDelay(missionId: string, delay: { name: string; afterTasks: string[]; blocksTasks: string[]; duration: string; notifyChannels?: string[]; message?: string }): Mission {
    return this.missionExec.addMissionDelay(missionId, delay);
  }
  updateMissionDelay(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; duration?: string; notifyChannels?: string[]; message?: string }): Mission {
    return this.missionExec.updateMissionDelay(missionId, name, updates);
  }
  removeMissionDelay(missionId: string, name: string): Mission {
    return this.missionExec.removeMissionDelay(missionId, name);
  }
  addMissionTeamMember(missionId: string, member: { name: string; role?: string; model?: string; [key: string]: unknown }): Mission {
    return this.missionExec.addMissionTeamMember(missionId, member);
  }
  updateMissionTeamMember(missionId: string, memberName: string, updates: { name?: string; role?: string; model?: string; [key: string]: unknown }): Mission {
    return this.missionExec.updateMissionTeamMember(missionId, memberName, updates);
  }
  removeMissionTeamMember(missionId: string, memberName: string): Mission {
    return this.missionExec.removeMissionTeamMember(missionId, memberName);
  }
  updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Mission {
    return this.missionExec.updateMissionNotifications(missionId, notifications);
  }

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

  /** Replace a unique substring in the project memory. */
  updateMemory(oldText: string, newText: string): true | string {
    if (!this.memoryStore) return "No memory store configured.";
    return this.memoryStore.update(oldText, newText);
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

  // ─── Mission Resume / Execute (delegates to MissionExecutor) ──

  getResumableMissions(): Mission[] { return this.missionExec.getResumableMissions(); }
  resumeMission(missionId: string, opts?: { retryFailed?: boolean }): { retried: number; pending: number } { return this.missionExec.resumeMission(missionId, opts); }
  executeMission(missionId: string): { tasks: Task[]; group: string } { return this.missionExec.executeMission(missionId); }

  // ─── Checkpoints ────────────────────────────────────

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints() { return this.missionExec.getActiveCheckpoints(); }

  /** Resume a checkpoint by mission group name and checkpoint name. Returns true if resumed. */
  resumeCheckpoint(group: string, checkpointName: string): boolean {
    return this.missionExec.resumeCheckpoint(group, checkpointName);
  }

  /** Resume a checkpoint by mission ID and checkpoint name. Returns true if resumed. */
  resumeCheckpointByMissionId(missionId: string, checkpointName: string): boolean {
    const mission = this.missionExec.getMission(missionId);
    if (!mission) return false;
    return this.missionExec.resumeCheckpoint(mission.name, checkpointName);
  }

  // ─── Delays ──────────────────────────────────────────

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays() { return this.missionExec.getActiveDelays(); }

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
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    this.configWatcher?.close();
    this.telegramPoller?.stop();
    this.whatsappBridge?.stop();
    this.whatsappStore?.close();
    this.whatsappStore = undefined;
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

  // ── Config Hot Reload ──

  /**
   * Reload polpo.json at runtime without restarting the server.
   * Disposes optional subsystems (notifications, approvals, escalation, SLA,
   * quality, scheduler, telegram poller) and re-initializes them from the
   * freshly-read config.  Core managers (agents, tasks, missions, runner,
   * assessor) and stores are left untouched — live state is preserved.
   *
   * Returns `true` if the config was successfully reloaded.
   */
  reloadConfig(): boolean {
    const polpoConfig = loadPolpoConfig(this.polpoDir);
    if (!polpoConfig) {
      this.emit("log", { level: "warn", message: "[reload] polpo.json not found or unparseable — skipping reload" });
      return false;
    }

    this.emit("log", { level: "info", message: "[reload] Reloading configuration..." });

    // 1. Dispose optional subsystems (scheduler is handled separately to preserve state)
    this.telegramPoller?.stop();
    this.telegramPoller = undefined;
    this.whatsappBridge?.stop();
    this.whatsappBridge = undefined;
    this.whatsappStore?.close();
    this.whatsappStore = undefined;
    this.qualityController?.dispose();
    this.qualityController = undefined;
    this.slaMonitor?.dispose();
    this.slaMonitor = undefined;
    this.escalationMgr?.dispose();
    this.escalationMgr = undefined;
    this.notificationRouter?.dispose();
    this.notificationRouter = undefined;
    this.approvalMgr?.dispose();
    this.approvalMgr = undefined;

    // 2. Update config in-place (preserves the shared reference in OrchestratorContext)
    const newSettings = polpoConfig.settings ?? this.config.settings;
    this.config.settings = newSettings;
    if (polpoConfig.teams) this.config.teams = polpoConfig.teams;
    if (polpoConfig.providers) {
      this.config.providers = polpoConfig.providers;
      setProviderOverrides(polpoConfig.providers);
    }
    if (newSettings.modelAllowlist) {
      setModelAllowlist(newSettings.modelAllowlist);
    }

    // 3. Invalidate cached agent work dir and rebuild OrchestratorContext
    this.cachedAgentWorkDir = null;
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
      agentWorkDir: this.getAgentWorkDir(),
      polpoDir: this.polpoDir,
      assessFn: this.assessFn,
    };

    // 4. Re-initialize optional subsystems from new config

    // Approval gates
    if (this.config.settings.approvalGates && this.config.settings.approvalGates.length > 0) {
      const approvalStore = new FileApprovalStore(this.polpoDir);
      this.approvalMgr = new ApprovalManager(ctx, approvalStore);
      this.approvalMgr.init();
    }

    // Notification router
    if (this.config.settings.notifications) {
      this.notificationRouter = new NotificationRouter(this);
      this.notificationRouter.init(this.config.settings.notifications, this.polpoDir);
      const notifStore = new FileNotificationStore(this.polpoDir);
      this.notificationRouter.setStore(notifStore);
      this.notificationRouter.start();

      // Restore scope resolver
      this.notificationRouter.setScopeResolver((data: unknown) => {
        if (!data || typeof data !== "object") return undefined;
        const d = data as Record<string, unknown>;
        const taskId = (d.taskId as string | undefined)
          ?? ((d.task as Record<string, unknown> | undefined)?.id as string | undefined);
        const group = (d.group as string | undefined)
          ?? (taskId ? this.registry.getTask(taskId)?.group : undefined);
        const taskNotifications = taskId
          ? this.registry.getTask(taskId)?.notifications
          : undefined;
        let missionNotifications: ScopedNotificationRules | undefined;
        // Resolve mission via task.missionId (direct FK) or event.missionId, fallback to group name
        const taskObj = taskId ? this.registry.getTask(taskId) : undefined;
        const resolvedMissionId = taskObj?.missionId ?? (d.missionId as string | undefined);
        if (resolvedMissionId) {
          const mission = this.registry.getMission?.(resolvedMissionId);
          missionNotifications = mission?.notifications;
        } else if (group) {
          const mission = this.registry.getMissionByName?.(group);
          missionNotifications = mission?.notifications;
        }
        return { taskNotifications, missionNotifications };
      });
    }

    // Wire notification router to approval manager
    if (this.approvalMgr && this.notificationRouter) {
      this.approvalMgr.setNotificationRouter(this.notificationRouter);
      this.notificationRouter.setOutcomeResolver((taskId: string) => {
        const task = this.registry.getTask(taskId);
        return task?.outcomes;
      });
      this.startTelegramApprovalPoller();
    }

    // Restart WhatsApp bridge if configured (independent of approval gates)
    if (this.notificationRouter && this.hasWhatsAppConfigured()) {
      this.startWhatsAppBridge();
    }

    // Escalation manager
    if (this.config.settings.escalationPolicy) {
      this.escalationMgr = new EscalationManager(ctx, this.approvalMgr);
      this.escalationMgr.init();
    }

    // SLA monitor
    if (this.config.settings.sla) {
      this.slaMonitor = new SLAMonitor(ctx, this.config.settings.sla);
      if (this.notificationRouter) {
        this.slaMonitor.setNotificationRouter(this.notificationRouter);
      }
      this.slaMonitor.init();
    }

    // Quality controller (always available)
    this.qualityController = new QualityController(ctx);
    if (this.notificationRouter) {
      this.qualityController.setNotificationRouter(this.notificationRouter);
      this.missionExec.setNotificationRouter(this.notificationRouter);
    }
    this.qualityController.init();
    this.missionExec.setQualityController(this.qualityController);

    // Scheduler — re-init without losing existing schedule state.
    // If scheduler was already running, just refresh its mission registrations.
    // If not, create a new one.
    if (this.config.settings.enableScheduler !== false) {
      if (!this.scheduler) {
        this.scheduler = new Scheduler(ctx);
        this.scheduler.setExecutor((missionId) => this.missionExec.executeMission(missionId));
      }
      this.scheduler.init();
    } else {
      this.scheduler?.dispose();
      this.scheduler = undefined;
    }

    this.emit("log", { level: "info", message: "[reload] Configuration reloaded successfully" });
    this.emit("config:reloaded", { timestamp: new Date().toISOString() });
    return true;
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
  /** Check if any Telegram channel has gateway.enableInbound set to true. */
  private hasTelegramGatewayEnabled(): boolean {
    const channels = this.config.settings.notifications?.channels;
    if (!channels) return false;
    return Object.values(channels).some(
      ch => ch.type === "telegram" && ch.gateway?.enableInbound,
    );
  }

  private startTelegramApprovalPoller(): void {
    if (!this.notificationRouter) return;

    // Stop any existing poller to prevent duplicate polling
    if (this.telegramPoller) {
      this.telegramPoller.stop();
      this.telegramPoller = undefined;
    }

    // Find the Telegram channel instance from notification config
    const telegramConfigKey = Object.keys(this.config.settings.notifications?.channels ?? {})
      .find(k => this.config.settings.notifications?.channels[k]?.type === "telegram");
    if (!telegramConfigKey) return;

    const ch = this.notificationRouter!.getChannel(telegramConfigKey);
    if (!ch || ch.type !== "telegram") return;
    const telegramChannel = ch as import("../notifications/channels/telegram.js").TelegramChannel;

    const botToken = telegramChannel.getBotToken();
    const chatId = telegramChannel.getChatId();

    const poller = new TelegramCallbackPoller(botToken, chatId);

    // Build approval resolver (if approval manager is available)
    const approvalMgr = this.approvalMgr;
    let resolver: ApprovalCallbackResolver | undefined;
    if (approvalMgr) {
      resolver = {
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
    }

    // Check if inbound gateway is enabled for this Telegram channel
    const channelConfig = this.config.settings.notifications?.channels[telegramConfigKey];
    if (channelConfig?.gateway?.enableInbound) {
      // Initialize peer store
      this.peerStore = new FilePeerStore(this.polpoDir);

      // Create ChannelGateway with typing indicator support
      this.channelGateway = new ChannelGateway({
        orchestrator: this,
        peerStore: this.peerStore,
        sessionStore: this.sessionStore,
        channelConfig,
        approvalResolver: resolver,
        onTyping: (chatId) => poller.sendTyping(chatId),
      });

      // Send partial responses as separate Telegram messages during multi-turn tool loops
      this.channelGateway.setPartialResponseHandler((chatId, text) => poller.sendPartial(chatId, text));

      // Attach gateway adapter to poller
      const adapter = new TelegramGatewayAdapter(this.channelGateway);
      poller.setGateway(adapter);

      this.emit("log", {
        level: "info",
        message: `Telegram channel gateway started (dmPolicy: ${channelConfig.gateway.dmPolicy ?? "allowlist"}, inbound: enabled)`,
      });
    }

    poller.start(2000); // Poll every 2 seconds
    this.telegramPoller = poller;

    this.emit("log", { level: "info", message: "Telegram callback poller started" });
  }

  // ── WhatsApp Bridge ──

  /** Check if any WhatsApp channel is configured. */
  private hasWhatsAppConfigured(): boolean {
    const channels = this.config.settings.notifications?.channels;
    if (!channels) return false;
    return Object.values(channels).some(ch => ch.type === "whatsapp");
  }

  /** Start the WhatsApp bridge (Baileys connection + inbound message routing). */
  private startWhatsAppBridge(): void {
    if (!this.notificationRouter) return;

    // Stop existing bridge
    if (this.whatsappBridge) {
      this.whatsappBridge.stop();
      this.whatsappBridge = undefined;
    }

    // Find the WhatsApp channel instance
    const waConfigKey = Object.keys(this.config.settings.notifications?.channels ?? {})
      .find(k => this.config.settings.notifications?.channels[k]?.type === "whatsapp");
    if (!waConfigKey) return;

    const ch = this.notificationRouter.getChannel(waConfigKey);
    if (!ch || ch.type !== "whatsapp") return;
    const waChannel = ch as WhatsAppChannel;

    // Create or reuse WhatsApp message store (SQLite)
    if (!this.whatsappStore) {
      const dbPath = join(this.polpoDir, "whatsapp.db");
      this.whatsappStore = new WhatsAppStore(dbPath);
      this.emit("log", { level: "info", message: `WhatsApp store opened: ${dbPath}` });
    }

    // Create the bridge
    const bridge = new WhatsAppBridge(waChannel, (level, msg) => {
      this.emit("log", { level: level as "info" | "warn" | "verbose", message: msg });
    });

    // Attach store to bridge (buffers all messages for tool access)
    bridge.setStore(this.whatsappStore);

    // Build approval resolver (same as Telegram)
    const approvalMgr = this.approvalMgr;
    let resolver: ApprovalCallbackResolver | undefined;
    if (approvalMgr) {
      resolver = {
        approve: async (requestId, resolvedBy) => {
          const result = approvalMgr.approve(requestId, resolvedBy);
          return result ? { ok: true } : { ok: false, error: "Not found or already resolved" };
        },
        reject: async (requestId, feedback, resolvedBy) => {
          const result = approvalMgr.reject(requestId, feedback, resolvedBy);
          return result ? { ok: true } : { ok: false, error: "Not found, already resolved, or max rejections reached" };
        },
      };
    }

    // Set up gateway if inbound is enabled
    const channelConfig = this.config.settings.notifications?.channels[waConfigKey];
    if (channelConfig?.gateway?.enableInbound) {
      // Initialize peer store (shared with Telegram if already created)
      if (!this.peerStore) {
        this.peerStore = new FilePeerStore(this.polpoDir);
      }

      // Create or reuse ChannelGateway
      if (!this.channelGateway) {
        this.channelGateway = new ChannelGateway({
          orchestrator: this,
          peerStore: this.peerStore,
          sessionStore: this.sessionStore,
          channelConfig,
          approvalResolver: resolver,
          onTyping: (chatId) => waChannel.sendTyping(chatId),
        });
      }

      // Send partial responses as separate messages during multi-turn tool loops
      this.channelGateway.setPartialResponseHandler((chatId, text) =>
        waChannel.sendText(chatId, text),
      );

      // Attach gateway adapter to bridge
      const adapter = new WhatsAppGatewayAdapter(this.channelGateway);
      bridge.setGateway(adapter);

      this.emit("log", {
        level: "info",
        message: `WhatsApp channel gateway configured (dmPolicy: ${channelConfig.gateway.dmPolicy ?? "allowlist"}, inbound: enabled)`,
      });
    }

    // Start the bridge (async — connection happens in background)
    bridge.start().catch(err => {
      this.emit("log", {
        level: "warn",
        message: `WhatsApp bridge start failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });

    this.whatsappBridge = bridge;
    this.emit("log", { level: "info", message: "WhatsApp bridge starting..." });
  }

  private seedTasks(): void {
    this.taskMgr.seedTasks();
    // Also set initial state for non-interactive mode
    this.registry.setState({
      project: this.config.project,
      teams: this.config.teams,
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
      agents: this.agentMgr.getAgents().map((a: AgentConfig) => a.name),
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
    // Scheduler checks FIRST — must run before early-return guards because
    // scheduled/recurring missions have zero tasks until triggered, and the
    // scheduler is what creates them via executeMission.
    this.scheduler?.check();

    const tasks = this.registry.getAllTasks();
    if (tasks.length === 0) return !this.interactive;

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
      this.missionExec.cleanupCompletedGroups(tasks);
      this.runner.syncProcessesFromRunStore();
      return true;
    }

    // 1. Collect results from finished runners
    this.runner.collectResults((id, res) => this.assessor.handleResult(id, res));

    // 2. Enforce health checks (timeouts + stale detection)
    this.runner.enforceHealthChecks();

    // 2b. SLA deadline checks
    this.slaMonitor?.check();

    // 3. Spawn agents for ready tasks (skip tasks from cancelled/completed/paused missions)
    const ready = pending.filter(task => {
      if (task.group) {
        // Resolve mission via direct ID (preferred) or group name (legacy fallback)
        const mission = task.missionId
          ? this.registry.getMission?.(task.missionId)
          : this.registry.getMissionByName?.(task.group);
        if (mission && (mission.status === "cancelled" || mission.status === "completed" || mission.status === "paused")) return false;

        // Check quality gates — task may be blocked by a gate even if deps are done
        if (this.qualityController) {
          const gates = this.missionExec.getQualityGates(task.group);
          if (gates.length > 0) {
            const blocking = this.qualityController.getBlockingGate(
              mission?.id ?? task.group,
              task.title,
              task.id,
              gates,
              tasks,
            );
            if (blocking) return false; // Blocked by quality gate
          }
        }

        // Check checkpoints — task may be blocked by a checkpoint awaiting human resume
        const checkpoints = this.missionExec.getCheckpoints(task.group);
        if (checkpoints.length > 0) {
          const blockingCp = this.missionExec.getBlockingCheckpoint(
            task.group,
            task.title,
            task.id,
            tasks,
          );
          if (blockingCp) return false; // Blocked by checkpoint
        }

        // Check delays — task may be blocked by a timed delay
        const delays = this.missionExec.getDelays(task.group);
        if (delays.length > 0) {
          const blockingDelay = this.missionExec.getBlockingDelay(
            task.group,
            task.title,
            task.id,
            tasks,
          );
          if (blockingDelay) return false; // Blocked by delay
        }
      }
      return task.dependsOn.every(depId => {
        const dep = tasks.find(t => t.id === depId);
        return dep && dep.status === "done";
      });
    });

    // Check for deadlock: no tasks ready, none running, but some pending
    // Don't consider it a deadlock if tasks are awaiting approval, blocked by checkpoints, or waiting on delays
    const hasActiveCheckpoints = this.missionExec.getActiveCheckpoints().length > 0;
    const hasActiveDelays = this.missionExec.getActiveDelays().length > 0;
    if (ready.length === 0 && inProgress.length === 0 && pending.length > 0 && awaitingApproval.length === 0 && !hasActiveCheckpoints && !hasActiveDelays) {
      // Async resolution already in progress — wait for next tick
      if (isResolving()) return false;

      const analysis = analyzeBlockedTasks(pending, tasks);

      if (analysis.resolvable.length > 0) {
        this.emit("deadlock:detected", {
          taskIds: pending.map(t => t.id),
          resolvableCount: analysis.resolvable.length,
        });

        // Async LLM resolution (same pattern as question detection)
        resolveDeadlock(analysis, this).catch(err => {
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
      const agentConfig = this.agentMgr.findAgent(agentName);
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

    // Clean up volatile agents for completed mission groups.
    // Re-read tasks fresh — assessment callbacks (async) may have transitioned
    // tasks to done/failed since the snapshot at the top of tick().
    this.missionExec.cleanupCompletedGroups(this.registry.getAllTasks());

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

