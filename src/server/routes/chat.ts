import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import { buildChatSystemPrompt, buildPlanSystemPrompt, buildTeamGenPrompt } from "../../llm/prompts.js";
import { querySDKText, querySDK, extractYaml, extractTeamYaml } from "../../llm/query.js";

/**
 * Chat & LLM generation routes.
 */
export function chatRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // POST /chat — Q&A about Polpo state
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ message: string; sessionId?: string }>();

    if (!body.message?.trim()) {
      return c.json(
        { ok: false, error: "message is required", code: "VALIDATION_ERROR" },
        400
      );
    }

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
        sessionId = age < 30 * 60 * 1000 ? latest!.id : sessionStore.create();
      }
      sessionStore.addMessage(sessionId, "user", body.message);
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
      sessionStore.addMessage(sessionId, "assistant", response);
    }

    return c.json({ ok: true, data: { response, sessionId } });
  });

  // POST /chat/generate-plan — generate plan YAML from natural language
  app.post("/generate-plan", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ prompt: string }>();

    if (!body.prompt?.trim()) {
      return c.json(
        { ok: false, error: "prompt is required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const systemPrompt = buildPlanSystemPrompt(orchestrator, state, workDir);
    const fullPrompt = [
      systemPrompt,
      ``,
      `---`,
      ``,
      `User request: ${body.prompt}`,
    ].join("\n");

    const raw = await querySDKText(fullPrompt, workDir, model);
    const yaml = extractYaml(raw);
    return c.json({ ok: true, data: { yaml, raw } });
  });

  // POST /chat/prepare-task — LLM-enriched task preparation
  app.post("/prepare-task", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ description: string; assignTo: string; group?: string }>();

    if (!body.description?.trim() || !body.assignTo?.trim()) {
      return c.json(
        { ok: false, error: "description and assignTo are required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const { buildTaskPrepPrompt } = await import("../../llm/prompts.js");
    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const prompt = buildTaskPrepPrompt(orchestrator, state, workDir, body.description, body.assignTo);
    const raw = await querySDKText(prompt, workDir, model);
    const yaml = extractYaml(raw);
    return c.json({ ok: true, data: { yaml, raw } });
  });

  // POST /chat/generate-team — AI team generation from natural language
  app.post("/generate-team", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ description: string }>();

    if (!body.description?.trim()) {
      return c.json(
        { ok: false, error: "description is required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const prompt = buildTeamGenPrompt(orchestrator, workDir, body.description);
    // Team gen needs Skill + Bash tools for skill discovery/installation
    const raw = await querySDK(prompt, ["Skill", "Bash"], workDir, undefined, model);
    const yaml = extractTeamYaml(raw);
    return c.json({ ok: true, data: { yaml, raw } });
  });

  // POST /chat/refine-team — refine generated team with feedback
  app.post("/refine-team", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ currentYaml: string; description: string; feedback: string }>();

    if (!body.currentYaml?.trim() || !body.feedback?.trim()) {
      return c.json(
        { ok: false, error: "currentYaml and feedback are required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const prompt = [
      buildTeamGenPrompt(orchestrator, workDir, body.description || ""),
      ``,
      `---`,
      ``,
      `Current team YAML:`,
      body.currentYaml,
      ``,
      `User feedback: "${body.feedback}"`,
      ``,
      `Revise the team based on the feedback. Output ONLY valid YAML.`,
    ].join("\n");

    const raw = await querySDK(prompt, ["Skill", "Bash"], workDir, undefined, model);
    const yaml = extractTeamYaml(raw);
    return c.json({ ok: true, data: { yaml, raw } });
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

  // POST /chat/refine-plan — refine generated plan with feedback
  app.post("/refine-plan", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ currentYaml: string; prompt: string; feedback: string }>();

    if (!body.currentYaml?.trim() || !body.feedback?.trim()) {
      return c.json(
        { ok: false, error: "currentYaml and feedback are required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const systemPrompt = buildPlanSystemPrompt(orchestrator, state, workDir);
    const fullPrompt = [
      systemPrompt,
      ``,
      `---`,
      ``,
      `Original request: ${body.prompt || ""}`,
      ``,
      `Current plan YAML:`,
      body.currentYaml,
      ``,
      `User feedback: "${body.feedback}"`,
      ``,
      `Revise the plan based on the feedback. Output ONLY valid YAML.`,
    ].join("\n");

    const raw = await querySDKText(fullPrompt, workDir, model);
    const yaml = extractYaml(raw);
    return c.json({ ok: true, data: { yaml, raw } });
  });

  return app;
}
