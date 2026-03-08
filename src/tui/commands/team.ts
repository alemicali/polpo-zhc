/**
 * /team — manage team agents (list, add, remove, edit).
 * Subcommands: /team, /team add, /team remove [name], /team edit [name]
 */

import type { CommandAPI } from "./types.js";
import type { AgentConfig } from "../../core/types.js";
import { seg } from "../format.js";

export function cmdTeam({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "add") {
    teamAdd(polpo, store);
  } else if (sub === "remove" || sub === "rm") {
    teamRemove(polpo, store, args[1]);
  } else if (sub === "edit") {
    teamEdit(polpo, store, args[1]);
  } else if (sub === "rename") {
    teamRename(polpo, store, args.slice(1).join(" "));
  } else {
    teamList(polpo, store);
  }
}

function teamList(polpo: import("../../core/orchestrator.js").Orchestrator, store: import("../store.js").TUIStore) {
  const team = polpo.getTeam();
  const teamName = team?.name ?? "default";
  const agents = team?.agents ?? [];

  store.log(`Team: ${teamName} (${agents.length} agents)`, [
    seg("Team: ", "gray"),
    seg(teamName, undefined, true),
    seg(` (${agents.length} agents)`, "gray"),
  ]);

  for (const agent of agents) {
    const parts = [
      seg("  "),
      seg(agent.name, "cyan", true),
    ];
    if (agent.model) parts.push(seg(` ${agent.model}`, "gray", false, true));
    if (agent.role) parts.push(seg(` — ${agent.role}`, "gray", false, true));
    if (agent.reportsTo) parts.push(seg(` → ${agent.reportsTo}`, "gray"));
    if (agent.createdAt) parts.push(seg(` (${agent.createdAt.slice(0, 10)})`, "gray"));
    store.log(`  ${agent.name}`, parts);
  }

  store.log("", [
    seg("  /team add", "cyan"),
    seg(" | ", "gray"),
    seg("/team remove", "cyan"),
    seg(" | ", "gray"),
    seg("/team edit", "cyan"),
    seg(" | ", "gray"),
    seg("/team rename", "cyan"),
  ]);
}

function teamAdd(polpo: import("../../core/orchestrator.js").Orchestrator, store: import("../store.js").TUIStore) {
  store.navigate({
    id: "editor",
    title: "Agent name",
    initial: "",
    onSave: (name) => {
      const trimmed = name.trim();
      if (!trimmed) {
        store.goMain();
        store.log("Agent name cannot be empty", [seg("Agent name cannot be empty", "red")]);
        return;
      }

      // Check duplicates
      if (polpo.getAgents().find((a) => a.name === trimmed)) {
        store.goMain();
        store.log(`Agent "${trimmed}" already exists`, [seg(`Agent "${trimmed}" already exists`, "red")]);
        return;
      }

      const agent: AgentConfig = { name: trimmed };

      polpo.addAgent(agent);
      store.goMain();
      store.log(`Added agent: ${trimmed}`, [
        seg("+ ", "green"),
        seg(trimmed, "cyan", true),
      ]);
    },
    onCancel: () => {
      store.goMain();
      store.log("Agent creation cancelled", [seg("Cancelled", "gray")]);
    },
  });
}

async function teamRemove(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  name?: string,
) {
  const agents = polpo.getAgents();

  if (agents.length === 0) {
    store.log("No agents to remove", [seg("No agents to remove", "gray")]);
    return;
  }

  if (name) {
    // Direct removal
    const removed = await polpo.removeAgent(name);
    if (removed) {
      store.log(`Removed agent: ${name}`, [seg("- ", "red"), seg(name, undefined, true)]);
    } else {
      store.log(`Agent not found: ${name}`, [seg(`Agent not found: ${name}`, "red")]);
    }
    return;
  }

  // Show picker
  store.navigate({
    id: "picker",
    title: "Remove agent",
    items: agents.map((a) => ({
      label: a.name,
      value: a.name,
      description: `${a.role ?? ""}${a.model ? ` • ${a.model}` : ""}`,
    })),
    onSelect: async (_idx, value) => {
      store.goMain();
      const removed = await polpo.removeAgent(value);
      if (removed) {
        store.log(`Removed agent: ${value}`, [seg("- ", "red"), seg(value, undefined, true)]);
      }
    },
    onCancel: () => store.goMain(),
  });
}

function teamEdit(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  name?: string,
) {
  const agents = polpo.getAgents();
  if (agents.length === 0) {
    store.log("No agents to edit", [seg("No agents to edit", "gray")]);
    return;
  }

  const doEdit = (agent: AgentConfig) => {
    // Show editable fields as picker
    const fields = [
      { label: `model: ${agent.model ?? "(none)"}`, value: "model" },
      { label: `role: ${agent.role ?? "(none)"}`, value: "role" },
      { label: `reportsTo: ${agent.reportsTo ?? "(none)"}`, value: "reportsTo" },
      { label: `systemPrompt: ${agent.systemPrompt ? "set" : "(none)"}`, value: "systemPrompt" },
      { label: `maxTurns: ${agent.maxTurns ?? "default"}`, value: "maxTurns" },
    ];

    store.navigate({
      id: "picker",
      title: `Edit agent: ${agent.name}`,
      items: fields,
      hint: "Enter to edit field  Esc to go back",
      onSelect: (_idx, field) => {
        const current = (agent as unknown as Record<string, unknown>)[field];
        store.navigate({
          id: "editor",
          title: `${agent.name}.${field}`,
          initial: current != null ? String(current) : "",
          onSave: (value) => {
            const trimmed = value.trim();
            // Update agent in-place via remove+add — preserve original team
            const originalTeam = polpo.findAgentTeam(agent.name)?.name;
            polpo.removeAgent(agent.name);
            const updated = { ...agent, [field]: trimmed || undefined };
            polpo.addAgent(updated, originalTeam);
            store.goMain();
            store.log(`Updated ${agent.name}.${field}`, [
              seg(`${agent.name}`, "cyan", true),
              seg(`.${field} = `, "gray"),
              seg(trimmed || "(cleared)"),
            ]);
          },
          onCancel: () => doEdit(agent), // go back to field picker
        });
      },
      onCancel: () => store.goMain(),
    });
  };

  if (name) {
    const agent = agents.find((a) => a.name === name);
    if (!agent) {
      store.log(`Agent not found: ${name}`, [seg(`Agent not found: ${name}`, "red")]);
      return;
    }
    doEdit(agent);
    return;
  }

  // Show agent picker first
  store.navigate({
    id: "picker",
    title: "Edit agent",
    items: agents.map((a) => ({
      label: a.name,
      value: a.name,
      description: `${a.role ?? ""}${a.model ? ` • ${a.model}` : ""}`,
    })),
    onSelect: (_idx, value) => {
      const agent = agents.find((a) => a.name === value);
      if (agent) doEdit(agent);
    },
    onCancel: () => store.goMain(),
  });
}

function teamRename(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  newName: string,
) {
  if (!newName.trim()) {
    store.navigate({
      id: "editor",
      title: "New team name",
      initial: polpo.getTeam()?.name ?? "default",
      onSave: (value) => {
        store.goMain();
        if (value.trim()) {
          const oldName = polpo.getTeam()?.name ?? "default";
          polpo.renameTeam(oldName, value.trim());
          store.log(`Team renamed to: ${value.trim()}`, [
            seg("Team: ", "gray"),
            seg(value.trim(), undefined, true),
          ]);
        }
      },
      onCancel: () => store.goMain(),
    });
    return;
  }

  const oldName = polpo.getTeam()?.name ?? "default";
  polpo.renameTeam(oldName, newName.trim());
  store.log(`Team renamed to: ${newName.trim()}`, [
    seg("Team: ", "gray"),
    seg(newName.trim(), undefined, true),
  ]);
}
