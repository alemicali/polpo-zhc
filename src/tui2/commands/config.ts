import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { PickerOverlay } from "../overlays/picker.js";
import { EditorOverlay } from "../overlays/editor-page.js";
import { savePolpoConfig } from "../../core/config.js";

export function cmdConfig(api: CommandAPI): void {
  const { polpo, tui, args } = api;
  const config = polpo.getConfig();
  const settings = config?.settings;

  if (args[0] === "edit") {
    const fields = [
      {
        value: "maxRetries",
        label: "maxRetries",
        description: String(settings?.maxRetries ?? 3),
      },
      {
        value: "logLevel",
        label: "logLevel",
        description: settings?.logLevel ?? "normal",
      },
      {
        value: "taskTimeout",
        label: "taskTimeout",
        description: String(settings?.taskTimeout ?? 600000),
      },
      {
        value: "staleThreshold",
        label: "staleThreshold",
        description: String(settings?.staleThreshold ?? 120000),
      },
      {
        value: "autoCorrectExpectations",
        label: "autoCorrectExpectations",
        description: String(settings?.autoCorrectExpectations ?? true),
      },
    ];

    const picker = new PickerOverlay({
      title: "Edit Config",
      items: fields,
      onSelect: (item) => {
        tui.hideOverlay();
        const editor = new EditorOverlay({
          title: `Edit: ${item.value}`,
          initialText: item.description ?? "",
          tui: tui.tuiInstance,
          onSave: (text) => {
            tui.hideOverlay();
            const trimmed = text.trim();
            let value: string | number | boolean = trimmed;
            if (trimmed === "true") value = true;
            else if (trimmed === "false") value = false;
            else if (/^\d+$/.test(trimmed)) value = parseInt(trimmed, 10);

            const updated = {
              ...config,
              settings: { ...settings, [item.value]: value },
            };
            savePolpoConfig(polpo.getPolpoDir(), updated as any);
            tui.logSystem(`Updated ${item.value} = ${trimmed}`);
            tui.requestRender();
          },
          onCancel: () => tui.hideOverlay(),
        });
        tui.showOverlay(editor);
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(picker);
    return;
  }

  // Default: show config
  const lines: string[] = [];
  lines.push(theme.bold("Configuration"));
  lines.push(`  Project: ${config?.project ?? "unknown"}`);
  lines.push(`  Team: ${config?.teams?.[0]?.name ?? "default"}`);
  lines.push(`  Max Retries: ${settings?.maxRetries ?? 3}`);
  lines.push(`  Log Level: ${settings?.logLevel ?? "normal"}`);
  lines.push(`  Task Timeout: ${settings?.taskTimeout ?? 600000}ms`);
  lines.push(`  Stale Threshold: ${settings?.staleThreshold ?? 120000}ms`);
  lines.push(`  Auto Correct: ${settings?.autoCorrectExpectations ?? true}`);
  tui.logSystem(lines.join("\n"));
  tui.requestRender();
}
