import type { CommandAPI } from "../types.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { EditorOverlay } from "../overlays/editor-page.js";

export function cmdMemory(api: CommandAPI): void {
  const { polpo, tui, args } = api;

  if (args[0] === "append") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      tui.logSystem("Usage: /memory append <text>");
      tui.requestRender();
      return;
    }
    polpo.appendMemory(text);
    tui.logSystem("Memory appended");
    tui.requestRender();
    return;
  }

  if (args[0] === "edit") {
    const current = polpo.getMemory() ?? "";
    const editor = new EditorOverlay({
      title: "Edit Memory",
      initialText: current,
      tui: tui.tuiInstance,
      onSave: (text) => {
        tui.hideOverlay();
        polpo.saveMemory(text);
        tui.logSystem("Memory saved");
        tui.requestRender();
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(editor);
    return;
  }

  const memory = polpo.getMemory();
  if (!memory || !memory.trim()) {
    tui.logSystem("No project memory. Use /memory edit to create one.");
    tui.requestRender();
    return;
  }

  const viewer = new ViewerOverlay({
    title: "Project Memory",
    content: memory,
    actions: [
      {
        label: "Edit",
        handler: () => {
          tui.hideOverlay();
          cmdMemory({ ...api, args: ["edit"] });
        },
      },
      { label: "Close", handler: () => tui.hideOverlay() },
    ],
    onClose: () => tui.hideOverlay(),
  });
  tui.showOverlay(viewer);
}
