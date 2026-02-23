import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import type { ProjectManager } from "../project-manager.js";
import { UpdateMemorySchema } from "../schemas.js";
import { redactPolpoState, redactPolpoConfig, sanitizeTranscriptEntry } from "../security.js";

// ── Route definitions ─────────────────────────────────────────────────

const listProjectsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Projects"],
  summary: "List all registered projects",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "List of projects",
    },
  },
});

const getStateRoute = createRoute({
  method: "get",
  path: "/state",
  tags: ["Projects"],
  summary: "Get full state snapshot",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Full state snapshot",
    },
  },
});

const getProjectConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Projects"],
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
  summary: "Get project memory",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ exists: z.boolean(), content: z.any() }) }) } },
      description: "Project memory",
    },
  },
});

const updateMemoryRoute = createRoute({
  method: "put",
  path: "/memory",
  tags: ["Memory"],
  summary: "Update project memory",
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
 * Project listing, state, config, memory, logs routes.
 */
export function projectListRoutes(pm: ProjectManager): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET / — list all registered projects
  app.openapi(listProjectsRoute, (c) => {
    return c.json({ ok: true, data: pm.list() });
  });

  return app;
}

/**
 * Per-project state access routes (mounted under /projects/:projectId/).
 */
export function projectDetailRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /state — full state snapshot
  app.openapi(getStateRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: redactPolpoState(orchestrator.getStore().getState()) });
  });

  // GET /config — orchestrator config
  app.openapi(getProjectConfigRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const config = orchestrator.getConfig();
    return c.json({ ok: true, data: config ? redactPolpoConfig(config) : config });
  });

  // GET /memory — project memory
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

  // PUT /memory — update project memory
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
