import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
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
export function workflowRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /workflows — list available workflows
  const listWorkflowsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Workflows"],
    summary: "List available workflows",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of workflows",
      },
    },
  });

  app.openapi(listWorkflowsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const workflows = discoverWorkflows(cwd, polpoDir);
    return c.json({ ok: true, data: workflows });
  });

  // GET /workflows/:name — get workflow details
  const getWorkflowRoute = createRoute({
    method: "get",
    path: "/{name}",
    tags: ["Workflows"],
    summary: "Get workflow details",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Workflow details",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Workflow not found",
      },
    },
  });

  app.openapi(getWorkflowRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");
    const workflow = loadWorkflow(cwd, polpoDir, name);

    if (!workflow) {
      return c.json({ ok: false, error: "Workflow not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true, data: workflow }, 200);
  });

  // POST /workflows/:name/run — execute workflow with parameters
  const runWorkflowRoute = createRoute({
    method: "post",
    path: "/{name}/run",
    tags: ["Workflows"],
    summary: "Execute workflow with parameters",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Workflow executed",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string(), details: z.any() }) } },
        description: "Parameter validation failed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Workflow not found",
      },
    },
  });

  app.openapi(runWorkflowRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");

    const workflow = loadWorkflow(cwd, polpoDir, name);
    if (!workflow) {
      return c.json({ ok: false, error: "Workflow not found", code: "NOT_FOUND" }, 404);
    }

    const body = c.req.valid("json");
    const params = (body.params ?? {}) as Record<string, string | number | boolean>;

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
