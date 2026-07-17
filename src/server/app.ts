import { getPolpoDir } from "../core/constants.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { buildSystemPrompt } from "../adapters/engine.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SSEBridge } from "./sse-bridge.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorMiddleware } from "./middleware/error.js";
import { instanceAuthMiddleware } from "./middleware/instance-auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { isInstanceAuthEnabled } from "./auth/instance-auth.js";
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
} from "@polpo-ai/server";
// Node.js-only routes (stay in src/server/routes/)
import { publicConfigRoutes } from "./routes/config.js";
import { filesystemRoutes } from "./routes/filesystem.js";
import { providerRoutes } from "./routes/providers.js";
import { skillRoutes } from "./routes/skills.js";
import { authRoutes } from "./routes/auth.js";
import { instanceAuthRoutes } from "./routes/instance-auth.js";
import { fileRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { audioRoutes } from "./routes/audio.js";
import { pushRoutes } from "./routes/push.js";
import { expoPushRoutes } from "./routes/expo-push.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { emailRoutes } from "./routes/email.js";
import { codingRoutes } from "./routes/coding.js";
import { syncRoutes } from "./routes/sync.js";
import { browserDashboardRoutes } from "./routes/browser-dashboard.js";
import { backgroundWaitRoutes } from "./routes/background-waits.js";
import { tokenUsageRoutes } from "./routes/token-usage.js";
import { FileAttachmentStore } from "../stores/file-attachment-store.js";
import { FileTokenUsageStore } from "../stores/file-token-usage-store.js";
import { isTerminalEnabled, type TerminalWebSocketHandle } from "./terminal.js";
import type { CodeServerManager } from "./code-server.js";
import type { SyncScheduler } from "./sync-scheduler.js";

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

  // Global middleware
  app.use("*", errorMiddleware());
  // Rate limit API routes only (not static assets)
  app.use("/api/*", rateLimitMiddleware());
  app.use("/v1/*", rateLimitMiddleware());

  const corsExposeHeaders = ["x-session-id"];
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

  // ── Public routes (no auth) ───────────────────────────────────────────

  app.route("/api/v1/health", healthRoutes());

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

  // Provider management — always available (API key CRUD, OAuth flows, model listing)
  if (opts?.workDir) {
    app.route("/api/v1/providers", providerRoutes(activePolpoDir));
  }

  // OpenAI-compatible chat completions
  if (opts?.workDir) {
    app.use("/v1/*", instanceAuthMiddleware(getPolpoDir(opts.workDir), opts.apiKeys ?? []));
  }
  const completionApp = completionRoutes(() => ({
    getAgents: () => o.getAgents(),
    getConfig: () => o.getConfig(),
    getMemoryStore: () => o.getMemoryStore(),
    getSessionStore: () => o.getSessionStore(),
    getStore: () => o.getStore(),
    emit: (event: string, data: any) => o.emit(event as any, data),
    recordTokenUsage: (usage) => new FileTokenUsageStore(activePolpoDir()).record(usage),
    resolveAgentModel: async (agentConfig: any, reasoning?: string) => {
      const { resolveModel, resolveApiKeyAsync, buildStreamOpts } = await import("../llm/pi-client.js");
      const m = resolveModel(agentConfig.model);
      const apiKey = await resolveApiKeyAsync(m.provider as string);
      const r = agentConfig.reasoning ?? reasoning;
      return { model: m, streamOpts: buildStreamOpts(apiKey, r, m.maxTokens) };
    },
    buildAgentPrompt: async (agentConfig: any) => {
      // Pull the agent's mailboxes from vault so the prompt enumerates
      // them (drives the `account` selector in email_* tools). Failures
      // here degrade gracefully: prompt is rendered without the section.
      let mailboxes: any[] | undefined;
      try {
        const entries = await o.getVaultStore()?.getAllForAgent(agentConfig.name);
        const { resolveAgentVault } = await import("../vault/index.js");
        mailboxes = resolveAgentVault(entries).listMailboxes();
      } catch { /* ignore — keep prompt without mailboxes section */ }
      return buildSystemPrompt(agentConfig, o.getAgentWorkDir(), o.getPolpoDir(), undefined, undefined, mailboxes);
    },
    resolveAgentTools: async (agentConfig: any) => {
      const { createAllTools } = await import("../tools/system-tools.js");
      const { createMemoryTools } = await import("../tools/memory-tools.js");
      const { resolveAgentVault } = await import("../vault/index.js");
      const {
        CLIENT_SIDE_CHAT_TOOLS,
        isClientSideChatTool,
        isSideEffectGated,
        renderWidgetTool,
        validateRenderWidgetArgs,
        setSessionTitleTool,
      } = await import("../llm/orchestrator-tools.js");
      const { nanoid } = await import("nanoid");
      const { join } = await import("node:path");
      const vaultEntries = await o.getVaultStore()?.getAllForAgent(agentConfig.name);
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
        ? (jid: string, opts: { path: string; caption?: string; mimeType?: string; fileName?: string; mediaKind?: "auto" | "image" | "video" | "audio" | "document"; viewOnce?: boolean }) =>
            waBridge.sendMediaMessage(jid, opts)
        : undefined;
      const whatsappMarkRead = waBridge
        ? (keys: { remoteJid: string; id: string; fromMe?: boolean; participant?: string }[]) =>
            waBridge.markRead(keys)
        : undefined;
      const tools: any[] = await createAllTools({
        cwd: o.getAgentWorkDir(),
        allowedTools: agentConfig.allowedTools,
        allowedPaths: undefined,
        browserSession: agentConfig.name,
        browserProfileDir,
        vault,
        emailAllowedDomains: agentConfig.emailAllowedDomains,
        outputDir: undefined,
        whatsappStore: o.getWhatsAppStore?.(),
        whatsappSendMessage,
        whatsappSendMedia,
        whatsappMarkRead,
        polpoDir,
      });
      const memoryStore = o.getMemoryStore();
      if (memoryStore) tools.push(...createMemoryTools(memoryStore, agentConfig.name));
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
      const isInteractive = (name: string) => isClientSideChatTool(name) || isSideEffectGated(name);
      return { tools, executor, isInteractive };
    },
    streamLLM: streamSimple as any,
    resolveOrchestratorContext: async () => {
      const { buildChatSystemPrompt } = await import("../llm/prompts.js");
      const { resolveModel, resolveApiKeyAsync, resolveModelSpec, buildStreamOpts } = await import("../llm/pi-client.js");
      const { ALL_ORCHESTRATOR_TOOLS, executeOrchestratorTool, isInteractive } = await import("../llm/orchestrator-tools.js");
      const state = await (async () => { try { return await o.getStore()?.getState() ?? null; } catch { return null; } })();
      const systemPrompt = await buildChatSystemPrompt(o, state);
      const settings = o.getConfig()?.settings;
      const modelSpec = resolveModelSpec(settings?.orchestratorModel);
      const m = resolveModel(modelSpec);
      const apiKey = await resolveApiKeyAsync(m.provider as string);
      return {
        systemPrompt,
        model: m,
        streamOpts: buildStreamOpts(apiKey, settings?.reasoning, m.maxTokens),
        tools: ALL_ORCHESTRATOR_TOOLS,
        executor: (name: string, args: Record<string, unknown>, context) => executeOrchestratorTool(name, args, o, context),
        isInteractive,
      };
    },
  }), opts?.apiKeys);
  app.route("/v1/chat/completions", completionApp);

  // ── Authenticated routes (require initialized orchestrator) ───────────

  const authed = new OpenAPIHono();
  if (!isInstanceAuthEnabled() && opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }
  if (opts?.workDir) {
    authed.use("*", instanceAuthMiddleware(getPolpoDir(opts.workDir), opts.apiKeys ?? []));
  }

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
    if (streamRegistry.getActiveTurnForSession(wait.sessionId)) return "deferred";
    const session = await o.getSessionStore()?.getSession(wait.sessionId);
    if (!session) throw new Error(`Chat session "${wait.sessionId}" no longer exists`);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": wait.sessionId,
      "x-polpo-internal-continuation": "background-wait",
    };
    if (opts?.apiKeys?.[0]) headers.authorization = `Bearer ${opts.apiKeys[0]}`;
    const history = await o.getSessionStore()?.getRecentMessages(wait.sessionId, 40) ?? [];
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
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as any;
      throw new Error(payload?.error?.message ?? payload?.error ?? `Continuation failed (${response.status})`);
    }
    return "completed";
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
    abortGroup: (group: string) => o.abortGroup(group),
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

  authed.route("/chat", chatRoutes(() => ({
    sessionStore: o.getSessionStore(),
  })));

  authed.route("/skills", skillRoutes(() => ({
    polpoDir: o.getPolpoDir(),
    workDir: o.getWorkDir(),
    getAgents: () => o.getAgents(),
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
  })));
  // Backward-compat: keep /templates as alias
  authed.route("/templates", playbookRoutes(() => ({
    playbookStore: o.getPlaybookStore(),
    saveMission: (opts: any) => o.saveMission(opts),
    executeMission: (id: string) => o.executeMission(id),
  })));

  authed.route("/config", configRoutes(() => ({
    getConfig: () => o.getConfig(),
    reloadConfig: () => o.reloadConfig(),
    saveConfig: async (config: any) => {
      const { savePolpoConfig } = await import("../core/config.js");
      savePolpoConfig(o.getPolpoDir(), config);
    },
    getNotificationRouter: () => o.getNotificationRouter(),
  })));

  authed.route("/peers", peerRoutes(() => ({
    peerStore: o.getPeerStore(),
  })));

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
  })));

  authed.route("/audio", audioRoutes());

  authed.route("/browser-dashboard", browserDashboardRoutes());

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
