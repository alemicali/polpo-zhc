import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { serve } from "@hono/node-server";
import { createApp, type ServerState } from "./app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  private shutdownHandlers: (() => void)[] = [];
  private serverState: ServerState = { setupMode: false };

  constructor(private config: ServerConfig) {}

  /** Initialize the orchestrator (called at start or after setup completes). */
  private async initOrchestrator(overrideWorkDir?: string): Promise<void> {
    const workDir = resolve(overrideWorkDir ?? this.config.workDir);
    const defaultTeam: Team = {
      name: "default",
      agents: [{ name: "dev-1", role: "developer" }],
    };

    await this.orchestrator.initInteractive(basename(workDir), defaultTeam);

    // (Re-)create SSE bridge
    this.sseBridge?.dispose();
    this.sseBridge = new SSEBridge(this.orchestrator);
    this.sseBridge.start();

    // Flip shared state — routes will start serving
    this.serverState.setupMode = false;
    console.log("\n  Orchestrator initialized — dashboard is ready.\n");
  }

  /** Called by the setup complete endpoint to transition from setup → ready. */
  async completeSetup(workDir: string): Promise<void> {
    // Re-point the existing orchestrator at the user's chosen project directory
    this.orchestrator.resetWorkDir(workDir);
    await this.initOrchestrator(workDir);
  }

  /** Start the server: init orchestrator, bind HTTP. */
  async start(): Promise<void> {
    const workDir = resolve(this.config.workDir);
    this.orchestrator = new Orchestrator(workDir);
    this.serverState = { setupMode: !!this.config.setupMode };

    if (!this.config.setupMode) {
      await this.initOrchestrator();

      if (this.config.autoStart !== false) {
        this.orchestrator.run().catch((err) => {
          console.error(`[PolpoServer] Supervisor loop crashed:`, err instanceof Error ? err.message : err);
        });
      }
    } else {
      // Setup mode — no orchestrator init yet, just a placeholder SSE bridge
      this.sseBridge = new SSEBridge(this.orchestrator);
    }

    const app = createApp(this.orchestrator, this.sseBridge, {
      apiKeys: this.config.apiKeys,
      corsOrigins: this.config.corsOrigins,
      setupMode: this.config.setupMode,
      workDir,
      serverState: this.serverState,
      onSetupComplete: (workDir: string) => this.completeSetup(workDir),
    });

    this.server = serve({
      fetch: app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    const base = `http://${this.config.host}:${this.config.port}`;
    const uiAvailable = existsSync(resolve(__dirname, "..", "..", "ui", "dist", "index.html"));

    console.log(`\n  Listening  ${base}`);
    console.log(`  WorkDir    ${workDir}`);
    console.log(`  API        ${base}/api/v1/health`);
    let dashboardUrl: string | undefined;
    if (uiAvailable) {
      if (this.config.setupMode) {
        dashboardUrl = `${base}/setup`;
        console.log(`  Setup      ${dashboardUrl}`);
      } else {
        dashboardUrl = base;
        console.log(`  Dashboard  ${dashboardUrl}`);
      }
    } else {
      console.log(`  Dashboard  not found (run 'pnpm build:ui' to enable)`);
    }
    console.log();

    // Auto-open browser
    if (dashboardUrl) {
      const openCmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
      exec(`${openCmd} ${dashboardUrl}`, () => { /* ignore errors — best effort */ });
    }

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
    if (!this.config.setupMode) {
      await this.orchestrator?.gracefulStop();
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
