import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

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

    console.log("\n  Orchestrator initialized — dashboard is ready.\n");
  }

  /** Called by the initialize endpoint to transition from uninitialized → ready. */
  async completeSetup(workDir: string): Promise<void> {
    this.orchestrator.resetWorkDir(workDir);
    await this.initOrchestrator(workDir);
  }

  /** Start the server: init orchestrator if config exists, bind HTTP. */
  async start(): Promise<void> {
    const workDir = resolve(this.config.workDir);
    this.orchestrator = new Orchestrator(workDir);

    const configPath = resolve(workDir, ".polpo", "polpo.json");
    const hasConfig = existsSync(configPath);

    if (hasConfig) {
      await this.initOrchestrator();

      if (this.config.autoStart !== false) {
        this.orchestrator.run().catch((err) => {
          console.error(`[PolpoServer] Supervisor loop crashed:`, err instanceof Error ? err.message : err);
        });
      }
    } else {
      // No config yet — placeholder SSE bridge, orchestrator will be initialized after setup
      this.sseBridge = new SSEBridge(this.orchestrator);
    }

    const app = createApp(this.orchestrator, this.sseBridge, {
      apiKeys: this.config.apiKeys,
      corsOrigins: this.config.corsOrigins,
      workDir,
      onInitialize: (workDir: string) => this.completeSetup(workDir),
    });

    this.server = serve({
      fetch: app.fetch,
      port: this.config.port,
      hostname: this.config.host,
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
