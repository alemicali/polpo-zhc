"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Suggestions,
  Suggestion,
} from "@/components/ai-elements/suggestion";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  useOrchestra,
  useAgents,
  useTasks,
  usePlans,
  type Task,
} from "@orchestra/react";
import { TaskStatusBadge } from "@/components/tasks/task-status-badge";
import { formatDuration, formatScore, formatTimeAgo } from "@/lib/orchestra";
import {
  ExternalLink,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Clock,
  MessageCircle,
  ListTodo,
  Map,
  Keyboard,
  Code2,
  BookOpen,
  Pencil,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { HumanReadableView } from "@/components/plans/plan-yaml-view";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { cn } from "@/lib/utils";

type InputMode = "chat" | "task" | "plan";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cards?: { type: "task"; data: Task }[];
  actions?: { label: string; href: string }[];
  mode?: InputMode;
  yaml?: string;
  planId?: string;
}

const MODE_CONFIG: Record<InputMode, { label: string; color: string; icon: typeof MessageCircle; placeholder: string; shortcut: string }> = {
  chat: {
    label: "Chat",
    color: "text-purple-400",
    icon: MessageCircle,
    placeholder: "Ask about tasks, agents, plans, project state…",
    shortcut: "LLM-powered Q&A about your project",
  },
  task: {
    label: "Task",
    color: "text-cyan-400",
    icon: ListTodo,
    placeholder: "Describe a task… (prefix @agent to assign, %group to tag)",
    shortcut: "Creates a task and assigns it to an agent",
  },
  plan: {
    label: "Plan",
    color: "text-amber-400",
    icon: Map,
    placeholder: "Describe what you want to build…",
    shortcut: "AI generates a multi-task plan with dependencies",
  },
};

const CHAT_SUGGESTIONS = [
  "What's the current status?",
  "Which agents are idle?",
  "Show failed tasks",
  "What was the last completed task?",
];

function PlanPreviewInline({
  yaml,
  onExecute,
  onRefine,
  onUpdateYaml,
}: {
  yaml: string;
  onExecute: (yaml: string) => void;
  onRefine: (yaml: string, feedback: string) => void;
  onUpdateYaml: (msgYaml: string, newYaml: string) => void;
}) {
  const [viewMode, setViewMode] = useState<"readable" | "yaml" | "edit">("readable");
  const [editYaml, setEditYaml] = useState(yaml);
  const [refineMode, setRefineMode] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div className="ml-10 mt-2 mb-4 space-y-2">
      <div className="rounded-lg border bg-muted/20 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
          <span className="text-xs text-muted-foreground font-medium">Plan Preview</span>
          <div className="flex rounded-md border bg-muted/50">
            <button
              type="button"
              className={cn("h-6 px-2 text-[10px] rounded-l-md transition-colors", viewMode === "readable" && "bg-background shadow-sm")}
              onClick={() => setViewMode("readable")}
            >
              <BookOpen className="inline mr-1 h-3 w-3" />Readable
            </button>
            <button
              type="button"
              className={cn("h-6 px-2 text-[10px] transition-colors", viewMode === "yaml" && "bg-background shadow-sm")}
              onClick={() => setViewMode("yaml")}
            >
              <Code2 className="inline mr-1 h-3 w-3" />YAML
            </button>
            <button
              type="button"
              className={cn("h-6 px-2 text-[10px] rounded-r-md transition-colors", viewMode === "edit" && "bg-background shadow-sm")}
              onClick={() => { setEditYaml(yaml); setViewMode("edit"); }}
            >
              <Pencil className="inline mr-1 h-3 w-3" />Edit
            </button>
          </div>
        </div>
        {viewMode === "readable" && <HumanReadableView yaml={yaml} />}
        {viewMode === "yaml" && (
          <CodeBlock code={yaml} language="yaml" showLineNumbers>
            <CodeBlockHeader>
              <CodeBlockTitle>plan.yaml</CodeBlockTitle>
              <CodeBlockCopyButton />
            </CodeBlockHeader>
          </CodeBlock>
        )}
        {viewMode === "edit" && (
          <div className="p-3 space-y-2">
            <textarea
              className="w-full font-mono text-xs bg-transparent border rounded p-2 min-h-[200px] resize-y focus:outline-none focus:ring-1 focus:ring-ring"
              value={editYaml}
              onChange={(e) => setEditYaml(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                onUpdateYaml(yaml, editYaml);
                setViewMode("readable");
              }}>
                Save Changes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setViewMode("readable")}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Refine input */}
      {refineMode && (
        <div className="flex gap-2">
          <input
            className="flex-1 h-8 text-xs border rounded px-2 bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="e.g. Add more tests, split the backend task, use Opus for the architect..."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && feedback.trim()) {
                onRefine(yaml, feedback.trim());
                setFeedback("");
                setRefineMode(false);
              }
              if (e.key === "Escape") setRefineMode(false);
            }}
            autoFocus
          />
          <Button size="sm" disabled={!feedback.trim()} onClick={() => {
            onRefine(yaml, feedback.trim());
            setFeedback("");
            setRefineMode(false);
          }}>
            Refine
          </Button>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onExecute(yaml)}>
          <ArrowRight className="mr-1.5 h-3.5 w-3.5" /> Execute
        </Button>
        {!refineMode && (
          <Button size="sm" variant="outline" onClick={() => setRefineMode(true)}>
            <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Refine
          </Button>
        )}
      </div>
    </div>
  );
}

/** Wrapper that centers content within the full-width scroller */
function ChatRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-5xl mx-auto w-full px-4">
      {children}
    </div>
  );
}

export function ChatInterface() {
  const { client } = useOrchestra();
  const { agents } = useAgents();
  const { createTask } = useTasks();
  const { createPlan, executePlan: execPlan } = usePlans();
  const router = useRouter();
  const params = useParams<{ projectId: string }>();

  // Persist chat messages in localStorage
  const storageKey = `orchestra-chat-${params.projectId ?? "default"}`;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InputMode>("chat");
  const loadedKeyRef = useRef<string | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Load from localStorage when storageKey is ready
  useEffect(() => {
    if (loadedKeyRef.current === storageKey) return;
    loadedKeyRef.current = storageKey;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setMessages(JSON.parse(saved));
    } catch {}
  }, [storageKey]);

  // Sync to localStorage
  const setMessagesAndPersist = useCallback((updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessages((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { localStorage.setItem(storageKey, JSON.stringify(next.slice(-100))); } catch {}
      return next;
    });
  }, [storageKey]);
  const [isLoading, setIsLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const basePath = `/projects/${params.projectId}`;

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessagesAndPersist((prev) => [...prev, msg]);
  }, [setMessagesAndPersist]);

  const cycleMode = useCallback(() => {
    setMode((m) => {
      const modes: InputMode[] = ["chat", "task", "plan"];
      return modes[(modes.indexOf(m) + 1) % modes.length];
    });
  }, []);

  // ── Chat mode: LLM Q&A ──────────────────────────────────
  const handleChat = useCallback(async (text: string) => {
    setIsLoading(true);
    try {
      const { response } = await client.chat(text);
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: response,
        mode: "chat",
      });
    } catch (err) {
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Error:** ${err instanceof Error ? err.message : "Failed to get response"}`,
        mode: "chat",
      });
    } finally {
      setIsLoading(false);
    }
  }, [client, addMessage]);

  // ── Task mode: create task ───────────────────────────────
  const handleTask = useCallback(async (text: string) => {
    let assignTo = agents[0]?.name || "default";
    let group: string | undefined;
    let description = text;

    // Extract %group
    const groupMatch = description.match(/%([a-zA-Z0-9_-]+)/);
    if (groupMatch) {
      group = groupMatch[1];
      description = description.replace(groupMatch[0], "").trim();
    }

    // Extract @agent
    const atMatch = description.match(/^@(\w+)\s+([\s\S]+)$/);
    if (atMatch) {
      const found = agents.find((a) => a.name === atMatch[1]);
      if (found) {
        assignTo = found.name;
        description = atMatch[2];
      } else {
        description = atMatch[2];
        toast.error(`Agent "${atMatch[1]}" not found, using ${assignTo}`);
      }
    }

    setIsLoading(true);
    try {
      const task = await createTask({
        title: description.slice(0, 80),
        description,
        assignTo,
        group,
      });
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Task created and assigned to **${assignTo}**`,
        mode: "task",
        cards: [{ type: "task", data: task }],
        actions: [{ label: "View Task", href: `${basePath}/tasks/${task.id}` }],
      });
    } catch (err) {
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Error creating task:** ${err instanceof Error ? err.message : "Unknown error"}`,
        mode: "task",
      });
    } finally {
      setIsLoading(false);
    }
  }, [agents, createTask, addMessage, basePath]);

  // ── Plan mode: generate plan via LLM ─────────────────────
  const handlePlan = useCallback(async (text: string) => {
    setIsLoading(true);
    try {
      const { yaml } = await client.generatePlan(text);
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Plan generated.** Review below and click Execute to launch.`,
        mode: "plan",
        yaml,
      });
    } catch (err) {
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Error generating plan:** ${err instanceof Error ? err.message : "Unknown error"}`,
        mode: "plan",
      });
    } finally {
      setIsLoading(false);
    }
  }, [client, addMessage]);

  // Execute a generated plan
  const handleExecutePlan = useCallback(async (yaml: string) => {
    try {
      const plan = await createPlan({ yaml, status: "draft" });
      const result = await execPlan(plan.id);
      toast.success(`Launched ${result.tasks.length} tasks`);
      setMessagesAndPersist((prev) =>
        prev.map((m) =>
          m.yaml === yaml
            ? {
                ...m,
                yaml: undefined,
                actions: [{ label: "View Plan", href: `${basePath}/plans/${plan.id}` }],
                content: m.content + `\n\n**Executed!** ${result.tasks.length} tasks launched.`,
              }
            : m
        )
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to execute plan");
    }
  }, [createPlan, execPlan, basePath, setMessagesAndPersist]);

  // Refine a generated plan with AI feedback
  const handleRefinePlan = useCallback(async (currentYaml: string, feedback: string) => {
    setIsLoading(true);
    addMessage({
      id: Date.now().toString(),
      role: "user",
      content: feedback,
      mode: "plan",
    });
    try {
      const { yaml: newYaml } = await client.refinePlan(currentYaml, "", feedback);
      setMessagesAndPersist((prev) =>
        prev.map((m) =>
          m.yaml === currentYaml ? { ...m, yaml: newYaml } : m
        )
      );
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Plan refined.** Review the updated plan below.`,
        mode: "plan",
        yaml: newYaml,
      });
    } catch (err) {
      addMessage({
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `**Error refining plan:** ${err instanceof Error ? err.message : "Unknown error"}`,
        mode: "plan",
      });
    } finally {
      setIsLoading(false);
    }
  }, [client, addMessage, setMessagesAndPersist]);

  // Update plan YAML after manual edit
  const handleUpdatePlanYaml = useCallback((oldYaml: string, newYaml: string) => {
    setMessagesAndPersist((prev) =>
      prev.map((m) =>
        m.yaml === oldYaml ? { ...m, yaml: newYaml } : m
      )
    );
  }, [setMessagesAndPersist]);

  // ── Submit handler ───────────────────────────────────────
  const handleSubmit = useCallback(
    (msg: PromptInputMessage) => {
      const text = msg.text.trim();
      if (!text) return;

      addMessage({
        id: Date.now().toString(),
        role: "user",
        content: text,
        mode,
      });
      setInput("");

      if (mode === "chat") handleChat(text);
      else if (mode === "task") handleTask(text);
      else if (mode === "plan") handlePlan(text);
    },
    [mode, handleChat, handleTask, handlePlan, addMessage]
  );

  const handleSuggestion = useCallback(
    (text: string) => handleSubmit({ text, files: [] }),
    [handleSubmit]
  );

  const ModeIcon = MODE_CONFIG[mode].icon;

  const clearChat = useCallback(() => {
    setMessagesAndPersist([]);
  }, [setMessagesAndPersist]);

  // Build items array: messages + optional loading indicator
  const items: (ChatMessage | "loading")[] = [
    ...messages,
    ...(isLoading ? ["loading" as const] : []),
  ];

  const renderItem = useCallback(
    (_index: number, item: ChatMessage | "loading") => {
      if (item === "loading") {
        return (
          <ChatRow>
            <Message from="assistant">
              <MessageContent>
                <Shimmer className="w-48 h-4">
                  {mode === "chat" ? "Thinking…" : mode === "plan" ? "Generating plan…" : "Creating task…"}
                </Shimmer>
              </MessageContent>
            </Message>
          </ChatRow>
        );
      }

      const msg = item;
      return (
        <ChatRow>
          <Message from={msg.role}>
            <MessageContent>
              {msg.role === "user" && msg.mode && (
                <Badge variant="outline" className={`mb-1 text-[9px] ${MODE_CONFIG[msg.mode].color}`}>
                  {MODE_CONFIG[msg.mode].label}
                </Badge>
              )}
              {msg.yaml ? (
                <MessageResponse>**Plan generated.** Review below and click Execute to launch.</MessageResponse>
              ) : (
                <MessageResponse>{msg.content}</MessageResponse>
              )}
            </MessageContent>
          </Message>
          {/* Plan preview + execute */}
          {msg.yaml && (
            <PlanPreviewInline
              yaml={msg.yaml}
              onExecute={handleExecutePlan}
              onRefine={handleRefinePlan}
              onUpdateYaml={handleUpdatePlanYaml}
            />
          )}
          {/* Task cards */}
          {msg.cards && msg.cards.length > 0 && (
            <div className="ml-10 mt-2 space-y-2 mb-4">
              {msg.cards.map((card) => {
                const task = card.data;
                return (
                  <Card
                    key={task.id}
                    className="cursor-pointer hover:border-primary/40 transition-colors"
                    onClick={() => router.push(`${basePath}/tasks/${task.id}`)}
                  >
                    <CardContent className="p-3 flex items-center gap-3">
                      <TaskStatusBadge status={task.status} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{task.title}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                          {task.assignTo && <span>{task.assignTo}</span>}
                          {task.result?.duration && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDuration(task.result.duration)}
                            </span>
                          )}
                          {task.result?.assessment && (
                            <span className="flex items-center gap-1">
                              {task.result.assessment.passed ? (
                                <CheckCircle2 className="h-3 w-3 text-status-done" />
                              ) : (
                                <XCircle className="h-3 w-3 text-status-failed" />
                              )}
                              {formatScore(task.result.assessment.globalScore)}
                            </span>
                          )}
                          <span>{formatTimeAgo(task.updatedAt)}</span>
                        </div>
                      </div>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
          {/* Action links */}
          {msg.actions && msg.actions.length > 0 && (
            <div className="ml-10 mb-4 flex flex-wrap gap-2">
              {msg.actions.map((action) => (
                <Button
                  key={action.href}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => router.push(action.href)}
                >
                  {action.label}
                  <ArrowRight className="ml-1.5 h-3 w-3" />
                </Button>
              ))}
            </div>
          )}
        </ChatRow>
      );
    },
    [mode, handleExecutePlan, handleRefinePlan, handleUpdatePlanYaml, router, basePath]
  );

  return (
    <div className="flex h-[calc(100vh-140px)] flex-col w-full">
      {messages.length > 0 && (
        <div className="max-w-5xl mx-auto w-full px-4 flex justify-end mb-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearChat}>
            Clear chat
          </Button>
        </div>
      )}

      {messages.length === 0 ? (
        /* Empty state — centered content */
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-4">
          <h2 className="text-lg font-semibold">Polpo Chat</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            Three modes, like the TUI. Press the mode button or{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">Alt+T</kbd>{" "}
            to switch.
          </p>
          <div className="flex gap-3 text-xs">
            {(["chat", "task", "plan"] as InputMode[]).map((m) => {
              const cfg = MODE_CONFIG[m];
              const Icon = cfg.icon;
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border transition-colors ${
                    mode === m ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50"
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                  <span className={cfg.color}>{cfg.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground max-w-sm mt-1">
            {MODE_CONFIG[mode].shortcut}
          </p>
          {mode === "chat" && (
            <Suggestions>
              {CHAT_SUGGESTIONS.map((s) => (
                <Suggestion key={s} suggestion={s} onClick={() => handleSuggestion(s)} />
              ))}
            </Suggestions>
          )}
        </div>
      ) : (
        /* Virtualized message list — scrollbar at page edge */
        <Virtuoso
          ref={virtuosoRef}
          data={items}
          itemContent={renderItem}
          followOutput="smooth"
          initialTopMostItemIndex={items.length - 1}
          className="flex-1"
        />
      )}

      <div className="max-w-5xl mx-auto w-full px-4 pt-2 pb-1">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === "t" || e.key === "T")) {
                  e.preventDefault();
                  cycleMode();
                }
              }}
              placeholder={MODE_CONFIG[mode].placeholder}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cycleMode}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors hover:bg-accent"
              >
                <ModeIcon className={`h-3.5 w-3.5 ${MODE_CONFIG[mode].color}`} />
                <span className={MODE_CONFIG[mode].color}>{MODE_CONFIG[mode].label}</span>
                <Keyboard className="h-3 w-3 text-muted-foreground ml-1" />
                <span className="text-[10px] text-muted-foreground">Alt+T</span>
              </button>
            </div>
            <PromptInputSubmit status={isLoading ? "submitted" : undefined} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
