/**
 * /plans — List and manage saved plans (drafts, active, completed).
 * /resume — Resume interrupted plans.
 */

import blessed from "blessed";
import type { CommandContext } from "../context.js";
import type { Plan } from "../../core/types.js";
import { createOverlay, addHintBar } from "../widgets.js";
import { formatYamlColored, formatPlanReadable } from "../formatters.js";
import { executeSavedPlan, showPlanPreview } from "./plan.js";
import { parse as parseYaml } from "yaml";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case "draft": return "blue-fg";
    case "active": return "yellow-fg";
    case "completed": return "green-fg";
    case "failed": return "red-fg";
    case "cancelled": return "grey-fg";
    default: return "white-fg";
  }
}

function getGroupProgress(ctx: CommandContext, groupName: string): string {
  const state = ctx.getState();
  if (!state) return "";
  const tasks = state.tasks.filter(t => t.group === groupName);
  if (tasks.length === 0) return "";
  const done = tasks.filter(t => t.status === "done").length;
  return `(${done}/${tasks.length} done)`;
}

export function cmdPlans(ctx: CommandContext): void {
  const plans = ctx.orchestrator.getAllPlans();

  if (plans.length === 0) {
    ctx.logAlways("{yellow-fg}No saved plans. Use plan mode to generate one.{/yellow-fg}");
    return;
  }

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const buildItems = () => plans.map(p => {
    const color = statusColor(p.status);
    const ago = timeAgo(p.updatedAt);
    const progress = p.status === "active" ? ` ${getGroupProgress(ctx, p.name)}` : "";
    // Dynamic prompt width: total minus status(9) + name(10) + padding/quotes(~12) + ago(~8)
    const cols = (ctx.screen.cols as number) || 80;
    const promptMax = Math.max(15, cols - 45);
    const prompt = p.prompt ? (p.prompt.length > promptMax ? p.prompt.slice(0, promptMax - 1) + "…" : p.prompt) : "(no prompt)";
    return `  {${color}}${p.status.padEnd(9)}{/${color}} {cyan-fg}${p.name.padEnd(10)}{/cyan-fg} "${prompt}" {grey-fg}${ago}${progress}{/grey-fg}`;
  });

  const list = blessed.list({
    parent: overlay,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-3",
    items: buildItems(),
    tags: true,
    border: { type: "line" },
    label: " {bold}Plans{/bold} ",
    style: {
      bg: "black",
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    mouse: true,
    scrollable: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}open{/grey-fg}  {cyan-fg}d{/cyan-fg} {grey-fg}delete{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}close{/grey-fg}");

  list.select(0);
  ctx.scheduleRender();

  const openPlan = (idx: number) => {
    const plan = plans[idx];
    if (!plan) return;
    cleanup();

    if (plan.status === "draft") {
      // Re-show preview with Execute/Edit/Refine
      showPlanPreview(ctx, plan.yaml, plan.prompt ?? "", plan.id);
    } else if (plan.status === "active") {
      // Show plan info
      ctx.log(`{yellow-fg}Plan "${plan.name}" is active.{/yellow-fg} ${getGroupProgress(ctx, plan.name)}`);
      ctx.log("{grey-fg}Use /tasks to see running tasks.{/grey-fg}");
    } else {
      // Completed/failed/cancelled — show details with re-execute option
      showCompletedPlan(ctx, plan);
    }
  };

  const deletePlan = (idx: number) => {
    const plan = plans[idx];
    if (!plan) return;
    if (plan.status === "active") {
      ctx.log("{red-fg}Cannot delete active plan. Abort it first.{/red-fg}");
      return;
    }
    ctx.orchestrator.deletePlan(plan.id);
    plans.splice(idx, 1);
    list.setItems(buildItems());
    if (plans.length === 0) {
      cleanup();
      ctx.log("{yellow-fg}No plans remaining.{/yellow-fg}");
      return;
    }
    list.select(Math.min(idx, plans.length - 1));
    ctx.scheduleRender();
  };

  let listReady = false;
  setImmediate(() => { listReady = true; });
  list.on("select", (_: any, idx: number) => { if (listReady) openPlan(idx); });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      openPlan((list as any).selected ?? 0);
      return;
    }
    if (key.full === "d") {
      deletePlan((list as any).selected ?? 0);
    }
  });
}

function showCompletedPlan(ctx: CommandContext, plan: Plan): void {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  let doc: any;
  try { doc = parseYaml(plan.yaml); } catch { doc = null; }

  const content = doc
    ? formatPlanReadable(doc)
    : formatYamlColored(plan.yaml);

  const contentBox = blessed.box({
    parent: overlay,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-5",
    border: { type: "line" },
    tags: true,
    label: ` {bold}${plan.name}{/bold} {${statusColor(plan.status)}}${plan.status}{/${statusColor(plan.status)}} `,
    content,
    scrollable: true,
    keys: true,
    vi: true,
    mouse: true,
    style: { bg: "black", border: { fg: "cyan" } },
  });

  const actions = [
    "  {green-fg}✓{/green-fg} Re-execute plan",
  ];

  const actionList = blessed.list({
    parent: overlay,
    bottom: 1,
    left: "center",
    width: 28,
    height: actions.length + 2,
    items: actions,
    tags: true,
    border: { type: "line" },
    style: {
      bg: "black",
      border: { fg: "grey" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}back{/grey-fg}");

  actionList.select(0);
  actionList.focus();
  ctx.scheduleRender();

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "return" || key.name === "enter") {
      cleanup();
      // Re-execute: save as new plan from same YAML
      const newPlan = ctx.orchestrator.savePlan({
        yaml: plan.yaml,
        prompt: plan.prompt,
      });
      executeSavedPlan(ctx, newPlan.id);
    }
  });

  let actionReady = false;
  setImmediate(() => { actionReady = true; });
  actionList.on("select", () => {
    if (!actionReady) return;
    cleanup();
    const newPlan = ctx.orchestrator.savePlan({ yaml: plan.yaml, prompt: plan.prompt });
    executeSavedPlan(ctx, newPlan.id);
  });
}

/**
 * /resume — Resume interrupted plans (active or failed).
 * Uses core orchestrator.getResumablePlans() and orchestrator.resumePlan().
 */
export function cmdResume(ctx: CommandContext): void {
  const resumablePlans = ctx.orchestrator.getResumablePlans();

  if (resumablePlans.length === 0) {
    ctx.logAlways("{yellow-fg}No plans to resume. All plans are either complete or have no tasks.{/yellow-fg}");
    return;
  }

  const state = ctx.getState();
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const buildItems = () => resumablePlans.map(p => {
    const tasks = state?.tasks.filter(t => t.group === p.name) ?? [];
    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    const pending = tasks.filter(t => t.status === "pending").length;
    const inProgress = tasks.filter(t => ["in_progress", "assigned", "review"].includes(t.status)).length;

    const color = statusColor(p.status);
    const ago = timeAgo(p.updatedAt);
    const progress = `${done}/${tasks.length} done`;
    const failInfo = failed > 0 ? ` {red-fg}${failed} failed{/red-fg}` : "";
    const pendInfo = pending > 0 ? ` {grey-fg}${pending} pending{/grey-fg}` : "";
    const runInfo = inProgress > 0 ? ` {yellow-fg}${inProgress} running{/yellow-fg}` : "";

    return `  {${color}}${p.status.padEnd(9)}{/${color}} {cyan-fg}${p.name.padEnd(10)}{/cyan-fg} {green-fg}${progress}{/green-fg}${failInfo}${pendInfo}${runInfo} {grey-fg}${ago}{/grey-fg}`;
  });

  const list = blessed.list({
    parent: overlay,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-3",
    items: buildItems(),
    tags: true,
    border: { type: "line" },
    label: " {bold}Resume Plan{/bold} ",
    style: {
      bg: "black",
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    mouse: true,
    scrollable: true,
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}resume + retry{/grey-fg}  {cyan-fg}p{/cyan-fg} {grey-fg}resume pending only{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}close{/grey-fg}");

  list.select(0);
  ctx.scheduleRender();

  const doResume = (idx: number, retryFailed: boolean) => {
    const plan = resumablePlans[idx];
    if (!plan) return;
    cleanup();

    try {
      const result = ctx.orchestrator.resumePlan(plan.id, { retryFailed });
      ctx.logAlways(`{green-fg}Resumed plan "${plan.name}"{/green-fg}`);
      if (result.retried > 0) {
        ctx.logAlways(`{yellow-fg}  Retrying ${result.retried} failed task(s){/yellow-fg}`);
      }
      if (result.pending > 0) {
        ctx.logAlways(`{grey-fg}  ${result.pending} pending task(s) will be picked up{/grey-fg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logAlways(`{red-fg}Failed to resume: ${msg}{/red-fg}`);
    }
  };

  let listReady = false;
  setImmediate(() => { listReady = true; });
  list.on("select", (_: any, idx: number) => {
    if (listReady) doResume(idx, true);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      doResume((list as any).selected ?? 0, true);
      return;
    }
    if (key.full === "p") {
      doResume((list as any).selected ?? 0, false);
    }
  });
}
