import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

// ── Route definitions ─────────────────────────────────────────────────

const listWatchersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Watchers"],
  summary: "List watchers",
  request: {
    query: z.object({
      active: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of watchers",
    },
  },
});

const createWatcherRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Watchers"],
  summary: "Create watcher",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            taskId: z.string().min(1),
            targetStatus: z.enum(["pending", "assigned", "in_progress", "review", "done", "failed", "awaiting_approval"]),
            action: z.object({
              type: z.string().min(1),
            }).passthrough(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Watcher created",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Watcher manager unavailable or task not found",
    },
  },
});

const deleteWatcherRoute = createRoute({
  method: "delete",
  path: "/{watcherId}",
  tags: ["Watchers"],
  summary: "Delete watcher",
  request: {
    params: z.object({ watcherId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ deleted: z.boolean() }) }) } },
      description: "Watcher deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Watcher not found",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

export function watcherRoutes(getDeps: () => {
  getWatcherManager: () => any;
  taskStore: any;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /watchers — list watchers
  app.openapi(listWatchersRoute, (c) => {
    const deps = getDeps();
    const watcherMgr = deps.getWatcherManager();
    if (!watcherMgr) {
      return c.json({ ok: true, data: [] });
    }
    const query = c.req.valid("query");
    const watchers = query.active === "true" ? watcherMgr.getActive() : watcherMgr.getAll();
    return c.json({ ok: true, data: watchers });
  });

  // POST /watchers — create a watcher
  app.openapi(createWatcherRoute, async (c) => {
    const deps = getDeps();
    const watcherMgr = deps.getWatcherManager();
    if (!watcherMgr) {
      return c.json({ ok: false, error: "Watcher manager not available", code: "NOT_AVAILABLE" }, 400);
    }

    const body = c.req.valid("json");
    const task = await deps.taskStore.getTask(body.taskId);
    if (!task) {
      return c.json({ ok: false, error: `Task "${body.taskId}" not found`, code: "NOT_FOUND" }, 400);
    }

    const watcher = watcherMgr.create({
      taskId: body.taskId,
      targetStatus: body.targetStatus as any,
      action: body.action as any,
    });

    return c.json({ ok: true, data: watcher }, 201);
  });

  // DELETE /watchers/:watcherId — delete a watcher
  app.openapi(deleteWatcherRoute, (c) => {
    const deps = getDeps();
    const watcherMgr = deps.getWatcherManager();
    if (!watcherMgr) {
      return c.json({ ok: false, error: "Watcher manager not available", code: "NOT_FOUND" }, 404);
    }

    const { watcherId } = c.req.valid("param");
    const removed = watcherMgr.remove(watcherId);
    if (!removed) {
      return c.json({ ok: false, error: `Watcher "${watcherId}" not found`, code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  return app;
}
