import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import {
  discoverWorkflows,
  loadWorkflow,
  validateParams,
  instantiateWorkflow,
} from "../../core/workflow.js";

/**
 * Workflow routes — discover, inspect, and execute reusable workflow templates.
 */
export function workflowRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /workflows — list available workflows
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const workflows = discoverWorkflows(cwd, polpoDir);
    return c.json({ ok: true, data: workflows });
  });

  // GET /workflows/:name — get workflow details
  app.get("/:name", (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const name = c.req.param("name");
    const workflow = loadWorkflow(cwd, polpoDir, name);

    if (!workflow) {
      return c.json({ ok: false, error: "Workflow not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true, data: workflow });
  });

  // POST /workflows/:name/run — execute workflow with parameters
  app.post("/:name/run", async (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const name = c.req.param("name");

    const workflow = loadWorkflow(cwd, polpoDir, name);
    if (!workflow) {
      return c.json({ ok: false, error: "Workflow not found", code: "NOT_FOUND" }, 404);
    }

    const body = await c.req.json<{ params?: Record<string, string | number | boolean> }>().catch(() => ({ params: {} }));
    const params = body.params ?? {};

    // Validate parameters
    const validation = validateParams(workflow, params);
    if (!validation.valid) {
      return c.json({
        ok: false,
        error: "Parameter validation failed",
        code: "VALIDATION_ERROR",
        details: validation.errors,
      }, 400);
    }

    // Instantiate
    const instance = instantiateWorkflow(workflow, validation.resolved);

    // Save as plan and execute
    const plan = orchestrator.savePlan({
      data: instance.data,
      prompt: instance.prompt,
      name: instance.name,
    });

    const result = orchestrator.executePlan(plan.id);

    return c.json({
      ok: true,
      data: {
        plan,
        tasks: result.tasks.length,
        group: result.group,
      },
    }, 201);
  });

  return app;
}
