import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import {
  CreateMissionSchema, UpdateMissionSchema,
  AddMissionTaskSchema, UpdateMissionTaskSchema, ReorderMissionTasksSchema,
  AddMissionCheckpointSchema, UpdateMissionCheckpointSchema,
  AddMissionDelaySchema, UpdateMissionDelaySchema,
  AddMissionQualityGateSchema, UpdateMissionQualityGateSchema,
  AddMissionTeamMemberSchema, UpdateMissionTeamMemberSchema,
  UpdateMissionNotificationsSchema,
} from "../schemas.js";

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

// ── Atomic mission data route definitions ─────────────────────────────

const missionOkResponse = {
  200: {
    content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
    description: "Updated mission",
  },
  404: {
    content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
    description: "Mission or entity not found",
  },
};

// Tasks
const addMissionTaskRoute = createRoute({
  method: "post", path: "/{missionId}/tasks", tags: ["Missions"],
  summary: "Add a task to mission data",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionTaskSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionTaskRoute = createRoute({
  method: "patch", path: "/{missionId}/tasks/{taskTitle}", tags: ["Missions"],
  summary: "Update a task in mission data",
  request: { params: z.object({ missionId: z.string(), taskTitle: z.string() }), body: { content: { "application/json": { schema: UpdateMissionTaskSchema } } } },
  responses: missionOkResponse,
});

const removeMissionTaskRoute = createRoute({
  method: "delete", path: "/{missionId}/tasks/{taskTitle}", tags: ["Missions"],
  summary: "Remove a task from mission data",
  request: { params: z.object({ missionId: z.string(), taskTitle: z.string() }) },
  responses: missionOkResponse,
});

const reorderMissionTasksRoute = createRoute({
  method: "put", path: "/{missionId}/tasks/reorder", tags: ["Missions"],
  summary: "Reorder tasks in mission data",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: ReorderMissionTasksSchema } } } },
  responses: missionOkResponse,
});

// Checkpoints
const addMissionCheckpointRoute = createRoute({
  method: "post", path: "/{missionId}/checkpoints", tags: ["Missions"],
  summary: "Add a checkpoint to mission data",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionCheckpointSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionCheckpointRoute = createRoute({
  method: "patch", path: "/{missionId}/checkpoints/{checkpointName}", tags: ["Missions"],
  summary: "Update a checkpoint in mission data",
  request: { params: z.object({ missionId: z.string(), checkpointName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionCheckpointSchema } } } },
  responses: missionOkResponse,
});

const removeMissionCheckpointRoute2 = createRoute({
  method: "delete", path: "/{missionId}/checkpoints/{checkpointName}", tags: ["Missions"],
  summary: "Remove a checkpoint from mission data",
  request: { params: z.object({ missionId: z.string(), checkpointName: z.string() }) },
  responses: missionOkResponse,
});

// Delays
const listDelaysRoute = createRoute({
  method: "get", path: "/delays", tags: ["Missions"],
  summary: "List all active delays",
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } }, description: "List of active delays" } },
});

const addMissionDelayRoute = createRoute({
  method: "post", path: "/{missionId}/delays", tags: ["Missions"],
  summary: "Add a delay to mission data",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionDelaySchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionDelayRoute = createRoute({
  method: "patch", path: "/{missionId}/delays/{delayName}", tags: ["Missions"],
  summary: "Update a delay in mission data",
  request: { params: z.object({ missionId: z.string(), delayName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionDelaySchema } } } },
  responses: missionOkResponse,
});

const removeMissionDelayRoute = createRoute({
  method: "delete", path: "/{missionId}/delays/{delayName}", tags: ["Missions"],
  summary: "Remove a delay from mission data",
  request: { params: z.object({ missionId: z.string(), delayName: z.string() }) },
  responses: missionOkResponse,
});

// Quality gates
const addMissionQualityGateRoute = createRoute({
  method: "post", path: "/{missionId}/quality-gates", tags: ["Missions"],
  summary: "Add a quality gate to mission data",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionQualityGateSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionQualityGateRoute = createRoute({
  method: "patch", path: "/{missionId}/quality-gates/{gateName}", tags: ["Missions"],
  summary: "Update a quality gate in mission data",
  request: { params: z.object({ missionId: z.string(), gateName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionQualityGateSchema } } } },
  responses: missionOkResponse,
});

const removeMissionQualityGateRoute = createRoute({
  method: "delete", path: "/{missionId}/quality-gates/{gateName}", tags: ["Missions"],
  summary: "Remove a quality gate from mission data",
  request: { params: z.object({ missionId: z.string(), gateName: z.string() }) },
  responses: missionOkResponse,
});

// Team members
const addMissionTeamMemberRoute = createRoute({
  method: "post", path: "/{missionId}/team", tags: ["Missions"],
  summary: "Add a volatile team member to mission data",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionTeamMemberSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionTeamMemberRoute = createRoute({
  method: "patch", path: "/{missionId}/team/{memberName}", tags: ["Missions"],
  summary: "Update a volatile team member in mission data",
  request: { params: z.object({ missionId: z.string(), memberName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionTeamMemberSchema } } } },
  responses: missionOkResponse,
});

const removeMissionTeamMemberRoute = createRoute({
  method: "delete", path: "/{missionId}/team/{memberName}", tags: ["Missions"],
  summary: "Remove a volatile team member from mission data",
  request: { params: z.object({ missionId: z.string(), memberName: z.string() }) },
  responses: missionOkResponse,
});

// Notifications
const updateMissionNotificationsRoute = createRoute({
  method: "put", path: "/{missionId}/notifications", tags: ["Missions"],
  summary: "Update or clear mission-level notification rules",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: UpdateMissionNotificationsSchema } } } },
  responses: missionOkResponse,
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
    const { endDate, ...rest } = c.req.valid("json");
    // Convert null endDate (clear) to undefined for the Mission interface
    const updates: Partial<Omit<import("../../core/types.js").Mission, "id">> = {
      ...rest,
      ...(endDate !== undefined ? { endDate: endDate ?? undefined } : {}),
    };
    const mission = orchestrator.updateMission(missionId, updates);
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

  // ── Atomic mission data handlers ──────────────────────────────────

  // POST /missions/:missionId/tasks — add task
  app.openapi(addMissionTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.addMissionTask(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/tasks/:taskTitle — update task
  app.openapi(updateMissionTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, taskTitle } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.updateMissionTask(missionId, decodeURIComponent(taskTitle), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/tasks/:taskTitle — remove task
  app.openapi(removeMissionTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, taskTitle } = c.req.valid("param");
    try {
      const mission = orchestrator.removeMissionTask(missionId, decodeURIComponent(taskTitle));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // PUT /missions/:missionId/tasks/reorder — reorder tasks
  app.openapi(reorderMissionTasksRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const { titles } = c.req.valid("json");
    try {
      const mission = orchestrator.reorderMissionTasks(missionId, titles);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // POST /missions/:missionId/checkpoints — add checkpoint (data-level)
  app.openapi(addMissionCheckpointRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.addMissionCheckpoint(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/checkpoints/:checkpointName — update checkpoint (data-level)
  app.openapi(updateMissionCheckpointRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, checkpointName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.updateMissionCheckpoint(missionId, decodeURIComponent(checkpointName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/checkpoints/:checkpointName — remove checkpoint (data-level)
  app.openapi(removeMissionCheckpointRoute2, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, checkpointName } = c.req.valid("param");
    try {
      const mission = orchestrator.removeMissionCheckpoint(missionId, decodeURIComponent(checkpointName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // GET /missions/delays — list active delays
  app.openapi(listDelaysRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getActiveDelays() });
  });

  // POST /missions/:missionId/delays — add delay (data-level)
  app.openapi(addMissionDelayRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.addMissionDelay(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/delays/:delayName — update delay (data-level)
  app.openapi(updateMissionDelayRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, delayName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.updateMissionDelay(missionId, decodeURIComponent(delayName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/delays/:delayName — remove delay (data-level)
  app.openapi(removeMissionDelayRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, delayName } = c.req.valid("param");
    try {
      const mission = orchestrator.removeMissionDelay(missionId, decodeURIComponent(delayName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // POST /missions/:missionId/quality-gates — add quality gate
  app.openapi(addMissionQualityGateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.addMissionQualityGate(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/quality-gates/:gateName — update quality gate
  app.openapi(updateMissionQualityGateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, gateName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.updateMissionQualityGate(missionId, decodeURIComponent(gateName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/quality-gates/:gateName — remove quality gate
  app.openapi(removeMissionQualityGateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, gateName } = c.req.valid("param");
    try {
      const mission = orchestrator.removeMissionQualityGate(missionId, decodeURIComponent(gateName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // POST /missions/:missionId/team — add team member
  app.openapi(addMissionTeamMemberRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.addMissionTeamMember(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/team/:memberName — update team member
  app.openapi(updateMissionTeamMemberRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, memberName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = orchestrator.updateMissionTeamMember(missionId, decodeURIComponent(memberName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/team/:memberName — remove team member
  app.openapi(removeMissionTeamMemberRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId, memberName } = c.req.valid("param");
    try {
      const mission = orchestrator.removeMissionTeamMember(missionId, decodeURIComponent(memberName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // PUT /missions/:missionId/notifications — update notifications
  app.openapi(updateMissionNotificationsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { missionId } = c.req.valid("param");
    const { notifications } = c.req.valid("json");
    try {
      const mission = orchestrator.updateMissionNotifications(missionId, notifications);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  return app;
}
