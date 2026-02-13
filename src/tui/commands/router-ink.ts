/**
 * Ink-native command router — full-fidelity port of all blessed TUI commands.
 * Dispatches slash commands using store overlays (picker, text-input, yaml-editor, content-viewer).
 */

import chalk from "chalk";
import { useTUIStore, type LogSeg } from "../store.js";
import { PROVIDERS, MODELS, SLASH_COMMANDS, SHORTCUTS } from "../constants.js";
import { getProviderLabel, formatElapsed } from "../formatters.js";
import { readSessionSummary } from "../../core/session-reader.js";
import { cmdWatchInk } from "./watch.js";
import type { Task, TaskStatus } from "../../core/types.js";
import type { SessionInfo } from "../../core/log-store.js";
import { parse as parseYaml } from "yaml";

/** Shorthand segment constructor */
const seg = (text: string, color?: string, bold?: boolean, dim?: boolean): LogSeg => ({ text, color, bold, dim });

export type InkCommandHandler = (args: string[]) => void | Promise<void>;

const commands: Record<string, InkCommandHandler> = {
  "/status": cmdStatus,
  "/result": cmdResult,
  "/help": cmdHelp,
  "/clear": cmdClear,
  "/quit": cmdQuit,
  "/config": cmdConfig,
  "/team": cmdTeam,
  "/tasks": cmdTasks,
  "/inspect": cmdTasks,
  "/plans": cmdPlans,
  "/resume": cmdResume,
  "/plan": () => {}, // plan mode handles this
  "/memory": cmdMemory,
  "/logs": cmdLogs,
  "/abort": cmdAbort,
  "/clear-tasks": cmdClearTasks,
  "/reassess": cmdReassess,
  "/edit-plan": cmdEditPlan,
  "/sessions": cmdSessions,
  "/new-chat": cmdNewChat,
  "/watch": cmdWatchInk,
};

/** Dispatch a slash command. Returns true if handled. */
export function dispatchInkCommand(cmd: string): boolean {
  const parts = cmd.split(/\s+/);
  const command = parts[0]!.toLowerCase();
  const handler = commands[command];
  if (handler) {
    handler(parts.slice(1));
    return true;
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────

function statusIconPlain(status: TaskStatus): string {
  switch (status) {
    case "pending": return "○";
    case "assigned": return "◉";
    case "in_progress": return "●";
    case "review": return "●";
    case "done": return "✓";
    case "failed": return "✗";
  }
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending": return "PENDING";
    case "assigned": return "ASSIGNED";
    case "in_progress": return "RUNNING";
    case "review": return "REVIEW";
    case "done": return "DONE";
    case "failed": return "FAILED";
  }
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case "pending": return "gray";
    case "assigned": return "cyan";
    case "in_progress": return "yellow";
    case "review": return "magenta";
    case "done": return "green";
    case "failed": return "red";
  }
}

/** Colored icon + text for Picker labels (chalk ANSI) */
function coloredIcon(status: TaskStatus): string {
  const icon = statusIconPlain(status);
  switch (status) {
    case "pending": return chalk.gray(icon);
    case "assigned": return chalk.cyan(icon);
    case "in_progress": return chalk.yellow(icon);
    case "review": return chalk.magenta(icon);
    case "done": return chalk.green(icon);
    case "failed": return chalk.red(icon);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /status — Detailed per-task status ──────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdStatus() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  if (!state || state.tasks.length === 0) {
    store.logAlways("No tasks found");
    return;
  }

  store.logAlways("", []);
  store.logAlways("Task Status:", [seg("Task Status:", undefined, true)]);
  for (const task of state.tasks) {
    const icon = statusIconPlain(task.status);
    const color = statusColor(task.status);
    const label = statusLabel(task.status);
    const dur = task.result ? ` (${(task.result.duration / 1000).toFixed(1)}s)` : "";
    const score = task.result?.assessment?.globalScore !== undefined
      ? ` [${task.result.assessment.globalScore.toFixed(1)}/5]`
      : "";
    const scoreColor = task.result?.assessment?.globalScore !== undefined
      ? (task.result.assessment.globalScore >= 4 ? "green" : task.result.assessment.globalScore >= 3 ? "yellow" : "red")
      : undefined;
    store.logAlways(`  ${icon} ${label.padEnd(9)} ${task.title}${dur}${score}`, [
      seg("  "),
      seg(icon, color),
      seg(` ${label.padEnd(9)}`, color),
      seg(` ${task.title}`),
      ...(dur ? [seg(dur, "gray")] : []),
      ...(score ? [seg(score, scoreColor)] : []),
    ]);

    if (task.result?.assessment?.scores) {
      for (const sc of task.result.assessment.scores) {
        const filled = "★".repeat(sc.score);
        const empty = "☆".repeat(5 - sc.score);
        const dimColor = sc.score >= 4 ? "green" : sc.score >= 3 ? "yellow" : "red";
        store.logAlways(`    ${filled}${empty} ${sc.dimension}`, [
          seg("    "),
          seg(filled, dimColor),
          seg(empty, "gray"),
          seg(` ${sc.dimension}`, "gray"),
        ]);
      }
    }
  }
  store.logAlways("", []);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /result — Full assessment of last completed task ────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdResult() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  if (!state || state.tasks.length === 0) {
    store.logAlways("No tasks found");
    return;
  }

  const withResult = [...state.tasks]
    .filter((t) => t.result)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (withResult.length === 0) {
    store.logAlways("No task results yet");
    return;
  }

  const task = withResult[0]!;
  const r = task.result!;

  const color = statusColor(task.status);
  store.logAlways("", []);
  store.logAlways(`Result: ${task.title} [${task.id}]`, [
    seg("Result: ", undefined, true),
    seg(task.title, "cyan", true),
    seg(` [${task.id}]`, "gray"),
  ]);
  const exitColor = r.exitCode === 0 ? "green" : "red";
  store.logAlways(`Status: ${task.status} | Duration: ${(r.duration / 1000).toFixed(1)}s | Exit: ${r.exitCode}`, [
    seg("Status: ", "gray"),
    seg(statusLabel(task.status), color),
    seg(` | Duration: ${(r.duration / 1000).toFixed(1)}s`, "gray"),
    seg(` | Exit: `, "gray"),
    seg(String(r.exitCode), exitColor),
  ]);

  if (r.assessment?.globalScore !== undefined) {
    const scoreColor = r.assessment.globalScore >= 4 ? "green" : r.assessment.globalScore >= 3 ? "yellow" : "red";
    store.logAlways(`Score: ${r.assessment.globalScore.toFixed(1)}/5`, [
      seg("Score: ", "gray"),
      seg(`${r.assessment.globalScore.toFixed(1)}/5`, scoreColor, true),
    ]);
    if (r.assessment.scores) {
      for (const s of r.assessment.scores) {
        const filled = "★".repeat(s.score);
        const empty = "☆".repeat(5 - s.score);
        const dimColor = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
        store.logAlways(`  ${filled}${empty} ${s.dimension}`, [
          seg("  "),
          seg(filled, dimColor),
          seg(empty, "gray"),
          seg(` ${s.dimension}`, "gray"),
        ]);
      }
    }
  }

  store.logAlways("", []);
  if (r.stdout) {
    for (const line of r.stdout.split("\n")) {
      store.logAlways(`  ${line}`);
    }
  }
  store.logAlways("", []);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /help ───────────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdHelp() {
  const store = useTUIStore.getState();

  const cmds = Object.entries(SLASH_COMMANDS)
    .map(([cmd, desc]) => `  ${chalk.cyan(cmd.padEnd(16))} ${chalk.gray(desc)}`)
    .join("\n");

  const shortcuts = Object.entries(SHORTCUTS)
    .map(([key, desc]) => `  ${chalk.yellow(key.padEnd(12))} ${chalk.gray(desc)}`)
    .join("\n");

  store.openOverlay("content-viewer", {
    title: "Help",
    content: `${chalk.bold("Commands:")}\n${cmds}\n\n${chalk.bold("Shortcuts:")}\n${shortcuts}`,
  });
}

function cmdClear() {
  useTUIStore.getState().clearLogs();
}

function cmdQuit() {
  useTUIStore.getState().setQuitting(true);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /config — 7-option configuration menu ───────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdConfig() {
  const store = useTUIStore.getState();
  const config = store.config;
  const settings = store.orchestrator?.getConfig()?.settings;

  const modelLabel = config.model
    ? MODELS.find((m) => m.value === config.model)?.label ?? config.model
    : "default";
  const judgeModelLabel = config.judgeModel
    ? MODELS.find((m) => m.value === config.judgeModel)?.label ?? config.judgeModel
    : "default";
  const volatileEnabled = settings?.enableVolatileTeams !== false;
  const volatileCleanup = (settings as any)?.volatileCleanup ?? "on_complete";
  const taskPrepEnabled = config.taskPrep !== false;

  const onOff = (v: boolean) => v ? chalk.green("enabled") : chalk.red("disabled");
  const items = [
    { label: `${chalk.gray("Judge:")}         ${chalk.cyan(getProviderLabel(config.judge))}`, value: "judge" },
    { label: `${chalk.gray("Judge Model:")}   ${chalk.cyan(judgeModelLabel)}`, value: "judge-model" },
    { label: `${chalk.gray("Orchestrator:")}  ${chalk.cyan(getProviderLabel(config.agent))}`, value: "agent" },
    { label: `${chalk.gray("Agent Model:")}   ${chalk.cyan(modelLabel)}`, value: "agent-model" },
    { label: `${chalk.gray("Task Prep:")}     ${onOff(taskPrepEnabled)}`, value: "task-prep" },
    { label: `${chalk.gray("Volatile Teams:")} ${onOff(volatileEnabled)}`, value: "volatile" },
    { label: `${chalk.gray("Volatile Cleanup:")} ${chalk.cyan(volatileCleanup)}`, value: "volatile-cleanup" },
  ];

  store.openOverlay("picker", {
    title: "Configuration",
    items,
    onSelect: (_index: number, value: string) => {
      handleConfigSelect(value);
    },
  });
}

function handleConfigSelect(key: string) {
  const store = useTUIStore.getState();

  if (key === "task-prep") {
    const current = store.config.taskPrep !== false;
    store.setConfig({ ...store.config, taskPrep: !current });
    store.logAlways(`Task preparation ${!current ? "enabled" : "disabled"}`);
    return;
  }

  if (key === "volatile") {
    const cfg = store.orchestrator?.getConfig();
    if (cfg) {
      const current = cfg.settings.enableVolatileTeams !== false;
      cfg.settings.enableVolatileTeams = !current;
      store.logAlways(`Volatile teams ${!current ? "enabled" : "disabled"}`);
    }
    return;
  }

  if (key === "volatile-cleanup") {
    const cfg = store.orchestrator?.getConfig();
    if (cfg) {
      const current = (cfg.settings as any).volatileCleanup ?? "on_complete";
      (cfg.settings as any).volatileCleanup = current === "on_complete" ? "manual" : "on_complete";
      store.logAlways(`Volatile cleanup: ${(cfg.settings as any).volatileCleanup}`);
    }
    return;
  }

  // Provider/model pickers
  if (key === "judge" || key === "agent") {
    const items = PROVIDERS.filter((p) => p.available).map((p) => ({
      label: p.label,
      value: p.value,
    }));
    store.openOverlay("picker", {
      title: key === "judge" ? "Select Judge" : "Select Orchestrator",
      items,
      onSelect: (_idx: number, value: string) => {
        if (key === "judge") {
          store.setConfig({ ...store.config, judge: value });
          // Sync judge model
          const cfg = store.orchestrator?.getConfig();
          if (cfg) cfg.settings.orchestratorModel = store.config.judgeModel || undefined;
          store.logAlways(`Judge changed to ${getProviderLabel(value)}`);
        } else {
          store.setConfig({ ...store.config, agent: value });
          const team = store.orchestrator?.getTeam();
          if (team) {
            for (const a of team.agents) a.adapter = value;
          }
          store.logAlways(`Orchestrator changed to ${getProviderLabel(value)}`);
        }
      },
    });
    return;
  }

  if (key === "judge-model" || key === "agent-model") {
    const adapter = key === "judge-model" ? store.config.judge : store.config.agent;
    const available = MODELS.filter((m) => m.adapter === adapter);
    const items = available.map((m) => ({ label: `${m.label} (${m.value})`, value: m.value }));
    store.openOverlay("picker", {
      title: key === "judge-model" ? "Select Judge Model" : "Select Agent Model",
      items,
      onSelect: (_idx: number, value: string) => {
        if (key === "judge-model") {
          store.setConfig({ ...store.config, judgeModel: value });
          const cfg = store.orchestrator?.getConfig();
          if (cfg) cfg.settings.orchestratorModel = value;
          store.logAlways(`Judge model changed to ${value}`);
        } else {
          store.setConfig({ ...store.config, model: value });
          const team = store.orchestrator?.getTeam();
          if (team) {
            for (const a of team.agents) a.model = value;
          }
          store.logAlways(`Agent model changed to ${value}`);
        }
      },
    });
    return;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /team — Full team management ────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdTeam() {
  showTeamMenu();
}

function showTeamMenu() {
  const store = useTUIStore.getState();
  const team = store.orchestrator?.getTeam();
  if (!team) {
    store.logAlways("No team loaded.");
    return;
  }

  const agents = store.orchestrator!.getAgents();
  const items = agents.map((a) => {
    const model = a.model ? chalk.gray(` (${MODELS.find((m) => m.value === a.model)?.label ?? a.model})`) : "";
    const skillsBadge = a.skills?.length ? chalk.yellow(` ⚡${a.skills.length}`) : "";
    const sysPrompt = a.systemPrompt ? chalk.blue(" ✎") : "";
    const def = a.name === store.defaultAgent ? chalk.green(" ★") : "";
    return {
      label: `${chalk.bold(a.name)}  ${chalk.cyan(a.adapter)}  ${chalk.gray(a.role || "-")}${model}${skillsBadge}${sysPrompt}${def}`,
      value: a.name,
    };
  });

  items.push({ label: chalk.green("+ Add agent"), value: "__add__" });
  items.push({ label: chalk.magenta("✦ Generate team with AI"), value: "__ai__" });

  store.openOverlay("picker", {
    title: `Team: ${team.name} (${agents.length} agents)`,
    items,
    hint: "Enter edit  d delete  r rename  * default  t team name  Esc close",
    onSelect: (_idx: number, value: string) => {
      if (value === "__add__") {
        showAddAgentWizard();
      } else if (value === "__ai__") {
        showAITeamPrompt();
      } else {
        showEditAgentMenu(value);
      }
    },
    onKey: (input: string, _key: any, _idx: number, value: string) => {
      if (value === "__add__" || value === "__ai__") return;

      // d = delete agent
      if (input === "d") {
        if (agents.length <= 1) {
          store.logAlways("Cannot remove the last agent");
          return;
        }
        store.orchestrator?.removeAgent(value);
        if (value === store.defaultAgent) {
          const remaining = store.orchestrator?.getAgents() ?? [];
          store.setDefaultAgent(remaining[0]?.name ?? "dev");
        }
        store.logAlways(`Agent "${value}" removed`);
        store.closeOverlay();
        showTeamMenu();
        return;
      }

      // r = rename agent
      if (input === "r") {
        store.closeOverlay();
        store.openOverlay("text-input", {
          title: `Rename "${value}"`,
          initial: value,
          onSubmit: (newName: string) => {
            if (newName && newName !== value) {
              const existing = store.orchestrator?.getAgents().find((a) => a.name === newName);
              if (existing) {
                store.logAlways(`Agent "${newName}" already exists`);
              } else {
                const agent = store.orchestrator?.getAgents().find((a) => a.name === value);
                if (agent) {
                  agent.name = newName;
                  if (store.defaultAgent === value) store.setDefaultAgent(newName);
                  store.logAlways(`Renamed: ${value} → ${newName}`);
                }
              }
            }
            showTeamMenu();
          },
          onCancel: () => showTeamMenu(),
        });
        return;
      }

      // * = set default
      if (input === "*") {
        store.setDefaultAgent(value);
        store.logAlways(`Default agent: ${value}`);
        store.closeOverlay();
        showTeamMenu();
        return;
      }

      // t = rename team
      if (input === "t") {
        store.closeOverlay();
        store.openOverlay("text-input", {
          title: "Team Name",
          initial: team!.name,
          onSubmit: (name: string) => {
            if (name) {
              store.orchestrator?.renameTeam(name);
              store.logAlways(`Team renamed to "${name}"`);
            }
            showTeamMenu();
          },
          onCancel: () => showTeamMenu(),
        });
        return;
      }
    },
  });
}

function showAddAgentWizard() {
  const store = useTUIStore.getState();

  // Step 1: Name
  store.openOverlay("text-input", {
    title: "Step 1/4 — Agent name",
    onSubmit: (name: string) => {
      if (!name.trim()) { showTeamMenu(); return; }
      // Step 2: Adapter
      const adapterItems = PROVIDERS.filter((p) => p.available).map((p) => ({
        label: p.label,
        value: p.value,
      }));
      store.openOverlay("picker", {
        title: "Step 2/4 — Adapter",
        items: adapterItems,
        onSelect: (_idx: number, adapter: string) => {
          // Step 3: Model
          const modelItems = MODELS.filter((m) => m.adapter === adapter);
          if (modelItems.length > 0) {
            store.openOverlay("picker", {
              title: "Step 3/4 — Model",
              items: modelItems.map((m) => ({ label: `${m.label} (${m.value})`, value: m.value })),
              onSelect: (_idx2: number, model: string) => {
                // Step 4: Role
                store.openOverlay("text-input", {
                  title: "Step 4/4 — Role (optional, Enter to skip)",
                  onSubmit: (role: string) => {
                    finishAddAgent(name.trim(), adapter, model, role.trim());
                  },
                  onCancel: () => finishAddAgent(name.trim(), adapter, model, ""),
                });
              },
              onCancel: () => showTeamMenu(),
            });
          } else {
            // No models, skip to role
            store.openOverlay("text-input", {
              title: "Step 4/4 — Role (optional, Enter to skip)",
              onSubmit: (role: string) => {
                finishAddAgent(name.trim(), adapter, "", role.trim());
              },
              onCancel: () => finishAddAgent(name.trim(), adapter, "", ""),
            });
          }
        },
        onCancel: () => showTeamMenu(),
      });
    },
    onCancel: () => showTeamMenu(),
  });
}

function finishAddAgent(name: string, adapter: string, model: string, role: string) {
  const store = useTUIStore.getState();
  try {
    store.orchestrator?.addAgent({
      name,
      adapter,
      model: model || undefined,
      role: role || undefined,
    });
    store.logAlways(`Agent "${name}" added (${adapter})`);
  } catch (err: any) {
    store.logAlways(`Error: ${err.message}`);
  }
  showTeamMenu();
}

function showEditAgentMenu(agentName: string) {
  const store = useTUIStore.getState();
  const agent = store.orchestrator?.getAgents().find((a) => a.name === agentName);
  if (!agent) { showTeamMenu(); return; }

  const modelLabel = agent.model
    ? MODELS.find((m) => m.value === agent.model)?.label ?? agent.model
    : "default";
  const truncPrompt = agent.systemPrompt
    ? agent.systemPrompt.replace(/\n/g, " ").slice(0, 60) + (agent.systemPrompt.length > 60 ? "…" : "")
    : "-";
  const skillsLabel = agent.skills?.length ? agent.skills.join(", ") : "-";

  const items = [
    { label: `${chalk.gray("Adapter")}       ${chalk.cyan(getProviderLabel(agent.adapter))}`, value: "adapter" },
    { label: `${chalk.gray("Model")}         ${chalk.cyan(modelLabel)}`, value: "model" },
    { label: `${chalk.gray("Role")}          ${agent.role || chalk.gray("-")}`, value: "role" },
    { label: `${chalk.gray("System Prompt")} ${chalk.blue(truncPrompt)}`, value: "system-prompt" },
    { label: `${chalk.gray("Skills")}        ${chalk.yellow(skillsLabel)}`, value: "skills" },
  ];

  store.openOverlay("picker", {
    title: `Edit: ${agent.name}`,
    items,
    onSelect: (_idx: number, value: string) => {
      if (value === "adapter") {
        const adapterItems = PROVIDERS.filter((p) => p.available).map((p) => ({
          label: p.label,
          value: p.value,
        }));
        store.openOverlay("picker", {
          title: "Select Adapter",
          items: adapterItems,
          onSelect: (_i: number, v: string) => {
            agent.adapter = v;
            store.logAlways(`${agent.name}: adapter → ${getProviderLabel(v)}`);
            showTeamMenu();
          },
          onCancel: () => showEditAgentMenu(agentName),
        });
      } else if (value === "model") {
        const available = MODELS.filter((m) => m.adapter === agent.adapter);
        if (available.length === 0) {
          store.logAlways("No models for this adapter");
          showEditAgentMenu(agentName);
          return;
        }
        store.openOverlay("picker", {
          title: "Select Model",
          items: available.map((m) => ({ label: `${m.label} (${m.value})`, value: m.value })),
          onSelect: (_i: number, v: string) => {
            agent.model = v;
            store.logAlways(`${agent.name}: model → ${MODELS.find((m) => m.value === v)?.label ?? v}`);
            showTeamMenu();
          },
          onCancel: () => showEditAgentMenu(agentName),
        });
      } else if (value === "role") {
        store.openOverlay("text-input", {
          title: "Enter role",
          initial: agent.role || "",
          onSubmit: (v: string) => {
            agent.role = v.trim() || undefined;
            store.logAlways(`${agent.name}: role → ${v.trim() || "-"}`);
            showTeamMenu();
          },
          onCancel: () => showEditAgentMenu(agentName),
        });
      } else if (value === "system-prompt") {
        store.openOverlay("yaml-editor", {
          title: `System Prompt: ${agent.name}`,
          initial: agent.systemPrompt || "",
          onSave: (v: string) => {
            agent.systemPrompt = v.trim() || undefined;
            store.logAlways(`${agent.name}: system prompt ${v.trim() ? "updated" : "cleared"}`);
            showTeamMenu();
          },
          onCancel: () => showEditAgentMenu(agentName),
        });
      } else if (value === "skills") {
        showSkillPicker(agent);
      }
    },
    onCancel: () => showTeamMenu(),
  });
}

function showSkillPicker(agent: { name: string; skills?: string[] }) {
  import("../../llm/skills.js").then(({ discoverSkills }) => {
    const store = useTUIStore.getState();
    const available = discoverSkills(store.workDir);
    const currentSkills = new Set(agent.skills ?? []);

    if (available.length === 0) {
      store.logAlways("No skills found in .claude/skills/");
      showTeamMenu();
      return;
    }

    const items = available.map((s) => ({
      label: `[${currentSkills.has(s.name) ? chalk.green("✓") : " "}] ${chalk.bold(s.name)}  ${chalk.gray(s.description.slice(0, 40))}`,
      value: s.name,
    }));

    store.openOverlay("picker", {
      title: `Skills: ${agent.name}`,
      items,
      borderColor: "yellow",
      hint: "Space toggle  Enter save  Escape cancel",
      onSelect: () => {
        // Enter = save
        const agents = store.orchestrator?.getAgents() ?? [];
        const found = agents.find((a) => a.name === agent.name);
        if (found) {
          found.skills = currentSkills.size > 0 ? [...currentSkills] : undefined;
        }
        store.logAlways(`${agent.name}: skills → ${currentSkills.size > 0 ? [...currentSkills].join(", ") : "none"}`);
        showTeamMenu();
      },
      onKey: (input: string, _key: any, _idx: number, val: string) => {
        if (input === " ") {
          // Toggle skill
          if (currentSkills.has(val)) {
            currentSkills.delete(val);
          } else {
            currentSkills.add(val);
          }
          // Reopen with updated checkmarks
          store.closeOverlay();
          showSkillPicker(agent);
        }
      },
      onCancel: () => showTeamMenu(),
    });
  });
}

function showAITeamPrompt() {
  const store = useTUIStore.getState();
  store.openOverlay("text-input", {
    title: "✦ AI Team Generator — describe the team you need",
    onSubmit: (description: string) => {
      if (description.trim()) {
        generateAITeam(description.trim());
      } else {
        showTeamMenu();
      }
    },
    onCancel: () => showTeamMenu(),
  });
}

async function generateAITeam(description: string) {
  const store = useTUIStore.getState();
  store.logAlways(`✦ ${description}`);
  store.logAlways("");
  store.setProcessing(true, "Generating team");

  try {
    const { querySDK, extractTeamYaml } = await import("../../llm/query.js");
    const { buildTeamGenPrompt } = await import("../../llm/prompts.js");

    const prompt = buildTeamGenPrompt(store.orchestrator!, store.workDir, description);
    const resultText = await querySDK(prompt, ["Skill", "Bash"], store.workDir, (event: string) => {
      store.setProcessingDetail(event.replace(/\{[^}]*\}/g, "").slice(0, 80));
    });
    store.setProcessing(false);

    const yaml = extractTeamYaml(resultText);
    if (!yaml?.trim()) {
      store.logAlways("AI returned empty result");
      return;
    }

    try {
      const doc = parseYaml(yaml);
      if (!doc?.team || !Array.isArray(doc.team) || doc.team.length === 0) {
        store.logAlways("Invalid team: no agents found");
        return;
      }
    } catch (parseErr: any) {
      store.logAlways(`Invalid YAML: ${parseErr.message}`);
      return;
    }

    showTeamPreview(yaml, description);
  } catch (err: any) {
    store.setProcessing(false);
    store.logAlways(`Team generation failed: ${err.message}`);
  }
}

function showTeamPreview(yaml: string, originalDescription: string) {
  const store = useTUIStore.getState();

  let viewMode: "readable" | "yaml" = "readable";

  const buildContent = () => {
    if (viewMode === "yaml") return yaml;
    // Readable format
    try {
      const doc = parseYaml(yaml);
      const agents = doc.team || [];
      const lines: string[] = [];
      lines.push(`${chalk.bold(String(agents.length))} agent${agents.length !== 1 ? "s" : ""} in team`);
      lines.push("");
      for (const a of agents) {
        const modelLabel = MODELS.find((m) => m.value === a.model)?.label ?? a.model ?? "";
        lines.push(`${chalk.bold(a.name)}  ${chalk.cyan(a.adapter || "claude-sdk")}`);
        if (modelLabel) lines.push(`  ${chalk.gray("Model:")} ${chalk.cyan(modelLabel)}`);
        if (a.role) lines.push(`  ${a.role}`);
        if (a.systemPrompt) {
          const truncated = String(a.systemPrompt).replace(/\n/g, " ").slice(0, 60);
          lines.push(`  ${chalk.blue("✎")} ${chalk.gray(truncated)}${String(a.systemPrompt).length > 60 ? "…" : ""}`);
        }
        if (a.skills?.length) lines.push(`  ${chalk.yellow("⚡")} ${chalk.yellow(a.skills.join(", "))}`);
        lines.push("");
      }
      return lines.join("\n");
    } catch {
      return yaml;
    }
  };

  store.openOverlay("content-viewer", {
    title: "✦ Team Preview",
    content: buildContent(),
    actions: ["Apply team", "Edit YAML", "Refine with feedback"],
    onAction: (index: number) => {
      store.closeOverlay();
      if (index === 0) {
        applyTeam(yaml);
      } else if (index === 1) {
        store.openOverlay("yaml-editor", {
          title: "Edit Team",
          initial: yaml,
          onSave: (edited: string) => showTeamPreview(edited, originalDescription),
          onCancel: () => showTeamPreview(yaml, originalDescription),
        });
      } else if (index === 2) {
        store.openOverlay("text-input", {
          title: "↻ Refine — What should be changed?",
          onSubmit: (feedback: string) => {
            if (feedback.trim()) refineAITeam(yaml, originalDescription, feedback.trim());
            else showTeamPreview(yaml, originalDescription);
          },
          onCancel: () => showTeamPreview(yaml, originalDescription),
        });
      }
    },
    onTab: () => {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      return buildContent();
    },
  });
}

function applyTeam(yaml: string) {
  const store = useTUIStore.getState();
  try {
    const doc = parseYaml(yaml);
    if (!doc?.team || !Array.isArray(doc.team)) {
      store.logAlways("Invalid team YAML");
      return;
    }

    let added = 0, updated = 0;
    for (const agentDef of doc.team) {
      if (!agentDef.name || !agentDef.adapter) continue;
      const existing = store.orchestrator?.getAgents().find((a) => a.name === agentDef.name);
      if (existing) {
        existing.adapter = agentDef.adapter;
        existing.model = agentDef.model;
        existing.role = agentDef.role;
        existing.systemPrompt = agentDef.systemPrompt;
        existing.skills = agentDef.skills;
        updated++;
      } else {
        try {
          store.orchestrator?.addAgent({
            name: agentDef.name,
            adapter: agentDef.adapter,
            model: agentDef.model,
            role: agentDef.role,
            systemPrompt: agentDef.systemPrompt,
            skills: agentDef.skills,
          });
          added++;
        } catch { /* skip duplicates */ }
      }
    }
    store.logAlways(`Team applied: ${added} added, ${updated} updated`);
  } catch (err: any) {
    store.logAlways(`Failed to apply team: ${err.message}`);
  }
}

async function refineAITeam(currentYaml: string, originalDescription: string, feedback: string) {
  const store = useTUIStore.getState();
  store.logAlways(`↻ Refining: ${feedback}`);
  store.setProcessing(true, "Refining team");

  try {
    const { querySDK, extractTeamYaml } = await import("../../llm/query.js");
    const { buildTeamGenPrompt } = await import("../../llm/prompts.js");

    const prompt = [
      buildTeamGenPrompt(store.orchestrator!, store.workDir, originalDescription),
      "", "---", "",
      "Current team YAML:", currentYaml, "",
      `User feedback: "${feedback}"`, "",
      "Revise the team based on the feedback. Output ONLY valid YAML.",
    ].join("\n");

    const resultText = await querySDK(prompt, ["Skill", "Bash"], store.workDir, (event: string) => {
      store.setProcessingDetail(event.replace(/\{[^}]*\}/g, "").slice(0, 80));
    });
    store.setProcessing(false);

    const newYaml = extractTeamYaml(resultText);
    if (!newYaml?.trim()) {
      store.logAlways("Refine returned empty result");
      showTeamPreview(currentYaml, originalDescription);
      return;
    }
    showTeamPreview(newYaml, originalDescription);
  } catch (err: any) {
    store.setProcessing(false);
    store.logAlways(`Refine failed: ${err.message}`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /tasks /inspect — 3-level hierarchical browser ──────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type BrowserEntry = { type: "plan"; name: string; tasks: Task[] } | { type: "task"; task: Task };

function cmdTasks() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  const tasks = state?.tasks ?? [];
  if (tasks.length === 0) {
    store.logAlways("No tasks");
    return;
  }

  const ungrouped: Task[] = [];
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  const entries: BrowserEntry[] = [];
  for (const [name, gTasks] of groups) {
    entries.push({ type: "plan", name, tasks: gTasks });
  }
  for (const t of ungrouped) {
    entries.push({ type: "task", task: t });
  }

  showBrowserLevel1(entries);
}

function showBrowserLevel1(entries: BrowserEntry[]) {
  const store = useTUIStore.getState();

  const items = entries.map((e) => {
    if (e.type === "plan") {
      const done = e.tasks.filter((t) => t.status === "done").length;
      const failed = e.tasks.filter((t) => t.status === "failed").length;
      const total = e.tasks.length;
      const allTerminal = done + failed === total;
      const earliest = e.tasks.reduce(
        (min, t) => (t.createdAt < min ? t.createdAt : min),
        e.tasks[0]!.createdAt,
      );
      const endTime = allTerminal
        ? e.tasks.reduce(
            (max, t) => (t.updatedAt > max ? t.updatedAt : max),
            e.tasks[0]!.updatedAt,
          )
        : new Date().toISOString();
      const elapsed = formatElapsed(
        new Date(endTime).getTime() - new Date(earliest).getTime(),
      );
      const statusIcon = allTerminal
        ? (failed > 0 ? chalk.red("✗") : chalk.green("✓"))
        : chalk.yellow("●");
      const countStr = chalk.gray(`(${done}/${total})`);
      const elapsedStr = chalk.gray(elapsed);
      return {
        label: `${statusIcon} ${chalk.bold(e.name)} ${countStr} ${elapsedStr}`,
        value: `plan:${e.name}`,
      };
    } else {
      const icon = coloredIcon(e.task.status);
      const score = e.task.result?.assessment?.globalScore;
      const scoreStr = score !== undefined
        ? ` ${(score >= 4 ? chalk.green : score >= 3 ? chalk.yellow : chalk.red)(score.toFixed(1) + "/5")}`
        : "";
      return {
        label: `${icon} ${e.task.title}${scoreStr}`,
        value: `task:${e.task.id}`,
      };
    }
  });

  store.openOverlay("picker", {
    title: "Tasks",
    items,
    onSelect: (_idx: number, value: string) => {
      if (value.startsWith("plan:")) {
        const planName = value.slice(5);
        const entry = entries.find(
          (e) => e.type === "plan" && e.name === planName,
        );
        if (entry && entry.type === "plan") {
          showBrowserPlan(entry.name, entry.tasks, entries);
        }
      } else {
        const taskId = value.slice(5);
        // Re-read state for fresh data
        store.loadState();
        const task = useTUIStore.getState().state?.tasks.find((t) => t.id === taskId);
        if (task) {
          showTaskDetail(task, () => showBrowserLevel1(entries));
        }
      }
    },
  });
}

function showBrowserPlan(planName: string, planTasks: Task[], parentEntries: BrowserEntry[]) {
  const store = useTUIStore.getState();

  const items = planTasks.map((t) => {
    const icon = coloredIcon(t.status);
    const score = t.result?.assessment?.globalScore;
    const scoreStr = score !== undefined
      ? ` ${(score >= 4 ? chalk.green : score >= 3 ? chalk.yellow : chalk.red)(score.toFixed(1) + "/5")}`
      : "";
    const agent = t.assignTo ? chalk.gray(` → ${t.assignTo}`) : "";
    return {
      label: `${icon} ${t.title}${agent}${scoreStr}`,
      value: t.id,
    };
  });

  store.openOverlay("picker", {
    title: planName,
    items,
    hint: "Enter inspect  Escape back",
    onSelect: (_idx: number, value: string) => {
      store.loadState();
      const task = useTUIStore.getState().state?.tasks.find((t) => t.id === value) ??
        planTasks.find((t) => t.id === value);
      if (task) {
        showTaskDetail(task, () => showBrowserPlan(planName, planTasks, parentEntries));
      }
    },
    onCancel: () => {
      showBrowserLevel1(parentEntries);
    },
  });
}

function showTaskDetail(task: Task, goBack: () => void) {
  const store = useTUIStore.getState();
  const isRunning = ["in_progress", "assigned", "review"].includes(task.status);

  const buildContent = (): string => {
    // Re-read state for fresh data (must use getState() for live data)
    store.loadState();
    const state = useTUIStore.getState().state;
    const freshTask = state?.tasks.find((t: Task) => t.id === task.id) ?? task;
    const proc = (state?.processes ?? []).find((p: any) => p.taskId === freshTask.id);
    const sessionId = proc?.activity?.sessionId;

    const lines: string[] = [];

    // ── Header ──
    const sColor = statusColor(freshTask.status);
    const chalkC = (chalk as any)[sColor] ?? chalk.white;
    lines.push(`${chalk.bold(freshTask.title)} ${chalk.gray(`[${freshTask.id}]`)}`);
    lines.push(`${chalkC(statusLabel(freshTask.status))}  ${chalk.gray("→")} ${chalk.cyan(freshTask.assignTo)}  ${chalk.gray(`Retries: ${freshTask.retries}/${freshTask.maxRetries}`)}`);
    if (freshTask.group) lines.push(`${chalk.gray("Plan:")} ${chalk.cyan(freshTask.group)}`);
    if (freshTask.dependsOn?.length > 0) {
      const depNames = freshTask.dependsOn.map((depId: string) => {
        const dep = state?.tasks.find((t: Task) => t.id === depId);
        return dep ? dep.title : depId;
      });
      lines.push(`${chalk.gray("Depends on:")} ${depNames.join(", ")}`);
    }
    lines.push("");

    // ── Prompt / Description ──
    if (freshTask.description && freshTask.description !== freshTask.title) {
      lines.push(chalk.bold("━━ Prompt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      lines.push(`  ${freshTask.description.slice(0, 800)}`);
      lines.push("");
    }

    // ── Expectations ──
    if (freshTask.expectations?.length > 0) {
      lines.push(chalk.cyan("┌─ Expectations ────────────────────────┐"));
      for (const exp of freshTask.expectations) {
        const check = freshTask.result?.assessment?.checks?.find(
          (c: any) => c.type === exp.type,
        );
        const icon = check ? (check.passed ? chalk.green("✓") : chalk.red("✗")) : chalk.gray("○");
        let label = "";
        switch (exp.type) {
          case "test":
            label = `test: ${exp.command || ""}`;
            break;
          case "file_exists":
            label = `files: ${(exp.paths || []).join(", ")}`;
            break;
          case "script":
            label = `script: ${(exp.command || "").split("\n")[0]}`;
            break;
          case "llm_review":
            label = `review: ${(exp.criteria || "").slice(0, 80)}`;
            break;
          default:
            label = exp.type;
        }
        lines.push(`│  ${icon} ${label}`);
      }
      lines.push("└──────────────────────────────────────┘");
      lines.push("");
    }

    // ── Live Activity (running tasks) ──
    if (proc?.alive && proc.activity) {
      const act = proc.activity;
      const elapsed = proc.startedAt
        ? formatElapsed(Date.now() - new Date(proc.startedAt).getTime())
        : "";
      lines.push(`${chalk.bold("━━ Live Activity ━━━━━━━━━━━━━━━━━━━━━━")} ${chalk.yellow(elapsed)}`);
      if (act.lastTool) {
        const fileInfo = act.lastFile
          ? ` → ${chalk.cyan(act.lastFile.split("/").pop() ?? "")}`
          : "";
        lines.push(`  ${chalk.yellow("▸")} ${chalk.bold(act.lastTool)}${fileInfo}`);
      }
      lines.push(`  ${chalk.gray("Tool calls:")} ${act.toolCalls}`);
      if (act.filesCreated?.length > 0) {
        lines.push(`  ${chalk.green("Created:")}`);
        for (const f of act.filesCreated) lines.push(`    ${chalk.green("+")} ${chalk.cyan(f)}`);
      }
      if (act.filesEdited?.length > 0) {
        lines.push(`  ${chalk.yellow("Edited:")}`);
        for (const f of act.filesEdited) lines.push(`    ${chalk.yellow("~")} ${chalk.cyan(f)}`);
      }
      if (act.summary) {
        lines.push("");
        lines.push(`  ${chalk.gray(act.summary.slice(0, 400))}`);
      }
      lines.push("");
    }

    // ── Session Transcript ──
    if (sessionId) {
      const summary = readSessionSummary(sessionId, store.workDir);
      if (summary) {
        lines.push(chalk.bold("━━ Session Transcript ━━━━━━━━━━━━━━━━━"));
        lines.push(`  ${chalk.gray("ID:")} ${chalk.cyan(sessionId)}  ${chalk.gray("Messages:")} ${summary.messageCount}`);
        if (summary.filesCreated.length > 0) {
          lines.push(`  ${chalk.green("Files created:")}`);
          for (const f of summary.filesCreated.slice(0, 15))
            lines.push(`    ${chalk.green("+")} ${chalk.cyan(f)}`);
        }
        if (summary.filesEdited.length > 0) {
          lines.push(`  ${chalk.yellow("Files edited:")}`);
          for (const f of summary.filesEdited.slice(0, 15))
            lines.push(`    ${chalk.yellow("~")} ${chalk.cyan(f)}`);
        }
        if (summary.todos.length > 0) {
          lines.push(`  ${chalk.blue("TODOs:")}`);
          for (const t of summary.todos.slice(0, 5)) lines.push(`    ${chalk.blue("·")} ${t}`);
        }
        if (summary.errors.length > 0) {
          lines.push(`  ${chalk.red("Errors:")}`);
          for (const e of summary.errors.slice(0, 5))
            lines.push(`    ${chalk.red("✗")} ${e}`);
        }
        if (summary.lastMessage) {
          lines.push("");
          lines.push(`  ${chalk.gray("Last message:")}`);
          lines.push(`    ${chalk.gray(summary.lastMessage.slice(0, 500))}`);
        }
        lines.push("");
      }
    }

    // ── Result & Assessment ──
    if (freshTask.result) {
      lines.push(chalk.bold("━━ Result ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      const exitColor = freshTask.result.exitCode === 0 ? chalk.green : chalk.red;
      lines.push(
        `  ${chalk.gray("Exit:")} ${exitColor(String(freshTask.result.exitCode))}  ${chalk.gray("Duration:")} ${(freshTask.result.duration / 1000).toFixed(1)}s`,
      );

      if (freshTask.result.assessment) {
        const assessment = freshTask.result.assessment;
        lines.push("");
        lines.push(chalk.bold("━━ Assessment ━━━━━━━━━━━━━━━━━━━━━━━━━"));
        const passedColor = assessment.passed ? chalk.green : chalk.red;
        lines.push(
          `  ${chalk.gray("Result:")} ${passedColor(assessment.passed ? "PASSED" : "FAILED")}`,
        );

        if (assessment.globalScore !== undefined) {
          const scoreC = assessment.globalScore >= 4 ? chalk.green : assessment.globalScore >= 3 ? chalk.yellow : chalk.red;
          lines.push(
            `  ${chalk.gray("Global score:")} ${scoreC(assessment.globalScore.toFixed(1) + "/5")}`,
          );
        }

        if (assessment.scores && assessment.scores.length > 0) {
          lines.push("");
          for (const s of assessment.scores) {
            const barColor = s.score >= 4 ? chalk.green : s.score >= 3 ? chalk.yellow : chalk.red;
            const bar = barColor("█".repeat(s.score)) + chalk.gray("░".repeat(5 - s.score));
            lines.push(`  ${bar} ${chalk.bold(s.dimension)} ${s.score}/5`);
            if (s.reasoning)
              lines.push(`       ${chalk.gray(s.reasoning.slice(0, 150))}`);
          }
        }

        if (assessment.checks?.length > 0) {
          lines.push("");
          lines.push(`  ${chalk.bold("Checks:")}`);
          for (const c of assessment.checks) {
            const icon = c.passed ? chalk.green("✓") : chalk.red("✗");
            lines.push(`    ${icon} ${chalk.bold(c.type)}: ${c.message ?? ""}`);
            if (c.details) lines.push(`      ${chalk.gray(c.details.slice(0, 200))}`);
          }
        }

        if (assessment.llmReview) {
          lines.push("");
          lines.push(`  ${chalk.bold("LLM Review:")}`);
          lines.push(`    ${chalk.gray(assessment.llmReview.slice(0, 500))}`);
        }
      }

      lines.push("");

      if (freshTask.result.stdout) {
        lines.push(chalk.bold("━━ Output ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
        for (const line of freshTask.result.stdout.slice(0, 1000).split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push("");
      }
      if (freshTask.result.stderr) {
        lines.push(chalk.bold.red("━━ Stderr ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
        for (const line of freshTask.result.stderr.slice(0, 500).split("\n")) {
          lines.push(`  ${chalk.red(line)}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  };

  store.openOverlay("content-viewer", {
    title: task.title,
    content: buildContent(),
    onClose: goBack,
    onTab: isRunning
      ? () => buildContent()
      : undefined,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /plans ──────────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdPlans() {
  const store = useTUIStore.getState();
  const plans = store.orchestrator?.getAllPlans() ?? [];
  if (plans.length === 0) {
    store.logAlways("No plans.");
    return;
  }

  const items = plans.map((p) => {
    const statusC = p.status === "completed" ? chalk.green : p.status === "active" ? chalk.yellow : chalk.gray;
    return {
      label: `${statusC(`[${p.status}]`)} ${chalk.bold(p.name)} ${chalk.gray("—")} ${chalk.gray(p.prompt?.slice(0, 50) ?? "")}`,
      value: p.name,
    };
  });

  store.openOverlay("picker", {
    title: "Plans",
    items,
    onSelect: (_idx: number, value: string) => {
      showPlanDetail(value);
    },
  });
}

function showPlanDetail(planName: string) {
  const store = useTUIStore.getState();
  const plan = store.orchestrator?.getAllPlans().find((p) => p.name === planName);
  if (!plan) return;

  const tasks = store.state?.tasks.filter((t) => t.group === planName) ?? [];
  const lines: string[] = [];
  lines.push(`${chalk.gray("Plan:")} ${chalk.bold(plan.name)}`);
  const planStatusC = plan.status === "completed" ? chalk.green : plan.status === "active" ? chalk.yellow : chalk.gray;
  lines.push(`${chalk.gray("Status:")} ${planStatusC(plan.status)}`);
  if (plan.prompt) lines.push(`${chalk.gray("Prompt:")} ${plan.prompt}`);
  lines.push("");
  lines.push(chalk.bold(`Tasks (${tasks.length}):`));
  for (const t of tasks) {
    const icon = coloredIcon(t.status);
    const score = t.result?.assessment?.globalScore;
    const scoreStr = score !== undefined
      ? ` ${(score >= 4 ? chalk.green : score >= 3 ? chalk.yellow : chalk.red)(score.toFixed(1) + "/5")}`
      : "";
    lines.push(`  ${icon} ${t.title} ${chalk.gray(`[${t.status}]`)} ${chalk.gray("→")} ${chalk.cyan(t.assignTo)}${scoreStr}`);
  }

  store.openOverlay("content-viewer", {
    title: planName,
    content: lines.join("\n"),
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /resume ─────────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdResume() {
  const store = useTUIStore.getState();
  const plans = store.orchestrator?.getResumablePlans() ?? [];
  if (plans.length === 0) {
    store.logAlways("No plans to resume.");
    return;
  }

  const items = plans.map((p) => ({
    label: `${chalk.bold(p.name)} ${chalk.gray(`[${p.status}]`)}`,
    value: p.name,
  }));

  store.openOverlay("picker", {
    title: "Resume Plan",
    items,
    onSelect: (_idx: number, value: string) => {
      store.orchestrator?.resumePlan(value);
      store.logAlways(`Resuming plan: ${value}`);
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /memory — Use orchestrator methods ──────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdMemory() {
  const store = useTUIStore.getState();
  const current = store.orchestrator?.getMemory() ?? "";
  const TEMPLATE = `# Project Memory\n\n## Architecture\n<!-- tech stack, folder structure -->\n\n## Conventions\n<!-- coding conventions, naming rules -->\n\n## Decisions\n<!-- key decisions and why -->\n\n## Notes\n<!-- anything agents should know -->\n`;
  const initial = current || TEMPLATE;

  store.openOverlay("yaml-editor", {
    title: "Project Memory (Ctrl+S save, Escape cancel)",
    initial,
    onSave: (value: string) => {
      store.orchestrator?.saveMemory(value);
      const lines = value.split("\n").filter((l) => l.trim()).length;
      store.logAlways(`Project memory saved (${lines} lines)`);
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /logs — Use LogStore with structured events ─────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdLogs() {
  const store = useTUIStore.getState();
  const logStore = store.orchestrator?.getLogStore();

  if (!logStore) {
    // Fallback to file-based logs
    cmdLogsFallback();
    return;
  }

  const sessions = logStore.listSessions();
  if (sessions.length === 0) {
    store.logAlways("No log sessions found");
    return;
  }

  showLogSessionPicker(sessions);
}

function showLogSessionPicker(sessions: SessionInfo[]) {
  const store = useTUIStore.getState();
  const currentSessionId = store.orchestrator?.getLogStore()?.getSessionId();

  const items = sessions.map((s) => {
    const date = new Date(s.startedAt);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const current = s.sessionId === currentSessionId ? chalk.green(" (current)") : "";
    return {
      label: `${chalk.cyan(dateStr)}  ${chalk.gray(`${s.entries} events`)}${current}`,
      value: s.sessionId,
    };
  });

  store.openOverlay("picker", {
    title: `Log Sessions (${sessions.length})`,
    items,
    onSelect: (_idx: number, value: string) => {
      showLogSessionEntries(value, sessions);
    },
  });
}

function showLogSessionEntries(sessionId: string, allSessions: SessionInfo[]) {
  const store = useTUIStore.getState();
  const logStore = store.orchestrator?.getLogStore();
  if (!logStore) return;

  const entries = logStore.getSessionEntries(sessionId);
  if (entries.length === 0) {
    store.logAlways("No entries in this session");
    return;
  }

  const lines: string[] = [];
  for (const entry of entries) {
    const time = new Date(entry.ts).toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const summary = summarizeLogEvent(entry.event, entry.data);
    const evtColor = entry.event.includes("fail") || entry.event.includes("error") ? chalk.red
      : entry.event.includes("complete") || entry.event.includes("done") ? chalk.green
      : entry.event.includes("spawn") || entry.event.includes("created") ? chalk.cyan
      : chalk.yellow;
    lines.push(`${chalk.gray(time)} ${evtColor(entry.event)} ${summary}`);
  }

  const session = allSessions.find((s) => s.sessionId === sessionId);
  const date = session
    ? new Date(session.startedAt).toLocaleDateString("it-IT", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : sessionId;

  store.openOverlay("content-viewer", {
    title: `Session ${date} (${entries.length} events)`,
    content: lines.join("\n"),
    onClose: () => showLogSessionPicker(allSessions),
  });
}

function summarizeLogEvent(event: string, data: unknown): string {
  const d = data as Record<string, any> | undefined;
  if (!d) return "";

  switch (event) {
    case "task:created":
      return d.task?.title ?? "";
    case "task:transition":
      return `${d.task?.title ?? d.taskId} ${d.from} → ${d.to}`;
    case "agent:spawned":
      return `${d.taskTitle ?? ""} → ${d.agentName ?? ""}`;
    case "agent:finished": {
      const secs = d.duration ? (d.duration / 1000).toFixed(1) : "?";
      const sid = d.sessionId ? ` ${d.sessionId}` : "";
      return `${d.agentName ?? ""} exit ${d.exitCode} (${secs}s)${sid}`;
    }
    case "assessment:complete": {
      const score = d.globalScore !== undefined ? ` (${d.globalScore.toFixed(1)}/5)` : "";
      return `${d.passed ? "PASSED" : "FAILED"}${score}`;
    }
    case "task:retry":
      return `${d.taskId} ${d.attempt}/${d.maxRetries}`;
    case "task:fix":
      return `${d.taskId} fix ${d.attempt}/${d.maxFix}`;
    case "plan:executed":
      return `${d.group ?? ""} (${d.taskCount} tasks)`;
    case "plan:completed":
      return `${d.group ?? ""} ${d.allPassed ? "all passed" : "some failed"}`;
    case "log":
      return d.message ?? "";
    default:
      return d.taskId ?? d.planId ?? "";
  }
}

async function cmdLogsFallback() {
  const store = useTUIStore.getState();
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");

  const logsDir = resolve(store.workDir, ".polpo", "logs");
  let files: string[] = [];
  try {
    files = (await readdir(logsDir))
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse();
  } catch {
    store.logAlways("No logs found.");
    return;
  }

  if (files.length === 0) {
    store.logAlways("No log files found.");
    return;
  }

  const items = files.map((f) => ({ label: f, value: f }));

  store.openOverlay("picker", {
    title: "Session Logs",
    items,
    onSelect: async (_idx: number, value: string) => {
      try {
        const content = await readFile(join(logsDir, value), "utf-8");
        store.openOverlay("content-viewer", {
          title: value,
          content,
        });
      } catch (err: any) {
        store.logAlways(`Error reading log: ${err.message}`);
      }
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /abort — Group-level + individual ───────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdAbort() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  if (!state || state.tasks.length === 0) {
    store.logAlways("No tasks to abort");
    return;
  }

  const running = state.tasks.filter((t) =>
    ["pending", "assigned", "in_progress", "review"].includes(t.status),
  );

  if (running.length === 0) {
    store.logAlways("No running tasks");
    return;
  }

  // Build options: groups first, then individual ungrouped tasks
  const groups = new Map<string, Task[]>();
  const ungrouped: Task[] = [];
  for (const t of running) {
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  type AbortOption = { label: string; value: string; action: () => void };
  const options: AbortOption[] = [];

  for (const [groupName, tasks] of groups) {
    options.push({
      label: `${chalk.red("✗")} Abort ${chalk.bold(groupName)} ${chalk.gray(`(${tasks.length} tasks)`)}`,
      value: `group:${groupName}`,
      action: () => {
        const count = store.orchestrator?.abortGroup(groupName) ?? 0;
        store.logAlways(`Aborted ${count} tasks in ${groupName}`);
      },
    });
  }

  for (const t of ungrouped) {
    const title = t.title.length > 50 ? t.title.slice(0, 49) + "…" : t.title;
    options.push({
      label: `${chalk.red("✗")} ${title}`,
      value: `task:${t.id}`,
      action: () => {
        store.orchestrator?.killTask(t.id);
        store.logAlways(`Aborted: ${t.title}`);
      },
    });
  }

  // Auto-execute if only 1 option
  if (options.length === 1) {
    options[0]!.action();
    return;
  }

  options.push({ label: "Cancel", value: "__cancel__", action: () => {} });

  const items = options.map((o) => ({ label: o.label, value: o.value }));

  store.openOverlay("picker", {
    title: "Abort",
    items,
    borderColor: "red",
    onSelect: (_idx: number, value: string) => {
      const opt = options.find((o) => o.value === value);
      opt?.action();
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /clear-tasks — 5-option menu ────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdClearTasks() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  if (!state || state.tasks.length === 0) {
    store.logAlways("No tasks to clear");
    return;
  }

  const done = state.tasks.filter(
    (t) => t.status === "done" || t.status === "failed",
  );
  if (done.length === 0) {
    store.logAlways("No finished tasks to clear");
    return;
  }

  const items = [
    { label: `${chalk.green("✓")} Clear completed (done)`, value: "done" },
    { label: `${chalk.red("✗")} Clear failed`, value: "failed" },
    { label: `${chalk.yellow("●")} Clear all finished ${chalk.gray("(done + failed)")}`, value: "finished" },
    { label: `${chalk.red.bold("!!")} Clear ALL tasks ${chalk.gray("(kills running agents)")}`, value: "all" },
    { label: chalk.gray("Cancel"), value: "cancel" },
  ];

  store.openOverlay("picker", {
    title: "Clear Tasks",
    items,
    borderColor: "yellow",
    onSelect: (_idx: number, value: string) => {
      let count = 0;
      switch (value) {
        case "done":
          count = store.orchestrator?.clearTasks((t) => t.status === "done") ?? 0;
          store.logAlways(`Cleared ${count} completed tasks`);
          break;
        case "failed":
          count = store.orchestrator?.clearTasks((t) => t.status === "failed") ?? 0;
          store.logAlways(`Cleared ${count} failed tasks`);
          break;
        case "finished":
          count = store.orchestrator?.clearTasks(
            (t) => t.status === "done" || t.status === "failed",
          ) ?? 0;
          store.logAlways(`Cleared ${count} finished tasks`);
          break;
        case "all":
          count = store.orchestrator?.clearTasks(() => true) ?? 0;
          store.logAlways(`Cleared all ${count} tasks`);
          break;
      }
      store.loadState();
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /reassess — With processing state ───────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdReassess() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  if (!state) return;

  const eligible = state.tasks.filter(
    (t) => t.status === "done" || t.status === "failed",
  );
  if (eligible.length === 0) {
    store.logAlways("No tasks to reassess.");
    return;
  }

  const items = eligible.map((t) => {
    const icon = t.status === "done" ? chalk.green("✓") : chalk.red("✗");
    const score = t.result?.assessment?.globalScore;
    const scoreStr = score !== undefined
      ? ` ${(score >= 4 ? chalk.green : score >= 3 ? chalk.yellow : chalk.red)(`(${score.toFixed(1)}/5)`)}`
      : "";
    return {
      label: `${icon} ${t.title}${scoreStr}`,
      value: t.id,
    };
  });

  store.openOverlay("picker", {
    title: "Reassess Task",
    items,
    borderColor: "yellow",
    onSelect: (_idx: number, value: string) => {
      const task = eligible.find((t) => t.id === value);
      store.logAlways(`↻ Reassessing: ${task?.title ?? value}`);
      store.setProcessing(true, "Reassessing");
      store.orchestrator
        ?.reassessTask(value)
        .then(() => {
          store.setProcessing(false);
        })
        .catch((err: Error) => {
          store.setProcessing(false);
          store.logAlways(`Reassess error: ${err.message}`);
        });
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /edit-plan — Full CRUD editor ───────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdEditPlan() {
  const store = useTUIStore.getState();
  store.loadState();
  const state = useTUIStore.getState().state;
  const tasks = state?.tasks ?? [];
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group)!.push(t);
    }
  }

  const editableGroups = [...groups.entries()].filter(([, g]) =>
    g.some((t) => t.status !== "done" && t.status !== "failed"),
  );

  if (editableGroups.length === 0) {
    store.logAlways("No active plans to edit");
    return;
  }

  if (editableGroups.length === 1) {
    const [name, g] = editableGroups[0]!;
    showPlanEditor(name, g);
    return;
  }

  const items = editableGroups.map(([name, g]) => {
    const done = g.filter((t) => t.status === "done").length;
    return {
      label: `${chalk.bold(name)} ${chalk.gray(`(${done}/${g.length} done)`)}`,
      value: name,
    };
  });

  store.openOverlay("picker", {
    title: "Edit Plan",
    items,
    onSelect: (_idx: number, value: string) => {
      const group = editableGroups.find(([n]) => n === value);
      if (group) showPlanEditor(group[0], group[1]);
    },
  });
}

function showPlanEditor(groupName: string, groupTasks: Task[]) {
  const store = useTUIStore.getState();

  const items = groupTasks.map((t) => {
    const icon = coloredIcon(t.status);
    const editable = t.status === "pending" || t.status === "failed";
    const lockMark = editable ? "" : chalk.gray(" (locked)");
    const titleMax = 50;
    const title = t.title.length > titleMax ? t.title.slice(0, titleMax - 1) + "…" : t.title;
    return {
      label: `${icon} ${title} ${chalk.gray("→")} ${chalk.cyan(t.assignTo)}${lockMark}`,
      value: t.id,
    };
  });

  items.push({ label: chalk.green("+ Add task to plan"), value: "__add__" });

  store.openOverlay("picker", {
    title: `✎ Edit: ${groupName}`,
    items,
    borderColor: "yellow",
    hint: "Enter edit  d remove  a reassign  r retry  Esc close",
    onSelect: (_idx: number, value: string) => {
      if (value === "__add__") {
        // Add new task: title → description
        store.openOverlay("text-input", {
          title: "New task title",
          onSubmit: (title: string) => {
            if (!title.trim()) { reopenPlanEditor(groupName); return; }
            store.openOverlay("text-input", {
              title: "Task description",
              onSubmit: (desc: string) => {
                const agents = store.orchestrator?.getAgents() ?? [];
                const defaultAgent = agents[0]?.name ?? "dev";
                store.orchestrator?.addTask({
                  title: title.trim(),
                  description: desc?.trim() || title.trim(),
                  assignTo: defaultAgent,
                  expectations: [],
                  group: groupName,
                });
                store.logAlways(`Task added to ${groupName}: ${title.trim()}`);
                reopenPlanEditor(groupName);
              },
              onCancel: () => reopenPlanEditor(groupName),
            });
          },
          onCancel: () => reopenPlanEditor(groupName),
        });
        return;
      }

      // Edit task description (only if editable)
      const task = groupTasks.find((t) => t.id === value);
      if (!task) return;
      const editable = task.status === "pending" || task.status === "failed";
      if (!editable) {
        store.logAlways(`Task "${task.title}" is locked (${task.status})`);
        reopenPlanEditor(groupName);
        return;
      }

      store.openOverlay("text-input", {
        title: `Edit: ${task.title}`,
        initial: task.description,
        onSubmit: (desc: string) => {
          if (desc?.trim()) {
            store.orchestrator?.updateTaskDescription(task.id, desc.trim());
            store.logAlways(`Task updated: ${task.title}`);
          }
          reopenPlanEditor(groupName);
        },
        onCancel: () => reopenPlanEditor(groupName),
      });
    },
    onKey: (input: string, _key: any, _idx: number, value: string) => {
      if (value === "__add__") return;
      const task = groupTasks.find((t) => t.id === value);
      if (!task) return;
      const editable = task.status === "pending" || task.status === "failed";

      // d = delete (only pending/failed)
      if (input === "d" && editable) {
        store.orchestrator?.killTask(task.id);
        store.orchestrator?.clearTasks((t: Task) => t.id === task.id);
        store.logAlways(`Removed from plan: ${task.title}`);
        store.closeOverlay();
        reopenPlanEditor(groupName);
        return;
      }

      // a = reassign (only pending/failed)
      if (input === "a" && editable) {
        const agents = store.orchestrator?.getAgents() ?? [];
        const agentItems = agents.map((a) => ({
          label: `${a.name}${a.role ? ` (${a.role})` : ""}`,
          value: a.name,
        }));
        store.closeOverlay();
        store.openOverlay("picker", {
          title: `Reassign: ${task.title}`,
          items: agentItems,
          onSelect: (_i: number, v: string) => {
            store.orchestrator?.updateTaskAssignment(task.id, v);
            store.logAlways(`${task.title} → ${v}`);
            reopenPlanEditor(groupName);
          },
          onCancel: () => reopenPlanEditor(groupName),
        });
        return;
      }

      // r = retry (only failed)
      if (input === "r" && task.status === "failed") {
        try {
          store.orchestrator?.retryTask(task.id);
          store.logAlways(`Retrying: ${task.title}`);
        } catch (e: any) {
          store.logAlways(`Cannot retry: ${e.message}`);
        }
        store.closeOverlay();
        reopenPlanEditor(groupName);
        return;
      }
    },
  });
}

function reopenPlanEditor(groupName: string) {
  const store = useTUIStore.getState();
  store.loadState();
  const updated = (useTUIStore.getState().state?.tasks ?? []).filter(
    (t: Task) => t.group === groupName,
  );
  if (updated.length === 0) {
    store.logAlways("No tasks remaining in plan");
    return;
  }
  showPlanEditor(groupName, updated);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /sessions — Browse & resume chat sessions ───────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdSessions() {
  const store = useTUIStore.getState();
  const sessionStore = store.orchestrator?.getSessionStore();
  if (!sessionStore) {
    store.logAlways("Session store not available");
    return;
  }

  const sessions = sessionStore.listSessions();
  if (sessions.length === 0) {
    store.logAlways("No chat sessions yet. Use chat mode to start one.");
    return;
  }

  const items = sessions.map((s) => {
    const date = new Date(s.createdAt);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const current = s.id === store.activeSessionId ? chalk.green(" (active)") : "";
    const title = s.title ? ` ${s.title.slice(0, 40)}` : "";
    return {
      label: `${chalk.cyan(dateStr)}  ${chalk.gray(`${s.messageCount} msgs`)}${chalk.white(title)}${current}`,
      value: s.id,
    };
  });

  store.openOverlay("picker", {
    title: `Chat Sessions (${sessions.length})`,
    items,
    hint: "Enter resume  d delete  Esc close",
    onSelect: (_idx: number, value: string) => {
      // Resume this session
      store.setActiveSessionId(value);
      const messages = sessionStore.getMessages(value);
      store.setChatMessages(messages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        ts: new Date(m.ts).getTime(),
      })));
      store.setInputMode("chat");
      store.logAlways(`Resumed session (${messages.length} messages)`);
    },
    onKey: (input: string, _key: any, _idx: number, value: string) => {
      if (input === "d") {
        // Don't delete active session
        if (value === store.activeSessionId) {
          store.logAlways("Cannot delete active session. Use /new-chat first.");
          return;
        }
        sessionStore.deleteSession(value);
        store.logAlways("Session deleted");
        store.closeOverlay();
        cmdSessions(); // Reopen with updated list
      }
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── /new-chat — Start a fresh chat session ──────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cmdNewChat() {
  const store = useTUIStore.getState();
  const sessionStore = store.orchestrator?.getSessionStore();
  if (!sessionStore) {
    store.logAlways("Session store not available");
    return;
  }

  const newId = sessionStore.create();
  store.setActiveSessionId(newId);
  store.setChatMessages([]);
  store.setInputMode("chat");
  store.logAlways("New chat session started");
}
