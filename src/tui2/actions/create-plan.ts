/**
 * Plan creation action — generates a structured plan from user prompt via LLM.
 * Uses tool-based structured output (submit_plan tool) for reliable generation.
 * Shows preview in viewer overlay with Execute/Edit/Save/Refine actions.
 *
 * Port of src/tui/actions/create-plan.ts for the pi-tui imperative TUI2.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIContext } from "../types.js";
import type {
  PlanData,
  GeneratePlanResult,
  UserAnswer,
} from "../../llm/plan-generator.js";
import chalk from "chalk";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { EditorOverlay } from "../overlays/editor-page.js";
import { QuestionsOverlay, type Question } from "../overlays/questions.js";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "plan";
}

/**
 * Create a plan from a natural language prompt using LLM generation.
 */
export async function createPlan(
  prompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  const agents = polpo.getAgents();
  if (agents.length === 0) {
    tui.logSystem(`${theme.error("No agents configured.")} Use ${theme.info("/team")} to add agents.`);
    tui.requestRender();
    return;
  }

  tui.setStreaming(true);
  tui.setProcessing(true, "Generating plan…");
  tui.requestRender();

  try {
    const {
      generatePlanInteractive,
      continuePlanWithAnswers,
      planDataToJson,
      formatPlanReadable,
    } = await import("../../llm/plan-generator.js");
    const { buildPlanSystemPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildPlanSystemPrompt(polpo, state, polpo.getWorkDir());
    const userPrompt = `Generate a task plan for:\n"${prompt}"`;
    const settings = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings?.orchestratorModel);

    const result = await generatePlanInteractive(
      systemPrompt,
      userPrompt,
      model,
      (tokens) => tui.updateStreamingTokens(tokens),
      settings?.reasoning,
    );

    tui.setProcessing(false);
    tui.setStreaming(false);

    handlePlanResult(result, systemPrompt, prompt, polpo, tui, model);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Plan generation failed: ${msg}`);
    tui.requestRender();
  }
}

/**
 * Handle a plan generation result — either show questions or plan preview.
 */
function handlePlanResult(
  result: GeneratePlanResult,
  systemPrompt: string,
  originalPrompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
  model?: string,
): void {
  if (result.type === "questions") {
    showQuestions(result, systemPrompt, originalPrompt, polpo, tui, model);
  } else {
    void showPlanPreview(result.data, originalPrompt, polpo, tui);
  }
}

/**
 * Show the questions overlay for user clarification, then continue plan generation.
 */
function showQuestions(
  result: Extract<GeneratePlanResult, { type: "questions" }>,
  systemPrompt: string,
  originalPrompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
  model?: string,
): void {
  // Map UserQuestion[] to the QuestionsOverlay Question format
  const questions: Question[] = result.questions.map((q) => ({
    question: q.question,
    options: q.options.map((o) => ({ label: o.label, value: o.label })),
    multiSelect: q.multiSelect,
  }));

  const overlay = new QuestionsOverlay({
    questions,
    onSubmit: async (answerMap) => {
      tui.hideOverlay();
      tui.setStreaming(true);
      tui.setProcessing(true, "Generating plan with your answers…");
      tui.requestRender();

      try {
        const { continuePlanWithAnswers } = await import("../../llm/plan-generator.js");

        // Convert Map<number, string[]> to UserAnswer[]
        const answers: UserAnswer[] = [];
        for (const [idx, values] of answerMap) {
          const q = result.questions[idx];
          if (q) {
            answers.push({
              questionId: q.id,
              selected: values,
            });
          }
        }

        const nextResult = await continuePlanWithAnswers(
          systemPrompt,
          result.messages,
          answers,
          model,
          (tokens) => tui.updateStreamingTokens(tokens),
        );

        tui.setProcessing(false);
        tui.setStreaming(false);
        void handlePlanResult(nextResult, systemPrompt, originalPrompt, polpo, tui, model);
      } catch (err: unknown) {
        tui.setProcessing(false);
        tui.setStreaming(false);
        const msg = err instanceof Error ? err.message : String(err);
        tui.logSystem(`${theme.error("✗")} Plan generation failed: ${msg}`);
        tui.requestRender();
      }
    },
    onCancel: () => {
      tui.hideOverlay();
      tui.logSystem(`${theme.warning("Plan cancelled")}`);
      tui.requestRender();
    },
  });
  tui.showOverlay(overlay);
}

/**
 * Show the plan preview in a viewer overlay with Execute/Edit/Save/Refine actions.
 */
async function showPlanPreview(
  planData: PlanData,
  originalPrompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  // Format plan for display using the rich formatter.
  // formatPlanRich returns PlanSeg[][] — an array of lines, each line being an array of styled segments.
  // We flatten to plain text with chalk styling for the viewer.
  let content: string;
  try {
    const { formatPlanRich } = await import("../../llm/plan-generator.js");
    const richLines = formatPlanRich(planData, process.stdout.columns ?? 80);
    content = richLines
      .map((segs) =>
        segs.map((s) => {
          let text = s.text;
          if (s.bold) text = chalk.bold(text);
          if (s.dim) text = chalk.dim(text);
          if (s.color) text = chalk.hex(s.color)(text);
          return text;
        }).join("")
      )
      .join("\n");
  } catch {
    // Fallback to JSON if formatter fails
    content = JSON.stringify(planData, null, 2);
  }

  const viewer = new ViewerOverlay({
    title: `Plan: ${planData.name || "generated"}`,
    content,
    actions: [
      {
        label: "Execute",
        handler: () => {
          tui.hideOverlay();
          executePlan(planData, originalPrompt, polpo, tui);
        },
      },
      {
        label: "Save draft",
        handler: () => {
          tui.hideOverlay();
          saveDraft(planData, originalPrompt, polpo, tui);
        },
      },
      {
        label: "Edit JSON",
        handler: () => {
          tui.hideOverlay();
          const editor = new EditorOverlay({
            title: "Edit Plan JSON",
            initialText: JSON.stringify(planData, null, 2),
            tui: tui.tuiInstance,
            onSave: (text) => {
              tui.hideOverlay();
              try {
                const edited = JSON.parse(text) as PlanData;
                if (edited?.tasks?.length) {
                  void showPlanPreview(edited, originalPrompt, polpo, tui);
                } else {
                  tui.logSystem(`${theme.error("Edited plan has no tasks")}`);
                  tui.requestRender();
                }
              } catch {
                tui.logSystem(`${theme.error("Invalid JSON in edited plan")}`);
                tui.requestRender();
              }
            },
            onCancel: () => void showPlanPreview(planData, originalPrompt, polpo, tui),
          });
          tui.showOverlay(editor);
        },
      },
      {
        label: "Refine",
        handler: () => {
          tui.hideOverlay();
          const editor = new EditorOverlay({
            title: "Refine — What should be changed?",
            initialText: "",
            tui: tui.tuiInstance,
            onSave: (feedback) => {
              tui.hideOverlay();
              if (!feedback.trim()) {
                void showPlanPreview(planData, originalPrompt, polpo, tui);
                return;
              }
              refinePlan(planData, originalPrompt, feedback.trim(), polpo, tui);
            },
            onCancel: () => void showPlanPreview(planData, originalPrompt, polpo, tui),
          });
          tui.showOverlay(editor);
        },
      },
      {
        label: "Cancel",
        handler: () => {
          tui.hideOverlay();
          tui.logSystem(`${theme.warning("Plan cancelled")}`);
          tui.requestRender();
        },
      },
    ],
    onClose: () => {
      tui.hideOverlay();
      tui.logSystem(`${theme.warning("Plan cancelled")}`);
      tui.requestRender();
    },
  });
  tui.showOverlay(viewer);
}

function executePlan(
  planData: PlanData,
  prompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  try {
    const json = JSON.stringify(planData);
    const planName = planData.name ? slugify(planData.name) : undefined;
    const plan = polpo.savePlan({ data: json, prompt, name: planName });
    const result = polpo.executePlan(plan.id);
    tui.logSystem(
      `${theme.done("▶")} ${theme.bold(plan.name)} → ${theme.dim(`${result.tasks.length} tasks`)}`,
    );
    tui.requestRender();
    kickRun(polpo);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Execute error: ${msg}`);
    tui.requestRender();
  }
}

function saveDraft(
  planData: PlanData,
  prompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  try {
    const json = JSON.stringify(planData);
    const planName = planData.name ? slugify(planData.name) : undefined;
    const plan = polpo.savePlan({ data: json, prompt, status: "draft", name: planName });
    tui.logSystem(`${theme.done("■")} ${theme.bold(plan.name)} ${theme.dim("(draft)")}`);
    tui.requestRender();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Save error: ${msg}`);
    tui.requestRender();
  }
}

async function refinePlan(
  currentPlanData: PlanData,
  originalPrompt: string,
  feedback: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  tui.setStreaming(true);
  tui.setProcessing(true, "Refining plan…");
  tui.requestRender();

  try {
    const { refinePlanStructured } = await import("../../llm/plan-generator.js");
    const { buildPlanSystemPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildPlanSystemPrompt(polpo, state, polpo.getWorkDir());
    const settings2 = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings2?.orchestratorModel);
    const currentJson = JSON.stringify(currentPlanData);

    const planData = await refinePlanStructured(
      systemPrompt,
      originalPrompt,
      currentJson,
      feedback,
      model,
      (tokens) => tui.updateStreamingTokens(tokens),
      settings2?.reasoning,
    );

    tui.setProcessing(false);
    tui.setStreaming(false);
    void showPlanPreview(planData, originalPrompt, polpo, tui);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Refine error: ${msg}`);
    tui.requestRender();
  }
}
