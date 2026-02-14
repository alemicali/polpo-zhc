/**
 * Command router — thin dispatch table.
 * Each domain is a separate handler function.
 */

import type { CommandAPI } from "./types.js";
import { cmdStatus } from "./status.js";
import { cmdHelp } from "./help.js";
import { cmdTeam } from "./team.js";
import { cmdTasks } from "./tasks.js";
import { cmdPlans } from "./plans.js";
import { cmdConfig } from "./config.js";
import { cmdChat, cmdTaskMode } from "./chat.js";
import { cmdSessions } from "./sessions.js";
import { cmdMemory } from "./memory.js";
import { cmdLogs, cmdInspect } from "./logs.js";

type Handler = (api: CommandAPI) => void | Promise<void>;

const commands: Record<string, Handler> = {
  "/status": cmdStatus,
  "/help": cmdHelp,
  "/team": cmdTeam,
  "/tasks": cmdTasks,
  "/plans": cmdPlans,
  "/plan": cmdPlans,
  "/config": cmdConfig,
  "/chat": cmdChat,
  "/task": cmdTaskMode,
  "/sessions": cmdSessions,
  "/memory": cmdMemory,
  "/logs": cmdLogs,
  "/inspect": cmdInspect,
  "/clear": ({ store }) => store.clearLines(),
  "/quit": () => process.exit(0),
  "/abort": ({ polpo, store, args }) => {
    const group = args[0];
    if (group) {
      polpo.abortGroup(group);
      store.log(`Aborted group: ${group}`);
    } else {
      store.log("Usage: /abort <group>");
    }
  },
  "/clear-tasks": ({ polpo, store }) => {
    polpo.clearTasks(() => true);
    store.log("Tasks cleared");
  },
};

/** Dispatch a slash command. Returns true if handled. */
export function dispatch(input: string, api: CommandAPI): boolean {
  const parts = input.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const args = parts.slice(1);
  const handler = commands[cmd];
  if (!handler) return false;
  handler({ ...api, args });
  return true;
}
