import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";

/* ── Route definitions ─────────────────────────────────────────────── */

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Chat Sessions"],
  summary: "List chat sessions",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "List of sessions",
    },
  },
});

const getSessionMessagesRoute = createRoute({
  method: "get",
  path: "/sessions/{id}/messages",
  tags: ["Chat Sessions"],
  summary: "Get messages for a session",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session messages",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session not found",
    },
    503: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session store not available",
    },
  },
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/sessions/{id}",
  tags: ["Chat Sessions"],
  summary: "Delete a session",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session not found",
    },
    503: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Session store not available",
    },
  },
});

/* ── Handlers ──────────────────────────────────────────────────────── */

/**
 * Chat session management routes.
 * Conversational AI is handled by /v1/chat/completions (see completions.ts).
 */
export function chatRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /chat/sessions — list chat sessions
  app.openapi(listSessionsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const sessionStore = orchestrator.getSessionStore();
    if (!sessionStore) {
      return c.json({ ok: true, data: { sessions: [] } });
    }
    const sessions = sessionStore.listSessions();
    return c.json({ ok: true, data: { sessions } });
  });

  // GET /chat/sessions/:id/messages — get messages for a session
  app.openapi(getSessionMessagesRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const sessionStore = orchestrator.getSessionStore();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const session = sessionStore.getSession(id);
    if (!session) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    const messages = sessionStore.getMessages(id);
    // SECURITY: Redact vault credentials from persisted tool calls before serving to client
    const safeMessages = messages.map(m => {
      if (!m.toolCalls) return m;
      const hasVault = m.toolCalls.some(tc => tc.name === "set_vault_entry");
      if (!hasVault) return m;
      return {
        ...m,
        toolCalls: m.toolCalls.map(tc => {
          if (tc.name !== "set_vault_entry" || !tc.arguments) return tc;
          const args = { ...tc.arguments };
          if (args.credentials && typeof args.credentials === "object") {
            const redacted: Record<string, string> = {};
            for (const key of Object.keys(args.credentials as Record<string, string>)) {
              redacted[key] = "[REDACTED]";
            }
            args.credentials = redacted;
          }
          return { ...tc, arguments: args };
        }),
      };
    });
    return c.json({ ok: true, data: { session, messages: safeMessages } }, 200);
  });

  // DELETE /chat/sessions/:id — delete a session
  app.openapi(deleteSessionRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const sessionStore = orchestrator.getSessionStore();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const deleted = sessionStore.deleteSession(id);
    if (!deleted) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  return app;
}
