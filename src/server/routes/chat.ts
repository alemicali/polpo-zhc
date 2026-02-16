import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { buildChatSystemPrompt, buildPlanSystemPrompt, buildTeamGenPrompt } from "../../llm/prompts.js";
import { querySDKText } from "../../llm/query.js";
import {
  ChatMessageSchema,
  GeneratePlanSchema,
  PrepareTaskSchema,
  GenerateTeamSchema,
  RefineTeamSchema,
  RefinePlanSchema,
} from "../schemas.js";

/* ── Route definitions ─────────────────────────────────────────────── */

const chatRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat"],
  summary: "Q&A about Polpo state",
  request: {
    body: { content: { "application/json": { schema: ChatMessageSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Chat response",
    },
  },
});

const generatePlanRoute = createRoute({
  method: "post",
  path: "/generate-plan",
  tags: ["Chat"],
  summary: "Generate plan from natural language",
  request: {
    body: { content: { "application/json": { schema: GeneratePlanSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Generated plan",
    },
  },
});

const prepareTaskRoute = createRoute({
  method: "post",
  path: "/prepare-task",
  tags: ["Chat"],
  summary: "LLM-enriched task preparation",
  request: {
    body: { content: { "application/json": { schema: PrepareTaskSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Prepared task data",
    },
  },
});

const generateTeamRoute = createRoute({
  method: "post",
  path: "/generate-team",
  tags: ["Chat"],
  summary: "AI team generation",
  request: {
    body: { content: { "application/json": { schema: GenerateTeamSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Generated team data",
    },
  },
});

const refineTeamRoute = createRoute({
  method: "post",
  path: "/refine-team",
  tags: ["Chat"],
  summary: "Refine generated team with feedback",
  request: {
    body: { content: { "application/json": { schema: RefineTeamSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Refined team data",
    },
  },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Chat"],
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
  tags: ["Chat"],
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
  tags: ["Chat"],
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

const refinePlanRoute = createRoute({
  method: "post",
  path: "/refine-plan",
  tags: ["Chat"],
  summary: "Refine generated plan with feedback",
  request: {
    body: { content: { "application/json": { schema: RefinePlanSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Refined plan",
    },
  },
});

/* ── Handlers ──────────────────────────────────────────────────────── */

/**
 * Chat & LLM generation routes.
 */
export function chatRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // POST /chat — Q&A about Polpo state
  app.openapi(chatRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;
    const sessionStore = orchestrator.getSessionStore();

    // Resolve session
    let sessionId = body.sessionId;

    if (sessionStore) {
      if (!sessionId) {
        const latest = sessionStore.getLatestSession();
        const age = latest ? Date.now() - new Date(latest.updatedAt).getTime() : Infinity;
        if (age < 30 * 60 * 1000) {
          sessionId = latest!.id;
        } else {
          sessionId = sessionStore.create();
          orchestrator.emit("session:created", { sessionId, title: body.message.slice(0, 60) });
        }
      }
      const userMsg = sessionStore.addMessage(sessionId, "user", body.message);
      orchestrator.emit("message:added", { sessionId, messageId: userMsg.id, role: "user" });
    }

    // Build prompt with history
    const parts: string[] = [
      buildChatSystemPrompt(orchestrator, state, workDir),
    ];

    if (sessionStore && sessionId) {
      const history = sessionStore.getRecentMessages(sessionId, 20);
      const past = history.filter(m => !(m.role === "user" && m.content === body.message));
      if (past.length > 0) {
        parts.push("", "## Conversation History", "");
        for (const m of past) {
          parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
        }
      }
    }

    parts.push("", "---", "", `User question: ${body.message}`, "", `Answer concisely based on the current Polpo state. Use markdown for formatting.`);

    const response = await querySDKText(parts.join("\n"), workDir, model);

    if (sessionStore && sessionId) {
      const assistantMsg = sessionStore.addMessage(sessionId, "assistant", response);
      orchestrator.emit("message:added", { sessionId, messageId: assistantMsg.id, role: "assistant" });
    }

    return c.json({ ok: true, data: { response, sessionId } });
  });

  // POST /chat/generate-plan — generate plan from natural language (tool-based)
  app.openapi(generatePlanRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const { generatePlan, planDataToJson } = await import("../../llm/plan-generator.js");
    const systemPrompt = buildPlanSystemPrompt(orchestrator, state, workDir);
    const userPrompt = `Generate a task plan for:\n"${body.prompt}"`;

    const planData = await generatePlan(systemPrompt, userPrompt, model);
    const json = planDataToJson(planData);
    return c.json({ ok: true, data: { json, planData } });
  });

  // POST /chat/prepare-task — LLM-enriched task preparation (tool-based)
  app.openapi(prepareTaskRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const { buildTaskPrepPrompt } = await import("../../llm/prompts.js");
    const { generateTaskPrep } = await import("../../llm/plan-generator.js");
    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const systemPrompt = buildTaskPrepPrompt(orchestrator, state, workDir, body.description, body.assignTo);
    const taskData = await generateTaskPrep(systemPrompt, body.description, model);
    return c.json({ ok: true, data: { taskData } });
  });

  // POST /chat/generate-team — AI team generation (tool-based)
  app.openapi(generateTeamRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const { generateTeam } = await import("../../llm/plan-generator.js");
    const systemPrompt = buildTeamGenPrompt(orchestrator, workDir, body.description);
    const teamData = await generateTeam(systemPrompt, body.description, model);
    return c.json({ ok: true, data: { teamData } });
  });

  // POST /chat/refine-team — refine generated team with feedback (tool-based)
  app.openapi(refineTeamRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const { refineTeam } = await import("../../llm/plan-generator.js");
    const systemPrompt = buildTeamGenPrompt(orchestrator, workDir, body.description || "");
    const teamData = await refineTeam(systemPrompt, body.currentData, body.feedback, model);
    return c.json({ ok: true, data: { teamData } });
  });

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
    return c.json({ ok: true, data: { session, messages } }, 200);
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

  // POST /chat/refine-plan — refine generated plan with feedback
  app.openapi(refinePlanRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = c.req.valid("json");

    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const { refinePlanStructured, planDataToJson } = await import("../../llm/plan-generator.js");
    const systemPrompt = buildPlanSystemPrompt(orchestrator, state, workDir);

    const planData = await refinePlanStructured(
      systemPrompt, body.prompt || "", body.currentData, body.feedback, model,
    );
    const json = planDataToJson(planData);
    return c.json({ ok: true, data: { json, planData } });
  });

  return app;
}
