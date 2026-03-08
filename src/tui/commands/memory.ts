/**
 * /memory — view and edit project memory.
 * Subcommands: (none) = view, edit = open editor.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export async function cmdMemory({ polpo, store, args }: CommandAPI) {
  const sub = args[0];

  if (sub === "edit") {
    await memoryEdit(polpo, store);
    return;
  }

  // Default: view memory
  await memoryView(polpo, store);
}

async function memoryView(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  if (!(await polpo.hasMemory())) {
    store.log("No project memory yet. Use /memory edit to create one.", [
      seg("No project memory. ", "gray"),
      seg("/memory edit", "cyan"),
      seg(" to create.", "gray"),
    ]);
    return;
  }

  const content = await polpo.getMemory();
  store.navigate({
    id: "viewer",
    title: "Project Memory",
    content: content || "(empty)",
    actions: ["Edit", "Close"],
    onAction: (idx) => {
      store.goMain();
      if (idx === 0) memoryEdit(polpo, store);
    },
    onClose: () => store.goMain(),
  });
}

async function memoryEdit(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const current = (await polpo.hasMemory()) ? await polpo.getMemory() : "";

  store.navigate({
    id: "editor",
    title: "Edit Project Memory",
    initial: current,
    onSave: (value) => {
      store.goMain();
      polpo.saveMemory(value);
      store.log("Project memory saved", [seg("✓ ", "green"), seg("Memory saved", "gray")]);
    },
    onCancel: () => {
      store.goMain();
      store.log("Memory edit cancelled", [seg("Cancelled", "gray")]);
    },
  });
}
