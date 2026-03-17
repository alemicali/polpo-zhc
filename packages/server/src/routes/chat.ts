import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

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
  summary: "Get session messages",
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

const renameSessionRoute = createRoute({
  method: "patch",
  path: "/sessions/{id}",
  tags: ["Chat Sessions"],
  summary: "Rename session",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: z.object({ title: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session renamed",
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
  summary: "Delete session",
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
export function chatRoutes(getDeps: () => { sessionStore?: any }): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /chat/sessions — list chat sessions
  app.openapi(listSessionsRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: true, data: { sessions: [] } });
    }
    const sessions = await sessionStore.listSessions();
    return c.json({ ok: true, data: { sessions } });
  });

  // GET /chat/sessions/:id/messages — get messages for a session
  app.openapi(getSessionMessagesRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const session = await sessionStore.getSession(id);
    if (!session) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    const messages = await sessionStore.getMessages(id);
    // SECURITY: Redact vault credentials from persisted tool calls before serving to client
    const safeMessages = messages.map((m: any) => {
      const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : undefined;
      if (!toolCalls || toolCalls.length === 0) return m;
      const hasVault = toolCalls.some((tc: any) => tc.name === "set_vault_entry" || tc.name === "update_vault_credentials");
      if (!hasVault) return m;
      return {
        ...m,
        toolCalls: toolCalls.map((tc: any) => {
          if ((tc.name !== "set_vault_entry" && tc.name !== "update_vault_credentials") || !tc.arguments) return tc;
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

  // PATCH /chat/sessions/:id — rename a session
  app.openapi(renameSessionRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const { title } = c.req.valid("json");
    const renamed = await sessionStore.renameSession(id, title);
    if (!renamed) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { renamed: true } }, 200);
  });

  // DELETE /chat/sessions/:id — delete a session
  app.openapi(deleteSessionRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const deleted = await sessionStore.deleteSession(id);
    if (!deleted) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } }, 200);
  });

  return app;
}
