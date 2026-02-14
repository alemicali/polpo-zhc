/**
 * Task creation action — creates a task from user input.
 * If multiple agents available, shows picker first.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import { seg } from "../format.js";

export function createTask(
  description: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  const agents = polpo.getAgents();

  if (agents.length === 0) {
    store.log("No agents configured. Use /team to add agents.", [
      seg("No agents configured. ", "red"),
      seg("Use ", "gray"),
      seg("/team", "cyan"),
      seg(" to add agents.", "gray"),
    ]);
    return;
  }

  const defaultAgent = store.defaultAgent;

  // Single agent or valid default → create immediately
  if (agents.length === 1) {
    doCreate(description, agents[0]!.name, polpo, store);
    return;
  }

  if (defaultAgent && agents.find((a) => a.name === defaultAgent)) {
    doCreate(description, defaultAgent, polpo, store);
    return;
  }

  // Multiple agents, no default → show picker
  store.navigate({
    id: "picker",
    title: "Assign task to agent",
    items: agents.map((a) => ({
      label: a.name,
      value: a.name,
      description: a.role ?? a.adapter,
    })),
    hint: "↑↓ navigate  Enter select  Esc cancel  d = set default",
    onSelect: (_idx, value) => {
      store.goMain();
      doCreate(description, value, polpo, store);
    },
    onCancel: () => {
      store.goMain();
      store.log("Task creation cancelled", [seg("Task creation cancelled", "gray")]);
    },
    onKey: (input, _idx, value) => {
      if (input === "d") {
        store.setDefaultAgent(value);
        store.log(`Default agent set to ${value}`, [
          seg("Default agent: ", "gray"),
          seg(value, "cyan", true),
        ]);
      }
    },
  });
}

function doCreate(
  description: string,
  agentName: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  const title = description.length > 80
    ? description.slice(0, 77) + "..."
    : description;

  const task = polpo.addTask({
    title,
    description,
    assignTo: agentName,
  });

  store.log(`Task created: ${task.title}`, [
    seg("+ ", "green"),
    seg(task.title, undefined, true),
    seg(` → ${agentName}`, "gray"),
  ]);

  // Start orchestrator if not already running
  polpo.run().catch(() => {
    // Already running or error — both fine
  });
}
