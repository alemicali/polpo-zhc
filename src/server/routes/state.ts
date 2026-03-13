import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { UpdateMemorySchema } from "../schemas.js";
import { redactPolpoState, redactPolpoConfig, sanitizeTranscriptEntry } from "../security.js";

// ── Route definitions ─────────────────────────────────────────────────

const getStateRoute = createRoute({
  method: "get",
  path: "/state",
  tags: ["State"],
  summary: "Get state",
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
  summary: "Get shared memory",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ exists: z.boolean(), content: z.any() }) }) } },
      description: "Shared memory content",
    },
  },
});

const updateMemoryRoute = createRoute({
  method: "put",
  path: "/memory",
  tags: ["Memory"],
  summary: "Update shared memory",
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

const getAgentMemoryRoute = createRoute({
  method: "get",
  path: "/memory/agent/{agentName}",
  tags: ["Memory"],
  summary: "Get agent-specific memory",
  request: {
    params: z.object({ agentName: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ exists: z.boolean(), content: z.any(), agent: z.string() }) }) } },
      description: "Agent memory content",
    },
  },
});

const updateAgentMemoryRoute = createRoute({
  method: "put",
  path: "/memory/agent/{agentName}",
  tags: ["Memory"],
  summary: "Update agent-specific memory",
  request: {
    params: z.object({ agentName: z.string() }),
    body: { content: { "application/json": { schema: UpdateMemorySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ saved: z.boolean(), agent: z.string() }) }) } },
      description: "Agent memory updated",
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
  summary: "Get log entries",
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
export function stateRoutes(getDeps: () => {
  taskStore: any;
  getConfig: () => any;
  hasMemory: () => Promise<boolean>;
  getMemory: () => Promise<string>;
  saveMemory: (content: string) => Promise<void>;
  hasAgentMemory: (name: string) => Promise<boolean>;
  getAgentMemory: (name: string) => Promise<string>;
  saveAgentMemory: (name: string, content: string) => Promise<void>;
  getLogStore: () => any;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET /state — full state snapshot
  app.openapi(getStateRoute, async (c) => {
    const deps = getDeps();
    return c.json({ ok: true, data: redactPolpoState(await deps.taskStore.getState()) });
  });

  // GET /orchestrator-config — orchestrator config
  app.openapi(getConfigRoute, (c) => {
    const deps = getDeps();
    const config = deps.getConfig();
    return c.json({ ok: true, data: config ? redactPolpoConfig(config) : config });
  });

  // GET /memory — shared memory
  app.openapi(getMemoryRoute, async (c) => {
    const deps = getDeps();
    return c.json({
      ok: true,
      data: {
        exists: await deps.hasMemory(),
        content: await deps.getMemory(),
      },
    });
  });

  // PUT /memory — update shared memory
  app.openapi(updateMemoryRoute, async (c) => {
    const deps = getDeps();
    const body = c.req.valid("json");
    await deps.saveMemory(body.content);
    return c.json({ ok: true, data: { saved: true } });
  });

  // GET /memory/agent/:agentName — agent-specific memory
  app.openapi(getAgentMemoryRoute, async (c) => {
    const deps = getDeps();
    const { agentName } = c.req.valid("param");
    return c.json({
      ok: true,
      data: {
        exists: await deps.hasAgentMemory(agentName),
        content: await deps.getAgentMemory(agentName),
        agent: agentName,
      },
    });
  });

  // PUT /memory/agent/:agentName — update agent-specific memory
  app.openapi(updateAgentMemoryRoute, async (c) => {
    const deps = getDeps();
    const { agentName } = c.req.valid("param");
    const body = c.req.valid("json");
    await deps.saveAgentMemory(agentName, body.content);
    return c.json({ ok: true, data: { saved: true, agent: agentName } });
  });

  // GET /logs — list log sessions
  app.openapi(listLogsRoute, async (c) => {
    const deps = getDeps();
    const logStore = deps.getLogStore();
    if (!logStore) {
      return c.json({ ok: true, data: [] });
    }
    return c.json({ ok: true, data: await logStore.listSessions() });
  });

  // GET /logs/:sessionId — get log entries for a session
  app.openapi(getLogSessionRoute, async (c) => {
    const deps = getDeps();
    const logStore = deps.getLogStore();
    if (!logStore) {
      return c.json({ ok: false, error: "Log store not available", code: "NOT_FOUND" }, 404);
    }
    const { sessionId } = c.req.valid("param");
    const entries = (await logStore.getSessionEntries(sessionId)).map((e: any) => sanitizeTranscriptEntry(e as unknown as Record<string, unknown>));
    return c.json({ ok: true, data: entries }, 200);
  });

  return app;
}
