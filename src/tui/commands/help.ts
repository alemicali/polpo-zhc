/**
 * /help — show available commands.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export const COMMANDS: [string, string][] = [
  ["/team [add|rm|edit]", "Manage team agents"],
  ["/config", "Configure settings"],
  ["/sessions", "View chat sessions"],
  ["/memory [edit] [agent:<name>]", "View/edit shared or agent memory"],
  ["/clear", "Clear the stream"],
  ["/quit", "Exit Polpo"],
];

const SHORTCUTS: [string, string][] = [
  ["Ctrl+R", "Voice input"],
  ["Ctrl+C", "Clear input / exit"],
  ["Ctrl+L", "Clear stream"],
  ["PgUp/PgDn", "Scroll"],
  ["Up/Down", "History navigation"],
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
