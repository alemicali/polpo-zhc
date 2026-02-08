/**
 * Task Preparation: LLM-powered single-task structuring.
 * Generates a 1-task YAML spec with expectations, shows preview, then executes.
 */

import { parse as parseYaml } from "yaml";
import type { CommandContext } from "../context.js";
import { querySDKText, extractYaml } from "../../llm/query.js";
import { buildTaskPrepPrompt } from "../../llm/prompts.js";
import { formatTaskReadable, formatYamlColored, fmtUserMsg } from "../formatters.js";
import { showContentViewer, showTextarea, showTextInput } from "../widgets.js";

/**
 * Entry point: prepare a single task via LLM before creating it.
 * Falls back to direct creation on any error.
 */
export async function prepareTask(
  ctx: CommandContext,
  input: string,
  assignTo: string,
  group?: string,
): Promise<void> {
  ctx.logAlways(fmtUserMsg(input));
  ctx.logAlways("");
  ctx.setProcessing(true, "Preparing task");

  try {
    ctx.setProcessingDetail("Analyzing intent and project context");
    const yaml = await generateTaskSpec(ctx, input, assignTo);
    ctx.setProcessing(false);

    if (!yaml || !yaml.trim()) {
      ctx.logAlways("{yellow-fg}Task preparation returned empty result — creating directly{/yellow-fg}");
      fallbackDirectCreate(ctx, input, assignTo, group);
      return;
    }

    // Validate YAML
    let doc: any;
    try {
      doc = parseYaml(yaml);
    } catch {
      ctx.logAlways("{yellow-fg}Invalid YAML from preparation — creating directly{/yellow-fg}");
      fallbackDirectCreate(ctx, input, assignTo, group);
      return;
    }

    if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
      ctx.logAlways("{yellow-fg}No task in preparation result — creating directly{/yellow-fg}");
      fallbackDirectCreate(ctx, input, assignTo, group);
      return;
    }

    showTaskPreview(ctx, yaml, doc, input, assignTo, group);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logAlways(`{yellow-fg}Task preparation failed: ${msg}{/yellow-fg}`);
    ctx.logAlways("{grey-fg}Creating task directly...{/grey-fg}");
    fallbackDirectCreate(ctx, input, assignTo, group);
  }
}

/** Call LLM to generate a 1-task YAML spec */
async function generateTaskSpec(
  ctx: CommandContext,
  input: string,
  assignTo: string,
): Promise<string> {
  ctx.loadState();
  const prompt = buildTaskPrepPrompt(
    ctx.orchestrator,
    ctx.getState(),
    ctx.workDir,
    input,
    assignTo,
  );
  const model = ctx.orchestrator.getConfig()?.settings?.orchestratorModel;
  const resultText = await querySDKText(prompt, ctx.workDir, model);
  return extractYaml(resultText);
}

/** Show task preview overlay with actions */
async function showTaskPreview(
  ctx: CommandContext,
  yaml: string,
  doc: any,
  originalInput: string,
  assignTo: string,
  group?: string,
): Promise<void> {
  const task = doc.tasks[0];
  let viewMode: "readable" | "yaml" = "readable";
  const readableContent = formatTaskReadable(task);
  const yamlContent = formatYamlColored(yaml);

  const actionIdx = await showContentViewer(ctx, {
    title: "{bold}Task Preview{/bold}",
    content: readableContent,
    actions: [
      "  {green-fg}✓{/green-fg} Execute task",
      "  {yellow-fg}✎{/yellow-fg} Edit YAML",
      "  {cyan-fg}↻{/cyan-fg} Refine",
      "  {grey-fg}⚡{/grey-fg} Quick run (skip prep)",
    ],
    hint: " {cyan-fg}Tab{/cyan-fg} {grey-fg}toggle view{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}actions{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
    onTab: () => {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      return viewMode === "readable" ? readableContent : yamlContent;
    },
  });

  switch (actionIdx) {
    case 0: // Execute
      executeTaskFromYaml(ctx, doc, assignTo, group);
      break;
    case 1: // Edit YAML
      await handleEditYaml(ctx, yaml, originalInput, assignTo, group);
      break;
    case 2: // Refine
      await handleRefine(ctx, yaml, originalInput, assignTo, group);
      break;
    case 3: // Quick run
      fallbackDirectCreate(ctx, originalInput, assignTo, group);
      break;
    default: // Escape
      ctx.logAlways("{yellow-fg}Task cancelled{/yellow-fg}");
      break;
  }
}

/** Edit YAML in textarea, then re-preview */
async function handleEditYaml(
  ctx: CommandContext,
  yaml: string,
  originalInput: string,
  assignTo: string,
  group?: string,
): Promise<void> {
  const edited = await showTextarea(ctx, {
    title: "{yellow-fg}✎{/yellow-fg} {bold}Edit Task YAML{/bold}",
    initial: yaml,
    borderColor: "yellow",
  });

  if (edited === null) {
    // Cancelled — back to original preview
    try {
      const doc = parseYaml(yaml);
      showTaskPreview(ctx, yaml, doc, originalInput, assignTo, group);
    } catch {
      ctx.logAlways("{yellow-fg}Task cancelled{/yellow-fg}");
    }
    return;
  }

  // Validate edited YAML
  try {
    const doc = parseYaml(edited);
    if (!doc?.tasks?.length) {
      ctx.logAlways("{red-fg}Edited YAML has no tasks{/red-fg}");
      showTaskPreview(ctx, yaml, parseYaml(yaml), originalInput, assignTo, group);
      return;
    }
    showTaskPreview(ctx, edited, doc, originalInput, assignTo, group);
  } catch {
    ctx.logAlways("{red-fg}Edited YAML is invalid — reverting{/red-fg}");
    showTaskPreview(ctx, yaml, parseYaml(yaml), originalInput, assignTo, group);
  }
}

/** Refine via feedback → regenerate → re-preview */
async function handleRefine(
  ctx: CommandContext,
  currentYaml: string,
  originalInput: string,
  assignTo: string,
  group?: string,
): Promise<void> {
  const feedback = await showTextInput(ctx, {
    title: "{cyan-fg}↻{/cyan-fg} {bold}Refine{/bold} — What should change?",
    hint: " {cyan-fg}Enter{/cyan-fg} {grey-fg}submit{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
  });

  if (!feedback) {
    // Cancelled — back to current preview
    try {
      showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
    } catch {
      ctx.logAlways("{yellow-fg}Task cancelled{/yellow-fg}");
    }
    return;
  }

  ctx.logAlways(`{cyan-fg}↻{/cyan-fg} Refining: ${feedback}`);
  ctx.setProcessing(true, "Refining task");

  try {
    ctx.loadState();
    const prompt = [
      buildTaskPrepPrompt(ctx.orchestrator, ctx.getState(), ctx.workDir, originalInput, assignTo),
      ``,
      `Current task spec:`,
      currentYaml,
      ``,
      `User feedback: "${feedback}"`,
      ``,
      `Revise the task spec based on the feedback. Output ONLY valid YAML.`,
    ].join("\n");

    const model = ctx.orchestrator.getConfig()?.settings?.orchestratorModel;
    const resultText = await querySDKText(prompt, ctx.workDir, model);
    ctx.setProcessing(false);
    const newYaml = extractYaml(resultText);

    const doc = parseYaml(newYaml);
    if (!doc?.tasks?.length) {
      ctx.logAlways("{red-fg}Refined spec has no tasks — keeping original{/red-fg}");
      showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
      return;
    }

    showTaskPreview(ctx, newYaml, doc, originalInput, assignTo, group);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logAlways(`{red-fg}Refine failed: ${msg}{/red-fg}`);
    try {
      showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
    } catch {
      ctx.logAlways("{yellow-fg}Task cancelled{/yellow-fg}");
    }
  }
}

/** Create task from validated YAML doc */
function executeTaskFromYaml(
  ctx: CommandContext,
  doc: any,
  defaultAssignTo: string,
  group?: string,
): void {
  const t = doc.tasks[0];
  try {
    const task = ctx.orchestrator.addTask({
      title: t.title || "Untitled",
      description: t.description || t.title || "",
      assignTo: t.assignTo || defaultAssignTo,
      expectations: t.expectations || [],
      group,
    });
    const groupInfo = group ? ` {cyan-fg}[${group}]{/cyan-fg}` : "";
    const expCount = (t.expectations || []).length;
    ctx.logAlways(`{green-fg}Task created:{/green-fg} ${task.title} {grey-fg}[${task.id}] → ${task.assignTo}{/grey-fg}${groupInfo}`);
    if (expCount > 0) {
      ctx.logAlways(`  {grey-fg}${expCount} expectation(s) configured{/grey-fg}`);
    }
    ctx.logAlways("{grey-fg}Agent will pick it up shortly...{/grey-fg}");
    ctx.logAlways("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logAlways(`{red-fg}Failed to create task: ${msg}{/red-fg}`);
  }
}

/** Fallback: create task directly without LLM preparation */
export function fallbackDirectCreate(
  ctx: CommandContext,
  input: string,
  assignTo: string,
  group?: string,
): void {
  try {
    const title = input.length > 60 ? input.slice(0, 57) + "..." : input;
    const task = ctx.orchestrator.addTask({
      title,
      description: input,
      assignTo,
      group,
    });
    const groupInfo = group ? ` {cyan-fg}[${group}]{/cyan-fg}` : "";
    ctx.logAlways(`{green-fg}Task created:{/green-fg} ${task.title} {grey-fg}[${task.id}] → ${assignTo}{/grey-fg}${groupInfo}`);
    ctx.logAlways("{grey-fg}Agent will pick it up shortly...{/grey-fg}");
    ctx.logAlways("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logAlways(`{red-fg}Failed to create task: ${msg}{/red-fg}`);
  }
}
