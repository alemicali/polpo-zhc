import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import type { CreateTaskRequest, UpdateTaskRequest } from "../types.js";

/**
 * Task CRUD + action routes.
 */
export function taskRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /tasks — list all tasks, optional filters
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    let tasks = orchestrator.getStore().getAllTasks();

    // Optional filters
    const status = c.req.query("status");
    const group = c.req.query("group");
    const assignTo = c.req.query("assignTo");

    if (status) tasks = tasks.filter(t => t.status === status);
    if (group) tasks = tasks.filter(t => t.group === group);
    if (assignTo) tasks = tasks.filter(t => t.assignTo === assignTo);

    return c.json({ ok: true, data: tasks });
  });

  // GET /tasks/:taskId — get single task
  app.get("/:taskId", (c) => {
    const orchestrator = c.get("orchestrator");
    const task = orchestrator.getStore().getTask(c.req.param("taskId"));
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: task });
  });

  // POST /tasks — create task
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<CreateTaskRequest>();

    if (!body.title || !body.description || !body.assignTo) {
      return c.json(
        { ok: false, error: "title, description, and assignTo are required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const task = orchestrator.addTask({
      title: body.title,
      description: body.description,
      assignTo: body.assignTo,
      expectations: body.expectations,
      dependsOn: body.dependsOn,
      group: body.group,
      maxDuration: body.maxDuration,
      retryPolicy: body.retryPolicy,
    });

    return c.json({ ok: true, data: task }, 201);
  });

  // PATCH /tasks/:taskId — update task description and/or assignment
  app.patch("/:taskId", async (c) => {
    const orchestrator = c.get("orchestrator");
    const taskId = c.req.param("taskId");
    const body = await c.req.json<UpdateTaskRequest>();

    const task = orchestrator.getStore().getTask(taskId);
    if (!task) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
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

    const updated = orchestrator.getStore().getTask(taskId);
    return c.json({ ok: true, data: updated });
  });

  // DELETE /tasks/:taskId — remove task
  app.delete("/:taskId", (c) => {
    const orchestrator = c.get("orchestrator");
    const taskId = c.req.param("taskId");
    const removed = orchestrator.getStore().removeTask(taskId);
    if (!removed) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } });
  });

  // POST /tasks/:taskId/retry — retry failed task
  app.post("/:taskId/retry", (c) => {
    const orchestrator = c.get("orchestrator");
    orchestrator.retryTask(c.req.param("taskId"));
    return c.json({ ok: true, data: { retried: true } });
  });

  // POST /tasks/:taskId/kill — kill running task
  app.post("/:taskId/kill", (c) => {
    const orchestrator = c.get("orchestrator");
    const killed = orchestrator.killTask(c.req.param("taskId"));
    if (!killed) {
      return c.json({ ok: false, error: "Task not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { killed: true } });
  });

  // POST /tasks/:taskId/reassess — re-run assessment
  app.post("/:taskId/reassess", async (c) => {
    const orchestrator = c.get("orchestrator");
    await orchestrator.reassessTask(c.req.param("taskId"));
    return c.json({ ok: true, data: { reassessed: true } });
  });

  return app;
}
