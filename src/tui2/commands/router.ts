import type { CommandAPI } from "../types.js";
import { cmdHelp, COMMANDS } from "./help.js";
import { cmdStatus } from "./status.js";
import { cmdTeam } from "./team.js";
import { cmdTasks } from "./tasks.js";
import { cmdPlans } from "./plans.js";
import { cmdConfig } from "./config.js";
import { cmdChat, cmdPlanMode, cmdTaskMode } from "./modes.js";
import { cmdSessions } from "./sessions.js";
import { cmdMemory } from "./memory.js";
import { cmdLogs, cmdInspect } from "./logs.js";
import { cmdWorkflow } from "./workflows.js";
import { cmdSkills } from "./skills.js";
import { cmdCheckpoints } from "./checkpoints.js";
import { cmdApprovals } from "./approvals.js";
import { ConfirmOverlay } from "../overlays/confirm.js";

export { COMMANDS };

const COMMAND_MAP: Record<string, (api: CommandAPI) => Promise<void> | void> = {
  help: cmdHelp,
  status: cmdStatus,
  team: cmdTeam,
  tasks: cmdTasks,
  plans: cmdPlans,
  plan: cmdPlanMode,
  config: cmdConfig,
  chat: cmdChat,
  task: cmdTaskMode,
  sessions: cmdSessions,
  memory: cmdMemory,
  logs: cmdLogs,
  inspect: cmdInspect,
  workflow: cmdWorkflow,
  workflows: cmdWorkflow,
  skills: cmdSkills,
  checkpoints: cmdCheckpoints,
  approvals: cmdApprovals,
};

/**
 * Dispatch a slash command.
 * Returns true if the command was handled.
 */
export function dispatch(input: string, api: CommandAPI): boolean {
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) return false;

  const [name, ...rest] = trimmed.split(/\s+/);
  const cmd = name!.toLowerCase();

  // Inline commands
  if (cmd === "clear") {
    api.tui.clearLog();
    api.tui.requestRender();
    return true;
  }
  if (cmd === "quit" || cmd === "exit") {
    api.tui.logSystem("Shutting down…");
    api.tui.requestRender();
    void api.polpo.gracefulStop().then(() => process.exit(0));
    return true;
  }
  if (cmd === "abort") {
    const group = rest.join(" ").trim();
    if (!group) {
      api.tui.logSystem("Usage: /abort <group>");
      api.tui.requestRender();
      return true;
    }
    const confirm = new ConfirmOverlay({
      message: `Abort all tasks in group "${group}"?`,
      onConfirm: () => {
        api.tui.hideOverlay();
        const count = api.polpo.abortGroup(group);
        api.tui.logSystem(`Aborted ${count} task(s) in group "${group}"`);
        api.tui.requestRender();
      },
      onCancel: () => api.tui.hideOverlay(),
    });
    api.tui.showOverlay(confirm);
    return true;
  }
  if (cmd === "clear-tasks") {
    const confirm = new ConfirmOverlay({
      message: "Remove ALL tasks? This cannot be undone.",
      onConfirm: () => {
        api.tui.hideOverlay();
        const count = api.polpo.clearTasks(() => true);
        api.tui.logSystem(`Cleared ${count} task(s)`);
        api.tui.requestRender();
      },
      onCancel: () => api.tui.hideOverlay(),
    });
    api.tui.showOverlay(confirm);
    return true;
  }
  if (cmd === "reload") {
    const ok = api.polpo.reloadConfig();
    api.tui.logSystem(ok ? "Configuration reloaded" : "Reload failed (check polpo.json)");
    api.tui.requestRender();
    return true;
  }

  const handler = COMMAND_MAP[cmd];
  if (handler) {
    const cmdApi = { ...api, args: rest };
    void handler(cmdApi);
    return true;
  }

  api.tui.logSystem(`Unknown command: /${cmd}. Type /help for available commands.`);
  api.tui.requestRender();
  return true;
}
