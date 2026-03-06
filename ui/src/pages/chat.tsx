import { useState, useCallback, useRef, useEffect } from "react";
import {
  Copy,
  Check,
  Trash2,
  Zap,
  ListChecks,
  Target,
  MessageSquare,
  Plus,
  History,
  ChevronsLeft,
  Send,
  MessageCircleQuestion,
  PenLine,
  ChevronLeft,
  ChevronRight,
  ArrowDown,
  Mic,
  MicOff,
  X,
  Play,
  Save,
  RefreshCw,
  Ban,
  User,
  GitBranch,
  ChevronDown,
  ChevronUp,
  FileCheck,
  FileCode,
  Terminal,
  Eye,
  KeyRound,
  ShieldCheck,
  AlertTriangle,
  SkipForward,
  PauseCircle,
  Timer,
  BarChart3,
  AtSign,
  Compass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
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
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { useChatState, useChatActions, useChatInputDisabled } from "@/hooks/chat-context";
import type { AskUserQuestion, AskUserAnswer, MessageSegment, ToolCallInfo, MissionPreviewData, MissionPreviewAction, VaultPreviewData, VaultPreviewAction } from "@/hooks/use-polpo";
import { FilePreviewDialog, useFilePreview, mimeFromPath } from "@/components/shared/file-preview";
import { ToolCallList, ToolInvocation, ToolCallGroup } from "@/components/ai-elements/tool";
import { MentionPopover, MentionText, type MentionPopoverHandle, type MentionFile } from "@/components/ai-elements/mention-popover";
import { useAgents, useTasks, useMissions, useSkills, useTemplates } from "@lumea-labs/polpo-react";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

/** Like formatDistanceToNow but returns "just now" for < 30 s */
function chatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 30_000) return "just now";
  return formatDistanceToNow(date, { addSuffix: true });
}

// ── Speech-to-text hook (Web Speech API) ──

// Minimal type shim — Web Speech API types aren't in TS's default DOM lib
type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; [j: number]: { transcript: string } } } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

interface SpeechRecognitionHook {
  isListening: boolean;
  isSupported: boolean;
  transcript: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | undefined {
  if (typeof window === "undefined") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? undefined;
}

function useSpeechRecognition(opts?: { lang?: string; onResult?: (text: string) => void }): SpeechRecognitionHook {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onResultRef = useRef(opts?.onResult);
  onResultRef.current = opts?.onResult;

  const Ctor = getSpeechRecognitionCtor();
  const isSupported = !!Ctor;

  const start = useCallback(() => {
    const C = getSpeechRecognitionCtor();
    if (!C || recognitionRef.current) return;

    const recognition = new C();
    recognition.lang = opts?.lang ?? "it-IT";
    recognition.continuous = true;
    recognition.interimResults = true;

    let finalTranscript = "";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript + " ";
        } else {
          interim += result[0].transcript;
        }
      }
      const combined = (finalTranscript + interim).trim();
      setTranscript(combined);
      onResultRef.current?.(combined);
    };

    recognition.onerror = (event) => {
      if (event.error !== "aborted") {
        console.warn("[STT] error:", event.error);
      }
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setTranscript("");
  }, [opts?.lang]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (isListening) stop();
    else start();
  }, [isListening, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  return { isListening, isSupported, transcript, start, stop, toggle };
}

// ── Mic button component ──

function MicButton({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}) {
  const { isListening, isSupported, toggle } = useSpeechRecognition({
    lang: "it-IT",
    onResult: onTranscript,
  });

  if (!isSupported) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8 rounded-full transition-all",
            isListening
              ? "bg-red-500/15 text-red-400 hover:bg-red-500/25 ring-2 ring-red-500/30 animate-pulse"
              : "text-muted-foreground hover:text-foreground hover:bg-accent",
          )}
          onClick={toggle}
          disabled={disabled}
        >
          {isListening ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {isListening ? "Stop recording" : "Voice input"}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Attachment preview strip (lives inside PromptInput) ──

function AttachmentPreview() {
  const { files, remove } = usePromptInputAttachments();
  if (files.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-2 pb-1.5 overflow-x-auto scrollbar-none">
      {files.map((file) => (
        <div key={file.id} className="group/thumb relative shrink-0">
          {file.mediaType?.startsWith("image/") ? (
            <img
              src={file.url}
              alt={file.filename}
              className="h-14 w-14 rounded-lg object-cover border border-border/50"
            />
          ) : (
            <div className="h-14 w-14 rounded-lg border border-border/50 bg-muted flex items-center justify-center">
              <span className="text-[9px] text-muted-foreground font-mono truncate px-1">
                {file.filename?.split(".").pop()?.toUpperCase() ?? "FILE"}
              </span>
            </div>
          )}
          <button
            type="button"
            className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
            onClick={() => remove(file.id)}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Attach button (lives inside PromptInput) ──

function AttachButton({ disabled }: { disabled?: boolean }) {
  const { openFileDialog } = usePromptInputAttachments();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent"
          onClick={openFileDialog}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Attach image
      </TooltipContent>
    </Tooltip>
  );
}

// ── Mention @ button (lives inside PromptInput) ──

function MentionButton({ disabled, onOpen }: { disabled?: boolean; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent"
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent stealing focus from textarea
            onOpen();
          }}
          disabled={disabled}
        >
          <AtSign className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Mention agent, task, or mission
      </TooltipContent>
    </Tooltip>
  );
}

// ── Mission data shape (mirrors server-side MissionData from mission-generator.ts) ──

interface MissionExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
}

interface MissionTaskShape {
  title: string;
  description: string;
  assignTo: string;
  dependsOn?: string[];
  expectations?: MissionExpectation[];
  maxRetries?: number;
}

interface MissionCheckpointShape {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  message?: string;
  notifyChannels?: string[];
}

interface MissionQualityGateShape {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

interface MissionDelayShape {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  duration: string;
  message?: string;
  notifyChannels?: string[];
}

interface MissionDataShape {
  name?: string;
  tasks: MissionTaskShape[];
  team?: Array<{ name: string; role?: string }>;
  checkpoints?: MissionCheckpointShape[];
  delays?: MissionDelayShape[];
  qualityGates?: MissionQualityGateShape[];
}

// ── Mission Preview Card ──

function MissionPreviewCard({
  preview,
  onRespond,
  disabled,
}: {
  preview: MissionPreviewData;
  onRespond: (action: MissionPreviewAction, feedback?: string) => Promise<{ missionId?: string; error?: string }>;
  disabled?: boolean;
}) {
  const [refineMode, setRefineMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set());

  const mission = preview.data as MissionDataShape;
  const tasks = mission?.tasks ?? [];

  const handleAction = async (action: MissionPreviewAction, fb?: string) => {
    setSubmitting(true);
    try {
      const result = await onRespond(action, fb);
      if (result.error) {
        toast.error(`Mission ${action} failed`, { description: result.error });
      } else if (action === "execute") {
        toast.success("Mission execution started", { description: "Track progress on the missions page." });
      } else if (action === "draft") {
        toast.success("Mission saved as draft", { description: "Review it on the missions page." });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const toggleTask = (idx: number) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const expectationIcon = (type: string) => {
    switch (type) {
      case "test": return <Terminal className="h-3 w-3" />;
      case "file_exists": return <FileCheck className="h-3 w-3" />;
      case "script": return <FileCode className="h-3 w-3" />;
      case "llm_review": return <Eye className="h-3 w-3" />;
      default: return null;
    }
  };

  const expectationLabel = (type: string) => {
    switch (type) {
      case "test": return "Test";
      case "file_exists": return "Files";
      case "script": return "Script";
      case "llm_review": return "Review";
      default: return type;
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.03] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10 bg-primary/[0.02]">
        <Target className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{preview.name || mission?.name || "Mission"}</p>
          <p className="text-[11px] text-muted-foreground">
            {tasks.length} task{tasks.length !== 1 ? "s" : ""}
            {mission?.team && mission.team.length > 0 && (
              <> &middot; {mission.team.length} agent{mission.team.length !== 1 ? "s" : ""}</>
            )}
          </p>
        </div>
        <Badge variant="outline" className="text-[10px] shrink-0">
          Preview
        </Badge>
      </div>

      {/* Task list — interleaved with checkpoints, delays, quality gates at correct positions */}
      <div className="px-4 py-3 space-y-1 max-h-80 overflow-y-auto">
        {(() => {
          // Build a title→index map for positioning flow-control elements
          const titleIndex = new Map<string, number>();
          tasks.forEach((t, i) => titleIndex.set(t.title, i));

          // Compute insertion position for a flow-control element: after the last of its afterTasks
          const insertionPos = (afterTasks: string[]) => {
            let maxIdx = -1;
            for (const t of afterTasks) {
              const idx = titleIndex.get(t);
              if (idx != null && idx > maxIdx) maxIdx = idx;
            }
            return maxIdx;
          };

          type FlowItem =
            | { kind: "checkpoint"; data: MissionCheckpointShape }
            | { kind: "delay"; data: MissionDelayShape }
            | { kind: "gate"; data: MissionQualityGateShape };

          // Group flow items by their insertion position (task index they follow)
          const flowAfter = new Map<number, FlowItem[]>();
          const flowEnd: FlowItem[] = []; // items that don't match any task go to the end

          for (const cp of mission?.checkpoints ?? []) {
            const pos = insertionPos(cp.afterTasks);
            if (pos >= 0) {
              const arr = flowAfter.get(pos) ?? [];
              arr.push({ kind: "checkpoint", data: cp });
              flowAfter.set(pos, arr);
            } else {
              flowEnd.push({ kind: "checkpoint", data: cp });
            }
          }
          for (const dl of mission?.delays ?? []) {
            const pos = insertionPos(dl.afterTasks);
            if (pos >= 0) {
              const arr = flowAfter.get(pos) ?? [];
              arr.push({ kind: "delay", data: dl });
              flowAfter.set(pos, arr);
            } else {
              flowEnd.push({ kind: "delay", data: dl });
            }
          }
          for (const qg of mission?.qualityGates ?? []) {
            const pos = insertionPos(qg.afterTasks);
            if (pos >= 0) {
              const arr = flowAfter.get(pos) ?? [];
              arr.push({ kind: "gate", data: qg });
              flowAfter.set(pos, arr);
            } else {
              flowEnd.push({ kind: "gate", data: qg });
            }
          }

          // Render a flow-control item
          const renderFlowItem = (item: FlowItem, key: string) => {
            if (item.kind === "checkpoint") {
              const cp = item.data;
              return (
                <div key={key} className="flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.03] px-3 py-2 ml-6">
                  <PauseCircle className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{cp.name}</p>
                      <span className="text-[9px] font-medium uppercase tracking-wider text-amber-500">Checkpoint</span>
                    </div>
                    {cp.message && <p className="text-[11px] text-muted-foreground mt-0.5">{cp.message}</p>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                      <span className="text-[10px] text-muted-foreground">
                        Blocks: <span className="font-medium text-foreground/70">{cp.blocksTasks.join(", ")}</span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            }
            if (item.kind === "delay") {
              const dl = item.data;
              return (
                <div key={key} className="flex items-start gap-2 rounded-lg border border-blue-500/15 bg-blue-500/[0.03] px-3 py-2 ml-6">
                  <Timer className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{dl.name}</p>
                      <span className="text-[9px] font-medium uppercase tracking-wider text-blue-500">Delay</span>
                    </div>
                    {dl.message && <p className="text-[11px] text-muted-foreground mt-0.5">{dl.message}</p>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                      <span className="text-[10px] text-muted-foreground">
                        Blocks: <span className="font-medium text-foreground/70">{dl.blocksTasks.join(", ")}</span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            }
            // gate
            const qg = item.data as MissionQualityGateShape;
            return (
              <div key={key} className="flex items-start gap-2 rounded-lg border border-violet-500/15 bg-violet-500/[0.03] px-3 py-2 ml-6">
                <BarChart3 className="h-3.5 w-3.5 text-violet-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{qg.name}</p>
                    <span className="text-[9px] font-medium uppercase tracking-wider text-violet-500">Quality Gate</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                    <span className="text-[10px] text-muted-foreground">
                      Blocks: <span className="font-medium text-foreground/70">{qg.blocksTasks.join(", ")}</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {qg.minScore != null && (
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <BarChart3 className="h-2.5 w-2.5" />
                        Min score: {qg.minScore}/5
                      </Badge>
                    )}
                    {qg.requireAllPassed && (
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <ShieldCheck className="h-2.5 w-2.5" />
                        All must pass
                      </Badge>
                    )}
                    {qg.condition && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="secondary" className="text-[10px] gap-1 cursor-default">
                            <FileCode className="h-2.5 w-2.5" />
                            Custom condition
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs max-w-xs font-mono">
                          {qg.condition}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            );
          };

          // Build interleaved output
          const elements: React.ReactNode[] = [];

          tasks.forEach((task, idx) => {
            const isExpanded = expandedTasks.has(idx);
            elements.push(
              <div key={`task-${idx}`} className="rounded-lg transition-colors hover:bg-primary/[0.03]">
                <button
                  type="button"
                  className="flex items-start gap-2 py-2 px-1.5 w-full text-left"
                  onClick={() => toggleTask(idx)}
                >
                  <span className="text-[11px] font-mono text-muted-foreground mt-0.5 w-5 text-right shrink-0">
                    {idx + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm leading-snug">{task.title}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <User className="h-3 w-3" />
                        {task.assignTo}
                      </span>
                      {task.dependsOn && task.dependsOn.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <GitBranch className="h-3 w-3" />
                          {task.dependsOn.join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  {isExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
                  )}
                </button>
                {isExpanded && (
                  <div className="pl-9 pr-2 pb-2.5 space-y-2">
                    {task.description && (
                      <div className="text-xs text-muted-foreground leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_code]:text-[11px] [&_pre]:text-[11px]">
                        <MessageResponse>{task.description}</MessageResponse>
                      </div>
                    )}
                    {task.expectations && task.expectations.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {task.expectations.map((exp, ei) => (
                          <Tooltip key={ei}>
                            <TooltipTrigger asChild>
                              <Badge variant="secondary" className="text-[10px] gap-1 cursor-default">
                                {expectationIcon(exp.type)}
                                {expectationLabel(exp.type)}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs max-w-xs">
                              {exp.command && <p className="font-mono">{exp.command}</p>}
                              {exp.paths && exp.paths.length > 0 && (
                                <p className="font-mono">{exp.paths.join(", ")}</p>
                              )}
                              {exp.criteria && <p>{exp.criteria}</p>}
                              {!exp.command && !exp.paths?.length && !exp.criteria && (
                                <p>{exp.type} check</p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    )}
                    {task.maxRetries != null && task.maxRetries > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Max retries: {task.maxRetries}
                      </p>
                    )}
                  </div>
                )}
              </div>,
            );

            // Insert any flow-control items that follow this task
            const items = flowAfter.get(idx);
            if (items) {
              for (let fi = 0; fi < items.length; fi++) {
                elements.push(renderFlowItem(items[fi], `flow-${idx}-${fi}`));
              }
            }
          });

          // Append any flow items that didn't match a task position
          for (let fi = 0; fi < flowEnd.length; fi++) {
            elements.push(renderFlowItem(flowEnd[fi], `flow-end-${fi}`));
          }

          if (elements.length === 0) {
            elements.push(
              <p key="empty" className="text-xs text-muted-foreground italic">No tasks in this mission.</p>,
            );
          }

          return elements;
        })()}
      </div>

      {/* Refine feedback input */}
      {refineMode && (
        <div className="px-4 pb-3 border-t border-primary/10">
          <p className="text-xs text-muted-foreground mt-2 mb-1.5">What would you like to change?</p>
          <Textarea
            placeholder="e.g., Add a task for writing tests, change the agent assignment..."
            className="text-sm min-h-[60px] bg-background/60"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && feedback.trim()) {
                e.preventDefault();
                handleAction("refine", feedback.trim());
              }
            }}
            disabled={disabled || submitting}
          />
          <div className="flex justify-end gap-2 mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setRefineMode(false); setFeedback(""); }}
              disabled={submitting}
            >
              Back
            </Button>
            <Button
              size="sm"
              disabled={!feedback.trim() || disabled || submitting}
              onClick={() => handleAction("refine", feedback.trim())}
              className="gap-1.5"
            >
              {submitting ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send feedback
            </Button>
          </div>
        </div>
      )}

      {/* Action buttons — Cancel left, actions right */}
      {!refineMode && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-primary/10 bg-primary/[0.02]">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || submitting}
            onClick={() => handleAction("cancel")}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            <Ban className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || submitting}
            onClick={() => setRefineMode(true)}
            className="gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refine
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || submitting}
            onClick={() => handleAction("draft")}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            Save Draft
          </Button>
          <Button
            size="sm"
            disabled={disabled || submitting}
            onClick={() => handleAction("execute")}
            className="gap-1.5"
          >
            {submitting ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Execute
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Vault Preview Card ──

function VaultPreviewCard({
  preview,
  onRespond,
  disabled,
}: {
  preview: VaultPreviewData;
  onRespond: (action: VaultPreviewAction, editedCredentials?: Record<string, string>) => Promise<void>;
  disabled?: boolean;
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>(() => ({ ...preview.credentials }));
  const [submitting, setSubmitting] = useState(false);
  const [showValues, setShowValues] = useState<Set<string>>(new Set());

  const vaultTypeLabel: Record<string, string> = {
    smtp: "SMTP",
    imap: "IMAP",
    oauth: "OAuth",
    api_key: "API Key",
    login: "Login",
    custom: "Custom",
  };

  const handleAction = async (action: VaultPreviewAction) => {
    setSubmitting(true);
    try {
      await onRespond(action, action === "confirm" ? credentials : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleShow = (key: string) => {
    setShowValues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Determine which fields are sensitive (password, secret, token, key)
  const isSensitive = (key: string) =>
    /password|secret|token|key|credential/i.test(key);

  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-500/10 bg-amber-500/[0.02]">
          <KeyRound className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">
              {preview.label ?? preview.service}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {vaultTypeLabel[preview.type] ?? preview.type} credential for <span className="font-medium">{preview.agent}</span>
            </p>
          </div>
          <Badge variant="outline" className="text-[10px] shrink-0 border-amber-500/30 text-amber-600">
            <ShieldCheck className="h-3 w-3 mr-1" />
            Vault
          </Badge>
        </div>

        {/* Credential fields — editable */}
        <div className="px-4 py-3 space-y-2">
          {Object.entries(credentials).map(([key, value]) => {
            const sensitive = isSensitive(key);
            const isVisible = showValues.has(key);

            return (
              <div key={key} className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground w-28 shrink-0 text-right">
                  {key}
                </label>
                <div className="relative flex-1">
                  <Input
                    type={sensitive && !isVisible ? "password" : "text"}
                    value={value}
                    onChange={(e) =>
                      setCredentials((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    disabled={disabled || submitting}
                    className="h-8 text-sm bg-background/60 pr-8 font-mono"
                  />
                  {sensitive && (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => toggleShow(key)}
                      tabIndex={-1}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Action buttons — outside the box, consistent with AskUser pattern */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || submitting}
          onClick={() => handleAction("cancel")}
          className="gap-1.5 text-muted-foreground hover:text-destructive"
        >
          <Ban className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled || submitting}
          onClick={() => handleAction("confirm")}
          className="gap-1.5"
        >
          {submitting ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          Save to vault
        </Button>
      </div>
    </div>
  );
}

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

type StepStatus = "answered" | "empty";

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
  const [partialWarning, setPartialWarning] = useState(false);
  const [skipWarning, setSkipWarning] = useState(false);

  const isWizard = questions.length > 1;
  const isSummaryStep = isWizard && step === questions.length;
  const current = !isSummaryStep ? questions[step] : undefined;

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

  const getStatus = (q: AskUserQuestion): StepStatus => {
    const sel = selections[q.id];
    const txt = customTexts[q.id]?.trim();
    return (sel && sel.size > 0) || (txt && txt.length > 0) ? "answered" : "empty";
  };

  const statuses = questions.map(getStatus);
  const answeredCount = statuses.filter(s => s === "answered").length;
  const emptyCount = statuses.filter(s => s === "empty").length;
  const allAnswered = emptyCount === 0;
  const hasAnyAnswer = answeredCount > 0;

  // Auto-navigate to summary when all questions are answered
  const prevAllAnswered = useRef(false);
  useEffect(() => {
    if (isWizard && allAnswered && !prevAllAnswered.current && !isSummaryStep) {
      setStep(questions.length);
    }
    prevAllAnswered.current = allAnswered;
  }, [allAnswered, isWizard, isSummaryStep, questions.length]);

  const handleSubmit = () => {
    if (submitting) return;
    // Warn if there are unanswered questions — double confirm to proceed
    if (emptyCount > 0 && !partialWarning) {
      setPartialWarning(true);
      return;
    }
    if (!hasAnyAnswer) return;
    setSubmitting(true);
    setPartialWarning(false);
    const answers: AskUserAnswer[] = questions.map((q) => ({
      questionId: q.id,
      selected: Array.from(selections[q.id] ?? []),
      customText: customTexts[q.id]?.trim() || undefined,
    }));
    onSubmit(answers);
  };

  const handleSkip = () => {
    if (submitting) return;
    if (!skipWarning) {
      setSkipWarning(true);
      return;
    }
    // Confirmed — submit empty answers
    setSubmitting(true);
    setSkipWarning(false);
    const answers: AskUserAnswer[] = questions.map((q) => ({
      questionId: q.id,
      selected: [],
      customText: undefined,
    }));
    onSubmit(answers);
  };

  // Reset warnings when navigating
  useEffect(() => { if (!isSummaryStep) setPartialWarning(false); }, [isSummaryStep]);
  useEffect(() => { setSkipWarning(false); }, [step]);

  // ── Single question — flat layout ──
  if (!isWizard) {
    return (
      <div className="mt-3 space-y-3">
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
    );
  }

  // ── Wizard layout ──
  return (
    <div className="mt-3">
      {/* Step tabs with names and status indicators */}
      <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
        {questions.map((q, idx) => {
          const status = statuses[idx];
          const isActive = idx === step;
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => setStep(idx)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all whitespace-nowrap shrink-0",
                isActive
                  ? "bg-primary/10 text-primary border border-primary/30"
                  : "text-muted-foreground hover:bg-muted/50 border border-transparent",
              )}
            >
              <span className={cn(
                "h-2 w-2 rounded-full shrink-0",
                status === "answered" ? "bg-emerald-500"
                  : isActive ? "bg-primary" : "bg-border",
              )} />
              {q.header || `Q${idx + 1}`}
            </button>
          );
        })}
        {/* Summary tab */}
        <button
          type="button"
          onClick={() => setStep(questions.length)}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all whitespace-nowrap shrink-0",
            isSummaryStep
              ? "bg-primary/10 text-primary border border-primary/30"
              : "text-muted-foreground hover:bg-muted/50 border border-transparent",
          )}
        >
          <ListChecks className="h-3 w-3" />
          Summary
        </button>
      </div>

      {/* ── Summary step ── */}
      {isSummaryStep ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <ListChecks className="h-4 w-4 text-primary" />
              <p className="text-sm font-semibold">Summary</p>
              <Badge variant="secondary" className="text-[9px] ml-auto">
                {answeredCount}/{questions.length} answered
              </Badge>
            </div>

            <div className="space-y-2">
              {questions.map((q, idx) => {
                const status = statuses[idx];
                const sel = selections[q.id];
                const txt = customTexts[q.id]?.trim();
                const answer = status === "answered"
                  ? [...(sel?.size ? Array.from(sel) : []), ...(txt ? [txt] : [])].join(", ")
                  : undefined;

                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setStep(idx)}
                    className="flex items-start gap-2 w-full text-left rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors"
                  >
                    <span className={cn(
                      "h-2 w-2 rounded-full shrink-0 mt-1.5",
                      status === "answered" ? "bg-emerald-500" : "bg-border",
                    )} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium">{q.question}</p>
                      {status === "answered" && answer && (
                        <p className="text-[11px] text-muted-foreground truncate">{answer}</p>
                      )}
                      {status === "empty" && (
                        <p className="text-[11px] text-muted-foreground/50 italic">Not answered yet</p>
                      )}
                    </div>
                    <ChevronRight className="h-3 w-3 text-muted-foreground mt-1 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Partial warning */}
          {partialWarning && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{emptyCount} question{emptyCount > 1 ? "s" : ""} not answered. Press send again to confirm.</span>
            </div>
          )}
          {skipWarning && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Skip all questions without answering? Press skip again to confirm.</span>
            </div>
          )}

          {/* Submit */}
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(questions.length - 1)}
              className="gap-1 text-muted-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <div className="flex items-center gap-2">
              {!allAnswered && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || submitting}
                  onClick={handleSkip}
                  className="gap-1 text-muted-foreground"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                  {skipWarning ? "Confirm skip" : "Skip all"}
                </Button>
              )}
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
            </div>
          </div>
        </div>
      ) : current ? (
        <>
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
              const nextEmpty = questions.findIndex((q, i) => i > step && getStatus(q) === "empty");
              if (nextEmpty >= 0) setStep(nextEmpty);
              else setStep(questions.length);
            }}
          />

          {/* Skip warning */}
          {skipWarning && (
            <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Skip all questions without answering? Press skip again to confirm.</span>
            </div>
          )}

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

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || submitting}
                onClick={handleSkip}
                className="gap-1 text-muted-foreground"
              >
                <SkipForward className="h-3.5 w-3.5" />
                {skipWarning ? "Confirm skip" : "Skip all"}
              </Button>
              <Button
                size="sm"
                variant={getStatus(current) === "answered" ? "default" : "outline"}
                onClick={() => {
                  setSkipWarning(false);
                  const nextEmpty = questions.findIndex((q, i) => i > step && getStatus(q) === "empty");
                  if (nextEmpty >= 0) setStep(nextEmpty);
                  else setStep(questions.length);
                }}
                className="gap-1"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Suggestions for empty state ──

const suggestions = [
  {
    icon: Zap,
    title: "What's the current status?",
    description: "Overview of tasks, agents, and missions",
  },
  {
    icon: ListChecks,
    title: "Show me failed tasks",
    description: "Tasks that need attention",
  },
  {
    icon: Target,
    title: "Create a mission to refactor the auth module",
    description: "Generate a multi-task execution mission",
  },
  {
    icon: MessageSquare,
    title: "List all active agents",
    description: "See which agents are configured",
  },
];

// ── Session ID copy button ──

function SessionIdCopy({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [sessionId]);

  return (
    <span
      className="inline-flex items-center gap-1 cursor-pointer group"
      onClick={handleCopy}
      title="Click to copy session ID"
    >
      {copied ? (
        <>
          <Check className="inline h-2.5 w-2.5 text-emerald-500" />
          <span className="text-emerald-500">Copied!</span>
        </>
      ) : (
        <>
          {" Session "}
          <code className="font-mono hover:text-foreground transition-colors">
            {sessionId.slice(0, 8)}
          </code>
          <Copy className="inline h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
        </>
      )}
    </span>
  );
}

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

// ── Message skeleton (reused in initial load and session switching) ──

function ChatMessagesSkeleton() {
  return (
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
  );
}

// ── ChatToolbar — top bar with session toggle, title, message count, clear ──

function ChatToolbar({
  sidebarOpen,
  onToggleSidebar,
  compact,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  compact?: boolean;
}) {
  const { messages, isLoading, sessionId, sessions } = useChatState();
  const { newSession, clear } = useChatActions();

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-background/80 backdrop-blur-md shrink-0">
      {!compact && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleSidebar}
            >
              {sidebarOpen ? <ChevronsLeft className="h-4 w-4" /> : <History className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {sidebarOpen ? "Hide history" : "Session history"}
          </TooltipContent>
        </Tooltip>
      )}
      {/* New session — only when sidebar is closed (or in compact mode) */}
      {(!sidebarOpen || compact) && (
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
      <div className="flex-1 min-w-0 truncate">
        {sessionId ? (
          <span className="text-sm font-medium">
            {sessions.find((s: { id: string; title?: string }) => s.id === sessionId)?.title || "Session"}
          </span>
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
  );
}

// ── ChatEmptyState — shown when no messages ──

function ChatEmptyState() {
  const { send } = useChatActions();

  return (
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
  );
}

// ── ChatMessages — Virtuoso message list, empty state, scroll-to-bottom ──

function ChatMessages() {
  const { messages, isLoading, messagesLoading, pendingQuestions, pendingMission, pendingVault } = useChatState();
  const { answerQuestions, respondToMission, respondToVault } = useChatActions();

  const [atBottom, setAtBottom] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // File preview for inline open_file indicators (re-open on click)
  const { previewState, openPreview, closePreview } = useFilePreview();

  const isEmpty = messages.length === 0 && !messagesLoading;

  return (
    <div className="relative flex-1 min-h-0">
      {messagesLoading ? (
        <div className="flex-1 overflow-hidden">
          <ChatMessagesSkeleton />
        </div>
      ) : isEmpty ? (
        <ChatEmptyState />
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          data={messages}
          followOutput="smooth"
          initialTopMostItemIndex={messages.length - 1}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={80}
          increaseViewportBy={600}
          itemContent={(i, msg) => {
            const isStreaming = isLoading && i === messages.length - 1;

            return msg.role === "user" ? (
              <div className="group w-full py-4 px-4">
                <div className="mx-auto max-w-3xl">
                  <div className="flex justify-end">
                    <div className="max-w-[85%]">
                      <div className="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5">
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">
                          <MentionText text={msg.content} variant="inverted" />
                        </p>
                      </div>
                      <div className="flex items-center justify-end gap-1.5 mt-1">
                        {msg.ts && (
                          <span className="text-[10px] text-muted-foreground">
                            {chatTimeAgo(new Date(msg.ts))}
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
              <div className="group w-full py-4 px-4">
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
                              {chatTimeAgo(new Date(msg.ts))}
                            </span>
                          )}
                        </div>
                        {/* Render segments chronologically, grouping consecutive tools */}
                        {msg.segments && msg.segments.length > 0 ? (
                          (() => {
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
                                  <MessageResponse mode={isStreaming ? "streaming" : "static"}>{g.content}</MessageResponse>
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
                            {msg.toolCalls && msg.toolCalls.length > 0 && (
                              <ToolCallList tools={msg.toolCalls} />
                            )}
                            <MessageContent>
                              <MessageResponse mode={isStreaming ? "streaming" : "static"}>{msg.content}</MessageResponse>
                            </MessageContent>
                          </>
                        )}
                        {!isStreaming && !msg.askUserQuestions?.length && !msg.missionPreview && !msg.vaultPreview && (
                          <MessageActions className="mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyAction text={msg.content} />
                          </MessageActions>
                        )}
                        {msg.askUserQuestions && msg.askUserQuestions.length > 0 && (
                          <AskUserCards
                            questions={msg.askUserQuestions}
                            onSubmit={answerQuestions}
                            disabled={isLoading || !pendingQuestions}
                          />
                        )}
                        {msg.missionPreview && (
                          <MissionPreviewCard
                            preview={msg.missionPreview}
                            onRespond={respondToMission}
                            disabled={isLoading || !pendingMission}
                          />
                        )}
                        {msg.vaultPreview && (
                          <VaultPreviewCard
                            preview={msg.vaultPreview}
                            onRespond={respondToVault}
                            disabled={isLoading || !pendingVault}
                          />
                        )}
                        {msg.openFile && (
                          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onClick={() => { const p = msg.openFile!.path; openPreview({ label: p.split("/").pop() ?? p, path: p, mimeType: mimeFromPath(p) }); }}>
                            <Eye className="h-3.5 w-3.5" />
                            <span>Opened: <code className="font-mono text-foreground">{msg.openFile.path}</code></span>
                            <span className="text-[10px]">(click to reopen)</span>
                          </div>
                        )}
                        {msg.navigateTo && (
                          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                            <Compass className="h-3.5 w-3.5" />
                            <span>Navigated to <code className="font-mono text-foreground">{msg.navigateTo.target}{msg.navigateTo.id ? ` / ${msg.navigateTo.id}` : ""}{msg.navigateTo.name ? ` / ${msg.navigateTo.name}` : ""}</code></span>
                          </div>
                        )}
                      </div>
                    </div>
                  </Message>
                </div>
              </div>
            );
          }}
          components={{
            Footer: () => isLoading ? (
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
            ) : null,
          }}
        />
      )}

      {/* Scroll to bottom button */}
      {!atBottom && !isEmpty && (
        <Button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          size="icon"
          variant="outline"
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: "end", behavior: "smooth" })}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}

      {/* File preview dialog — for inline reopen clicks */}
      <FilePreviewDialog preview={previewState} onClose={closePreview} />
    </div>
  );
}

// ── ChatInput — prompt input area with mentions, attachments, mic ──

function ChatInput() {
  const { isLoading, pendingQuestions, pendingMission, pendingVault, sessionId } = useChatState();
  const { send, stop } = useChatActions();
  const inputDisabled = useChatInputDisabled();

  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<MentionPopoverHandle>(null);

  // Mention autocomplete data
  const { agents } = useAgents();
  const { tasks } = useTasks();
  const { missions } = useMissions();
  const { skills } = useSkills();
  const { templates } = useTemplates();

  // Files for @mention autocomplete — fetch once on mount
  const [mentionFiles, setMentionFiles] = useState<MentionFile[]>([]);
  useEffect(() => {
    const base = config.baseUrl || "";
    fetch(`${base}/api/v1/files/search?limit=200`)
      .then(r => r.json())
      .then(json => { if (json.ok) setMentionFiles(json.data.files); })
      .catch(() => {});
  }, []);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (!message.text.trim() || isLoading) return;
      // Resolve display mentions → wire mentions
      const resolvedText = mentionRef.current?.resolveMessage(message.text.trim()) ?? message.text.trim();
      const images = message.files
        .filter((f) => f.url && f.mediaType?.startsWith("image/"))
        .map((f) => ({ url: f.url!, mimeType: f.mediaType ?? "image/png" }));
      await send(resolvedText, images.length > 0 ? images : undefined);
    },
    [isLoading, send]
  );

  // Set the uncontrolled textarea value from speech recognition
  const setTextareaValue = useCallback((text: string) => {
    const textarea = inputWrapperRef.current?.querySelector<HTMLTextAreaElement>("textarea[name='message']");
    if (!textarea) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    nativeSetter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);

  return (
    <div className="bg-background/80 backdrop-blur-md px-4 pt-2 pb-1.5 shrink-0" ref={inputWrapperRef}>
      <div className="mx-auto max-w-3xl">
        <MentionPopover ref={mentionRef} textareaRef={textareaRef} agents={agents} tasks={tasks} missions={missions} skills={skills} templates={templates} files={mentionFiles}>
          <PromptInput
            onSubmit={handleSubmit}
            accept="image/*"
            multiple
            globalDrop
            maxFiles={5}
            maxFileSize={10 * 1024 * 1024}
            onError={(err) => toast.error(err.message)}
            className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-input"
          >
            <AttachmentPreview />
            <PromptInputTextarea
              placeholder={isLoading ? "Polpo is working..." : pendingQuestions ? "Answer the questions above first..." : pendingMission ? "Review the mission preview above..." : pendingVault ? "Review the vault entry above..." : "Message Polpo..."}
              disabled={inputDisabled}
              onKeyDown={(e) => mentionRef.current?.handleTextareaKeyDown(e)}
              onInput={(e) => {
                if (!textareaRef.current) textareaRef.current = e.currentTarget;
                mentionRef.current?.handleInput();
              }}
            />
            <PromptInputFooter>
              <div className="flex items-center gap-1">
                <AttachButton disabled={inputDisabled} />
                <MentionButton
                  disabled={inputDisabled}
                  onOpen={() => mentionRef.current?.toggle()}
                />
              </div>
              <div className="flex items-center gap-1">
                <MicButton onTranscript={setTextareaValue} disabled={inputDisabled} />
                <PromptInputSubmit
                  status={isLoading ? "streaming" : undefined}
                  disabled={inputDisabled}
                  onStop={stop}
                />
              </div>
            </PromptInputFooter>
          </PromptInput>
        </MentionPopover>
        <p className="text-[10px] text-muted-foreground text-center mt-0.5">
          @ to mention · Enter to send · Shift+Enter for new line.
          {sessionId && (
            <SessionIdCopy sessionId={sessionId} />
          )}
        </p>
      </div>
    </div>
  );
}

// ── ChatLoadingSkeleton — full-page skeleton while sessions are loading ──

function ChatLoadingSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className={cn(
      "flex flex-1 min-h-0",
      !compact && "-mx-4 -mt-4 -mb-2 lg:-mx-6 lg:-mt-6 lg:-mb-3",
    )}>
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
          <ChatMessagesSkeleton />
        </div>

        {/* Disabled prompt input */}
        <div className="bg-background/80 backdrop-blur-md px-4 pt-2 pb-1.5 shrink-0">
          <div className="mx-auto max-w-3xl">
            <PromptInput onSubmit={() => {}} className="[&_[data-slot=input-group]]:rounded-2xl">
              <PromptInputTextarea placeholder="Message Polpo..." disabled />
              <PromptInputFooter>
                <div className="flex items-center gap-1" />
                <PromptInputSubmit disabled />
              </PromptInputFooter>
            </PromptInput>
            <p className="text-[10px] text-muted-foreground text-center mt-0.5">
              @ to mention · Enter to send · Shift+Enter for new line.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ChatPage — full-page composition with session sidebar ──

export function ChatPage({ compact }: { compact?: boolean } = {}) {
  const { sessions, sessionsLoading, sessionId } = useChatState();
  const { loadSession, newSession, deleteSession } = useChatActions();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Filter out empty/orphan sessions
  const visibleSessions = sessions.filter(
    (s: { messageCount: number; title?: string }) => s.messageCount > 1 || (s.messageCount === 1 && s.title),
  );

  if (sessionsLoading) {
    return <ChatLoadingSkeleton compact={compact} />;
  }

  return (
    <div className={cn(
      "flex flex-1 min-h-0",
      !compact && "-mx-4 -mt-4 -mb-2 lg:-mx-6 lg:-mt-6 lg:-mb-3",
    )}>
      {/* Session sidebar — only in full-page mode, hidden on mobile */}
      {!compact && sidebarOpen && (
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
        <ChatToolbar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          compact={compact}
        />
        <ChatMessages />
        <ChatInput />
      </div>
    </div>
  );
}
