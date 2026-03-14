import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ApproveRequestSchema, RejectRequestSchema } from "../schemas.js";

/* ── Route definitions ─────────────────────────────────────────────── */

const listApprovalsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Approvals"],
  summary: "List approval requests",
  request: {
    query: z.object({
      status: z.string().optional(),
      taskId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Approval list",
    },
  },
});

const getApprovalRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Approvals"],
  summary: "Get approval",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Approval details",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Approval not found",
    },
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/{id}/approve",
  tags: ["Approvals"],
  summary: "Approve request",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: ApproveRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Approval result",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Approval not found",
    },
    409: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Already resolved",
    },
  },
});

const rejectRoute = createRoute({
  method: "post",
  path: "/{id}/reject",
  tags: ["Approvals"],
  summary: "Reject with feedback",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: RejectRequestSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Rejection result",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Bad request",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Approval not found",
    },
    409: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Already resolved or max rejections reached",
    },
  },
});

/* ── Handlers ──────────────────────────────────────────────────────── */

/**
 * Approval routes.
 *
 * GET  /approvals           — list approvals (optional ?status=pending|approved|rejected|timeout)
 * GET  /approvals/:id       — get single approval request
 * POST /approvals/:id/approve — approve a pending request
 * POST /approvals/:id/reject  — reject with feedback (task retries with notes)
 */
export function approvalRoutes(getDeps: () => {
  getAllApprovals: (status?: string) => Promise<any[]>;
  getApprovalRequest: (id: string) => Promise<any>;
  approveRequest: (id: string, resolvedBy?: string, note?: string) => Promise<any>;
  rejectRequest: (id: string, feedback: string, resolvedBy?: string) => Promise<any>;
  canRejectRequest: (id: string) => Promise<any>;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /approvals — list all approval requests
  app.openapi(listApprovalsRoute, async (c) => {
    const deps = getDeps();
    const query = c.req.valid("query");
    const status = query.status as "pending" | "approved" | "rejected" | "timeout" | undefined;
    const taskId = query.taskId;

    let data;
    if (taskId) {
      // Filter by task — getAllApprovals doesn't support taskId filter,
      // so we get all and filter manually
      const all = await deps.getAllApprovals(status);
      data = all.filter(r => r.taskId === taskId);
    } else {
      data = await deps.getAllApprovals(status);
    }

    return c.json({ ok: true, data });
  });

  // GET /approvals/:id — get single approval request
  app.openapi(getApprovalRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");
    const request = await deps.getApprovalRequest(id);
    if (!request) {
      return c.json({ ok: false, error: "Approval request not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: request }, 200);
  });

  // POST /approvals/:id/approve — approve a pending request
  app.openapi(approveRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");

    // Body is optional — approve can work with no payload
    let resolvedBy: string | undefined;
    let note: string | undefined;
    try {
      const body = c.req.valid("json");
      resolvedBy = body.resolvedBy;
      note = body.note;
    } catch {
      // Empty body or parse error — that's fine, use defaults
    }

    const result = await deps.approveRequest(id, resolvedBy, note);
    if (!result) {
      // Could be not found or already resolved
      const existing = await deps.getApprovalRequest(id);
      if (!existing) {
        return c.json({ ok: false, error: "Approval request not found", code: "NOT_FOUND" }, 404);
      }
      return c.json({
        ok: false,
        error: `Request already resolved with status: ${existing.status}`,
        code: "CONFLICT",
      }, 409);
    }

    return c.json({ ok: true, data: result }, 200);
  });

  // POST /approvals/:id/reject — reject with feedback, task retries with notes
  app.openapi(rejectRoute, async (c) => {
    const deps = getDeps();
    const { id } = c.req.valid("param");

    const body = c.req.valid("json");
    if (!body.feedback) {
      return c.json({ ok: false, error: "feedback is required for rejection", code: "BAD_REQUEST" }, 400);
    }

    // Check if rejection is allowed (max rejections)
    const check = await deps.canRejectRequest(id);
    if (!check.allowed) {
      const existing = await deps.getApprovalRequest(id);
      if (!existing) {
        return c.json({ ok: false, error: "Approval request not found", code: "NOT_FOUND" }, 404);
      }
      if (existing.status !== "pending") {
        return c.json({
          ok: false,
          error: `Request already resolved with status: ${existing.status}`,
          code: "CONFLICT",
        }, 409);
      }
      return c.json({
        ok: false,
        error: `Max rejections reached (${check.rejectionCount}/${check.maxRejections}). Only approve is available.`,
        code: "CONFLICT",
      }, 409);
    }

    const result = await deps.rejectRequest(id, body.feedback, body.resolvedBy);
    if (!result) {
      return c.json({ ok: false, error: "Failed to reject request", code: "CONFLICT" }, 409);
    }

    return c.json({ ok: true, data: result }, 200);
  });

  return app;
}
