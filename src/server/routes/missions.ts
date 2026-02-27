import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { CreateMissionSchema, UpdateMissionSchema } from "../schemas.js";

// ── Route definitions ─────────────────────────────────────────────────

const listMissionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Missions"],
  summary: "List all missions",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of missions",
    },
  },
});

const listResumableMissionsRoute = createRoute({
  method: "get",
  path: "/resumable",
  tags: ["Missions"],
  summary: "List resumable missions",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of resumable missions",
    },
  },
});

const getMissionRoute = createRoute({
  method: "get",
  path: "/{missionId}",
  tags: ["Missions"],
  summary: "Get a mission by ID",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Mission details",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Mission not found",
    },
  },
});

const createMissionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Missions"],
  summary: "Save a new mission",
  request: {
    body: { content: { "application/json": { schema: CreateMissionSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Mission created",
    },
  },
});

const updateMissionRoute = createRoute({
  method: "patch",
  path: "/{missionId}",
  tags: ["Missions"],
  summary: "Update a mission",
  request: {
    params: z.object({ missionId: z.string() }),
    body: { content: { "application/json": { schema: UpdateMissionSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Mission updated",
    },
  },
});

const deleteMissionRoute = createRoute({
  method: "delete",
  path: "/{missionId}",
  tags: ["Missions"],
  summary: "Delete a mission",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ deleted: z.boolean() }) }) } },
      description: "Mission deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Mission not found",
    },
  },
});

const executeMissionRoute = createRoute({
  method: "post",
  path: "/{missionId}/execute",
  tags: ["Missions"],
  summary: "Execute a mission",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Mission execution result",
    },
  },
});

const resumeMissionRoute = createRoute({
  method: "post",
  path: "/{missionId}/resume",
  tags: ["Missions"],
  summary: "Resume a mission",
  request: {
    params: z.object({ missionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ retryFailed: z.boolean().optional() }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Mission resumed",
    },
  },
});

const listCheckpointsRoute = createRoute({
  method: "get",
  path: "/checkpoints",
  tags: ["Missions"],
  summary: "List all active checkpoints",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of active checkpoints",
    },
  },
});

const resumeCheckpointRoute = createRoute({
  method: "post",
  path: "/{missionId}/checkpoints/{checkpointName}/resume",
  tags: ["Missions"],
  summary: "Resume a checkpoint",
  request: {
    params: z.object({ missionId: z.string(), checkpointName: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ resumed: z.boolean() }) }) } },
      description: "Checkpoint resumed",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Checkpoint not found or not active",
    },
  },
});

const abortMissionRoute = createRoute({
  method: "post",
  path: "/{missionId}/abort",
  tags: ["Missions"],
  summary: "Abort a mission",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ aborted: z.number() }) }) } },
      description: "Mission aborted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Mission not found",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * Mission CRUD + execute/resume/abort routes.
 */
export function missionRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /missions — list all missions
  app.openapi(listMissionsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getAllMissions() });
  });

  // GET /missions/resumable — list resumable missions
  app.openapi(listResumableMissionsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getResumableMissions() });
  });

  // GET /missions/:missionId — get mission by ID
  app.openapi(getMissionRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const mission = orchestrator.getMission(missionId);
    if (!mission) {
      return c.json({ ok: false, error: "Mission not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: mission }, 200);
  });

  // POST /missions — save mission
  app.openapi(createMissionRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const mission = orchestrator.saveMission({
      data: body.data,
      prompt: body.prompt,
      name: body.name,
      status: body.status,
      notifications: body.notifications,
    });

    return c.json({ ok: true, data: mission }, 201);
  });

  // PATCH /missions/:missionId — update mission
  app.openapi(updateMissionRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const mission = orchestrator.updateMission(missionId, body);
    return c.json({ ok: true, data: mission });
  });

  // DELETE /missions/:missionId — delete mission
  app.openapi(deleteMissionRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const deleted = orchestrator.deleteMission(missionId);
    if (!deleted) {
      return c.json({ ok: false, error: "Mission not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  // POST /missions/:missionId/execute — execute mission
  app.openapi(executeMissionRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const result = orchestrator.executeMission(missionId);
    return c.json({ ok: true, data: result });
  });

  // POST /missions/:missionId/resume — resume mission
  app.openapi(resumeMissionRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = orchestrator.resumeMission(missionId, body);
    return c.json({ ok: true, data: result });
  });

  // GET /missions/checkpoints — list all active checkpoints
  app.openapi(listCheckpointsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getActiveCheckpoints() });
  });

  // POST /missions/:missionId/checkpoints/:checkpointName/resume — resume a checkpoint
  app.openapi(resumeCheckpointRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, checkpointName } = c.req.valid("param");
    const resumed = orchestrator.resumeCheckpointByMissionId(missionId, checkpointName);
    if (!resumed) {
      return c.json({ ok: false, error: "Checkpoint not found or not active", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { resumed: true } }, 200);
  });

  // POST /missions/:missionId/abort — abort mission group
  app.openapi(abortMissionRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const mission = orchestrator.getMission(missionId);
    if (!mission) {
      return c.json({ ok: false, error: "Mission not found", code: "NOT_FOUND" }, 404);
    }
    const count = orchestrator.abortGroup(mission.name);
    return c.json({ ok: true, data: { aborted: count } }, 200);
  });

  return app;
}
