import { nanoid } from "nanoid";
import { resolve, join } from "node:path";
import { mkdirSync, existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { getPolpoDir } from "./constants.js";
import type { Server } from "node:net";
import { parseConfig, loadPolpoConfig, savePolpoConfig, loadEnvFile, parseProviders } from "./config.js";
import { findLogForTask, buildExecutionSummary } from "../assessment/transcript-parser.js";
import { FileTaskStore } from "../stores/file-task-store.js";
import { FileRunStore } from "../stores/file-run-store.js";
import { FileTaskControlStore } from "../stores/file-task-control-store.js";
import { FileMemoryStore } from "../stores/file-memory-store.js";
import { FileLogStore } from "../stores/file-log-store.js";
import { FileSessionStore } from "../stores/file-session-store.js";
import { FileChatQueueStore } from "../stores/file-chat-queue-store.js";
import { FileRoomStore } from "../stores/file-room-store.js";
import type { SessionStore } from "./session-store.js";
import { FileCodingSessionStore } from "../stores/file-coding-session-store.js";
import type { CodingSessionStore } from "./coding-session-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogPruneResult, LogStore } from "./log-store.js";
import { assessTask } from "../assessment/assessor.js";
import { analyzeBlockedTasks, resolveDeadlock, isResolving } from "./deadlock-resolver.js";
import { OrchestratorEngine } from "@polpo-ai/core";
import type { DeadlockResolverPort, DeadlockFacade, MissionEdit } from "@polpo-ai/core";
import { MISSION_EDIT } from "@polpo-ai/core";
import { TypedEmitter, withEventOrigin } from "./events.js";
import type { PolpoEventMap } from "@polpo-ai/core";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type { BackgroundWaitStore, TaskControlStore } from "./task-control-store.js";
import type {
  PolpoConfig,
  AgentConfig,
  AgentUpdate,
  Task,
  TaskStatus,
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
import { refreshCustomProviderSecretStatus, setProviderSecretsSource } from "../llm/custom-providers.js";
import { readProviderSecrets } from "../llm/provider-secrets.js";
import { startNotificationServer, getSocketPath } from "./notification.js";
import { HookRegistry } from "./hooks.js";
import { ApprovalManager } from "./approval-manager.js";
import { FileApprovalStore } from "../stores/file-approval-store.js";
import { NotificationRouter } from "../notifications/index.js";
import { FileNotificationStore } from "../stores/file-notification-store.js";
import { TelegramCallbackPoller } from "../notifications/channels/telegram.js";
import { syncTelegramBotProfile } from "../notifications/telegram-bot-profile.js";
import type { ApprovalCallbackResolver } from "../notifications/channels/telegram.js";
import { ChannelGateway, type ChannelChatRunner, type ChannelCompactRunner, type ReplyRouteEvent } from "../notifications/channel-gateway.js";
import { GroupIntentArbiter } from "../notifications/group-intent.js";
import { POLPO, RoomEngine } from "../rooms/room-engine.js";
import { TelegramAgentRelay, type RelayBot } from "../rooms/telegram-relay.js";
import { TelegramGatewayAdapter } from "../notifications/telegram-gateway-adapter.js";
import { WebhookGatewayAdapter } from "../notifications/webhook-gateway-adapter.js";
import { WhatsAppBridge, WhatsAppChannel } from "../notifications/channels/whatsapp.js";
import { WhatsAppGatewayAdapter } from "../notifications/whatsapp-gateway-adapter.js";
import { WhatsAppStore } from "../stores/whatsapp-store.js";
import type { WhatsAppMessageStore } from "@polpo-ai/core/whatsapp-store";
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
import { BackgroundWaitManager, type BackgroundWaitContinuation } from "./background-wait-manager.js";
import type { ApprovalRequest, ApprovalStatus, ChannelReplyTarget, NotificationAction } from "./types.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultStore } from "./vault-store.js";
import type { PlaybookStore } from "./playbook-store.js";
import { FilePlaybookStore } from "../stores/file-playbook-store.js";
import { NodeSpawner } from "../adapters/node-spawner.js";
import type { Spawner } from "./spawner.js";
import { FileContextCheckpointStore } from "../stores/file-context-checkpoint-store.js";
import type { ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";
import { databaseStoresFor } from "./storage.js";
import { availableProviders, createWorkspace, effectiveSandbox, WorkspaceShell } from "../sandbox/manager.js";
import { normalizeSandboxSettings, type StorageMountProvider, type Workspace } from "@polpo-ai/core/sandbox";
import type { Shell } from "@polpo-ai/core/shell";

// Re-export for backward compatibility (consumed by core/index.ts and external modules)
export { buildFixPrompt, buildRetryPrompt };
export type { AssessFn };

export interface OrchestratorOptions {
  workDir?: string;
  store?: TaskStore;
  runStore?: RunStore;
  taskControlStore?: TaskControlStore;
  assessFn?: AssessFn;
  spawner?: Spawner;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Days of orchestrator event logs kept when settings.logRetentionDays is not set. */
const DEFAULT_LOG_RETENTION_DAYS = 30;

function supportsBackgroundWaits(store: TaskControlStore): store is TaskControlStore & BackgroundWaitStore {
  return typeof store.createBackgroundWait === "function"
    && typeof store.getBackgroundWait === "function"
    && typeof store.listBackgroundWaits === "function"
    && typeof store.markBackgroundWaitReady === "function"
    && typeof store.claimBackgroundWait === "function"
    && typeof store.completeBackgroundWait === "function"
    && typeof store.failBackgroundWait === "function"
    && typeof store.requeueBackgroundWait === "function"
    && typeof store.cancelBackgroundWait === "function"
    && typeof store.recoverBackgroundWaits === "function";
}

export class Orchestrator extends TypedEmitter {
  private registry!: TaskStore;
  private runStore!: RunStore;
  private taskControlStore!: TaskControlStore;
  private config!: PolpoConfig;
  private polpoDir: string;
  private workDir: string;
  /** Cached resolved agent working directory (invalidated on config reload). */
  private cachedAgentWorkDir: string | null = null;
  private interactive = false;
  private stopped = false;
  private assessFn: AssessFn;
  private spawner: Spawner;
  private ownsSpawner = true;
  private injectedStore?: TaskStore;
  private injectedRunStore?: RunStore;
  private injectedTaskControlStore?: TaskControlStore;
  private memoryStore!: MemoryStore;
  private logStore!: LogStore;
  private sessionStore!: SessionStore;
  private codingSessionStore!: CodingSessionStore;
  private notificationServer?: Server;
  private hookRegistry = new HookRegistry();
  private approvalMgr?: ApprovalManager;
  private notificationRouter?: NotificationRouter;
  private escalationMgr?: EscalationManager;
  private slaMonitor?: SLAMonitor;
  private qualityController?: QualityController;
  private scheduler?: Scheduler;
  private watcherMgr?: TaskWatcherManager;
  private backgroundWaitMgr?: BackgroundWaitManager;
  private backgroundWaitContinuation?: BackgroundWaitContinuation;
  private telegramPoller?: TelegramCallbackPoller;
  /** Pollers of dedicated-agent bots (extra Telegram channels with gateway.agent). */
  private dedicatedTelegramPollers: TelegramCallbackPoller[] = [];
  /** Gateways by channel name; the primary one is also exposed as channelGateway. */
  private channelGateways = new Map<string, ChannelGateway>();
  /** @usernames of running Telegram bots by channel name (getMe at start), for the chat prompt. */
  private telegramBotUsernames = new Map<string, string>();
  /** Bots dedicated to one agent, refreshed (menu, photo, description) when that agent changes. */
  private dedicatedTelegramBots = new Map<string, { agent: string; botToken: string; poller: TelegramCallbackPoller; gateway: ChannelGateway }>();
  /** Running Telegram pollers by channel name, for replies routed from other channels. */
  private telegramPollersByChannel = new Map<string, TelegramCallbackPoller>();
  /** Inbound webhook channels (HTTP clients such as iOS Shortcuts) by channel name. */
  private webhookGateways = new Map<string, { gateway: ChannelGateway; adapter: WebhookGatewayAdapter }>();
  private whatsappBridge?: WhatsAppBridge;
  private whatsappStore?: WhatsAppMessageStore;
  private peerStore?: PeerStore;
  private teamStore!: TeamStore;
  private agentStore!: AgentStore;
  private channelGateway?: ChannelGateway;
  private channelChatRunner?: ChannelChatRunner;
  private channelCompactRunner?: ChannelCompactRunner;
  private contextCheckpointStore?: ContextCheckpointStore;
  private configWatcher?: FSWatcher;
  private configReloadTimer?: ReturnType<typeof setTimeout>;
  private logRetentionTimer?: ReturnType<typeof setTimeout>;
  private vaultStore?: VaultStore;
  private playbookStore!: PlaybookStore;
  private eventingTaskStores = new WeakMap<TaskStore, TaskStore>();

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
  /** Primary gateway, or the gateway of a specific channel by name. */
  getChannelGateway(channelName?: string): ChannelGateway | undefined {
    return channelName
      ? this.channelGateways.get(channelName) ?? this.webhookGateways.get(channelName)?.gateway
      : this.channelGateway;
  }
  /** Inbound adapter of a webhook channel with gateway.enableInbound. */
  getWebhookGateway(channelName: string): WebhookGatewayAdapter | undefined {
    return this.webhookGateways.get(channelName)?.adapter;
  }
  getTelegramBotUsernames(): Map<string, string> { return this.telegramBotUsernames; }
  /** Agent-direct chat for messaging channels, provided by the server host. */
  getChannelChatRunner(): ChannelChatRunner | undefined { return this.channelChatRunner; }
  setChannelChatRunner(runner: ChannelChatRunner): void { this.channelChatRunner = runner; }
  /** Where chat sessions keep their compaction checkpoint (database when configured, files otherwise). */
  // ── Sandboxes for chats (Polpo and agents): one workspace per interlocutor, closed when idle ──

  private storageMountProvider?: StorageMountProvider;
  private chatWorkspaces = new Map<string, { workspace: Promise<Workspace>; timer?: ReturnType<typeof setTimeout> }>();

  /** The storage feature registers what each agent may mount. */
  setStorageMountProvider(provider: StorageMountProvider | undefined): void { this.storageMountProvider = provider; }

  /**
   * The shell an interlocutor's chat commands run in (agent tools in chat, Polpo's run_command).
   * Polpo talks with people on messaging channels, so it counts as reading external content:
   * it gets at least bubblewrap unless the instance allows local explicitly.
   */
  chatShell(agent?: AgentConfig): Shell {
    const key = agent?.name ?? "polpo";
    const orchestrator = this;
    const idleMs = (normalizeSandboxSettings(this.config?.settings?.sandbox)?.chatIdleMinutes ?? 30) * 60_000;
    const acquire = (): Promise<Workspace> => {
      const existing = this.chatWorkspaces.get(key);
      const entry = existing ?? { workspace: this.openChatWorkspace(agent) };
      if (!existing) this.chatWorkspaces.set(key, entry);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void orchestrator.closeChatWorkspace(key, "idle"), idleMs);
      entry.timer.unref?.();
      entry.workspace.catch(() => this.chatWorkspaces.delete(key));
      return entry.workspace;
    };
    return {
      async execute(command, options = {}) {
        const workspace = await acquire();
        return new WorkspaceShell(workspace).execute(command, options);
      },
    };
  }

  private async openChatWorkspace(agent?: AgentConfig): Promise<Workspace> {
    const settings = this.config?.settings;
    const instanceSandbox = normalizeSandboxSettings(settings?.sandbox);
    const sandbox = effectiveSandbox({
      scope: "chat",
      cascade: { instance: instanceSandbox, agent: normalizeSandboxSettings(agent?.sandbox) },
      // Polpo reads messages from people on channels: treat it like an agent reading external content
      agentTools: agent ? agent.allowedTools : (instanceSandbox?.allowLocal ? [] : ["http_fetch"]),
    });
    const mounts = (await this.storageMountProvider?.mountsFor(agent?.name, "host").catch(() => [])) ?? [];
    const root = this.getAgentWorkDir();
    try {
      const workspace = createWorkspace(sandbox, {
        root,
        readable: [join(this.polpoDir, "tmp", "tool-output")],
        mounts: mounts.filter((m) => m.hostPath),
      });
      this.emit("sandbox:created", {
        workspaceId: workspace.id, provider: workspace.provider, scope: "chat", agentName: agent?.name ?? "polpo", network: sandbox.network.mode,
      });
      return workspace;
    } catch (error) {
      this.emit("sandbox:failed", { provider: sandbox.provider, scope: "chat", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async closeChatWorkspace(key: string, reason: "idle" | "shutdown"): Promise<void> {
    const entry = this.chatWorkspaces.get(key);
    if (!entry) return;
    this.chatWorkspaces.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    const workspace = await entry.workspace.catch(() => undefined);
    if (!workspace) return;
    await workspace.dispose().catch(() => undefined);
    this.emit("sandbox:destroyed", { workspaceId: workspace.id, provider: workspace.provider, durationMs: 0, reason });
  }

  getContextCheckpointStore(): ContextCheckpointStore {
    this.contextCheckpointStore ??= databaseStoresFor(this.polpoDir)?.contextCheckpointStore ?? new FileContextCheckpointStore(this.polpoDir);
    return this.contextCheckpointStore;
  }
  getChannelCompactRunner(): ChannelCompactRunner | undefined { return this.channelCompactRunner; }
  setChannelCompactRunner(runner: ChannelCompactRunner): void { this.channelCompactRunner = runner; }
  getSLAMonitor(): SLAMonitor | undefined { return this.slaMonitor; }
  getQualityController(): QualityController | undefined { return this.qualityController; }
  getScheduler(): Scheduler | undefined { return this.scheduler; }
  getWatcherManager(): TaskWatcherManager | undefined { return this.watcherMgr; }
  getBackgroundWaitManager(): BackgroundWaitManager | undefined { return this.backgroundWaitMgr; }
  setBackgroundWaitContinuation(handler: BackgroundWaitContinuation): void {
    this.backgroundWaitContinuation = handler;
    this.backgroundWaitMgr?.setContinuation(handler);
  }
  getWhatsAppStore(): WhatsAppMessageStore | undefined { return this.whatsappStore; }
  getWhatsAppBridge(): WhatsAppBridge | undefined { return this.whatsappBridge; }

  /** Re-point the orchestrator at a different project directory (before init). */
  resetWorkDir(newWorkDir: string): void {
    this.workDir = resolve(newWorkDir);
    this.polpoDir = getPolpoDir(this.workDir);
    this.cachedAgentWorkDir = null;
    if (this.ownsSpawner) {
      this.spawner = new NodeSpawner({ polpoDir: this.polpoDir, cwd: this.workDir });
    }
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
      this.injectedTaskControlStore = opts.taskControlStore;
      this.spawner = opts.spawner ?? new NodeSpawner({ polpoDir: this.polpoDir, cwd: this.workDir });
      this.ownsSpawner = !opts.spawner;
    }
  }

  /** The open database (or the file backend), closed on shutdown. */
  private storage?: import("./storage.js").OpenStorage;
  /** Drizzle store bundle — populated when storage is "sqlite" or "postgres". */
  private drizzleStores?: import("@polpo-ai/drizzle").DrizzleStores;
  /** Raw Drizzle DB handle — used by file→sqlite migration after init. */
  private drizzleDb?: any;
  /** Sqlite-flavoured schema bundle, kept around so the migration can re-use it. */
  private drizzleSchema?: typeof import("@polpo-ai/drizzle")["sqliteSchema"];
  /** Effective storage backend selected at init time. Mirror of
   *  `config.settings.storage` after parseSettings has applied defaults —
   *  kept private because the source of truth is `config.settings.storage`. */
  private resolvedStorage: "file" | "sqlite" | "postgres" = "file";

  /**
   * Decorate task status changes with task:transition events.
   *
   * Watchers, SSE, notification rules, and CLI status output all depend on this
   * event. Keeping it at the store boundary prevents missed events when callers
   * use registry.transition(...) directly.
   */
  private withTaskTransitionEvents(store: TaskStore): TaskStore {
    const removedPayload = (taskId: string, task: Task | undefined) => ({
      taskId, ...(task ? { title: task.title, group: task.group, missionId: task.missionId } : {}),
    });
    const cached = this.eventingTaskStores.get(store);
    if (cached) return cached;

    const orchestrator = this;
    const wrapped = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "__emitsTaskTransitionEvents") return true;

        if (prop === "transition") {
          return async (taskId: string, newStatus: TaskStatus) => {
            const before = await target.getTask(taskId);
            const updated = await target.transition(taskId, newStatus);
            if (before && before.status !== updated.status) {
              orchestrator.emit("task:transition", {
                taskId,
                from: before.status,
                to: updated.status,
                task: updated,
              });
            }
            return updated;
          };
        }

        if (prop === "unsafeSetStatus") {
          return async (taskId: string, newStatus: TaskStatus, reason: string) => {
            const before = await target.getTask(taskId);
            const updated = await target.unsafeSetStatus(taskId, newStatus, reason);
            if (before && before.status !== updated.status) {
              orchestrator.emit("task:transition", {
                taskId,
                from: before.status,
                to: updated.status,
                task: updated,
                reason,
              });
            }
            return updated;
          };
        }

        // Field changes: one event per write, naming the fields (status goes through transition).
        if (prop === "updateTask") {
          return async (taskId: string, updates: Partial<Task>) => {
            const updated = await target.updateTask(taskId, updates);
            orchestrator.emit("task:updated", { taskId, task: updated, fields: Object.keys(updates) });
            return updated;
          };
        }

        if (prop === "removeTask") {
          return async (taskId: string) => {
            const before = await target.getTask(taskId);
            const removed = await target.removeTask(taskId);
            if (removed) orchestrator.emit("task:removed", removedPayload(taskId, before));
            return removed;
          };
        }

        if (prop === "removeTasks") {
          return async (filter: (task: Task) => boolean) => {
            const doomed = (await target.getAllTasks()).filter(filter);
            const count = await target.removeTasks(filter);
            if (count > 0) {
              const still = new Set((await target.getAllTasks()).map((t) => t.id));
              for (const task of doomed) if (!still.has(task.id)) orchestrator.emit("task:removed", removedPayload(task.id, task));
            }
            return count;
          };
        }

        if (prop === "saveMission" && target.saveMission) {
          return async (mission: Parameters<NonNullable<TaskStore["saveMission"]>>[0]) => {
            const saved = await target.saveMission!(mission);
            orchestrator.emit("mission:created", { missionId: saved.id, name: saved.name, status: saved.status });
            return saved;
          };
        }

        if (prop === "updateMission" && target.updateMission) {
          return async (missionId: string, updates: Parameters<NonNullable<TaskStore["updateMission"]>>[1]) => {
            const edit = (updates as Record<symbol, MissionEdit | undefined>)[MISSION_EDIT];
            const { [MISSION_EDIT]: _edit, ...plain } = updates as typeof updates & { [MISSION_EDIT]?: MissionEdit };
            const before = await target.getMission?.(missionId);
            const updated = await target.updateMission!(missionId, plain);
            const fields = Object.keys(plain).filter((k) => k !== "updatedAt");
            if (fields.length > 0) {
              orchestrator.emit("mission:updated", {
                missionId, name: updated.name, status: updated.status,
                ...(edit ? { section: edit.section, action: edit.action, ...(edit.item ? { item: edit.item } : {}) } : { fields }),
                ...(before && before.status !== updated.status ? { prevStatus: before.status } : {}),
              });
            }
            return updated;
          };
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as TaskStore;

    this.eventingTaskStores.set(store, wrapped);
    return wrapped;
  }

  /** Playbook writes announce themselves (playbook:changed), whoever makes them. */
  private withPlaybookEvents(store: PlaybookStore): PlaybookStore {
    const orchestrator = this;
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "save") {
          return async (definition: Parameters<PlaybookStore["save"]>[0]) => {
            const existed = !!(await target.get(definition.name).catch(() => null));
            const location = await target.save(definition);
            orchestrator.emit("playbook:changed", { name: definition.name, action: existed ? "updated" : "created" });
            return location;
          };
        }
        if (prop === "delete") {
          return async (name: string) => {
            const deleted = await target.delete(name);
            if (deleted) orchestrator.emit("playbook:changed", { name, action: "deleted" });
            return deleted;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Create task + run stores based on the configured storage backend. */
  private async createStores(storage?: "file" | "sqlite" | "postgres", databaseUrl?: string): Promise<{
    task: TaskStore; run: RunStore; taskControlStore: TaskControlStore;
    logStore?: LogStore; sessionStore?: SessionStore; memoryStore?: MemoryStore;
  }> {
    const { openStorage } = await import("./storage.js");
    const opened = await openStorage({
      storage,
      polpoDir: this.polpoDir,
      databaseUrl: databaseUrl ?? this.config?.settings?.databaseUrl,
      role: "server",
      log: (message) => this.emit("log", { level: "info", message: `[storage] ${message}` }),
    });
    this.storage = opened;
    if (opened.kind !== "file") {
      this.drizzleStores = opened.stores;
      this.resolvedStorage = opened.kind;
      if (opened.kind === "sqlite") {
        this.drizzleDb = opened.db;
        this.drizzleSchema = (await import("@polpo-ai/drizzle")).sqliteSchema;
      }
      return {
        task: opened.stores.taskStore,
        run: opened.stores.runStore,
        taskControlStore: opened.stores.taskControlStore,
        logStore: opened.stores.logStore,
        sessionStore: opened.stores.sessionStore,
        memoryStore: opened.stores.memoryStore,
      };
    }
    this.resolvedStorage = "file";
    return {
      task: new FileTaskStore(this.polpoDir),
      run: new FileRunStore(this.polpoDir),
      taskControlStore: new FileTaskControlStore(this.polpoDir),
    };
  }

  /**
   * Auto-migrate `.polpo/*.json` legacy files into the SQLite database the
   * first time a project boots after switching to `storage: "sqlite"`.
   *
   * Safe to call on every init — the migration short-circuits when the DB
   * already has data. Failures are logged but do not abort startup; the
   * legacy files remain on disk so the user can roll back manually.
   */
  private async maybeAutoMigrateToSqlite(): Promise<void> {
    if (this.resolvedStorage !== "sqlite") return;
    if (!this.drizzleDb || !this.drizzleSchema) return;
    // Only attempt the migration when legacy `tasks/` exists — a strong
    // signal that this project pre-dates the SQLite default.
    const tasksDir = join(this.polpoDir, "tasks");
    if (!existsSync(tasksDir)) return;
    try {
      const { migrateFileToSqlite } = await import("../migrations/file-to-sqlite.js");
      this.emit("log", { level: "info", message: "Detected legacy file store — migrating to SQLite (files preserved at .polpo/)." });
      const result = await migrateFileToSqlite(this.polpoDir, this.drizzleDb, this.drizzleSchema, {
        log: (msg) => this.emit("log", { level: "info", message: `[migrate] ${msg}` }),
      });
      if (!result.ok) {
        this.emit("log", { level: "warn", message: `[migrate] completed with errors — see logs above. Files at .polpo/ remain intact.` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `[migrate] auto-migration failed: ${msg}. Files at .polpo/ remain intact.` });
    }
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
      ? {
          task: this.injectedStore,
          run: this.injectedRunStore!,
          taskControlStore: this.injectedTaskControlStore ?? new FileTaskControlStore(this.polpoDir),
        }
      : await this.createStores(this.config.settings.storage, this.config.settings.databaseUrl);
    this.registry = this.withTaskTransitionEvents(stores.task);
    this.runStore = stores.run;
    this.taskControlStore = stores.taskControlStore;

    // NOTE: file→sqlite migration is MANUAL only (run `polpo migrate`
    // from the CLI). Auto-trigger at boot was removed by user request —
    // a fresh-install SQLite DB ships empty until the user explicitly
    // migrates, so legacy file-based projects keep using files until
    // the user runs the migration command.

    // When storage is "postgres", Drizzle provides all stores; otherwise use file-based defaults
    if ("logStore" in stores && stores.logStore) {
      this.logStore = stores.logStore;
      await this.logStore.startSession();
      this.setLogSink(this.logStore);
    } else {
      await this.initLogStore();
    }
    this.scheduleLogRetention();
    if ("sessionStore" in stores && stores.sessionStore) {
      this.sessionStore = stores.sessionStore;
    } else {
      await this.initSessionStore();
    }
    this.codingSessionStore = (this.drizzleStores?.codingSessionStore as CodingSessionStore | undefined)
      ?? new FileCodingSessionStore(this.polpoDir);
    this.memoryStore = ("memoryStore" in stores && stores.memoryStore)
      ? stores.memoryStore
      : new FileMemoryStore(this.polpoDir);

    // Team & Agent stores — Drizzle when available, otherwise file-based
    this.teamStore = this.drizzleStores?.teamStore ?? new FileTeamStore(this.polpoDir);
    this.agentStore = this.drizzleStores?.agentStore ?? new FileAgentStore(this.polpoDir);

    // Vault first: custom provider keys live there ("$providers"), and the key check below
    // must see them (otherwise vault-only custom providers are reported as missing).
    this.initVaultStore();
    await refreshCustomProviderSecretStatus();

    // Validate API keys (after stores are available so we can read per-agent models)
    await this.validateProviders();

    await this.initManagers();

    // Sync config.teams from stores (authoritative source — agents.json / teams.json)
    await this.agentMgr.syncConfigCache();

    this.playbookStore = this.withPlaybookEvents(this.drizzleStores?.playbookStore ?? new FilePlaybookStore(this.workDir, this.polpoDir));
  }

  /**
   * Populate stores from the teams array passed to initInteractive().
   *
   * First-run only: if the TeamStore already has ANY row, we skip seeding
   * entirely. This prevents the boot path from resurrecting teams/agents
   * that the user has explicitly deleted (e.g. `default` / `dev-1`).
   * The previous "idempotent per-name" behaviour was a footgun — once a
   * named team had been deleted, the next boot would re-create it because
   * `seed()` only checked existence by name.
   */
  private async populateStores(teams: Team[]): Promise<void> {
    if (!teams || teams.length === 0) return;

    // If the user has touched the stores at all (even leaving one team),
    // treat the project as initialised and DO NOT re-seed legacy defaults.
    const existingTeams = await this.teamStore.getTeams();
    if (existingTeams.length > 0) return;

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
      taskControlStore: this.taskControlStore,
      memoryStore: this.memoryStore,
      sandboxProviders: () => availableProviders(),
      storageMounts: (agentName, target) => this.storageMountProvider?.mountsFor(agentName, target) ?? Promise.resolve([]),
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

    this.startWebhookGateways();

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
      this.scheduler.setExecutor((missionId) => withEventOrigin({ source: "schedule" }, () => this.missionExec.executeMission(missionId)));
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

    if (supportsBackgroundWaits(this.taskControlStore)) {
      this.backgroundWaitMgr = new BackgroundWaitManager(this, this.registry, this.taskControlStore);
      await this.backgroundWaitMgr.start();
      if (this.backgroundWaitContinuation) {
        this.backgroundWaitMgr.setContinuation(this.backgroundWaitContinuation);
      }
    }

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
      ? {
          task: this.injectedStore,
          run: this.injectedRunStore!,
          taskControlStore: this.injectedTaskControlStore ?? new FileTaskControlStore(this.polpoDir),
        }
      : await this.createStores(storageBackend, dbUrl);
    this.registry = this.withTaskTransitionEvents(stores.task);
    this.runStore = stores.run;
    this.taskControlStore = stores.taskControlStore;

    await this.maybeAutoMigrateToSqlite();

    // Use Drizzle-provided stores when available, otherwise fall back to file-based
    if ("logStore" in stores && stores.logStore) {
      this.logStore = stores.logStore;
      await this.logStore.startSession();
      this.setLogSink(this.logStore);
    } else {
      await this.initLogStore();
    }
    this.scheduleLogRetention();
    if ("sessionStore" in stores && stores.sessionStore) {
      this.sessionStore = stores.sessionStore;
    } else {
      await this.initSessionStore();
    }
    this.codingSessionStore = (this.drizzleStores?.codingSessionStore as CodingSessionStore | undefined)
      ?? new FileCodingSessionStore(this.polpoDir);
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
      providers: polpoConfig?.providers
        ? parseProviders(polpoConfig.providers as Record<string, unknown>)
        : undefined,
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
    await refreshCustomProviderSecretStatus();
    this.playbookStore = this.withPlaybookEvents(this.drizzleStores?.playbookStore ?? new FilePlaybookStore(this.workDir, this.polpoDir));
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
      // Without a listener an FSWatcher error is an uncaught exception that kills the process.
      // Windows emits EPERM when the watched file or its folder is deleted or moved.
      this.configWatcher.on("error", (err) => {
        this.configWatcher?.close();
        this.configWatcher = undefined;
        this.emit("log", { level: "warn", message: `[watch] Stopped watching polpo.json: ${err.message}` });
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
  async sendDirection(
    taskId: string,
    message: string,
    opts?: { mode?: "auto" | "steer" | "follow_up" | "continue"; confirmSideEffects?: boolean },
  ) { return this.engine.sendDirection(taskId, message, opts); }
  async listDirections(taskId: string) { return this.engine.listDirections(taskId); }
  async createBackgroundWait(input: { taskId: string; sessionId: string; targetStatus?: string }) {
    if (!this.backgroundWaitMgr) throw new Error("Background waits are not initialized");
    return this.backgroundWaitMgr.create(input);
  }
  async listBackgroundWaits(sessionId?: string) {
    if (!this.backgroundWaitMgr) return [];
    return this.backgroundWaitMgr.list(sessionId);
  }
  async cancelBackgroundWait(id: string): Promise<boolean> {
    return (await this.backgroundWaitMgr?.cancel(id)) ?? false;
  }
  reassessTask(taskId: string): Promise<void> { return this.engine.reassessTask(taskId); }
  async killTask(taskId: string): Promise<boolean> { return this.engine.killTask(taskId); }
  async deleteTask(taskId: string): Promise<boolean> { return this.engine.deleteTask(taskId); }
  async abortGroup(group: string): Promise<number> { return this.engine.abortGroup(group); }
  async clearTasks(filter: (task: Task) => boolean): Promise<number> { return this.engine.clearTasks(filter); }
  async forceFailTask(taskId: string, reason?: string): Promise<void> { return this.engine.forceFailTask(taskId, reason); }

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
  getTaskControlStore(): TaskControlStore { return this.taskControlStore; }
  getPolpoDir(): string { return this.polpoDir; }
  getMemoryStore(): MemoryStore { return this.memoryStore; }
  getVaultStore(): VaultStore | undefined { return this.vaultStore; }
  getPlaybookStore(): PlaybookStore { return this.playbookStore; }
  getCodingSessionStore(): CodingSessionStore { return this.codingSessionStore; }
  getTeamStore(): TeamStore { return this.teamStore; }
  getAgentStore(): AgentStore { return this.agentStore; }
  /** Drizzle-backed AttachmentStore when storage is sqlite/postgres, undefined for file mode. */
  getAttachmentStore(): import("@polpo-ai/core/attachment-store").AttachmentStore | undefined {
    return this.drizzleStores?.attachmentStore;
  }

  /** Per-session chat prompt queue: database-backed with sqlite/postgres, `.polpo/chat-queue.json` otherwise. */
  getChatQueueStore(): import("@polpo-ai/core/session-store").ChatQueueStore {
    return this.drizzleStores?.chatQueueStore ?? (this.fileChatQueueStore ??= new FileChatQueueStore(this.polpoDir));
  }
  private fileChatQueueStore?: FileChatQueueStore;

  /** Rooms (group conversations of people and agents): database-backed with sqlite/postgres, `.polpo/rooms/` otherwise. */
  getRoomStore(): import("@polpo-ai/core/room-store").RoomStore {
    return this.drizzleStores?.roomStore ?? (this.fileRoomStore ??= new FileRoomStore(this.polpoDir));
  }
  private fileRoomStore?: FileRoomStore;

  /**
   * The group intent classifier (TypeSafe Jev), one for the instance: Telegram groups and web
   * rooms. It reads the room's persisted transcript.
   */
  getGroupIntent(): GroupIntentArbiter {
    if (this.groupIntent) return this.groupIntent;
    const roomStore = this.getRoomStore();
    this.groupIntent = new GroupIntentArbiter({
      apiKey: () => process.env.TYPESAFE_API_KEY || undefined,
      transcript: async (conversation) => {
        const messages = await roomStore.getRecentMessages(conversation, 30);
        const names = new Map(messages.map(m => [m.id, m.authorName]));
        return messages.map(m => ({
          id: m.id,
          name: m.authorName,
          text: m.text,
          at: Date.parse(m.ts),
          ...(m.authorKind === "agent" ? { agent: true } : {}),
          ...(m.replyToId && names.has(m.replyToId) ? { to: names.get(m.replyToId)! } : {}),
          ...(m.externalId ? { externalId: m.externalId } : {}),
        }));
      },
      log: (level, message) => this.emit("log", { level, message }),
    });
    return this.groupIntent;
  }
  private groupIntent?: GroupIntentArbiter;

  /** Group chats of people and agents on the web (rooms of kind "web"). */
  getRoomEngine(): RoomEngine {
    if (this.roomEngine) return this.roomEngine;
    this.roomEngine = new RoomEngine({
      rooms: this.getRoomStore(),
      sessions: this.sessionStore,
      runner: () => this.channelChatRunner,
      intent: this.getGroupIntent(),
      profile: async (name) => {
        if (name === POLPO) {
          return { id: POLPO, name: "Polpo", role: "the orchestrator: plans and coordinates the company's work, assigns tasks to the agents", responsibilities: [] };
        }
        const agent = (await this.getAgents()).find(a => a.name === name);
        const id = agent?.identity;
        const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
        return {
          id: name,
          name: id?.displayName ?? name,
          role: short(id?.title ?? agent?.role ?? "an agent of the company", 160),
          responsibilities: (id?.responsibilities ?? []).map(r => short(typeof r === "string" ? r : `${r.area}: ${r.description}`, 160)),
        };
      },
      emit: (event) => {
        if (event.type === "room:message") this.emit("room:message", { roomId: event.roomId, message: event.message });
        else this.emit("room:typing", { roomId: event.roomId, agent: event.agent, name: event.name, typing: event.typing });
      },
      log: (level, message) => this.emit("log", { level, message }),
    });
    return this.roomEngine;
  }
  private roomEngine?: RoomEngine;

  /**
   * Initialize the vault store: the `vault` table when the project runs on a database (each entry
   * encrypted with AES-256-GCM, same key as before; .polpo/vault.enc is imported once at startup
   * and kept as a backup), .polpo/vault.enc otherwise.
   * Key: POLPO_VAULT_KEY env var or auto-generated ~/.polpo/vault.key.
   */
  private initVaultStore(): void {
    try {
      this.vaultStore = this.drizzleStores?.vaultStore ?? new EncryptedVaultStore(this.polpoDir);
      // Custom provider keys / secret headers live in the vault (owner "$providers").
      const vault = this.vaultStore;
      setProviderSecretsSource({ get: (id) => readProviderSecrets(vault, id) });
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
  async addTeam(team: Team): Promise<void> {
    await this.engine.addTeam(team);
    await this.emitTeamSnapshot("team:created", { teamName: team.name });
  }
  async removeTeam(name: string): Promise<boolean> {
    const removed = await this.engine.removeTeam(name);
    if (removed) await this.emitTeamSnapshot("team:removed", { teamName: name });
    return removed;
  }
  async renameTeam(oldName: string, newName: string): Promise<void> {
    await this.engine.renameTeam(oldName, newName);
    await this.emitTeamSnapshot("team:updated", { oldName, teamName: newName });
  }
  async addAgent(agent: AgentConfig, teamName?: string): Promise<void> {
    await this.engine.addAgent(agent, teamName);
    await this.emitTeamSnapshot("agent:created", { agentName: agent.name, teamName });
    this.refreshDedicatedTelegramBots(agent.name);
  }
  async removeAgent(name: string): Promise<boolean> {
    const removed = await this.engine.removeAgent(name);
    if (removed) await this.emitTeamSnapshot("agent:removed", { agentName: name });
    return removed;
  }
  async updateAgent(name: string, updates: AgentUpdate): Promise<AgentConfig> {
    const agent = await this.engine.updateAgent(name, updates);
    await this.emitTeamSnapshot("agent:updated", { agentName: agent.name });
    this.refreshDedicatedTelegramBots(agent.name);
    return agent;
  }
  async findAgentTeam(name: string): Promise<Team | undefined> { return this.engine.findAgentTeam(name); }
  async addVolatileAgent(agent: AgentConfig, group: string): Promise<void> { return this.engine.addVolatileAgent(agent, group); }
  async cleanupVolatileAgents(group: string): Promise<number> { return this.engine.cleanupVolatileAgents(group); }

  private async emitTeamSnapshot<K extends "agent:created" | "agent:updated" | "agent:removed" | "team:created" | "team:updated" | "team:removed">(
    event: K,
    data: Omit<PolpoEventMap[K], "agents" | "teams" | "timestamp">,
  ): Promise<void> {
    this.emit(event, {
      ...data,
      agents: await this.getAgents(),
      teams: await this.getTeams(),
      timestamp: new Date().toISOString(),
    } as PolpoEventMap[K]);
  }


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

  /**
   * Removes orchestrator event logs older than settings.logRetentionDays (default 30, 0 keeps
   * them): a minute after start, then daily. Agent run transcripts are kept: they back the task
   * activity view and the task token totals.
   */
  private scheduleLogRetention(delayMs = 60_000): void {
    if (this.logRetentionTimer) clearTimeout(this.logRetentionTimer);
    this.logRetentionTimer = setTimeout(() => {
      void this.pruneOldLogs().finally(() => {
        if (!this.stopped) this.scheduleLogRetention(DAY_MS);
      });
    }, delayMs);
    this.logRetentionTimer.unref?.();
  }

  /** Remove the event logs older than the retention period now. */
  async pruneOldLogs(): Promise<LogPruneResult | undefined> {
    const days = this.config?.settings?.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    if (!(days > 0) || !this.logStore?.pruneBefore) return undefined;
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    try {
      const result = await this.logStore.pruneBefore(cutoff);
      if (result.entries > 0 || result.sessions > 0) {
        this.emit("log", { level: "info", message: `[logs] Removed ${result.entries} log entries and ${result.sessions} log session(s) older than ${days} days.` });
      }
      return result;
    } catch (err) {
      this.emit("log", { level: "warn", message: `[logs] Log cleanup failed: ${err instanceof Error ? err.message : String(err)}` });
      return undefined;
    }
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
    this.backgroundWaitMgr?.dispose();
    this.engine?.stop();
  }

  /**
   * Graceful shutdown: SIGTERM all runner subprocesses, wait for them to write results,
   * preserve completed work, leave in-progress tasks for recovery on restart.
   */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    await this.hookRegistry.runBefore("orchestrator:shutdown", {});
    this.stopped = true;
    this.backgroundWaitMgr?.dispose();
    for (const key of [...this.chatWorkspaces.keys()]) await this.closeChatWorkspace(key, "shutdown");
    const activeRuns = await this.runStore.getActiveRuns();
    this.emit("orchestrator:stopping", { activeRuns: activeRuns.length });

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
    if (this.logRetentionTimer) clearTimeout(this.logRetentionTimer);
    this.configWatcher?.close();
    this.telegramPoller?.stop();
    this.stopDedicatedTelegramPollers();
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
    this.backgroundWaitMgr?.dispose();
    await this.registry.close?.();
    await this.runStore.close();
    this.emit("orchestrator:shutdown", {});
    await this.hookRegistry.runAfter("orchestrator:shutdown", {});
    // Nothing may write to the log store once its database is closing.
    this.setLogSink(undefined);
    await this.logStore?.close();
    await this.sessionStore?.close();
    await this.storage?.close().catch(() => {});
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
    this.stopDedicatedTelegramPollers();
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
    // Providers: parse like at boot and always replace — removed providers must disappear
    // from the runtime registry too.
    const parsedProviders = polpoConfig.providers
      ? parseProviders(polpoConfig.providers as Record<string, unknown>)
      : {};
    this.config.providers = Object.keys(parsedProviders).length > 0 ? parsedProviders : undefined;
    setProviderOverrides(parsedProviders);
    await refreshCustomProviderSecretStatus();
    // Allowlist: an allowlist removed from polpo.json must stop being enforced.
    setModelAllowlist(newSettings.modelAllowlist && Object.keys(newSettings.modelAllowlist).length > 0
      ? newSettings.modelAllowlist
      : undefined);

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

      // Reconnect rule actions (create_task, execute_mission, run_script, send_notification)
      this.notificationRouter.setActionExecutor(this.buildActionExecutor(ctx));
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

    this.startWebhookGateways();

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
        this.scheduler.setExecutor((missionId) => withEventOrigin({ source: "schedule" }, () => this.missionExec.executeMission(missionId)));
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

    // Stop any existing pollers to prevent duplicate polling
    if (this.telegramPoller) {
      this.telegramPoller.stop();
      this.telegramPoller = undefined;
    }
    this.stopDedicatedTelegramPollers();
    this.channelGateways.clear();
    this.telegramPollersByChannel.clear();
    this.dedicatedTelegramBots.clear();
    this.telegramBotUsernames.clear();

    const channels = this.config.settings.notifications?.channels ?? {};
    const telegramKeys = Object.keys(channels).filter(k => channels[k]?.type === "telegram");
    if (telegramKeys.length === 0) return;

    // The primary bot talks to the orchestrator (and to agents via /agent); it keeps
    // the approval chat. Extra bots with gateway.agent are dedicated to one agent.
    const primaryKey = telegramKeys.find(k => !channels[k]?.gateway?.agent) ?? telegramKeys[0];
    const ordered = [primaryKey, ...telegramKeys.filter(k => k !== primaryKey)];

    const resolver = this.createApprovalResolver();

    // groupReplies "intent": one arbiter for all the bots, so a group message is classified once
    const roomStore = this.getRoomStore();
    const intent = this.getGroupIntent();
    // agents answering each other in groups: every bot of the instance, through one relay
    const relay = new TelegramAgentRelay({
      rooms: roomStore,
      intent,
      log: (level, message) => this.emit("log", { level, message }),
      bots: () => [...this.channelGateways.entries()].flatMap(([key, gateway]) => {
        const poller = this.telegramPollersByChannel.get(key);
        if (!poller) return [];
        const bot: RelayBot = {
          key,
          isIn: (c) => gateway.isIn(c),
          mode: (c) => gateway.relayMode(c),
          threshold: () => gateway.relayThreshold(),
          profile: async (c) => {
            const me = await poller.getIdentity().catch(() => undefined);
            return { ...await gateway.relayProfile(c), aliases: me?.username ? [me.username] : [] };
          },
          answer: (c, m) => gateway.answerAgent(c, m),
          post: async (c, text) => {
            const m = /^[^:]+:group:([^:]+)(?::topic:(\d+))?$/.exec(c);
            if (m) await poller.sendPartial(m[1]!, text, m[2] ? { threadId: Number(m[2]) } : undefined);
          },
        };
        return [bot];
      }),
    });

    const usedTokens = new Set<string>();
    for (const key of ordered) {
      const ch = this.notificationRouter!.getChannel(key);
      if (!ch || ch.type !== "telegram") continue;
      const telegramChannel = ch as import("../notifications/channels/telegram.js").TelegramChannel;
      const botToken = telegramChannel.getBotToken();

      // Two pollers on one token steal each other's updates (Telegram 409).
      if (usedTokens.has(botToken)) {
        this.emit("log", { level: "warn", message: `[telegram] Channel "${key}" reuses another channel's bot token — skipped` });
        continue;
      }
      usedTokens.add(botToken);

      const isPrimary = key === primaryKey;
      const poller = new TelegramCallbackPoller(botToken, telegramChannel.getChatId());
      if (resolver) poller.setResolver(resolver);

      const channelConfig = channels[key];
      if (channelConfig?.gateway?.enableInbound) {
        this.peerStore = this.peerStore ?? this.drizzleStores?.peerStore ?? new FilePeerStore(this.polpoDir);

        const gateway = new ChannelGateway({
          orchestrator: this,
          peerStore: this.peerStore!,
          sessionStore: this.sessionStore,
          channelConfig,
          approvalResolver: resolver,
          onTyping: (chatId, target) => poller.sendTyping(chatId, target),
          key,
          roomStore,
        });
        gateway.setIntentArbiter(intent);
        gateway.setAgentRelay(relay);
        gateway.setPartialResponseHandler((chatId, text, target) => poller.sendPartial(chatId, text, target));
        gateway.setReplyRouter((target, event) => this.routeChannelReply(target, event));
        poller.setGateway(new TelegramGatewayAdapter(gateway));
        // The main bot's menu is static; dedicated bots get theirs (agent suggestions) once agents are loaded.
        if (!channelConfig.gateway.agent) {
          void Promise.all([gateway.menuCommands(), gateway.groupMenuCommands()])
            .then(([commands, groupCommands]) => poller.setMenuCommands(commands, groupCommands)).catch(() => {});
        }
        void poller.getIdentity().then(me => {
          if (me && me.canReadAllGroupMessages === false) {
            this.emit("log", { level: "info", message: `[telegram] "${key}" (@${me.username}) has privacy mode on: in groups it only sees commands and replies to its messages. Turn it off in BotFather (/setprivacy) for mentions and group context.` });
          }
        });
        this.channelGateways.set(key, gateway);
        if (isPrimary) this.channelGateway = gateway;

        const target = channelConfig.gateway.agent ? `agent: ${channelConfig.gateway.agent}` : "orchestrator";
        this.emit("log", {
          level: "info",
          message: `Telegram channel gateway "${key}" started (dmPolicy: ${channelConfig.gateway.dmPolicy ?? "allowlist"}, ${target})`,
        });
      }

      poller.start(2000); // Poll every 2 seconds
      this.telegramPollersByChannel.set(key, poller);
      void fetch(`https://api.telegram.org/bot${botToken}/getMe`)
        .then(r => r.json() as Promise<{ ok?: boolean; result?: { username?: string } }>)
        .then(me => { if (me.ok && me.result?.username) this.telegramBotUsernames.set(key, me.result.username); })
        .catch(() => {});
      if (isPrimary) this.telegramPoller = poller;
      else this.dedicatedTelegramPollers.push(poller);

      const dedicatedAgent = channelConfig?.gateway?.enableInbound ? channelConfig.gateway.agent : undefined;
      const gateway = this.channelGateways.get(key);
      if (dedicatedAgent && gateway) {
        this.dedicatedTelegramBots.set(key, { agent: dedicatedAgent, botToken, poller, gateway });
        this.scheduleDedicatedBotRefresh(key);
      }
    }

    this.emit("log", { level: "info", message: `Telegram callback poller started (${usedTokens.size} bot${usedTokens.size === 1 ? "" : "s"})` });
  }

  /** Approve/reject through the approval manager, for channel commands and buttons. */
  private createApprovalResolver(): ApprovalCallbackResolver | undefined {
    const approvalMgr = this.approvalMgr;
    return approvalMgr ? {
      approve: async (requestId, resolvedBy) => {
        const result = await approvalMgr.approve(requestId, resolvedBy);
        return result ? { ok: true } : { ok: false, error: "Not found or already resolved" };
      },
      reject: async (requestId, feedback, resolvedBy) => {
        const result = await approvalMgr.reject(requestId, feedback, resolvedBy);
        return result ? { ok: true } : { ok: false, error: "Not found, already resolved, or max rejections reached" };
      },
    } : undefined;
  }

  /** Re-register menus and re-sync profiles of the bots dedicated to `agentName`. */
  private refreshDedicatedTelegramBots(agentName: string): void {
    for (const [key, bot] of this.dedicatedTelegramBots) {
      if (bot.agent === agentName) void this.refreshDedicatedBot(key);
    }
  }

  /**
   * Telegram pollers start during init, possibly before agents are loaded:
   * retry until the dedicated agent is visible (0s, 5s, 15s, 30s, 60s).
   */
  private scheduleDedicatedBotRefresh(key: string, delays = [0, 5_000, 15_000, 30_000, 60_000]): void {
    const [delay, ...rest] = delays;
    setTimeout(() => {
      void this.refreshDedicatedBot(key).then(done => {
        if (done || !this.dedicatedTelegramBots.has(key)) return;
        if (rest.length > 0) this.scheduleDedicatedBotRefresh(key, rest);
        else console.error(`[polpo/telegram] "${key}": agent "${this.dedicatedTelegramBots.get(key)?.agent}" not found — menu and profile not synced`);
      });
    }, delay).unref?.();
  }

  /** Menu (agent suggestions) + profile of one dedicated bot. Returns false if the agent is not loaded yet. */
  private async refreshDedicatedBot(key: string): Promise<boolean> {
    const bot = this.dedicatedTelegramBots.get(key);
    if (!bot) return true;
    // The engine exists once the stores are open: until then, retry later (not an error).
    if (!this.engine) return false;
    try {
      const agents = await this.getAgents();
      if (!agents.some(a => a.name === bot.agent)) return false;
      bot.poller.setMenuCommands(await bot.gateway.menuCommands(), await bot.gateway.groupMenuCommands());
      await this.syncDedicatedBotProfile(key);
      return true;
    } catch (err) {
      console.error(`[polpo/telegram] "${key}" refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Mirror the agent's avatar and bio onto its dedicated bot (photo only re-uploaded when changed). */
  private async syncDedicatedBotProfile(key: string): Promise<void> {
    const bot = this.dedicatedTelegramBots.get(key);
    if (!bot) return;
    try {
      const agent = (await this.getAgents()).find(a => a.name === bot.agent);
      if (!agent) return;
      const result = await syncTelegramBotProfile({
        botToken: bot.botToken,
        agent,
        roots: [this.workDir, this.getAgentWorkDir()],
        statePath: join(this.polpoDir, "telegram-bot-profiles.json"),
      });
      const level = result.error ? "warn" : "info";
      const message = `[telegram] "${key}" profile for ${bot.agent}: photo ${result.photo}, description ${result.description}${result.error ? ` (${result.error})` : ""}`;
      console.error(`[polpo/telegram] ${message.slice("[telegram] ".length)}`);
      this.emit("log", { level, message });
    } catch (err) {
      this.emit("log", { level: "warn", message: `[telegram] "${key}" profile sync failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private stopDedicatedTelegramPollers(): void {
    for (const poller of this.dedicatedTelegramPollers) poller.stop();
    this.dedicatedTelegramPollers = [];
  }

  // ── Conversation pipe ──

  /**
   * Deliver a chat turn through another channel (gateway.replyTo). Telegram gets the
   * whole conversation (echo, partials, reply with buttons and files); other channels
   * get the final reply as a notification.
   */
  private async routeChannelReply(target: ChannelReplyTarget, event: ReplyRouteEvent): Promise<void> {
    const config = this.config.settings.notifications?.channels?.[target.channel];
    if (!config) throw new Error(`Unknown channel "${target.channel}"`);

    if (config.type === "telegram") {
      const poller = this.telegramPollersByChannel.get(target.channel);
      if (!poller) throw new Error(`Telegram channel "${target.channel}" is not running`);
      const chatId = target.chatId || config.chatId || await this.onlyPairedTelegramChat();
      if (!chatId) throw new Error(`No chat for "${target.channel}": set replyTo.chatId or the channel's chat ID`);
      if (event.kind === "echo") {
        await poller.sendMarkdown(chatId, `_↪ ${event.from} · ${event.via}_\n${event.text}`);
      } else if (event.kind === "partial") {
        await poller.sendPartial(chatId, event.text);
      } else {
        const { reply } = event;
        if (reply.text.trim() || reply.buttons || reply.forceReply) {
          await poller.sendMarkdown(chatId, reply.text, reply.buttons, reply.forceReply);
        }
        for (const file of reply.files ?? []) await poller.sendDocument(chatId, file.path, file.filename);
      }
      return;
    }

    if (event.kind !== "reply") return;
    const channel = this.notificationRouter?.getChannel(target.channel);
    if (!channel) throw new Error(`Channel "${target.channel}" is not running`);
    const notification = {
      id: nanoid(),
      channel: target.channel,
      title: "Polpo reply",
      body: event.reply.text,
      severity: "info" as const,
      sourceEvent: "channel:reply",
      sourceData: { chatId: target.chatId },
      ruleId: "conversation-pipe",
      timestamp: new Date().toISOString(),
    };
    const files = event.reply.files ?? [];
    if (files.length > 0 && channel.sendWithAttachments) {
      const { readFile } = await import("node:fs/promises");
      const attachments = await Promise.all(files.map(async (f) => {
        const content = await readFile(f.path);
        return { label: f.filename, type: "file" as const, filePath: f.path, size: content.length, content };
      }));
      await channel.sendWithAttachments(notification, attachments);
    } else {
      await channel.send(notification);
    }
  }

  /** Private chat of the only person allowed on Telegram (chat id = user id), if exactly one. */
  private async onlyPairedTelegramChat(): Promise<string | undefined> {
    const allowed = (await this.peerStore?.getAllowlist() ?? []).filter(id => id.startsWith("telegram:"));
    return allowed.length === 1 ? allowed[0].slice("telegram:".length) : undefined;
  }

  // ── Inbound webhooks ──

  /**
   * One gateway per webhook channel with gateway.enableInbound. The shared secret
   * authenticates callers, so the DM policy defaults to "open" (still overridable).
   */
  private startWebhookGateways(): void {
    this.webhookGateways.clear();
    const channels = this.config.settings.notifications?.channels ?? {};
    for (const [key, channelConfig] of Object.entries(channels)) {
      if (channelConfig?.type !== "webhook" || !channelConfig.gateway?.enableInbound) continue;
      this.peerStore = this.peerStore ?? this.drizzleStores?.peerStore ?? new FilePeerStore(this.polpoDir);
      const gateway = new ChannelGateway({
        orchestrator: this,
        peerStore: this.peerStore!,
        sessionStore: this.sessionStore,
        channelConfig: { ...channelConfig, gateway: { dmPolicy: "open", ...channelConfig.gateway } },
        approvalResolver: this.createApprovalResolver(),
      });
      gateway.setReplyRouter((target, event) => this.routeChannelReply(target, event));
      this.webhookGateways.set(key, { gateway, adapter: new WebhookGatewayAdapter(gateway) });
      const target = channelConfig.gateway.agent ? `agent: ${channelConfig.gateway.agent}` : "orchestrator";
      this.emit("log", { level: "info", message: `Webhook channel gateway "${key}" ready (${target})` });
    }
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

    // WhatsApp history: the project's database, or .polpo/whatsapp.db on files.
    if (!this.whatsappStore) {
      if (this.drizzleStores) {
        this.whatsappStore = this.drizzleStores.whatsappStore;
      } else {
        const dbPath = join(this.polpoDir, "whatsapp.db");
        this.whatsappStore = new WhatsAppStore(dbPath);
        this.emit("log", { level: "info", message: `WhatsApp store opened: ${dbPath}` });
      }
    }

    // Create the bridge
    const bridge = new WhatsAppBridge(waChannel, (level, msg) => {
      this.emit("log", { level: level === "verbose" ? "debug" : level as "info" | "warn", message: msg });
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
      this.channelGateway.setReplyRouter((target, event) => this.routeChannelReply(target, event));

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
