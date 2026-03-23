import { resolve, join } from "node:path";
import { mkdirSync, existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { getPolpoDir } from "./constants.js";
import type { Server } from "node:net";
import { parseConfig, loadPolpoConfig, savePolpoConfig, loadEnvFile } from "./config.js";
import { findLogForTask, buildExecutionSummary } from "../assessment/transcript-parser.js";
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
import { OrchestratorEngine } from "@polpo-ai/core";
import type { DeadlockResolverPort, DeadlockFacade } from "@polpo-ai/core";
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
import { startNotificationServer, getSocketPath } from "./notification.js";
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
import { FileTeamStore } from "../stores/file-team-store.js";
import { FileAgentStore } from "../stores/file-agent-store.js";
import type { TeamStore } from "./team-store.js";
import type { AgentStore } from "./agent-store.js";
import { EscalationManager } from "./escalation-manager.js";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { QualityController } from "../quality/quality-controller.js";
import { Scheduler } from "../scheduling/scheduler.js";
import { TaskWatcherManager } from "./task-watcher.js";
import type { ApprovalRequest, ApprovalStatus, NotificationAction } from "./types.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultStore } from "./vault-store.js";
import type { PlaybookStore } from "./playbook-store.js";
import { FilePlaybookStore } from "../stores/file-playbook-store.js";
import { NodeSpawner } from "../adapters/node-spawner.js";
import type { Spawner } from "./spawner.js";

// Re-export for backward compatibility (consumed by core/index.ts and external modules)
export { buildFixPrompt, buildRetryPrompt };
export type { AssessFn };

export interface OrchestratorOptions {
  workDir?: string;
  store?: TaskStore;
  runStore?: RunStore;
  assessFn?: AssessFn;
  spawner?: Spawner;
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
  private spawner: Spawner;
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
  private teamStore!: TeamStore;
  private agentStore!: AgentStore;
  private channelGateway?: ChannelGateway;
  private configWatcher?: FSWatcher;
  private configReloadTimer?: ReturnType<typeof setTimeout>;
  private vaultStore?: VaultStore;
  private playbookStore!: PlaybookStore;

  // Managers
  private agentMgr!: AgentManager;
  private taskMgr!: TaskManager;
  private missionExec!: MissionExecutor;
  private runner!: TaskRunner;
  private assessor!: AssessmentOrchestrator;

  // Pure orchestration engine (delegates tick, run, and all pure-logic methods)
  private engine!: OrchestratorEngine;

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

  /** Re-point the orchestrator at a different project directory (before init). */
  resetWorkDir(newWorkDir: string): void {
    this.workDir = resolve(newWorkDir);
    this.polpoDir = getPolpoDir(this.workDir);
    this.cachedAgentWorkDir = null;
  }

  constructor(workDirOrOptions?: string | OrchestratorOptions) {
    super();
    if (typeof workDirOrOptions === "string" || workDirOrOptions === undefined) {
      const workDir = workDirOrOptions ?? ".";
      this.workDir = resolve(workDir);
      this.polpoDir = getPolpoDir(this.workDir);
      this.assessFn = assessTask;
      this.spawner = new NodeSpawner({ polpoDir: this.polpoDir, cwd: this.workDir });
    } else {
      const opts = workDirOrOptions;
      this.workDir = resolve(opts.workDir ?? ".");
      this.polpoDir = getPolpoDir(this.workDir);
      this.assessFn = opts.assessFn ?? assessTask;
      this.injectedStore = opts.store;
      this.injectedRunStore = opts.runStore;
      this.spawner = opts.spawner ?? new NodeSpawner({ polpoDir: this.polpoDir, cwd: this.workDir });
    }
  }

  /** Drizzle store bundle — populated when storage is "sqlite" or "postgres". */
  private drizzleStores?: import("@polpo-ai/drizzle").DrizzleStores;

  /** Create task + run stores based on the configured storage backend. */
  private async createStores(storage?: "file" | "sqlite" | "postgres", databaseUrl?: string): Promise<{
    task: TaskStore; run: RunStore;
    logStore?: LogStore; sessionStore?: SessionStore; memoryStore?: MemoryStore;
  }> {
    if (storage === "postgres") {
      const dbUrl = databaseUrl ?? this.config?.settings?.databaseUrl;
      if (!dbUrl) throw new Error('storage: "postgres" requires a databaseUrl');
      const { createPgStores, ensurePgSchema } = await import("@polpo-ai/drizzle");
      const postgres = (await import("postgres")).default;
      const { drizzle } = await import("drizzle-orm/postgres-js");
      const sql = postgres(dbUrl);
      const db = drizzle(sql);
      await ensurePgSchema(db);
      this.drizzleStores = createPgStores(db);
      return {
        task: this.drizzleStores.taskStore,
        run: this.drizzleStores.runStore,
        logStore: this.drizzleStores.logStore,
        sessionStore: this.drizzleStores.sessionStore,
        memoryStore: this.drizzleStores.memoryStore,
      };
    }
    if (storage === "sqlite") {
      const { createSqliteStores } = await import("@polpo-ai/drizzle");
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const Database = req("better-sqlite3");
      const dbPath = join(this.polpoDir, "state.db");
      const sqlite = new Database(dbPath);
      sqlite.exec("PRAGMA journal_mode = WAL");
      sqlite.exec("PRAGMA synchronous = NORMAL");
      sqlite.exec("PRAGMA foreign_keys = ON");
      const { ensureSqliteSchema } = await import("./drizzle-sqlite-schema.js");
      ensureSqliteSchema(sqlite);
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const db = drizzle(sqlite);
      this.drizzleStores = createSqliteStores(db);
      return {
        task: this.drizzleStores.taskStore,
        run: this.drizzleStores.runStore,
        logStore: this.drizzleStores.logStore,
        sessionStore: this.drizzleStores.sessionStore,
        memoryStore: this.drizzleStores.memoryStore,
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

    const stores = this.injectedStore
      ? { task: this.injectedStore, run: this.injectedRunStore! }
      : await this.createStores(this.config.settings.storage, this.config.settings.databaseUrl);
    this.registry = stores.task;
    this.runStore = stores.run;

    // When storage is "postgres", Drizzle provides all stores; otherwise use file-based defaults
    if ("logStore" in stores && stores.logStore) {
      this.logStore = stores.logStore;
      await this.logStore.startSession();
      this.setLogSink(this.logStore);
    } else {
      await this.initLogStore();
    }
    if ("sessionStore" in stores && stores.sessionStore) {
      this.sessionStore = stores.sessionStore;
    } else {
      await this.initSessionStore();
    }
    this.memoryStore = ("memoryStore" in stores && stores.memoryStore)
      ? stores.memoryStore
      : new FileMemoryStore(this.polpoDir);

    // Team & Agent stores — Drizzle when available, otherwise file-based
    this.teamStore = this.drizzleStores?.teamStore ?? new FileTeamStore(this.polpoDir);
    this.agentStore = this.drizzleStores?.agentStore ?? new FileAgentStore(this.polpoDir);

    // Validate API keys (after stores are available so we can read per-agent models)
    await this.validateProviders();

    await this.initManagers();

    // Sync config.teams from stores (authoritative source — agents.json / teams.json)
    await this.agentMgr.syncConfigCache();

    this.initVaultStore();
    this.playbookStore = this.drizzleStores?.playbookStore ?? new FilePlaybookStore(this.workDir, this.polpoDir);
  }

  /**
   * Populate stores from the teams array passed to initInteractive().
   * Idempotent — skips teams/agents that already exist in the store.
   */
  private async populateStores(teams: Team[]): Promise<void> {
    if (!teams || teams.length === 0) return;

    await this.teamStore.seed(teams);

    const agentsToSeed: Array<AgentConfig & { teamName: string }> = [];
    for (const team of teams) {
      for (const agent of team.agents) {
        agentsToSeed.push({ ...agent, teamName: team.name });
      }
    }
    if (agentsToSeed.length > 0) {
      await this.agentStore.seed(agentsToSeed);
    }
  }

  private async validateProviders(): Promise<void> {
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
    // Per-agent models (from AgentStore, not config)
    const agents = await this.agentStore.getAgents();
    for (const agent of agents) {
      if (agent.model) modelSpecs.push(agent.model);
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
        message: `Missing API keys for providers:\n${details}\nSet the corresponding environment variables or run 'polpo setup'`,
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

  /** Build the shared OrchestratorContext used by all managers. */
  private buildContext(): OrchestratorContext {
    return {
      emitter: this,
      registry: this.registry,
      runStore: this.runStore,
      memoryStore: this.memoryStore,
      logStore: this.logStore,
      sessionStore: this.sessionStore,
      teamStore: this.teamStore,
      agentStore: this.agentStore,
      hooks: this.hookRegistry,
      config: this.config,
      workDir: this.workDir,
      agentWorkDir: this.getAgentWorkDir(),
      polpoDir: this.polpoDir,
      assessFn: this.assessFn,
      spawner: this.spawner,

      // Shell-specific ports (Node.js implementations)
      killProcess: (pid, signal) => { try { process.kill(pid, (signal ?? "SIGTERM") as NodeJS.Signals); } catch { /* already dead */ } },
      loadConfig: () => loadPolpoConfig(this.polpoDir),
      saveConfig: (config) => savePolpoConfig(this.polpoDir, config),
      queryLLM: async (prompt, model) => {
        const { queryOrchestratorText } = await import("../llm/query.js");
        return queryOrchestratorText(prompt, model);
      },
      findLogForTask: (polpoDir, taskId, runId) => findLogForTask(polpoDir, taskId, runId),
      buildExecutionSummary: (logPath) => buildExecutionSummary(logPath),
      validateProviderKeys: (modelSpecs) => validateProviderKeys(modelSpecs),
      readRunLog: (runId) => {
        const logPath = join(this.polpoDir, "logs", `run-${runId}.jsonl`);
        if (!existsSync(logPath)) return null;
        return readFileSync(logPath, "utf-8");
      },
      notifySocketPath: getSocketPath(this.polpoDir),

      // Inject Drizzle stores when storage is "sqlite" or "postgres"
      ...(this.drizzleStores ? {
        approvalStore: this.drizzleStores.approvalStore,
        notificationStore: this.drizzleStores.notificationStore,
        checkpointStore: this.drizzleStores.checkpointStore,
        delayStore: this.drizzleStores.delayStore,
        peerStore: this.drizzleStores.peerStore,
        configStore: this.drizzleStores.configStore,
      } : {}),
    };
  }

  /** Create manager instances with shared context. */
  private async initManagers(): Promise<void> {
    const ctx = this.buildContext();
    this.agentMgr = new AgentManager(ctx);
    this.taskMgr = new TaskManager(ctx);
    this.missionExec = new MissionExecutor(ctx, this.taskMgr, this.agentMgr);
    await this.missionExec.ready;
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
      const approvalStore = ctx.approvalStore ?? new FileApprovalStore(this.polpoDir);
      this.approvalMgr = new ApprovalManager(ctx, approvalStore);
      this.approvalMgr.init();
    }

    // Initialize notification router if configured
    if (this.config.settings.notifications) {
      this.notificationRouter = new NotificationRouter(this);
      this.notificationRouter.init(this.config.settings.notifications, this.polpoDir);
      // Attach persistent notification store
      const notifStore = ctx.notificationStore ?? new FileNotificationStore(this.polpoDir);
      this.notificationRouter.setStore(notifStore);
      this.notificationRouter.start();

      // Set scope resolver so the router can resolve task/mission-level notification rules
      this.notificationRouter.setScopeResolver(async (data: unknown) => {
        if (!data || typeof data !== "object") return undefined;
        const d = data as Record<string, unknown>;

        // Extract taskId from common event payload shapes
        const taskId = (d.taskId as string | undefined)
          ?? ((d.task as Record<string, unknown> | undefined)?.id as string | undefined);

        // Extract missionId / group
        const taskForGroup = taskId ? await this.registry.getTask(taskId) : undefined;
        const group = (d.group as string | undefined)
          ?? taskForGroup?.group;

        const taskNotifications = taskForGroup?.notifications;

        let missionNotifications: import("./types.js").ScopedNotificationRules | undefined;
        // Resolve mission via task.missionId (direct FK) or event.missionId, fallback to group name
        const resolvedMissionId = taskForGroup?.missionId ?? (d.missionId as string | undefined);
        if (resolvedMissionId) {
          const mission = await this.registry.getMission?.(resolvedMissionId);
          missionNotifications = mission?.notifications;
        } else if (group) {
          const mission = await this.registry.getMissionByName?.(group);
          missionNotifications = mission?.notifications;
        }

        return { taskNotifications, missionNotifications };
      });
    }

    // Wire notification router to approval manager (must happen after both are created)
    if (this.approvalMgr && this.notificationRouter) {
      this.approvalMgr.setNotificationRouter(this.notificationRouter);

      // Set outcome resolver so approval notifications can include task outcomes
      this.notificationRouter.setOutcomeResolver(async (taskId: string) => {
        const task = await this.registry.getTask(taskId);
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

    // Build the deadlock resolver port (wraps the shell's deadlock-resolver module)
    const deadlockResolver: DeadlockResolverPort = {
      isResolving,
      analyzeBlockedTasks,
      resolveDeadlock: (analysis, facade: DeadlockFacade) =>
        resolveDeadlock(analysis as ReturnType<typeof analyzeBlockedTasks>, this),
    };

    // Create the pure orchestration engine
    this.engine = new OrchestratorEngine({
      ctx,
      taskManager: this.taskMgr,
      agentManager: this.agentMgr,
      missionExecutor: this.missionExec,
      taskRunner: this.runner,
      assessmentOrchestrator: this.assessor,
      approvalManager: this.approvalMgr,
      scheduler: this.scheduler,
      slaMonitor: this.slaMonitor,
      qualityController: this.qualityController,
      escalationManager: this.escalationMgr,
      deadlockResolver,
    });
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
          const task = await this.addTask({
            title: action.title,
            description: action.description,
            assignTo: action.assignTo,
            expectations: action.expectations,
          });
          return `Task created: [${task.id}] "${task.title}" → ${task.assignTo}`;
        }
        case "execute_mission": {
          const mission = await this.registry.getMission?.(action.missionId);
          if (!mission) throw new Error(`Mission "${action.missionId}" not found`);
          const result = await this.missionExec.executeMission(action.missionId);
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
   * Initialize for interactive mode.
   * Creates .polpo dir and a minimal config from provided team info.
   */
  async initInteractive(project: string, teams: Team | Team[]): Promise<void> {
    const teamsArray = Array.isArray(teams) ? teams : [teams];
    if (!existsSync(this.polpoDir)) {
      mkdirSync(this.polpoDir, { recursive: true });
    }

    // Load .polpo/.env so ${VAR} references resolve correctly
    loadEnvFile(this.polpoDir);

    // Load persistent config if available
    const polpoConfig = loadPolpoConfig(this.polpoDir);
    const settings = polpoConfig?.settings ?? { maxRetries: 2, workDir: ".", logLevel: "normal" as const };

    const storageBackend = settings.storage as "file" | "sqlite" | "postgres" | undefined;
    const dbUrl = (settings as any).databaseUrl ?? process.env.DATABASE_URL;
    const stores = this.injectedStore
      ? { task: this.injectedStore, run: this.injectedRunStore! }
      : await this.createStores(storageBackend, dbUrl);
    this.registry = stores.task;
    this.runStore = stores.run;

    // Use Drizzle-provided stores when available, otherwise fall back to file-based
    if ("logStore" in stores && stores.logStore) {
      this.logStore = stores.logStore;
      await this.logStore.startSession();
      this.setLogSink(this.logStore);
    } else {
      await this.initLogStore();
    }
    if ("sessionStore" in stores && stores.sessionStore) {
      this.sessionStore = stores.sessionStore;
    } else {
      await this.initSessionStore();
    }
    this.memoryStore = ("memoryStore" in stores && stores.memoryStore)
      ? stores.memoryStore
      : new FileMemoryStore(this.polpoDir);

    // Team & Agent stores — Drizzle when available, otherwise file-based
    this.teamStore = this.drizzleStores?.teamStore ?? new FileTeamStore(this.polpoDir);
    this.agentStore = this.drizzleStores?.agentStore ?? new FileAgentStore(this.polpoDir);

    // Populate stores with the teams passed to initInteractive
    // (this is project creation, not migration — teams come from the caller)
    await this.populateStores(teamsArray);

    this.config = {
      version: "1",
      project: polpoConfig?.project ?? project,
      teams: [], // populated by syncConfigCache() from stores
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

    await this.initManagers();

    // Sync config.teams from stores (authoritative source — agents.json / teams.json)
    await this.agentMgr.syncConfigCache();

    this.initVaultStore();
    this.playbookStore = this.drizzleStores?.playbookStore ?? new FilePlaybookStore(this.workDir, this.polpoDir);
    this.interactive = true;
    await this.registry.setState({
      project,
      teams: this.config.teams,
      startedAt: new Date().toISOString(),
    });

    // Recover any tasks left in limbo from a previous crash
    const recovered = await this.runner.recoverOrphanedTasks();
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
          this.reloadConfig().catch(() => {});
        }, 500);
      });

      this.emit("log", { level: "info", message: "[watch] Watching polpo.json for changes" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `[watch] Failed to watch polpo.json: ${msg}` });
    }
  }

  // ── Task Management (delegates to OrchestratorEngine → TaskManager) ──

  async addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[]; group?: string; maxDuration?: number; retryPolicy?: RetryPolicy;
    notifications?: ScopedNotificationRules; sideEffects?: boolean; draft?: boolean;
  }): Promise<Task> { return this.engine.addTask(opts); }
  async updateTaskDescription(taskId: string, description: string): Promise<void> { return this.engine.updateTaskDescription(taskId, description); }
  async updateTaskAssignment(taskId: string, agentName: string): Promise<void> { return this.engine.updateTaskAssignment(taskId, agentName); }
  async updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): Promise<void> { return this.engine.updateTaskExpectations(taskId, expectations); }
  async retryTask(taskId: string): Promise<void> { return this.engine.retryTask(taskId); }
  reassessTask(taskId: string): Promise<void> { return this.engine.reassessTask(taskId); }
  async killTask(taskId: string): Promise<boolean> { return this.engine.killTask(taskId); }
  async deleteTask(taskId: string): Promise<boolean> { return this.engine.deleteTask(taskId); }
  async abortGroup(group: string): Promise<number> { return this.engine.abortGroup(group); }
  async clearTasks(filter: (task: Task) => boolean): Promise<number> { return this.engine.clearTasks(filter); }
  async forceFailTask(taskId: string): Promise<void> { return this.engine.forceFailTask(taskId); }

  // ── Approval Management (delegates to OrchestratorEngine) ──

  async approveRequest(requestId: string, resolvedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    return this.engine.approveRequest(requestId, resolvedBy, note);
  }
  async rejectRequest(requestId: string, feedback: string, resolvedBy?: string): Promise<ApprovalRequest | null> {
    return this.engine.rejectRequest(requestId, feedback, resolvedBy);
  }
  async canRejectRequest(requestId: string): Promise<{ allowed: boolean; rejectionCount: number; maxRejections: number }> {
    return this.engine.canRejectRequest(requestId);
  }
  async getPendingApprovals(): Promise<ApprovalRequest[]> {
    return this.engine.getPendingApprovals();
  }
  async getAllApprovals(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return this.engine.getAllApprovals(status);
  }
  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    return this.engine.getApprovalRequest(id);
  }

  // ── Store Accessors ──

  getStore(): TaskStore { return this.registry; }
  getRunStore(): RunStore { return this.runStore; }
  getPolpoDir(): string { return this.polpoDir; }
  getMemoryStore(): MemoryStore { return this.memoryStore; }
  getVaultStore(): VaultStore | undefined { return this.vaultStore; }
  getPlaybookStore(): PlaybookStore { return this.playbookStore; }
  getTeamStore(): TeamStore { return this.teamStore; }
  getAgentStore(): AgentStore { return this.agentStore; }

  /**
   * Initialize the vault store.
   * When storage is "sqlite" or "postgres", uses DrizzleVaultStore (AES-256-GCM encrypted in DB).
   * Otherwise falls back to EncryptedVaultStore (file-based, .polpo/vault.enc).
   * Key: POLPO_VAULT_KEY env var or auto-generated ~/.polpo/vault.key.
   */
  private initVaultStore(): void {
    try {
      this.vaultStore = this.drizzleStores?.vaultStore ?? new EncryptedVaultStore(this.polpoDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `Vault store init failed: ${msg}. Vault features disabled.` });
    }
  }

  // ── Agent Management (delegates to OrchestratorEngine → AgentManager) ──

  async getAgents(): Promise<AgentConfig[]> { return this.engine.getAgents(); }
  async getTeams(): Promise<Team[]> { return this.engine.getTeams(); }
  async getTeam(name?: string): Promise<Team | undefined> { return this.engine.getTeam(name); }
  getConfig(): PolpoConfig | null { return this.config; }
  get isInitialized(): boolean { return this.interactive; }
  async addTeam(team: Team): Promise<void> { return this.engine.addTeam(team); }
  async removeTeam(name: string): Promise<boolean> { return this.engine.removeTeam(name); }
  async renameTeam(oldName: string, newName: string): Promise<void> { return this.engine.renameTeam(oldName, newName); }
  async addAgent(agent: AgentConfig, teamName?: string): Promise<void> { return this.engine.addAgent(agent, teamName); }
  async removeAgent(name: string): Promise<boolean> { return this.engine.removeAgent(name); }
  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> { return this.engine.updateAgent(name, updates); }
  async findAgentTeam(name: string): Promise<Team | undefined> { return this.engine.findAgentTeam(name); }
  async addVolatileAgent(agent: AgentConfig, group: string): Promise<void> { return this.engine.addVolatileAgent(agent, group); }
  async cleanupVolatileAgents(group: string): Promise<number> { return this.engine.cleanupVolatileAgents(group); }


  // ─── Mission Management (delegates to OrchestratorEngine → MissionExecutor) ──

  async saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules }): Promise<Mission> { return this.engine.saveMission(opts); }
  async getMission(missionId: string): Promise<Mission | undefined> { return this.engine.getMission(missionId); }
  async getMissionByName(name: string): Promise<Mission | undefined> { return this.engine.getMissionByName(name); }
  async getAllMissions(): Promise<Mission[]> { return this.engine.getAllMissions(); }
  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> { return this.engine.updateMission(missionId, updates); }
  async deleteMission(missionId: string): Promise<boolean> { return this.engine.deleteMission(missionId); }

  // ─── Atomic Mission Data Operations (delegates to OrchestratorEngine → MissionExecutor) ──

  async addMissionTask(missionId: string, task: { title: string; description: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission> {
    return this.engine.addMissionTask(missionId, task);
  }
  async updateMissionTask(missionId: string, taskTitle: string, updates: { title?: string; description?: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission> {
    return this.engine.updateMissionTask(missionId, taskTitle, updates);
  }
  async removeMissionTask(missionId: string, taskTitle: string): Promise<Mission> {
    return this.engine.removeMissionTask(missionId, taskTitle);
  }
  async reorderMissionTasks(missionId: string, titles: string[]): Promise<Mission> {
    return this.engine.reorderMissionTasks(missionId, titles);
  }
  async addMissionCheckpoint(missionId: string, cp: { name: string; afterTasks: string[]; blocksTasks: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.addMissionCheckpoint(missionId, cp);
  }
  async updateMissionCheckpoint(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.updateMissionCheckpoint(missionId, name, updates);
  }
  async removeMissionCheckpoint(missionId: string, name: string): Promise<Mission> {
    return this.engine.removeMissionCheckpoint(missionId, name);
  }
  async addMissionQualityGate(missionId: string, gate: { name: string; afterTasks: string[]; blocksTasks: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission> {
    return this.engine.addMissionQualityGate(missionId, gate);
  }
  async updateMissionQualityGate(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission> {
    return this.engine.updateMissionQualityGate(missionId, name, updates);
  }
  async removeMissionQualityGate(missionId: string, name: string): Promise<Mission> {
    return this.engine.removeMissionQualityGate(missionId, name);
  }
  async addMissionDelay(missionId: string, delay: { name: string; afterTasks: string[]; blocksTasks: string[]; duration: string; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.addMissionDelay(missionId, delay);
  }
  async updateMissionDelay(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; duration?: string; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.updateMissionDelay(missionId, name, updates);
  }
  async removeMissionDelay(missionId: string, name: string): Promise<Mission> {
    return this.engine.removeMissionDelay(missionId, name);
  }
  async addMissionTeamMember(missionId: string, member: { name: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission> {
    return this.engine.addMissionTeamMember(missionId, member);
  }
  async updateMissionTeamMember(missionId: string, memberName: string, updates: { name?: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission> {
    return this.engine.updateMissionTeamMember(missionId, memberName, updates);
  }
  async removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission> {
    return this.engine.removeMissionTeamMember(missionId, memberName);
  }
  async updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Promise<Mission> {
    return this.engine.updateMissionNotifications(missionId, notifications);
  }

  // ─── Shared Memory (delegates to OrchestratorEngine) ───

  /** Check if shared memory exists. */
  async hasMemory(): Promise<boolean> { return this.engine.hasMemory(); }

  /** Get the full shared memory content. */
  async getMemory(): Promise<string> { return this.engine.getMemory(); }

  /** Overwrite the shared memory. */
  async saveMemory(content: string): Promise<void> { return this.engine.saveMemory(content); }

  /** Append a line to the shared memory. */
  async appendMemory(line: string): Promise<void> { return this.engine.appendMemory(line); }

  /** Replace a unique substring in the shared memory. */
  async updateMemory(oldText: string, newText: string): Promise<true | string> { return this.engine.updateMemory(oldText, newText); }

  // ─── Agent Memory (delegates to OrchestratorEngine) ───

  /** Check if memory exists for a specific agent. */
  async hasAgentMemory(agentName: string): Promise<boolean> { return this.engine.hasAgentMemory(agentName); }

  /** Get the memory content for a specific agent. */
  async getAgentMemory(agentName: string): Promise<string> { return this.engine.getAgentMemory(agentName); }

  /** Overwrite the memory for a specific agent. */
  async saveAgentMemory(agentName: string, content: string): Promise<void> { return this.engine.saveAgentMemory(agentName, content); }

  /** Append a line to a specific agent's memory. */
  async appendAgentMemory(agentName: string, line: string): Promise<void> { return this.engine.appendAgentMemory(agentName, line); }

  /** Replace a unique substring in a specific agent's memory. */
  async updateAgentMemory(agentName: string, oldText: string, newText: string): Promise<true | string> { return this.engine.updateAgentMemory(agentName, oldText, newText); }

  /** Get the persistent log store. */
  getLogStore(): LogStore | undefined {
    return this.logStore;
  }

  /** Initialize the persistent log store and wire it as event sink. */
  private async initLogStore(): Promise<void> {
    this.logStore = new FileLogStore(this.polpoDir);
    await this.logStore.startSession();
    this.setLogSink(this.logStore);
    // Auto-prune: keep last 20 sessions
    try { await this.logStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  /** Get the chat session store. */
  getSessionStore(): SessionStore | undefined {
    return this.sessionStore;
  }

  /** Initialize the chat session store. */
  private async initSessionStore(): Promise<void> {
    this.sessionStore = new FileSessionStore(this.polpoDir);
    try { await this.sessionStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  // ─── Mission Resume / Execute (delegates to OrchestratorEngine → MissionExecutor) ──

  async getResumableMissions(): Promise<Mission[]> { return this.engine.getResumableMissions(); }
  async resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }> { return this.engine.resumeMission(missionId, opts); }
  async executeMission(missionId: string): Promise<{ tasks: Task[]; group: string }> { return this.engine.executeMission(missionId); }

  // ─── Checkpoints (delegates to OrchestratorEngine) ──

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints() { return this.engine.getActiveCheckpoints(); }

  /** Resume a checkpoint by mission group name and checkpoint name. Returns true if resumed. */
  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    return this.engine.resumeCheckpoint(group, checkpointName);
  }

  /** Resume a checkpoint by mission ID and checkpoint name. Returns true if resumed. */
  async resumeCheckpointByMissionId(missionId: string, checkpointName: string): Promise<boolean> {
    return this.engine.resumeCheckpointByMissionId(missionId, checkpointName);
  }

  // ─── Delays (delegates to OrchestratorEngine) ─────

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays() { return this.engine.getActiveDelays(); }

  /** Stop the supervisor loop (non-graceful — use gracefulStop for clean shutdown) */
  stop(): void {
    this.stopped = true;
    this.engine?.stop();
  }

  /**
   * Graceful shutdown: SIGTERM all runner subprocesses, wait for them to write results,
   * preserve completed work, leave in-progress tasks for recovery on restart.
   */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    await this.hookRegistry.runBefore("orchestrator:shutdown", {});
    this.stopped = true;
    const activeRuns = await this.runStore.getActiveRuns();

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
        const stillActive = await this.runStore.getActiveRuns();
        if (stillActive.length === 0) break;
        await sleep(200);
      }

      // Force-mark any remaining active runs as killed
      for (const run of await this.runStore.getActiveRuns()) {
        await this.runStore.completeRun(run.id, "killed", {
          exitCode: 1, stdout: "", stderr: "Killed during shutdown", duration: 0,
        });
      }
    }

    // Only save completed work — leave killed/failed tasks in current state for recovery
    for (const run of await this.runStore.getTerminalRuns()) {
      const task = await this.registry.getTask(run.taskId);
      if (run.status === "completed" && run.result?.exitCode === 0 && task && task.status !== "done") {
        // Agent finished successfully — save result and mark done (skip async assessment)
        try {
          await this.registry.updateTask(run.taskId, { result: run.result });
          if (task.status === "pending") await this.registry.transition(run.taskId, "assigned");
          if (task.status === "assigned") await this.registry.transition(run.taskId, "in_progress");
          if (task.status === "in_progress") await this.registry.transition(run.taskId, "review");
          await this.registry.transition(run.taskId, "done");
        } catch { /* leave for recovery on restart */ }
      }
      // For killed/failed runs: task stays in current state (in_progress, assigned, etc.)
      // recoverOrphanedTasks() on restart will handle retry without burning retry count
      await this.runStore.deleteRun(run.id);
    }

    // Clear process list in state and close stores
    await this.registry.setState({ processes: [], completedAt: new Date().toISOString() });
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
    await this.registry.close?.();
    await this.runStore.close();
    this.emit("orchestrator:shutdown", {});
    await this.hookRegistry.runAfter("orchestrator:shutdown", {});
    await this.logStore?.close();
    await this.sessionStore?.close();
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
  async reloadConfig(): Promise<boolean> {
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
    //    Settings and providers come from polpo.json; teams come from stores.
    const newSettings = polpoConfig.settings ?? this.config.settings;
    this.config.settings = newSettings;
    if (polpoConfig.providers) {
      this.config.providers = polpoConfig.providers;
      setProviderOverrides(polpoConfig.providers);
    }
    if (newSettings.modelAllowlist) {
      setModelAllowlist(newSettings.modelAllowlist);
    }

    // Re-sync config.teams from TeamStore/AgentStore (authoritative source)
    await this.agentMgr.syncConfigCache();

    // 3. Invalidate cached agent work dir and rebuild OrchestratorContext
    this.cachedAgentWorkDir = null;
    const ctx = this.buildContext();

    // 4. Re-initialize optional subsystems from new config

    // Approval gates
    if (this.config.settings.approvalGates && this.config.settings.approvalGates.length > 0) {
      const approvalStore = this.drizzleStores?.approvalStore ?? new FileApprovalStore(this.polpoDir);
      this.approvalMgr = new ApprovalManager(ctx, approvalStore);
      this.approvalMgr.init();
    }

    // Notification router
    if (this.config.settings.notifications) {
      this.notificationRouter = new NotificationRouter(this);
      this.notificationRouter.init(this.config.settings.notifications, this.polpoDir);
      const notifStore = this.drizzleStores?.notificationStore ?? new FileNotificationStore(this.polpoDir);
      this.notificationRouter.setStore(notifStore);
      this.notificationRouter.start();

      // Restore scope resolver
      this.notificationRouter.setScopeResolver(async (data: unknown) => {
        if (!data || typeof data !== "object") return undefined;
        const d = data as Record<string, unknown>;
        const taskId = (d.taskId as string | undefined)
          ?? ((d.task as Record<string, unknown> | undefined)?.id as string | undefined);
        const taskForGroup = taskId ? await this.registry.getTask(taskId) : undefined;
        const group = (d.group as string | undefined)
          ?? taskForGroup?.group;
        const taskNotifications = taskForGroup?.notifications;
        let missionNotifications: ScopedNotificationRules | undefined;
        // Resolve mission via task.missionId (direct FK) or event.missionId, fallback to group name
        const resolvedMissionId = taskForGroup?.missionId ?? (d.missionId as string | undefined);
        if (resolvedMissionId) {
          const mission = await this.registry.getMission?.(resolvedMissionId);
          missionNotifications = mission?.notifications;
        } else if (group) {
          const mission = await this.registry.getMissionByName?.(group);
          missionNotifications = mission?.notifications;
        }
        return { taskNotifications, missionNotifications };
      });
    }

    // Wire notification router to approval manager
    if (this.approvalMgr && this.notificationRouter) {
      this.approvalMgr.setNotificationRouter(this.notificationRouter);
      this.notificationRouter.setOutcomeResolver(async (taskId: string) => {
        const task = await this.registry.getTask(taskId);
        return task?.outcomes;
      });
      this.startTelegramApprovalPoller();
    } else if (this.notificationRouter && this.hasTelegramGatewayEnabled()) {
      // Start Telegram poller even without approval gates when gateway inbound is enabled
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

    // Sync engine with updated optional subsystems
    this.engine.setApprovalManager(this.approvalMgr);
    this.engine.setScheduler(this.scheduler);
    this.engine.setSLAMonitor(this.slaMonitor);
    this.engine.setQualityController(this.qualityController);
    this.engine.setEscalationManager(this.escalationMgr);

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
  async recoverOrphanedTasks(): Promise<number> { return this.engine.recoverOrphanedTasks(); }

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
          const result = await approvalMgr.approve(requestId, resolvedBy);
          return result ? { ok: true } : { ok: false, error: "Not found or already resolved" };
        },
        reject: async (requestId, feedback, resolvedBy) => {
          const result = await approvalMgr.reject(requestId, feedback, resolvedBy);
          return result ? { ok: true } : { ok: false, error: "Not found, already resolved, or max rejections reached" };
        },
      };
      poller.setResolver(resolver);
    }

    // Check if inbound gateway is enabled for this Telegram channel
    const channelConfig = this.config.settings.notifications?.channels[telegramConfigKey];
    if (channelConfig?.gateway?.enableInbound) {
      // Initialize peer store
      this.peerStore = this.drizzleStores?.peerStore ?? new FilePeerStore(this.polpoDir);

      // Create ChannelGateway with typing indicator support
      this.channelGateway = new ChannelGateway({
        orchestrator: this,
        peerStore: this.peerStore!,
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
          const result = await approvalMgr.approve(requestId, resolvedBy);
          return result ? { ok: true } : { ok: false, error: "Not found or already resolved" };
        },
        reject: async (requestId, feedback, resolvedBy) => {
          const result = await approvalMgr.reject(requestId, feedback, resolvedBy);
          return result ? { ok: true } : { ok: false, error: "Not found, already resolved, or max rejections reached" };
        },
      };
    }

    // Set up gateway if inbound is enabled
    const channelConfig = this.config.settings.notifications?.channels[waConfigKey];
    if (channelConfig?.gateway?.enableInbound) {
      // Initialize peer store (shared with Telegram if already created)
      if (!this.peerStore) {
        this.peerStore = this.drizzleStores?.peerStore ?? new FilePeerStore(this.polpoDir);
      }

      // Create or reuse ChannelGateway
      if (!this.channelGateway) {
        this.channelGateway = new ChannelGateway({
          orchestrator: this,
          peerStore: this.peerStore!,
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

  private async seedTasks(): Promise<void> {
    await this.taskMgr.seedTasks();
    // Sync config cache from stores so state reflects authoritative data
    await this.agentMgr.syncConfigCache();
    // Also set initial state for non-interactive mode
    await this.registry.setState({
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
      await this.seedTasks();
    }

    this.stopped = false;

    // Node.js-specific: catch unhandled promise rejections
    const rejectionHandler = (reason: unknown) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.emit("log", { level: "error", message: `Unhandled rejection in supervisor: ${msg}` });
    };

    await this.engine.run(
      this.interactive,
      () => { process.on("unhandledRejection", rejectionHandler); },
      () => { process.removeListener("unhandledRejection", rejectionHandler); },
    );
  }

  /**
   * Single tick of the supervisor loop. Returns true when all work is done.
   */
  async tick(): Promise<boolean> {
    return this.engine.tick();
  }

  // Assessment pipeline delegated to AssessmentOrchestrator
  /** @internal — test access only */
  private async retryOrFail(taskId: string, task: Task, result: TaskResult): Promise<void> {
    await this.assessor.retryOrFail(taskId, task, result);
  }

  async status(): Promise<void> {
    await this.init();
    // Emit log for CLI to consume
    const tasks = await this.registry.getAllTasks();
    const done = tasks.filter(t => t.status === "done");
    const failed = tasks.filter(t => t.status === "failed");
    this.emit("log", { level: "info", message: `Total: ${tasks.length} | Done: ${done.length} | Failed: ${failed.length}` });
  }

  /** Access the pure orchestration engine (for advanced use / testing). */
  getEngine(): OrchestratorEngine { return this.engine; }
}

