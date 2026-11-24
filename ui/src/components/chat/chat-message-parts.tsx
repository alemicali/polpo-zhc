/**
 * The pieces a chat conversation is drawn with, shared by the chat page and every other place
 * that shows a conversation the same way (a task's run as a chat, in Tasks → Execution → Chat):
 * the user's bubble, the assistant's avatar and the assistant's message body (text, reasoning,
 * tool calls grouped as "Used N tools ›", widgets and artifacts in their place in the flow).
 */
import type { ComponentProps, ReactNode } from "react";
import { ChatAttachments } from "@/components/chat-attachments";
import { CollapsibleUserMessage } from "@/components/shared/collapsible-user-message";
import { MentionText } from "@/components/ai-elements/mention-popover";
import { MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { ToolCallGroup, ToolInvocation } from "@/components/ai-elements/tool";
import { WidgetCard, WidgetPendingCard } from "@/components/widget-card";
import { ArtifactChatCard } from "@/components/artifacts/artifact-chat-card";
import { ArtifactGeneration } from "@/components/artifacts/artifact-generation";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { artifactIdOf } from "@/lib/artifacts-api";
import { cn } from "@/lib/utils";
import type { MessageSegment, ToolCallInfo, WidgetRenderData } from "@/hooks/use-polpo";

/** The user's message: the primary-coloured bubble, attachments on top, long text clipped. */
export function ChatUserBubble({
  text,
  attachments,
  className,
  children,
}: {
  text: string;
  attachments?: ComponentProps<typeof ChatAttachments>["attachments"];
  className?: string;
  /** Replaces the text (mentions highlighted) when given. */
  children?: ReactNode;
}) {
  return (
    <div className={cn("rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5", className)} data-testid="chat-user-bubble">
      <ChatAttachments attachments={attachments} />
      <CollapsibleUserMessage text={text}>
        {children ?? <MentionText text={text} variant="inverted" />}
      </CollapsibleUserMessage>
    </div>
  );
}

/** The assistant's round avatar: the agent's picture, its initials, or Polpo's octopus. */
export function ChatAssistantAvatar({ avatar, name, isAgent }: { avatar?: string; name: string; isAgent: boolean }) {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-primary/10 mt-0.5 text-sm">
      {avatar ? (
        <AgentAvatar avatar={avatar} name={name} size="sm" />
      ) : isAgent ? (
        <AgentAvatar name={name} size="sm" />
      ) : (
        <>🐙</>
      )}
    </div>
  );
}

type SegmentGroup =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tools"; tools: ToolCallInfo[] }
  | { type: "widget"; widget: WidgetRenderData; key: string }
  | { type: "widget-pending"; tool: ToolCallInfo }
  | { type: "artifact"; artifactId: string; updated: boolean; key: string }
  | { type: "artifact-pending"; tool: ToolCallInfo };

/**
 * An assistant message's body, in the order it happened: consecutive tool calls grouped
 * ("Used 4 tools, 1 failed ›"), consecutive reasoning chunks merged, the N-th render_widget call
 * drawn as the N-th widget right where it was called (not at the bottom of the message), and an
 * artifact made or changed here as a card that opens it.
 */
export function AssistantSegments({
  segments,
  widgets,
  isStreaming,
}: {
  segments: MessageSegment[];
  widgets?: WidgetRenderData[];
  isStreaming: boolean;
}) {
  const groups: SegmentGroup[] = [];
  const widgetsArr = widgets ?? [];
  let widgetCounter = 0;
  const pushTool = (tool: ToolCallInfo) => {
    const last = groups[groups.length - 1];
    if (last && last.type === "tools") last.tools.push(tool);
    else groups.push({ type: "tools", tools: [tool] });
  };
  for (const seg of segments) {
    if (seg.type === "text") {
      groups.push({ type: "text", content: seg.content });
    } else if (seg.type === "thinking") {
      const last = groups[groups.length - 1];
      if (last && last.type === "thinking") last.content += seg.content;
      else groups.push({ type: "thinking", content: seg.content });
    } else if (seg.type === "tool") {
      const isArtifactTool = seg.tool.name === "artifact_create" || seg.tool.name === "artifact_update";
      const madeArtifact = isArtifactTool && seg.tool.state === "completed" ? artifactIdOf(seg.tool.result) : undefined;
      if (madeArtifact) {
        groups.push({ type: "artifact", artifactId: madeArtifact, updated: seg.tool.name === "artifact_update", key: seg.tool.id });
      } else if (isArtifactTool && (seg.tool.state === "preparing" || seg.tool.state === "calling")) {
        if (isStreaming) groups.push({ type: "artifact-pending", tool: seg.tool });
        else groups.push({ type: "tools", tools: [{ ...seg.tool, state: "interrupted" }] });
      } else if (seg.tool.name === "render_widget") {
        const w = widgetsArr[widgetCounter];
        if (w) groups.push({ type: "widget", widget: w, key: seg.tool.id });
        // a validation error: the ordinary tool line, with the error visible
        else if (seg.tool.state === "error") pushTool(seg.tool);
        // the html has not arrived yet: a placeholder, so the message does not jump
        else groups.push({ type: "widget-pending", tool: seg.tool });
        widgetCounter += 1;
      } else {
        pushTool(seg.tool);
      }
    }
  }

  return (
    <>
      {groups.map((g, gi) => {
        if (g.type === "text") {
          return (
            <MessageContent key={`g-${gi}`}>
              <MessageResponse mode={isStreaming ? "streaming" : "static"}>{g.content}</MessageResponse>
            </MessageContent>
          );
        }
        if (g.type === "thinking") {
          return (
            <Reasoning key={`r-${gi}`} isStreaming={isStreaming}>
              <ReasoningTrigger />
              <ReasoningContent>{g.content}</ReasoningContent>
            </Reasoning>
          );
        }
        if (g.type === "widget") return <WidgetCard key={`w-${g.key}`} widget={g.widget} />;
        if (g.type === "artifact") return <ArtifactChatCard key={`a-${g.key}`} artifactId={g.artifactId} updated={g.updated} />;
        if (g.type === "artifact-pending") return <ArtifactGeneration key={`a-${g.tool.id}`} tool={g.tool} />;
        if (g.type === "widget-pending") {
          return <WidgetPendingCard key={`wp-${g.tool.id}`} argsBytes={g.tool.argumentsText?.length} />;
        }
        return g.tools.length === 1 ? (
          <ToolInvocation key={g.tools[0].id} tool={g.tools[0]} />
        ) : (
          <ToolCallGroup key={`tg-${gi}`} tools={g.tools} />
        );
      })}
    </>
  );
}
