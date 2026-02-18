import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import {
  discoverWorkflows,
  loadWorkflow,
  validateParams,
  instantiateWorkflow,
} from "../../core/workflow.js";

export async function cmdWorkflow(api: CommandAPI): Promise<void> {
  const { polpo, tui, args } = api;
  const workDir = polpo.getWorkDir();
  const polpoDir = polpo.getPolpoDir();

  const workflows = discoverWorkflows(workDir, polpoDir);
  if (workflows.length === 0) {
    tui.logSystem(
      "No workflows found. Place .yaml files in .polpo/workflows/",
    );
    tui.requestRender();
    return;
  }

  // Direct execution: /workflow <name> [k=v ...]
  if (args.length > 0 && args[0] !== "list") {
    const name = args[0]!;
    const wf = loadWorkflow(workDir, polpoDir, name);
    if (!wf) {
      tui.logSystem(`Workflow not found: ${name}`);
      tui.requestRender();
      return;
    }
    // Parse k=v params
    const params: Record<string, string> = {};
    for (const arg of args.slice(1)) {
      const [k, ...v] = arg.split("=");
      if (k && v.length > 0) params[k] = v.join("=");
    }
    const validation = validateParams(wf, params);
    if (!validation.valid) {
      tui.logSystem(
        `Validation errors:\n  ${validation.errors.join("\n  ")}`,
      );
      tui.requestRender();
      return;
    }
    const plan = instantiateWorkflow(wf, validation.resolved);
    const saved = polpo.savePlan({
      data: plan.data,
      name: plan.name,
      prompt: plan.prompt,
    });
    polpo.executePlan(saved.id);
    kickRun(polpo);
    tui.logSystem(`Workflow "${name}" executed as plan "${plan.name}"`);
    tui.requestRender();
    return;
  }

  // Picker
  const items = workflows.map((w) => ({
    value: w.name,
    label: w.name,
    description: w.description ?? "",
  }));

  const picker = new PickerOverlay({
    title: "Workflows",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      const wf = loadWorkflow(workDir, polpoDir, item.value);
      if (!wf) return;

      const lines: string[] = [];
      lines.push(chalk.bold(wf.name));
      if (wf.description) lines.push(wf.description);
      lines.push("");
      if (wf.parameters && wf.parameters.length > 0) {
        lines.push(chalk.bold("Parameters:"));
        for (const p of wf.parameters) {
          const req = p.required ? theme.error("*") : "";
          const def =
            p.default !== undefined
              ? theme.dim(` (default: ${p.default})`)
              : "";
          lines.push(`  ${req}${p.name}: ${p.type ?? "string"}${def}`);
          if (p.description)
            lines.push(`    ${theme.dim(p.description)}`);
        }
      }
      lines.push("");
      lines.push(chalk.bold("Usage:"));
      lines.push(`  /workflow ${wf.name} key=value ...`);

      const viewer = new ViewerOverlay({
        title: `Workflow: ${wf.name}`,
        content: lines.join("\n"),
        onClose: () => tui.hideOverlay(),
      });
      tui.showOverlay(viewer);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}
