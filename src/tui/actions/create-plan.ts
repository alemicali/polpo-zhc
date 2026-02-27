/**
 * Plan creation action — generates a structured plan from user prompt via LLM.
 * Uses tool-based structured output (submit_plan tool) for reliable generation.
 * Shows preview in viewer with Execute/Edit/Save/Refine actions.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import { seg, kickRun } from "../format.js";
import { buildPlanSystemPrompt } from "../../llm/prompts.js";
import { resolveModelSpec } from "../../llm/pi-client.js";
import {
  generatePlanInteractive,
  continuePlanWithAnswers,
  refinePlanStructured,
  planDataToJson,
  formatPlanReadable,
  formatPlanRich,
  type PlanData,
  type GeneratePlanResult,
  type UserAnswer,
} from "../../llm/plan-generator.js";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "plan";
}

export async function createPlan(
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  const agents = polpo.getAgents();
  if (agents.length === 0) {
    store.log("No agents configured. Use /team to add agents.", [
      seg("No agents configured. ", "red"),
      seg("Use ", "gray"),
      seg("/team", "cyan"),
      seg(" to add agents.", "gray"),
    ]);
    return;
  }

  store.startStreaming();
  store.setProcessing(true, "Generating plan...");

  try {
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
      (tokens) => store.updateProcessingTokens(tokens),
      settings?.reasoning,
    );

    store.setProcessing(false);
    store.stopStreaming();

    handlePlanResult(result, systemPrompt, prompt, polpo, store, model);
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Plan generation failed: ${msg}`, [seg(`Plan error: ${msg}`, "red")]);
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
  store: TUIStore,
  model?: string,
): void {
  if (result.type === "questions") {
    showQuestions(result, systemPrompt, originalPrompt, polpo, store, model);
  } else {
    showPlanPreview(result.data, originalPrompt, polpo, store);
  }
}

/**
 * Show the questions page for user clarification, then continue plan generation.
 */
function showQuestions(
  result: Extract<GeneratePlanResult, { type: "questions" }>,
  systemPrompt: string,
  originalPrompt: string,
  polpo: Orchestrator,
  store: TUIStore,
  model?: string,
): void {
  store.navigate({
    id: "questions",
    title: "Clarification needed",
    questions: result.questions,
    onSubmit: async (answers: UserAnswer[]) => {
      store.goMain();
      store.startStreaming();
      store.setProcessing(true, "Generating plan with your answers...");
      try {
        const nextResult = await continuePlanWithAnswers(
          systemPrompt,
          result.messages,
          answers,
          model,
          (tokens) => store.updateProcessingTokens(tokens),
        );
        store.setProcessing(false);
        store.stopStreaming();
        handlePlanResult(nextResult, systemPrompt, originalPrompt, polpo, store, model);
      } catch (err: unknown) {
        store.setProcessing(false);
        store.stopStreaming();
        const msg = err instanceof Error ? err.message : String(err);
        store.log(`Plan generation failed: ${msg}`, [seg(`Plan error: ${msg}`, "red")]);
      }
    },
    onCancel: () => {
      store.goMain();
      store.log("Plan cancelled", [seg("Plan cancelled", "yellow")]);
    },
  });
}

function showPlanPreview(
  planData: PlanData,
  originalPrompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  const richContent = formatPlanRich(planData, process.stdout.columns) as import("../store.js").Seg[][];
  const preview = formatPlanReadable(planData);
  const json = planDataToJson(planData);

  store.navigate({
    id: "viewer",
    title: `Plan: ${planData.name || "generated"}`,
    content: preview,
    richContent,
    actions: ["Execute", "Save draft", "Edit JSON", "Refine", "Cancel"],
    onAction: (idx) => {
      switch (idx) {
        case 0: // Execute
          store.goMain();
          executePlan(json, originalPrompt, polpo, store, planData.name);
          break;
        case 1: // Save draft
          store.goMain();
          saveDraft(json, originalPrompt, polpo, store, planData.name);
          break;
        case 2: // Edit JSON
          store.navigate({
            id: "editor",
            title: "Edit Plan JSON",
            initial: JSON.stringify(planData, null, 2),
            onSave: (edited) => {
              try {
                const newData = JSON.parse(edited) as PlanData;
                if (newData?.tasks?.length) {
                  showPlanPreview(newData, originalPrompt, polpo, store);
                } else {
                  store.goMain();
                  store.log("Edited plan has no tasks", [seg("Edited plan has no tasks", "red")]);
                }
              } catch {
                store.goMain();
                store.log("Invalid JSON in edited plan", [seg("Invalid JSON in edited plan", "red")]);
              }
            },
            onCancel: () => showPlanPreview(planData, originalPrompt, polpo, store),
          });
          break;
        case 3: // Refine
          store.navigate({
            id: "editor",
            title: "Refine — What should be changed?",
            initial: "",
            onSave: (feedback) => {
              if (!feedback.trim()) {
                showPlanPreview(planData, originalPrompt, polpo, store);
                return;
              }
              store.goMain();
              refinePlan(json, originalPrompt, feedback.trim(), polpo, store);
            },
            onCancel: () => showPlanPreview(planData, originalPrompt, polpo, store),
          });
          break;
        case 4: // Cancel
          store.goMain();
          store.log("Plan cancelled", [seg("Plan cancelled", "yellow")]);
          break;
      }
    },
    onClose: () => {
      store.goMain();
      store.log("Plan cancelled", [seg("Plan cancelled", "yellow")]);
    },
  });
}

function executePlan(
  json: string,
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
  name?: string,
): void {
  try {
    const planName = name ? slugify(name) : undefined;
    const plan = polpo.savePlan({ data: json, prompt, name: planName });
    const result = polpo.executePlan(plan.id);
    store.log(`Plan executed: ${plan.name} (${result.tasks.length} tasks)`, [
      seg("▶ ", "blue", true),
      seg(plan.name, undefined, true),
      seg(` → ${result.tasks.length} tasks`, "gray"),
    ]);
    kickRun(polpo, store);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Execute error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function saveDraft(
  json: string,
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
  name?: string,
): void {
  try {
    const planName = name ? slugify(name) : undefined;
    const plan = polpo.savePlan({ data: json, prompt, status: "draft", name: planName });
    store.log(`Draft saved: ${plan.name}`, [
      seg("■ ", "blue"),
      seg(plan.name, undefined, true),
      seg(" (draft)", "gray"),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Save error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

async function refinePlan(
  currentJson: string,
  originalPrompt: string,
  feedback: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  store.startStreaming();
  store.setProcessing(true, "Refining plan...");

  try {
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildPlanSystemPrompt(polpo, state, polpo.getWorkDir());
    const settings2 = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings2?.orchestratorModel);

    const planData = await refinePlanStructured(
      systemPrompt,
      originalPrompt,
      currentJson,
      feedback,
      model,
      (tokens) => store.updateProcessingTokens(tokens),
      settings2?.reasoning,
    );

    store.setProcessing(false);
    store.stopStreaming();
    showPlanPreview(planData, originalPrompt, polpo, store);
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Refine error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}
