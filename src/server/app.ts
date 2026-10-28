import { readFile, unlink } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { interpretChannelCompletion } from "./channel-chat-result.js";
import { getPolpoDir } from "../core/constants.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { streamSimpleWithAuth, completeSimpleWithAuth, resolveSummaryModel } from "../llm/pi-client.js";
import { buildSystemPrompt, sandboxPromptNote } from "../adapters/engine.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SSEBridge } from "./sse-bridge.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorMiddleware } from "./middleware/error.js";
import { instanceAuthMiddleware } from "./middleware/instance-auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { AUTH_COOKIE_NAME, isInstanceAuthEnabled, validateSession } from "./auth/instance-auth.js";
// Shared routes from @polpo-ai/server (edge-compatible, single source of truth)
import {
  healthRoutes,
  taskRoutes,
  missionRoutes,
  chatRoutes,
  notificationRoutes,
  approvalRoutes,
  playbookRoutes,
  stateRoutes,
  completionRoutes,
  peerRoutes,
  scheduleRoutes,
  watcherRoutes,
  vaultRoutes,
  agentRoutes,
  eventRoutes,
  configRoutes,
  attachmentRoutes,
  countsRoutes,
  streamRegistry,
  createTurnScheduler,
  sessionLeases,
  internalCallHeaders,
  trustedApiCallHeaders,
  isTrustedApiCall,
  TRUSTED_API_CALL_HEADER,
  CHAT_ORIGIN_HEADER,
} from "@polpo-ai/server";
import { getCookie } from "hono/cookie";
import { createHmac } from "node:crypto";
import { handleMcpRequest } from "./mcp.js";
import { authorizationServerMetadata, consentPage, OAuthError, OAuthServer, protectedResourceMetadata } from "./oauth.js";
import { hasValidApiKey } from "./middleware/instance-auth.js";
import { reactionHint } from "../notifications/telegram-reactions.js";
// Node.js-only routes (stay in src/server/routes/)
import { brandingConfigRoutes, publicConfigRoutes } from "./routes/config.js";
import { filesystemRoutes } from "./routes/filesystem.js";
import { providerRoutes } from "./routes/providers.js";
import { customProviderRoutes } from "./routes/custom-providers.js";
import { skillRoutes } from "./routes/skills.js";
import { authRoutes } from "./routes/auth.js";
import { instanceAuthRoutes } from "./routes/instance-auth.js";
import { webhookInboundRoutes } from "./routes/webhook-inbound.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { audioRoutes } from "./routes/audio.js";
import { mobileDiagnosticsRoutes } from "./routes/mobile-diagnostics.js";
import { pushRoutes } from "./routes/push.js";
import { expoPushRoutes } from "./routes/expo-push.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { emailRoutes } from "./routes/email.js";
import { codingRoutes } from "./routes/coding.js";
import { roomRoutes } from "./routes/rooms.js";
import { learningRoutes } from "./routes/learning.js";
import { driveRoutes } from "./routes/drive.js";
import { syncRoutes } from "./routes/sync.js";
import { browserDashboardRoutes } from "./routes/browser-dashboard.js";
import { appPreviewRoutes } from "./routes/app-preview.js";
import { backgroundWaitRoutes } from "./routes/background-waits.js";
import { tokenUsageRoutes } from "./routes/token-usage.js";
import { appsRoutes } from "./routes/apps.js";
import { dataRoutes } from "./routes/data.js";
import { dataViewRoutes } from "./routes/data-views.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { getArtifactStore } from "./artifact-runtime.js";
import { storageRoutes } from "./routes/storage.js";
import { getStorageRuntime } from "../storage/runtime.js";
import { companyBrainRoutes } from "./routes/company-brain.js";
import { FileAttachmentStore } from "../stores/file-attachment-store.js";
import { saveChatUserMessage, resolveChatAttachmentReferences } from "./chat-attachments.js";
import { FileTokenUsageStore } from "../stores/file-token-usage-store.js";
import { databaseStoresFor } from "../core/storage.js";
import { FileContextCheckpointStore } from "../stores/file-context-checkpoint-store.js";
import { getAppRegistryRuntime } from "./app-runtime-manager.js";
import { getDataRegistryRuntime } from "./data-runtime.js";
import { getCompanyBrainRuntime } from "./company-brain-runtime.js";
import { isTerminalEnabled, type TerminalWebSocketHandle } from "./terminal.js";
import type { CodeServerManager } from "./code-server.js";
import type { SyncScheduler } from "./sync-scheduler.js";
import { withEventOrigin, currentEventOrigin } from "../core/events.js";
import { POLPO_PACKAGE_VERSION } from "../core/version.js";

export interface AppOptions {
  apiKeys?: string[];
  corsOrigins?: string[];
  workDir?: string;
  onInitialize?: (workDir: string) => Promise<void>;
  wakeSupervisor?: () => void;
  codeServerManager?: CodeServerManager;
  /** Closure rather than a direct ref because the terminal websocket is
   * attached *after* the Hono app is constructed (it needs the bound
   * server). The "Processes" panel uses this to enumerate live ptys. */
  getTerminalHandle?: () => TerminalWebSocketHandle | null | undefined;
  /** Hands the long-lived scheduler to /sync routes so flipping the
   * enabled toggle re-arms the cron without a server restart. */
  syncScheduler?: SyncScheduler;
}

/**
 * Create the Hono app with all routes and middleware.
 * Single-orchestrator architecture — no project concept.
 *
 * Route factories receive explicit dependency thunks instead of pulling
 * from Hono context.  This lets the cloud data-plane wire stores directly
 * without needing the full Orchestrator class.
 */
export function createApp(orchestrator: Orchestrator, sseBridge: SSEBridge, opts?: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono();
  const activeWorkDir = () => orchestrator.isInitialized ? orchestrator.getWorkDir() : opts?.workDir;
  const activePolpoDir = () => getPolpoDir(activeWorkDir() ?? opts?.workDir ?? process.cwd());
  const activeAppRegistry = () => getAppRegistryRuntime(activePolpoDir(), (event) => orchestrator.emit("app:changed", event));
  const activeDataRegistry = () => getDataRegistryRuntime(activePolpoDir(), orchestrator?.getVaultStore?.(), (event) => {
    if (event.type === "source") {
      const { type: _type, ...payload } = event;
      orchestrator.emit("data-source:changed", payload);
    } else {
      const { type: _type, ...payload } = event;
      orchestrator.emit("data-view:changed", payload);
    }
  });
  const activeStorage = () => getStorageRuntime(activePolpoDir(), orchestrator?.getVaultStore?.(), (payload) => {
    orchestrator.emit("storage:changed", payload);
  });
  const activeCompanyBrain = () => getCompanyBrainRuntime(activePolpoDir(), activeDataRegistry(), (event) => {
    orchestrator.emit("brain:changed", event);
  });

  // Global middleware
  app.use("*", errorMiddleware());

  // CORS before the rate limit: a 429 without CORS headers reaches a page on another origin as a
  // bare "Failed to fetch", and its Retry-After cannot be read.
  const corsExposeHeaders = ["x-session-id", "x-user-message-id", "x-turn-id", "retry-after"];
  if (opts?.corsOrigins && opts.corsOrigins.length > 0) {
    app.use("*", cors({ origin: opts.corsOrigins, exposeHeaders: corsExposeHeaders, credentials: true }));
  } else {
    // Default: restrict to localhost origins only
    app.use("*", cors({
      origin: [
        "http://localhost:3000", "http://localhost:3001",
        "http://localhost:3890", "http://localhost:3891",
        "http://localhost:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "http://127.0.0.1:3890", "http://127.0.0.1:3891",
        "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175", "http://127.0.0.1:5176",
      ],
      exposeHeaders: corsExposeHeaders,
      credentials: true,
    }));
  }

  // Rate limit API routes only (not static assets)
  app.use("/api/*", rateLimitMiddleware());
  app.use("/v1/*", rateLimitMiddleware());

  // ── Public routes (no auth) ───────────────────────────────────────────

  app.route("/api/v1/health", healthRoutes({ version: POLPO_PACKAGE_VERSION }));

  // Inbound webhook channels authenticate with their own secret (e.g. iOS Shortcuts).
  app.route("/api/v1/channels", webhookInboundRoutes({
    isInitialized: () => !!orchestrator?.isInitialized,
    getChannelConfig: (name) => orchestrator?.getConfig()?.settings?.notifications?.channels?.[name],
    getAdapter: (name) => orchestrator?.getWebhookGateway(name),
  }));

  // Config status + initialize — always available so setup wizard works
  if (opts?.workDir) {
    app.route("/api/v1/config", publicConfigRoutes(orchestrator, opts.workDir, opts.onInitialize));
    // NB: mounted at /auth/instance to avoid path collision with the
    // provider-auth-status routes (/api/v1/auth/status) that live behind
    // the auth gate. Instance-auth deals with this Polpo *instance*'s
    // session/login; provider-auth-status deals with LLM provider keys.
    app.route("/api/v1/auth/instance", instanceAuthRoutes(activePolpoDir));
  }

  // Filesystem browsing — always available (used by setup wizard path picker)
  if (opts?.workDir) {
    const setupAwareInstanceAuth = instanceAuthMiddleware(activePolpoDir, opts.apiKeys ?? []);
    app.use("/api/v1/filesystem", async (c, next) => {
      if (!orchestrator.isInitialized) return next();
      return setupAwareInstanceAuth(c, next);
    });
    app.use("/api/v1/filesystem/*", async (c, next) => {
      if (!orchestrator.isInitialized) return next();
      return setupAwareInstanceAuth(c, next);
    });
    app.use("/api/v1/providers", async (c, next) => {
      if (!orchestrator.isInitialized) return next();
      return setupAwareInstanceAuth(c, next);
    });
    app.use("/api/v1/providers/*", async (c, next) => {
      if (!orchestrator.isInitialized) return next();
      return setupAwareInstanceAuth(c, next);
    });
  }

  // Filesystem browsing — always available during setup (used by path picker)
  app.route("/api/v1/filesystem", filesystemRoutes());

  // Custom providers / AI gateways (CRUD, test, discovery). Mounted before the generic
  // provider routes so "/custom/*" never matches "/:name/*". Requires an initialized
  // instance, so it is always behind the instance auth gate above.
  if (opts?.workDir) {
    app.route("/api/v1/providers/custom", customProviderRoutes(() => ({
      isInitialized: () => !!orchestrator?.isInitialized,
      getPolpoDir: () => orchestrator.getPolpoDir(),
      getVaultStore: () => orchestrator.getVaultStore(),
      applyProviders: async () => {
        const { loadPolpoConfig, parseProviders } = await import("../core/config.js");
        const { setProviderOverrides } = await import("../llm/pi-client.js");
        const { refreshCustomProviderSecretStatus } = await import("../llm/custom-providers.js");
        const raw = loadPolpoConfig(orchestrator.getPolpoDir());
        const parsed = raw?.providers ? parseProviders(raw.providers as Record<string, unknown>) : {};
        const config = orchestrator.getConfig();
        if (config) config.providers = Object.keys(parsed).length > 0 ? parsed : undefined;
        setProviderOverrides(parsed);
        await refreshCustomProviderSecretStatus();
      },
      getModelUsage: async () => {
        const specs: string[] = [];
        const settings = orchestrator.getConfig()?.settings;
        const om = settings?.orchestratorModel;
        if (typeof om === "string") specs.push(om);
        else if (om) specs.push(...[om.primary, ...(om.fallbacks ?? [])].filter((x): x is string => !!x));
        if (settings?.imageModel) specs.push(settings.imageModel);
        for (const agent of await orchestrator.getAgents()) if (agent.model) specs.push(agent.model);
        return specs;
      },
    })));
  }

  // Provider management — always available (API key CRUD, OAuth flows, model listing)
  if (opts?.workDir) {
    app.route("/api/v1/providers", providerRoutes(activePolpoDir));
  }

  // OpenAI-compatible chat completions
  if (opts?.workDir) {
    app.use("/v1/*", instanceAuthMiddleware(getPolpoDir(opts.workDir), opts.apiKeys ?? []));
  }
  // Server-side turns: queued prompts, steers that missed their turn, a branch's answer.
  const CHAT_ATTACHMENT_PATH = /^workspace\/attachments\/[\w-]+\/[^/\\]+$/;
  const turnScheduler = createTurnScheduler({
    getSessionStore: () => o.getSessionStore(),
    getAttachmentStore: () => o.getAttachmentStore() ?? new FileAttachmentStore(o.getPolpoDir()),
    getQueueStore: () => o.getChatQueueStore(),
    readAttachment: (path) => {
      // Only chat attachments, never anything else under the project.
      if (!CHAT_ATTACHMENT_PATH.test(path)) return Promise.reject(new Error("Not a chat attachment"));
      return readFile(joinPath(o.getWorkDir(), path));
    },
    emit: (event, data) => o.emit(event as any, data as any),
    request: (req) => completionApp.request(req),
    apiKey: opts?.apiKeys?.[0],
  });
  // After a restart, queues that were waiting to auto-send get their chance.
  if (orchestrator) {
    const resumeTimer = setTimeout(() => {
      if (orchestrator.isInitialized) void turnScheduler.resumePending().catch(() => undefined);
    }, 3000);
    resumeTimer.unref?.();
  }
  const completionApp = completionRoutes(() => ({
    turnScheduler,
    contextCheckpoints: o.getContextCheckpointStore(),
    resolveAttachmentReferences: (text) => resolveChatAttachmentReferences(text, o.getWorkDir()),
    saveUserMessage: (sessionId, content) => saveChatUserMessage(o.getSessionStore()!,
      o.getAttachmentStore() ?? new FileAttachmentStore(o.getPolpoDir()), o.getWorkDir(), sessionId, content),
    getAgents: () => o.getAgents(),
    getConfig: () => o.getConfig(),
    getMemoryStore: () => o.getMemoryStore(),
    getSessionStore: () => o.getSessionStore(),
    getStore: () => o.getStore(),
    emit: (event: string, data: any) => o.emit(event as any, data),
    recordTokenUsage: async (usage) => {
      await (databaseStoresFor(activePolpoDir())?.tokenUsageStore ?? new FileTokenUsageStore(activePolpoDir())).record(usage);
      o.emit("token-usage:recorded", { timestamp: new Date().toISOString() });
    },
    resolveAgentModel: async (agentConfig: any, reasoning?: string) => {
      const { resolveModel, buildStreamOpts } = await import("../llm/pi-client.js");
      const m = resolveModel(agentConfig.model);
      const r = agentConfig.reasoning ?? reasoning;
      return { model: m, streamOpts: buildStreamOpts(undefined, r, m.maxTokens) };
    },
    agentChatContext: async (agentConfig: any) => {
      const drive = o.getDriveManager();
      if (!agentConfig.drive?.enabled || !drive) return undefined;
      const { drivePrompt } = await import("../core/drive.js");
      return drivePrompt(agentConfig, drive.getSelf(agentConfig.name), await drive.intentions(agentConfig.name), drive.listPlan(agentConfig.name));
    },
    buildAgentPrompt: async (agentConfig: any) => {
      // Pull the agent's mailboxes from vault so the prompt enumerates
      // them (drives the `account` selector in email_* tools). Failures
      // here degrade gracefully: prompt is rendered without the section.
      let mailboxes: any[] | undefined;
      try {
        const { resolveAgentVault, loadAgentVaultEntries } = await import("../vault/index.js");
        const entries = await loadAgentVaultEntries(o.getVaultStore(), agentConfig.name);
        mailboxes = resolveAgentVault(entries).listMailboxes();
      } catch { /* ignore — keep prompt without mailboxes section */ }
      const { sandbox, volumes } = await o.chatSandbox(agentConfig).catch(() => ({ sandbox: undefined, volumes: [] }));
      const remote = sandbox?.provider === "daytona" || sandbox?.provider === "e2b";
      return buildSystemPrompt(agentConfig, o.getAgentWorkDir(), o.getPolpoDir(), undefined, undefined, mailboxes)
        + sandboxPromptNote(sandbox, remote ? volumes.filter((v) => v.remote) : volumes.filter((v) => v.hostPath),
          remote ? { outputDir: o.chatOutputDir(agentConfig.name) } : {});
    },
    resolveAgentTools: async (agentConfig: any, context?: { sessionId: () => string | undefined; origin?: import("@polpo-ai/core").ConversationCheckTarget }) => {
      const { createAllTools } = await import("../tools/system-tools.js");
      const { createMemoryTools } = await import("../tools/memory-tools.js");
      const { createDataAgentTools } = await import("../tools/data-tools.js");
      const { createArtifactAgentTools } = await import("../tools/artifact-tools.js");
      const { createCompanyBrainAgentTools } = await import("../tools/company-brain-tools.js");
      const { createStorageAgentTools } = await import("../tools/storage-tools.js");
      const { resolveAgentVault } = await import("../vault/index.js");
      const {
        CLIENT_SIDE_CHAT_TOOLS,
        isClientSideChatTool,
        isSideEffectGated,
        renderWidgetTool,
        askUserTool,
        validateRenderWidgetArgs,
        setSessionTitleTool,
      } = await import("../llm/orchestrator-tools.js");
      const { nanoid } = await import("nanoid");
      const { join } = await import("node:path");
      // System vault namespaces ("$data", ...) are never exposed to an agent.
      const { loadAgentVaultEntries } = await import("../vault/index.js");
      const vaultEntries = await loadAgentVaultEntries(o.getVaultStore(), agentConfig.name);
      const vault = resolveAgentVault(vaultEntries);
      // Mirror del path task (src/adapters/engine.ts) — se l'agent dichiara
      // tool estesi (browser_*, email_*, image_*, video_*, audio_*, excel_*,
      // pdf_*, docx_*, search_*, whatsapp_*, phone_*) li registriamo anche
      // in chat completions. Senza questo l'agente in chat poteva solo
      // read/write/bash/grep/glob/ls/http_fetch/http_download mentre nei
      // task aveva accesso completo — incoerenza intenzionalmente rimossa.
      // Performance: la chiamata sotto cade nel core-only path se
      // allowedTools non contiene nessun prefisso esteso (createAllTools
      // attiva ogni categoria solo quando richiesta).
      const polpoDir = o.getPolpoDir();
      const browserProfileDir = polpoDir
        ? join(polpoDir, "browser-profiles", agentConfig.browserProfile || agentConfig.name)
        : undefined;
      // WhatsApp send wiring: il WhatsAppBridge live dell'orchestrator
      // espone sendMessage / sendMediaMessage / markRead. createAllTools
      // attiva la categoria whatsapp_* solo se store + sendMessage sono
      // entrambi presenti; sendMedia e markRead sono opzionali ma
      // necessari per `whatsapp_send_file` e per i read-receipt
      // (`markRead=true` su whatsapp_read). Bind a tutti e tre se il
      // bridge è attivo.
      const waBridge = o.getWhatsAppBridge?.();
      const whatsappSendMessage = waBridge
        ? (jid: string, text: string) => waBridge.sendMessage(jid, text)
        : undefined;
      const whatsappSendMedia = waBridge
        ? (jid: string, opts: { path: string; caption?: string; mimeType?: string; fileName?: string; mediaKind?: "auto" | "image" | "video" | "audio" | "document"; viewOnce?: boolean; data?: Uint8Array }) =>
            waBridge.sendMediaMessage(jid, opts)
        : undefined;
      const whatsappMarkRead = waBridge
        ? (keys: { remoteJid: string; id: string; fromMe?: boolean; participant?: string }[]) =>
            waBridge.markRead(keys)
        : undefined;
      // The chat's sandbox provider: anything but "local" keeps secret values away from the model
      // (vault_get → bash env_from_vault). If it cannot be resolved, fail closed.
      const chatSandboxProvider = await o.chatSandbox(agentConfig).then((c) => c.sandbox.provider, () => "bwrap");
      // commands (bash, grep, glob, the browser in Cowork chats) run in this agent's chat sandbox;
      // Cowork chats keep their files in the remote VM: every tool that touches files goes there too
      const chatShell = o.chatShell(agentConfig, context?.sessionId);
      const chatFs = o.chatFileSystem(agentConfig, context?.sessionId);
      const tools: any[] = await createAllTools({
        cwd: o.getAgentWorkDir(),
        allowedTools: agentConfig.allowedTools,
        allowedPaths: undefined,
        browserSession: agentConfig.name,
        browserProfileDir,
        browserNetwork: await o.chatBrowserNetwork(agentConfig),
        vault,
        emailAllowedDomains: agentConfig.emailAllowedDomains,
        outputDir: undefined,
        // Large tool outputs go to <polpoDir>/tmp/tool-output/<agent>/ (no task output dir in chat).
        agentName: agentConfig.name,
        whatsappStore: o.getWhatsAppStore?.(),
        whatsappSendMessage,
        whatsappSendMedia,
        whatsappMarkRead,
        polpoDir,
        shell: chatShell,
        fs: chatFs,
        sandboxProvider: chatSandboxProvider,
      });
      const memoryStore = o.getMemoryStore();
      if (memoryStore) tools.push(...createMemoryTools(memoryStore, agentConfig.name));
      tools.push(...createDataAgentTools(polpoDir, agentConfig.name, agentConfig.allowedTools, o.getVaultStore(), (event) => {
        if (event.type === "source") {
          const { type: _type, ...payload } = event;
          o.emit("data-source:changed", payload);
        } else {
          const { type: _type, ...payload } = event;
          o.emit("data-view:changed", payload);
        }
      }));
      tools.push(...createCompanyBrainAgentTools(polpoDir, agentConfig.name, agentConfig.allowedTools, o.getVaultStore(), (event) => {
        o.emit("brain:changed", event);
      }));
      // Artifacts (documents, dashboards, designs) it makes in this chat; its own only
      tools.push(...createArtifactAgentTools(agentConfig.allowedTools, () => ({
        store: getArtifactStore(polpoDir),
        author: agentConfig.name,
        ...(context?.sessionId?.() ? { sessionId: context.sessionId()! } : {}),
        emit: (payload) => o.emit("artifact:changed", payload),
      })));
      // Buckets through host-side tools: credentials stay on the host.
      tools.push(...createStorageAgentTools(polpoDir, agentConfig.name, agentConfig.allowedTools, {
        vaultStore: o.getVaultStore(),
        cwd: o.getAgentWorkDir(),
        emit: (payload) => o.emit("storage:changed", payload),
        emitFileChanged: (payload) => o.emit("file:changed", payload),
        fs: chatFs,
      }));
      // Cowork chats with hydrated read-write volumes: persist them on demand
      {
        const { sandbox: chatSbx, volumes: chatVolumes } = await o.chatSandbox(agentConfig).catch(() => ({ sandbox: undefined, volumes: [] as any[] }));
        if ((chatSbx?.provider === "daytona" || chatSbx?.provider === "e2b") && chatVolumes.some((v: any) => v.remote && v.strategy === "hydrated" && v.access === "read-write")) {
          const { createSandboxVolumeCheckpointTool } = await import("../tools/sandbox-volume-tools.js");
          tools.push(createSandboxVolumeCheckpointTool((name) => o.checkpointChatVolume(agentConfig, context?.sessionId?.(), name)));
        }
      }
      const existingToolNames = new Set(tools.map((tool: any) => tool.name));
      for (const tool of CLIENT_SIDE_CHAT_TOOLS) {
        if (!existingToolNames.has(tool.name)) tools.push(tool);
      }
      // Session meta — every agent gets `set_session_title` so the
      // first-turn nudge in completions.ts has somewhere to land. The
      // executor returns a placeholder string; the actual rename is
      // intercepted server-side in completions.ts before this executor
      // is invoked. See: orchestrator-tools.ts:setSessionTitleTool.
      if (!existingToolNames.has("set_session_title")) {
        tools.push(setSessionTitleTool);
      }
      // Structured clarification is a chat capability, not an
      // orchestrator-only capability. It is intentionally registered here
      // (agent-direct chat) and not in createAllTools, so autonomous task
      // runners remain non-interactive.
      if (!existingToolNames.has("ask_user")) {
        tools.push(askUserTool);
      }
      // Learning from its conversations: off by default; set_learning, and its own skills while learning
      if (!existingToolNames.has("set_learning")) {
        tools.push(...(await o.learningTools(agentConfig)).filter((tool) => !existingToolNames.has(tool.name)));
      }
      // A drive: the agent keeps its self-portrait (who it is, its people, its open threads)
      const drive = o.getDriveManager();
      if (agentConfig.drive?.enabled && drive && !existingToolNames.has("update_self")) {
        const { createDriveTools } = await import("../tools/drive-tools.js");
        tools.push(...createDriveTools(agentConfig.name, drive));
      }
      // Voice replies on Telegram: off by default, the agent knows its mode and changes it when asked
      if (!existingToolNames.has("set_voice_replies")) {
        const { createVoiceReplyTool } = await import("../tools/voice-reply-tools.js");
        tools.push(createVoiceReplyTool(agentConfig.voiceReplies, async (mode) => {
          await o.updateAgent(agentConfig.name, { voiceReplies: mode });
        }));
      }
      // Scheduled checks and reminders, and messages to any chat ("remind the team group every Monday at 9",
      // "tell Marco it is out"): to any Telegram group, topic or person, by default where the turn came from
      if (!existingToolNames.has("schedule_check")) {
        const { createConversationCheckTools } = await import("../tools/conversation-check-tools.js");
        tools.push(...createConversationCheckTools(() => ({
          manager: o.getConversationCheckManager(), sessionId: context?.sessionId?.(), agent: agentConfig.name, origin: context?.origin,
          chats: o, ...(agentConfig.identity?.timezone ? { timezone: agentConfig.identity.timezone } : {}),
          ...(agentConfig.drive?.enabled ? {
            autonomy: agentConfig.drive.autonomy ?? "balanced",
            reflecting: () => !!drive?.isReflecting(agentConfig.name, context?.sessionId?.()),
            noteAction: (action: string) => {
              if (drive?.isReflecting(agentConfig.name, context?.sessionId?.())) drive.noteAction(agentConfig.name, action);
            },
          } : {}),
        })).filter((tool) => !existingToolNames.has(tool.name)));
      }
      // Opt-in `render_widget` per agente, via allowedTools (es.
      // `["read","write","render_widget"]` in polpo.json). NON è nei
      // CLIENT_SIDE_CHAT_TOOLS perché è un display tool potente: lo
      // diamo solo agli agent che lo dichiarano esplicitamente. Side-
      // effect del chunk widget_render emesso dal route in
      // packages/server/src/routes/completions.ts (case `name ===
      // "render_widget"` nel for-loop tool execution) — funziona
      // identico a orchestrator mode.
      const allowsRenderWidget = Array.isArray(agentConfig.allowedTools)
        && agentConfig.allowedTools.includes("render_widget");
      if (allowsRenderWidget && !existingToolNames.has("render_widget")) {
        tools.push(renderWidgetTool);
      }
      const toolMap = new Map(tools.map((t: any) => [t.name, t]));
      const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (name === "render_widget") {
          // Validate args; errori sono restituiti come tool result così
          // il modello può ritentare nello stesso turn (stesso pattern
          // dell'orchestrator). On success il route emette poi il chunk
          // widget_render dopo questo executor.
          const err = validateRenderWidgetArgs(args);
          if (err) return err;
          return "Widget rendered to the user. Continue with prose only if necessary.";
        }
        if (isClientSideChatTool(name)) {
          return `Client-side tool ${name} completed.`;
        }
        if (name === "set_session_title") {
          // Normally intercepted in completions.ts before reaching this
          // executor — this fallback only fires if the intercept missed
          // (defensive). The rename itself is a no-op here; the model
          // gets a placeholder result and the UI sees no chunk.
          return `Session title acknowledged (rename will be applied by server intercept).`;
        }
        const tool = toolMap.get(name);
        if (!tool) return `Error: Unknown tool "${name}"`;
        try {
          const result = await tool.execute(nanoid(), args as any);
          return result.content.map((c: any) => c.text ?? "").join("");
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      };
      // Side-effect gate: in CHAT mode (real-time conversation) we
      // intercept whatsapp_send / whatsapp_send_file / email_send and
      // emit a preview chunk so the user can confirm before the message
      // actually goes out. The TASK runner is unaffected — tasks are
      // pre-authorised by the user when they're queued. See
      // SIDE_EFFECT_GATED_TOOLS in src/llm/orchestrator-tools.ts.
      const isInteractive = (name: string) => name === "ask_user" || isClientSideChatTool(name) || isSideEffectGated(name);
      // Whatever the agent's tools change is attributed to the agent
      const attributed = (name: string, args: Record<string, unknown>) =>
        withEventOrigin({ source: "agent", by: agentConfig.name }, () => executor(name, args));
      return { tools, executor: attributed, isInteractive };
    },
    streamLLM: streamSimpleWithAuth as any,
    completeLLM: completeSimpleWithAuth as any,
    resolveSummaryModel: (conversation: any, configured: string | undefined, promptTokens: number) =>
      resolveSummaryModel(conversation, configured, promptTokens),
    // only Telegram turns carry an origin (see ChannelGateway.checkTarget)
    channelTurnPrompt: () => `## Channel\nThis turn comes from Telegram: your answer is sent as a Telegram message. ${reactionHint()}`,
    resolveOrchestratorContext: async () => {
      const { buildChatSystemPrompt } = await import("../llm/prompts.js");
      const { resolveModel, resolveModelSpec, buildStreamOpts } = await import("../llm/pi-client.js");
      const { ALL_ORCHESTRATOR_TOOLS, executeOrchestratorTool, isInteractive } = await import("../llm/orchestrator-tools.js");
      const state = await (async () => { try { return await o.getStore()?.getState() ?? null; } catch { return null; } })();
      const systemPrompt = await buildChatSystemPrompt(o, state);
      const settings = o.getConfig()?.settings;
      const modelSpec = resolveModelSpec(settings?.orchestratorModel);
      const m = resolveModel(modelSpec);
      return {
        systemPrompt,
        model: m,
        streamOpts: buildStreamOpts(undefined, settings?.reasoning, m.maxTokens),
        tools: ALL_ORCHESTRATOR_TOOLS,
        executor: (name: string, args: Record<string, unknown>, context) =>
          withEventOrigin({ source: "polpo" }, () => executeOrchestratorTool(name, args, o, context)),
        isInteractive,
      };
    },
  }), opts?.apiKeys);
  // Chat turns from outside (web UI, API clients) are "api"; internal channel turns keep their origin
  app.use("/v1/chat/completions", (c, next) => currentEventOrigin() ? next() : withEventOrigin({ source: "api" }, () => next()));
  app.route("/v1/chat/completions", completionApp);

  // ── OAuth for the MCP connector (Claude web/Desktop/mobile, ChatGPT…) ──
  // The public origin as the client sees it (a reverse proxy or Tailscale in front): the forwarded host
  // and protocol, else the request URL. POLPO_PUBLIC_URL (which may carry a path, when the proxy mounts
  // Polpo under one) wins for requests through its host, or that name no other host.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const publicOrigin = (c: any): string => {
    const url = new URL(c.req.url);
    const forwardedHost = (c.req.header("x-forwarded-host") as string | undefined)?.split(",")[0]?.trim();
    const proto = (c.req.header("x-forwarded-proto") as string | undefined)?.split(",")[0]?.trim() || url.protocol.replace(":", "");
    const host = (forwardedHost || c.req.header("host") || url.host).replace(proto === "https" ? /:443$/ : /:80$/, "");
    const configured = process.env.POLPO_PUBLIC_URL?.replace(/\/+$/, "");
    if (configured && (!forwardedHost || new URL(configured).host === host)) return configured;
    return `${proto}://${host}`;
  };
  // Keys that open the MCP connector: the server's API keys, and POLPO_MCP_KEY (comma-separated) for an
  // instance that exposes only its connector, with no API key on the dashboard and REST API.
  const mcpKeys = (): string[] => [
    ...(opts?.apiKeys ?? []),
    ...(process.env.POLPO_MCP_KEY ?? "").split(",").map((k) => k.trim()).filter(Boolean),
  ];
  let oauth: { dir: string; server: OAuthServer } | undefined;
  const oauthServer = (): OAuthServer => {
    const dir = activePolpoDir();
    if (!oauth || oauth.dir !== dir) oauth = { dir, server: new OAuthServer(dir) };
    return oauth.server;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const oauthFail = (c: any, err: unknown) => err instanceof OAuthError
    ? c.json({ error: err.code, error_description: err.message }, 400)
    : c.json({ error: "server_error", error_description: err instanceof Error ? err.message : String(err) }, 500);
  // How the person on the consent page may allow a client: signed in to the dashboard, an API or MCP key, or open (no auth at all)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const consentIdentity = (c: any): { method: "session" | "api-key" | "open"; email?: string } => {
    const keys = mcpKeys();
    const instanceAuth = isInstanceAuthEnabled();
    const session = instanceAuth && opts?.workDir ? validateSession(getPolpoDir(opts.workDir), getCookie(c, AUTH_COOKIE_NAME)) : null;
    if (session) return { method: "session", email: session.email };
    if (!instanceAuth && keys.length === 0) return { method: "open" };
    return { method: "api-key" };
  };
  // The consent form carries a token bound to the dashboard session (and this process), checked on submit
  const consentSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const consentCsrf = (c: any): string => createHmac("sha256", consentSecret).update(getCookie(c, AUTH_COOKIE_NAME) ?? "no-session").digest("base64url");
  const AUTHORIZE_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const authorizeParams = (source: Record<string, any>) => Object.fromEntries(AUTHORIZE_PARAMS.map((k) => [k, typeof source[k] === "string" ? source[k] : undefined]));

  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, (c) => c.json(protectedResourceMetadata(publicOrigin(c))));
  }
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
    app.get(path, (c) => c.json(authorizationServerMetadata(publicOrigin(c))));
  }
  app.post("/oauth/register", async (c) => {
    try {
      const client = oauthServer().register(await c.req.json().catch(() => ({})));
      return c.json({ ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
    } catch (err) {
      return oauthFail(c, err);
    }
  });
  app.get("/oauth/authorize", async (c) => {
    const params = authorizeParams(c.req.query());
    try {
      const client = await oauthServer().checkAuthorizeRequest(params, `${publicOrigin(c)}/mcp`);
      const who = consentIdentity(c);
      return c.html(consentPage({ client, redirectUri: params.redirect_uri!, params: { ...params, csrf: consentCsrf(c) }, ...who }));
    } catch (err) {
      return c.html(`<!doctype html><meta charset="utf-8"><title>Polpo</title><p>This connection request is not valid: ${err instanceof Error ? err.message.replace(/[<>&]/g, "") : "error"}</p>`, 400);
    }
  });
  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const params = authorizeParams(form);
    const resource = `${publicOrigin(c)}/mcp`;
    let client;
    try {
      client = await oauthServer().checkAuthorizeRequest(params, resource);
    } catch (err) {
      return c.html(`<!doctype html><meta charset="utf-8"><title>Polpo</title><p>This connection request is not valid: ${err instanceof Error ? err.message.replace(/[<>&]/g, "") : "error"}</p>`, 400);
    }
    const back = new URL(params.redirect_uri!);
    if (params.state) back.searchParams.set("state", params.state);
    back.searchParams.set("iss", publicOrigin(c));
    if (form.decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      return c.redirect(back.toString(), 302);
    }
    const who = consentIdentity(c);
    if (typeof form.csrf !== "string" || form.csrf !== consentCsrf(c)) {
      return c.html(consentPage({ client, redirectUri: params.redirect_uri!, params: { ...params, csrf: consentCsrf(c) }, ...who, error: "This page expired: try again." }), 400);
    }
    let subject = who.email ?? "local";
    if (who.method === "api-key") {
      // pasted from an env file or with spaces: KEY=value, or the bare value
      const key = typeof form.api_key === "string" ? form.api_key.trim().replace(/^(POLPO_MCP_KEY|POLPO_API_KEY)=/, "") : "";
      const ok = hasValidApiKey(new Request("http://x/", { headers: { "x-api-key": key } }), mcpKeys());
      if (!ok) return c.html(consentPage({ client, redirectUri: params.redirect_uri!, params: { ...params, csrf: consentCsrf(c) }, method: "api-key", error: "That API key is not valid." }), 401);
      subject = "api-key";
    }
    back.searchParams.set("code", oauthServer().issueCode(params, resource, subject));
    return c.redirect(back.toString(), 302);
  });
  app.post("/oauth/token", async (c) => {
    try {
      const body = await c.req.parseBody();
      const form = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
      c.header("Cache-Control", "no-store");
      return c.json(oauthServer().exchange(form));
    } catch (err) {
      return oauthFail(c, err);
    }
  });
  app.post("/oauth/revoke", async (c) => {
    const body = await c.req.parseBody();
    oauthServer().revoke(typeof body.token === "string" ? body.token : undefined);
    return c.body(null, 200);
  });

  // ── MCP: Polpo as a connector (Claude Code, Codex, Claude, ChatGPT…) ──
  // Streamable HTTP, stateless. The tools call this server's REST API in process, so they follow
  // the same rules; the caller is authenticated here: an API or MCP key (Bearer or X-API-Key), an OAuth
  // token or a dashboard session, or nothing when the server has no auth and no key at all (localhost-only).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const mcpAuthorized = (c: any): boolean => {
    const keys = mcpKeys();
    const instanceAuth = isInstanceAuthEnabled();
    if (!instanceAuth && keys.length === 0) return true;
    if (hasValidApiKey(c.req.raw, keys)) return true;
    // an OAuth access token issued for this endpoint (Claude, ChatGPT and other connectors)
    const auth = c.req.header("authorization") as string | undefined;
    const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
    if (bearer?.startsWith("polpo_at_") && oauthServer().verifyAccessToken(bearer, `${publicOrigin(c)}/mcp`)) return true;
    return instanceAuth && !!opts?.workDir && !!validateSession(getPolpoDir(opts.workDir), getCookie(c, AUTH_COOKIE_NAME));
  };
  app.all("/mcp", async (c) => {
    if (!mcpAuthorized(c)) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${publicOrigin(c)}/.well-known/oauth-protected-resource/mcp"`);
      return c.json({ error: "Authentication required: send Authorization: Bearer <your Polpo API key>" }, 401);
    }
    if (!orchestrator?.isInitialized) return c.json({ error: "Polpo is not initialized. Complete setup first." }, 503);
    return withEventOrigin({ source: "api", by: "mcp" }, () => handleMcpRequest(c.req.raw, {
      version: POLPO_PACKAGE_VERSION,
      routes: () => app.routes,
      api: async (method, path, body, headers) => {
        const form = body instanceof FormData;
        const res = await app.request(path, {
          method,
          headers: {
            ...(body !== undefined && !form ? { "content-type": "application/json" } : {}),
            ...trustedApiCallHeaders(),
            ...(opts?.apiKeys?.[0] ? { authorization: `Bearer ${opts.apiKeys[0]}` } : {}),
            ...headers,
          },
          ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        const raw = new TextDecoder().decode(bytes);
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        return { status: res.status, body: parsed, headers: res.headers, bytes };
      },
    }));
  });

  // ── Authenticated routes (require initialized orchestrator) ───────────

  const authed = new OpenAPIHono();
  if (!isInstanceAuthEnabled() && opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }
  if (opts?.workDir) {
    authed.use("*", instanceAuthMiddleware(getPolpoDir(opts.workDir), opts.apiKeys ?? []));
  }

  // Events caused by an API call carry source "api" and, with instance auth, the person's email
  authed.use("*", (c, next) => {
    if (currentEventOrigin()) return next();
    const email = c.get("polpoUserEmail" as never) as string | undefined;
    return withEventOrigin({ source: "api", ...(email ? { by: email } : {}) }, () => next());
  });

  // Gate: orchestrator must be initialized for these routes
  authed.use("*", async (c, next) => {
    // The build-time OpenAPI generator intentionally creates the app without
    // a runtime orchestrator. Serving the static schema must remain possible.
    if (c.req.path.endsWith("/openapi.json")) return next();
    if (!orchestrator.isInitialized) {
      return c.json({ ok: false, error: "Polpo is not initialized. Complete setup first." }, 503);
    }
    return next();
  });

  // ── Dependency thunks ─────────────────────────────────────────────────
  //
  // Each route factory receives a thunk that returns its deps at request
  // time.  In the self-hosted case every thunk delegates to the same
  // Orchestrator instance.  Cloud can supply different thunks that read
  // from Neon stores directly.

  const o = orchestrator; // short alias

  o?.setBackgroundWaitContinuation(async (wait, task, signal) => {
    // One turn per session: wait for whatever runs there now.
    if (sessionLeases.isHeld(wait.sessionId)) return "deferred";
    const session = await o.getSessionStore()?.getSession(wait.sessionId);
    if (!session) throw new Error(`Chat session "${wait.sessionId}" no longer exists`);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": wait.sessionId,
      "x-polpo-internal-continuation": "background-wait",
      ...internalCallHeaders(),
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    // the whole conversation: compaction keeps it within the window
    const history = await o.getSessionStore()?.getMessages(wait.sessionId) ?? [];
    const response = await completionApp.request(new Request("http://polpo.internal/", {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        stream: false,
        messages: [
          ...history.map((message) => ({ role: message.role, content: message.content })),
          {
            role: "system",
            content: [
              `Background wait ${wait.id} is complete.`,
              `Task "${task.title}" (${task.id}) reached status "${task.status}".`,
              "Resume the conversation proactively: report the result, inspect the task if useful, and continue any work that was deferred while waiting.",
            ].join("\n"),
          },
        ],
      }),
    }));
    if (response.status === 409) return "deferred";
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as any;
      throw new Error(payload?.error?.message ?? payload?.error ?? `Continuation failed (${response.status})`);
    }
    return "completed";
  });

  // A learning review is a turn of the agent's review session (its own model and tools).
  o?.setLearningRunner(async ({ agent, sessionId, prompt, signal }) => {
    if (sessionLeases.isHeld(sessionId)) return "deferred";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": sessionId,
      ...internalCallHeaders(),
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    const history = await o.getSessionStore()?.getMessages(sessionId) ?? [];
    const response = await completionApp.request(new Request("http://polpo.internal/", {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        stream: false,
        agent: agent.name,
        messages: [
          ...history.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: prompt },
        ],
      }),
    }));
    if (response.status === 409) return "deferred";
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(payload?.error?.message ?? payload?.error ?? `Learning review failed (${response.status})`);
    const content = payload?.choices?.[0]?.message?.content;
    return { text: typeof content === "string" ? content : "" };
  });

  // A reflection is a turn of the agent's reflection session (its own model, tools and purpose). The
  // journal carries the continuity, so only the last turns of that session are sent back.
  o?.setReflectionRunner(async ({ agent, sessionId, prompt, signal }) => {
    if (sessionLeases.isHeld(sessionId)) return "deferred";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": sessionId,
      ...internalCallHeaders(),
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    const history = (await o.getSessionStore()?.getMessages(sessionId) ?? [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim())
      .slice(-6);
    const response = await completionApp.request(new Request("http://polpo.internal/", {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        stream: false,
        agent: agent.name,
        messages: [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: prompt }],
      }),
    }));
    if (response.status === 409) return "deferred";
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(payload?.error?.message ?? payload?.error ?? `Reflection failed (${response.status})`);
    const content = payload?.choices?.[0]?.message?.content;
    return { text: typeof content === "string" ? content : "" };
  });

  // A recurring check runs as a turn of its own session (it remembers its earlier runs and keeps
  // the "nothing to report" answers out of the chat it was asked in).
  o?.setConversationCheckRunner(async (check, signal) => {
    const sessions = o.getSessionStore();
    if (!sessions) throw new Error("Chat sessions are not available");
    let runSessionId = check.runSessionId;
    if (!runSessionId || !(await sessions.getSession(runSessionId))) {
      runSessionId = await sessions.create(`Check: ${check.prompt.slice(0, 50)}`, check.agent, { scope: `check:${check.id}` });
      await o.getConversationCheckManager()?.setRunSession(check.id, runSessionId);
    }
    if (sessionLeases.isHeld(runSessionId)) return "deferred";
    const { CHECK_NOTHING_TO_REPORT } = await import("@polpo-ai/core");
    const kind = check.target?.conversation ? "the Telegram group" : check.target ? "the Telegram chat" : "the chat";
    const where = check.target?.name ? `${kind} "${check.target.name}"` : kind;
    const when = check.cron ? `cron "${check.cron}"${check.timezone ? ` (${check.timezone})` : ""}` : check.everyMinutes > 0 ? `every ${check.everyMinutes} min` : "once";
    const instruction = [
      `[Scheduled check ${check.id}: run ${check.runs + 1}, ${when}; your answer is posted in ${where}]`,
      ...(check.why ? [`You planned this yourself, because: ${check.why}`] : []),
      check.prompt,
      "",
      `Do it now. If there is nothing worth telling the chat, answer exactly ${CHECK_NOTHING_TO_REPORT} and nothing else.`,
      "Otherwise answer only with the message for the chat: it is posted as you write it.",
      "Do not repeat what you already reported in an earlier run unless something changed.",
    ].join("\n");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": runSessionId,
      ...internalCallHeaders(),
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    const history = await sessions.getMessages(runSessionId);
    const response = await completionApp.request(new Request("http://polpo.internal/", {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        stream: false,
        ...(check.agent ? { agent: check.agent } : {}),
        messages: [
          ...history.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: instruction },
        ],
      }),
    }));
    if (response.status === 409) return "deferred";
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(payload?.error?.message ?? payload?.error ?? `Check run failed (${response.status})`);
    const content = payload?.choices?.[0]?.message?.content;
    return { text: typeof content === "string" ? content : "" };
  });

  // Messaging channels (Telegram, WhatsApp) run agent turns, and any turn with
  // media, through the same completions pipeline as the web UI: prompt, memory,
  // tools, compaction, attachment storage and persistence stay identical.
  o?.setChannelChatRunner(async ({ agent, sessionId, messages, origin }) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": sessionId,
      // where the turn came from: a recurring check asked in it reports there
      ...(origin ? { [CHAT_ORIGIN_HEADER]: encodeURIComponent(JSON.stringify(origin)) } : {}),
      // One turn per session: a channel message waits for the running answer instead of failing.
      "x-polpo-lease-wait": String(10 * 60 * 1000),
      ...internalCallHeaders(),
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    const response = await completionApp.request(new Request("http://polpo.internal/", {
      method: "POST",
      headers,
      body: JSON.stringify({ stream: false, ...(agent ? { agent } : {}), messages }),
    }));
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? payload?.error ?? `Agent chat failed (${response.status})`);
    }
    // Only the agents' workspace is shareable — never the project root (.polpo holds config and tokens).
    return interpretChannelCompletion(payload?.choices?.[0], [o.getAgentWorkDir()]);
  });

  // /compact from a messaging channel: the same completion route, asked to compact instead of answering
  o?.setChannelCompactRunner(async ({ agent, sessionId, messages, focus }) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": sessionId,
      "x-polpo-lease-wait": String(10 * 60 * 1000),
      ...internalCallHeaders(),
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    const response = await completionApp.request(new Request("http://polpo.internal/", {
      method: "POST",
      headers,
      body: JSON.stringify({ stream: false, ...(agent ? { agent } : {}), messages, compact: focus ? { focus } : {} }),
    }));
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(payload?.error?.message ?? `Compaction failed (${response.status})`);
    return payload?.data?.compaction ?? null;
  });

  // Sandbox status for the UI: what this machine can run, and the resolved defaults
  authed.get("/sandbox", async (c) => {
    const { availableProviders, effectiveSandbox } = await import("../sandbox/manager.js");
    const { normalizeSandboxSettings } = await import("@polpo-ai/core/sandbox");
    const instance = normalizeSandboxSettings(o.getConfig()?.settings?.sandbox);
    const agents = await o.getAgents();
    return c.json({ ok: true, data: {
      available: [...availableProviders()],
      settings: instance ?? null,
      polpo: effectiveSandbox({ scope: "chat", cascade: { instance }, agentTools: instance?.allowLocal ? [] : ["http_fetch"] }),
      agents: agents.map((agent) => {
        const cascade = { instance, agent: normalizeSandboxSettings(agent.sandbox) };
        return {
          name: agent.name,
          settings: cascade.agent ?? null,
          task: effectiveSandbox({ scope: "task", cascade, agentTools: agent.allowedTools }),
          chat: effectiveSandbox({ scope: "chat", cascade, agentTools: agent.allowedTools }),
        };
      }),
    } });
  });

  // Destinations the sandbox network rule refused recently (last ~100, in memory): the "approve a new domain" list
  authed.get("/sandbox/network-denied", (c) => c.json({ ok: true, data: o.getNetworkDenied() }));

  // Remote sandbox providers (Daytona, E2B): settings are edited with the other sandbox settings
  // (PATCH /config/settings), keys stay in the vault entry each provider references.
  // Vault entries a feature can reference (owner + service): every agent's own entries, names and
  // key names only — never values, never the system "$" owners.
  authed.get("/vault-catalog", async (c) => {
    const store = o.getVaultStore();
    if (!store) return c.json({ ok: true, data: [] });
    const agents = await o.getAgents();
    const rows = (await Promise.all(agents.map(async (agent) => {
      const entries = await store.list(agent.name).catch(() => []);
      return entries.filter((e: any) => !e.sharedFrom).map((e: any) => ({
        owner: agent.name, service: e.service, type: e.type, label: e.label, keys: e.keys, allowedAgents: e.allowedAgents ?? [],
      }));
    }))).flat();
    return c.json({ ok: true, data: rows });
  });

  authed.get("/sandbox/providers", async (c) => {
    const { remoteProviderStatus } = await import("../sandbox/remote-providers.js");
    return c.json({ ok: true, data: await remoteProviderStatus() });
  });
  authed.post("/sandbox/providers/:id/test", async (c) => {
    const { isRemoteProvider, testRemoteProvider, remoteProviderCredentials } = await import("../sandbox/remote-providers.js");
    const id = c.req.param("id");
    if (!isRemoteProvider(id)) return c.json({ ok: false, error: `Unknown provider "${id}"` }, 404);
    if (!(await remoteProviderCredentials(id))) return c.json({ ok: false, error: "Choose a vault entry with the API key first" }, 400);
    return c.json({ ok: true, data: await testRemoteProvider(id) });
  });

  authed.route("/counts", countsRoutes(() => ({
    getAllTasks: () => o.getStore().getAllTasks(),
    getAllMissions: () => o.getAllMissions(),
    getAgents: () => o.getAgents(),
  })));

  authed.route("/token-usage", tokenUsageRoutes(activePolpoDir, () => o.getRunStore()));

  authed.route("/tasks", taskRoutes(() => ({
    taskStore: o.getStore(),
    wakeSupervisor: opts?.wakeSupervisor,
    addTask: (opts: any) => o.addTask(opts),
    deleteTask: (id: string) => o.deleteTask(id),
    retryTask: (id: string) => o.retryTask(id),
    killTask: (id: string) => o.killTask(id),
    sendDirection: (id: string, message: string, directionOpts?: any) => o.sendDirection(id, message, directionOpts),
    listDirections: (id: string) => o.listDirections(id),
    reassessTask: (id: string) => o.reassessTask(id),
    forceFailTask: (id: string) => o.forceFailTask(id),
    updateTaskDescription: (id: string, desc: string) => o.updateTaskDescription(id, desc),
    updateTaskAssignment: (id: string, agent: string) => o.updateTaskAssignment(id, agent),
    updateTaskExpectations: (id: string, exp: any) => o.updateTaskExpectations(id, exp),
  })));

  authed.route("/missions", missionRoutes(() => ({
    getAllMissions: () => o.getAllMissions(),
    getResumableMissions: () => o.getResumableMissions(),
    getMission: (id: string) => o.getMission(id),
    saveMission: (opts: any) => o.saveMission(opts),
    updateMission: (id: string, updates: any) => o.updateMission(id, updates),
    deleteMission: (id: string) => o.deleteMission(id),
    executeMission: (id: string) => o.executeMission(id),
    resumeMission: (id: string, opts?: any) => o.resumeMission(id, opts),
    abortGroup: (group: string, missionId?: string) => o.abortGroup(group, missionId),
    getActiveCheckpoints: () => o.getActiveCheckpoints(),
    resumeCheckpointByMissionId: (mid: string, cp: string) => o.resumeCheckpointByMissionId(mid, cp),
    getActiveDelays: () => o.getActiveDelays(),
    addMissionTask: (mid: string, task: any) => o.addMissionTask(mid, task),
    updateMissionTask: (mid: string, title: string, u: any) => o.updateMissionTask(mid, title, u),
    removeMissionTask: (mid: string, title: string) => o.removeMissionTask(mid, title),
    reorderMissionTasks: (mid: string, titles: string[]) => o.reorderMissionTasks(mid, titles),
    addMissionCheckpoint: (mid: string, cp: any) => o.addMissionCheckpoint(mid, cp),
    updateMissionCheckpoint: (mid: string, name: string, u: any) => o.updateMissionCheckpoint(mid, name, u),
    removeMissionCheckpoint: (mid: string, name: string) => o.removeMissionCheckpoint(mid, name),
    addMissionDelay: (mid: string, d: any) => o.addMissionDelay(mid, d),
    updateMissionDelay: (mid: string, name: string, u: any) => o.updateMissionDelay(mid, name, u),
    removeMissionDelay: (mid: string, name: string) => o.removeMissionDelay(mid, name),
    addMissionQualityGate: (mid: string, g: any) => o.addMissionQualityGate(mid, g),
    updateMissionQualityGate: (mid: string, name: string, u: any) => o.updateMissionQualityGate(mid, name, u),
    removeMissionQualityGate: (mid: string, name: string) => o.removeMissionQualityGate(mid, name),
    addMissionTeamMember: (mid: string, m: any) => o.addMissionTeamMember(mid, m),
    updateMissionTeamMember: (mid: string, name: string, u: any) => o.updateMissionTeamMember(mid, name, u),
    removeMissionTeamMember: (mid: string, name: string) => o.removeMissionTeamMember(mid, name),
    updateMissionNotifications: (mid: string, n: any) => o.updateMissionNotifications(mid, n),
  })));

  authed.route("/agents", agentRoutes(() => ({
    getAgents: () => o.getAgents(),
    addAgent: (agent: any, teamName?: string) => o.addAgent(agent, teamName),
    removeAgent: (name: string) => o.removeAgent(name),
    updateAgent: (name: string, updates: any) => o.updateAgent(name, updates),
    getTeams: () => o.getTeams(),
    getTeam: (name?: string) => o.getTeam(name),
    addTeam: (team: any) => o.addTeam(team),
    removeTeam: (name: string) => o.removeTeam(name),
    renameTeam: (oldName: string, newName: string) => o.renameTeam(oldName, newName),
    taskStore: o.getStore(),
    runStore: o.getRunStore(),
    polpoDir: o.getPolpoDir(),
    fs: new NodeFileSystem(),
  })));

  authed.route("/events", eventRoutes(sseBridge));

  authed.route("/learning", learningRoutes(() => ({
    manager: o.getLearningManager(),
    getAgents: () => o.getAgents(),
  })));

  authed.route("/drive", driveRoutes(() => ({
    manager: o.getDriveManager(),
    checks: o.getConversationCheckManager(),
    getAgents: () => o.getAgents(),
  })));

  authed.route("/rooms", roomRoutes(() => ({
    rooms: o.getRoomStore(),
    engine: o.getRoomEngine(),
    agentNames: async () => (await o.getAgents()).map(a => a.name),
    emit: (event, payload) => o.emit(event, payload),
    emitDeleted: (roomId) => o.emit("room:deleted", { roomId }),
  })));

  authed.route("/chat", chatRoutes(() => ({
    attachmentStore: o.getAttachmentStore() ?? new FileAttachmentStore(o.getPolpoDir()),
    sessionStore: o.getSessionStore(),
    emit: (event: string, data: unknown) => o.emit(event as any, data),
    chatQueueStore: o.getChatQueueStore(),
    turnScheduler,
    removeAttachmentFile: async (path: string) => {
      // Only chat attachments, never anything else under the project.
      if (!CHAT_ATTACHMENT_PATH.test(path)) return;
      await unlink(joinPath(o.getWorkDir(), path)).catch(() => undefined);
    },
  })));

  authed.route("/skills", skillRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    workDir: o.getWorkDir(),
    getAgents: () => o.getAgents(),
    emit: (event, data) => o.emit(event, data),
  })));

  authed.route("/notifications", notificationRoutes(() => ({
    getNotificationRouter: () => o.getNotificationRouter(),
  })));

  authed.route("/approvals", approvalRoutes(() => ({
    getAllApprovals: (status?: string) => o.getAllApprovals(status as any),
    getApprovalRequest: (id: string) => o.getApprovalRequest(id),
    approveRequest: (id: string, resolvedBy?: string, note?: string) => o.approveRequest(id, resolvedBy, note),
    rejectRequest: (id: string, feedback: string, resolvedBy?: string) => o.rejectRequest(id, feedback, resolvedBy),
    canRejectRequest: (id: string) => o.canRejectRequest(id),
  })));

  authed.route("/playbooks", playbookRoutes(() => ({
    playbookStore: o.getPlaybookStore(),
    saveMission: (opts: any) => o.saveMission(opts),
    executeMission: (id: string) => o.executeMission(id),
    deleteMission: (id: string) => o.deleteMission(id),
    onRun: (name: string, missionId: string, params: string[]) => o.emit("playbook:run", { name, missionId, params }),
  })));
  // Backward-compat: keep /templates as alias
  authed.route("/templates", playbookRoutes(() => ({
    playbookStore: o.getPlaybookStore(),
    saveMission: (opts: any) => o.saveMission(opts),
    executeMission: (id: string) => o.executeMission(id),
    deleteMission: (id: string) => o.deleteMission(id),
    onRun: (name: string, missionId: string, params: string[]) => o.emit("playbook:run", { name, missionId, params }),
  })));

  authed.route("/config", configRoutes(() => ({
    getConfig: () => o.getConfig(),
    reloadConfig: () => o.reloadConfig(),
    getPolpoDir: () => o.getPolpoDir(),
    saveConfig: async (config: any) => {
      // Config routes only mutate `settings`; merge them into the file so provider
      // definitions (and anything else the parsed in-memory config drops) survive.
      const { savePolpoSettings } = await import("../core/config.js");
      savePolpoSettings(o.getPolpoDir(), config?.settings ?? {});
    },
    getNotificationRouter: () => o.getNotificationRouter(),
  })));
  authed.route("/config", brandingConfigRoutes(() => ({
    getConfig: () => o.getConfig(),
    reloadConfig: () => o.reloadConfig(),
    getPolpoDir: () => o.getPolpoDir(),
  })));

  authed.route("/peers", peerRoutes(() => {
    const channels: Record<string, any> = o.getConfig()?.settings?.notifications?.channels ?? {};
    return {
      peerStore: o.getPeerStore(),
      getGateway: (channel?: string) => o.getChannelGateway(channel),
      getConfiguredTelegramTokens: () => Object.values(channels)
        .filter((ch) => ch?.type === "telegram" && ch.botToken)
        .map((ch) => String(ch.botToken).trim()),
      getTelegramBotToken: (channel?: string) => {
        if (channel) return channels[channel]?.type === "telegram" ? channels[channel].botToken : undefined;
        // Primary bot: the first Telegram channel not dedicated to an agent (as in the orchestrator).
        const telegram = Object.values(channels).filter((ch) => ch?.type === "telegram" && ch.botToken);
        return (telegram.find((ch) => !ch.gateway?.agent) ?? telegram[0])?.botToken;
      },
    };
  }));

  authed.route("/schedules", scheduleRoutes(() => ({
    getScheduler: () => o.getScheduler(),
    getMission: (id: string) => o.getMission(id),
    updateMission: (id: string, updates: any) => o.updateMission(id, updates),
  })));

  authed.route("/watchers", watcherRoutes(() => ({
    getWatcherManager: () => o.getWatcherManager(),
    taskStore: o.getStore(),
  })));

  authed.route("/background-waits", backgroundWaitRoutes(o));
  authed.route("/apps", appsRoutes(() => ({ ...activeAppRegistry(), polpoDir: activePolpoDir() })));
  authed.route("/data", dataRoutes(() => {
    const runtime = activeDataRegistry();
    return { runtime, store: runtime.store, vaultStore: o.getVaultStore() };
  }));
  authed.route("/views", dataViewRoutes(() => activeDataRegistry().store));
  authed.route("/artifacts", artifactRoutes(() => ({
    store: getArtifactStore(activePolpoDir()),
    data: activeDataRegistry(),
    author: (c) => {
      const email = c.get("polpoUserEmail" as never) as string | undefined;
      if (email) return `person:${email}`;
      // made through the MCP connector (the server calls the API for an authenticated client)
      return isTrustedApiCall(c.req.header(TRUSTED_API_CALL_HEADER)) ? "person:mcp" : "person:dashboard";
    },
    emit: (payload) => orchestrator.emit("artifact:changed", payload),
  })));
  authed.route("/storage", storageRoutes(activeStorage, () => orchestrator.getAgentWorkDir()));
  authed.route("/brain", companyBrainRoutes(activeCompanyBrain));

  authed.route("/vault", vaultRoutes(() => ({
    vaultStore: o.getVaultStore(),
  })));

  authed.route("/auth", authRoutes(() => ({
    getConfig: () => o.getConfig(),
  })));

  authed.route("/files", fileRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    workDir: o.getWorkDir(),
    agentWorkDir: o.getAgentWorkDir(),
    fs: new NodeFileSystem(),
    emit: (event: string, data: any) => o.emit(event as any, data),
    // Mounted buckets appear as extra roots (their files are browsed through the mount).
    // every volume (local folders and buckets); buckets are browsable once mounted here
    storageRoots: async () => (await activeStorage().list())
      .map((entry) => ({ id: entry.id, slug: entry.slug, name: entry.name, path: entry.mount.path, readOnly: entry.readOnly, kind: entry.provider === "local" ? "local" as const : "bucket" as const, mounted: entry.mount.state === "mounted" })),
  })));

  authed.route("/audio", audioRoutes());
  authed.route("/diagnostics/mobile", mobileDiagnosticsRoutes());

  authed.route("/browser-dashboard", browserDashboardRoutes());
  authed.route("/app-preview", appPreviewRoutes(() => ({
    codingSessionStore: o.getCodingSessionStore(),
    codeServerManager: opts?.codeServerManager,
    agentWorkDir: o.getAgentWorkDir(),
  })));

  authed.route("/git", gitRoutes(() => ({
    workDir: o.getWorkDir(),
  })));

  authed.route("/push", pushRoutes(() => ({
    polpoDir: o.getPolpoDir(),
  })));

  authed.route("/expo-push", expoPushRoutes(() => ({
    polpoDir: o.getPolpoDir(),
  })));

  authed.route("/whatsapp", whatsappRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    reloadConfig: () => o.reloadConfig(),
    // Approval-gate /send and /send-file need the live WhatsAppBridge
    // (resolved through the orchestrator). Login flows still work without
    // it because they spin up their own bridge per session.
    orchestrator: o,
  })));

  // Approval-gate REST: invoked by the chat UI after the user confirms
  // an `email_send` preview. Re-uses the same SMTP code path as the
  // email_send agent tool (sendEmail() in src/tools/email-tools.ts).
  authed.route("/email", emailRoutes(() => ({ orchestrator: o })));

  authed.route("/coding", codingRoutes(() => ({
    codingSessionStore: o.getCodingSessionStore(),
    codeServerManager: opts?.codeServerManager,
    polpoDir: o.getPolpoDir(),
    getTerminalHandle: opts?.getTerminalHandle,
  })));

  authed.route("/sync", syncRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    workDir: o.getWorkDir(),
    scheduler: opts?.syncScheduler,
  })));

  authed.route("/attachments", attachmentRoutes(() => ({
    // Prefer the Drizzle-backed AttachmentStore when storage is sqlite/postgres.
    // Falls back to the file-based store so projects on `storage: "file"`
    // keep working unchanged.
    attachmentStore: o.getAttachmentStore() ?? new FileAttachmentStore(o.getPolpoDir()),
    fs: new NodeFileSystem(),
    workDir: o.getWorkDir(),
  })));

  authed.get("/terminal/status", (c) => c.json({
    ok: true,
    data: {
      enabled: isTerminalEnabled(),
      workDir: o.getWorkDir(),
      agentWorkDir: o.getAgentWorkDir(),
      shell: process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "/bin/bash",
    },
  }));

  authed.route("/", stateRoutes(() => ({
    taskStore: o.getStore(),
    getConfig: () => o.getConfig(),
    hasMemory: () => o.hasMemory(),
    getMemory: () => o.getMemory(),
    saveMemory: (content: string) => o.saveMemory(content),
    hasAgentMemory: (name: string) => o.hasAgentMemory(name),
    getAgentMemory: (name: string) => o.getAgentMemory(name),
    saveAgentMemory: (name: string, content: string) => o.saveAgentMemory(name, content),
    getLogStore: () => o.getLogStore(),
  })));

  app.route("/api/v1", authed);

  // OpenAPI spec endpoint
  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Polpo API",
      version: "1.0.0",
      description: "REST API for Polpo — an AI agent that manages teams of AI coding agents. Manage tasks, missions, agents, playbooks, skills, notifications, and approvals. For conversational interaction, use the OpenAI-compatible POST /v1/chat/completions endpoint.",
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
    ],
    security: [{ bearerAuth: [] }],
  });

  // Register security scheme for OpenAPI docs
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key passed as a Bearer token. Configure via the apiKeys field in polpo.json or the POLPO_API_KEY environment variable.",
  });

  return app;
}
