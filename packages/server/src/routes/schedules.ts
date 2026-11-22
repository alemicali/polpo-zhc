import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { scheduleExpressionProblem } from "@polpo-ai/core";

// ── Schemas ───────────────────────────────────────────────────────────

const CatchUpSchema = z.enum(["none", "once"]).describe(
  "A run missed while the server was down: \"once\" (default) runs it at startup when it is at most one interval late (24 h for a one-shot), \"none\" skips to the next run",
);

const CreateScheduleSchema = z.object({
  missionId: z.string().min(1),
  expression: z.string().min(1),
  recurring: z.boolean().optional(),
  endDate: z.string().datetime().optional(),
  catchUp: CatchUpSchema.optional(),
});

const UpdateScheduleSchema = z.object({
  expression: z.string().min(1).optional(),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
  endDate: z.string().datetime().nullable().optional(),
  catchUp: CatchUpSchema.optional(),
});

/**
 * A schedule as the API shows it: the entry, plus `paused` and `catchUp` spelled out. Pause,
 * next/last run, last outcome and missed runs are persisted: a restart keeps them.
 */
function scheduleView(entry: any): any {
  if (!entry) return entry;
  // paused: stopped by someone with a run still ahead; a one-shot that ran (or expired) is done, not paused
  return { ...entry, paused: !entry.enabled && !!entry.nextRunAt, catchUp: entry.catchUp ?? "once", missedRuns: entry.missedRuns ?? 0 };
}

// ── Route definitions ─────────────────────────────────────────────────

const listSchedulesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Schedules"],
  summary: "List schedules",
  description: "Every mission schedule: paused or not, next and last run, how the last run went, runs missed while the server was down.",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of schedule entries",
    },
  },
});

const getScheduleRoute = createRoute({
  method: "get",
  path: "/{missionId}",
  tags: ["Schedules"],
  summary: "Get a schedule",
  description: "One mission's schedule: paused or not, next and last run, how the last run went, runs missed while the server was down.",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "The schedule",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Schedule not found",
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
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Invalid expression",
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

const runScheduleRoute = createRoute({
  method: "post",
  path: "/{missionId}/run",
  tags: ["Schedules"],
  summary: "Run a scheduled mission now",
  description: "Runs the mission out of turn; the next scheduled run stays as it is, and a paused schedule stays paused.",
  request: {
    params: z.object({ missionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "The schedule, with its new lastRunAt",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Schedule not found",
    },
    409: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "The mission cannot run now",
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

  // POST /schedules/:missionId/run — run it now
  app.openapi(runScheduleRoute, async (c) => {
    const scheduler = getDeps().getScheduler();
    const { missionId } = c.req.valid("param");
    if (!scheduler?.getScheduleByMissionId(missionId)) {
      return c.json({ ok: false, error: `No schedule found for mission "${missionId}"`, code: "NOT_FOUND" }, 404);
    }
    try {
      return c.json({ ok: true, data: scheduleView(scheduler.runNow(missionId)) }, 200);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), code: "CANNOT_RUN" }, 409);
    }
  });

  // GET /schedules — list all schedule entries
  app.openapi(listSchedulesRoute, (c) => {
    const deps = getDeps();
    const schedules = deps.getScheduler()?.getAllSchedules() ?? [];
    return c.json({ ok: true, data: schedules.map(scheduleView) });
  });

  // GET /schedules/:missionId — one schedule
  app.openapi(getScheduleRoute, (c) => {
    const { missionId } = c.req.valid("param");
    const entry = getDeps().getScheduler()?.getScheduleByMissionId(missionId);
    if (!entry) return c.json({ ok: false, error: `No schedule found for mission "${missionId}"`, code: "NOT_FOUND" }, 404);
    return c.json({ ok: true, data: scheduleView(entry) }, 200);
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
    // checked before the mission changes: a bad expression leaves it as it was
    const problem = scheduleExpressionProblem(body.expression, { recurring: isRecurring });
    if (problem) return c.json({ ok: false, error: problem, code: "INVALID_EXPRESSION" }, 400);
    const newStatus = isRecurring ? "recurring" : "scheduled";
    const missionUpdate: Record<string, unknown> = {
      schedule: body.expression,
      status: newStatus,
    };
    if (body.endDate !== undefined) {
      missionUpdate.endDate = body.endDate;
    }
    const updatedMission = await deps.updateMission(body.missionId, missionUpdate as any);

    const entry = scheduler.registerMission(updatedMission, "created", body.catchUp ? { catchUp: body.catchUp } : undefined);
    if (!entry) {
      return c.json({ ok: false, error: "Could not create schedule. Expression may be invalid or timestamp is in the past.", code: "INVALID_EXPRESSION" }, 400);
    }

    return c.json({ ok: true, data: scheduleView(entry) }, 201);
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
      const problem = scheduleExpressionProblem(body.expression, { recurring: body.recurring ?? existing.recurring });
      if (problem) return c.json({ ok: false, error: problem, code: "INVALID_EXPRESSION" }, 400);
    }

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
      scheduler.rescheduleMission(updated);
    }

    if (body.recurring !== undefined && body.expression === undefined) {
      const isRecurring = body.recurring;
      existing.recurring = isRecurring;
      const newStatus = isRecurring ? "recurring" : "scheduled";
      await deps.updateMission(missionId, { status: newStatus });
      const mission = await deps.getMission(missionId);
      if (mission) {
        scheduler.rescheduleMission(mission);
      }
    }

    if (body.enabled !== undefined) {
      scheduler.setEnabled(missionId, body.enabled);
    }

    if (body.catchUp !== undefined) {
      scheduler.setCatchUp(missionId, body.catchUp);
    }

    if (body.endDate !== undefined) {
      const endDate = body.endDate ?? undefined;
      await deps.updateMission(missionId, { endDate } as any);
    }

    const updated = scheduler.getScheduleByMissionId(missionId);
    return c.json({ ok: true, data: scheduleView(updated) }, 200);
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
