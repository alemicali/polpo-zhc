import { useState, useCallback } from "react";
import {
  Copy,
  Check,
  Trash2,
  Zap,
  ListChecks,
  Map,
  MessageSquare,
  Plus,
  Clock,
  Columns2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { useChat } from "@/hooks/use-polpo";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

// ── Copy button ──

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <MessageAction tooltip={copied ? "Copied!" : "Copy"} onClick={copy}>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </MessageAction>
  );
}

// ── Suggestions for empty state ──

const suggestions = [
  {
    icon: Zap,
    title: "What's the current status?",
    description: "Overview of tasks, agents, and plans",
  },
  {
    icon: ListChecks,
    title: "Show me failed tasks",
    description: "Tasks that need attention",
  },
  {
    icon: Map,
    title: "Create a plan to refactor the auth module",
    description: "Generate a multi-task execution plan",
  },
  {
    icon: MessageSquare,
    title: "List all active agents",
    description: "See which agents are configured",
  },
];

// ── Session sidebar ──

function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: { id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number }[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="w-56 border-r border-border/30 flex flex-col bg-card/40 h-full">
      <div className="p-3 border-b border-border/30 flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Sessions
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onNew}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            New session
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-1.5 space-y-0.5">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center text-center py-8 px-3 text-muted-foreground">
              <p className="text-xs font-medium">No sessions yet</p>
              <p className="text-[10px] mt-1">
                Start a new session or use the TUI — sessions are shared
                between both interfaces.
              </p>
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "group flex items-start gap-2 rounded-md px-2.5 py-2 cursor-pointer transition-colors",
                  activeSessionId === s.id
                    ? "bg-accent/80 text-accent-foreground"
                    : "hover:bg-accent/30 text-muted-foreground"
                )}
                onClick={() => onSelect(s.id)}
              >
                <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0 opacity-50" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate leading-snug">
                    {s.title || "Untitled"}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Clock className="h-2.5 w-2.5 opacity-40" />
                    <span className="text-[10px] opacity-60">
                      {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
                    </span>
                    <span className="text-[9px] opacity-40">
                      upd. {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}
                    </span>
                    {s.messageCount > 0 && (
                      <span className="text-[9px] opacity-50">{s.messageCount} msg</span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main ──

export function ChatPage() {
  const {
    messages,
    isLoading,
    sessionId,
    sessions,
    send,
    clear,
    loadSession,
    newSession,
    deleteSession,
  } = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    return typeof window !== "undefined" && window.innerWidth >= 1024;
  });

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() || isLoading) return;
      await send(message.text.trim());
    },
    [isLoading, send]
  );

  const isEmpty = messages.length === 0;

  return (
    <div className="flex -m-4 lg:-mx-6 lg:-my-6 flex-1 min-h-0">
      {/* Session sidebar — hidden on mobile */}
      {sidebarOpen && (
        <div className="hidden lg:flex">
          <SessionSidebar
            sessions={sessions}
            activeSessionId={sessionId}
            onSelect={loadSession}
            onNew={newSession}
            onDelete={deleteSession}
          />
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Chat toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-background/80 backdrop-blur-md shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <Columns2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {sidebarOpen ? "Hide sessions" : "Show sessions"}
            </TooltipContent>
          </Tooltip>
          <div className="flex-1 min-w-0">
            {sessionId ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">
                  {sessions.find((s) => s.id === sessionId)?.title || "Session"}
                </span>
                <Badge variant="outline" className="text-[10px] font-mono">
                  {sessionId.slice(0, 8)}
                </Badge>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">New session</span>
            )}
          </div>
          {messages.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {messages.length} messages
            </Badge>
          )}
        </div>

        {/* Messages area */}
        <Conversation className="flex-1 min-h-0">
          <ConversationContent className="mx-auto max-w-3xl gap-0 p-0">
            {isEmpty ? (
              <div className="flex flex-col items-center justify-center h-full pt-24">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4 text-3xl">
                  🐙
                </div>
                <h2 className="text-2xl font-semibold mb-2">How can I help you?</h2>
                <p className="text-sm text-muted-foreground mb-8 max-w-md text-center">
                  I can manage your tasks, create execution plans, monitor agents,
                  and help you orchestrate your AI coding team.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl w-full px-4">
                  {suggestions.map((s) => (
                    <button
                      key={s.title}
                      onClick={() => send(s.title)}
                      className="flex items-start gap-3 rounded-xl border border-border/40 p-4 text-left transition-all hover:bg-accent/30 hover:border-primary/20"
                    >
                      <s.icon className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {s.description}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg, i) =>
                  msg.role === "user" ? (
                    <div key={msg.id || i} className="w-full py-4 px-4">
                      <div className="mx-auto max-w-3xl">
                        <div className="flex justify-end">
                          <div className="max-w-[85%]">
                            <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5">
                              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                {msg.content}
                              </p>
                            </div>
                            {msg.ts && (
                              <p className="text-[10px] text-muted-foreground mt-1 text-right">
                                {formatDistanceToNow(new Date(msg.ts), { addSuffix: true })}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={msg.id || i} className="w-full py-4 px-4 bg-muted/20">
                      <div className="mx-auto max-w-3xl">
                        <Message from="assistant">
                          <div className="flex gap-3">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5 text-sm">
                              🐙
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="text-xs font-semibold">Polpo</p>
                                {msg.ts && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {formatDistanceToNow(new Date(msg.ts), { addSuffix: true })}
                                  </span>
                                )}
                              </div>
                              <MessageContent>
                                <MessageResponse>{msg.content}</MessageResponse>
                              </MessageContent>
                              <MessageActions className="mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <CopyAction text={msg.content} />
                              </MessageActions>
                            </div>
                          </div>
                        </Message>
                      </div>
                    </div>
                  )
                )}

                {isLoading && messages.at(-1)?.role !== "assistant" && (
                  <div className="w-full py-2 px-4">
                    <div className="mx-auto max-w-3xl pl-10">
                      <div className="flex items-center gap-1.5 py-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-bounce [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {/* Input */}
        <div className="bg-background/80 backdrop-blur-md px-4 py-3 shrink-0">
          <div className="mx-auto max-w-3xl">
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputTextarea placeholder="Message Polpo..." />
              <PromptInputFooter>
                <div className="flex items-center gap-1">
                  {messages.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={clear}
                          type="button"
                          className="text-muted-foreground hover:text-foreground h-8 px-2"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                          <span className="text-xs">Clear</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Clear session
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <PromptInputSubmit />
              </PromptInputFooter>
            </PromptInput>
            <p className="text-[10px] text-muted-foreground text-center mt-1.5">
              Enter to send, Shift+Enter for new line.
              {sessionId && (
                <> Session <code className="font-mono">{sessionId.slice(0, 8)}</code> — shared with TUI.</>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
