import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { CreateTaskSchema, UpdateTaskSchema } from "../schemas.js";

// ── Route definitions ─────────────────────────────────────────────────

const listTasksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Tasks"],
  summary: "List all tasks",
  request: {
    query: z.object({
      status: z.string().optional(),
      group: z.string().optional(),
      assignTo: z.string().optional(),
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
  summary: "Get a single task",
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
  summary: "Create a new task",
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
  summary: "Update a task",
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
  summary: "Delete a task",
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
  summary: "Retry a failed task",
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
  summary: "Kill a running task",
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
  summary: "Queue a draft task (transition draft → pending)",
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

// ── Route handlers ────────────────────────────────────────────────────

/**
 * Task CRUD + action routes.
 */
export function taskRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /tasks — list all tasks, optional filters
  app.openapi(listTasksRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    let tasks = orchestrator.getStore().getAllTasks();

    // Optional filters
    const { status, group, assignTo } = c.req.valid("query");

    if (status) tasks = tasks.filter(t => t.status === status);
    if (group) tasks = tasks.filter(t => t.group === group);
    if (assignTo) tasks = tasks.filter(t => t.assignTo === assignTo);

    return c.json({ ok: true, data: tasks });
  });

  // GET /tasks/:taskId — get single task
  app.openapi(getTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const task = orchestrator.getStore().getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: task }, 200);
  });

  // POST /tasks — create task
  app.openapi(createTaskRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const task = orchestrator.addTask({
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
      draft: body.draft,
    });

    return c.json({ ok: true, data: task }, 201);
  });

  // PATCH /tasks/:taskId — update task description and/or assignment
  app.openapi(updateTaskRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const body = c.req.valid("json");

    const task = orchestrator.getStore().getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }

    if (body.status !== undefined) {
      orchestrator.getStore().unsafeSetStatus(taskId, body.status as any, "manual status update via API");
    }
    if (body.description !== undefined) {
      orchestrator.updateTaskDescription(taskId, body.description);
    }
    if (body.assignTo !== undefined) {
      orchestrator.updateTaskAssignment(taskId, body.assignTo);
    }
    if (body.expectations !== undefined) {
      orchestrator.updateTaskExpectations(taskId, body.expectations);
    }
    if (body.retries !== undefined || body.maxRetries !== undefined) {
      const patch: Record<string, number> = {};
      if (body.retries !== undefined) patch.retries = body.retries;
      if (body.maxRetries !== undefined) patch.maxRetries = body.maxRetries;
      orchestrator.getStore().updateTask(taskId, patch);
    }

    const updated = orchestrator.getStore().getTask(taskId);
    return c.json({ ok: true, data: updated }, 200);
  });

  // DELETE /tasks/:taskId — remove task
  app.openapi(deleteTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const removed = orchestrator.deleteTask(taskId);
    if (!removed) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } }, 200);
  });

  // POST /tasks/:taskId/retry — retry failed task
  app.openapi(retryTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    orchestrator.retryTask(taskId);
    return c.json({ ok: true, data: { retried: true } });
  });

  // POST /tasks/:taskId/kill — kill running task
  app.openapi(killTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const killed = orchestrator.killTask(taskId);
    if (!killed) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { killed: true } }, 200);
  });

  // POST /tasks/:taskId/reassess — re-run assessment
  app.openapi(reassessTaskRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    await orchestrator.reassessTask(taskId);
    return c.json({ ok: true, data: { reassessed: true } });
  });

  // POST /tasks/:taskId/queue — transition draft → pending
  app.openapi(queueTaskRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { taskId } = c.req.valid("param");
    const task = orchestrator.getStore().getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    if (task.status !== "draft") {
      return c.json({ ok: false, error: `Task is not in draft state (current: ${task.status})`, code: "INVALID_STATE" }, 404);
    }
    orchestrator.getStore().transition(taskId, "pending");
    return c.json({ ok: true, data: { queued: true } }, 200);
  });

  return app;
}
