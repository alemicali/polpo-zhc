import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import type { CreatePlanRequest, UpdatePlanRequest } from "../types.js";

/**
 * Plan CRUD + execute/resume/abort routes.
 */
export function planRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /plans — list all plans
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getAllPlans() });
  });

  // GET /plans/resumable — list resumable plans
  app.get("/resumable", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getResumablePlans() });
  });

  // GET /plans/:planId — get plan by ID
  app.get("/:planId", (c) => {
    const orchestrator = c.get("orchestrator");
    const plan = orchestrator.getPlan(c.req.param("planId"));
    if (!plan) {
      return c.json({ ok: false, error: "Plan not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: plan });
  });

  // POST /plans — save plan
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<CreatePlanRequest>();

    if (!body.yaml) {
      return c.json(
        { ok: false, error: "yaml is required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const plan = orchestrator.savePlan({
      yaml: body.yaml,
      prompt: body.prompt,
      name: body.name,
      status: body.status,
    });

    return c.json({ ok: true, data: plan }, 201);
  });

  // PATCH /plans/:planId — update plan
  app.patch("/:planId", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<UpdatePlanRequest>();
    const plan = orchestrator.updatePlan(c.req.param("planId"), body);
    return c.json({ ok: true, data: plan });
  });

  // DELETE /plans/:planId — delete plan
  app.delete("/:planId", (c) => {
    const orchestrator = c.get("orchestrator");
    const deleted = orchestrator.deletePlan(c.req.param("planId"));
    if (!deleted) {
      return c.json({ ok: false, error: "Plan not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } });
  });

  // POST /plans/:planId/execute — execute plan
  app.post("/:planId/execute", (c) => {
    const orchestrator = c.get("orchestrator");
    const result = orchestrator.executePlan(c.req.param("planId"));
    return c.json({ ok: true, data: result });
  });

  // POST /plans/:planId/resume — resume plan
  app.post("/:planId/resume", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ retryFailed?: boolean }>().catch(() => ({}));
    const result = orchestrator.resumePlan(c.req.param("planId"), body);
    return c.json({ ok: true, data: result });
  });

  // POST /plans/:planId/abort — abort plan group
  app.post("/:planId/abort", (c) => {
    const orchestrator = c.get("orchestrator");
    const plan = orchestrator.getPlan(c.req.param("planId"));
    if (!plan) {
      return c.json({ ok: false, error: "Plan not found", code: "NOT_FOUND" }, 404);
    }
    const count = orchestrator.abortGroup(plan.name);
    return c.json({ ok: true, data: { aborted: count } });
  });

  return app;
}
