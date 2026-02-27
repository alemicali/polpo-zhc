/**
 * Mission creation action — generates a structured mission from user prompt via LLM.
 * Uses tool-based structured output (submit_mission tool) for reliable generation.
 * Shows preview in viewer with Execute/Edit/Save/Refine actions.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import { seg, kickRun } from "../format.js";
import { buildMissionSystemPrompt } from "../../llm/prompts.js";
import { resolveModelSpec } from "../../llm/pi-client.js";
import {
  generateMissionInteractive,
  continueMissionWithAnswers,
  refineMissionStructured,
  missionDataToJson,
  formatMissionReadable,
  formatMissionRich,
  type MissionData,
  type GenerateMissionResult,
  type UserAnswer,
} from "../../llm/mission-generator.js";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "mission";
}

export async function createMission(
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
  store.setProcessing(true, "Generating mission...");

  try {
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildMissionSystemPrompt(polpo, state, polpo.getWorkDir());
    const userPrompt = `Generate a task mission for:\n"${prompt}"`;
    const settings = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings?.orchestratorModel);

    const result = await generateMissionInteractive(
      systemPrompt,
      userPrompt,
      model,
      (tokens) => store.updateProcessingTokens(tokens),
      settings?.reasoning,
    );

    store.setProcessing(false);
    store.stopStreaming();

    handleMissionResult(result, systemPrompt, prompt, polpo, store, model);
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Mission generation failed: ${msg}`, [seg(`Mission error: ${msg}`, "red")]);
  }
}

/**
 * Handle a mission generation result — either show questions or mission preview.
 */
function handleMissionResult(
  result: GenerateMissionResult,
  systemPrompt: string,
  originalPrompt: string,
  polpo: Orchestrator,
  store: TUIStore,
  model?: string,
): void {
  if (result.type === "questions") {
    showQuestions(result, systemPrompt, originalPrompt, polpo, store, model);
  } else {
    showMissionPreview(result.data, originalPrompt, polpo, store);
  }
}

/**
 * Show the questions page for user clarification, then continue mission generation.
 */
function showQuestions(
  result: Extract<GenerateMissionResult, { type: "questions" }>,
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
      store.setProcessing(true, "Generating mission with your answers...");
      try {
        const nextResult = await continueMissionWithAnswers(
          systemPrompt,
          result.messages,
          answers,
          model,
          (tokens) => store.updateProcessingTokens(tokens),
        );
        store.setProcessing(false);
        store.stopStreaming();
        handleMissionResult(nextResult, systemPrompt, originalPrompt, polpo, store, model);
      } catch (err: unknown) {
        store.setProcessing(false);
        store.stopStreaming();
        const msg = err instanceof Error ? err.message : String(err);
        store.log(`Mission generation failed: ${msg}`, [seg(`Mission error: ${msg}`, "red")]);
      }
    },
    onCancel: () => {
      store.goMain();
      store.log("Mission cancelled", [seg("Mission cancelled", "yellow")]);
    },
  });
}

function showMissionPreview(
  missionData: MissionData,
  originalPrompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  const richContent = formatMissionRich(missionData, process.stdout.columns) as import("../store.js").Seg[][];
  const preview = formatMissionReadable(missionData);
  const json = missionDataToJson(missionData);

  store.navigate({
    id: "viewer",
    title: `Mission: ${missionData.name || "generated"}`,
    content: preview,
    richContent,
    actions: ["Execute", "Save draft", "Edit JSON", "Refine", "Cancel"],
    onAction: (idx) => {
      switch (idx) {
        case 0: // Execute
          store.goMain();
          executeMission(json, originalPrompt, polpo, store, missionData.name);
          break;
        case 1: // Save draft
          store.goMain();
          saveDraft(json, originalPrompt, polpo, store, missionData.name);
          break;
        case 2: // Edit JSON
          store.navigate({
            id: "editor",
            title: "Edit Mission JSON",
            initial: JSON.stringify(missionData, null, 2),
            onSave: (edited) => {
              try {
                const newData = JSON.parse(edited) as MissionData;
                if (newData?.tasks?.length) {
                  showMissionPreview(newData, originalPrompt, polpo, store);
                } else {
                  store.goMain();
                  store.log("Edited mission has no tasks", [seg("Edited mission has no tasks", "red")]);
                }
              } catch {
                store.goMain();
                store.log("Invalid JSON in edited mission", [seg("Invalid JSON in edited mission", "red")]);
              }
            },
            onCancel: () => showMissionPreview(missionData, originalPrompt, polpo, store),
          });
          break;
        case 3: // Refine
          store.navigate({
            id: "editor",
            title: "Refine — What should be changed?",
            initial: "",
            onSave: (feedback) => {
              if (!feedback.trim()) {
                showMissionPreview(missionData, originalPrompt, polpo, store);
                return;
              }
              store.goMain();
              refineMission(json, originalPrompt, feedback.trim(), polpo, store);
            },
            onCancel: () => showMissionPreview(missionData, originalPrompt, polpo, store),
          });
          break;
        case 4: // Cancel
          store.goMain();
          store.log("Mission cancelled", [seg("Mission cancelled", "yellow")]);
          break;
      }
    },
    onClose: () => {
      store.goMain();
      store.log("Mission cancelled", [seg("Mission cancelled", "yellow")]);
    },
  });
}

function executeMission(
  json: string,
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
  name?: string,
): void {
  try {
    const missionName = name ? slugify(name) : undefined;
    const mission = polpo.saveMission({ data: json, prompt, name: missionName });
    const result = polpo.executeMission(mission.id);
    store.log(`Mission executed: ${mission.name} (${result.tasks.length} tasks)`, [
      seg("▶ ", "blue", true),
      seg(mission.name, undefined, true),
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
    const missionName = name ? slugify(name) : undefined;
    const mission = polpo.saveMission({ data: json, prompt, status: "draft", name: missionName });
    store.log(`Draft saved: ${mission.name}`, [
      seg("■ ", "blue"),
      seg(mission.name, undefined, true),
      seg(" (draft)", "gray"),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Save error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

async function refineMission(
  currentJson: string,
  originalPrompt: string,
  feedback: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  store.startStreaming();
  store.setProcessing(true, "Refining mission...");

  try {
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildMissionSystemPrompt(polpo, state, polpo.getWorkDir());
    const settings2 = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings2?.orchestratorModel);

    const missionData = await refineMissionStructured(
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
    showMissionPreview(missionData, originalPrompt, polpo, store);
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Refine error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}
