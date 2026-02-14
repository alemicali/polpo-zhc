/**
 * /chat — toggle chat mode for LLM conversation.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdChat({ store }: CommandAPI) {
  const current = store.inputMode;
  if (current === "chat") {
    store.setInputMode("task");
    store.log("Switched to task mode", [
      seg("Switched to ", "gray"),
      seg("task", "green", true),
      seg(" mode", "gray"),
    ]);
  } else {
    store.setInputMode("chat");
    store.log("Switched to chat mode", [
      seg("Switched to ", "gray"),
      seg("chat", "magenta", true),
      seg(" mode", "gray"),
    ]);
  }
}
