/**
 * Which sandbox the current chat's tools run in, for the badges on tool calls.
 * The chat page provides it; tool cards read it.
 */
import { createContext, use } from "react";

export interface ChatSandboxInfo {
  /** Provider of the chat's sandbox: "local" = this machine without isolation. */
  provider: string;
}

export const ChatSandboxContext = createContext<ChatSandboxInfo | null>(null);

export function useChatSandbox(): ChatSandboxInfo | null {
  return use(ChatSandboxContext);
}
