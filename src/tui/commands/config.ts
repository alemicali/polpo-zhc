/**
 * /config — view and edit settings.
 * /config          → show current settings
 * /config edit     → open settings editor as picker
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdConfig({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "edit") {
    configEdit(polpo, store);
    return;
  }

  configView(polpo, store);
}

function configView(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const config = polpo.getConfig();
  if (!config) {
    store.log("No configuration loaded", [seg("No configuration loaded", "gray")]);
    return;
  }

  const s = config.settings;
  const lines: [string, string][] = [
    ["Project", config.project],
    ["Version", config.version],
    ["Team", `${config.team.name} (${config.team.agents.length} agents)`],
    ["Max retries", `${s.maxRetries}`],
    ["Log level", s.logLevel],
    ["Task timeout", s.taskTimeout ? `${(s.taskTimeout / 60000).toFixed(0)}min` : "30min"],
    ["Stale threshold", s.staleThreshold ? `${(s.staleThreshold / 60000).toFixed(0)}min` : "5min"],
    ["Volatile teams", s.enableVolatileTeams !== false ? "enabled" : "disabled"],
    ["Auto-correct", s.autoCorrectExpectations !== false ? "enabled" : "disabled"],
    ["Orchestrator model", s.orchestratorModel ?? "(default)"],
  ];

  store.log("Configuration:", [seg("Configuration:", undefined, true)]);
  for (const [label, value] of lines) {
    store.log(`  ${label}: ${value}`, [
      seg(`  ${label}: `, "gray"),
      seg(value),
    ]);
  }

  store.log("", [
    seg("  /config edit", "cyan"),
    seg(" to modify settings", "gray"),
  ]);
}

function configEdit(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const config = polpo.getConfig();
  if (!config) {
    store.log("No configuration loaded", [seg("No configuration loaded", "gray")]);
    return;
  }

  const s = config.settings;
  const fields = [
    { label: `logLevel: ${s.logLevel}`, value: "logLevel", description: "quiet | normal | verbose" },
    { label: `maxRetries: ${s.maxRetries}`, value: "maxRetries", description: "Max task retries" },
    { label: `orchestratorModel: ${s.orchestratorModel ?? "(default)"}`, value: "orchestratorModel", description: "Model for LLM calls" },
    { label: `autoCorrect: ${s.autoCorrectExpectations !== false}`, value: "autoCorrectExpectations", description: "Auto-correct expectations" },
    { label: `enableVolatileTeams: ${s.enableVolatileTeams !== false}`, value: "enableVolatileTeams", description: "Allow plan-defined agents" },
  ];

  store.navigate({
    id: "picker",
    title: "Edit Settings",
    items: fields,
    hint: "Enter to edit  Esc back",
    onSelect: (_idx, field) => {
      const current = (s as unknown as Record<string, unknown>)[field];
      store.navigate({
        id: "editor",
        title: `settings.${field}`,
        initial: current != null ? String(current) : "",
        onSave: (value) => {
          // Parse value based on field type
          let parsed: unknown = value.trim();
          if (parsed === "true") parsed = true;
          else if (parsed === "false") parsed = false;
          else if (/^\d+$/.test(parsed as string)) parsed = parseInt(parsed as string, 10);

          (s as unknown as Record<string, unknown>)[field] = parsed || undefined;
          store.goMain();
          store.log(`Updated settings.${field}`, [
            seg(`settings.${field} = `, "gray"),
            seg(String(parsed ?? "(cleared)")),
          ]);
        },
        onCancel: () => configEdit(polpo, store),
      });
    },
    onCancel: () => store.goMain(),
  });
}
