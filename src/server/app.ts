import { readFile, unlink } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { interpretChannelCompletion } from "./channel-chat-result.js";
import { getPolpoDir } from "../core/constants.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { streamSimpleWithAuth, completeSimpleWithAuth, resolveSummaryModel } from "../llm/pi-client.js";
import { validateToolArguments } from "@earendil-works/pi-ai";
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
  registerAgentSuiteRoutes,
  type AgentSuiteRouteDeps,
  benchmarkRoutes,
  isTrustedApiCall,
  TRUSTED_API_CALL_HEADER,
  CHAT_ORIGIN_HEADER,
  AGENT_CHAIN_HEADER,
} from "@polpo-ai/server";
import { getCookie } from "hono/cookie";
import { createHmac } from "node:crypto";
import { ALL_SCOPES, SCOPES, handleMcpRequest, hasScope, resolveToolsets, toolScopeMatrix, type McpPrincipal } from "./mcp.js";
import { setPolpoApi } from "../llm/polpo-mcp-bridge.js";
import {
  authorizationServerMetadata, consentPage, consentScopes, CONSENT_SCOPE_FIELD, OAUTH_DEFAULT_SCOPE, OAuthError, OAuthServer, protectedResourceMetadata,
} from "./oauth.js";
import { McpKeyRing, type McpKeyInfo } from "./mcp-keys.js";
import { reactionHint, telegramFilesHint } from "../notifications/telegram-reactions.js";
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
import { preferencesRoutes } from "./routes/preferences.js";
import { pushRoutes } from "./routes/push.js";
import { expoPushRoutes } from "./routes/expo-push.js";
import { agentEgressName, computerContext, tailnetEgressFor } from "@polpo-ai/core/sandbox";
import { harnessUsageByTask } from "@polpo-ai/core/task-cost";
import { computerRoutes, egressRoutes, type ComputerRouteDeps } from "./routes/computers.js";
import { harnessRoutes } from "./routes/harnesses.js";
import { harnessSessionViews } from "../harness/control.js";
import { forwardToRelay, HARNESS_RELAY_PATH } from "../harness/relay.js";
import { computerManagerWithEvents, driverHost } from "../sandbox/computers.js";
import { cliAccountRoutes } from "./routes/cli-accounts.js";
import { cliChatRunner } from "../cli-engine/chat.js";
import { computerWebhooksFor } from "../sandbox/computer-webhooks.js";
import { computerWebhookAdminRoutes, computerWebhookInboundRoutes } from "./routes/computer-webhooks.js";
import { waBusinessAdminRoutes, waBusinessWebhookRoutes } from "./routes/whatsapp-business.js";
import { computerSandbox } from "../sandbox/manager.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { emailRoutes } from "./routes/email.js";
import { codingRoutes } from "./routes/coding.js";
import { roomRoutes } from "./routes/rooms.js";
import { learningRoutes } from "./routes/learning.js";
import { checkRoutes, telegramRoutes } from "./routes/checks.js";
import { driveRoutes } from "./routes/drive.js";
import { syncRoutes } from "./routes/sync.js";
import { browserDashboardRoutes } from "./routes/browser-dashboard.js";
import { browserProfileRoutes } from "./routes/browser-profiles.js";
import { connectorRoutes, connectorOAuthCallback } from "./routes/connectors.js";
import { mcpServerRoutes } from "./routes/mcp-servers.js";
import { mcpServerServiceFor, setHostedSuiteGate } from "./mcp-servers-runtime.js";
import { handlePublicMcpRequest, RateLimiter, PUBLIC_MCP_SERVERS_PATH } from "../mcp-servers/public.js";
import { hostedDeps } from "../mcp-servers/host.js";
import { queryOrchestratorText } from "../llm/query.js";
import { effectiveOrchestratorModel, requireOrchestratorModel } from "../llm/orchestrator-model.js";
import {
  connectorManagerFor, connectorsPromptSection, notePublicOrigin, clientMetadataDocument, connectorDashboardBase, connectorPublicBase,
  CONNECTOR_CLIENT_METADATA_PATH, CONNECTOR_OAUTH_CALLBACK_PATH, knownPublicOrigin,
} from "../mcp/runtime.js";
import { triggerServiceFor, TRIGGER_PUBLIC_PATH } from "../triggers/service.js";
import { triggerAdminRoutes, triggerInboundRoutes } from "./routes/triggers.js";
import { isMcpToolName, toolResultText } from "../mcp/tools.js";
import { connectorLabel } from "../mcp/view.js";
import { AgentTalk } from "./agent-talk.js";
import { agentTesterFor } from "./agent-tests-host.js";
import { agentBenchmarksFor, agentDeployGatesFor, agentSuiteRunnerFor } from "./agent-suites-host.js";
import { DecisionService, decisionServiceFor, registerDecisionService } from "../decisions/service.js";
import { decideRoutes, decisionRoutes } from "./routes/decisions.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  SUITE_PLACEHOLDER_MODEL, applySuiteOverrides, currentSuiteCase, suiteCompleteLLM, suiteStreamLLM, suiteToolExecutor,
} from "../core/agent-suite-context.js";
import { orchestratorName } from "../core/orchestrator-name.js";
import { resolveBrowserEgress } from "../tools/browser-egress.js";
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
import { searchRoutes } from "./routes/search.js";
import { SearchEngine } from "./search/engine.js";
import { buildSearchSources } from "./search/sources.js";
import { FileAttachmentStore } from "../stores/file-attachment-store.js";
import { saveChatUserMessage, resolveChatAttachmentReferences } from "./chat-attachments.js";
import { transcribeSpeech } from "../tools/audio-tools.js";
import { speechVaultFor } from "../notifications/speech-vault.js";
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
import type { PolpoEventMap } from "@polpo-ai/core";
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
/** Orchestrators whose deleted missions / hosted servers already drop their suites (createApp may run more than once). */
const suiteCleanupWired = new WeakSet<Orchestrator>();

export function createApp(orchestrator: Orchestrator, sseBridge: SSEBridge, opts?: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono();
  const activeWorkDir = () => orchestrator.isInitialized ? orchestrator.getWorkDir() : opts?.workDir;
  const activePolpoDir = () => getPolpoDir(activeWorkDir() ?? opts?.workDir ?? process.cwd());
  /** Agents talking to each other during a chat (set up once the completions pipeline exists). */
  let agentTalk: AgentTalk | undefined;
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

  // ── Model relay for agent harnesses (public) ─────────────────────────
  // Computers' Claude Code / Codex / OpenCode reach their model through here with placeholders instead of the
  // key: the per-run token in the path selects the run's relay lease (src/harness/relay.ts), which
  // swaps the credential outside the VM. Before the rate limit: long agent turns make many calls.
  // Exposed publicly at <POLPO_PUBLIC_URL>/api/v1/harness-relay/ (docs/harnesses.md).
  app.all(`${HARNESS_RELAY_PATH}/*`, (c) => forwardToRelay({
    polpoDir: activePolpoDir(), path: c.req.path.slice(HARNESS_RELAY_PATH.length), request: c.req.raw,
  }));

  // ── WhatsApp Business webhooks (public) ───────────────────────────────
  // Meta's verify token and signature authenticate; before the global per-IP rate limit (Meta posts
  // from a few addresses in bursts), with a limit of its own per channel (whatsapp-business-service.ts).
  const waBusiness = () => (orchestrator?.isInitialized ? orchestrator.getWaBusiness() : undefined);
  app.route("/api/v1/channels/whatsapp-business/webhooks", waBusinessWebhookRoutes({ service: waBusiness }));

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

  // Computers' provider webhooks (Daytona, E2B): public, authenticated by the provider's signature
  const computerWebhooks = () => {
    if (!orchestrator?.isInitialized) return undefined;
    const log = (level: "info" | "warn", message: string) => orchestrator.emit("log", { level, message: `[computers] ${message}` });
    return computerWebhooksFor(orchestrator, () => computerManagerWithEvents(
      orchestrator.getPolpoDir(), (payload) => orchestrator.emit("computer:changed", payload), log,
      () => orchestrator.getConfig()?.settings?.computers ?? [],
    ), log);
  };
  app.route("/api/v1/computers/webhooks", computerWebhookInboundRoutes({ webhooks: computerWebhooks }));

  // Triggers: POST /hooks/:id, public (outside /api and the auth gate), authenticated by the
  // trigger's own secret / HMAC signature / IP allowlist, with its own rate limit and body cap.
  // The only public path of the feature: behind Tailscale Funnel publish /<instance>/hooks/ (docs/triggers.md).
  const triggerService = () => {
    if (!orchestrator?.isInitialized) return undefined;
    const polpoDir = orchestrator.getPolpoDir();
    return triggerServiceFor(polpoDir, {
      polpoDir: () => polpoDir,
      vault: () => orchestrator.getVaultStore?.(),
      publicBase: () => knownPublicOrigin(),
      emit: (kind, payload) => {
        if (kind === "changed") orchestrator.emit("trigger:changed", payload as PolpoEventMap["trigger:changed"]);
        else orchestrator.emit("trigger:delivery", payload as PolpoEventMap["trigger:delivery"]);
      },
    });
  };
  app.route(TRIGGER_PUBLIC_PATH, triggerInboundRoutes({ service: triggerService }));

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
    saveUserMessage: (sessionId, content, options) => saveChatUserMessage(o.getSessionStore()!,
      o.getAttachmentStore() ?? new FileAttachmentStore(o.getPolpoDir()), o.getWorkDir(), sessionId, content, {
        transcribe: async (audio, filename) => (await transcribeSpeech(audio, filename, await speechVaultFor(o, options?.agent)))?.text ?? null,
      }),
    getAgents: () => o.getAgents(),
    // "writer@draft" (the Tests tab's smoke run): the draft over the live agent's runtime fields
    // a suite case's variant (agent suites): its per-run overrides on top (nothing is saved)
    resolveAgent: async (name: string, ref?: string) => {
      // a suite role played by a model + engine block: its ephemeral agent (this turn only)
      const roleAgent = currentSuiteCase()?.roleAgent;
      if (roleAgent && name === roleAgent.name && !ref) return { agent: roleAgent };
      const overrides = currentSuiteCase()?.overrides;
      const withOverrides = <T extends { agent: any } | undefined>(r: T): T => (r && overrides ? { ...r, agent: applySuiteOverrides(r.agent, overrides) } : r);
      if (ref !== "draft") return withOverrides(await o.getAgentVersioning().resolve(name, ref));
      const live = (await o.getAgents()).find((a) => a.name === name);
      if (!live) return undefined;
      const { config } = await o.getAgentVersioning().draftConfig(name);
      return withOverrides({ agent: { ...live, ...config, name } });
    },
    getConfig: () => o.getConfig(),
    getMemoryStore: () => o.getMemoryStore(),
    getSessionStore: () => o.getSessionStore(),
    getStore: () => o.getStore(),
    emit: (event: string, data: any) => o.emit(event as any, data),
    connectorNames: () => Object.fromEntries(connectorManagerFor(o).store.list().map((connector) => [connector.id, connectorLabel(connector)])),
    connectorApps: () => Object.fromEntries(connectorManagerFor(o).store.list().flatMap((connector) => (connector.catalogId ? [[connector.id, connector.catalogId]] : []))),
    recordTokenUsage: async (usage) => {
      // a suite case's scripted turns are not spending
      if (currentSuiteCase()?.mocksModel) return;
      await (databaseStoresFor(activePolpoDir())?.tokenUsageStore ?? new FileTokenUsageStore(activePolpoDir())).record(usage);
      o.emit("token-usage:recorded", { timestamp: new Date().toISOString() });
    },
    resolveAgentModel: async (agentConfig: any, reasoning?: string) => {
      const { resolveModel, buildStreamOpts } = await import("../llm/pi-client.js");
      let m: any;
      try {
        m = resolveModel(agentConfig.model);
      } catch (err) {
        // a suite case that scripts the model runs offline: no provider needed
        if (!currentSuiteCase()?.mocksModel) throw err;
        m = SUITE_PLACEHOLDER_MODEL;
      }
      const r = agentConfig.reasoning ?? reasoning;
      return { model: m, streamOpts: buildStreamOpts(undefined, r, m.maxTokens) };
    },
    // agents on the CLI engine: their chats run the official program with the agent's account
    cliChat: (agentConfig: any) => cliChatRunner(agentConfig, {
      polpoDir: o.getPolpoDir(),
      workDir: () => o.getAgentWorkDir(),
      settings: () => o.getConfig()?.settings,
      vaultStore: () => o.getVaultStore(),
      chatSandbox: (agent) => o.chatSandbox(agent),
      chatOutputDir: (name) => o.chatOutputDir(name),
      instanceAuth: () => isInstanceAuthEnabled(),
    }),
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
      // the connectors it may use (state from the last connection; tools come with resolveAgentTools)
      let connectorsNote = "";
      try {
        const section = connectorsPromptSection(connectorManagerFor(o).store.list(), agentConfig.name, [], agentConfig.connectorTools);
        if (section) connectorsNote = `\n\n${section}`;
      } catch { /* no connectors file: nothing to say */ }
      return buildSystemPrompt(agentConfig, o.getAgentWorkDir(), o.getPolpoDir(), undefined, undefined, mailboxes)
        + sandboxPromptNote(sandbox, remote ? volumes.filter((v) => v.remote) : volumes.filter((v) => v.hostPath),
          remote ? { outputDir: o.chatOutputDir(agentConfig.name) } : {})
        + connectorsNote;
    },
    resolveAgentTools: async (agentConfig: any, context?: { sessionId: () => string | undefined; origin?: import("@polpo-ai/core").ConversationCheckTarget; chain?: string[] }) => {
      // a suite role's turn (judge, simulated user, generator, reviewer): text only, no tools
      const role = currentSuiteCase()?.role;
      if (role) return { tools: [], executor: async (name: string) => `Error: ${name} is not available: this turn plays a test suite's ${role}, without tools.`, isInteractive: () => false };
      const { createAllTools } = await import("../tools/system-tools.js");
      const { createMemoryTools } = await import("../tools/memory-tools.js");
      const { createDataAgentTools } = await import("../tools/data-tools.js");
      const { createArtifactAgentTools, workspaceFileReader } = await import("../tools/artifact-tools.js");
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
      const chatResolved = await o.chatSandbox(agentConfig).catch(() => undefined);
      const chatSandboxProvider = chatResolved?.sandbox.provider ?? "bwrap";
      const chatComputer = chatResolved?.sandbox.computer;
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
        // a remote computer's egress (through Tailscale in its VM), else the agent's own or its host computer's
        browserEgress: tailnetEgressFor(chatComputer, o.getConfig()?.settings, o.getConfig()?.project)
          ?? resolveBrowserEgress({ browserEgress: agentEgressName(agentConfig, o.getConfig()?.settings) }, o.getConfig()?.settings?.egressProxies),
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
        // artifact_from_file: a file of its chat workspace (the Cowork VM's or this machine's), copied out
        readFile: workspaceFileReader({
          cwd: o.getAgentWorkDir(), tempDir: join(polpoDir, "tmp"),
          remote: { readFileBuffer: async (p: string) => chatFs.readFileBuffer ? chatFs.readFileBuffer(p) : Buffer.from(await chatFs.readFile(p)) },
        }),
      })));
      // Buckets through host-side tools: credentials stay on the host.
      tools.push(...createStorageAgentTools(polpoDir, agentConfig.name, agentConfig.allowedTools, {
        vaultStore: o.getVaultStore(),
        cwd: o.getAgentWorkDir(),
        emit: (payload) => o.emit("storage:changed", payload),
        emitFileChanged: (payload) => o.emit("file:changed", payload),
        fs: chatFs,
      }));
      // decide: typed judgments from the decision model (allowedTools "decide")
      const { createDecisionTools } = await import("../tools/decision-tools.js");
      tools.push(...createDecisionTools(polpoDir, agentConfig.name, agentConfig.allowedTools));
      // Connectors granted to this agent (mcp__<connector>__<tool>), filtered by allowedTools. A
      // connector that cannot connect is skipped (and logged): it never breaks the chat.
      try {
        const { tools: connectorTools } = await connectorManagerFor(o).toolsFor(agentConfig.name, agentConfig.allowedTools, agentConfig.connectorTools);
        const taken = new Set(tools.map((tool: any) => tool.name));
        tools.push(...connectorTools.filter((tool) => !taken.has(tool.name)));
      } catch (err) {
        console.warn(`[connectors] ${agentConfig.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      // WhatsApp Business (wabiz_*): only when allowedTools names them (never through whatsapp_*), host-side
      if (agentConfig.allowedTools?.some((t: string) => t.toLowerCase().startsWith("wabiz"))) {
        const { createWabizTools } = await import("../tools/wabiz-tools.js");
        tools.push(...createWabizTools({ service: () => o.getWaBusiness(), sender: agentConfig.name }, agentConfig.allowedTools)
          .filter((tool) => !existingToolNames.has(tool.name)));
      }
      // Talking to other agents in the middle of the chat (nobody waits: answers arrive live)
      if (agentTalk && !existingToolNames.has("ask_agent")) {
        const { createAgentTalkTools } = await import("../tools/agent-talk-tools.js");
        const talk = agentTalk;
        tools.push(...createAgentTalkTools(talk, () => ({
          agent: agentConfig.name, chain: context?.chain ?? [], sessionId: context?.sessionId?.(), origin: context?.origin,
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
          if (isMcpToolName(name)) return toolResultText(result);
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
      // agent suites: a case's tool mocks answer before anything runs (no side effect)
      return { tools, executor: suiteToolExecutor(attributed), isInteractive };
    },
    // agent suites: scripted turns (model mock), observed real turns and budgets
    streamLLM: suiteStreamLLM(streamSimpleWithAuth as any),
    // A tool call whose arguments do not match the tool's schema is returned to the model instead of run.
    // Only a validation failure counts: if the validator itself fails, the call goes through as before.
    validateToolArguments: (tool: any, call: any) => {
      try {
        return validateToolArguments(tool, call);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Validation failed")) throw err;
        return call.arguments;
      }
    },
    completeLLM: suiteCompleteLLM(completeSimpleWithAuth as any),
    resolveSummaryModel: (conversation: any, configured: string | undefined, promptTokens: number) =>
      resolveSummaryModel(conversation, configured, promptTokens),
    // only Telegram turns carry an origin (see ChannelGateway.checkTarget)
    channelTurnPrompt: () => `## Channel\nThis turn comes from Telegram: your answer is sent as a Telegram message. ${reactionHint()}\n${telegramFilesHint()}`,
    resolveOrchestratorContext: async () => {
      const { buildChatSystemPrompt } = await import("../llm/prompts.js");
      const { resolveModel, resolveModelSpec, buildStreamOpts } = await import("../llm/pi-client.js");
      const { ALL_ORCHESTRATOR_TOOLS, executeOrchestratorTool, isInteractive } = await import("../llm/orchestrator-tools.js");
      const state = await (async () => { try { return await o.getStore()?.getState() ?? null; } catch { return null; } })();
      let systemPrompt = await buildChatSystemPrompt(o, state);
      const settings = o.getConfig()?.settings;
      const modelSpec = resolveModelSpec(effectiveOrchestratorModel(settings?.orchestratorModel) ?? settings?.orchestratorModel);
      const m = resolveModel(modelSpec);
      // Connectors granted to Polpo (access.polpo): their tools are appended to Polpo's static ones
      const connectorManager = connectorManagerFor(o);
      const connectorTools = await connectorManager.toolsFor(undefined).catch((err) => {
        console.warn(`[connectors] polpo: ${err instanceof Error ? err.message : String(err)}`);
        return { tools: [], notes: [] };
      });
      const connectorSection = connectorsPromptSection(connectorManager.store.list(), undefined, connectorTools.notes);
      if (connectorSection) systemPrompt += `\n\n${connectorSection}`;
      const connectorToolMap = new Map(connectorTools.tools.map((tool) => [tool.name, tool]));
      const runTool = async (name: string, args: Record<string, unknown>, context: any): Promise<string> => {
        const connectorTool = connectorToolMap.get(name);
        if (!connectorTool) return executeOrchestratorTool(name, args, o, context);
        try {
          return toolResultText(await connectorTool.execute(`polpo-${Date.now()}`, args as any));
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      };
      // a suite role's turn played by Polpo (judge, simulated user, generator, reviewer): text only, no tools
      const role = currentSuiteCase()?.role;
      return {
        systemPrompt,
        model: m,
        streamOpts: buildStreamOpts(undefined, settings?.reasoning, m.maxTokens),
        tools: role ? [] : [...ALL_ORCHESTRATOR_TOOLS, ...connectorTools.tools],
        executor: (name: string, args: Record<string, unknown>, context) =>
          withEventOrigin({ source: "polpo" }, () => runTool(name, args, context)),
        isInteractive,
      };
    },
  }), opts?.apiKeys);
  // Chat turns from outside (web UI, API clients) are "api"; internal channel turns keep their origin
  app.use("/v1/chat/completions", (c, next) => {
    // Polpo's connector_add needs the OAuth redirect URI as people reach this instance
    if (!currentEventOrigin()) notePublicOrigin(publicOrigin(c));
    if (currentEventOrigin()) return next();
    // the signed-in member chatting (instance sign-in): what Polpo's tools create is theirs (requestedBy, mission owner)
    const email = c.get("polpoUserEmail" as never) as string | undefined;
    return withEventOrigin({ source: "api", ...(email ? { by: email } : {}) }, () => next());
  });
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
  // Keys that open the MCP connector, each with its scopes: the server's API keys (every scope),
  // POLPO_MCP_KEY (comma-separated; POLPO_MCP_KEY_SCOPES, else every scope) for an instance that exposes
  // only its connector, with no API key on the dashboard and REST API, and named keys in settings.mcp.keys
  // (values in the vault). See mcp-keys.ts.
  const mcpKeys = new McpKeyRing({
    apiKeys: () => opts?.apiKeys ?? [],
    env: () => process.env,
    settings: () => orchestrator?.getConfig?.()?.settings?.mcp?.keys,
    vault: () => orchestrator?.getVaultStore?.(),
    warn: (message) => console.warn(`[polpo/mcp] ${message}`),
  });
  /** The principal for a key: who acts (named keys by name) and its scopes. */
  const keyPrincipal = (key: McpKeyInfo): McpPrincipal => ({
    kind: "key", actor: key.source === "settings" ? `mcp-key:${key.name}` : "mcp-key", keyName: key.name, scopes: [...key.scopes],
  });
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
  const consentIdentity = async (c: any): Promise<{ method: "session" | "api-key" | "open"; email?: string }> => {
    const instanceAuth = isInstanceAuthEnabled();
    const session = instanceAuth && opts?.workDir ? validateSession(getPolpoDir(opts.workDir), getCookie(c, AUTH_COOKIE_NAME)) : null;
    if (session) return { method: "session", email: session.email };
    if (!instanceAuth && !(await mcpKeys.any())) return { method: "open" };
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
      const who = await consentIdentity(c);
      const requested = oauthServer().requestedScopes(params.scope);
      return c.html(consentPage({ client, redirectUri: params.redirect_uri!, params: { ...params, csrf: consentCsrf(c) }, requested, ...who }));
    } catch (err) {
      return c.html(`<!doctype html><meta charset="utf-8"><title>Polpo</title><p>This connection request is not valid: ${err instanceof Error ? err.message.replace(/[<>&]/g, "") : "error"}</p>`, 400);
    }
  });
  app.post("/oauth/authorize", async (c) => {
    // all: the scope checkboxes repeat one field name
    const form = await c.req.parseBody({ all: true });
    const params = authorizeParams(form);
    // what the person left checked (read always), shown again if the page comes back with an error
    const chosen = consentScopes(form[CONSENT_SCOPE_FIELD]);
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
    const who = await consentIdentity(c);
    if (typeof form.csrf !== "string" || form.csrf !== consentCsrf(c)) {
      return c.html(consentPage({ client, redirectUri: params.redirect_uri!, params: { ...params, csrf: consentCsrf(c) }, requested: chosen, ...who, error: "This page expired: try again." }), 400);
    }
    let subject = who.email ?? "local";
    let granted = chosen;
    if (who.method === "api-key") {
      // pasted from an env file or with spaces: KEY=value, or the bare value
      const key = typeof form.api_key === "string" ? form.api_key.trim().replace(/^(POLPO_MCP_KEY|POLPO_API_KEY)=/, "") : "";
      const matched = key ? await mcpKeys.match(key) : undefined;
      if (!matched) return c.html(consentPage({ client, redirectUri: params.redirect_uri!, params: { ...params, csrf: consentCsrf(c) }, requested: chosen, method: "api-key", error: "That API key is not valid." }), 401);
      subject = "api-key";
      // a key allows a client only what the key itself may do
      granted = chosen.filter((scope) => hasScope({ scopes: matched.scopes }, scope));
    }
    back.searchParams.set("code", oauthServer().issueCode(params, resource, subject, granted));
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
  // Who calls, for attribution (events' `by`, approvals' resolvedBy, artifacts' author) and scopes:
  // an OAuth client (and the person who allowed it), an API or MCP key, a dashboard session, or
  // nobody on a server without auth and keys (localhost-only). Null: not allowed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono context
  const mcpPrincipal = async (c: any): Promise<McpPrincipal | null> => {
    const instanceAuth = isInstanceAuthEnabled();
    const key = await mcpKeys.match(c.req.raw);
    if (key) return keyPrincipal(key);
    // an OAuth access token issued for this endpoint (Claude, ChatGPT and other connectors)
    const auth = c.req.header("authorization") as string | undefined;
    const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
    const grant = bearer?.startsWith("polpo_at_") ? oauthServer().verifyAccessToken(bearer, `${publicOrigin(c)}/mcp`) : null;
    if (grant) {
      const client = oauthServer().clientName(grant.client_id);
      const actor = grant.subject.includes("@") ? `${grant.subject} via ${client}`
        : grant.subject === "api-key" ? `${client} (MCP key)` : `${client} (MCP)`;
      return { kind: "oauth", actor, subject: grant.subject, client, scopes: grant.scope.split(/\s+/).filter(Boolean) };
    }
    const session = instanceAuth && opts?.workDir ? validateSession(getPolpoDir(opts.workDir), getCookie(c, AUTH_COOKIE_NAME)) : null;
    if (session) return { kind: "session", actor: session.email, subject: session.email, scopes: [...ALL_SCOPES] };
    if (!instanceAuth && !(await mcpKeys.any())) return { kind: "open", actor: "mcp", scopes: [...ALL_SCOPES] };
    return null;
  };
  // The REST API called in process, by a client already authenticated (the MCP tools, and Polpo's own
  // tools that run them: src/llm/polpo-mcp-bridge.ts); a FormData or binary body goes as is, anything else as JSON.
  const inProcessApi = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const form = body instanceof FormData;
    const binary = body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob;
    const res = await app.request(path, {
      method,
      headers: {
        ...(body !== undefined && !form && !binary ? { "content-type": "application/json" } : {}),
        ...trustedApiCallHeaders(),
        ...(opts?.apiKeys?.[0] ? { authorization: `Bearer ${opts.apiKeys[0]}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: form || binary ? body as BodyInit : JSON.stringify(body) } : {}),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const raw = new TextDecoder().decode(bytes);
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers, bytes };
  };
  // Polpo's chat (web, channels) runs the MCP server's tools with it: everything MCP can do, Polpo can
  if (orchestrator) setPolpoApi(inProcessApi);
  app.all("/mcp", async (c) => {
    const principal = await mcpPrincipal(c);
    const resourceMetadataUrl = `${publicOrigin(c)}/.well-known/oauth-protected-resource/mcp`;
    if (!principal) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="${OAUTH_DEFAULT_SCOPE}"`);
      return c.json({ error: "Authentication required: send Authorization: Bearer <your Polpo API key>" }, 401);
    }
    if (!orchestrator?.isInitialized) return c.json({ error: "Polpo is not initialized. Complete setup first." }, 503);
    // what it does is recorded as the principal, with the scopes it acted under
    return withEventOrigin({ source: "api", by: principal.actor, scopes: principal.scopes }, () => handleMcpRequest(c.req.raw, {
      version: POLPO_PACKAGE_VERSION,
      log: (line) => console.log(`[polpo/mcp] ${line}`),
      routes: () => app.routes,
      principal,
      resourceMetadataUrl,
      toolsets: resolveToolsets(process.env.POLPO_MCP_TOOLSETS, orchestrator.getConfig()?.settings?.mcp?.toolsets),
      publicUrl: publicOrigin(c),
      // where the dashboard is, when not on the API's origin (the UI server on its own port)
      dashboardUrl: process.env.POLPO_DASHBOARD_URL?.trim() || process.env.POLPO_UI_PUBLIC_URL?.trim() || undefined,
      api: inProcessApi,
    }));
  });

  // ── Hosted MCP servers: the public endpoint ───────────────────────────
  // POLPO_PUBLIC_URL/mcp/servers/<id>: only servers marked public answer (others 404), with the
  // instance's credentials, rate limited per IP and globally; destructive / approval tools are not
  // offered unless a tool allows it. No API key: it is public on purpose (see docs/custom-mcp-servers.md).
  const publicMcpLimiter = new RateLimiter();
  app.all(`${PUBLIC_MCP_SERVERS_PATH}/:id`, async (c) => {
    if (!orchestrator?.isInitialized) return c.json({ error: "Polpo is not initialized" }, 503);
    mcpServerServiceFor(orchestrator); // approvals wired
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the node server's socket
    const socketIp = (c.env as any)?.incoming?.socket?.remoteAddress as string | undefined;
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || socketIp || "unknown";
    return handlePublicMcpRequest(c.req.raw, {
      serverId: c.req.param("id"), ip, limiter: publicMcpLimiter,
      deps: hostedDeps(orchestrator.getPolpoDir(), orchestrator.getVaultStore()),
      log: (line) => console.log(`[polpo/mcp-servers] ${line}`),
    });
  });

  // ── Connectors: the OAuth callback ────────────────────────────────────
  // The browser comes back here from the provider (Linear, Notion, Google…) without the API key or
  // a session: it is public, and authenticated by the single-use, 10-minute state it carries.
  app.get(CONNECTOR_OAUTH_CALLBACK_PATH, async (c, next) => {
    if (!orchestrator?.isInitialized) return next();
    // back to the dashboard (POLPO_DASHBOARD_URL), not to the API's public origin
    return connectorOAuthCallback({ manager: () => connectorManagerFor(o), uiUrl: (ctx) => connectorDashboardBase(publicOrigin(ctx)) })(c);
  });
  // Our OAuth Client ID Metadata Document: servers that support CIMD fetch it (its URL is our client_id)
  app.get(CONNECTOR_CLIENT_METADATA_PATH, (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(clientMetadataDocument(connectorPublicBase(publicOrigin(c))));
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

  // Agents talking to each other during a chat: their turns go through the same completions pipeline
  agentTalk = new AgentTalk(activePolpoDir(), {
    turn: async ({ agent, sessionId, messages, chain, origin, signal }) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-session-id": sessionId,
        [AGENT_CHAIN_HEADER]: chain.join(","),
        "x-polpo-lease-wait": String(10 * 60 * 1000),
        ...(origin ? { [CHAT_ORIGIN_HEADER]: encodeURIComponent(JSON.stringify(origin)) } : {}),
        ...internalCallHeaders(),
      };
      if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
      const response = await completionApp.request(new Request("http://polpo.internal/", {
        method: "POST", headers, ...(signal ? { signal } : {}),
        body: JSON.stringify({ stream: false, ...(agent ? { agent } : {}), messages }),
      }));
      const payload = await response.json().catch(() => null) as any;
      if (!response.ok) throw new Error(payload?.error?.message ?? `turn failed (${response.status})`);
      const content = payload?.choices?.[0]?.message?.content;
      return { text: typeof content === "string" ? content : "", sessionId: response.headers.get("x-session-id") ?? sessionId };
    },
    history: async (sessionId) => {
      const messages = await o.getSessionStore()?.getMessages(sessionId) ?? [];
      return messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    },
    agents: async () => (await o.getAgents()).map((a) => ({ name: a.name, ...(a.role ? { role: a.role } : {}) })),
    orchestratorName: () => orchestratorName(o.getConfig()?.settings),
    // The answer joins the conversation now: into the running answer, else as the next turn
    // (streamed, so an open chat shows it live), whatever auto-send says.
    deliver: async (sessionId, content) => {
      const queue = o.getChatQueueStore();
      if (!queue) throw new Error("Chat queue not available");
      const item = await queue.add(sessionId, content, { front: true });
      o.emit("chat:queue-updated" as any, { sessionId } as any);
      await turnScheduler.sendNow(sessionId, item.id);
    },
    post: (origin, text, agent) => o.sendToChat(origin, text, agent),
    emit: (event, data) => o.emit(event as any, data as any),
    log: (line) => console.warn(`[polpo/agent-talk] ${line}`),
  });
  o?.setAgentTalk?.(agentTalk);

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
    // Daytona deactivates snapshots nobody used for a while: say so (the next create reactivates it)
    const available = availableProviders();
    const daytonaSnapshot = instance?.providers?.daytona?.snapshot;
    let snapshot: { provider: "daytona"; name: string; state: string } | undefined;
    if (available.has("daytona") && typeof daytonaSnapshot === "string" && daytonaSnapshot) {
      const { remoteAdapter } = await import("../sandbox/remote-adapters.js");
      const state = await Promise.race([
        remoteAdapter("daytona").snapshotState?.(daytonaSnapshot).catch(() => undefined),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000).unref?.()),
      ]);
      if (state) snapshot = { provider: "daytona", name: daytonaSnapshot, state };
    }
    return c.json({ ok: true, data: {
      ...(snapshot ? { snapshot } : {}),
      available: [...available],
      settings: instance ?? null,
      polpo: effectiveSandbox({ scope: "chat", cascade: { instance }, agentTools: instance?.allowLocal ? [] : ["http_fetch"] }),
      agents: agents.map((agent) => {
        const cascade = { instance, agent: normalizeSandboxSettings(agent.sandbox) };
        return {
          name: agent.name,
          settings: cascade.agent ?? null,
          task: effectiveSandbox({ scope: "task", cascade, agentTools: agent.allowedTools, computers: computerContext(agent, o.getConfig()?.settings) }),
          chat: effectiveSandbox({ scope: "chat", cascade, agentTools: agent.allowedTools, computers: computerContext(agent, o.getConfig()?.settings) }),
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

  /**
   * Harness cost per task id from the token-usage records (agent_harness, the task id as session),
   * which are not capped: a task keeps only its latest runs, these give back the dropped ones'.
   */
  const harnessUsageOf = async (taskIds: string[]) => {
    const store = databaseStoresFor(activePolpoDir())?.tokenUsageStore ?? new FileTokenUsageStore(activePolpoDir());
    return harnessUsageByTask(await store.list("all").catch(() => []), taskIds);
  };

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
    updateTaskToolScope: (id: string, scope: unknown) => o.updateTaskToolScope(id, scope),
    taskToolScopeStale: (task: any) => o.taskToolScopeStale(task),
    getTaskHarnessUsage: async (id: string) => (await harnessUsageOf([id]))[id],
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
    getMissionCost: async (mid: string) => {
      const cost = await o.getMissionCost(mid);
      if (!cost?.partialTaskIds?.length) return cost;
      // a task kept only its latest runs: its harness cost comes back from the usage records
      // (agent_harness, the task id as session), which are not capped
      const harnessUsage = await harnessUsageOf(cost.partialTaskIds);
      return Object.keys(harnessUsage).length ? o.getMissionCost(mid, { harnessUsage }) : cost;
    },
    getMissionCostSummaries: (missions: any[]) => o.getMissionCostSummaries(missions),
  })));

  /** Who makes a request (versions of skills and agents, deploys): a person, Polpo's chat, an agent, or an MCP client. */
  const requestAuthor = (c: { req: { header: (name: string) => string | undefined }; get: (key: never) => unknown }): string => {
    if (isTrustedApiCall(c.req.header(TRUSTED_API_CALL_HEADER))) {
      const origin = currentEventOrigin();
      if (origin?.source === "polpo") return "polpo";
      if (origin?.source === "agent" && origin.by) return origin.by;
      return `mcp:${origin?.by ?? "client"}`;
    }
    const email = c.get("polpoUserEmail" as never) as string | undefined;
    return email ? `person:${email}` : "person:dashboard";
  };

  /**
   * An admin may override a deploy gate and let a gate run real tools: instance members have no
   * roles (every member configures the instance) and an API key is the owner's; an MCP client got
   * here only with polpo:admin (the MCP layer checks), Polpo's chat is admin; an agent never is.
   */
  const requestIsAdmin = (c: { req: { header: (name: string) => string | undefined } }): boolean => {
    if (isTrustedApiCall(c.req.header(TRUSTED_API_CALL_HEADER))) {
      const origin = currentEventOrigin();
      if (origin?.source === "agent") return false;
      // an MCP client's call carries the scopes it acted under
      return !origin?.scopes || origin.scopes.includes("polpo:admin") || origin.scopes.includes("polpo");
    }
    return true;
  };

  authed.route("/agents", agentRoutes(() => ({
    getAgents: () => o.getAgents(),
    addAgent: (agent: any, teamName?: string) => o.addAgent(agent, teamName),
    removeAgent: async (name: string) => {
      const removed = await o.removeAgent(name);
      if (removed) await agentTester().forget(name).catch(() => undefined);
      if (removed) await agentSuites().forget(name).catch(() => undefined);
      return removed;
    },
    updateAgent: (name: string, updates: any) => o.updateAgent(name, updates),
    getTeams: () => o.getTeams(),
    getTeam: (name?: string) => o.getTeam(name),
    addTeam: (team: any) => o.addTeam(team),
    removeTeam: (name: string) => o.removeTeam(name),
    renameTeam: (oldName: string, newName: string) => o.renameTeam(oldName, newName),
    taskStore: o.getStore(),
    runStore: o.getRunStore(),
    polpoDir: o.getPolpoDir(),
    computerIds: () => (o.getConfig()?.settings?.computers ?? []).map((c) => c.id),
    fs: new NodeFileSystem(),
    versions: {
      versioning: () => o.getAgentVersioning(),
      update: (name, updates, opts) => o.updateAgentVersioned(name, updates, opts),
      // through the deploy gate: the agent's required suites run first (docs/agent-suites.md, "CI gate")
      deploy: (name, version, req) => o.requestAgentDeploy(name, version, req),
      rollback: (name, opts) => o.rollbackAgentVersion(name, opts),
      autoDeploy: () => o.autoDeployApiUpdates(),
      actor: (c) => requestAuthor(c),
      isAdmin: (c) => requestIsAdmin(c),
      gates: {
        list: (name, opts) => deployGates().list(name, opts),
        get: (name, id) => deployGates().get(name, id),
        cancel: (name, id, actor) => deployGates().cancel(name, id, actor),
        override: (name, id, req) => deployGates().override(name, id, req),
        versionStatuses: (name) => deployGates().versionStatuses(name),
        pending: (name) => deployGates().pending(name),
        attach: (name, entries) => deployGates().attach(name, entries),
        published: (name, version, actor) => deployGates().published(name, version, actor),
        wait: (name, id, ms) => deployGates().wait(name, id, ms),
        outcome: (gate) => deployGates().outcome(gate),
        required: async (name) => (await deployGates().requiredSuites(name)).map((s) => ({
          id: s.id, name: s.name, onPublish: s.gate?.onPublish === true, allowRealTools: s.gate?.allowRealTools === true,
        })),
      },
      // publish / discard do not write the live agent: refresh live clients (deploys already do)
      changed: (name, what) => { if (what !== "deployed") void o.notifyAgentChanged(name); },
    },
    // the Tests tab: check everything the agent has at its disposal (docs/agent-tests.md)
    tests: {
      run: (name, req, opts) => agentTester().run(name, req, opts),
      history: (name, limit) => agentTester().history(name, limit),
      get: (name, id) => agentTester().get(name, id),
      fix: (name, action) => agentTester().fix(name, action),
      actor: (c) => requestAuthor(c),
      member: (c) => c.get("polpoUserEmail" as never) as string | undefined,
    },
    // the Suites tab: tests and evals with mocks, run against a version (docs/agent-suites.md)
    suites: {
      list: (name) => agentSuites().listSuites(name),
      get: (name, id) => agentSuites().getSuite(name, id),
      save: (name, input, opts) => agentSuites().saveSuite(name, input, opts),
      remove: (name, id) => agentSuites().deleteSuite(name, id),
      importDataset: (name, id, req, opts) => agentSuites().importDataset(name, id, req, opts),
      startRun: (name, id, req, opts) => agentSuites().startRun(name, id, req, opts),
      listRuns: (name, opts) => agentSuites().listRuns(name, opts),
      getRun: (name, runId) => agentSuites().getRun(name, runId),
      cancelRun: (name, runId) => agentSuites().cancelRun(name, runId),
      // evals: baselines, comparisons, trends, "explain this run"
      setBaseline: (name, id, runId) => agentSuites().setBaseline(name, id, runId),
      getBaseline: (name, id) => agentSuites().getBaseline(name, id),
      compareRuns: (name, runId, opts) => agentSuites().compareRuns(name, runId, opts),
      trend: (name, id, opts) => agentSuites().trend(name, id, opts),
      reviewRun: (name, runId, opts) => agentSuites().reviewRun(name, runId, opts),
      toYaml: (value) => stringifyYaml(value, { lineWidth: 0 }),
      fromYaml: (text) => parseYaml(text),
      actor: (c) => requestAuthor(c),
      isAdmin: (c) => requestIsAdmin(c),
      ...suitePhase4Deps(),
    },
  })));
  // phase 4 (docs/agent-suites.md): cassettes (record / replay), recordings from chats and tasks, generation
  function suitePhase4Deps(): Partial<AgentSuiteRouteDeps> {
    return {
      listCassettes: (name) => agentSuites().listCassettes(name),
      getCassette: (name, id) => agentSuites().getCassette(name, id),
      caseCassette: (name, suiteId, caseId) => agentSuites().caseCassette(name, suiteId, caseId),
      editCassette: (name, id, edits, opts) => agentSuites().editCassette(name, id, edits, opts),
      deleteCassette: (name, id) => agentSuites().deleteCassette(name, id),
      recordCase: (name, suiteId, caseId, req, opts) => agentSuites().recordCase(name, suiteId, caseId, req, opts),
      caseFromRecording: (name, suiteId, req, opts) => agentSuites().caseFromRecording(name, suiteId, req, opts),
      generateCases: (name, req) => agentSuites().generateCases(name, req),
      acceptCases: (name, suiteId, req, opts) => agentSuites().acceptCases(name, suiteId, req, opts),
      generateDatasetRows: (name, suiteId, req) => agentSuites().generateDatasetRows(name, suiteId, req),
    };
  }
  const suiteRouteDeps = (): AgentSuiteRouteDeps => ({
    list: (name) => agentSuites().listSuites(name),
    get: (name, id) => agentSuites().getSuite(name, id),
    save: (name, input, opts) => agentSuites().saveSuite(name, input, opts),
    remove: (name, id) => agentSuites().deleteSuite(name, id),
    importDataset: (name, id, req, opts) => agentSuites().importDataset(name, id, req, opts),
    startRun: (name, id, req, opts) => agentSuites().startRun(name, id, req, opts),
    listRuns: (name, opts) => agentSuites().listRuns(name, opts),
    getRun: (name, runId) => agentSuites().getRun(name, runId),
    cancelRun: (name, runId) => agentSuites().cancelRun(name, runId),
    setBaseline: (name, id, runId) => agentSuites().setBaseline(name, id, runId),
    getBaseline: (name, id) => agentSuites().getBaseline(name, id),
    compareRuns: (name, runId, opts) => agentSuites().compareRuns(name, runId, opts),
    trend: (name, id, opts) => agentSuites().trend(name, id, opts),
    reviewRun: (name, runId, opts) => agentSuites().reviewRun(name, runId, opts),
    toYaml: (value) => stringifyYaml(value, { lineWidth: 0 }),
    fromYaml: (text) => parseYaml(text),
    actor: (c) => requestAuthor(c),
    isAdmin: (c) => requestIsAdmin(c),
    ...suitePhase4Deps(),
  });
  // suites of other targets: a hosted MCP server's saved tests, a mission run in test mode
  const hostedSuiteApp = new OpenAPIHono();
  registerAgentSuiteRoutes(hostedSuiteApp, () => ({ suites: suiteRouteDeps(), getAgents: () => o.getAgents() }), {
    owner: (id) => `mcp-server:${id}`, exists: async (id) => mcpServerServiceFor(o).store.exists(id), tag: "MCP server suites", noun: "hosted server",
  });
  authed.route("/mcp-servers", hostedSuiteApp);
  const missionSuiteApp = new OpenAPIHono();
  registerAgentSuiteRoutes(missionSuiteApp, () => ({ suites: suiteRouteDeps(), getAgents: () => o.getAgents() }), {
    owner: (id) => `mission:${id}`, exists: async (id) => !!(await o.getMission(id).catch(() => undefined)), tag: "Mission suites", noun: "mission",
  });
  authed.route("/missions", missionSuiteApp);
  const agentSuites = () => agentSuiteRunnerFor({
    orchestrator: o, completions: (req) => completionApp.request(req),
    api: (path) => app.request(`/api/v1${path}`, { headers: trustedApiCallHeaders() }),
  });
  // Decisions (docs/decisions.md): decide() — typed judgments with probabilities from a decision model
  // through the shared gateway resolver, the uncalibrated fallback through Polpo's chat (a role turn
  // of the chat pipeline, no tools), the decision log, missions' decision nodes, the agents' tool.
  const decisions = (): DecisionService => {
    const polpoDir = activePolpoDir();
    let s = decisionServiceFor(polpoDir);
    if (!s) {
      s = new DecisionService({
        polpoDir: () => polpoDir,
        settings: () => o.getConfig()?.settings,
        vault: () => o.getVaultStore?.(),
        chatTurn: (prompt, check) => agentSuites().playRole("decider", undefined, prompt, { check }),
        recordUsage: async (u) => {
          await (databaseStoresFor(polpoDir)?.tokenUsageStore ?? new FileTokenUsageStore(polpoDir)).record({
            timestamp: new Date().toISOString(), source: "decision", provider: u.provider, model: u.model,
            inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
            totalTokens: u.inputTokens + u.outputTokens, cost: u.cost,
          });
          o.emit("token-usage:recorded", { timestamp: new Date().toISOString() });
        },
        emit: (payload) => o.emit("decision:made", payload),
      });
      registerDecisionService(polpoDir, s);
    }
    return s;
  };
  decisions();
  o.setMissionDecider(async (req) => {
    const r = await decisions().decide(
      { state: req.state, questions: req.questions, ...(req.model ? { model: req.model } : {}) },
      { kind: "mission", ...(req.caller.id ? { id: req.caller.id } : {}), label: req.caller.label },
    );
    return { id: r.id, answers: r.answers, calibrated: r.calibrated, model: r.model };
  });
  const decisionDeps = {
    service: () => (o.isInitialized ? decisions() : undefined),
    nodes: () => (o.isInitialized ? { list: () => o.getDecisionNodes(), resolve: (g: string, n: string, b: string | null, by: string) => o.resolveDecisionNode(g, n, b, by) } : undefined),
  };
  // each decide() is a model call: a rate limit like Ask
  authed.use("/decide", rateLimitMiddleware(60, 60_000));
  authed.route("/decide", decideRoutes(decisionDeps));
  authed.route("/decisions", decisionRoutes(decisionDeps));
  // phase 5 (docs/agent-suites.md): benchmarks (suites × variants × repetitions, compared) and the Playground
  const benchmarks = () => agentBenchmarksFor({
    orchestrator: o, completions: (req) => completionApp.request(req),
    api: (path) => app.request(`/api/v1${path}`, { headers: trustedApiCallHeaders() }),
  });
  authed.route("/", benchmarkRoutes(() => {
    const b = benchmarks();
    return {
      list: () => b.list(), get: (id) => b.get(id), save: (input, opts) => b.save(input, opts), remove: (id) => b.remove(id),
      estimate: async (req) => b.estimate((await b.specOf(req)).spec),
      start: (req, opts) => b.start(req, opts),
      listRuns: (opts) => b.listRuns(opts), report: (id, w) => b.report(id, w), cancel: (id) => b.cancel(id),
      compare: (id, key, opts) => b.compareCase(id, key, opts),
      sessions: (actor) => b.listSessions(actor), createSession: (panes, opts) => b.createSession(panes, opts), getSession: (id) => b.getSession(id),
      updateSession: (id, panes) => b.updateSession(id, panes), deleteSession: (id) => b.deleteSession(id), resetSession: (id, paneId) => b.resetSession(id, paneId),
      send: (id, req, onEvent, signal) => b.send(id, req, onEvent, signal), sendOnce: (panes, req, opts) => b.sendOnce(panes, req, opts),
      caseFromExchange: (id, req, opts) => b.caseFromExchange(id, req, opts), promote: (req, opts) => b.promote(req, opts),
      actor: (c) => requestAuthor(c), isAdmin: (c) => requestIsAdmin(c),
    };
  }));
  // a hosted server's deploys go through its required suite (the saved tests' gate)
  setHostedSuiteGate(o, (id, version, opts) => agentSuites().hostedGate(id, version, opts), (id, ref, opts) => agentSuites().hostedCheck(id, ref, opts));
  // a deleted mission or hosted server takes its suite runs and cassettes along (a server's saved tests go with it)
  if (!suiteCleanupWired.has(o)) {
    suiteCleanupWired.add(o);
    o.on("mission:deleted", ({ missionId }) => { void agentSuites().forget(`mission:${missionId}`).catch(() => undefined); });
    o.on("mcp-server:changed", ({ id, what }) => { if (what === "deleted") void agentSuites().forget(`mcp-server:${id}`).catch(() => undefined); });
  }
  const deployGates = () => agentDeployGatesFor({ orchestrator: o, completions: (req) => completionApp.request(req) });
  // every deploy (dashboard, REST, MCP, Polpo's chat, API updates that auto-deploy) goes through the required suites
  o.setAgentDeployGate({
    applies: (name) => deployGates().applies(name),
    request: (name, version, req) => deployGates().request(name, version, req),
    published: (name, version, actor) => deployGates().published(name, version, actor),
    rollingBack: (name, actor) => deployGates().rollingBack(name, actor),
  });
  const agentTester = () => agentTesterFor({
    orchestrator: o,
    computerManager: () => computerDeps.manager(),
    onComputer: async (id, command, timeoutMs) => {
      const computer = (o.getConfig()?.settings?.computers ?? []).find((x) => x.id === id);
      if (!computer) return undefined;
      return computerDeps.manager().whenRunning(computer, (d) => driverHost(d).exec(command, { timeoutMs }));
    },
    completions: (req) => completionApp.request(req),
    instanceAuth: () => isInstanceAuthEnabled(),
  });

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
    sessions: o.getSessionStore() ?? undefined,
    emit: (event, payload) => o.emit(event, payload),
    emitDeleted: (roomId) => o.emit("room:deleted", { roomId }),
  })));

  authed.route("/chat", chatRoutes(() => ({
    attachmentStore: o.getAttachmentStore() ?? new FileAttachmentStore(o.getPolpoDir()),
    sessionStore: o.getSessionStore(),
    emit: (event: string, data: unknown) => o.emit(event as any, data),
    chatQueueStore: o.getChatQueueStore(),
    turnScheduler,
    contextCheckpoints: o.getContextCheckpointStore(),
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
    // who changes a skill, recorded in its versions: a person, Polpo's chat, an agent, or an MCP client
    author: (c) => requestAuthor(c),
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
    getVaultStore: () => o.getVaultStore(),
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

  authed.route("/checks", checkRoutes(() => ({
    checks: o.getConversationCheckManager(),
    sessions: o.getSessionStore(),
    agentNames: async () => (await o.getAgents()).map((a) => a.name),
    resolveChatTarget: (to, opts) => o.resolveChatTarget(to, opts),
  })));
  authed.route("/telegram", telegramRoutes(() => ({
    listChats: () => o.listChats(),
    chatBots: () => o.chatBots(),
    resolveChatTarget: (to, opts) => o.resolveChatTarget(to, opts),
    sendToChat: (target, text, agent, files) => o.sendToChat(target, text, agent, files),
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
      // made through the MCP connector (the server calls the API for an authenticated client): who that is
      return isTrustedApiCall(c.req.header(TRUSTED_API_CALL_HEADER)) ? `person:${currentEventOrigin()?.by ?? "mcp"}` : "person:dashboard";
    },
    emit: (payload) => orchestrator.emit("artifact:changed", payload),
    // uploads from a file of the instance ({ path }): the same folders the Files page reads
    fileRoots: () => [...new Set([o.getWorkDir(), o.getPolpoDir(), o.getAgentWorkDir()])],
  })));
  authed.route("/storage", storageRoutes(activeStorage, () => orchestrator.getAgentWorkDir()));
  authed.route("/brain", companyBrainRoutes(activeCompanyBrain));
  // Global search (⌘K, polpo_search): every area, read as the dashboard reads it (src/server/search)
  const searchSources = buildSearchSources({
    api: async (path) => {
      const res = await inProcessApi("GET", `/api/v1${path}`).catch(() => undefined);
      const body = res?.body as { ok?: boolean; data?: unknown } | undefined;
      return res && res.status < 400 && body?.ok ? body.data : undefined;
    },
    sessions: () => o.getSessionStore() ?? undefined,
    rooms: () => o.getRoomStore() ?? undefined,
    tasks: () => o.getStore().getAllTasks(),
    missions: () => o.getAllMissions(),
    artifacts: () => getArtifactStore(activePolpoDir()),
    files: () => ({ roots: [o.getAgentWorkDir()], base: o.getWorkDir() }),
    recentEvents: () => sseBridge.recentEvents?.() ?? [],
  });
  const searchEngine = new SearchEngine(() => searchSources);
  // Ask Polpo from ⌘K (POST /search/ask): the orchestrator's model, a tighter rate limit (each call is an LLM call)
  authed.use("/search/ask", rateLimitMiddleware(20, 60_000));
  authed.route("/search", searchRoutes(() => (o.isInitialized ? searchEngine : undefined), () => ({
    model: async () => {
      const { orchestratorAskModel } = await import("./search/ask-llm.js");
      return orchestratorAskModel(effectiveOrchestratorModel(o.getConfig()?.settings?.orchestratorModel));
    },
    recordUsage: async (usage) => {
      await (databaseStoresFor(activePolpoDir())?.tokenUsageStore ?? new FileTokenUsageStore(activePolpoDir())).record({
        timestamp: new Date().toISOString(), source: "search_ask", provider: usage.provider, model: usage.model,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.totalTokens, cost: usage.cost,
      });
      o.emit("token-usage:recorded", { timestamp: new Date().toISOString() });
    },
  })));

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
  authed.route("/preferences", preferencesRoutes({
    polpoDir: activePolpoDir,
    member: (c) => c.get("polpoUserEmail" as never) as string | undefined,
  }));

  authed.route("/browser-dashboard", browserDashboardRoutes());
  // Agent conversations: the pairs' conversations and the latest exchanges (live: agent:message events)
  authed.get("/agent-talk", (c) => c.json({ ok: true, data: agentTalk?.overview() ?? { conversations: [], recent: [] } }));
  authed.route("/browser-profiles", browserProfileRoutes({ polpoDir: () => orchestrator.getPolpoDir(), agents: () => orchestrator.getAgents() }));
  authed.use("/connectors/*", async (c, next) => { notePublicOrigin(publicOrigin(c)); return next(); });
  authed.route("/connectors", connectorRoutes({
    manager: () => connectorManagerFor(o),
    settings: () => o.getConfig()?.settings,
    // what the provider must reach: POLPO_PUBLIC_URL when set, even when the dashboard calls the API on another port
    redirectUri: (c) => `${connectorPublicBase(publicOrigin(c))}${CONNECTOR_OAUTH_CALLBACK_PATH}`,
  }));
  // Hosted MCP servers: build, test, publish, deploy; each becomes a connector (docs/custom-mcp-servers.md)
  authed.route("/mcp-servers", mcpServerRoutes({
    service: () => mcpServerServiceFor(o),
    llm: () => async (prompt) => (await queryOrchestratorText(prompt, requireOrchestratorModel(o.getConfig()?.settings?.orchestratorModel))).text,
    actor: (c) => requestAuthor(c),
    publicBase: (c) => connectorPublicBase(publicOrigin(c)),
    urlPolicy: () => ({ allowPrivateNetwork: false }),
    isAdmin: (c) => requestIsAdmin(c),
  }));
  const computerDeps: ComputerRouteDeps = {
    computers: () => o.getConfig()?.settings?.computers ?? [],
    settings: () => o.getConfig()?.settings,
    agents: () => o.getAgents(),
    manager: () => computerManagerWithEvents(
      o.getPolpoDir(), (payload) => o.emit("computer:changed", payload), (level, message) => o.emit("log", { level, message: `[computers] ${message}` }),
      () => o.getConfig()?.settings?.computers ?? [],
    ),
    save: async (computers) => {
      const { savePolpoSettingsKey } = await import("../core/config.js");
      savePolpoSettingsKey(o.getPolpoDir(), "computers", computers.length ? computers : undefined);
      await o.reloadConfig();
    },
    sandboxFor: (computer) => computerSandbox(computer, o.getConfig()?.settings),
    tasks: () => o.getStore().getAllTasks(),
    harnessSessions: (computerId) => harnessSessionViews(o.getPolpoDir(), { computer: computerId }),
    instance: () => o.getConfig()?.project,
    emit: (payload) => o.emit("computer:changed", payload),
  };
  authed.route("/computers", computerRoutes(computerDeps));
  authed.route("/computer-webhooks", computerWebhookAdminRoutes({ webhooks: computerWebhooks }));
  // Triggers: definitions, secrets (rotation, the HMAC secret in the vault), deliveries, test tools (no actions yet)
  authed.route("/triggers", triggerAdminRoutes({ service: triggerService }));
  // WhatsApp Business channels: status, secrets (vault, write-only), events, contacts, sends, templates, approvals
  authed.route("/whatsapp-business", waBusinessAdminRoutes({ service: waBusiness }));
  // the CLI engine's accounts (personal Claude Code / Codex sign-ins: config directories, never tokens)
  authed.route("/harnesses/cli", cliAccountRoutes({
    settings: () => o.getConfig()?.settings,
    agents: () => o.getAgents(),
    save: async (cli) => {
      const { savePolpoSettingsKey } = await import("../core/config.js");
      const harnesses = { enabled: [], ...((o.getConfig()?.settings?.harnesses ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
      if (cli) harnesses.cli = cli; else delete harnesses.cli;
      savePolpoSettingsKey(o.getPolpoDir(), "harnesses", harnesses);
      await o.reloadConfig();
    },
    onComputer: async (id, command, timeoutMs) => {
      const computer = (o.getConfig()?.settings?.computers ?? []).find((x) => x.id === id);
      if (!computer) return undefined;
      return computerDeps.manager().whenRunning(computer, (d) => driverHost(d).exec(command, { timeoutMs }));
    },
    member: (c) => c.get("polpoUserEmail" as never) as string | undefined,
    instanceAuth: () => isInstanceAuthEnabled(),
  }));
  // agent harnesses (Claude Code, Codex, OpenCode): settings overview and their sessions (status, stop, reset)
  authed.route("/harnesses", harnessRoutes({
    polpoDir: () => o.getPolpoDir(),
    settings: () => o.getConfig()?.settings,
    agents: () => o.getAgents(),
    vault: () => o.getVaultStore(),
    manager: computerDeps.manager,
  }));
  // every egress proxy and every remote computer's egress (read-only)
  authed.route("/egress", egressRoutes(computerDeps));
  // Polpo's own MCP connector: who may use it (OAuth grants, MCP keys) and with which scopes
  authed.get("/mcp/access", async (c) => c.json({ ok: true, data: {
    scopes: ALL_SCOPES.map((id) => ({ id, ...SCOPES[id] })),
    grants: oauthServer().listGrants(),
    keys: await mcpKeys.list(),
    tools: toolScopeMatrix().map(({ name, toolset, scope, destructive }) => ({ name, toolset, scope, destructive })),
  } }));
  authed.delete("/mcp/grants/:id", (c) => {
    if (!oauthServer().revokeGrant(c.req.param("id"))) return c.json({ ok: false, error: "No such grant (it may have expired)" }, 404);
    return c.json({ ok: true, data: { revoked: c.req.param("id") } });
  });
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
