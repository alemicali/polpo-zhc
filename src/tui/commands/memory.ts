/**
 * /memory — view and edit shared or agent-specific memory.
 * Subcommands: (none) = view shared, edit = open editor, agent:<name> = view agent memory.
 * Examples:
 *   /memory              — view shared memory
 *   /memory edit          — edit shared memory
 *   /memory agent:alex   — view agent "alex" memory
 *   /memory agent:alex edit — edit agent "alex" memory
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export async function cmdMemory({ polpo, store, args }: CommandAPI) {
  // Parse args: look for "agent:<name>" and "edit"
  let agentName: string | undefined;
  let isEdit = false;

  for (const arg of args) {
    if (arg === "edit") {
      isEdit = true;
    } else if (arg.startsWith("agent:")) {
      agentName = arg.slice(6);
    }
  }

  if (isEdit) {
    await memoryEdit(polpo, store, agentName);
    return;
  }

  await memoryView(polpo, store, agentName);
}

async function memoryView(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  agentName?: string,
) {
  if (agentName) {
    if (!(await polpo.hasAgentMemory(agentName))) {
      store.log(`No memory for agent "${agentName}". Use /memory agent:${agentName} edit to create one.`, [
        seg(`No memory for agent "${agentName}". `, "gray"),
        seg(`/memory agent:${agentName} edit`, "cyan"),
        seg(" to create.", "gray"),
      ]);
      return;
    }

    const content = await polpo.getAgentMemory(agentName);
    store.navigate({
      id: "viewer",
      title: `Agent Memory: ${agentName}`,
      content: content || "(empty)",
      actions: ["Edit", "Close"],
      onAction: (idx) => {
        store.goMain();
        if (idx === 0) memoryEdit(polpo, store, agentName);
      },
      onClose: () => store.goMain(),
    });
    return;
  }

  // Shared memory
  if (!(await polpo.hasMemory())) {
    store.log("No shared memory yet. Use /memory edit to create one.", [
      seg("No shared memory. ", "gray"),
      seg("/memory edit", "cyan"),
      seg(" to create.", "gray"),
    ]);
    return;
  }

  const content = await polpo.getMemory();
  store.navigate({
    id: "viewer",
    title: "Shared Memory",
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
  agentName?: string,
) {
  let current: string;
  if (agentName) {
    current = (await polpo.hasAgentMemory(agentName)) ? await polpo.getAgentMemory(agentName) : "";
  } else {
    current = (await polpo.hasMemory()) ? await polpo.getMemory() : "";
  }

  const title = agentName ? `Edit Agent Memory: ${agentName}` : "Edit Shared Memory";

  store.navigate({
    id: "editor",
    title,
    initial: current,
    onSave: (value) => {
      store.goMain();
      if (agentName) {
        polpo.saveAgentMemory(agentName, value);
      } else {
        polpo.saveMemory(value);
      }
      const target = agentName ? `Agent "${agentName}" memory` : "Shared memory";
      store.log(`${target} saved`, [seg("\u2713 ", "green"), seg(`${target} saved`, "gray")]);
    },
    onCancel: () => {
      store.goMain();
      store.log("Memory edit cancelled", [seg("Cancelled", "gray")]);
    },
  });
}
