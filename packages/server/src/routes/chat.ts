import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { buildETag, handleConditional, quickFingerprint } from "../etag.js";
import { nanoid } from "nanoid";
import type { AttachmentStore, ChatQueueStore } from "@polpo-ai/core";
import { streamRegistry } from "../stream-registry.js";
import type { TurnScheduler } from "../turn-scheduler.js";

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
export interface ChatRouteDeps {
  sessionStore?: any;
  attachmentStore?: AttachmentStore;
  emit?: (event: string, data: unknown) => void;
  /** Server-side prompt queue (queue routes answer 501 without it). */
  chatQueueStore?: ChatQueueStore;
  /** Starts server-side turns (queue auto-send, "send now", a branch's answer). */
  turnScheduler?: TurnScheduler;
  /** Delete an attachment file (project-relative path) once no message references it. */
  removeAttachmentFile?: (path: string) => Promise<void>;
}

/** Longest queued prompt accepted (characters). */
const MAX_QUEUE_ITEM_CHARS = 100_000;

export function chatRoutes(getDeps: () => ChatRouteDeps): OpenAPIHono {
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
    // Incremental sync: ?after=<msgId> returns only messages strictly newer than that id
    // (read from the store when it can, instead of loading the whole transcript).
    const afterId = c.req.valid("query").after;
    const delta = afterId && sessionStore.getMessagesAfter ? await sessionStore.getMessagesAfter(id, afterId) : undefined;
    const [rawMessages, attachments] = await Promise.all([
      delta ?? sessionStore.getMessages(id), getDeps().attachmentStore?.getBySession(id) ?? [],
    ]);
    const byMessage = new Map<string, typeof attachments>();
    for (const attachment of attachments) {
      if (!attachment.messageId) continue;
      const list = byMessage.get(attachment.messageId) ?? [];
      list.push(attachment);
      byMessage.set(attachment.messageId, list);
    }
    const allMessages = rawMessages.map((message: any) => ({ ...message,
      ...(byMessage.has(message.id) ? { attachments: byMessage.get(message.id) } : {}),
    }));
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
    let messages = allMessages;
    let incremental = delta !== undefined;
    if (afterId && delta === undefined) {
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
    // Branches started from this conversation, so the UI can mark their fork points.
    const forks = (typeof sessionStore.listSessions === "function" ? await sessionStore.listSessions() as any[] : [])
      .filter((s) => s.parentSessionId === id)
      .map((s) => ({ id: s.id, title: s.title, forkMessageId: s.forkMessageId, createdAt: s.createdAt }));
    return c.json({ ok: true, data: { session, messages: safeMessages, incremental, forks } }, 200);
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
    getDeps().emit?.("session:updated", { sessionId: id, ...(body.title !== undefined ? { title: body.title } : {}), ...(body.starred !== undefined ? { starred: body.starred } : {}) });
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
    await getDeps().chatQueueStore?.deleteSession(id).catch(() => undefined);
    getDeps().turnScheduler?.forget(id);
    getDeps().emit?.("session:deleted", { sessionId: id });
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
    getDeps().emit?.("session:created", { sessionId, title: body.title });
    let imported = 0;

    for (const msg of body.messages) {
      const added = await sessionStore.addMessage(sessionId, msg.role, msg.content);
      getDeps().emit?.("message:added", { sessionId, messageId: added.id, role: msg.role });
      if ((msg.toolCalls && msg.toolCalls.length > 0) || (msg.segments && msg.segments.length > 0)) {
        await sessionStore.updateMessage(sessionId, added.id, msg.content, msg.toolCalls as any, msg.segments as any);
      }
      imported++;
    }

    return c.json({ ok: true, data: { sessionId, imported } }, 201);
  });

  // ── Prompt queue ─────────────────────────────────────────────────────
  //
  // GET    /sessions/:id/queue                  — { items, autoSend }
  // POST   /sessions/:id/queue                  — { content, front? } add a prompt
  // PATCH  /sessions/:id/queue                  — { autoSend }
  // DELETE /sessions/:id/queue                  — clear
  // PUT    /sessions/:id/queue/order            — { ids } new order
  // PATCH  /sessions/:id/queue/:itemId          — { content }
  // DELETE /sessions/:id/queue/:itemId
  // POST   /sessions/:id/queue/:itemId/send     — send now (steers the running turn, if any)
  //
  // With auto-send on, the server sends the head when a turn completes normally, whether or not
  // a browser is open. Every change is announced with `chat:queue-updated`.

  const queueDeps = async (c: any): Promise<{ error: Response; id?: undefined; queue?: undefined } | { error?: undefined; id: string; queue: ChatQueueStore }> => {
    const { sessionStore, chatQueueStore } = getDeps();
    if (!sessionStore || !chatQueueStore) {
      return { error: c.json({ ok: false, error: "Chat queue not available", code: "NOT_AVAILABLE" }, 501) };
    }
    const id = c.req.param("id");
    if (!(await sessionStore.getSession(id))) {
      return { error: c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404) };
    }
    return { id, queue: chatQueueStore };
  };
  const queueChanged = (sessionId: string) => {
    getDeps().emit?.("chat:queue-updated", { sessionId });
  };
  const queueText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 && value.length <= MAX_QUEUE_ITEM_CHARS ? value.trim() : undefined;

  app.get("/sessions/:id/queue", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    return c.json({ ok: true, data: await r.queue.get(r.id) });
  });

  app.post("/sessions/:id/queue", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const body = await c.req.json().catch(() => null) as { content?: unknown; front?: unknown } | null;
    const content = queueText(body?.content);
    if (!content) return c.json({ ok: false, error: "content (non-empty text) is required", code: "VALIDATION_ERROR" }, 400);
    const item = await r.queue.add(r.id, content, { front: body?.front === true });
    queueChanged(r.id);
    getDeps().turnScheduler?.queueChanged(r.id);
    return c.json({ ok: true, data: item }, 201);
  });

  app.patch("/sessions/:id/queue", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const body = await c.req.json().catch(() => null) as { autoSend?: unknown } | null;
    if (typeof body?.autoSend !== "boolean") return c.json({ ok: false, error: "autoSend (boolean) is required", code: "VALIDATION_ERROR" }, 400);
    await r.queue.setAutoSend(r.id, body.autoSend);
    queueChanged(r.id);
    if (body.autoSend) getDeps().turnScheduler?.queueChanged(r.id);
    return c.json({ ok: true, data: await r.queue.get(r.id) });
  });

  app.delete("/sessions/:id/queue", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const cleared = await r.queue.clear(r.id);
    queueChanged(r.id);
    return c.json({ ok: true, data: { cleared } });
  });

  app.put("/sessions/:id/queue/order", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
    if (!Array.isArray(body?.ids) || !body.ids.every((x) => typeof x === "string")) {
      return c.json({ ok: false, error: "ids (string array) is required", code: "VALIDATION_ERROR" }, 400);
    }
    const items = await r.queue.reorder(r.id, body.ids as string[]);
    queueChanged(r.id);
    return c.json({ ok: true, data: { items } });
  });

  app.patch("/sessions/:id/queue/:itemId", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const body = await c.req.json().catch(() => null) as { content?: unknown } | null;
    const content = queueText(body?.content);
    if (!content) return c.json({ ok: false, error: "content (non-empty text) is required", code: "VALIDATION_ERROR" }, 400);
    const item = await r.queue.update(r.id, c.req.param("itemId"), content);
    if (!item) return c.json({ ok: false, error: "Queued prompt not found", code: "NOT_FOUND" }, 404);
    queueChanged(r.id);
    return c.json({ ok: true, data: item });
  });

  app.delete("/sessions/:id/queue/:itemId", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const item = await r.queue.remove(r.id, c.req.param("itemId"));
    if (!item) return c.json({ ok: false, error: "Queued prompt not found", code: "NOT_FOUND" }, 404);
    queueChanged(r.id);
    return c.json({ ok: true, data: { removed: true } });
  });

  app.post("/sessions/:id/queue/:itemId/send", async (c) => {
    const r = await queueDeps(c);
    if (r.error) return r.error;
    const scheduler = getDeps().turnScheduler;
    if (!scheduler) return c.json({ ok: false, error: "Sending from the queue is not available", code: "NOT_AVAILABLE" }, 501);
    try {
      const result = await scheduler.sendNow(r.id, c.req.param("itemId"));
      if (!result) return c.json({ ok: false, error: "Queued prompt not found", code: "NOT_FOUND" }, 404);
      return c.json({ ok: true, data: result });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "Could not send", code: "SEND_FAILED" }, 502);
    }
  });

  // ── Branches ─────────────────────────────────────────────────────────
  //
  // POST   /sessions/:id/fork   — { messageId } new session with the conversation up to that user
  //                               message; the assistant answers it again there (server-side turn)
  // DELETE /sessions/:id/fork   — undo a branch: delete it and go back to the parent. Answers 409
  //                               FORK_HAS_MESSAGES when the user already wrote in it (?force=1 to
  //                               delete anyway).

  app.post("/sessions/:id/fork", async (c) => {
    const { sessionStore, attachmentStore, turnScheduler, emit } = getDeps();
    if (!sessionStore?.forkSession) {
      return c.json({ ok: false, error: "Branching is not available", code: "NOT_AVAILABLE" }, 501);
    }
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null) as { messageId?: unknown } | null;
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (!messageId) return c.json({ ok: false, error: "messageId is required", code: "VALIDATION_ERROR" }, 400);
    const parent = await sessionStore.getSession(id);
    if (!parent) return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    const messages: any[] = await sessionStore.getMessages(id);
    const target = messages.find((m) => m.id === messageId);
    if (!target) return c.json({ ok: false, error: "Message not found", code: "NOT_FOUND" }, 404);
    if (target.role !== "user") {
      return c.json({ ok: false, error: "Branch from one of your messages", code: "NOT_A_USER_MESSAGE" }, 400);
    }

    const fork = await sessionStore.forkSession(id, messageId);
    if (!fork) return c.json({ ok: false, error: "Message not found", code: "NOT_FOUND" }, 404);
    const forkId: string = fork.session.id;

    // Attachments: new rows pointing at the same files (deleting one keeps shared files).
    if (attachmentStore) {
      try {
        const rows = await attachmentStore.getBySession(id);
        for (const row of rows) {
          const copyOf = row.messageId ? fork.messageIds[row.messageId] : undefined;
          if (!copyOf) continue;
          await attachmentStore.save({ ...row, id: nanoid(20), sessionId: forkId, messageId: copyOf });
        }
      } catch (error) {
        // All or nothing: a branch without its files would answer a different question.
        await attachmentStore.deleteBySession(forkId).catch(() => undefined);
        await sessionStore.deleteSession(forkId).catch(() => undefined);
        return c.json({ ok: false, error: error instanceof Error ? error.message : "Could not copy attachments", code: "FORK_FAILED" }, 500);
      }
    }
    emit?.("session:created", { sessionId: forkId, title: fork.session.title });

    // The assistant answers the copied user message again, in the branch.
    let turnId: string | null = null;
    let turnError: string | undefined;
    if (turnScheduler) {
      try {
        turnId = (await turnScheduler.startTurn(forkId, { reason: "fork" }))?.turnId ?? null;
      } catch (error) {
        turnError = error instanceof Error ? error.message : "Could not start the answer";
      }
    }
    return c.json({ ok: true, data: { session: fork.session, turnId, ...(turnError ? { turnError } : {}) } }, 201);
  });

  app.delete("/sessions/:id/fork", async (c) => {
    const { sessionStore, attachmentStore, chatQueueStore, turnScheduler, emit, removeAttachmentFile } = getDeps();
    if (!sessionStore) return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    const id = c.req.param("id");
    const session = await sessionStore.getSession(id);
    if (!session) return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    if (!session.parentSessionId) return c.json({ ok: false, error: "Not a branch", code: "NOT_A_FORK" }, 400);
    const parentId: string = session.parentSessionId;
    const parent = await sessionStore.getSession(parentId);
    if (!parent) return c.json({ ok: false, error: "The original conversation no longer exists", code: "PARENT_MISSING" }, 409);

    // What was written in the branch after the fork point (copies keep the parent's timestamps).
    const parentMessages: any[] = await sessionStore.getMessages(parentId);
    const cut = parentMessages.findIndex((m) => m.id === session.forkMessageId);
    const forkMessages: any[] = await sessionStore.getMessages(id);
    const added = cut >= 0 ? forkMessages.slice(cut + 1) : forkMessages;
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    if (!force && added.some((m) => m.role === "user")) {
      return c.json({ ok: false, error: "The branch has new messages", code: "FORK_HAS_MESSAGES" }, 409);
    }

    const live = streamRegistry.getActiveTurnForSession(id);
    if (live) {
      streamRegistry.closeSteering(live);
      streamRegistry.abort(live);
    }
    if (attachmentStore) {
      const rows = await attachmentStore.getBySession(id).catch(() => []);
      for (const row of rows) {
        await attachmentStore.delete(row.id).catch(() => undefined);
        // Only files no other message points at (the parent's stay).
        const shared = attachmentStore.getByPath ? await attachmentStore.getByPath(row.path).catch(() => [row]) : [row];
        if (shared.length === 0) await removeAttachmentFile?.(row.path).catch(() => undefined);
      }
    }
    await sessionStore.deleteSession(id);
    await chatQueueStore?.deleteSession(id).catch(() => undefined);
    turnScheduler?.forget(id);
    emit?.("session:deleted", { sessionId: id });
    return c.json({ ok: true, data: { deleted: true, parentSessionId: parentId, forkMessageId: session.forkMessageId ?? null } });
  });

  return app;
}
