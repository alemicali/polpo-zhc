import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import { buildChatSystemPrompt, buildPlanSystemPrompt, buildTeamGenPrompt } from "../../llm/prompts.js";
import { querySDKText, querySDK, extractYaml, extractTeamYaml } from "../../llm/query.js";

/**
 * Chat & LLM generation routes.
 */
export function chatRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // POST /chat — Q&A about Orchestra state
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = await c.req.json<{ message: string }>();

    if (!body.message?.trim()) {
      return c.json(
        { ok: false, error: "message is required", code: "VALIDATION_ERROR" },
        400
      );
    }

    const state = orchestrator.getStore().getState();
    const workDir = orchestrator.getWorkDir();
    const model = orchestrator.getConfig()?.settings?.orchestratorModel;

    const prompt = [
      buildChatSystemPrompt(orchestrator, state, workDir),
      ``,
      `---`,
      ``,
      `User question: ${body.message}`,
      ``,
      `Answer concisely based on the current Orchestra state. Use markdown for formatting.`,
    ].join("\n");

    const response = await querySDKText(prompt, workDir, model);
    return c.json({ ok: true, data: { response } });
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
