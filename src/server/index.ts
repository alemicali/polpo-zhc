import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ProjectManager } from "./project-manager.js";
import type { ServerConfig } from "./types.js";

/**
 * Polpo HTTP Server.
 *
 * Manages multiple Polpo projects via HTTP API + SSE streaming.
 * Can run locally, self-hosted, or as a cloud-managed service.
 *
 * Usage:
 *   const server = new PolpoServer({
 *     port: 3000,
 *     host: "0.0.0.0",
 *     projects: [{ id: "my-project", workDir: "./my-project", autoStart: true }],
 *   });
 *   await server.start();
 */
export class PolpoServer {
  private pm: ProjectManager;
  private server: ReturnType<typeof serve> | null = null;
  private shutdownHandlers: (() => void)[] = [];

  constructor(private config: ServerConfig) {
    this.pm = new ProjectManager();
  }

  /** Start the server: register projects, bind HTTP. */
  async start(): Promise<void> {
    // Register all configured projects
    for (const entry of this.config.projects) {
      await this.pm.register(entry);
      if (entry.autoStart) {
        await this.pm.start(entry.id);
      }
    }

    const app = createApp(this.pm, {
      apiKeys: this.config.apiKeys,
      corsOrigins: this.config.corsOrigins,
    });

    this.server = serve({
      fetch: app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    console.log(`\n  Listening  http://${this.config.host}:${this.config.port}`);
    console.log(`  Projects   ${this.config.projects.map(p => p.id).join(", ")}`);
    console.log(`  API        http://${this.config.host}:${this.config.port}/api/v1/health\n`);

    // Signal handlers for graceful shutdown
    const onSignal = () => { this.stop(); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    this.shutdownHandlers.push(() => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    });
  }

  /** Graceful shutdown: stop all projects, close HTTP server. */
  async stop(): Promise<void> {
    console.log("\nShutting down Polpo Server...");
    await this.pm.shutdownAll();
    this.server?.close();
    for (const fn of this.shutdownHandlers) fn();
    console.log("Polpo Server stopped.");
  }

  /** Get the project manager (for programmatic access). */
  getProjectManager(): ProjectManager {
    return this.pm;
  }
}

// Re-exports
export { createApp } from "./app.js";
export { ProjectManager } from "./project-manager.js";
export { SSEBridge } from "./sse-bridge.js";
export type {
  ServerConfig,
  ProjectEntry,
  ProjectInfo,
  ApiResponse,
  ApiError,
  SSEEvent,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreatePlanRequest,
  UpdatePlanRequest,
  AddAgentRequest,
} from "./types.js";
