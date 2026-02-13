/**
 * Command dispatch table — routes slash commands to handlers.
 */

import type { CommandContext } from "../context.js";
import { cmdStatus, cmdResult, cmdHelp } from "./status.js";
import { cmdConfig } from "./config.js";
import { cmdTeam } from "./team.js";
import { cmdTaskBrowser, cmdReassess, cmdAbort, cmdClearTasks, cmdEditPlan, cmdInspect } from "./tasks.js";
import { cmdPlans, cmdResume } from "./plans.js";
import { cmdMemory } from "./memory.js";
import { cmdLogs } from "./logs.js";
import { cmdSessions, cmdNewChat } from "./sessions.js";
import { cmdWatch } from "./watch.js";

export type CommandHandler = (ctx: CommandContext, args: string[]) => void | Promise<void>;

const commands: Record<string, CommandHandler> = {
  "/status": (ctx) => cmdStatus(ctx),
  "/result": (ctx) => cmdResult(ctx),
  "/team": (ctx, args) => cmdTeam(ctx, args),
  "/inspect": (ctx) => cmdInspect(ctx),
  "/edit-plan": (ctx) => cmdEditPlan(ctx),
  "/reassess": (ctx) => cmdReassess(ctx),
  "/abort": (ctx) => cmdAbort(ctx),
  "/clear-tasks": (ctx) => cmdClearTasks(ctx),
  "/tasks": (ctx) => cmdTaskBrowser(ctx),
  "/plans": (ctx) => cmdPlans(ctx),
  "/resume": (ctx) => cmdResume(ctx),
  "/memory": (ctx) => cmdMemory(ctx),
  "/logs": (ctx) => cmdLogs(ctx),
  "/config": (ctx) => cmdConfig(ctx),
  "/help": (ctx) => cmdHelp(ctx),
  "/sessions": (ctx) => cmdSessions(ctx),
  "/new-chat": (ctx) => cmdNewChat(ctx),
  "/watch": (ctx) => cmdWatch(ctx),
};

/** Dispatch a slash command. Returns true if handled. */
export function dispatchCommand(ctx: CommandContext, cmd: string): boolean {
  const parts = cmd.split(/\s+/);
  const command = parts[0].toLowerCase();

  const handler = commands[command];
  if (handler) {
    handler(ctx, parts.slice(1));
    return true;
  }
  return false;
}
