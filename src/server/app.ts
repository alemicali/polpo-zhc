import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ProjectManager } from "./project-manager.js";
import { authMiddleware } from "./middleware/auth.js";
import { projectMiddleware } from "./middleware/project.js";
import { errorMiddleware } from "./middleware/error.js";
import { healthRoutes } from "./routes/health.js";
import { taskRoutes } from "./routes/tasks.js";
import { planRoutes } from "./routes/plans.js";
import { agentRoutes } from "./routes/agents.js";
import { eventRoutes } from "./routes/events.js";
import { chatRoutes } from "./routes/chat.js";
import { skillRoutes } from "./routes/skills.js";
import { notificationRoutes } from "./routes/notifications.js";
import { approvalRoutes } from "./routes/approvals.js";
import { workflowRoutes } from "./routes/workflows.js";
import { configRoutes } from "./routes/config.js";
import { projectListRoutes, projectDetailRoutes } from "./routes/projects.js";
import { completionRoutes } from "./routes/completions.js";
import { peerRoutes } from "./routes/peers.js";

export type ServerEnv = {
  Variables: {
    orchestrator: Orchestrator;
    projectId: string;
  };
};

export interface AppOptions {
  apiKeys?: string[];
  corsOrigins?: string[];
}

/**
 * Create the Hono app with all routes and middleware.
 */
export function createApp(pm: ProjectManager, opts?: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono();

  // Global middleware
  app.use("*", errorMiddleware());

  if (opts?.corsOrigins && opts.corsOrigins.length > 0) {
    app.use("*", cors({ origin: opts.corsOrigins }));
  } else {
    // Default: restrict to localhost origins only
    app.use("*", cors({
      origin: [
        "http://localhost:3000", "http://localhost:3001",
        "http://localhost:5173", "http://localhost:5174",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001",
        "http://127.0.0.1:5173", "http://127.0.0.1:5174",
      ],
    }));
  }

  // Health (no auth, no project context)
  app.route("/api/v1/health", healthRoutes());

  // OpenAI-compatible chat completions — Polpo's primary conversational interface
  app.route("/v1/chat/completions", completionRoutes(pm, opts?.apiKeys));

  // Authenticated routes
  const authed = new OpenAPIHono();
  if (opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }

  // Project listing (authenticated but no project context)
  authed.route("/projects", projectListRoutes(pm));

  // Per-project routes (authenticated + project context)
  const projectApp = new OpenAPIHono<ServerEnv>();
  projectApp.use("*", projectMiddleware(pm));

  // Mount sub-routes
  projectApp.route("/tasks", taskRoutes());
  projectApp.route("/plans", planRoutes());
  projectApp.route("/agents", agentRoutes());
  projectApp.route("/events", eventRoutes(pm));
  projectApp.route("/chat", chatRoutes());
  projectApp.route("/skills", skillRoutes());
  projectApp.route("/notifications", notificationRoutes());
  projectApp.route("/approvals", approvalRoutes());
  projectApp.route("/workflows", workflowRoutes());
  projectApp.route("/config", configRoutes());
  projectApp.route("/peers", peerRoutes());
  projectApp.route("/", projectDetailRoutes());

  authed.route("/projects/:projectId", projectApp);
  app.route("/api/v1", authed);

  // OpenAPI spec endpoint
  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Polpo API",
      version: "1.0.0",
      description: "REST API for Polpo — an AI agent that manages teams of AI coding agents. Manage projects, tasks, plans, agents, workflows, skills, notifications, and approvals. For conversational interaction, use the OpenAI-compatible POST /v1/chat/completions endpoint.",
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
