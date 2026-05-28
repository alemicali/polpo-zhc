import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CreateTaskSchema, UpdateTaskSchema } from "../schemas.js";
import { buildETag, handleConditional, quickFingerprint } from "../etag.js";

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
      // `slim` is an alias for `summary` — the web UI uses `slim=true`
      // by convention (matches `/agents?slim=true`). Either flag triggers
      // the same projection; kept distinct so docs can keep both names.
      slim: z.union([z.literal("true"), z.literal("false")]).optional().openapi({
        description: "Alias for `summary=true`. Returns the slim projection (id, title, status, phase, assignTo, group, missionId, dependsOn, retries, timestamps, optional slim assessment, descriptionPreview).",
      }),
      // Cursor pagination. Activating `limit` or `cursor` switches the
      // response envelope from `{ tasks: Task[] }` to
      // `{ tasks, nextCursor, hasMore }`.
      limit: z.string().optional().openapi({
        description: "Page size (default 50, max 200). Presence triggers the paginated response shape `{ tasks, nextCursor, hasMore }`.",
      }),
      cursor: z.string().optional().openapi({
        description: "ISO timestamp from a previous page's `nextCursor`. Returns tasks with `updated_at < cursor`. Ignored when `q` is set.",
      }),
      q: z.string().optional().openapi({
        description: "Full-text search across task title and description. Uses SQLite FTS5 with prefix matching. When set, results are ranked by relevance and `cursor` is ignored.",
      }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "List of tasks. Returns `{ tasks, nextCursor, hasMore }` when `limit`/`cursor`/`q` is set, otherwise `Task[]` for backwards compat.",
    },
    304: {
      description: "Not modified — client has the current list per ETag",
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
 * Slim projection used by both the legacy list path and the paginated one.
 * Keeps the fields list rows actually render and drops the heavy tail
 * (outcomes, stdout/stderr, expectations, metrics). The full record is
 * still served by `GET /tasks/:id`.
 */
function projectSlim(t: any): any {
  const desc = typeof t.description === "string" ? t.description : "";
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
}

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
    const { status, group, assignTo, summary, slim, limit, cursor, q } = c.req.valid("query");

    // ── Paginated path ────────────────────────────────────────────────
    // Triggered by *any* of `limit`, `cursor`, or `q`. Uses the SQLite
    // FTS5 + cursor query when the store exposes `getTasksPage()`;
    // otherwise falls back to fetch-all + in-memory filtering so the file
    // store and tests keep working.
    const usePagination = limit !== undefined || cursor !== undefined || q !== undefined;
    if (usePagination) {
      const parsedLimit = limit ? Math.max(1, Math.min(200, parseInt(limit, 10) || 50)) : 50;
      let page: { tasks: any[]; nextCursor: string | null; hasMore: boolean };

      const taskStore = deps.taskStore as { getTasksPage?: (opts: any) => Promise<any> };
      if (typeof taskStore.getTasksPage === "function") {
        page = await taskStore.getTasksPage({
          limit: parsedLimit,
          cursor: cursor ?? null,
          q: q ?? null,
          status: status ?? null,
          group: group ?? null,
          assignTo: assignTo ?? null,
        });
      } else {
        // Fallback: fetch everything, filter + sort in memory.
        let all = await deps.taskStore.getAllTasks();
        if (status) all = all.filter((t: any) => t.status === status);
        if (group) all = all.filter((t: any) => t.group === group);
        if (assignTo) all = all.filter((t: any) => t.assignTo === assignTo);
        if (q && q.trim().length > 0) {
          const needle = q.toLowerCase();
          all = all.filter((t: any) =>
            (t.title ?? "").toLowerCase().includes(needle) ||
            (t.description ?? "").toLowerCase().includes(needle)
          );
        }
        // Newest-updated first; cursor filter is `updated_at < cursor`.
        all.sort((a: any, b: any) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        if (cursor) all = all.filter((t: any) => (t.updatedAt ?? "") < cursor);
        const sliced = all.slice(0, parsedLimit + 1);
        const hasMore = sliced.length > parsedLimit;
        const tasks = hasMore ? sliced.slice(0, parsedLimit) : sliced;
        page = {
          tasks,
          nextCursor: hasMore && tasks.length > 0 ? tasks[tasks.length - 1].updatedAt : null,
          hasMore,
        };
      }

      // Same slim projection used in the legacy path.
      const wantSlim = summary === "true" || slim === "true";
      const projected = wantSlim ? page.tasks.map((t: any) => projectSlim(t)) : page.tasks;
      return c.json({
        ok: true,
        data: {
          tasks: projected,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
      });
    }

    // ── Legacy path (backward compat) ─────────────────────────────────
    let tasks = await deps.taskStore.getAllTasks();
    if (status) tasks = tasks.filter((t: any) => t.status === status);
    if (group) tasks = tasks.filter((t: any) => t.group === group);
    if (assignTo) tasks = tasks.filter((t: any) => t.assignTo === assignTo);

    // `slim=true` is an alias for `summary=true`. Slim projection kicks in
    // only when the client opts in. Keeps every field the list rows render;
    // drops the heavy tail (outcomes, stdout/stderr, expectations, metrics).
    const wantSlim = summary === "true" || slim === "true";
    if (wantSlim) tasks = tasks.map((t: any) => projectSlim(t));

    // Conditional GET — return 304 if the client already has this exact list.
    // Fingerprint runs on the (possibly filtered & slimmed) array so different
    // query combinations get distinct ETags.
    const etag = buildETag(quickFingerprint(tasks));
    if (handleConditional(c, etag)) return c.body(null, 304);

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
