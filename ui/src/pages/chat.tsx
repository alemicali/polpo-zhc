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
  History,
  ChevronsLeft,
  Send,
  MessageCircleQuestion,
  PenLine,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import type { AskUserQuestion, AskUserAnswer, MessageSegment, ToolCallInfo } from "@/hooks/use-polpo";
import { ToolCallList, ToolInvocation, ToolCallGroup } from "@/components/ai-elements/tool";
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

// ── Ask User card (interactive question with option chips + custom input) ──

// ── Single question card (reused by both flat and wizard layouts) ──

function QuestionCard({
  q,
  sel,
  customText,
  disabled,
  submitting,
  onToggle,
  onCustomChange,
  onEnterSubmit,
}: {
  q: AskUserQuestion;
  sel: Set<string>;
  customText: string;
  disabled?: boolean;
  submitting: boolean;
  onToggle: (label: string, multiple: boolean) => void;
  onCustomChange: (text: string) => void;
  onEnterSubmit: () => void;
}) {
  const isMultiple = q.multiple ?? false;
  const showCustom = q.custom !== false;

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-4">
      {/* Question header */}
      <div className="flex items-start gap-2 mb-3">
        <MessageCircleQuestion className="h-4 w-4 text-primary mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          {q.header && (
            <p className="text-xs font-semibold text-primary/80 uppercase tracking-wider mb-0.5">
              {q.header}
            </p>
          )}
          <p className="text-sm font-medium">{q.question}</p>
        </div>
        {isMultiple && (
          <Badge variant="outline" className="text-[9px] shrink-0">
            Multi-select
          </Badge>
        )}
      </div>

      {/* Option chips */}
      {q.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {q.options.map((opt) => {
            const isSelected = sel.has(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                disabled={disabled || submitting}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-all",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary font-medium shadow-sm"
                    : "border-border/50 bg-card/60 text-muted-foreground hover:border-primary/30 hover:bg-primary/[0.04] hover:text-foreground"
                )}
                onClick={() => onToggle(opt.label, isMultiple)}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/40"
                  )}
                >
                  {isSelected && (
                    <Check className="h-2.5 w-2.5 text-primary-foreground" />
                  )}
                </span>
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Option descriptions */}
      {q.options.some((o) => o.description) && sel.size > 0 && (
        <div className="mb-3 pl-1">
          {q.options
            .filter((o) => sel.has(o.label) && o.description)
            .map((o) => (
              <p key={o.label} className="text-[11px] text-muted-foreground leading-snug">
                <span className="font-medium text-foreground/80">{o.label}:</span> {o.description}
              </p>
            ))}
        </div>
      )}

      {/* Custom text input */}
      {showCustom && (
        <div className="flex items-center gap-2">
          <PenLine className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            placeholder="Type your own answer..."
            className="h-8 text-sm bg-background/60"
            value={customText}
            disabled={disabled || submitting}
            onChange={(e) => onCustomChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onEnterSubmit();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── AskUser cards: wizard for multi-question, flat for single ──

function AskUserCards({
  questions,
  onSubmit,
  disabled,
}: {
  questions: AskUserQuestion[];
  onSubmit: (answers: AskUserAnswer[]) => void;
  disabled?: boolean;
}) {
  const [selections, setSelections] = useState<Record<string, Set<string>>>(() => {
    const init: Record<string, Set<string>> = {};
    for (const q of questions) init[q.id] = new Set();
    return init;
  });
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) init[q.id] = "";
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(0);

  const toggleOption = (questionId: string, label: string, multiple: boolean) => {
    setSelections((prev) => {
      const curr = new Set(prev[questionId]);
      if (curr.has(label)) {
        curr.delete(label);
      } else {
        if (!multiple) curr.clear();
        curr.add(label);
      }
      return { ...prev, [questionId]: curr };
    });
  };

  const hasAnyAnswer = questions.some((q) => {
    const sel = selections[q.id];
    const txt = customTexts[q.id]?.trim();
    return (sel && sel.size > 0) || (txt && txt.length > 0);
  });

  const handleSubmit = () => {
    if (!hasAnyAnswer || submitting) return;
    setSubmitting(true);
    const answers: AskUserAnswer[] = questions.map((q) => ({
      questionId: q.id,
      selected: Array.from(selections[q.id] ?? []),
      customText: customTexts[q.id]?.trim() || undefined,
    }));
    onSubmit(answers);
  };

  const isWizard = questions.length > 1;
  const current = questions[step];
  const isLastStep = step === questions.length - 1;

  // Check if current step has an answer
  const currentHasAnswer = current
    ? ((selections[current.id]?.size ?? 0) > 0) || (customTexts[current.id]?.trim().length > 0)
    : false;

  return (
    <div className="mt-3">
      {isWizard ? (
        <>
          {/* Step indicator */}
          <div className="flex items-center gap-1.5 mb-3">
            {questions.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setStep(idx)}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  idx === step
                    ? "w-6 bg-primary"
                    : idx < step
                      ? "w-3 bg-primary/40"
                      : "w-3 bg-border/60",
                )}
              />
            ))}
            <span className="text-[10px] text-muted-foreground ml-1.5">
              {step + 1} / {questions.length}
            </span>
          </div>

          {/* Current question */}
          <QuestionCard
            q={current}
            sel={selections[current.id] ?? new Set()}
            customText={customTexts[current.id] ?? ""}
            disabled={disabled}
            submitting={submitting}
            onToggle={(label, multiple) => toggleOption(current.id, label, multiple)}
            onCustomChange={(text) =>
              setCustomTexts((prev) => ({ ...prev, [current.id]: text }))
            }
            onEnterSubmit={() => {
              if (isLastStep && hasAnyAnswer) handleSubmit();
              else if (!isLastStep) setStep(step + 1);
            }}
          />

          {/* Wizard navigation */}
          <div className="flex items-center justify-between mt-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
              className="gap-1 text-muted-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </Button>

            {isLastStep ? (
              <Button
                size="sm"
                disabled={!hasAnyAnswer || disabled || submitting}
                onClick={handleSubmit}
                className="gap-1.5"
              >
                {submitting ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    Send answers
                  </>
                )}
              </Button>
            ) : (
              <Button
                size="sm"
                variant={currentHasAnswer ? "default" : "outline"}
                onClick={() => setStep(step + 1)}
                className="gap-1"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </>
      ) : (
        /* Single question — flat layout (no wizard) */
        <div className="space-y-3">
          <QuestionCard
            q={questions[0]}
            sel={selections[questions[0].id] ?? new Set()}
            customText={customTexts[questions[0].id] ?? ""}
            disabled={disabled}
            submitting={submitting}
            onToggle={(label, multiple) => toggleOption(questions[0].id, label, multiple)}
            onCustomChange={(text) =>
              setCustomTexts((prev) => ({ ...prev, [questions[0].id]: text }))
            }
            onEnterSubmit={() => { if (hasAnyAnswer) handleSubmit(); }}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!hasAnyAnswer || disabled || submitting}
              onClick={handleSubmit}
              className="gap-1.5"
            >
              {submitting ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  Send answer
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
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
      <div className="px-3 py-2 border-b border-border/40 flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Sessions
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNew}>
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
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate leading-snug">
                    {s.title || "Untitled"}
                  </p>
                  <span className="text-[10px] opacity-50">
                    {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}
                  </span>
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
    sessionsLoading,
    pendingQuestions,
    send,
    answerQuestions,
    clear,
    loadSession,
    newSession,
    deleteSession,
  } = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Filter out empty/orphan sessions — server creates placeholder sessions
  // before streaming starts; if streaming fails these remain empty
  const visibleSessions = sessions.filter(
    (s) => s.messageCount > 1 || (s.messageCount === 1 && s.title),
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() || isLoading) return;
      await send(message.text.trim());
    },
    [isLoading, send]
  );

  const isEmpty = messages.length === 0;

  // ── Loading skeleton ──
  if (sessionsLoading) {
    return (
      <div className="flex -mx-4 -mt-4 -mb-2 lg:-mx-6 lg:-mt-6 lg:-mb-3 flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0 h-full">
          {/* Skeleton toolbar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 shrink-0">
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-4 w-32 rounded" />
            <div className="flex-1" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>

          {/* Skeleton messages */}
          <div className="flex-1 overflow-hidden">
            <div className="mx-auto max-w-3xl p-4 space-y-6">
              {/* User message skeleton */}
              <div className="flex justify-end">
                <Skeleton className="h-10 w-48 rounded-2xl rounded-br-sm" />
              </div>
              {/* Assistant message skeleton */}
              <div className="flex gap-3">
                <Skeleton className="h-7 w-7 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-16 rounded" />
                  <Skeleton className="h-4 w-full rounded" />
                  <Skeleton className="h-4 w-3/4 rounded" />
                  <Skeleton className="h-4 w-5/6 rounded" />
                </div>
              </div>
              {/* User message skeleton */}
              <div className="flex justify-end">
                <Skeleton className="h-10 w-36 rounded-2xl rounded-br-sm" />
              </div>
              {/* Assistant message skeleton */}
              <div className="flex gap-3">
                <Skeleton className="h-7 w-7 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-16 rounded" />
                  <Skeleton className="h-4 w-full rounded" />
                  <Skeleton className="h-4 w-2/3 rounded" />
                </div>
              </div>
            </div>
          </div>

          {/* Prompt input — shown immediately even during loading */}
          <div className="bg-background/80 backdrop-blur-md px-4 pt-2 pb-1.5 shrink-0">
            <div className="mx-auto max-w-3xl">
              <PromptInput onSubmit={handleSubmit} className="[&_[data-slot=input-group]]:rounded-2xl">
                <PromptInputTextarea placeholder="Message Polpo..." disabled />
                <PromptInputFooter>
                  <div className="flex items-center gap-1" />
                  <PromptInputSubmit disabled />
                </PromptInputFooter>
              </PromptInput>
              <p className="text-[10px] text-muted-foreground text-center mt-0.5">
                Enter to send, Shift+Enter for new line.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex -mx-4 -mt-4 -mb-2 lg:-mx-6 lg:-mt-6 lg:-mb-3 flex-1 min-h-0">
      {/* Session sidebar — hidden on mobile */}
      {sidebarOpen && (
        <div className="hidden lg:flex">
          <SessionSidebar
            sessions={visibleSessions}
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
                {sidebarOpen ? <ChevronsLeft className="h-4 w-4" /> : <History className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {sidebarOpen ? "Hide history" : "Session history"}
            </TooltipContent>
          </Tooltip>
          {/* New session — only when sidebar is closed */}
          {!sidebarOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={newSession}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                New session
              </TooltipContent>
            </Tooltip>
          )}
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
            <>
              <Badge variant="secondary" className="text-[10px]">
                {messages.length} messages
              </Badge>
              {!isLoading && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={clear}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    Clear session
                  </TooltipContent>
                </Tooltip>
              )}
            </>
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
                {messages.map((msg, i) => {
                  // Copy is only shown when the message is complete (not still streaming)
                  const isStreaming = isLoading && i === messages.length - 1;

                  return msg.role === "user" ? (
                    <div key={msg.id || i} className="group w-full py-4 px-4">
                      <div className="mx-auto max-w-3xl">
                        <div className="flex justify-end">
                          <div className="max-w-[85%]">
                            <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5">
                              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                {msg.content}
                              </p>
                            </div>
                            <div className="flex items-center justify-end gap-1.5 mt-1">
                              {msg.ts && (
                                <span className="text-[10px] text-muted-foreground">
                                  {formatDistanceToNow(new Date(msg.ts), { addSuffix: true })}
                                </span>
                              )}
                              <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                                <CopyAction text={msg.content} />
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={msg.id || i} className="group w-full py-4 px-4">
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
                                {/* Render segments chronologically, grouping consecutive tools */}
                                {msg.segments && msg.segments.length > 0 ? (
                                  (() => {
                                    // Group consecutive tool segments into runs
                                    const groups: Array<{ type: "text"; content: string } | { type: "tools"; tools: ToolCallInfo[] }> = [];
                                    for (const seg of msg.segments as MessageSegment[]) {
                                      if (seg.type === "text") {
                                        groups.push({ type: "text", content: seg.content });
                                      } else {
                                        const last = groups[groups.length - 1];
                                        if (last && last.type === "tools") {
                                          last.tools.push(seg.tool);
                                        } else {
                                          groups.push({ type: "tools", tools: [seg.tool] });
                                        }
                                      }
                                    }
                                    return groups.map((g, gi) =>
                                      g.type === "text" ? (
                                        <MessageContent key={`g-${gi}`}>
                                          <MessageResponse>{g.content}</MessageResponse>
                                        </MessageContent>
                                      ) : g.tools.length === 1 ? (
                                        <ToolInvocation key={g.tools[0].id} tool={g.tools[0]} />
                                      ) : (
                                        <ToolCallGroup key={`tg-${gi}`} tools={g.tools} />
                                      )
                                    );
                                  })()
                                ) : (
                                  <>
                                    {/* Fallback for saved sessions without segments */}
                                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                                      <ToolCallList tools={msg.toolCalls} />
                                    )}
                                    <MessageContent>
                                      <MessageResponse>{msg.content}</MessageResponse>
                                    </MessageContent>
                                  </>
                                )}
                                {!isStreaming && (
                                  <MessageActions className="mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <CopyAction text={msg.content} />
                                  </MessageActions>
                                )}
                                {/* Ask User interactive cards — shown inline with the assistant message */}
                                {msg.askUserQuestions && msg.askUserQuestions.length > 0 && (
                                  <AskUserCards
                                    questions={msg.askUserQuestions}
                                    onSubmit={answerQuestions}
                                    disabled={isLoading || !pendingQuestions}
                                  />
                                )}
                              </div>
                            </div>
                        </Message>
                      </div>
                    </div>
                  );
                })}

                {isLoading && (
                  <div className="w-full py-2 px-4">
                    <div className="mx-auto max-w-3xl">
                      <div className="flex items-center gap-2.5 pl-10 py-1.5">
                        <div className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
                          <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
                          <span className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
                        </div>
                        <span className="text-[11px] text-muted-foreground animate-pulse">
                          Polpo is thinking...
                        </span>
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
        <div className="bg-background/80 backdrop-blur-md px-4 pt-2 pb-1.5 shrink-0">
          <div className="mx-auto max-w-3xl">
            <PromptInput onSubmit={handleSubmit} className="[&_[data-slot=input-group]]:rounded-2xl">
              <PromptInputTextarea
                placeholder={isLoading ? "Polpo is working..." : pendingQuestions ? "Answer the questions above first..." : "Message Polpo..."}
                disabled={isLoading || !!pendingQuestions}
              />
              <PromptInputFooter>
                <div className="flex items-center gap-1" />
                <PromptInputSubmit
                  status={isLoading ? "streaming" : undefined}
                  disabled={!!pendingQuestions}
                />
              </PromptInputFooter>
            </PromptInput>
            <p className="text-[10px] text-muted-foreground text-center mt-0.5">
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
