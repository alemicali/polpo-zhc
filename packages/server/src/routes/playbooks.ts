import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  validateParams,
  instantiatePlaybook,
  missionNameErrors,
  type PlaybookParameter,
  type PlaybookDefinition,
} from "../playbook-utils.js";

/**
 * A task blocked by a checkpoint, delay or quality gate must also depend on that gate's
 * afterTasks, or the mission is refused. Playbooks written by hand or by an agent often
 * lack those dependencies: add them when the playbook runs.
 */
export function withFlowControlDependencies(data: string): string {
  let mission: { tasks?: Array<{ title?: string; dependsOn?: string[] }>; [k: string]: unknown };
  try { mission = JSON.parse(data); } catch { return data; }
  if (!Array.isArray(mission.tasks)) return data;
  const tasks = mission.tasks;
  let changed = false;
  for (const kind of ["checkpoints", "delays", "qualityGates"]) {
    const gates = mission[kind];
    if (!Array.isArray(gates)) continue;
    for (const gate of gates as Array<{ afterTasks?: string[]; blocksTasks?: string[] }>) {
      for (const blocked of gate.blocksTasks ?? []) {
        const task = tasks.find((t) => t.title === blocked);
        if (!task) continue;
        const deps = new Set(task.dependsOn ?? []);
        for (const after of gate.afterTasks ?? []) {
          if (after !== blocked && !deps.has(after)) { deps.add(after); changed = true; }
        }
        task.dependsOn = [...deps];
      }
    }
  }
  return changed ? JSON.stringify(mission) : data;
}

/**
 * Playbook routes — discover, inspect, and execute reusable mission playbooks.
 *
 * All persistence goes through PlaybookStore (injected via getDeps()).
 */
/** What running a playbook needs (the REST route and the trigger action engine pass the same). */
export interface PlaybookRunDeps {
  playbookStore: any;
  saveMission: (opts: any) => Promise<any>;
  executeMission: (id: string, opts?: any) => Promise<any>;
  /** Called when a playbook is run, with its mission and the names of the parameters given. */
  onRun?: (name: string, missionId: string, params: string[]) => void;
  /** Removes a mission that could not start. */
  deleteMission?: (missionId: string) => Promise<unknown>;
}

/** Why a playbook did not run: 404 (no such playbook) or 400 (parameters, an invalid mission). */
export class PlaybookRunError extends Error {
  constructor(message: string, readonly status: 400 | 404, readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "INVALID_MISSION", readonly details?: string[]) {
    super(message);
  }
}

/**
 * Run a playbook: validate the parameters, instantiate it, save the mission and execute it. The one
 * path every surface uses (REST POST /playbooks/{name}/run, and the trigger action engine, which
 * adds `missionOpts` (the work's origin and owner) and `executeOpts` (requestedBy and origin)).
 */
export async function runPlaybook(
  deps: PlaybookRunDeps,
  name: string,
  params: Record<string, string | number | boolean>,
  o: { missionOpts?: Record<string, unknown>; executeOpts?: Record<string, unknown> } = {},
): Promise<{ mission: any; tasks: number; group: string; warnings: string[] }> {
  const playbook = await deps.playbookStore.get(name);
  if (!playbook) throw new PlaybookRunError("Playbook not found", 404, "NOT_FOUND");
  const validation = validateParams(playbook, params);
  if (!validation.valid) throw new PlaybookRunError("Parameter validation failed", 400, "VALIDATION_ERROR", validation.errors);
  const instance = instantiatePlaybook(playbook, validation.resolved);
  instance.data = withFlowControlDependencies(instance.data);
  const mission = await deps.saveMission({ data: instance.data, prompt: instance.prompt, name: instance.name, ...(o.missionOpts ?? {}) });
  deps.onRun?.(name, mission.id, Object.keys(params));
  let result;
  try {
    result = o.executeOpts ? await deps.executeMission(mission.id, o.executeOpts) : await deps.executeMission(mission.id);
  } catch (err) {
    // An invalid mission (e.g. a checkpoint without the matching dependsOn) must not surface as a
    // bare 500 the dashboard cannot parse, nor leave a mission behind that can never start.
    await deps.deleteMission?.(mission.id).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new PlaybookRunError(`The playbook cannot run: ${message}`, 400, "INVALID_MISSION", [message]);
  }
  return { mission, tasks: result.tasks.length, group: result.group, warnings: validation.warnings };
}

export function playbookRoutes(getDeps: () => PlaybookRunDeps): OpenAPIHono {
  const app = new OpenAPIHono();

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
    const deps = getDeps();
    const playbooks = await deps.playbookStore.list();
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
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const playbook = await deps.playbookStore.get(name);

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
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const r = await runPlaybook(getDeps(), name, (body.params ?? {}) as Record<string, string | number | boolean>);
      return c.json({
        ok: true,
        data: { mission: r.mission, tasks: r.tasks, group: r.group, ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}) },
      }, 201);
    } catch (err) {
      if (!(err instanceof PlaybookRunError)) throw err;
      if (err.status === 404) return c.json({ ok: false, error: err.message, code: err.code }, 404);
      return c.json({ ok: false, error: err.message, code: err.code, details: err.details }, 400);
    }
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
              missionName: z.string().optional().describe("Name of the mission a run creates, with the same {{placeholder}} syntax (default: the playbook name)"),
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
    const deps = getDeps();

    const body = c.req.valid("json");
    const definition: PlaybookDefinition = {
      name: body.name,
      description: body.description,
      mission: body.mission,
      parameters: body.parameters as PlaybookParameter[] | undefined,
      ...(body.missionName !== undefined ? { missionName: body.missionName } : {}),
    };

    const nameErrors = missionNameErrors(definition);
    if (nameErrors.length > 0) {
      return c.json({ ok: false, error: `Invalid playbook definition: ${nameErrors.join(" ")}`, code: "VALIDATION_ERROR" }, 400);
    }

    try {
      const dir = await deps.playbookStore.save(definition);
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
    const deps = getDeps();
    const { name } = c.req.valid("param");

    const deleted = await deps.playbookStore.delete(name);
    if (!deleted) {
      return c.json({ ok: false, error: "Playbook not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
