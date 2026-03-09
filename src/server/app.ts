import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SSEBridge } from "./sse-bridge.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorMiddleware } from "./middleware/error.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { setupRoutes } from "./routes/setup.js";
import { taskRoutes } from "./routes/tasks.js";
import { missionRoutes } from "./routes/missions.js";
import { agentRoutes } from "./routes/agents.js";
import { eventRoutes } from "./routes/events.js";
import { chatRoutes } from "./routes/chat.js";
import { skillRoutes } from "./routes/skills.js";
import { notificationRoutes } from "./routes/notifications.js";
import { approvalRoutes } from "./routes/approvals.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { configRoutes } from "./routes/config.js";
import { stateRoutes } from "./routes/state.js";
import { completionRoutes } from "./routes/completions.js";
import { peerRoutes } from "./routes/peers.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { watcherRoutes } from "./routes/watchers.js";
import { vaultRoutes } from "./routes/vault.js";
import { authRoutes } from "./routes/auth.js";
import { fileRoutes } from "./routes/files.js";

export type ServerEnv = {
  Variables: {
    orchestrator: Orchestrator;
  };
};

/** Shared mutable state between app and server — allows setup→ready transition */
export interface ServerState {
  setupMode: boolean;
}

export interface AppOptions {
  apiKeys?: string[];
  corsOrigins?: string[];
  setupMode?: boolean;
  workDir?: string;
  serverState?: ServerState;
  onSetupComplete?: (workDir: string) => Promise<void>;
}

/**
 * Create the Hono app with all routes and middleware.
 * Single-orchestrator architecture — no project concept.
 */
export function createApp(orchestrator: Orchestrator, sseBridge: SSEBridge, opts?: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono();

  // Global middleware
  app.use("*", errorMiddleware());
  // Rate limit API routes only (not static assets)
  app.use("/api/*", rateLimitMiddleware());
  app.use("/v1/*", rateLimitMiddleware());

  const corsExposeHeaders = ["x-session-id"];
  if (opts?.corsOrigins && opts.corsOrigins.length > 0) {
    app.use("*", cors({ origin: opts.corsOrigins, exposeHeaders: corsExposeHeaders }));
  } else {
    // Default: restrict to localhost origins only
    app.use("*", cors({
      origin: [
        "http://localhost:3000", "http://localhost:3001",
        "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175",
      ],
      exposeHeaders: corsExposeHeaders,
    }));
  }

  // Health (no auth)
  app.route("/api/v1/health", healthRoutes());

  // Shared state for setup→ready transition
  const serverState = opts?.serverState ?? { setupMode: !!opts?.setupMode };

  // Setup mode indicator — the UI checks this to redirect to /setup
  // Must read serverState dynamically so it reflects completeSetup() flipping it to false
  app.get("/api/v1/setup-mode", (c) => c.json({ ok: true, data: { setupMode: serverState.setupMode } }));

  // Setup routes (no auth — used by setup wizard)
  if (opts?.workDir) {
    app.route("/api/v1/setup", setupRoutes(opts.workDir, opts.onSetupComplete));
  }

  // OpenAI-compatible chat completions
  app.route("/v1/chat/completions", completionRoutes(orchestrator, opts?.apiKeys));

  // Authenticated routes
  const authed = new OpenAPIHono<ServerEnv>();
  if (opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }

  // Gate: if still in setup mode, return 503 for orchestrator routes
  authed.use("*", async (c, next) => {
    if (serverState.setupMode) {
      return c.json({ ok: false, error: "Server is in setup mode. Complete setup first." }, 503);
    }
    c.set("orchestrator", orchestrator);
    return next();
  });

  // Mount all routes (always — gated by middleware above)
  authed.route("/tasks", taskRoutes());
  authed.route("/missions", missionRoutes());
  authed.route("/agents", agentRoutes());
  authed.route("/events", eventRoutes(sseBridge));
  authed.route("/chat", chatRoutes());
  authed.route("/skills", skillRoutes());
  authed.route("/notifications", notificationRoutes());
  authed.route("/approvals", approvalRoutes());
  authed.route("/playbooks", playbookRoutes());
  // Backward-compat: keep /templates as alias
  authed.route("/templates", playbookRoutes());
  authed.route("/config", configRoutes());
  authed.route("/peers", peerRoutes());
  authed.route("/schedules", scheduleRoutes());
  authed.route("/watchers", watcherRoutes());
  authed.route("/vault", vaultRoutes());
  authed.route("/auth", authRoutes());
  authed.route("/files", fileRoutes());
  authed.route("/", stateRoutes());

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

  // ── Embedded Dashboard UI ────────────────────────────────────────────
  // Serve the pre-built React SPA from ui/dist/ if it exists.
  // This lets `polpo serve` provide the full dashboard experience
  // without requiring a separate nginx/Vite process.

  const __dirname = dirname(fileURLToPath(import.meta.url));
  // From dist/server/app.js → ../../ui/dist (both dev and npm install)
  const uiDistDir = resolve(__dirname, "..", "..", "ui", "dist");

  if (existsSync(uiDistDir)) {
    // Static assets — Hono handles MIME types, streaming, range requests
    app.use("*", serveStatic({
      root: uiDistDir,
      onFound: (_path, c) => {
        // Hashed assets get immutable cache
        if (/\.[a-f0-9]{8,}\.\w+$/.test(_path)) {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));

    // SPA fallback — serve index.html for client-side routes
    app.get("*", async (c) => {
      try {
        const html = await readFile(resolve(uiDistDir, "index.html"), "utf-8");
        return c.html(html);
      } catch {
        return c.text("Dashboard not available", 404);
      }
    });
  }

  return app;
}
