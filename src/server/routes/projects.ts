import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import type { ProjectManager } from "../project-manager.js";

/**
 * Project listing, state, config, memory, logs routes.
 */
export function projectListRoutes(pm: ProjectManager): Hono {
  const app = new Hono();

  // GET / — list all registered projects
  app.get("/", (c) => {
    return c.json({ ok: true, data: pm.list() });
  });

  return app;
}

/**
 * Per-project state access routes (mounted under /projects/:projectId/).
 */
export function projectDetailRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /state — full state snapshot
  app.get("/state", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getStore().getState() });
  });

  // GET /config — orchestrator config
  app.get("/config", (c) => {
    const orchestrator = c.get("orchestrator");
    const config = orchestrator.getConfig();
    return c.json({ ok: true, data: config });
  });

  // GET /memory — project memory
  app.get("/memory", (c) => {
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
  app.put("/memory", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ content: string }>();
    if (body.content === undefined) {
      return c.json(
        { ok: false, error: "content is required", code: "VALIDATION_ERROR" },
        400
      );
    }
    orchestrator.saveMemory(body.content);
    return c.json({ ok: true, data: { saved: true } });
  });

  // GET /logs — list log sessions
  app.get("/logs", (c) => {
    const orchestrator = c.get("orchestrator");
    const logStore = orchestrator.getLogStore();
    if (!logStore) {
      return c.json({ ok: true, data: [] });
    }
    return c.json({ ok: true, data: logStore.listSessions() });
  });

  // GET /logs/:sessionId — get log entries for a session
  app.get("/logs/:sessionId", (c) => {
    const orchestrator = c.get("orchestrator");
    const logStore = orchestrator.getLogStore();
    if (!logStore) {
      return c.json({ ok: false, error: "Log store not available", code: "NOT_FOUND" }, 404);
    }
    const entries = logStore.getSessionEntries(c.req.param("sessionId"));
    return c.json({ ok: true, data: entries });
  });

  return app;
}
