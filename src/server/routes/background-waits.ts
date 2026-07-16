import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { Orchestrator } from "../../core/orchestrator.js";
import { activeTaskWaitRegistry } from "../../llm/active-task-waits.js";

const CreateWaitSchema = z.object({
  taskId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  targetStatus: z.string().trim().min(1).optional(),
});

const DetachWaitSchema = z.object({
  toolCallId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
});

export function backgroundWaitRoutes(orchestrator: Orchestrator): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", async (c) => {
    const waits = await orchestrator.listBackgroundWaits(c.req.query("sessionId"));
    return c.json({ ok: true, data: waits });
  });

  app.post("/", async (c) => {
    const parsed = CreateWaitSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, error: "Invalid background wait" }, 400);
    try {
      const wait = await orchestrator.createBackgroundWait(parsed.data);
      return c.json({ ok: true, data: wait }, 201);
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/from-active", async (c) => {
    const parsed = DetachWaitSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ ok: false, error: "Invalid active wait" }, 400);
    const active = activeTaskWaitRegistry.get(parsed.data.toolCallId, parsed.data.sessionId);
    if (!active) return c.json({ ok: false, error: "This wait is no longer active" }, 409);

    try {
      const wait = await orchestrator.createBackgroundWait({
        taskId: active.taskId,
        sessionId: active.sessionId,
        targetStatus: active.targetStatus,
      });
      active.detach(wait.id);
      return c.json({ ok: true, data: wait }, 201);
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.delete("/:id", async (c) => {
    const cancelled = await orchestrator.cancelBackgroundWait(c.req.param("id"));
    return cancelled
      ? c.json({ ok: true })
      : c.json({ ok: false, error: "Background wait not found or already finished" }, 409);
  });

  return app;
}
