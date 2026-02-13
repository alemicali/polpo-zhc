/**
 * Task management commands: /tasks browser, /inspect, /reassess, /abort, /clear-tasks, /edit-plan
 */

import blessed from "blessed";
import type { CommandContext } from "../context.js";
import { getStatusIcon, getStatusLabel, formatElapsed, esc } from "../formatters.js";
import { createOverlay, addHintBar } from "../widgets.js";
import { showConfigPicker } from "./config.js";

// ─── /reassess ───────────────────────────────────────────

export function cmdReassess(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  const tasks = (state?.tasks ?? []).filter(t => t.status === "done" || t.status === "failed");
  if (tasks.length === 0) {
    ctx.logAlways("{yellow-fg}No done/failed tasks to reassess{/yellow-fg}");
    return;
  }

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const items = tasks.map(t => {
    const icon = t.status === "done" ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";
    const score = t.result?.assessment?.globalScore !== undefined
      ? ` {grey-fg}(${t.result.assessment.globalScore.toFixed(1)}/5){/grey-fg}`
      : "";
    return `  ${icon} ${t.title}${score}`;
  });

  const taskList = blessed.list({
    parent: overlay, top: "center", left: "center", width: "70%",
    height: Math.min(items.length + 2, 16), items, tags: true,
    border: { type: "line" },
    label: " {yellow-fg}↻{/yellow-fg} {bold}Reassess Task{/bold} ",
    style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, vi: false, mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}reassess{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  taskList.select(0);
  ctx.scheduleRender();

  const doReassess = (idx: number) => {
    if (idx < 0 || idx >= tasks.length) return;
    const task = tasks[idx];
    cleanup();
    ctx.logAlways(`{yellow-fg}↻{/yellow-fg} Reassessing: ${task.title}`);
    ctx.setProcessing(true, "Reassessing");
    ctx.orchestrator.reassessTask(task.id).then(() => {
      ctx.setProcessing(false);
    }).catch((err: Error) => {
      ctx.setProcessing(false);
      ctx.logAlways(`{red-fg}Reassess error: ${err.message}{/red-fg}`);
    });
  };

  let reassessReady = false;
  setImmediate(() => { reassessReady = true; });
  taskList.on("select", (_item: any, index: number) => {
    if (!reassessReady) return;
    doReassess(index);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { taskList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { taskList.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      doReassess((taskList as any).selected ?? 0);
    }
  });
}

// ─── /tasks browser ──────────────────────────────────────

type BrowserEntry = { type: "plan"; name: string; tasks: any[] } | { type: "task"; task: any };

export function cmdTaskBrowser(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  const tasks = state?.tasks ?? [];
  if (tasks.length === 0) {
    ctx.log("{yellow-fg}No tasks{/yellow-fg}");
    return;
  }

  const ungrouped: typeof tasks = [];
  const groups = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  const entries: BrowserEntry[] = [];
  for (const [name, gTasks] of groups) {
    entries.push({ type: "plan", name, tasks: gTasks });
  }
  for (const t of ungrouped) {
    entries.push({ type: "task", task: t });
  }

  if (entries.length === 0) {
    ctx.log("{yellow-fg}No tasks{/yellow-fg}");
    return;
  }

  showBrowserLevel1(ctx, entries);
}

export function cmdInspect(ctx: CommandContext): void {
  cmdTaskBrowser(ctx);
}

function showBrowserLevel1(ctx: CommandContext, entries: BrowserEntry[]): void {
  const items = entries.map(e => {
    if (e.type === "plan") {
      const done = e.tasks.filter((t: any) => t.status === "done").length;
      const failed = e.tasks.filter((t: any) => t.status === "failed").length;
      const total = e.tasks.length;
      const allTerminal = done + failed === total;
      const earliest = e.tasks.reduce((min: string, t: any) => t.createdAt < min ? t.createdAt : min, e.tasks[0].createdAt);
      const endTime = allTerminal
        ? e.tasks.reduce((max: string, t: any) => t.updatedAt > max ? t.updatedAt : max, e.tasks[0].updatedAt)
        : new Date().toISOString();
      const elapsed = formatElapsed(new Date(endTime).getTime() - new Date(earliest).getTime());
      const statusIcon = allTerminal
        ? (failed > 0 ? "{red-fg}✗{/red-fg}" : "{green-fg}✓{/green-fg}")
        : "{yellow-fg}●{/yellow-fg}";
      return `  ${statusIcon} {bold}${e.name}{/bold} {grey-fg}(${done}/${total}){/grey-fg} {grey-fg}${elapsed}{/grey-fg}`;
    } else {
      const icon = getStatusIcon(e.task.status);
      const score = e.task.result?.assessment?.globalScore !== undefined
        ? ` {grey-fg}${e.task.result.assessment.globalScore.toFixed(1)}/5{/grey-fg}`
        : "";
      return `  ${icon} ${e.task.title}${score}`;
    }
  });

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);
  const list = blessed.list({
    parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
    items, tags: true, border: { type: "line" },
    label: " {bold}Tasks{/bold} ",
    style: { bg: "black", border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, mouse: true,
  });
  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}open{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}");
  list.select(0);
  ctx.scheduleRender();

  const openEntry = (idx: number) => {
    const entry = entries[idx];
    if (!entry) return;
    cleanup();
    if (entry.type === "plan") {
      showBrowserPlan(ctx, entry.name, entry.tasks, entries);
    } else {
      showBrowserTaskDetail(ctx, entry.task, () => showBrowserLevel1(ctx, entries));
    }
  };

  let browseReady = false;
  setImmediate(() => { browseReady = true; });
  list.on("select", (_: any, idx: number) => { if (browseReady) openEntry(idx); });
  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") { openEntry((list as any).selected ?? 0); }
  });
}

function showBrowserPlan(ctx: CommandContext, planName: string, planTasks: any[], parentEntries: BrowserEntry[]): void {
  const items = planTasks.map((t: any) => {
    const icon = getStatusIcon(t.status);
    const score = t.result?.assessment?.globalScore !== undefined
      ? ` {grey-fg}${t.result.assessment.globalScore.toFixed(1)}/5{/grey-fg}`
      : "";
    const agent = t.assignTo ? ` {grey-fg}→ ${t.assignTo}{/grey-fg}` : "";
    return `  ${icon} ${t.title}${agent}${score}`;
  });

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);
  const list = blessed.list({
    parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
    items, tags: true, border: { type: "line" },
    label: ` {bold}${planName}{/bold} `,
    style: { bg: "black", border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, mouse: true,
  });
  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}inspect{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}");
  list.select(0);
  ctx.scheduleRender();

  const openTask = (idx: number) => {
    const task = planTasks[idx];
    if (!task) return;
    cleanup();
    showBrowserTaskDetail(ctx, task, () => showBrowserPlan(ctx, planName, planTasks, parentEntries));
  };

  let planReady = false;
  setImmediate(() => { planReady = true; });
  list.on("select", (_: any, idx: number) => { if (planReady) openTask(idx); });
  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); showBrowserLevel1(ctx, parentEntries); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") { openTask((list as any).selected ?? 0); }
  });
}

function showBrowserTaskDetail(ctx: CommandContext, task: any, goBack: () => void): void {
  import("../../core/session-reader.js").then(({ readSessionSummary }) => {
    const isRunning = ["in_progress", "assigned", "review"].includes(task.status);

    const buildContent = () => {
      // Re-read live state for running tasks
      ctx.loadState();
      const state = ctx.getState();
      const freshTask = state?.tasks.find((t: any) => t.id === task.id) ?? task;
      const proc = (state?.processes || []).find((p: any) => p.taskId === freshTask.id);
      const sessionId = proc?.activity?.sessionId;

      const lines: string[] = [];

      // ── Header ──
      const statusLabel = getStatusLabel(freshTask.status);
      lines.push(`{bold}${esc(freshTask.title)}{/bold} {grey-fg}[${freshTask.id}]{/grey-fg}`);
      lines.push(`${statusLabel}  {cyan-fg}→ ${esc(freshTask.assignTo)}{/cyan-fg}  Retries: ${freshTask.retries}/${freshTask.maxRetries}`);
      if (freshTask.group) lines.push(`Plan: {cyan-fg}${esc(freshTask.group)}{/cyan-fg}`);
      if (freshTask.dependsOn?.length > 0) {
        const depNames = freshTask.dependsOn.map((depId: string) => {
          const dep = state?.tasks.find((t: any) => t.id === depId);
          return dep ? esc(dep.title) : depId;
        });
        lines.push(`Depends on: {grey-fg}${depNames.join(", ")}{/grey-fg}`);
      }
      lines.push("");

      // ── Prompt / Description ──
      if (freshTask.description && freshTask.description !== freshTask.title) {
        lines.push("{cyan-fg}━━ Prompt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/cyan-fg}");
        lines.push(`  ${esc(freshTask.description.slice(0, 800))}`);
        lines.push("");
      }

      // ── Expectations ──
      if (freshTask.expectations?.length > 0) {
        lines.push("{yellow-fg}┌─ Expectations ────────────────────────┐{/yellow-fg}");
        for (const exp of freshTask.expectations) {
          // Check if this expectation passed (from assessment results)
          const check = freshTask.result?.assessment?.checks?.find((c: any) => c.type === exp.type);
          const icon = check ? (check.passed ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}") : "{grey-fg}○{/grey-fg}";
          let label = "";
          switch (exp.type) {
            case "test":
              label = `test: ${esc(exp.command || "")}`;
              break;
            case "file_exists":
              label = `files: ${esc((exp.paths || []).join(", "))}`;
              break;
            case "script":
              label = `script: ${esc((exp.command || "").split("\n")[0])}`;
              break;
            case "llm_review":
              label = `review: ${esc((exp.criteria || "").slice(0, 80))}`;
              break;
            default:
              label = exp.type;
          }
          lines.push(`{yellow-fg}│{/yellow-fg}  ${icon} ${label}`);
        }
        lines.push("{yellow-fg}└──────────────────────────────────────┘{/yellow-fg}");
        lines.push("");
      }

      // ── Live Activity (running tasks) ──
      if (proc?.alive && proc.activity) {
        const act = proc.activity;
        const elapsed = proc.startedAt ? formatElapsed(Date.now() - new Date(proc.startedAt).getTime()) : "";
        lines.push(`{yellow-fg}━━ Live Activity ━━━━━━━━━━━━━━━━━━━━━━{/yellow-fg} {grey-fg}${elapsed}{/grey-fg}`);
        if (act.lastTool) {
          const fileInfo = act.lastFile ? ` → ${esc(act.lastFile.split("/").pop() ?? "")}` : "";
          lines.push(`  {yellow-fg}▸{/yellow-fg} ${esc(act.lastTool)}${fileInfo}`);
        }
        lines.push(`  Tool calls: ${act.toolCalls}`);
        if (act.filesCreated?.length > 0) {
          lines.push(`  {green-fg}Created:{/green-fg}`);
          for (const f of act.filesCreated) lines.push(`    {green-fg}+{/green-fg} ${esc(f)}`);
        }
        if (act.filesEdited?.length > 0) {
          lines.push(`  {yellow-fg}Edited:{/yellow-fg}`);
          for (const f of act.filesEdited) lines.push(`    {yellow-fg}~{/yellow-fg} ${esc(f)}`);
        }
        if (act.summary) {
          lines.push("");
          lines.push(`  {grey-fg}${esc(act.summary.slice(0, 400))}{/grey-fg}`);
        }
        lines.push("");
      }

      // ── Session Transcript ──
      if (sessionId) {
        const summary = readSessionSummary(sessionId, ctx.workDir);
        if (summary) {
          lines.push("{cyan-fg}━━ Session Transcript ━━━━━━━━━━━━━━━━━{/cyan-fg}");
          lines.push(`  {grey-fg}ID: ${sessionId}{/grey-fg}  Messages: ${summary.messageCount}`);
          if (summary.filesCreated.length > 0) {
            lines.push(`  {green-fg}Files created:{/green-fg}`);
            for (const f of summary.filesCreated.slice(0, 15)) lines.push(`    {green-fg}+{/green-fg} ${esc(f)}`);
          }
          if (summary.filesEdited.length > 0) {
            lines.push(`  {yellow-fg}Files edited:{/yellow-fg}`);
            for (const f of summary.filesEdited.slice(0, 15)) lines.push(`    {yellow-fg}~{/yellow-fg} ${esc(f)}`);
          }
          if (summary.todos.length > 0) {
            lines.push(`  {magenta-fg}TODOs:{/magenta-fg}`);
            for (const t of summary.todos.slice(0, 5)) lines.push(`    ${esc(t)}`);
          }
          if (summary.errors.length > 0) {
            lines.push(`  {red-fg}Errors:{/red-fg}`);
            for (const e of summary.errors.slice(0, 5)) lines.push(`    {red-fg}✗{/red-fg} ${esc(e)}`);
          }
          if (summary.lastMessage) {
            lines.push("");
            lines.push(`  {grey-fg}Last message:{/grey-fg}`);
            lines.push(`    ${esc(summary.lastMessage.slice(0, 500))}`);
          }
          lines.push("");
        }
      }

      // ── Result & Assessment ──
      if (freshTask.result) {
        const exitColor = freshTask.result.exitCode === 0 ? "green" : "red";
        lines.push("{cyan-fg}━━ Result ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/cyan-fg}");
        lines.push(`  Exit: {${exitColor}-fg}${freshTask.result.exitCode}{/${exitColor}-fg}  Duration: ${(freshTask.result.duration / 1000).toFixed(1)}s`);

        if (freshTask.result.assessment) {
          const assessment = freshTask.result.assessment;
          lines.push("");
          lines.push("{magenta-fg}━━ Assessment ━━━━━━━━━━━━━━━━━━━━━━━━━{/magenta-fg}");
          const passed = assessment.passed;
          lines.push(`  Result: ${passed ? "{green-fg}PASSED{/green-fg}" : "{red-fg}FAILED{/red-fg}"}`);

          if (assessment.globalScore !== undefined) {
            const gs = assessment.globalScore;
            const color = gs >= 4 ? "green" : gs >= 3 ? "yellow" : "red";
            lines.push(`  Global score: {${color}-fg}{bold}${gs.toFixed(1)}/5{/bold}{/${color}-fg}`);
          }

          if (assessment.scores?.length > 0) {
            lines.push("");
            for (const s of assessment.scores) {
              const sc = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
              const bar = "{" + sc + "-fg}" + "█".repeat(s.score) + "{/" + sc + "-fg}" + "{grey-fg}" + "░".repeat(5 - s.score) + "{/grey-fg}";
              lines.push(`  ${bar} {bold}${esc(s.dimension)}{/bold} ${s.score}/5`);
              if (s.reasoning) lines.push(`       {grey-fg}${esc(s.reasoning.slice(0, 150))}{/grey-fg}`);
            }
          }

          if (assessment.checks?.length > 0) {
            lines.push("");
            lines.push("  {cyan-fg}Checks:{/cyan-fg}");
            for (const c of assessment.checks) {
              const icon = c.passed ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";
              lines.push(`    ${icon} ${c.type}: ${esc(c.message ?? "")}`);
              if (c.details) lines.push(`      {grey-fg}${esc(c.details.slice(0, 200))}{/grey-fg}`);
            }
          }

          if (assessment.llmReview) {
            lines.push("");
            lines.push("  {cyan-fg}LLM Review:{/cyan-fg}");
            lines.push(`    {grey-fg}${esc(assessment.llmReview.slice(0, 500))}{/grey-fg}`);
          }
        }

        lines.push("");

        if (freshTask.result.stdout) {
          lines.push("{cyan-fg}━━ Output ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/cyan-fg}");
          for (const line of freshTask.result.stdout.slice(0, 1000).split("\n")) {
            lines.push(`  ${esc(line)}`);
          }
          lines.push("");
        }
        if (freshTask.result.stderr) {
          lines.push("{red-fg}━━ Stderr ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{/red-fg}");
          for (const line of freshTask.result.stderr.slice(0, 500).split("\n")) {
            lines.push(`  {red-fg}${esc(line)}{/red-fg}`);
          }
          lines.push("");
        }
      }

      return lines.join("\n");
    };

    const { overlay, cleanup, onKeypress } = createOverlay(ctx);
    const contentBox = blessed.box({
      parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
      content: buildContent(), tags: true, border: { type: "line" },
      label: ` {bold}${task.title}{/bold} `,
      scrollable: true, keys: false, mouse: true,
      style: { bg: "black", border: { fg: "cyan" } },
    });
    const hintText = isRunning
      ? " {cyan-fg}↑↓{/cyan-fg} {grey-fg}scroll{/grey-fg}  {yellow-fg}auto-refresh{/yellow-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}"
      : " {cyan-fg}↑↓{/cyan-fg} {grey-fg}scroll{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}";
    addHintBar(overlay, hintText);
    contentBox.focus();
    ctx.scheduleRender();

    // Auto-refresh for running tasks
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    if (isRunning) {
      refreshTimer = setInterval(() => {
        const scroll = (contentBox as any).childBase ?? 0;
        contentBox.setContent(buildContent());
        contentBox.scrollTo(scroll);
        ctx.scheduleRender();
      }, 2000);
    }

    onKeypress((_ch, key) => {
      if (!key) return;
      if (key.name === "escape" || key.name === "q") {
        if (refreshTimer) clearInterval(refreshTimer);
        cleanup();
        goBack();
        return;
      }
      if (key.name === "up") { contentBox.scroll(-1); ctx.scheduleRender(); return; }
      if (key.name === "down") { contentBox.scroll(1); ctx.scheduleRender(); return; }
    });
  });
}

// ─── /edit-plan ──────────────────────────────────────────

export function cmdEditPlan(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  const tasks = state?.tasks ?? [];
  const groups = new Map<string, typeof tasks>();
  for (const t of tasks) {
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    }
  }

  const editableGroups = [...groups.entries()].filter(([, g]) =>
    g.some(t => t.status !== "done" && t.status !== "failed")
  );

  if (editableGroups.length === 0) {
    ctx.log("{yellow-fg}No active plans to edit{/yellow-fg}");
    return;
  }

  if (editableGroups.length === 1) {
    showPlanEditor(ctx, editableGroups[0][0], editableGroups[0][1]);
    return;
  }

  const items = editableGroups.map(([name, g]) => {
    const done = g.filter(t => t.status === "done").length;
    return `  {cyan-fg}${name}{/cyan-fg} {grey-fg}(${done}/${g.length} done){/grey-fg}`;
  });

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);
  const list = blessed.list({
    parent: overlay, top: "center", left: "center", width: "50%", height: Math.min(items.length + 2, 12),
    items, tags: true, border: { type: "line" },
    label: " {bold}Edit Plan{/bold} ",
    style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, mouse: true,
  });
  list.select(0);
  ctx.scheduleRender();

  const selectGroup = (idx: number) => {
    const [name, g] = editableGroups[idx];
    cleanup();
    showPlanEditor(ctx, name, g);
  };

  let editPlanReady = false;
  setImmediate(() => { editPlanReady = true; });
  list.on("select", (_: any, idx: number) => { if (editPlanReady) selectGroup(idx); });
  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") { selectGroup((list as any).selected ?? 0); }
  });
}

function showPlanEditor(ctx: CommandContext, groupName: string, groupTasks: any[]): void {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const buildItems = () => {
    const items: string[] = [];
    for (const t of groupTasks) {
      const icon = getStatusIcon(t.status);
      const agent = `{cyan-fg}→ ${t.assignTo}{/cyan-fg}`;
      const editable = t.status === "pending" || t.status === "failed";
      const editMark = editable ? "" : " {grey-fg}(locked){/grey-fg}";
      const cols = (ctx.screen.cols as number) || 80;
      const titleMax = Math.max(15, cols - 30);
      items.push(`  ${icon} ${t.title.length > titleMax ? t.title.slice(0, titleMax - 1) + "…" : t.title} ${agent}${editMark}`);
    }
    items.push("  {green-fg}+{/green-fg} Add task to plan");
    return items;
  };

  const taskList = blessed.list({
    parent: overlay, top: 0, left: 0, width: "100%", height: "100%-5",
    items: buildItems(), tags: true, border: { type: "line" },
    label: ` {yellow-fg}✎{/yellow-fg} {bold}Edit: ${groupName}{/bold} `,
    style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
    keys: false, mouse: true, scrollable: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}edit{/grey-fg}  {cyan-fg}d{/cyan-fg} {grey-fg}remove{/grey-fg}  {cyan-fg}a{/cyan-fg} {grey-fg}reassign{/grey-fg}  {cyan-fg}r{/cyan-fg} {grey-fg}retry{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}close{/grey-fg}");

  taskList.select(0);
  ctx.scheduleRender();

  const refreshList = () => { taskList.setItems(buildItems()); ctx.scheduleRender(); };

  /** Callback-based text input for plan editor using proper overlay lifecycle */
  const showTextInput = (title: string, initial: string, onSubmit: (value: string) => void, onCancel: () => void) => {
    const { overlay: inputOverlay, cleanup: inputCleanup, onKeypress: inputOnKeypress } = createOverlay(ctx);
    const box = blessed.box({
      parent: inputOverlay, top: "center", left: "center", width: "60%", height: 5,
      border: { type: "line" }, tags: true,
      label: ` {bold}${title}{/bold} `,
      style: { bg: "black", fg: "white", border: { fg: "cyan" } },
    });
    addHintBar(inputOverlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

    let buf = initial;
    const cursor = "{white-fg}_{/white-fg}";
    box.setContent(` ${buf}${cursor}`);
    ctx.scheduleRender();

    inputOnKeypress((ch, key) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") { inputCleanup(); onSubmit(buf.trim()); return; }
      if (key.name === "escape") { inputCleanup(); onCancel(); return; }
      if (key.name === "backspace") { buf = buf.slice(0, -1); }
      else if (ch && ch.length === 1 && !key.ctrl && !key.meta) { buf += ch; }
      box.setContent(` ${buf}${cursor}`);
      ctx.scheduleRender();
    });
  };

  const reopenEditor = () => {
    ctx.loadState();
    const updated = (ctx.getState()?.tasks ?? []).filter((t: any) => t.group === groupName);
    showPlanEditor(ctx, groupName, updated);
  };

  onKeypress((_ch, key) => {
    if (!key) return;
    const idx = (taskList as any).selected ?? 0;
    const isAddRow = idx >= groupTasks.length;
    const task = groupTasks[idx];
    const editable = task && (task.status === "pending" || task.status === "failed");

    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { taskList.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { taskList.down(1); ctx.scheduleRender(); return; }

    if (key.name === "return" || key.name === "enter") {
      if (isAddRow) {
        cleanup();
        showTextInput("New task title", "", (title) => {
          if (title?.trim()) {
            showTextInput("Task description", "", (desc) => {
              const agents = ctx.orchestrator.getAgents();
              const defaultAgent = agents[0]?.name ?? "dev";
              ctx.orchestrator.addTask({
                title: title.trim(),
                description: desc?.trim() || title.trim(),
                assignTo: defaultAgent,
                expectations: [],
                group: groupName,
              });
              ctx.log(`{green-fg}Task added to ${groupName}: ${title.trim()}{/green-fg}`);
              reopenEditor();
            }, reopenEditor);
          } else {
            reopenEditor();
          }
        }, reopenEditor);
      } else if (editable) {
        cleanup();
        showTextInput(`Edit: ${task.title}`, task.description, (desc) => {
          if (desc?.trim()) {
            ctx.orchestrator.updateTaskDescription(task.id, desc.trim());
            ctx.log(`{green-fg}Task updated: ${task.title}{/green-fg}`);
          }
          reopenEditor();
        }, reopenEditor);
      }
      return;
    }

    // d = delete (only pending/failed)
    if (key.name === "d" && !isAddRow && editable) {
      ctx.orchestrator.killTask(task.id);
      ctx.orchestrator.clearTasks((t: any) => t.id === task.id);
      groupTasks.splice(idx, 1);
      ctx.log(`{red-fg}Removed from plan: ${task.title}{/red-fg}`);
      refreshList();
      return;
    }

    // a = reassign (only pending/failed)
    if (key.name === "a" && !isAddRow && editable) {
      const agents = ctx.orchestrator.getAgents();
      const agentOpts = agents.map(a => ({
        label: `${a.name} ${a.role ? `{grey-fg}(${a.role}){/grey-fg}` : ""}`,
        value: a.name,
        available: true,
      }));
      cleanup();
      showConfigPicker(ctx, ctx.screen as any, "Reassign to", agentOpts, (value) => {
        ctx.orchestrator.updateTaskAssignment(task.id, value);
        ctx.log(`{green-fg}${task.title} → ${value}{/green-fg}`);
        reopenEditor();
      }, reopenEditor);
      return;
    }

    // r = retry (only failed)
    if (key.name === "r" && !isAddRow && task?.status === "failed") {
      try {
        ctx.orchestrator.retryTask(task.id);
        ctx.log(`{yellow-fg}Retrying: ${task.title}{/yellow-fg}`);
      } catch (e: any) {
        ctx.log(`{red-fg}Cannot retry: ${e.message}{/red-fg}`);
      }
      cleanup();
      reopenEditor();
      return;
    }
  });

  let planEdReady = false;
  setImmediate(() => { planEdReady = true; });
  taskList.on("select", () => {
    if (planEdReady) {
      const idx = (taskList as any).selected ?? 0;
      const isAddRow = idx >= groupTasks.length;
      const task = groupTasks[idx];
      const editable = task && (task.status === "pending" || task.status === "failed");
      if (isAddRow || editable) {
        // Trigger enter handling
        if (isAddRow) {
          cleanup();
          showTextInput("New task title", "", (title) => {
            if (title?.trim()) {
              showTextInput("Task description", "", (desc) => {
                const agents = ctx.orchestrator.getAgents();
                const defaultAgent = agents[0]?.name ?? "dev";
                ctx.orchestrator.addTask({
                  title: title.trim(),
                  description: desc?.trim() || title.trim(),
                  assignTo: defaultAgent,
                  expectations: [],
                  group: groupName,
                });
                ctx.log(`{green-fg}Task added to ${groupName}: ${title.trim()}{/green-fg}`);
                reopenEditor();
              }, reopenEditor);
            } else {
              reopenEditor();
            }
          }, reopenEditor);
        } else {
          cleanup();
          showTextInput(`Edit: ${task.title}`, task.description, (desc) => {
            if (desc?.trim()) {
              ctx.orchestrator.updateTaskDescription(task.id, desc.trim());
              ctx.log(`{green-fg}Task updated: ${task.title}{/green-fg}`);
            }
            reopenEditor();
          }, reopenEditor);
        }
      }
    }
  });
}

// ─── /abort ──────────────────────────────────────────────

export function cmdAbort(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  if (!state || state.tasks.length === 0) {
    ctx.log("{grey-fg}No tasks to abort{/grey-fg}");
    return;
  }

  const running = state.tasks.filter(t =>
    ["pending", "assigned", "in_progress", "review"].includes(t.status)
  );

  if (running.length === 0) {
    ctx.log("{grey-fg}No running tasks{/grey-fg}");
    return;
  }

  const groups = new Map<string, typeof running>();
  const ungrouped: typeof running = [];
  for (const t of running) {
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  const options: { label: string; action: () => void }[] = [];

  for (const [groupName, tasks] of groups) {
    options.push({
      label: `  {red-fg}✗{/red-fg} Abort {bold}${groupName}{/bold} {grey-fg}(${tasks.length} tasks){/grey-fg}`,
      action: () => {
        const count = ctx.orchestrator.abortGroup(groupName);
        ctx.log(`{red-fg}Aborted ${count} tasks in ${groupName}{/red-fg}`);
      },
    });
  }

  for (const t of ungrouped) {
    options.push({
      label: `  {red-fg}✗{/red-fg} ${t.title.length > 50 ? t.title.slice(0, 49) + "…" : t.title}`,
      action: () => {
        ctx.orchestrator.killTask(t.id);
        ctx.log(`{red-fg}Aborted: ${t.title}{/red-fg}`);
      },
    });
  }

  if (options.length === 1) {
    options[0].action();
    return;
  }

  showAbortPicker(ctx, options);
}

function showAbortPicker(ctx: CommandContext, options: { label: string; action: () => void }[]): void {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const items = options.map(o => o.label);
  items.push("  {grey-fg}Cancel{/grey-fg}");

  const list = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: "60%",
    height: items.length + 2,
    items,
    tags: true,
    border: { type: "line" },
    label: " {red-fg}✗{/red-fg} {bold}Abort{/bold} ",
    style: {
      bg: "black",
      border: { fg: "red" },
      selected: { bg: "red", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  list.select(0);
  list.focus();
  ctx.scheduleRender();

  let abortReady = false;
  setImmediate(() => { abortReady = true; });
  list.on("select", (_item: any, index: number) => {
    if (!abortReady) return;
    cleanup();
    if (index < options.length) {
      options[index].action();
    }
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      if (!abortReady) return;
      const idx = (list as any).selected ?? 0;
      cleanup();
      if (idx < options.length) {
        options[idx].action();
      }
    }
  });
}

// ─── /clear-tasks ────────────────────────────────────────

export function cmdClearTasks(ctx: CommandContext): void {
  ctx.loadState();
  const state = ctx.getState();
  if (!state || state.tasks.length === 0) {
    ctx.log("{grey-fg}No tasks to clear{/grey-fg}");
    return;
  }

  const done = state.tasks.filter(t => t.status === "done" || t.status === "failed");
  if (done.length === 0) {
    ctx.log("{grey-fg}No finished tasks to clear{/grey-fg}");
    return;
  }

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const items = [
    `  {green-fg}✓{/green-fg} Clear completed {grey-fg}(done){/grey-fg}`,
    `  {red-fg}✗{/red-fg} Clear failed`,
    `  {yellow-fg}●{/yellow-fg} Clear all finished {grey-fg}(done + failed){/grey-fg}`,
    `  {red-fg}!!{/red-fg} Clear ALL tasks {grey-fg}(kills running agents){/grey-fg}`,
    `  {grey-fg}Cancel{/grey-fg}`,
  ];

  const list = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: "60%",
    height: items.length + 2,
    items,
    tags: true,
    border: { type: "line" },
    label: " {bold}Clear Tasks{/bold} ",
    style: {
      bg: "black",
      border: { fg: "yellow" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  list.select(0);
  list.focus();
  ctx.scheduleRender();

  const doClear = (index: number) => {
    cleanup();
    let count = 0;
    switch (index) {
      case 0:
        count = ctx.orchestrator.clearTasks(t => t.status === "done");
        ctx.log(`{green-fg}Cleared ${count} completed tasks{/green-fg}`);
        break;
      case 1:
        count = ctx.orchestrator.clearTasks(t => t.status === "failed");
        ctx.log(`{green-fg}Cleared ${count} failed tasks{/green-fg}`);
        break;
      case 2:
        count = ctx.orchestrator.clearTasks(t => t.status === "done" || t.status === "failed");
        ctx.log(`{green-fg}Cleared ${count} finished tasks{/green-fg}`);
        break;
      case 3:
        count = ctx.orchestrator.clearTasks(() => true);
        ctx.log(`{red-fg}Cleared all ${count} tasks{/red-fg}`);
        break;
    }
  };

  let clearReady = false;
  setImmediate(() => { clearReady = true; });
  list.on("select", (_item: any, index: number) => {
    if (!clearReady) return;
    doClear(index);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      if (!clearReady) return;
      doClear((list as any).selected ?? 0);
    }
  });
}
