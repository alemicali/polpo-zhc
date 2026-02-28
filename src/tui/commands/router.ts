/**
 * Command router — thin dispatch table.
 * Chat-only: removed task, mission, plan, template, skills, logs, status commands.
 */

import type { CommandAPI } from "./types.js";
import { cmdHelp } from "./help.js";
import { cmdTeam } from "./team.js";
import { cmdConfig } from "./config.js";
import { cmdSessions } from "./sessions.js";
import { cmdMemory } from "./memory.js";

type Handler = (api: CommandAPI) => void | Promise<void>;

const commands: Record<string, Handler> = {
  "/help": cmdHelp,
  "/team": cmdTeam,
  "/config": cmdConfig,
  "/sessions": cmdSessions,
  "/memory": cmdMemory,
  "/clear": ({ store }) => store.clearLines(),
  "/quit": () => process.exit(0),
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
