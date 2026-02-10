/**
 * Plan mode: generate, preview, edit, refine, execute YAML plans.
 */

import blessed from "blessed";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CommandContext } from "../context.js";
import { querySDKText, extractYaml } from "../../llm/query.js";
import { buildPlanSystemPrompt, buildTaskPrepPrompt } from "../../llm/prompts.js";
import { formatYamlColored, formatPlanReadable, fmtUserMsg } from "../formatters.js";
import { createOverlay, addHintBar } from "../widgets.js";

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

export async function handlePlanInput(ctx: CommandContext, input: string): Promise<void> {
  ctx.logAlways(fmtUserMsg(input));
  ctx.logAlways("");
  ctx.setProcessing(true, "Generating plan");

  try {
    const yaml = await generatePlan(ctx, input);
    ctx.setProcessing(false);

    if (!yaml || !yaml.trim()) {
      ctx.log("{red-fg}Plan generation returned empty result{/red-fg}");
      return;
    }

    try {
      const doc = parseYaml(yaml);
      if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
        ctx.log("{red-fg}Plan has no tasks. Try a more specific prompt.{/red-fg}");
        return;
      }
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      ctx.log(`{red-fg}Invalid YAML in plan: ${msg}{/red-fg}`);
      ctx.log("{grey-fg}Raw output:{/grey-fg}");
      for (const line of yaml.split("\n").slice(0, 10)) {
        ctx.log(`  ${line}`);
      }
      return;
    }

    showPlanPreview(ctx, yaml, input);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Plan generation failed: ${msg}{/red-fg}`);
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

export function showPlanPreview(ctx: CommandContext, yaml: string, originalInput: string, existingPlanId?: string): void {
  let doc: any;
  try {
    doc = parseYaml(yaml);
    if (!doc?.tasks?.length) {
      ctx.log("{red-fg}Invalid plan: no tasks found{/red-fg}");
      return;
    }
  } catch {
    ctx.log("{red-fg}Invalid YAML in plan{/red-fg}");
    return;
  }

  let viewMode: "readable" | "yaml" = "readable";
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const contentBox = blessed.box({
    parent: overlay,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-8",
    border: { type: "line" },
    tags: true,
    label: " {bold}Plan Preview{/bold} ",
    scrollable: true,
    keys: true,
    vi: true,
    mouse: true,
    style: { bg: "black", border: { fg: "cyan" } },
  });

  const actionItems = [
    "  {green-fg}✓{/green-fg} Execute plan",
    "  {green-fg}✓{/green-fg}{yellow-fg}⚡{/yellow-fg} Execute with task prep",
    "  {blue-fg}■{/blue-fg} Save as draft",
    "  {yellow-fg}✎{/yellow-fg} Edit YAML",
    "  {cyan-fg}↻{/cyan-fg} Refine with feedback",
  ];
  const actionList = blessed.list({
    parent: overlay,
    bottom: 1,
    left: "center",
    width: 36,
    height: actionItems.length + 2,
    items: actionItems,
    tags: true,
    border: { type: "line" },
    style: {
      bg: "black",
      border: { fg: "grey" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Tab{/cyan-fg} {grey-fg}toggle view{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}actions{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  const renderContent = () => {
    if (viewMode === "readable") {
      contentBox.setContent(formatPlanReadable(doc));
      (contentBox as any).setLabel(" {bold}Plan Preview{/bold} ");
    } else {
      contentBox.setContent(formatYamlColored(yaml));
      (contentBox as any).setLabel(" {bold}Plan (YAML){/bold} ");
    }
  };

  renderContent();
  actionList.select(0);
  actionList.focus();
  ctx.scheduleRender();

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") {
      cleanup();
      ctx.log("{yellow-fg}Plan cancelled{/yellow-fg}");
      return;
    }
    if (key.full === "tab") {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      renderContent();
      ctx.scheduleRender();
      return;
    }
    if (key.name === "up") { actionList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { actionList.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      const selectedIdx = (actionList as any).selected ?? 0;
      handleAction(selectedIdx);
      return;
    }
  });

  const handleAction = (idx: number) => {
    cleanup();
    switch (idx) {
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
          ctx.log("{blue-fg}Draft updated{/blue-fg}");
        } else {
          saveDraft(ctx, yaml, originalInput);
        }
        break;
      case 3: showYamlEditor(ctx, yaml, originalInput, existingPlanId); break;
      case 4: showRefineInput(ctx, yaml, originalInput); break;
    }
  };

  let previewReady = false;
  setImmediate(() => { previewReady = true; });
  actionList.on("select", (_item: any, index: number) => {
    if (!previewReady) return;
    handleAction(index);
  });
}

function showYamlEditor(ctx: CommandContext, yaml: string, originalInput: string, existingPlanId?: string): void {
  ctx.overlayActive = true;
  const editor = blessed.textarea({
    parent: ctx.screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    value: yaml,
    inputOnFocus: false,
    border: { type: "line" },
    tags: true,
    label: " {yellow-fg}✎{/yellow-fg} {bold}Edit Plan{/bold}  {grey-fg}Ctrl+S save  Escape cancel{/grey-fg} ",
    style: { bg: "black", fg: "white", border: { fg: "yellow" } },
    keys: true,
    mouse: true,
    scrollable: true,
  });

  editor.focus();
  editor.readInput(() => {});
  ctx.scheduleRender();

  editor.key(["C-s"], () => {
    const editedYaml = editor.getValue();
    ctx.overlayActive = false;
    editor.destroy();
    showPlanPreview(ctx, editedYaml, originalInput, existingPlanId);
  });

  editor.key(["escape"], () => {
    ctx.overlayActive = false;
    editor.destroy();
    showPlanPreview(ctx, yaml, originalInput, existingPlanId);
  });
}

function showRefineInput(ctx: CommandContext, yaml: string, originalInput: string): void {
  ctx.overlayActive = true;
  const refineBox = blessed.box({
    parent: ctx.screen,
    top: "center",
    left: "center",
    width: "70%",
    height: 5,
    border: { type: "line" },
    tags: true,
    label: " {cyan-fg}↻{/cyan-fg} {bold}Refine{/bold}  {grey-fg}What should be changed?{/grey-fg} ",
    style: { bg: "black", fg: "white", border: { fg: "cyan" } },
  });

  let refineBuffer = "";
  const cursor = "{white-fg}█{/white-fg}";
  refineBox.setContent(` ${cursor}`);
  ctx.scheduleRender();

  const refineCleanup = () => {
    ctx.overlayActive = false;
    ctx.screen.removeListener("keypress", keyHandler);
    refineBox.destroy();
    ctx.scheduleRender();
  };

  const keyHandler = (ch: string, key: any) => {
    if (!key) return;
    if (key.name === "return" || key.name === "enter") {
      if (refineBuffer.trim()) {
        refineCleanup();
        handleRefine(ctx, yaml, originalInput, refineBuffer.trim());
      }
      return;
    }
    if (key.name === "escape") {
      refineCleanup();
      showPlanPreview(ctx, yaml, originalInput);
      return;
    }
    if (key.name === "backspace") {
      refineBuffer = refineBuffer.slice(0, -1);
    } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
      refineBuffer += ch;
    }
    refineBox.setContent(` ${refineBuffer}${cursor}`);
    ctx.scheduleRender();
  };

  ctx.screen.on("keypress", keyHandler);
}

async function handleRefine(ctx: CommandContext, currentYaml: string, originalInput: string, feedback: string): Promise<void> {
  ctx.logAlways(`{cyan-fg}↻{/cyan-fg} Refining: ${feedback}`);
  ctx.logAlways("");
  ctx.setProcessing(true, "Refining plan");

  try {
    const newYaml = await generatePlanWithFeedback(ctx, originalInput, currentYaml, feedback);
    ctx.setProcessing(false);

    if (!newYaml?.trim()) {
      ctx.log("{red-fg}Refine returned empty result{/red-fg}");
      showPlanPreview(ctx, currentYaml, originalInput);
      return;
    }

    try {
      const doc = parseYaml(newYaml);
      if (!doc?.tasks?.length) {
        ctx.log("{red-fg}Refined plan has no tasks{/red-fg}");
        showPlanPreview(ctx, currentYaml, originalInput);
        return;
      }
    } catch {
      ctx.log("{red-fg}Refined plan has invalid YAML{/red-fg}");
      showPlanPreview(ctx, currentYaml, originalInput);
      return;
    }

    showPlanPreview(ctx, newYaml, originalInput);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Refine failed: ${msg}{/red-fg}`);
  }
}

async function generatePlanWithFeedback(ctx: CommandContext, originalInput: string, currentYaml: string, feedback: string): Promise<string> {
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

function saveDraft(ctx: CommandContext, yaml: string, prompt: string): void {
  try {
    const plan = ctx.orchestrator.savePlan({ yaml, prompt, status: "draft", name: extractPlanName(yaml) });
    ctx.log(`{blue-fg}Plan saved as draft: ${plan.name}{/blue-fg}`);
    ctx.logEvent(`  {blue-fg}■{/blue-fg} Draft saved: {bold}${plan.name}{/bold}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Failed to save draft: ${msg}{/red-fg}`);
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
          // Merge: keep original assignTo/dependsOn, take enriched description + expectations
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
        // Prep failed for this task — keep original
        enrichedTasks.push(t);
      }
    }

    ctx.setProcessing(false);

    // Build enriched YAML and show preview (don't execute yet)
    const enrichedDoc = { ...doc, tasks: enrichedTasks };
    const enrichedYaml = stringifyYaml(enrichedDoc);

    ctx.logAlways(`{green-fg}✓{/green-fg} ${enrichedTasks.length} task(s) prepared`);
    showPlanPreview(ctx, enrichedYaml, originalInput, existingPlanId);
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Task preparation failed: ${msg}{/red-fg}`);
    // Re-show original plan preview
    showPlanPreview(ctx, yaml, originalInput, existingPlanId);
  }
}

function executeNewPlan(ctx: CommandContext, yaml: string, prompt: string): void {
  try {
    const plan = ctx.orchestrator.savePlan({ yaml, prompt, name: extractPlanName(yaml) });
    const { tasks, group } = ctx.orchestrator.executePlan(plan.id);
    ctx.log(`{green-fg}Plan executed: ${tasks.length} task${tasks.length !== 1 ? "s" : ""} created (${group}){/green-fg}`);
    ctx.logEvent(`  {green-fg}▸{/green-fg} {bold}Plan started{/bold} — ${tasks.length} tasks {grey-fg}(${group}){/grey-fg}`);
    ctx.log("{grey-fg}Supervisor will start picking them up...{/grey-fg}");
    ctx.log("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Failed to execute plan: ${msg}{/red-fg}`);
  }
}

/**
 * Execute a previously saved plan (called from /plans command).
 */
export function executeSavedPlan(ctx: CommandContext, planId: string): void {
  try {
    const { tasks, group } = ctx.orchestrator.executePlan(planId);
    ctx.log(`{green-fg}Plan executed: ${tasks.length} task${tasks.length !== 1 ? "s" : ""} created (${group}){/green-fg}`);
    ctx.logEvent(`  {green-fg}▸{/green-fg} {bold}Plan started{/bold} — ${tasks.length} tasks {grey-fg}(${group}){/grey-fg}`);
    ctx.log("{grey-fg}Supervisor will start picking them up...{/grey-fg}");
    ctx.log("");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`{red-fg}Failed to execute plan: ${msg}{/red-fg}`);
  }
}
