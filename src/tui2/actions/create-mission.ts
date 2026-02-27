/**
 * Mission creation action — generates a structured mission from user prompt via LLM.
 * Uses tool-based structured output (submit_mission tool) for reliable generation.
 * Shows preview in viewer overlay with Execute/Edit/Save/Refine actions.
 *
 * Port of src/tui/actions/create-mission.ts for the pi-tui imperative TUI2.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIContext } from "../types.js";
import type {
  MissionData,
  GenerateMissionResult,
  UserAnswer,
} from "../../llm/mission-generator.js";
import chalk from "chalk";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { EditorOverlay } from "../overlays/editor-page.js";
import { QuestionsOverlay, type Question } from "../overlays/questions.js";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "mission";
}

/**
 * Create a mission from a natural language prompt using LLM generation.
 */
export async function createMission(
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
  tui.setProcessing(true, "Generating mission…");
  tui.requestRender();

  try {
    const {
      generateMissionInteractive,
      continueMissionWithAnswers,
      missionDataToJson,
      formatMissionReadable,
    } = await import("../../llm/mission-generator.js");
    const { buildMissionSystemPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

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
      (tokens) => tui.updateStreamingTokens(tokens),
      settings?.reasoning,
    );

    tui.setProcessing(false);
    tui.setStreaming(false);

    handleMissionResult(result, systemPrompt, prompt, polpo, tui, model);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Mission generation failed: ${msg}`);
    tui.requestRender();
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
  tui: TUIContext,
  model?: string,
): void {
  if (result.type === "questions") {
    showQuestions(result, systemPrompt, originalPrompt, polpo, tui, model);
  } else {
    void showMissionPreview(result.data, originalPrompt, polpo, tui);
  }
}

/**
 * Show the questions overlay for user clarification, then continue mission generation.
 */
function showQuestions(
  result: Extract<GenerateMissionResult, { type: "questions" }>,
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
      tui.setProcessing(true, "Generating mission with your answers…");
      tui.requestRender();

      try {
        const { continueMissionWithAnswers } = await import("../../llm/mission-generator.js");

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

        const nextResult = await continueMissionWithAnswers(
          systemPrompt,
          result.messages,
          answers,
          model,
          (tokens) => tui.updateStreamingTokens(tokens),
        );

        tui.setProcessing(false);
        tui.setStreaming(false);
        void handleMissionResult(nextResult, systemPrompt, originalPrompt, polpo, tui, model);
      } catch (err: unknown) {
        tui.setProcessing(false);
        tui.setStreaming(false);
        const msg = err instanceof Error ? err.message : String(err);
        tui.logSystem(`${theme.error("✗")} Mission generation failed: ${msg}`);
        tui.requestRender();
      }
    },
    onCancel: () => {
      tui.hideOverlay();
      tui.logSystem(`${theme.warning("Mission cancelled")}`);
      tui.requestRender();
    },
  });
  tui.showOverlay(overlay);
}

/**
 * Show the mission preview in a viewer overlay with Execute/Edit/Save/Refine actions.
 */
async function showMissionPreview(
  missionData: MissionData,
  originalPrompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  // Format mission for display using the rich formatter.
  // formatMissionRich returns MissionSeg[][] — an array of lines, each line being an array of styled segments.
  // We flatten to plain text with chalk styling for the viewer.
  let content: string;
  try {
    const { formatMissionRich } = await import("../../llm/mission-generator.js");
    const richLines = formatMissionRich(missionData, process.stdout.columns ?? 80);
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
    content = JSON.stringify(missionData, null, 2);
  }

  const viewer = new ViewerOverlay({
    title: `Mission: ${missionData.name || "generated"}`,
    content,
    actions: [
      {
        label: "Execute",
        handler: () => {
          tui.hideOverlay();
          executeMission(missionData, originalPrompt, polpo, tui);
        },
      },
      {
        label: "Save draft",
        handler: () => {
          tui.hideOverlay();
          saveDraft(missionData, originalPrompt, polpo, tui);
        },
      },
      {
        label: "Edit JSON",
        handler: () => {
          tui.hideOverlay();
          const editor = new EditorOverlay({
            title: "Edit Mission JSON",
            initialText: JSON.stringify(missionData, null, 2),
            tui: tui.tuiInstance,
            onSave: (text) => {
              tui.hideOverlay();
              try {
                const edited = JSON.parse(text) as MissionData;
                if (edited?.tasks?.length) {
                  void showMissionPreview(edited, originalPrompt, polpo, tui);
                } else {
                  tui.logSystem(`${theme.error("Edited mission has no tasks")}`);
                  tui.requestRender();
                }
              } catch {
                tui.logSystem(`${theme.error("Invalid JSON in edited mission")}`);
                tui.requestRender();
              }
            },
            onCancel: () => void showMissionPreview(missionData, originalPrompt, polpo, tui),
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
                void showMissionPreview(missionData, originalPrompt, polpo, tui);
                return;
              }
              refineMission(missionData, originalPrompt, feedback.trim(), polpo, tui);
            },
            onCancel: () => void showMissionPreview(missionData, originalPrompt, polpo, tui),
          });
          tui.showOverlay(editor);
        },
      },
      {
        label: "Cancel",
        handler: () => {
          tui.hideOverlay();
          tui.logSystem(`${theme.warning("Mission cancelled")}`);
          tui.requestRender();
        },
      },
    ],
    onClose: () => {
      tui.hideOverlay();
      tui.logSystem(`${theme.warning("Mission cancelled")}`);
      tui.requestRender();
    },
  });
  tui.showOverlay(viewer);
}

function executeMission(
  missionData: MissionData,
  prompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  try {
    const json = JSON.stringify(missionData);
    const missionName = missionData.name ? slugify(missionData.name) : undefined;
    const mission = polpo.saveMission({ data: json, prompt, name: missionName });
    const result = polpo.executeMission(mission.id);
    tui.logSystem(
      `${theme.done("▶")} ${theme.bold(mission.name)} → ${theme.dim(`${result.tasks.length} tasks`)}`,
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
  missionData: MissionData,
  prompt: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  try {
    const json = JSON.stringify(missionData);
    const missionName = missionData.name ? slugify(missionData.name) : undefined;
    const mission = polpo.saveMission({ data: json, prompt, status: "draft", name: missionName });
    tui.logSystem(`${theme.done("■")} ${theme.bold(mission.name)} ${theme.dim("(draft)")}`);
    tui.requestRender();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Save error: ${msg}`);
    tui.requestRender();
  }
}

async function refineMission(
  currentMissionData: MissionData,
  originalPrompt: string,
  feedback: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  tui.setStreaming(true);
  tui.setProcessing(true, "Refining mission…");
  tui.requestRender();

  try {
    const { refineMissionStructured } = await import("../../llm/mission-generator.js");
    const { buildMissionSystemPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildMissionSystemPrompt(polpo, state, polpo.getWorkDir());
    const settings2 = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings2?.orchestratorModel);
    const currentJson = JSON.stringify(currentMissionData);

    const missionData = await refineMissionStructured(
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
    void showMissionPreview(missionData, originalPrompt, polpo, tui);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Refine error: ${msg}`);
    tui.requestRender();
  }
}
