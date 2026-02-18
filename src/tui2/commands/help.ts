import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";

export const COMMANDS = [
  { command: "/help", description: "Show available commands" },
  { command: "/status", description: "Show orchestrator status" },
  { command: "/team", description: "Manage team agents" },
  { command: "/tasks", description: "Browse and manage tasks" },
  { command: "/plans", description: "Manage execution plans" },
  { command: "/config", description: "View/edit configuration" },
  { command: "/chat", description: "Switch to chat mode" },
  { command: "/plan", description: "Switch to plan mode" },
  { command: "/task", description: "Switch to task mode" },
  { command: "/sessions", description: "View agent sessions" },
  { command: "/memory", description: "View/edit project memory" },
  { command: "/logs", description: "View event logs" },
  { command: "/inspect", description: "Inspect current session" },
  { command: "/workflow", description: "Discover and run workflows" },
  { command: "/skills", description: "Manage agent skills" },
  { command: "/checkpoints", description: "List/resume plan checkpoints" },
  { command: "/approvals", description: "Manage approval gates" },
  { command: "/reload", description: "Reload configuration" },
  { command: "/abort", description: "Abort all tasks in a group" },
  { command: "/clear-tasks", description: "Remove all tasks" },
  { command: "/clear", description: "Clear the log" },
  { command: "/quit", description: "Exit Polpo" },
];

const SHORTCUTS = [
  { key: "Tab", description: "Cycle input mode (chat/plan/task)" },
  { key: "Ctrl+O", description: "Toggle task panel" },
  { key: "Ctrl+A", description: "Toggle approval mode" },
  { key: "Ctrl+R", description: "Voice recording" },
  { key: "Ctrl+L", description: "Clear stream" },
  { key: "Ctrl+C", description: "Clear input / double-tap to exit" },
  { key: "Esc", description: "Cancel processing" },
];

export function cmdHelp(api: CommandAPI): void {
  const lines: string[] = [];
  lines.push(theme.bold("Commands:"));
  for (const cmd of COMMANDS) {
    lines.push(`  ${theme.info(cmd.command.padEnd(16))} ${theme.dim(cmd.description)}`);
  }
  lines.push("");
  lines.push(theme.bold("Shortcuts:"));
  for (const s of SHORTCUTS) {
    lines.push(`  ${theme.info(s.key.padEnd(16))} ${theme.dim(s.description)}`);
  }
  api.tui.logSystem(lines.join("\n"));
  api.tui.requestRender();
}
