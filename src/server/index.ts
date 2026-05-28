import { existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { getPolpoDir } from "../core/constants.js";
import { loadPolpoConfig } from "../core/config.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { attachTerminalWebSocket, type TerminalWebSocketHandle } from "./terminal.js";
import { attachCodeServerWebSocket, CodeServerManager } from "./code-server.js";

import { Orchestrator } from "../core/orchestrator.js";
import { SSEBridge } from "./sse-bridge.js";
import type { Team } from "../core/types.js";
import type { ServerConfig } from "./types.js";

/**
 * Polpo HTTP Server.
 *
 * Single-orchestrator architecture. Manages one Polpo instance via HTTP API + SSE streaming.
 *
 * Usage:
 *   const server = new PolpoServer({
 *     port: 3890,
 *     host: "0.0.0.0",
 *     workDir: "./my-project",
 *     autoStart: true,
 *   });
 *   await server.start();
 */
export class PolpoServer {
  private orchestrator!: Orchestrator;
  private sseBridge!: SSEBridge;
  private server: ReturnType<typeof serve> | null = null;
  private terminalWs: TerminalWebSocketHandle | null = null;
  private codeServerManager: CodeServerManager | null = null;
  private codeServerWs: { close: () => void } | null = null;
  private syncScheduler: SyncScheduler | null = null;
  private syncRunning = false;
  private shutdownHandlers: (() => void)[] = [];
  private supervisorRun: Promise<void> | null = null;

  constructor(private config: ServerConfig) {}

  /** Initialize the orchestrator (called at start or after setup completes). */
  private async initOrchestrator(overrideWorkDir?: string): Promise<void> {
    const workDir = resolve(overrideWorkDir ?? this.config.workDir);
    const polpoDir = getPolpoDir(workDir);
    const persistedConfig = loadPolpoConfig(polpoDir);
    // Source of truth at runtime is the configured TeamStore/AgentStore
    // (sqlite by default, file when storage="file", postgres when configured).
    // We always pass the first-run defaultTeam to initInteractive — the
    // orchestrator's populateStores() guards against re-seeding when ANY
    // team already exists in the store, so this is safe across all
    // backends and survives explicit user deletes.
    const defaultTeam: Team = {
      name: "default",
      agents: [{ name: "dev-1", role: "developer" }],
    };

    await this.orchestrator.initInteractive(
      persistedConfig?.project ?? basename(workDir), [defaultTeam]);

    // (Re-)create SSE bridge
    this.sseBridge?.dispose();
    this.sseBridge = new SSEBridge(this.orchestrator);
    this.sseBridge.start();

    console.log("\n  Orchestrator initialized — dashboard is ready.\n");
  }

  /** Called by the initialize endpoint to transition from uninitialized → ready. */
  async completeSetup(workDir: string): Promise<void> {
    this.orchestrator.resetWorkDir(workDir);
    await this.initOrchestrator(workDir);
    this.ensureSupervisorRunning("setup complete");
  }

  private ensureSupervisorRunning(reason: string): void {
    if (this.config.autoStart === false) return;
    if (!this.orchestrator?.isInitialized) return;
    if (this.supervisorRun) return;

    this.supervisorRun = this.orchestrator.run()
      .catch((err) => {
        console.error(`[PolpoServer] Supervisor loop crashed (${reason}):`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.supervisorRun = null;
      });
  }

  /** Start the server: init orchestrator if config exists, bind HTTP. */
  async start(): Promise<void> {
    const workDir = resolve(this.config.workDir);
    this.orchestrator = new Orchestrator(workDir);
    this.codeServerManager = new CodeServerManager(this.orchestrator);
    const wakeSupervisor = () => this.ensureSupervisorRunning("task event");
    this.orchestrator.on("task:created", wakeSupervisor);
    this.orchestrator.on("task:updated", wakeSupervisor);
    this.shutdownHandlers.push(() => {
      this.orchestrator.off("task:created", wakeSupervisor);
      this.orchestrator.off("task:updated", wakeSupervisor);
    });

    const configPath = join(getPolpoDir(workDir), "polpo.json");
    const hasConfig = existsSync(configPath);

    if (hasConfig) {
      await this.initOrchestrator();

      this.ensureSupervisorRunning("startup");
    } else {
      // No config yet — placeholder SSE bridge, orchestrator will be initialized after setup
      this.sseBridge = new SSEBridge(this.orchestrator);
    }

    // Auto-push scheduler — reads `<polpoDir>/sync-config.json` so its
    // state survives restarts. Activates only when the schedule's
    // `enabled` flag is true and R2 is configured.
    this.syncScheduler = new SyncScheduler(
      getPolpoDir(workDir),
      workDir,
      () => this.syncRunning,
    );
    this.syncScheduler.reload();

    const app = createApp(this.orchestrator, this.sseBridge, {
      apiKeys: this.config.apiKeys,
      corsOrigins: this.config.corsOrigins,
      workDir,
      onInitialize: (workDir: string) => this.completeSetup(workDir),
      wakeSupervisor: () => this.ensureSupervisorRunning("task route"),
      codeServerManager: this.codeServerManager,
      // Late-bound: terminalWs is created after this createApp() call, but
      // the Processes panel only reads it at request time.
      getTerminalHandle: () => this.terminalWs,
      syncScheduler: this.syncScheduler,
    });

    this.server = serve({
      fetch: app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });
    this.terminalWs = attachTerminalWebSocket(this.server, this.orchestrator, {
      apiKeys: this.config.apiKeys,
      workDir,
    });
    this.codeServerWs = attachCodeServerWebSocket(this.server, this.codeServerManager, this.orchestrator, {
      apiKeys: this.config.apiKeys,
      workDir,
    });

    const base = `http://${this.config.host}:${this.config.port}`;

    console.log(`\n  Listening  ${base}`);
    console.log(`  WorkDir    ${workDir}`);
    console.log(`  API        ${base}/api/v1/health`);
    console.log();

    // Signal handlers for graceful shutdown
    const onSignal = () => { this.stop(); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    this.shutdownHandlers.push(() => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    });
  }

  /** Graceful shutdown: stop orchestrator, close HTTP server. */
  async stop(): Promise<void> {
    console.log("\nShutting down Polpo Server...");
    this.sseBridge?.dispose();
    this.terminalWs?.close();
    this.terminalWs = null;
    this.codeServerWs?.close();
    this.codeServerWs = null;
    this.syncScheduler?.stop();
    this.codeServerManager?.close();
    if (this.orchestrator?.isInitialized) {
      await this.orchestrator.gracefulStop();
    }
    this.server?.close();
    for (const fn of this.shutdownHandlers) fn();
    console.log("Polpo Server stopped.");
  }

  /** Get the orchestrator (for programmatic access). */
  getOrchestrator(): Orchestrator {
    return this.orchestrator;
  }
}

// Re-exports
export { createApp } from "./app.js";
export type { AppOptions } from "./app.js";
export { SSEBridge } from "./sse-bridge.js";
export type {
  ServerConfig,
  ApiResponse,
  ApiError,
  SSEEvent,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateMissionRequest,
  UpdateMissionRequest,
  AddAgentRequest,
} from "./types.js";

// Route factories — shared routes re-exported from @polpo-ai/server
export {
  taskRoutes, missionRoutes, chatRoutes, notificationRoutes, approvalRoutes,
  playbookRoutes, stateRoutes, completionRoutes, peerRoutes, scheduleRoutes,
  watcherRoutes, vaultRoutes, healthRoutes, agentRoutes, eventRoutes, configRoutes,
} from "@polpo-ai/server";
// eventRoutes now in @polpo-ai/server (decoupled with EventBridge interface)
export { skillRoutes } from "./routes/skills.js";
export { authRoutes } from "./routes/auth.js";
export { fileRoutes } from "./routes/files.js";
// configRoutes now in @polpo-ai/server (decoupled with saveConfig dep)
export { publicConfigRoutes } from "./routes/config.js";
