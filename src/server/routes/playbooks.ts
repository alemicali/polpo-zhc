import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import {
  validateParams,
  instantiatePlaybook,
} from "../../core/playbook.js";
import type { PlaybookParameter, PlaybookDefinition } from "../../core/playbook.js";

/**
 * Playbook routes — discover, inspect, and execute reusable mission playbooks.
 *
 * All persistence goes through PlaybookStore (from orchestrator.getPlaybookStore()).
 */
export function playbookRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /playbooks — list available playbooks
  const listPlaybooksRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Playbooks"],
    summary: "List available playbooks",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of playbooks",
      },
    },
  });

  app.openapi(listPlaybooksRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const playbookStore = orchestrator.getPlaybookStore();
    const playbooks = await playbookStore.list();
    return c.json({ ok: true, data: playbooks });
  });

  // GET /playbooks/:name — get playbook details
  const getPlaybookRoute = createRoute({
    method: "get",
    path: "/{name}",
    tags: ["Playbooks"],
    summary: "Get playbook details",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Playbook details",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Playbook not found",
      },
    },
  });

  app.openapi(getPlaybookRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const playbookStore = orchestrator.getPlaybookStore();
    const { name } = c.req.valid("param");
    const playbook = await playbookStore.get(name);

    if (!playbook) {
      return c.json({ ok: false, error: "Playbook not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true, data: playbook }, 200);
  });

  // POST /playbooks/:name/run — execute playbook with parameters
  const runPlaybookRoute = createRoute({
    method: "post",
    path: "/{name}/run",
    tags: ["Playbooks"],
    summary: "Run playbook",
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
        description: "Playbook executed",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string(), details: z.any() }) } },
        description: "Parameter validation failed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Playbook not found",
      },
    },
  });

  app.openapi(runPlaybookRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const playbookStore = orchestrator.getPlaybookStore();
    const { name } = c.req.valid("param");

    const playbook = await playbookStore.get(name);
    if (!playbook) {
      return c.json({ ok: false, error: "Playbook not found", code: "NOT_FOUND" }, 404);
    }

    const body = c.req.valid("json");
    const params = (body.params ?? {}) as Record<string, string | number | boolean>;

    // Validate parameters
    const validation = validateParams(playbook, params);
    if (!validation.valid) {
      return c.json({
        ok: false,
        error: "Parameter validation failed",
        code: "VALIDATION_ERROR",
        details: validation.errors,
      }, 400);
    }

    // Instantiate
    const instance = instantiatePlaybook(playbook, validation.resolved);

    // Save as mission and execute
    const mission = await orchestrator.saveMission({
      data: instance.data,
      prompt: instance.prompt,
      name: instance.name,
    });

    const result = await orchestrator.executeMission(mission.id);

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

  // POST /playbooks — create or update a playbook
  const createPlaybookRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Playbooks"],
    summary: "Save playbook",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().describe("Playbook name (kebab-case)"),
              description: z.string().describe("Human-readable description"),
              mission: z.record(z.string(), z.any()).describe("Mission playbook body with {{placeholder}} syntax"),
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
        description: "Playbook created",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Invalid playbook definition",
      },
    },
  });

  app.openapi(createPlaybookRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const playbookStore = orchestrator.getPlaybookStore();

    const body = c.req.valid("json");
    const definition: PlaybookDefinition = {
      name: body.name,
      description: body.description,
      mission: body.mission,
      parameters: body.parameters as PlaybookParameter[] | undefined,
    };

    try {
      const dir = await playbookStore.save(definition);
      return c.json({ ok: true, data: { name: definition.name, path: dir } }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg, code: "VALIDATION_ERROR" }, 400);
    }
  });

  // DELETE /playbooks/:name — delete a playbook
  const deletePlaybookRoute = createRoute({
    method: "delete",
    path: "/{name}",
    tags: ["Playbooks"],
    summary: "Delete playbook",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        description: "Playbook deleted",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Playbook not found",
      },
    },
  });

  app.openapi(deletePlaybookRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const playbookStore = orchestrator.getPlaybookStore();
    const { name } = c.req.valid("param");

    const deleted = await playbookStore.delete(name);
    if (!deleted) {
      return c.json({ ok: false, error: "Playbook not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
