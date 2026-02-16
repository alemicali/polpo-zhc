import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { CreatePlanSchema, UpdatePlanSchema } from "../schemas.js";

// ── Route definitions ─────────────────────────────────────────────────

const listPlansRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Plans"],
  summary: "List all plans",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of plans",
    },
  },
});

const listResumablePlansRoute = createRoute({
  method: "get",
  path: "/resumable",
  tags: ["Plans"],
  summary: "List resumable plans",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of resumable plans",
    },
  },
});

const getPlanRoute = createRoute({
  method: "get",
  path: "/{planId}",
  tags: ["Plans"],
  summary: "Get a plan by ID",
  request: {
    params: z.object({ planId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Plan details",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Plan not found",
    },
  },
});

const createPlanRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Plans"],
  summary: "Save a new plan",
  request: {
    body: { content: { "application/json": { schema: CreatePlanSchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Plan created",
    },
  },
});

const updatePlanRoute = createRoute({
  method: "patch",
  path: "/{planId}",
  tags: ["Plans"],
  summary: "Update a plan",
  request: {
    params: z.object({ planId: z.string() }),
    body: { content: { "application/json": { schema: UpdatePlanSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Plan updated",
    },
  },
});

const deletePlanRoute = createRoute({
  method: "delete",
  path: "/{planId}",
  tags: ["Plans"],
  summary: "Delete a plan",
  request: {
    params: z.object({ planId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ deleted: z.boolean() }) }) } },
      description: "Plan deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Plan not found",
    },
  },
});

const executePlanRoute = createRoute({
  method: "post",
  path: "/{planId}/execute",
  tags: ["Plans"],
  summary: "Execute a plan",
  request: {
    params: z.object({ planId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Plan execution result",
    },
  },
});

const resumePlanRoute = createRoute({
  method: "post",
  path: "/{planId}/resume",
  tags: ["Plans"],
  summary: "Resume a plan",
  request: {
    params: z.object({ planId: z.string() }),
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
      description: "Plan resumed",
    },
  },
});

const listCheckpointsRoute = createRoute({
  method: "get",
  path: "/checkpoints",
  tags: ["Plans"],
  summary: "List all active checkpoints",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "List of active checkpoints",
    },
  },
});

const resumeCheckpointRoute = createRoute({
  method: "post",
  path: "/{planId}/checkpoints/{checkpointName}/resume",
  tags: ["Plans"],
  summary: "Resume a checkpoint",
  request: {
    params: z.object({ planId: z.string(), checkpointName: z.string() }),
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

const abortPlanRoute = createRoute({
  method: "post",
  path: "/{planId}/abort",
  tags: ["Plans"],
  summary: "Abort a plan",
  request: {
    params: z.object({ planId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ aborted: z.number() }) }) } },
      description: "Plan aborted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Plan not found",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * Plan CRUD + execute/resume/abort routes.
 */
export function planRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /plans — list all plans
  app.openapi(listPlansRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getAllPlans() });
  });

  // GET /plans/resumable — list resumable plans
  app.openapi(listResumablePlansRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getResumablePlans() });
  });

  // GET /plans/:planId — get plan by ID
  app.openapi(getPlanRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId } = c.req.valid("param");
    const plan = orchestrator.getPlan(planId);
    if (!plan) {
      return c.json({ ok: false, error: "Plan not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: plan }, 200);
  });

  // POST /plans — save plan
  app.openapi(createPlanRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const plan = orchestrator.savePlan({
      data: body.data,
      prompt: body.prompt,
      name: body.name,
      status: body.status,
      notifications: body.notifications,
    });

    return c.json({ ok: true, data: plan }, 201);
  });

  // PATCH /plans/:planId — update plan
  app.openapi(updatePlanRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const plan = orchestrator.updatePlan(planId, body);
    return c.json({ ok: true, data: plan });
  });

  // DELETE /plans/:planId — delete plan
  app.openapi(deletePlanRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId } = c.req.valid("param");
    const deleted = orchestrator.deletePlan(planId);
    if (!deleted) {
      return c.json({ ok: false, error: "Plan not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  // POST /plans/:planId/execute — execute plan
  app.openapi(executePlanRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId } = c.req.valid("param");
    const result = orchestrator.executePlan(planId);
    return c.json({ ok: true, data: result });
  });

  // POST /plans/:planId/resume — resume plan
  app.openapi(resumePlanRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = orchestrator.resumePlan(planId, body);
    return c.json({ ok: true, data: result });
  });

  // GET /plans/checkpoints — list all active checkpoints
  app.openapi(listCheckpointsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getActiveCheckpoints() });
  });

  // POST /plans/:planId/checkpoints/:checkpointName/resume — resume a checkpoint
  app.openapi(resumeCheckpointRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId, checkpointName } = c.req.valid("param");
    const resumed = orchestrator.resumeCheckpointByPlanId(planId, checkpointName);
    if (!resumed) {
      return c.json({ ok: false, error: "Checkpoint not found or not active", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { resumed: true } }, 200);
  });

  // POST /plans/:planId/abort — abort plan group
  app.openapi(abortPlanRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const { planId } = c.req.valid("param");
    const plan = orchestrator.getPlan(planId);
    if (!plan) {
      return c.json({ ok: false, error: "Plan not found", code: "NOT_FOUND" }, 404);
    }
    const count = orchestrator.abortGroup(plan.name);
    return c.json({ ok: true, data: { aborted: count } }, 200);
  });

  return app;
}
