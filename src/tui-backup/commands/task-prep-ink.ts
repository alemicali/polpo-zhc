/**
 * Task Preparation for Ink TUI — uses store overlays instead of blessed widgets.
 * Same logic as task-prep.ts but compatible with the Ink overlay system.
 */

import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import type { CommandContext } from "../context.js";
import { querySDKText, extractYaml } from "../../llm/query.js";
import { buildTaskPrepPrompt } from "../../llm/prompts.js";
import { useTUIStore } from "../store.js";

// ─── Chalk Formatters ────────────────────────────────────

function formatTaskReadableChalk(task: any): string {
  const lines: string[] = [];
  lines.push(`  ${chalk.bold("Task prepared")}`);
  lines.push("");
  lines.push(`  ${chalk.bold(task.title)}`);

  const depParts: string[] = [];
  if (task.dependsOn?.length > 0) {
    depParts.push(`${chalk.gray("depends on:")} ${task.dependsOn.join(", ")}`);
  }
  const depStr = depParts.length > 0 ? `  ${depParts.join("  ")}` : "";
  lines.push(`    ${chalk.cyan("→")} ${chalk.cyan(task.assignTo || "default")}${depStr}`);

  if (task.description && task.description !== task.title) {
    const desc = task.description.length > 200
      ? task.description.slice(0, 197) + "..."
      : task.description;
    lines.push(`    ${chalk.gray(desc)}`);
  }

  if (task.expectations?.length > 0) {
    lines.push("");
    for (const e of task.expectations) {
      switch (e.type) {
        case "test":
          lines.push(`    ${chalk.green("☐")} test: ${e.command || ""}`);
          break;
        case "file_exists":
          lines.push(`    ${chalk.green("☐")} files: ${(e.paths || []).join(", ")}`);
          break;
        case "script":
          lines.push(`    ${chalk.green("☐")} script: ${(e.command || "").split("\n")[0]}`);
          break;
        case "llm_review":
          lines.push(`    ${chalk.green("☐")} review: ${(e.criteria || "").slice(0, 80)}`);
          break;
        default:
          lines.push(`    ${chalk.green("☐")} ${e.type}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatYamlColoredChalk(yaml: string): string {
  return yaml.split("\n").map(line => {
    if (line.match(/^\s*#/)) return chalk.gray(line);
    if (line.match(/^\s*-\s/)) {
      const m = line.match(/^(\s*-\s)(.*)$/);
      return m ? chalk.cyan(m[1]) + m[2] : line;
    }
    const kv = line.match(/^(\s*)(\w[\w\s]*?)(:)(.*)/);
    if (kv) {
      return `${kv[1]}${chalk.green(kv[2])}${chalk.white(kv[3])}${kv[4]}`;
    }
    return line;
  }).join("\n");
}

// ─── Entry Point ─────────────────────────────────────────

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
  const store = useTUIStore.getState();
  store.logAlways(input);
  store.logAlways("");
  ctx.setProcessing(true, "Preparing task");

  try {
    ctx.setProcessingDetail("Analyzing intent and project context");
    const yaml = await generateTaskSpec(ctx, input, assignTo);
    ctx.setProcessing(false);

    if (!yaml || !yaml.trim()) {
      store.logAlways(chalk.yellow("Task preparation returned empty result — creating directly"));
      fallbackDirectCreate(ctx, input, assignTo, group);
      return;
    }

    let doc: any;
    try {
      doc = parseYaml(yaml);
    } catch {
      store.logAlways(chalk.yellow("Invalid YAML from preparation — creating directly"));
      fallbackDirectCreate(ctx, input, assignTo, group);
      return;
    }

    if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
      store.logAlways(chalk.yellow("No task in preparation result — creating directly"));
      fallbackDirectCreate(ctx, input, assignTo, group);
      return;
    }

    showTaskPreview(ctx, yaml, doc, input, assignTo, group);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.yellow(`Task preparation failed: ${msg}`));
    store.logAlways(chalk.gray("Creating task directly..."));
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

// ─── Task Preview ────────────────────────────────────────

function showTaskPreview(
  ctx: CommandContext,
  yaml: string,
  doc: any,
  originalInput: string,
  assignTo: string,
  group?: string,
): void {
  const store = useTUIStore.getState();
  const task = doc.tasks[0];
  let viewMode: "readable" | "yaml" = "readable";

  store.openOverlay("content-viewer", {
    title: "Task Preview",
    content: formatTaskReadableChalk(task),
    actions: [
      `  ${chalk.green("✓")} Execute task`,
      `  ${chalk.yellow("✎")} Edit YAML`,
      `  ${chalk.cyan("↻")} Refine`,
      `  ${chalk.gray("⚡")} Quick run (skip prep)`,
    ],
    onAction: (index: number) => {
      store.closeOverlay();
      switch (index) {
        case 0:
          executeTaskFromYaml(ctx, doc, assignTo, group);
          break;
        case 1:
          handleEditYaml(ctx, yaml, originalInput, assignTo, group);
          break;
        case 2:
          handleRefine(ctx, yaml, originalInput, assignTo, group);
          break;
        case 3:
          fallbackDirectCreate(ctx, originalInput, assignTo, group);
          break;
      }
    },
    onTab: () => {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      return viewMode === "readable"
        ? formatTaskReadableChalk(task)
        : formatYamlColoredChalk(yaml);
    },
    onClose: () => {
      store.logAlways(chalk.yellow("Task cancelled"));
    },
  });
}

// ─── Edit YAML ───────────────────────────────────────────

function handleEditYaml(
  ctx: CommandContext,
  yaml: string,
  originalInput: string,
  assignTo: string,
  group?: string,
): void {
  const store = useTUIStore.getState();
  store.openOverlay("yaml-editor", {
    title: "Edit Task YAML",
    initial: yaml,
    onSave: (edited: string) => {
      try {
        const doc = parseYaml(edited);
        if (!doc?.tasks?.length) {
          store.logAlways(chalk.red("Edited YAML has no tasks"));
          showTaskPreview(ctx, yaml, parseYaml(yaml), originalInput, assignTo, group);
          return;
        }
        showTaskPreview(ctx, edited, doc, originalInput, assignTo, group);
      } catch {
        store.logAlways(chalk.red("Edited YAML is invalid — reverting"));
        showTaskPreview(ctx, yaml, parseYaml(yaml), originalInput, assignTo, group);
      }
    },
    onCancel: () => {
      try {
        showTaskPreview(ctx, yaml, parseYaml(yaml), originalInput, assignTo, group);
      } catch {
        store.logAlways(chalk.yellow("Task cancelled"));
      }
    },
  });
}

// ─── Refine ──────────────────────────────────────────────

function handleRefine(
  ctx: CommandContext,
  currentYaml: string,
  originalInput: string,
  assignTo: string,
  group?: string,
): void {
  const store = useTUIStore.getState();
  store.openOverlay("text-input", {
    title: "Refine — What should change?",
    onSubmit: async (feedback: string) => {
      if (!feedback?.trim()) {
        try {
          showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
        } catch {
          store.logAlways(chalk.yellow("Task cancelled"));
        }
        return;
      }

      store.logAlways(`${chalk.cyan("↻")} Refining: ${feedback}`);
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
          store.logAlways(chalk.red("Refined spec has no tasks — keeping original"));
          showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
          return;
        }
        showTaskPreview(ctx, newYaml, doc, originalInput, assignTo, group);
      } catch (err: unknown) {
        ctx.setProcessing(false);
        const msg = err instanceof Error ? err.message : String(err);
        store.logAlways(chalk.red(`Refine failed: ${msg}`));
        try {
          showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
        } catch {
          store.logAlways(chalk.yellow("Task cancelled"));
        }
      }
    },
    onCancel: () => {
      try {
        showTaskPreview(ctx, currentYaml, parseYaml(currentYaml), originalInput, assignTo, group);
      } catch {
        store.logAlways(chalk.yellow("Task cancelled"));
      }
    },
  });
}

// ─── Execute ─────────────────────────────────────────────

function executeTaskFromYaml(
  ctx: CommandContext,
  doc: any,
  defaultAssignTo: string,
  group?: string,
): void {
  const store = useTUIStore.getState();
  const t = doc.tasks[0];
  try {
    const task = ctx.orchestrator.addTask({
      title: t.title || "Untitled",
      description: t.description || t.title || "",
      assignTo: t.assignTo || defaultAssignTo,
      expectations: t.expectations || [],
      group,
    });
    const groupInfo = group ? ` ${chalk.cyan(`[${group}]`)}` : "";
    const expCount = (t.expectations || []).length;
    store.logAlways(`${chalk.green("Task created:")} ${task.title} ${chalk.gray(`[${task.id}] → ${task.assignTo}`)}${groupInfo}`);
    if (expCount > 0) {
      store.logAlways(`  ${chalk.gray(`${expCount} expectation(s) configured`)}`);
    }
    store.logAlways(chalk.gray("Agent will pick it up shortly..."));
    store.logAlways("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Failed to create task: ${msg}`));
  }
}

/** Fallback: create task directly without LLM preparation */
export function fallbackDirectCreate(
  ctx: CommandContext,
  input: string,
  assignTo: string,
  group?: string,
): void {
  const store = useTUIStore.getState();
  try {
    const title = input.length > 60 ? input.slice(0, 57) + "..." : input;
    const task = ctx.orchestrator.addTask({
      title,
      description: input,
      assignTo,
      group,
    });
    const groupInfo = group ? ` ${chalk.cyan(`[${group}]`)}` : "";
    store.logAlways(`${chalk.green("Task created:")} ${task.title} ${chalk.gray(`[${task.id}] → ${assignTo}`)}${groupInfo}`);
    store.logAlways(chalk.gray("Agent will pick it up shortly..."));
    store.logAlways("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Failed to create task: ${msg}`));
  }
}
