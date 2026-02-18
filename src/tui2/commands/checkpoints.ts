import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { PickerOverlay } from "../overlays/picker.js";

export function cmdCheckpoints(api: CommandAPI): void {
  const { polpo, tui, args } = api;

  const checkpoints = polpo.getActiveCheckpoints();
  if (checkpoints.length === 0) {
    tui.logSystem("No active checkpoints");
    tui.requestRender();
    return;
  }

  // /checkpoints resume <group> <name>
  if (args[0] === "resume" && args.length >= 3) {
    const group = args[1]!;
    const name = args.slice(2).join(" ");
    const ok = polpo.resumeCheckpoint(group, name);
    if (ok) {
      tui.logSystem(theme.done(`✓ Resumed checkpoint "${name}" in group "${group}"`));
    } else {
      tui.logSystem(theme.error(`Checkpoint not found: ${group}/${name}`));
    }
    tui.requestRender();
    return;
  }

  // List
  if (args[0] === "list") {
    for (const cp of checkpoints) {
      const reachedDate = new Date(cp.reachedAt).toLocaleString();
      tui.logSystem(`  ${theme.info(cp.group)} / ${cp.checkpointName} — reached ${theme.dim(reachedDate)}`);
    }
    tui.requestRender();
    return;
  }

  // Default: picker with resume action
  const items = checkpoints.map((cp) => ({
    value: `${cp.group}::${cp.checkpointName}`,
    label: `${cp.group} / ${cp.checkpointName}`,
    description: `Reached ${new Date(cp.reachedAt).toLocaleString()}`,
  }));

  const picker = new PickerOverlay({
    title: "Active Checkpoints",
    hint: "Enter: resume · Esc: close",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      const [group, ...nameParts] = item.value.split("::");
      const name = nameParts.join("::");
      if (group && name) {
        const ok = polpo.resumeCheckpoint(group, name);
        if (ok) {
          tui.logSystem(theme.done(`✓ Resumed checkpoint "${name}" in group "${group}"`));
        } else {
          tui.logSystem(theme.error(`Failed to resume checkpoint`));
        }
      }
      tui.requestRender();
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}
