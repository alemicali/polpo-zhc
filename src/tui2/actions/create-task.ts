/**
 * Task creation action — creates a task from user input.
 * If multiple agents available, shows a picker overlay.
 * Optionally enriches the task via LLM task-prep (controlled by config.taskPrep).
 *
 * Port of src/tui/actions/create-task.ts for the pi-tui imperative TUI2.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TaskExpectation } from "../../core/types.js";
import type { TUIContext } from "../types.js";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { PickerOverlay } from "../overlays/picker.js";

/**
 * Create a task from user input.
 * Resolves the target agent (mention, default, single, or picker) then
 * optionally enriches via LLM task-prep before creating the task.
 */
export function createTask(
  description: string,
  polpo: Orchestrator,
  tui: TUIContext,
  mentionedAgent?: string,
): void {
  const agents = polpo.getAgents();

  if (agents.length === 0) {
    tui.logSystem(`${theme.error("No agents configured.")} Use ${theme.info("/team")} to add agents.`);
    tui.requestRender();
    return;
  }

  // @agent mention overrides default
  if (mentionedAgent) {
    const found = agents.find((a) => a.name === mentionedAgent);
    if (found) {
      doCreate(description, found.name, polpo, tui);
      return;
    }
    tui.logSystem(`${theme.error("Agent not found:")} ${theme.info(`@${mentionedAgent}`)}`);
    tui.requestRender();
    return;
  }

  const defaultAgent = tui.defaultAgent;

  // Single agent or valid default → create immediately
  if (agents.length === 1) {
    doCreate(description, agents[0]!.name, polpo, tui);
    return;
  }

  if (defaultAgent && agents.find((a) => a.name === defaultAgent)) {
    doCreate(description, defaultAgent, polpo, tui);
    return;
  }

  // Multiple agents, no default → show picker overlay
  const picker = new PickerOverlay({
    title: "Assign task to agent",
    items: agents.map((a) => ({
      label: a.name,
      value: a.name,
      description: a.role ?? a.name,
    })),
    hint: "↑↓ navigate  Enter select  Esc cancel",
    onSelect: (item) => {
      tui.hideOverlay();
      doCreate(description, item.value, polpo, tui);
    },
    onCancel: () => {
      tui.hideOverlay();
      tui.logSystem("Task creation cancelled");
      tui.requestRender();
    },
  });
  tui.showOverlay(picker);
}

function doCreate(
  userInput: string,
  agentName: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  // Check if task-prep is enabled (default: true)
  const config = polpo.getConfig();
  const taskPrepEnabled = config?.settings && "taskPrep" in config.settings
    ? (config.settings as Record<string, unknown>).taskPrep !== false
    : true;

  if (taskPrepEnabled) {
    doCreateWithPrep(userInput, agentName, polpo, tui);
  } else {
    doCreateDirect(userInput, agentName, polpo, tui);
  }
}

function doCreateDirect(
  description: string,
  agentName: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  const title = description.length > 80
    ? description.slice(0, 77) + "..."
    : description;

  const task = polpo.addTask({
    title,
    description,
    assignTo: agentName,
  });

  tui.logSystem(`${theme.done("+")} ${theme.bold(task.title)} → ${theme.dim(agentName)}`);
  tui.requestRender();

  kickRun(polpo);
}

async function doCreateWithPrep(
  userInput: string,
  agentName: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  tui.setStreaming(true);
  tui.setProcessing(true, "Preparing task…");
  tui.requestRender();

  try {
    const { generateTaskPrep } = await import("../../llm/plan-generator.js");
    const { buildTaskPrepPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildTaskPrepPrompt(polpo, state, polpo.getWorkDir(), userInput, agentName);
    const settings = polpo.getConfig()?.settings;
    const model = resolveModelSpec(settings?.orchestratorModel);
    const prepTask = await generateTaskPrep(
      systemPrompt,
      userInput,
      model,
      (tokens) => tui.updateStreamingTokens(tokens),
      settings?.reasoning,
    );

    tui.setProcessing(false);
    tui.setStreaming(false);

    // Build expectations from validated data
    const expectations: TaskExpectation[] = [];
    if (prepTask.expectations) {
      for (const e of prepTask.expectations) {
        if (e.type === "test" && e.command) {
          expectations.push({ type: "test", command: e.command });
        } else if (e.type === "file_exists" && Array.isArray(e.paths) && e.paths.length > 0) {
          expectations.push({ type: "file_exists", paths: e.paths, confidence: "estimated" });
        } else if (e.type === "script" && e.command) {
          expectations.push({ type: "script", command: e.command });
        } else if (e.type === "llm_review" && (e.criteria || e.dimensions)) {
          expectations.push({
            type: "llm_review",
            criteria: e.criteria,
            dimensions: e.dimensions,
            threshold: e.threshold,
          });
        }
      }
    }

    const task = polpo.addTask({
      title: prepTask.title,
      description: prepTask.description || userInput,
      assignTo: agentName,
      expectations,
    });

    tui.logSystem(`${theme.done("+")} ${theme.bold(task.title)} → ${theme.dim(agentName)}`);

    if (expectations.length > 0) {
      const types = expectations.map((e) => e.type).join(", ");
      tui.logSystem(`  ${theme.dim("Expectations:")} ${theme.dim(types)}`);
    }

    tui.requestRender();
    kickRun(polpo);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    // Fallback to direct creation on any error
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.warning("Task prep failed:")} ${theme.dim(msg)}`);
    doCreateDirect(userInput, agentName, polpo, tui);
  }
}
