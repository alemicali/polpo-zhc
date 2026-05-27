import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CreateTaskSchema, UpdateTaskSchema } from "../schemas.js";

// ── Route definitions ─────────────────────────────────────────────────

const listTasksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Tasks"],
  summary: "List tasks",
  request: {
    query: z.object({
      status: z.string().optional(),
      group: z.string().optional(),
      assignTo: z.string().optional(),
      summary: z.union([z.literal("true"), z.literal("false")]).optional().openapi({
        description: "If `true`, returns a slim projection: drops `outcomes`, `result.stdout/stderr` (keeps `result.assessment`), `expectations`, `metrics`, `maxRetries`, and truncates `description` to 200 chars. Default `false` — full record for backwards compat with the SDK and web UI. Bandwidth-sensitive clients (mobile) should opt in.",
      }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of tasks",
    },
  },
});

const getTaskRoute = createRoute({
  method: "get",
  path: "/{taskId}",
  tags: ["Tasks"],
  summary: "Get task",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Task details",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Task not found",
    },
  },
});

const createTaskRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Tasks"],
  summary: "Create task",
  request: {
    body: { content: { "application/json": { schema: CreateTaskSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Task created",
    },
    409: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "A task with this title already exists among active tasks",
    },
  },
});

const updateTaskRoute = createRoute({
  method: "patch",
  path: "/{taskId}",
  tags: ["Tasks"],
  summary: "Update task",
  request: {
    params: z.object({ taskId: z.string() }),
    body: { content: { "application/json": { schema: UpdateTaskSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Task updated",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Task not found",
    },
  },
});

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/{taskId}",
  tags: ["Tasks"],
  summary: "Delete task",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.boolean() }) }) } },
      description: "Task removed",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Task not found",
    },
  },
});

const retryTaskRoute = createRoute({
  method: "post",
  path: "/{taskId}/retry",
  tags: ["Tasks"],
  summary: "Retry task",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ retried: z.boolean() }) }) } },
      description: "Task retried",
    },
  },
});

const killTaskRoute = createRoute({
  method: "post",
  path: "/{taskId}/kill",
  tags: ["Tasks"],
  summary: "Kill task",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ killed: z.boolean() }) }) } },
      description: "Task killed",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Task not found",
    },
  },
});

const reassessTaskRoute = createRoute({
  method: "post",
  path: "/{taskId}/reassess",
  tags: ["Tasks"],
  summary: "Re-run task assessment",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ reassessed: z.boolean() }) }) } },
      description: "Task reassessed",
    },
  },
});

const queueTaskRoute = createRoute({
  method: "post",
  path: "/{taskId}/queue",
  tags: ["Tasks"],
  summary: "Queue task",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ queued: z.boolean() }) }) } },
      description: "Task queued",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Task not found",
    },
  },
});

const forceFailTaskRoute = createRoute({
  method: "post",
  path: "/{taskId}/force-fail",
  tags: ["Tasks"],
  summary: "Force fail task",
  request: {
    params: z.object({ taskId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ failed: z.boolean() }) }) } },
      description: "Task force-failed",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Task not found",
    },
  },
});

const bulkDeleteTasksRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Tasks"],
  summary: "Bulk delete tasks",
  request: {
    query: z.object({
      status: z.string().optional(),
      group: z.string().optional(),
      all: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ deleted: z.number() }) }) } },
      description: "Tasks deleted",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "No filter specified",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * Task CRUD + action routes.
 */
export function taskRoutes(getDeps: () => {
  taskStore: any;
  wakeSupervisor?: () => void;
  addTask: (opts: any) => Promise<any>;
  deleteTask: (taskId: string) => Promise<any>;
  retryTask: (taskId: string) => Promise<any>;
  killTask: (taskId: string) => Promise<any>;
  reassessTask: (taskId: string) => Promise<any>;
  forceFailTask: (taskId: string) => Promise<any>;
  updateTaskDescription: (taskId: string, desc: string) => Promise<any>;
  updateTaskAssignment: (taskId: string, agent: string) => Promise<any>;
  updateTaskExpectations: (taskId: string, exp: any) => Promise<any>;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /tasks — list all tasks, optional filters
  app.openapi(listTasksRoute, async (c) => {
    const deps = getDeps();
    let tasks = await deps.taskStore.getAllTasks();

    // Optional filters
    const { status, group, assignTo, summary } = c.req.valid("query");

    if (status) tasks = tasks.filter((t: any) => t.status === status);
    if (group) tasks = tasks.filter((t: any) => t.group === group);
    if (assignTo) tasks = tasks.filter((t: any) => t.assignTo === assignTo);

    // Slim projection: kicks in only when the client opts in via ?summary=true.
    // Keeps every field the list rows in web/mobile actually render (id, title,
    // status, phase, assignTo, group, dependsOn, retries, timestamps, plus the
    // small `result.assessment` block for the score badge). Drops the heavy
    // tail — outcomes, stdout/stderr, expectations, metrics — that only the
    // detail screen needs and that GET /tasks/:id already returns.
    if (summary === "true") {
      tasks = tasks.map((t: any) => {
        const desc = typeof t.description === "string" ? t.description : "";
        // result.assessment carries checks[] with full descriptions — that
        // alone makes the field 100-200KB per task and dominates the summary
        // payload (~8MB across 369 tasks observed in dev). The list rows
        // only need the score, the pass/fail flag, and the checks count for
        // the badge. The detail screen (GET /tasks/:id) returns the full
        // assessment when the user actually wants it.
        const assess = t.result && typeof t.result === "object" ? t.result.assessment : null;
        const slimAssessment = assess && typeof assess === "object"
          ? {
              globalScore: assess.globalScore,
              passed: assess.passed,
              checksCount: Array.isArray(assess.checks) ? assess.checks.length : 0,
            }
          : null;
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          phase: t.phase,
          assignTo: t.assignTo,
          group: t.group,
          missionId: t.missionId,
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
          retries: t.retries ?? 0,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          descriptionPreview: desc.length > 200 ? desc.slice(0, 200) : desc,
          ...(slimAssessment ? { result: { assessment: slimAssessment } } : {}),
        };
      });
    }

    return c.json({ ok: true, data: tasks });
  });

  // GET /tasks/:taskId — get single task
  app.openapi(getTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const task = await deps.taskStore.getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: task }, 200);
  });

  // POST /tasks — create task
  app.openapi(createTaskRoute, async (c) => {
    const deps = getDeps();
    const body = c.req.valid("json");

    const task = await deps.addTask({
      title: body.title,
      description: body.description,
      assignTo: body.assignTo,
      expectations: body.expectations,
      expectedOutcomes: body.expectedOutcomes,
      dependsOn: body.dependsOn,
      group: body.group,
      maxDuration: body.maxDuration,
      retryPolicy: body.retryPolicy,
      notifications: body.notifications,
      sideEffects: body.sideEffects,
      draft: body.draft,
    });

    if (task.status !== "draft") deps.wakeSupervisor?.();
    return c.json({ ok: true, data: task }, 201);
  });

  // PATCH /tasks/:taskId — update task description and/or assignment
  app.openapi(updateTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const body = c.req.valid("json");

    const task = await deps.taskStore.getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }

    if (body.status !== undefined) {
      await deps.taskStore.unsafeSetStatus(taskId, body.status as any, "manual status update via API");
      if (body.status === "pending") deps.wakeSupervisor?.();
    }
    if (body.description !== undefined) {
      await deps.updateTaskDescription(taskId, body.description);
    }
    if (body.assignTo !== undefined) {
      await deps.updateTaskAssignment(taskId, body.assignTo);
    }
    if (body.expectations !== undefined) {
      await deps.updateTaskExpectations(taskId, body.expectations);
    }
    if (body.retries !== undefined || body.maxRetries !== undefined) {
      const patch: Record<string, number> = {};
      if (body.retries !== undefined) patch.retries = body.retries;
      if (body.maxRetries !== undefined) patch.maxRetries = body.maxRetries;
      await deps.taskStore.updateTask(taskId, patch);
    }
    if (body.sideEffects !== undefined) {
      await deps.taskStore.updateTask(taskId, { sideEffects: body.sideEffects });
    }

    const updated = await deps.taskStore.getTask(taskId);
    return c.json({ ok: true, data: updated }, 200);
  });

  // DELETE /tasks/:taskId — remove task
  app.openapi(deleteTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const removed = await deps.deleteTask(taskId);
    if (!removed) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } }, 200);
  });

  // POST /tasks/:taskId/retry — retry failed task
  app.openapi(retryTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    await deps.retryTask(taskId);
    deps.wakeSupervisor?.();
    return c.json({ ok: true, data: { retried: true } });
  });

  // POST /tasks/:taskId/kill — kill running task
  app.openapi(killTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const killed = await deps.killTask(taskId);
    if (!killed) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { killed: true } }, 200);
  });

  // POST /tasks/:taskId/reassess — re-run assessment
  app.openapi(reassessTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    await deps.reassessTask(taskId);
    return c.json({ ok: true, data: { reassessed: true } });
  });

  // POST /tasks/:taskId/queue — transition draft → pending
  app.openapi(queueTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const task = await deps.taskStore.getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    if (task.status !== "draft") {
      return c.json({ ok: false, error: `Task is not in draft state (current: ${task.status})`, code: "INVALID_STATE" }, 404);
    }
    await deps.taskStore.transition(taskId, "pending");
    deps.wakeSupervisor?.();
    return c.json({ ok: true, data: { queued: true } }, 200);
  });

  // POST /tasks/:taskId/force-fail — force a task to failed state
  app.openapi(forceFailTaskRoute, async (c) => {
    const deps = getDeps();
    const { taskId } = c.req.valid("param");
    const task = await deps.taskStore.getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    await deps.forceFailTask(taskId);
    return c.json({ ok: true, data: { failed: true } }, 200);
  });

  // DELETE /tasks — bulk delete tasks by filter
  app.openapi(bulkDeleteTasksRoute, async (c) => {
    const deps = getDeps();
    const query = c.req.valid("query");

    if (!query.status && !query.group && query.all !== "true") {
      return c.json({ ok: false, error: "Specify ?status=, ?group=, or ?all=true", code: "NO_FILTER" }, 400);
    }

    let filter: (t: any) => boolean;
    if (query.all === "true") {
      filter = () => true;
    } else if (query.status && query.group) {
      filter = (t: any) => t.status === query.status && t.group === query.group;
    } else if (query.status) {
      filter = (t: any) => t.status === query.status;
    } else {
      filter = (t: any) => t.group === query.group;
    }

    const deleted = await deps.taskStore.removeTasks(filter);
    return c.json({ ok: true, data: { deleted } }, 200);
  });

  return app;
}
