import type { MiddlewareHandler } from "hono";
import type { ProjectManager } from "../project-manager.js";
import type { ServerEnv } from "../app.js";

/**
 * Project resolution middleware.
 * Extracts :projectId from URL, resolves via ProjectManager,
 * and injects the Orchestrator into the Hono context.
 */
export function projectMiddleware(pm: ProjectManager): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      return c.json(
        { ok: false, error: "Project ID required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const orchestrator = pm.get(projectId);
    if (!orchestrator) {
      return c.json(
        { ok: false, error: `Project not found: ${projectId}`, code: "NOT_FOUND" },
        404
      );
    }

    c.set("orchestrator", orchestrator);
    c.set("projectId", projectId);
    return next();
  };
}
