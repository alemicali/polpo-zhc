import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import {
  discoverTemplates,
  loadTemplate,
  validateParams,
  instantiateTemplate,
} from "../../core/template.js";

export async function cmdTemplate(api: CommandAPI): Promise<void> {
  const { polpo, tui, args } = api;
  const workDir = polpo.getWorkDir();
  const polpoDir = polpo.getPolpoDir();

  const templates = discoverTemplates(workDir, polpoDir);
  if (templates.length === 0) {
    tui.logSystem(
      "No templates found. Place template.json files in .polpo/templates/<name>/",
    );
    tui.requestRender();
    return;
  }

  // Direct execution: /template <name> [k=v ...]
  if (args.length > 0 && args[0] !== "list") {
    const name = args[0]!;
    const tpl = loadTemplate(workDir, polpoDir, name);
    if (!tpl) {
      tui.logSystem(`Template not found: ${name}`);
      tui.requestRender();
      return;
    }
    // Parse k=v params
    const params: Record<string, string> = {};
    for (const arg of args.slice(1)) {
      const [k, ...v] = arg.split("=");
      if (k && v.length > 0) params[k] = v.join("=");
    }
    const validation = validateParams(tpl, params);
    if (!validation.valid) {
      tui.logSystem(
        `Validation errors:\n  ${validation.errors.join("\n  ")}`,
      );
      tui.requestRender();
      return;
    }
    const mission = instantiateTemplate(tpl, validation.resolved);
    const saved = polpo.saveMission({
      data: mission.data,
      name: mission.name,
      prompt: mission.prompt,
    });
    polpo.executeMission(saved.id);
    kickRun(polpo);
    tui.logSystem(`Template "${name}" executed as mission "${mission.name}"`);
    tui.requestRender();
    return;
  }

  // Picker
  const items = templates.map((t) => ({
    value: t.name,
    label: t.name,
    description: t.description ?? "",
  }));

  const picker = new PickerOverlay({
    title: "Templates",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      const tpl = loadTemplate(workDir, polpoDir, item.value);
      if (!tpl) return;

      const lines: string[] = [];
      lines.push(chalk.bold(tpl.name));
      if (tpl.description) lines.push(tpl.description);
      lines.push("");
      if (tpl.parameters && tpl.parameters.length > 0) {
        lines.push(chalk.bold("Parameters:"));
        for (const p of tpl.parameters) {
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
      lines.push(`  /template ${tpl.name} key=value ...`);

      const viewer = new ViewerOverlay({
        title: `Template: ${tpl.name}`,
        content: lines.join("\n"),
        onClose: () => tui.hideOverlay(),
      });
      tui.showOverlay(viewer);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}
