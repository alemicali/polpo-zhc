import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

// ── Schemas ───────────────────────────────────────────────────────────

const CreateScheduleSchema = z.object({
  missionId: z.string().min(1),
  expression: z.string().min(1),
  recurring: z.boolean().optional(),
  endDate: z.string().datetime().optional(),
});

const UpdateScheduleSchema = z.object({
  expression: z.string().min(1).optional(),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
  endDate: z.string().datetime().nullable().optional(),
});

// ── Route definitions ─────────────────────────────────────────────────

const listSchedulesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Schedules"],
  summary: "List schedules",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of schedule entries",
    },
  },
});

const createScheduleRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Schedules"],
  summary: "Create schedule",
  request: {
    body: { content: { "application/json": { schema: CreateScheduleSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Schedule created",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Invalid expression or scheduler unavailable",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Mission not found",
    },
  },
});

const updateScheduleRoute = createRoute({
  method: "patch",
  path: "/{missionId}",
  tags: ["Schedules"],
  summary: "Update schedule",
  request: {
    params: z.object({ missionId: z.string() }),
    body: { content: { "application/json": { schema: UpdateScheduleSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Schedule updated",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Schedule not found",
    },
  },
});

const deleteScheduleRoute = createRoute({
  method: "delete",
  path: "/{missionId}",
  tags: ["Schedules"],
  summary: "Delete schedule",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ deleted: z.boolean() }) }) } },
      description: "Schedule deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Schedule not found",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

export function scheduleRoutes(getDeps: () => {
  getScheduler: () => any;
  getMission: (id: string) => Promise<any>;
  updateMission: (id: string, updates: any) => Promise<any>;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /schedules — list all schedule entries
  app.openapi(listSchedulesRoute, (c) => {
    const deps = getDeps();
    const schedules = deps.getScheduler()?.getAllSchedules() ?? [];
    return c.json({ ok: true, data: schedules });
  });

  // POST /schedules — create a schedule for a mission
  app.openapi(createScheduleRoute, async (c) => {
    const deps = getDeps();
    const scheduler = deps.getScheduler();
    if (!scheduler) {
      return c.json({ ok: false, error: "Scheduler not available", code: "SCHEDULER_UNAVAILABLE" }, 400);
    }

    const body = c.req.valid("json");
    const mission = await deps.getMission(body.missionId);
    if (!mission) {
      return c.json({ ok: false, error: `Mission "${body.missionId}" not found`, code: "NOT_FOUND" }, 404);
    }

    const isRecurring = body.recurring ?? false;
    const newStatus = isRecurring ? "recurring" : "scheduled";
    const missionUpdate: Record<string, unknown> = {
      schedule: body.expression,
      status: newStatus,
    };
    if (body.endDate !== undefined) {
      missionUpdate.endDate = body.endDate;
    }
    const updatedMission = await deps.updateMission(body.missionId, missionUpdate as any);

    const entry = scheduler.registerMission(updatedMission);
    if (!entry) {
      return c.json({ ok: false, error: "Could not create schedule. Expression may be invalid or timestamp is in the past.", code: "INVALID_EXPRESSION" }, 400);
    }

    return c.json({ ok: true, data: entry }, 201);
  });

  // PATCH /schedules/:missionId — update a schedule
  app.openapi(updateScheduleRoute, async (c) => {
    const deps = getDeps();
    const scheduler = deps.getScheduler();
    if (!scheduler) {
      return c.json({ ok: false, error: "Scheduler not available", code: "SCHEDULER_UNAVAILABLE" }, 404);
    }

    const { missionId } = c.req.valid("param");
    const existing = scheduler.getScheduleByMissionId(missionId);
    if (!existing) {
      return c.json({ ok: false, error: `No schedule found for mission "${missionId}"`, code: "NOT_FOUND" }, 404);
    }

    const body = c.req.valid("json");

    if (body.expression !== undefined) {
      const mission = await deps.getMission(missionId);
      if (!mission) {
        return c.json({ ok: false, error: `Mission "${missionId}" not found`, code: "NOT_FOUND" }, 404);
      }
      const isRecurring = body.recurring ?? existing.recurring;
      const newStatus = isRecurring ? "recurring" : "scheduled";
      const updated = await deps.updateMission(missionId, {
        schedule: body.expression,
        status: newStatus,
      });
      scheduler.unregisterMission(missionId);
      scheduler.registerMission(updated);
    }

    if (body.recurring !== undefined && body.expression === undefined) {
      const isRecurring = body.recurring;
      existing.recurring = isRecurring;
      const newStatus = isRecurring ? "recurring" : "scheduled";
      await deps.updateMission(missionId, { status: newStatus });
      const mission = await deps.getMission(missionId);
      if (mission) {
        scheduler.unregisterMission(missionId);
        scheduler.registerMission(mission);
      }
    }

    if (body.enabled !== undefined) {
      existing.enabled = body.enabled;
    }

    if (body.endDate !== undefined) {
      const endDate = body.endDate ?? undefined;
      await deps.updateMission(missionId, { endDate } as any);
    }

    const updated = scheduler.getScheduleByMissionId(missionId);
    return c.json({ ok: true, data: updated }, 200);
  });

  // DELETE /schedules/:missionId — delete a schedule
  app.openapi(deleteScheduleRoute, async (c) => {
    const deps = getDeps();
    const scheduler = deps.getScheduler();
    if (!scheduler) {
      return c.json({ ok: false, error: "Scheduler not available", code: "SCHEDULER_UNAVAILABLE" }, 404);
    }

    const { missionId } = c.req.valid("param");
    const deleted = scheduler.unregisterMission(missionId);
    if (!deleted) {
      return c.json({ ok: false, error: `No schedule found for mission "${missionId}"`, code: "NOT_FOUND" }, 404);
    }

    // Clear schedule from mission and reset status to draft
    await deps.updateMission(missionId, { schedule: undefined, status: "draft" });
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  return app;
}
