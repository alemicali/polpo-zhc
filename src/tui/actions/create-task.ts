/**
 * Task creation action — creates a task from user input.
 * If multiple agents available, shows picker first.
 * Optionally enriches task via LLM task-prep (controlled by config.taskPrep).
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import type { TaskExpectation } from "../../core/types.js";
import { seg, kickRun } from "../format.js";
import { generateTaskPrep } from "../../llm/plan-generator.js";
import { buildTaskPrepPrompt } from "../../llm/prompts.js";

export function createTask(
  description: string,
  polpo: Orchestrator,
  store: TUIStore,
  mentionedAgent?: string,
): void {
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

  // @agent mention overrides default
  if (mentionedAgent) {
    const found = agents.find((a) => a.name === mentionedAgent);
    if (found) {
      doCreate(description, found.name, polpo, store);
      return;
    }
    store.log(`Agent not found: @${mentionedAgent}`, [
      seg(`Agent not found: `, "red"),
      seg(`@${mentionedAgent}`, "cyan"),
    ]);
    return;
  }

  const defaultAgent = store.defaultAgent;

  // Single agent or valid default → create immediately
  if (agents.length === 1) {
    doCreate(description, agents[0]!.name, polpo, store);
    return;
  }

  if (defaultAgent && agents.find((a) => a.name === defaultAgent)) {
    doCreate(description, defaultAgent, polpo, store);
    return;
  }

  // Multiple agents, no default → show picker
  store.navigate({
    id: "picker",
    title: "Assign task to agent",
    items: agents.map((a) => ({
      label: a.name,
      value: a.name,
      description: a.role ?? a.name,
    })),
    hint: "↑↓ navigate  Enter select  Esc cancel  d = set default",
    onSelect: (_idx, value) => {
      store.goMain();
      doCreate(description, value, polpo, store);
    },
    onCancel: () => {
      store.goMain();
      store.log("Task creation cancelled", [seg("Task creation cancelled", "gray")]);
    },
    onKey: (input, _idx, value) => {
      if (input === "d") {
        store.setDefaultAgent(value);
        store.log(`Default agent set to ${value}`, [
          seg("Default agent: ", "gray"),
          seg(value, "cyan", true),
        ]);
      }
    },
  });
}

function doCreate(
  userInput: string,
  agentName: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  // Check if task-prep is enabled (default: true)
  const config = polpo.getConfig();
  const taskPrepEnabled = config?.settings && "taskPrep" in config.settings
    ? (config.settings as Record<string, unknown>).taskPrep !== false
    : true;

  if (taskPrepEnabled && agentName) {
    doCreateWithPrep(userInput, agentName, polpo, store);
  } else {
    doCreateDirect(userInput, agentName, polpo, store);
  }
}

function doCreateDirect(
  description: string,
  agentName: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  const title = description.length > 80
    ? description.slice(0, 77) + "..."
    : description;

  const task = polpo.addTask({
    title,
    description,
    assignTo: agentName,
  });

  store.log(`Task created: ${task.title}`, [
    seg("+ ", "green"),
    seg(task.title, undefined, true),
    seg(` → ${agentName}`, "gray"),
  ]);

  kickRun(polpo, store);
}

async function doCreateWithPrep(
  userInput: string,
  agentName: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  store.startStreaming();
  store.setProcessing(true, "Preparing task...");

  try {
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildTaskPrepPrompt(polpo, state, polpo.getWorkDir(), userInput, agentName);
    const model = polpo.getConfig()?.settings?.orchestratorModel;
    const prepTask = await generateTaskPrep(
      systemPrompt,
      userInput,
      model,
      (tokens) => store.updateProcessingTokens(tokens),
    );

    store.setProcessing(false);
    store.stopStreaming();

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

    store.log(`Task prepared: ${task.title}`, [
      seg("+ ", "green"),
      seg(task.title, undefined, true),
      seg(` → ${agentName}`, "gray"),
    ]);

    if (expectations.length > 0) {
      const types = expectations.map((e) => e.type).join(", ");
      store.log(`  Expectations: ${types}`, [
        seg("  Expectations: ", "gray"),
        seg(types, "gray", false, true),
      ]);
    }

    kickRun(polpo, store);
  } catch (err: unknown) {
    store.setProcessing(false);
    store.stopStreaming();
    // Fallback to direct creation on any error
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Task prep failed, creating directly: ${msg}`, [
      seg("Task prep failed: ", "yellow"),
      seg(msg, "gray", false, true),
    ]);
    doCreateDirect(userInput, agentName, polpo, store);
  }
}
