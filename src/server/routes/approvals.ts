import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import { ApproveRequestSchema, RejectRequestSchema, parseBody } from "../schemas.js";

/**
 * Approval routes.
 *
 * GET  /approvals           — list approvals (optional ?status=pending|approved|rejected|timeout)
 * GET  /approvals/:id       — get single approval request
 * POST /approvals/:id/approve — approve a pending request
 * POST /approvals/:id/reject  — reject with feedback (task retries with notes)
 */
export function approvalRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /approvals — list all approval requests
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    const status = c.req.query("status") as "pending" | "approved" | "rejected" | "timeout" | undefined;
    const taskId = c.req.query("taskId");

    let data;
    if (taskId) {
      // Filter by task — getAllApprovals doesn't support taskId filter,
      // so we get all and filter manually
      const all = orchestrator.getAllApprovals(status);
      data = all.filter(r => r.taskId === taskId);
    } else {
      data = orchestrator.getAllApprovals(status);
    }

    return c.json({ ok: true, data });
  });

  // GET /approvals/:id — get single approval request
  app.get("/:id", (c) => {
    const orchestrator = c.get("orchestrator");
    const request = orchestrator.getApprovalRequest(c.req.param("id"));
    if (!request) {
      return c.json({ ok: false, error: "Approval request not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: request });
  });

  // POST /approvals/:id/approve — approve a pending request
  app.post("/:id/approve", async (c) => {
    const orchestrator = c.get("orchestrator");
    const id = c.req.param("id");

    // Body is optional — approve can work with no payload
    let resolvedBy: string | undefined;
    let note: string | undefined;
    try {
      const body = parseBody(ApproveRequestSchema, await c.req.json());
      resolvedBy = body.resolvedBy;
      note = body.note;
    } catch {
      // Empty body or parse error — that's fine, use defaults
    }

    const result = orchestrator.approveRequest(id, resolvedBy, note);
    if (!result) {
      // Could be not found or already resolved
      const existing = orchestrator.getApprovalRequest(id);
      if (!existing) {
        return c.json({ ok: false, error: "Approval request not found", code: "NOT_FOUND" }, 404);
      }
      return c.json({
        ok: false,
        error: `Request already resolved with status: ${existing.status}`,
        code: "CONFLICT",
      }, 409);
    }

    return c.json({ ok: true, data: result });
  });

  // POST /approvals/:id/reject — reject with feedback, task retries with notes
  app.post("/:id/reject", async (c) => {
    const orchestrator = c.get("orchestrator");
    const id = c.req.param("id");

    const body = parseBody(RejectRequestSchema, await c.req.json());
    if (!body.feedback) {
      return c.json({ ok: false, error: "feedback is required for rejection", code: "BAD_REQUEST" }, 400);
    }

    // Check if rejection is allowed (max rejections)
    const check = orchestrator.canRejectRequest(id);
    if (!check.allowed) {
      const existing = orchestrator.getApprovalRequest(id);
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

    const result = orchestrator.rejectRequest(id, body.feedback, body.resolvedBy);
    if (!result) {
      return c.json({ ok: false, error: "Failed to reject request", code: "CONFLICT" }, 409);
    }

    return c.json({ ok: true, data: result });
  });

  return app;
}
