/** Pure helpers of the Coding app's chats (kept out of the component files for fast refresh). */
import type { CodingChatSegment } from "@polpo-ai/react";
import type { MessageSegment, ToolCallInfo } from "@/hooks/use-polpo";
import type { CodingTerminal } from "./types";

/** A session drawn as a chat: it has a coding chat, or is a new Claude Code / Codex one being created. */
export function isChatSession(t: CodingTerminal): boolean {
  return !!t.chatId || (!!t.agentKind && t.agentKind !== "terminal" && !t.agentSessionId && !t.agentCommand);
}

const TOOL_STATE: Record<string, ToolCallInfo["state"]> = { running: "calling", completed: "completed", error: "error", interrupted: "interrupted" };

export type ChatPart = { kind: "segments"; segments: MessageSegment[] } | { kind: "approval"; approvalId: string };

/** A coding chat's segments as the chat's message segments; approvals split the runs. */
export function toChatParts(segments: CodingChatSegment[]): ChatPart[] {
  const out: ChatPart[] = [];
  const push = (seg: MessageSegment) => {
    const last = out[out.length - 1];
    if (last?.kind === "segments") last.segments.push(seg);
    else out.push({ kind: "segments", segments: [seg] });
  };
  for (const s of segments) {
    if (s.type === "text") push({ type: "text", content: s.text });
    else if (s.type === "reasoning") push({ type: "thinking", content: s.text });
    else if (s.type === "tool") {
      push({
        type: "tool",
        tool: {
          id: s.tool.id,
          name: s.tool.name,
          ...(s.tool.input ? { arguments: s.tool.input } : {}),
          ...(s.tool.output !== undefined ? { result: s.tool.output } : {}),
          ...(s.tool.diff ? { diff: s.tool.diff } : {}),
          state: TOOL_STATE[s.tool.state] ?? "completed",
        },
      });
    } else out.push({ kind: "approval", approvalId: s.approvalId });
  }
  return out;
}
