import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import {
  discoverTemplates,
  loadTemplate,
  validateParams,
  instantiateTemplate,
} from "../../core/template.js";

/**
 * Template routes — discover, inspect, and execute reusable plan templates.
 */
export function templateRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /templates — list available templates
  const listTemplatesRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Templates"],
    summary: "List available templates",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of templates",
      },
    },
  });

  app.openapi(listTemplatesRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const templates = discoverTemplates(cwd, polpoDir);
    return c.json({ ok: true, data: templates });
  });

  // GET /templates/:name — get template details
  const getTemplateRoute = createRoute({
    method: "get",
    path: "/{name}",
    tags: ["Templates"],
    summary: "Get template details",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Template details",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Template not found",
      },
    },
  });

  app.openapi(getTemplateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");
    const template = loadTemplate(cwd, polpoDir, name);

    if (!template) {
      return c.json({ ok: false, error: "Template not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true, data: template }, 200);
  });

  // POST /templates/:name/run — execute template with parameters
  const runTemplateRoute = createRoute({
    method: "post",
    path: "/{name}/run",
    tags: ["Templates"],
    summary: "Execute template with parameters",
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
        description: "Template executed",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string(), details: z.any() }) } },
        description: "Parameter validation failed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Template not found",
      },
    },
  });

  app.openapi(runTemplateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const cwd = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");

    const template = loadTemplate(cwd, polpoDir, name);
    if (!template) {
      return c.json({ ok: false, error: "Template not found", code: "NOT_FOUND" }, 404);
    }

    const body = c.req.valid("json");
    const params = (body.params ?? {}) as Record<string, string | number | boolean>;

    // Validate parameters
    const validation = validateParams(template, params);
    if (!validation.valid) {
      return c.json({
        ok: false,
        error: "Parameter validation failed",
        code: "VALIDATION_ERROR",
        details: validation.errors,
      }, 400);
    }

    // Instantiate
    const instance = instantiateTemplate(template, validation.resolved);

    // Save as mission and execute
    const mission = orchestrator.saveMission({
      data: instance.data,
      prompt: instance.prompt,
      name: instance.name,
    });

    const result = orchestrator.executeMission(mission.id);

    return c.json({
      ok: true,
      data: {
        mission,
        tasks: result.tasks.length,
        group: result.group,
      },
    }, 201);
  });

  return app;
}
