/**
 * /help — show available commands.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export const COMMANDS: [string, string][] = [
  ["/status", "Show status"],
  ["/team [add|rm|edit]", "Manage team agents"],
  ["/tasks [list]", "Browse and manage tasks"],
  ["/plans [new|exec|resume]", "Manage plans"],
  ["/config", "Configure settings"],
  ["/chat", "Toggle chat mode"],
  ["/task", "Switch to task mode"],
  ["/sessions", "View agent sessions"],
  ["/memory [edit]", "View/edit project memory"],
  ["/logs [sessions]", "View event log"],
  ["/inspect", "View current session events"],
  ["/abort <group>", "Abort a task group"],
  ["/clear-tasks", "Clear all tasks"],
  ["/clear", "Clear the stream"],
  ["/quit", "Exit Polpo"],
];

const SHORTCUTS: [string, string][] = [
  ["Tab", "Cycle mode / autocomplete commands"],
  ["Ctrl+C", "Clear input / cancel / exit"],
  ["Ctrl+L", "Clear stream"],
  ["↑ ↓", "History navigation"],
];

export function cmdHelp({ store }: CommandAPI) {
  store.log("Commands:", [seg("Commands:", undefined, true)]);
  for (const [cmd, desc] of COMMANDS) {
    store.log(`  ${cmd.padEnd(24)} ${desc}`, [
      seg("  "),
      seg(cmd.padEnd(24), "cyan"),
      seg(desc, "gray"),
    ]);
  }

  store.log("", [seg("")]);
  store.log("Shortcuts:", [seg("Shortcuts:", undefined, true)]);
  for (const [key, desc] of SHORTCUTS) {
    store.log(`  ${key.padEnd(24)} ${desc}`, [
      seg("  "),
      seg(key.padEnd(24), "yellow"),
      seg(desc, "gray"),
    ]);
  }
}
