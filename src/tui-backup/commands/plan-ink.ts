/**
 * Plan mode for Ink TUI — uses store overlays instead of blessed widgets.
 * Same logic as plan.ts but compatible with the Ink overlay system.
 */

import chalk from "chalk";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CommandContext } from "../context.js";
import { querySDKText, extractYaml } from "../../llm/query.js";
import { buildPlanSystemPrompt, buildTaskPrepPrompt } from "../../llm/prompts.js";
import { useTUIStore } from "../store.js";
import { MODELS } from "../constants.js";

// ─── Helpers ─────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "plan";
}

function extractPlanName(yaml: string): string | undefined {
  try {
    const doc = parseYaml(yaml);
    if (doc?.name && typeof doc.name === "string") return slugify(doc.name);
  } catch { /* ignore */ }
  return undefined;
}

// ─── Chalk Formatters ────────────────────────────────────

function formatPlanReadableChalk(doc: any): string {
  const tasks = doc.tasks || [];
  const volatileTeam = doc.team as any[] | undefined;
  const lines: string[] = [];
  const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

  if (volatileTeam && volatileTeam.length > 0) {
    lines.push(`  ${chalk.bold.yellow("Volatile team")}  ${chalk.gray("(agents created for this plan only)")}`);
    lines.push("");
    for (const a of volatileTeam) {
      const modelLabel = a.model
        ? MODELS.find((m) => m.value === a.model)?.label ?? a.model
        : "";
      lines.push(`    ${chalk.cyan(a.name)}  ${a.adapter || "claude-sdk"}  ${chalk.gray(modelLabel)}`);
      if (a.role) lines.push(`      ${chalk.gray(a.role)}`);
      if (a.skills?.length) lines.push(`      ${chalk.yellow("⚡")} ${chalk.yellow(a.skills.join(", "))}`);
    }
    lines.push("");
    lines.push("  ───────────────────────────────");
    lines.push("");
  }

  lines.push(`  ${chalk.bold(`${tasks.length} task${tasks.length !== 1 ? "s" : ""}`)} in plan`);
  lines.push("");

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const num = circled[i] ?? `(${i + 1})`;

    lines.push(`  ${chalk.bold(`${num} ${t.title}`)}`);

    const depParts: string[] = [];
    if (t.dependsOn?.length > 0) {
      const depNums = t.dependsOn.map((dep: string) => {
        const idx = tasks.findIndex((tt: any) => tt.title === dep);
        return idx >= 0 ? (circled[idx] ?? `#${idx + 1}`) : dep;
      });
      depParts.push(`⟵ ${depNums.join(", ")}`);
    }
    const depStr = depParts.length > 0 ? `  ${chalk.gray(depParts.join("  "))}` : "";
    lines.push(`    ${chalk.cyan("→")} ${chalk.cyan(t.assignTo || "default")}${depStr}`);

    if (t.description && t.description !== t.title) {
      const desc = t.description.length > 120
        ? t.description.slice(0, 117) + "..."
        : t.description;
      lines.push(`    ${chalk.gray(desc)}`);
    }

    if (t.expectations?.length > 0) {
      const exps = t.expectations.map((e: any) => {
        switch (e.type) {
          case "test": return `${chalk.green("☐")} test: ${e.command || ""}`;
          case "file_exists": return `${chalk.green("☐")} files: ${(e.paths || []).join(", ")}`;
          case "script": return `${chalk.green("☐")} script: ${(e.command || "").split("\n")[0]}`;
          case "llm_review": return `${chalk.green("☐")} review: ${(e.criteria || "").slice(0, 80)}`;
          default: return `${chalk.green("☐")} ${e.type}`;
        }
      });
      lines.push(`    ${exps.join("  ")}`);
    }

    lines.push("");
  }

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

export async function handlePlanInput(ctx: CommandContext, input: string): Promise<void> {
  const store = useTUIStore.getState();
  store.logAlways(input);
  store.logAlways("");
  ctx.setProcessing(true, "Generating plan");

  try {
    const yaml = await generatePlan(ctx, input);
    ctx.setProcessing(false);

    if (!yaml || !yaml.trim()) {
      store.logAlways(chalk.red("Plan generation returned empty result"));
      return;
    }

    try {
      const doc = parseYaml(yaml);
      if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
        store.logAlways(chalk.red("Plan has no tasks. Try a more specific prompt."));
        return;
      }
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      store.logAlways(chalk.red(`Invalid YAML in plan: ${msg}`));
      store.logAlways(chalk.gray("Raw output:"));
      for (const line of yaml.split("\n").slice(0, 10)) {
        store.logAlways(`  ${line}`);
      }
      return;
    }

    showPlanPreview(ctx, yaml, input);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Plan generation failed: ${msg}`));
  }
}

async function generatePlan(ctx: CommandContext, input: string): Promise<string> {
  ctx.loadState();
  const prompt = [
    buildPlanSystemPrompt(ctx.orchestrator, ctx.getState(), ctx.workDir),
    ``,
    `---`,
    ``,
    `Generate a task plan for:`,
    `"${input}"`,
  ].join("\n");

  const resultText = await querySDKText(prompt, ctx.workDir, ctx.orchestrator.getConfig()?.settings.orchestratorModel);
  return extractYaml(resultText);
}

// ─── Plan Preview ────────────────────────────────────────

export function showPlanPreview(
  ctx: CommandContext,
  yaml: string,
  originalInput: string,
  existingPlanId?: string,
): void {
  const store = useTUIStore.getState();

  let doc: any;
  try {
    doc = parseYaml(yaml);
    if (!doc?.tasks?.length) {
      store.logAlways(chalk.red("Invalid plan: no tasks found"));
      return;
    }
  } catch {
    store.logAlways(chalk.red("Invalid YAML in plan"));
    return;
  }

  let viewMode: "readable" | "yaml" = "readable";

  store.openOverlay("content-viewer", {
    title: "Plan Preview",
    content: formatPlanReadableChalk(doc),
    actions: [
      `  ${chalk.green("✓")} Execute plan`,
      `  ${chalk.green("✓")}${chalk.yellow("⚡")} Execute with task prep`,
      `  ${chalk.blue("■")} Save as draft`,
      `  ${chalk.yellow("✎")} Edit YAML`,
      `  ${chalk.cyan("↻")} Refine with feedback`,
    ],
    onAction: (index: number) => {
      store.closeOverlay();
      switch (index) {
        case 0: // Execute as-is
          if (existingPlanId) {
            ctx.orchestrator.updatePlan(existingPlanId, { yaml });
            executeSavedPlan(ctx, existingPlanId);
          } else {
            executeNewPlan(ctx, yaml, originalInput);
          }
          break;
        case 1: // Execute with task prep
          executeWithPrep(ctx, yaml, doc, originalInput, existingPlanId);
          break;
        case 2: // Save draft
          if (existingPlanId) {
            ctx.orchestrator.updatePlan(existingPlanId, { yaml });
            store.logAlways(chalk.blue("Draft updated"));
          } else {
            saveDraft(ctx, yaml, originalInput);
          }
          break;
        case 3: // Edit YAML
          showYamlEditor(ctx, yaml, originalInput, existingPlanId);
          break;
        case 4: // Refine
          showRefineInput(ctx, yaml, originalInput);
          break;
      }
    },
    onTab: () => {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      return viewMode === "readable"
        ? formatPlanReadableChalk(doc)
        : formatYamlColoredChalk(yaml);
    },
    onClose: () => {
      store.logAlways(chalk.yellow("Plan cancelled"));
    },
  });
}

// ─── YAML Editor ─────────────────────────────────────────

function showYamlEditor(
  ctx: CommandContext,
  yaml: string,
  originalInput: string,
  existingPlanId?: string,
): void {
  const store = useTUIStore.getState();
  store.openOverlay("yaml-editor", {
    title: "Edit Plan (Ctrl+S save, Escape cancel)",
    initial: yaml,
    onSave: (editedYaml: string) => {
      showPlanPreview(ctx, editedYaml, originalInput, existingPlanId);
    },
    onCancel: () => {
      showPlanPreview(ctx, yaml, originalInput, existingPlanId);
    },
  });
}

// ─── Refine ──────────────────────────────────────────────

function showRefineInput(
  ctx: CommandContext,
  yaml: string,
  originalInput: string,
): void {
  const store = useTUIStore.getState();
  store.openOverlay("text-input", {
    title: "Refine — What should be changed?",
    onSubmit: async (feedback: string) => {
      if (!feedback?.trim()) {
        showPlanPreview(ctx, yaml, originalInput);
        return;
      }
      await handleRefine(ctx, yaml, originalInput, feedback.trim());
    },
    onCancel: () => {
      showPlanPreview(ctx, yaml, originalInput);
    },
  });
}

async function handleRefine(
  ctx: CommandContext,
  currentYaml: string,
  originalInput: string,
  feedback: string,
): Promise<void> {
  const store = useTUIStore.getState();
  store.logAlways(`${chalk.cyan("↻")} Refining: ${feedback}`);
  store.logAlways("");
  ctx.setProcessing(true, "Refining plan");

  try {
    const newYaml = await generatePlanWithFeedback(ctx, originalInput, currentYaml, feedback);
    ctx.setProcessing(false);

    if (!newYaml?.trim()) {
      store.logAlways(chalk.red("Refine returned empty result"));
      showPlanPreview(ctx, currentYaml, originalInput);
      return;
    }

    try {
      const doc = parseYaml(newYaml);
      if (!doc?.tasks?.length) {
        store.logAlways(chalk.red("Refined plan has no tasks"));
        showPlanPreview(ctx, currentYaml, originalInput);
        return;
      }
    } catch {
      store.logAlways(chalk.red("Refined plan has invalid YAML"));
      showPlanPreview(ctx, currentYaml, originalInput);
      return;
    }

    showPlanPreview(ctx, newYaml, originalInput);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Refine failed: ${msg}`));
  }
}

async function generatePlanWithFeedback(
  ctx: CommandContext,
  originalInput: string,
  currentYaml: string,
  feedback: string,
): Promise<string> {
  ctx.loadState();
  const prompt = [
    buildPlanSystemPrompt(ctx.orchestrator, ctx.getState(), ctx.workDir),
    ``,
    `---`,
    ``,
    `Original request: "${originalInput}"`,
    ``,
    `Current plan:`,
    currentYaml,
    ``,
    `User feedback: "${feedback}"`,
    ``,
    `Revise the plan based on the feedback. Output ONLY valid YAML.`,
  ].join("\n");

  const resultText = await querySDKText(prompt, ctx.workDir, ctx.orchestrator.getConfig()?.settings.orchestratorModel);
  return extractYaml(resultText);
}

// ─── Execution ───────────────────────────────────────────

function saveDraft(ctx: CommandContext, yaml: string, prompt: string): void {
  const store = useTUIStore.getState();
  try {
    const plan = ctx.orchestrator.savePlan({ yaml, prompt, status: "draft", name: extractPlanName(yaml) });
    store.logAlways(`${chalk.blue("■")} Draft saved: ${chalk.bold(plan.name)}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Failed to save draft: ${msg}`));
  }
}

/**
 * Execute plan with LLM task preparation: enrich each task with detailed
 * descriptions and expectations before creating them.
 */
async function executeWithPrep(
  ctx: CommandContext,
  yaml: string,
  doc: any,
  originalInput: string,
  existingPlanId?: string,
): Promise<void> {
  const store = useTUIStore.getState();
  const tasks = doc.tasks as any[];
  ctx.setProcessing(true, "Preparing tasks");

  try {
    ctx.loadState();
    const enrichedTasks: any[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      ctx.setProcessingDetail(`Task ${i + 1}/${tasks.length}: ${t.title}`);

      try {
        const prompt = buildTaskPrepPrompt(
          ctx.orchestrator,
          ctx.getState(),
          ctx.workDir,
          `${t.title}\n\n${t.description || t.title}`,
          t.assignTo || ctx.orchestrator.getAgents()[0]?.name || "default",
        );
        const resultText = await querySDKText(prompt, ctx.workDir, ctx.orchestrator.getConfig()?.settings.orchestratorModel);
        const prepYaml = extractYaml(resultText);
        const prepDoc = parseYaml(prepYaml);

        if (prepDoc?.tasks?.[0]) {
          const enriched = prepDoc.tasks[0];
          enrichedTasks.push({
            ...t,
            description: enriched.description || t.description || t.title,
            expectations: enriched.expectations || t.expectations || [],
          });
        } else {
          enrichedTasks.push(t);
        }
      } catch {
        enrichedTasks.push(t);
      }
    }

    ctx.setProcessing(false);

    const enrichedDoc = { ...doc, tasks: enrichedTasks };
    const enrichedYaml = stringifyYaml(enrichedDoc);

    store.logAlways(`${chalk.green("✓")} ${enrichedTasks.length} task(s) prepared`);
    showPlanPreview(ctx, enrichedYaml, originalInput, existingPlanId);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Task preparation failed: ${msg}`));
    showPlanPreview(ctx, yaml, originalInput, existingPlanId);
  }
}

function executeNewPlan(ctx: CommandContext, yaml: string, prompt: string): void {
  const store = useTUIStore.getState();
  try {
    const plan = ctx.orchestrator.savePlan({ yaml, prompt, name: extractPlanName(yaml) });
    const { tasks, group } = ctx.orchestrator.executePlan(plan.id);
    store.logAlways(`${chalk.green("Plan executed:")} ${tasks.length} task${tasks.length !== 1 ? "s" : ""} created ${chalk.gray(`(${group})`)}`);
    store.logEvent(`  ${chalk.green("▸")} ${chalk.bold("Plan started")} — ${tasks.length} tasks ${chalk.gray(`(${group})`)}`, [
      { text: "  " },
      { text: "▸", color: "green" },
      { text: " Plan started", bold: true },
      { text: ` — ${tasks.length} tasks`, color: "gray" },
      { text: ` (${group})`, color: "gray" },
    ]);
    store.logAlways(chalk.gray("Supervisor will start picking them up..."));
    store.logAlways("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Failed to execute plan: ${msg}`));
  }
}

export function executeSavedPlan(ctx: CommandContext, planId: string): void {
  const store = useTUIStore.getState();
  try {
    const { tasks, group } = ctx.orchestrator.executePlan(planId);
    store.logAlways(`${chalk.green("Plan executed:")} ${tasks.length} task${tasks.length !== 1 ? "s" : ""} created ${chalk.gray(`(${group})`)}`);
    store.logEvent(`  ${chalk.green("▸")} ${chalk.bold("Plan started")} — ${tasks.length} tasks ${chalk.gray(`(${group})`)}`, [
      { text: "  " },
      { text: "▸", color: "green" },
      { text: " Plan started", bold: true },
      { text: ` — ${tasks.length} tasks`, color: "gray" },
      { text: ` (${group})`, color: "gray" },
    ]);
    store.logAlways(chalk.gray("Supervisor will start picking them up..."));
    store.logAlways("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Failed to execute plan: ${msg}`));
  }
}
