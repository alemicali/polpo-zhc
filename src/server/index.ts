import { existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

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

  constructor(private config: ServerConfig) {}

  /** Start the server: init orchestrator, bind HTTP. */
  async start(): Promise<void> {
    const workDir = resolve(this.config.workDir);
    this.orchestrator = new Orchestrator(workDir);

    // Default team fallback (initInteractive will load from .polpo/polpo.json if available)
    const defaultTeam: Team = {
      name: "default",
      agents: [{ name: "dev-1", role: "developer" }],
    };

    await this.orchestrator.initInteractive(basename(workDir), defaultTeam);

    // Create SSE bridge and start listening to events
    this.sseBridge = new SSEBridge(this.orchestrator);
    this.sseBridge.start();

    if (this.config.autoStart !== false) {
      // Fire and forget — runs until stopped
      this.orchestrator.run().catch((err) => {
        console.error(`[PolpoServer] Supervisor loop crashed:`, err instanceof Error ? err.message : err);
      });
    }

    const app = createApp(this.orchestrator, this.sseBridge, {
      apiKeys: this.config.apiKeys,
      corsOrigins: this.config.corsOrigins,
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
    if (uiAvailable) {
      console.log(`  Dashboard  ${base}`);
    } else {
      console.log(`  Dashboard  not found (run 'pnpm build:ui' to enable)`);
    }
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
    await this.orchestrator?.gracefulStop();
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
