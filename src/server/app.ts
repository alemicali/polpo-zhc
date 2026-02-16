import { Hono } from "hono";
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
import { projectListRoutes, projectDetailRoutes } from "./routes/projects.js";

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
export function createApp(pm: ProjectManager, opts?: AppOptions): Hono {
  const app = new Hono();

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

  // Authenticated routes
  const authed = new Hono();
  if (opts?.apiKeys && opts.apiKeys.length > 0) {
    authed.use("*", authMiddleware(opts.apiKeys));
  }

  // Project listing (authenticated but no project context)
  authed.route("/projects", projectListRoutes(pm));

  // Per-project routes (authenticated + project context)
  const projectApp = new Hono<ServerEnv>();
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
  projectApp.route("/", projectDetailRoutes());

  authed.route("/projects/:projectId", projectApp);
  app.route("/api/v1", authed);

  return app;
}
