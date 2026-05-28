import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { buildETag, handleConditional, quickFingerprint } from "../etag.js";

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
    304: {
      description: "Not modified — client has the current list per ETag",
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
    query: z.object({
      after: z.string().optional().openapi({
        description: "If provided, return only messages strictly newer than this message id (incremental sync). If the id is not found, the full message list is returned. The response includes an `incremental` flag the client can use to decide whether to append or replace its local cache.",
      }),
    }),
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
  summary: "Update session (rename and/or star)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              title: z.string().min(1).optional(),
              starred: z.boolean().optional(),
            })
            .refine((v) => v.title !== undefined || v.starred !== undefined, {
              message: "Provide at least one of: title, starred",
            }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Session updated",
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
    // Conditional GET — sidebar is the hottest list in the app (refreshed
    // on every chat tab/route change). 304 short-circuit is huge here.
    const etag = buildETag(quickFingerprint(sessions));
    if (handleConditional(c, etag)) return c.body(null, 304);
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
    const allMessages = await sessionStore.getMessages(id);
    // Incremental sync: ?after=<msgId> returns only messages strictly newer
    // than that id. Big win for clients with a warm cache — they only pay
    // for the delta instead of the whole transcript (long chats persist
    // hundreds of messages with deeply-nested toolCalls payloads).
    //
    // If the client-supplied id is not found we fall back to the full list
    // and signal `incremental: false` so the client knows to REPLACE rather
    // than APPEND. That covers two cases: (1) the client cached a locally-
    // generated UUID that never existed on the server, (2) the server
    // pruned/lost the message after the client cached it.
    const afterId = c.req.valid("query").after;
    let messages = allMessages;
    let incremental = false;
    if (afterId) {
      const idx = allMessages.findIndex((m: any) => m.id === afterId);
      if (idx >= 0) {
        messages = allMessages.slice(idx + 1);
        incremental = true;
      }
    }
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
    return c.json({ ok: true, data: { session, messages: safeMessages, incremental } }, 200);
  });

  // PATCH /chat/sessions/:id — rename and/or (un)star a session.
  // Either field is optional but at least one must be present (enforced by zod
  // .refine). Renaming bumps updatedAt; starring deliberately does NOT, so
  // the sidebar's "recent" ordering survives pinning.
  app.openapi(renameSessionRoute, async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const result: { renamed?: boolean; starred?: boolean } = {};
    let touched = false;

    if (body.title !== undefined) {
      const renamed = await sessionStore.renameSession(id, body.title);
      if (!renamed) {
        return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
      }
      result.renamed = true;
      touched = true;
    }
    if (body.starred !== undefined) {
      const starred = await sessionStore.setStarred(id, body.starred);
      if (!starred) {
        return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
      }
      result.starred = body.starred;
      touched = true;
    }

    // Defensive: the refine above should make this unreachable, but keep a
    // safety net so we never return a 200 for a no-op request.
    if (!touched) {
      return c.json({ ok: false, error: "Nothing to update", code: "VALIDATION_ERROR" }, 404);
    }
    return c.json({ ok: true, data: result }, 200);
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

  // POST /sessions/import — bulk import a session with messages
  app.post("/sessions/import", async (c) => {
    const { sessionStore } = getDeps();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Sessions not available", code: "NOT_AVAILABLE" }, 501);
    }

    const body = await c.req.json<{
      title?: string;
      agent?: string;
      messages: Array<{
        role: "user" | "assistant";
        content: string;
        toolCalls?: unknown[];
        segments?: unknown[];
      }>;
    }>();

    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json({ ok: false, error: "messages array required" }, 400);
    }

    const sessionId = await sessionStore.create(body.title, body.agent);
    let imported = 0;

    for (const msg of body.messages) {
      const added = await sessionStore.addMessage(sessionId, msg.role, msg.content);
      if ((msg.toolCalls && msg.toolCalls.length > 0) || (msg.segments && msg.segments.length > 0)) {
        await sessionStore.updateMessage(sessionId, added.id, msg.content, msg.toolCalls as any, msg.segments as any);
      }
      imported++;
    }

    return c.json({ ok: true, data: { sessionId, imported } }, 201);
  });

  return app;
}
