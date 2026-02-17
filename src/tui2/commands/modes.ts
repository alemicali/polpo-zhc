import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";

export function cmdChat(api: CommandAPI): void {
  api.tui.setInputMode("chat");
  api.tui.logSystem(`Mode: ${theme.chatMode("chat")}`);
  api.tui.requestRender();
}

export function cmdPlanMode(api: CommandAPI): void {
  api.tui.setInputMode("plan");
  api.tui.logSystem(`Mode: ${theme.planMode("plan")}`);
  api.tui.requestRender();
}

export function cmdTaskMode(api: CommandAPI): void {
  api.tui.setInputMode("task");
  api.tui.logSystem(`Mode: ${theme.taskMode("task")}`);
  api.tui.requestRender();
}
