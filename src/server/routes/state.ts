import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { UpdateMemorySchema } from "../schemas.js";
import { redactPolpoState, redactPolpoConfig, sanitizeTranscriptEntry } from "../security.js";

// ── Route definitions ─────────────────────────────────────────────────

const getStateRoute = createRoute({
  method: "get",
  path: "/state",
  tags: ["State"],
  summary: "Get full state snapshot",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Full state snapshot",
    },
  },
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/orchestrator-config",
  tags: ["State"],
  summary: "Get orchestrator config",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Orchestrator config",
    },
  },
});

const getMemoryRoute = createRoute({
  method: "get",
  path: "/memory",
  tags: ["Memory"],
  summary: "Get memory",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ exists: z.boolean(), content: z.any() }) }) } },
      description: "Memory content",
    },
  },
});

const updateMemoryRoute = createRoute({
  method: "put",
  path: "/memory",
  tags: ["Memory"],
  summary: "Update memory",
  request: {
    body: { content: { "application/json": { schema: UpdateMemorySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ saved: z.boolean() }) }) } },
      description: "Memory updated",
    },
  },
});

const listLogsRoute = createRoute({
  method: "get",
  path: "/logs",
  tags: ["Logs"],
  summary: "List log sessions",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "List of log sessions",
    },
  },
});

const getLogSessionRoute = createRoute({
  method: "get",
  path: "/logs/{sessionId}",
  tags: ["Logs"],
  summary: "Get log entries for a session",
  request: {
    params: z.object({ sessionId: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Log entries for the session",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
      description: "Log store not available",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * State, config, memory, and logs routes.
 */
export function stateRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /state — full state snapshot
  app.openapi(getStateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: redactPolpoState(orchestrator.getStore().getState()) });
  });

  // GET /orchestrator-config — orchestrator config
  app.openapi(getConfigRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const config = orchestrator.getConfig();
    return c.json({ ok: true, data: config ? redactPolpoConfig(config) : config });
  });

  // GET /memory — memory
  app.openapi(getMemoryRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({
      ok: true,
      data: {
        exists: orchestrator.hasMemory(),
        content: orchestrator.getMemory(),
      },
    });
  });

  // PUT /memory — update memory
  app.openapi(updateMemoryRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");
    orchestrator.saveMemory(body.content);
    return c.json({ ok: true, data: { saved: true } });
  });

  // GET /logs — list log sessions
  app.openapi(listLogsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const logStore = orchestrator.getLogStore();
    if (!logStore) {
      return c.json({ ok: true, data: [] });
    }
    return c.json({ ok: true, data: logStore.listSessions() });
  });

  // GET /logs/:sessionId — get log entries for a session
  app.openapi(getLogSessionRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const logStore = orchestrator.getLogStore();
    if (!logStore) {
      return c.json({ ok: false, error: "Log store not available", code: "NOT_FOUND" }, 404);
    }
    const { sessionId } = c.req.valid("param");
    const entries = logStore.getSessionEntries(sessionId).map(e => sanitizeTranscriptEntry(e as unknown as Record<string, unknown>));
    return c.json({ ok: true, data: entries }, 200);
  });

  return app;
}
