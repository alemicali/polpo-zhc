import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
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
  summary: "List missions",
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
  summary: "Get mission",
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
  summary: "Create mission",
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
  summary: "Update mission",
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
  summary: "Delete mission",
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
  summary: "Execute mission",
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
  summary: "Resume mission",
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
  summary: "List checkpoints",
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
  summary: "Resume checkpoint",
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
  summary: "Abort mission",
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
  summary: "Add mission task",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionTaskSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionTaskRoute = createRoute({
  method: "patch", path: "/{missionId}/tasks/{taskTitle}", tags: ["Missions"],
  summary: "Update mission task",
  request: { params: z.object({ missionId: z.string(), taskTitle: z.string() }), body: { content: { "application/json": { schema: UpdateMissionTaskSchema } } } },
  responses: missionOkResponse,
});

const removeMissionTaskRoute = createRoute({
  method: "delete", path: "/{missionId}/tasks/{taskTitle}", tags: ["Missions"],
  summary: "Remove mission task",
  request: { params: z.object({ missionId: z.string(), taskTitle: z.string() }) },
  responses: missionOkResponse,
});

const reorderMissionTasksRoute = createRoute({
  method: "put", path: "/{missionId}/tasks/reorder", tags: ["Missions"],
  summary: "Reorder mission tasks",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: ReorderMissionTasksSchema } } } },
  responses: missionOkResponse,
});

// Checkpoints
const addMissionCheckpointRoute = createRoute({
  method: "post", path: "/{missionId}/checkpoints", tags: ["Missions"],
  summary: "Add mission checkpoint",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionCheckpointSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionCheckpointRoute = createRoute({
  method: "patch", path: "/{missionId}/checkpoints/{checkpointName}", tags: ["Missions"],
  summary: "Update mission checkpoint",
  request: { params: z.object({ missionId: z.string(), checkpointName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionCheckpointSchema } } } },
  responses: missionOkResponse,
});

const removeMissionCheckpointRoute2 = createRoute({
  method: "delete", path: "/{missionId}/checkpoints/{checkpointName}", tags: ["Missions"],
  summary: "Remove mission checkpoint",
  request: { params: z.object({ missionId: z.string(), checkpointName: z.string() }) },
  responses: missionOkResponse,
});

// Delays
const listDelaysRoute = createRoute({
  method: "get", path: "/delays", tags: ["Missions"],
  summary: "List delays",
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } }, description: "List of active delays" } },
});

const addMissionDelayRoute = createRoute({
  method: "post", path: "/{missionId}/delays", tags: ["Missions"],
  summary: "Add mission delay",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionDelaySchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionDelayRoute = createRoute({
  method: "patch", path: "/{missionId}/delays/{delayName}", tags: ["Missions"],
  summary: "Update mission delay",
  request: { params: z.object({ missionId: z.string(), delayName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionDelaySchema } } } },
  responses: missionOkResponse,
});

const removeMissionDelayRoute = createRoute({
  method: "delete", path: "/{missionId}/delays/{delayName}", tags: ["Missions"],
  summary: "Remove mission delay",
  request: { params: z.object({ missionId: z.string(), delayName: z.string() }) },
  responses: missionOkResponse,
});

// Quality gates
const addMissionQualityGateRoute = createRoute({
  method: "post", path: "/{missionId}/quality-gates", tags: ["Missions"],
  summary: "Add quality gate",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionQualityGateSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionQualityGateRoute = createRoute({
  method: "patch", path: "/{missionId}/quality-gates/{gateName}", tags: ["Missions"],
  summary: "Update quality gate",
  request: { params: z.object({ missionId: z.string(), gateName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionQualityGateSchema } } } },
  responses: missionOkResponse,
});

const removeMissionQualityGateRoute = createRoute({
  method: "delete", path: "/{missionId}/quality-gates/{gateName}", tags: ["Missions"],
  summary: "Remove quality gate",
  request: { params: z.object({ missionId: z.string(), gateName: z.string() }) },
  responses: missionOkResponse,
});

// Team members
const addMissionTeamMemberRoute = createRoute({
  method: "post", path: "/{missionId}/team", tags: ["Missions"],
  summary: "Add team member",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: AddMissionTeamMemberSchema } } } },
  responses: { ...missionOkResponse, 201: missionOkResponse[200] },
});

const updateMissionTeamMemberRoute = createRoute({
  method: "patch", path: "/{missionId}/team/{memberName}", tags: ["Missions"],
  summary: "Update team member",
  request: { params: z.object({ missionId: z.string(), memberName: z.string() }), body: { content: { "application/json": { schema: UpdateMissionTeamMemberSchema } } } },
  responses: missionOkResponse,
});

const removeMissionTeamMemberRoute = createRoute({
  method: "delete", path: "/{missionId}/team/{memberName}", tags: ["Missions"],
  summary: "Remove team member",
  request: { params: z.object({ missionId: z.string(), memberName: z.string() }) },
  responses: missionOkResponse,
});

// Notifications
const updateMissionNotificationsRoute = createRoute({
  method: "put", path: "/{missionId}/notifications", tags: ["Missions"],
  summary: "Update mission notifications",
  request: { params: z.object({ missionId: z.string() }), body: { content: { "application/json": { schema: UpdateMissionNotificationsSchema } } } },
  responses: missionOkResponse,
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * Mission CRUD + execute/resume/abort routes.
 */
export function missionRoutes(getDeps: () => {
  getAllMissions: () => Promise<any[]>;
  getResumableMissions: () => Promise<any[]>;
  getMission: (id: string) => Promise<any>;
  saveMission: (opts: any) => Promise<any>;
  updateMission: (id: string, updates: any) => Promise<any>;
  deleteMission: (id: string) => Promise<boolean>;
  executeMission: (id: string) => Promise<any>;
  resumeMission: (id: string, opts?: any) => Promise<any>;
  abortGroup: (group: string) => Promise<number>;
  getActiveCheckpoints: () => any;
  resumeCheckpointByMissionId: (missionId: string, checkpointName: string) => Promise<boolean>;
  getActiveDelays: () => any;
  addMissionTask: (missionId: string, body: any) => Promise<any>;
  updateMissionTask: (missionId: string, taskTitle: string, body: any) => Promise<any>;
  removeMissionTask: (missionId: string, taskTitle: string) => Promise<any>;
  reorderMissionTasks: (missionId: string, titles: string[]) => Promise<any>;
  addMissionCheckpoint: (missionId: string, body: any) => Promise<any>;
  updateMissionCheckpoint: (missionId: string, name: string, body: any) => Promise<any>;
  removeMissionCheckpoint: (missionId: string, name: string) => Promise<any>;
  addMissionDelay: (missionId: string, body: any) => Promise<any>;
  updateMissionDelay: (missionId: string, name: string, body: any) => Promise<any>;
  removeMissionDelay: (missionId: string, name: string) => Promise<any>;
  addMissionQualityGate: (missionId: string, body: any) => Promise<any>;
  updateMissionQualityGate: (missionId: string, name: string, body: any) => Promise<any>;
  removeMissionQualityGate: (missionId: string, name: string) => Promise<any>;
  addMissionTeamMember: (missionId: string, body: any) => Promise<any>;
  updateMissionTeamMember: (missionId: string, name: string, body: any) => Promise<any>;
  removeMissionTeamMember: (missionId: string, name: string) => Promise<any>;
  updateMissionNotifications: (missionId: string, notifications: any) => Promise<any>;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /missions — list all missions
  app.openapi(listMissionsRoute, async (c) => {
    const deps = getDeps();
    return c.json({ ok: true, data: await deps.getAllMissions() });
  });

  // GET /missions/resumable — list resumable missions
  app.openapi(listResumableMissionsRoute, async (c) => {
    const deps = getDeps();
    return c.json({ ok: true, data: await deps.getResumableMissions() });
  });

  // GET /missions/:missionId — get mission by ID
  app.openapi(getMissionRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const mission = await deps.getMission(missionId);
    if (!mission) {
      return c.json({ ok: false, error: "Mission not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: mission }, 200);
  });

  // POST /missions — save mission
  app.openapi(createMissionRoute, async (c) => {
    const deps = getDeps();
    const body = c.req.valid("json");

    const mission = await deps.saveMission({
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
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const { endDate, ...rest } = c.req.valid("json");
    // Convert null endDate (clear) to undefined for the Mission interface
    const updates: Partial<Omit<import("@polpo-ai/core/types").Mission, "id">> = {
      ...rest,
      ...(endDate !== undefined ? { endDate: endDate ?? undefined } : {}),
    };
    const mission = await deps.updateMission(missionId, updates);
    return c.json({ ok: true, data: mission });
  });

  // DELETE /missions/:missionId — delete mission
  app.openapi(deleteMissionRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const deleted = await deps.deleteMission(missionId);
    if (!deleted) {
      return c.json({ ok: false, error: "Mission not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  // POST /missions/:missionId/execute — execute mission
  app.openapi(executeMissionRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const result = await deps.executeMission(missionId);
    return c.json({ ok: true, data: result });
  });

  // POST /missions/:missionId/resume — resume mission
  app.openapi(resumeMissionRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await deps.resumeMission(missionId, body);
    return c.json({ ok: true, data: result });
  });

  // GET /missions/checkpoints — list all active checkpoints
  app.openapi(listCheckpointsRoute, (c) => {
    const deps = getDeps();
    return c.json({ ok: true, data: deps.getActiveCheckpoints() });
  });

  // POST /missions/:missionId/checkpoints/:checkpointName/resume — resume a checkpoint
  app.openapi(resumeCheckpointRoute, async (c) => {
    const deps = getDeps();
    const { missionId, checkpointName } = c.req.valid("param");
    const resumed = await deps.resumeCheckpointByMissionId(missionId, checkpointName);
    if (!resumed) {
      return c.json({ ok: false, error: "Checkpoint not found or not active", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { resumed: true } }, 200);
  });

  // POST /missions/:missionId/abort — abort mission group
  app.openapi(abortMissionRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const mission = await deps.getMission(missionId);
    if (!mission) {
      return c.json({ ok: false, error: "Mission not found", code: "NOT_FOUND" }, 404);
    }
    const count = await deps.abortGroup(mission.name);
    return c.json({ ok: true, data: { aborted: count } }, 200);
  });

  // ── Atomic mission data handlers ──────────────────────────────────

  // POST /missions/:missionId/tasks — add task
  app.openapi(addMissionTaskRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.addMissionTask(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/tasks/:taskTitle — update task
  app.openapi(updateMissionTaskRoute, async (c) => {
    const deps = getDeps();
    const { missionId, taskTitle } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.updateMissionTask(missionId, decodeURIComponent(taskTitle), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/tasks/:taskTitle — remove task
  app.openapi(removeMissionTaskRoute, async (c) => {
    const deps = getDeps();
    const { missionId, taskTitle } = c.req.valid("param");
    try {
      const mission = await deps.removeMissionTask(missionId, decodeURIComponent(taskTitle));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // PUT /missions/:missionId/tasks/reorder — reorder tasks
  app.openapi(reorderMissionTasksRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const { titles } = c.req.valid("json");
    try {
      const mission = await deps.reorderMissionTasks(missionId, titles);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // POST /missions/:missionId/checkpoints — add checkpoint (data-level)
  app.openapi(addMissionCheckpointRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.addMissionCheckpoint(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/checkpoints/:checkpointName — update checkpoint (data-level)
  app.openapi(updateMissionCheckpointRoute, async (c) => {
    const deps = getDeps();
    const { missionId, checkpointName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.updateMissionCheckpoint(missionId, decodeURIComponent(checkpointName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/checkpoints/:checkpointName — remove checkpoint (data-level)
  app.openapi(removeMissionCheckpointRoute2, async (c) => {
    const deps = getDeps();
    const { missionId, checkpointName } = c.req.valid("param");
    try {
      const mission = await deps.removeMissionCheckpoint(missionId, decodeURIComponent(checkpointName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // GET /missions/delays — list active delays
  app.openapi(listDelaysRoute, (c) => {
    const deps = getDeps();
    return c.json({ ok: true, data: deps.getActiveDelays() });
  });

  // POST /missions/:missionId/delays — add delay (data-level)
  app.openapi(addMissionDelayRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.addMissionDelay(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/delays/:delayName — update delay (data-level)
  app.openapi(updateMissionDelayRoute, async (c) => {
    const deps = getDeps();
    const { missionId, delayName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.updateMissionDelay(missionId, decodeURIComponent(delayName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/delays/:delayName — remove delay (data-level)
  app.openapi(removeMissionDelayRoute, async (c) => {
    const deps = getDeps();
    const { missionId, delayName } = c.req.valid("param");
    try {
      const mission = await deps.removeMissionDelay(missionId, decodeURIComponent(delayName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // POST /missions/:missionId/quality-gates — add quality gate
  app.openapi(addMissionQualityGateRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.addMissionQualityGate(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/quality-gates/:gateName — update quality gate
  app.openapi(updateMissionQualityGateRoute, async (c) => {
    const deps = getDeps();
    const { missionId, gateName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.updateMissionQualityGate(missionId, decodeURIComponent(gateName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/quality-gates/:gateName — remove quality gate
  app.openapi(removeMissionQualityGateRoute, async (c) => {
    const deps = getDeps();
    const { missionId, gateName } = c.req.valid("param");
    try {
      const mission = await deps.removeMissionQualityGate(missionId, decodeURIComponent(gateName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // POST /missions/:missionId/team — add team member
  app.openapi(addMissionTeamMemberRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.addMissionTeamMember(missionId, body);
      return c.json({ ok: true, data: mission }, 201);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "BAD_REQUEST" }, 404);
    }
  });

  // PATCH /missions/:missionId/team/:memberName — update team member
  app.openapi(updateMissionTeamMemberRoute, async (c) => {
    const deps = getDeps();
    const { missionId, memberName } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const mission = await deps.updateMissionTeamMember(missionId, decodeURIComponent(memberName), body);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // DELETE /missions/:missionId/team/:memberName — remove team member
  app.openapi(removeMissionTeamMemberRoute, async (c) => {
    const deps = getDeps();
    const { missionId, memberName } = c.req.valid("param");
    try {
      const mission = await deps.removeMissionTeamMember(missionId, decodeURIComponent(memberName));
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  // PUT /missions/:missionId/notifications — update notifications
  app.openapi(updateMissionNotificationsRoute, async (c) => {
    const deps = getDeps();
    const { missionId } = c.req.valid("param");
    const { notifications } = c.req.valid("json");
    try {
      const mission = await deps.updateMissionNotifications(missionId, notifications);
      return c.json({ ok: true, data: mission }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e.message, code: "NOT_FOUND" }, 404);
    }
  });

  return app;
}
