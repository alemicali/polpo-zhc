import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { EditorOverlay } from "../overlays/editor-page.js";
import { ConfirmOverlay } from "../overlays/confirm.js";

export function cmdPlans(api: CommandAPI): void {
  const { polpo, tui, args } = api;
  const plans = polpo.getAllPlans();

  if (args[0] === "list") {
    if (plans.length === 0) {
      tui.logSystem("No plans");
    } else {
      const lines = plans.map((p) => {
        const status =
          p.status === "active"
            ? theme.inProgress("active")
            : p.status === "completed"
              ? theme.done("completed")
              : p.status === "failed"
                ? theme.failed("failed")
                : theme.dim(p.status);
        return `  ${status} ${p.name}`;
      });
      tui.logSystem(theme.bold("Plans:") + "\n" + lines.join("\n"));
    }
    tui.requestRender();
    return;
  }

  if (args[0] === "new") {
    const template = JSON.stringify(
      {
        group: "new-plan",
        tasks: [
          { title: "Task 1", description: "Description", assignTo: "" },
        ],
      },
      null,
      2,
    );
    const editor = new EditorOverlay({
      title: "New Plan (JSON)",
      initialText: template,
      tui: tui.tuiInstance,
      onSave: (text) => {
        tui.hideOverlay();
        try {
          const data = JSON.parse(text);
          polpo.savePlan({ data: JSON.stringify(data), name: data.group });
          tui.logSystem(`Plan saved: ${data.group ?? "unnamed"}`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          tui.logSystem(`Invalid JSON: ${msg}`);
        }
        tui.requestRender();
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(editor);
    return;
  }

  if (plans.length === 0) {
    tui.logSystem("No plans. Use /plans new to create one.");
    tui.requestRender();
    return;
  }

  const items = plans.map((p) => ({
    value: p.id,
    label: p.name,
    description: p.status,
  }));

  const picker = new PickerOverlay({
    title: "Plans",
    items,
    hint: "Enter: view · e: edit · x: execute · d: delete",
    onSelect: (item) => {
      tui.hideOverlay();
      showPlanDetail(api, item.value);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}

function showPlanDetail(api: CommandAPI, planId: string): void {
  const { polpo, tui } = api;
  const plan = polpo.getPlan(planId);
  if (!plan) {
    tui.logSystem(`Plan not found: ${planId}`);
    tui.requestRender();
    return;
  }

  const lines: string[] = [];
  lines.push(chalk.bold(plan.name));
  lines.push(`Status: ${plan.status}`);
  if (plan.prompt) lines.push(`Prompt: ${plan.prompt}`);
  lines.push("");
  lines.push(chalk.bold("Plan data:"));
  try {
    const parsed = JSON.parse(plan.data);
    lines.push(JSON.stringify(parsed, null, 2));
  } catch {
    lines.push(plan.data ?? "[no data]");
  }

  const actions = [];
  if (plan.status === "draft") {
    actions.push({
      label: "Execute",
      handler: () => {
        tui.hideOverlay();
        polpo.executePlan(plan.id);
        kickRun(polpo);
        tui.logSystem(`Executing plan: ${plan.name}`);
        tui.requestRender();
      },
    });
  }
  if (plan.status === "failed" || plan.status === "active") {
    actions.push({
      label: "Resume",
      handler: () => {
        tui.hideOverlay();
        polpo.resumePlan(plan.id);
        kickRun(polpo);
        tui.logSystem(`Resuming plan: ${plan.name}`);
        tui.requestRender();
      },
    });
  }
  actions.push({
    label: "Edit",
    handler: () => {
      tui.hideOverlay();
      const editor = new EditorOverlay({
        title: `Edit Plan: ${plan.name}`,
        initialText: plan.data ?? "{}",
        tui: tui.tuiInstance,
        onSave: (text) => {
          tui.hideOverlay();
          try {
            JSON.parse(text); // validate
            polpo.updatePlan(plan.id, { data: text });
            tui.logSystem(`Plan updated: ${plan.name}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            tui.logSystem(`Invalid JSON: ${msg}`);
          }
          tui.requestRender();
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(editor);
    },
  });
  actions.push({
    label: "Delete",
    handler: () => {
      tui.hideOverlay();
      const confirm = new ConfirmOverlay({
        message: `Delete plan "${plan.name}"?`,
        onConfirm: () => {
          tui.hideOverlay();
          polpo.deletePlan(plan.id);
          tui.logSystem(`Deleted plan: ${plan.name}`);
          tui.requestRender();
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(confirm);
    },
  });
  actions.push({ label: "Close", handler: () => tui.hideOverlay() });

  const viewer = new ViewerOverlay({
    title: `Plan: ${plan.name}`,
    content: lines.join("\n"),
    actions,
    onClose: () => tui.hideOverlay(),
  });
  tui.showOverlay(viewer);
}
