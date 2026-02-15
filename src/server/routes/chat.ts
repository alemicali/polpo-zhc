import { Hono } from "hono";
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
  parseBody,
} from "../schemas.js";

/**
 * Chat & LLM generation routes.
 */
export function chatRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // POST /chat — Q&A about Polpo state
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(ChatMessageSchema, await c.req.json());

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
  app.post("/generate-plan", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(GeneratePlanSchema, await c.req.json());

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
  app.post("/prepare-task", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(PrepareTaskSchema, await c.req.json());

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
  app.post("/generate-team", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(GenerateTeamSchema, await c.req.json());

    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const { generateTeam } = await import("../../llm/plan-generator.js");
    const systemPrompt = buildTeamGenPrompt(orchestrator, workDir, body.description);
    const teamData = await generateTeam(systemPrompt, body.description, model);
    return c.json({ ok: true, data: { teamData } });
  });

  // POST /chat/refine-team — refine generated team with feedback (tool-based)
  app.post("/refine-team", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(RefineTeamSchema, await c.req.json());

    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const { refineTeam } = await import("../../llm/plan-generator.js");
    const systemPrompt = buildTeamGenPrompt(orchestrator, workDir, body.description || "");
    const teamData = await refineTeam(systemPrompt, body.currentData, body.feedback, model);
    return c.json({ ok: true, data: { teamData } });
  });

  // GET /chat/sessions — list chat sessions
  app.get("/sessions", (c) => {
    const orchestrator = c.get("orchestrator");
    const sessionStore = orchestrator.getSessionStore();
    if (!sessionStore) {
      return c.json({ ok: true, data: { sessions: [] } });
    }
    const sessions = sessionStore.listSessions();
    return c.json({ ok: true, data: { sessions } });
  });

  // GET /chat/sessions/:id/messages — get messages for a session
  app.get("/sessions/:id/messages", (c) => {
    const orchestrator = c.get("orchestrator");
    const sessionStore = orchestrator.getSessionStore();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const session = sessionStore.getSession(c.req.param("id"));
    if (!session) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    const messages = sessionStore.getMessages(c.req.param("id"));
    return c.json({ ok: true, data: { session, messages } });
  });

  // DELETE /chat/sessions/:id — delete a session
  app.delete("/sessions/:id", (c) => {
    const orchestrator = c.get("orchestrator");
    const sessionStore = orchestrator.getSessionStore();
    if (!sessionStore) {
      return c.json({ ok: false, error: "Session store not available", code: "NOT_AVAILABLE" }, 503);
    }
    const deleted = sessionStore.deleteSession(c.req.param("id"));
    if (!deleted) {
      return c.json({ ok: false, error: "Session not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { deleted: true } });
  });

  // POST /chat/refine-plan — refine generated plan with feedback
  app.post("/refine-plan", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(RefinePlanSchema, await c.req.json());

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
