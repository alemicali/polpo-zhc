/**
 * /chat — toggle chat mode for LLM conversation.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

const MODE_COLORS: Record<string, string> = {
  task: "green",
  plan: "blue",
  chat: "magenta",
};

function switchTo(store: CommandAPI["store"], mode: "task" | "plan" | "chat") {
  store.setInputMode(mode);
  store.log(`Switched to ${mode} mode`, [
    seg("Switched to ", "gray"),
    seg(mode, MODE_COLORS[mode] ?? "white", true),
    seg(" mode", "gray"),
  ]);
}

export function cmdChat({ store }: CommandAPI) {
  switchTo(store, store.inputMode === "chat" ? "task" : "chat");
}

export function cmdPlanMode({ store }: CommandAPI) {
  switchTo(store, store.inputMode === "plan" ? "task" : "plan");
}

export function cmdTaskMode({ store }: CommandAPI) {
  switchTo(store, "task");
}
