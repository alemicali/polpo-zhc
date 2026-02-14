/**
 * /help — show available commands.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

const HELP_LINES: [string, string][] = [
  ["/status", "Show orchestrator state"],
  ["/team", "Manage team agents"],
  ["/tasks", "Browse and manage tasks"],
  ["/plans", "Manage plans"],
  ["/config", "Configure settings"],
  ["/chat", "Switch to chat mode"],
  ["/sessions", "View agent sessions"],
  ["/abort <group>", "Abort a task group"],
  ["/clear-tasks", "Clear all tasks"],
  ["/clear", "Clear the stream"],
  ["/quit", "Exit Polpo"],
];

export function cmdHelp({ store }: CommandAPI) {
  store.log("Available commands:", [seg("Available commands:", undefined, true)]);
  for (const [cmd, desc] of HELP_LINES) {
    store.log(`  ${cmd.padEnd(20)} ${desc}`, [
      seg("  "),
      seg(cmd.padEnd(20), "cyan"),
      seg(desc, "gray"),
    ]);
  }
}
