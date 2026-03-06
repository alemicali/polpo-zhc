import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import {
  discoverTemplates,
  loadTemplate,
  validateParams,
  instantiateTemplate,
  saveTemplate,
  deleteTemplate,
} from "../../core/template.js";
import type { TemplateParameter } from "../../core/template.js";

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
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const templates = discoverTemplates(workDir, polpoDir);
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
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");
    const template = loadTemplate(workDir, polpoDir, name);

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
    summary: "Run template",
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
        content: { "application/json": { schema: z.object({
          ok: z.boolean(),
          data: z.object({
            mission: z.any(),
            tasks: z.number(),
            group: z.string(),
            warnings: z.array(z.string()).optional(),
          }),
        }) } },
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
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");

    const template = loadTemplate(workDir, polpoDir, name);
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
        ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
      },
    }, 201);
  });

  // POST /templates — create or update a template
  const createTemplateRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Templates"],
    summary: "Save template",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().describe("Template name (kebab-case)"),
              description: z.string().describe("Human-readable description"),
              mission: z.record(z.string(), z.any()).describe("Mission template body with {{placeholder}} syntax"),
              parameters: z.array(z.object({
                name: z.string(),
                description: z.string(),
                type: z.enum(["string", "number", "boolean"]).optional(),
                required: z.boolean().optional(),
                default: z.union([z.string(), z.number(), z.boolean()]).optional(),
                enum: z.array(z.union([z.string(), z.number()])).optional(),
              })).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Template created",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Invalid template definition",
      },
    },
  });

  app.openapi(createTemplateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir?.();
    if (!polpoDir) {
      return c.json({ ok: false, error: "Polpo directory not available", code: "NO_POLPO_DIR" }, 400);
    }

    const body = c.req.valid("json");
    const definition = {
      name: body.name,
      description: body.description,
      mission: body.mission,
      parameters: body.parameters as TemplateParameter[] | undefined,
    };

    try {
      const dir = saveTemplate(polpoDir, definition);
      return c.json({ ok: true, data: { name: definition.name, path: dir } }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg, code: "VALIDATION_ERROR" }, 400);
    }
  });

  // DELETE /templates/:name — delete a template
  const deleteTemplateRoute = createRoute({
    method: "delete",
    path: "/{name}",
    tags: ["Templates"],
    summary: "Delete template",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        description: "Template deleted",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Template not found",
      },
    },
  });

  app.openapi(deleteTemplateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir?.();
    const { name } = c.req.valid("param");

    const deleted = deleteTemplate(workDir, polpoDir, name);
    if (!deleted) {
      return c.json({ ok: false, error: "Template not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
