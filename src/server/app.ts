import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SSEBridge } from "./sse-bridge.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorMiddleware } from "./middleware/error.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { taskRoutes } from "./routes/tasks.js";
import { missionRoutes } from "./routes/missions.js";
import { agentRoutes } from "./routes/agents.js";
import { eventRoutes } from "./routes/events.js";
import { chatRoutes } from "./routes/chat.js";
import { skillRoutes } from "./routes/skills.js";
import { notificationRoutes } from "./routes/notifications.js";
import { approvalRoutes } from "./routes/approvals.js";
import { templateRoutes } from "./routes/templates.js";
import { configRoutes } from "./routes/config.js";
import { stateRoutes } from "./routes/state.js";
import { completionRoutes } from "./routes/completions.js";
import { peerRoutes } from "./routes/peers.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { vaultRoutes } from "./routes/vault.js";

export type ServerEnv = {
  Variables: {
    orchestrator: Orchestrator;
  };
};

export interface AppOptions {
  apiKeys?: string[];
  corsOrigins?: string[];
}

/**
 * Create the Hono app with all routes and middleware.
 * Single-orchestrator architecture — no project concept.
 */
export function createApp(orchestrator: Orchestrator, sseBridge: SSEBridge, opts?: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono();

  // Global middleware
  app.use("*", errorMiddleware());
  app.use("*", rateLimitMiddleware());

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

  // OpenAI-compatible chat completions
  app.route("/v1/chat/completions", completionRoutes(orchestrator, opts?.apiKeys));

  // Authenticated routes
  const authed = new OpenAPIHono<ServerEnv>();
  if (opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }

  // Inject single orchestrator into all routes
  authed.use("*", async (c, next) => {
    c.set("orchestrator", orchestrator);
    return next();
  });

  // Mount all routes directly (no project prefix)
  authed.route("/tasks", taskRoutes());
  authed.route("/missions", missionRoutes());
  authed.route("/agents", agentRoutes());
  authed.route("/events", eventRoutes(sseBridge));
  authed.route("/chat", chatRoutes());
  authed.route("/skills", skillRoutes());
  authed.route("/notifications", notificationRoutes());
  authed.route("/approvals", approvalRoutes());
  authed.route("/templates", templateRoutes());
  authed.route("/config", configRoutes());
  authed.route("/peers", peerRoutes());
  authed.route("/schedules", scheduleRoutes());
  authed.route("/vault", vaultRoutes());
  authed.route("/", stateRoutes());

  app.route("/api/v1", authed);

  // OpenAPI spec endpoint
  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Polpo API",
      version: "1.0.0",
      description: "REST API for Polpo — an AI agent that manages teams of AI coding agents. Manage tasks, missions, agents, templates, skills, notifications, and approvals. For conversational interaction, use the OpenAI-compatible POST /v1/chat/completions endpoint.",
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
