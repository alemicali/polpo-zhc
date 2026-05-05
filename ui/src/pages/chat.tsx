import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Copy,
  Check,
  Trash2,
  Zap,
  History,
  ListChecks,
  Target,
  MessageSquare,
  Plus,

  ChevronsLeft,
  Send,
  MessageCircleQuestion,
  PenLine,
  ChevronLeft,
  ChevronRight,
  ArrowDown,
  Mic,
  MicOff,
  Volume2,
  Pause,
  Loader2,
  Maximize2,
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
  Compass,
  Palette,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { useChatState, useChatActions, useChatInputDisabled } from "@/hooks/chat-context";
import { MissionPreviewDialog } from "@/components/mission-preview-dialog";
import type { AskUserQuestion, AskUserAnswer, MessageSegment, ToolCallInfo, MissionPreviewData, MissionPreviewAction, VaultPreviewData, VaultPreviewAction, SetDesignData } from "@/hooks/use-polpo";
import { FilePreviewDialog, useFilePreview, mimeFromPath } from "@/components/shared/file-preview";
import { ToolCallList, ToolInvocation, ToolCallGroup } from "@/components/ai-elements/tool";
import { MentionPopover, MentionText, type MentionPopoverHandle, type MentionFile, type MentionTrigger } from "@/components/ai-elements/mention-popover";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { useAgents, useSkills, usePolpo } from "@polpo-ai/react";
import type { AgentConfig, Mission, PlaybookInfo, SkillWithAssignment, Task } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";
import { useChatFirstSessionsOpen, setChatFirstSessionsOpen } from "@/hooks/use-layout-mode";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useAppearance, type AppearanceSettings, type AppearanceThemeSettings } from "@/lib/appearance";

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
  onListeningChange,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  onListeningChange?: (listening: boolean) => void;
}) {
  const { isListening, isSupported, toggle } = useSpeechRecognition({
    lang: "it-IT",
    onResult: onTranscript,
  });

  useEffect(() => {
    onListeningChange?.(isListening);
  }, [isListening, onListeningChange]);

  if (!isSupported) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8 rounded-[calc(var(--radius)+999px)] transition-all",
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
          className="h-8 w-8 rounded-[calc(var(--radius)+999px)] text-muted-foreground hover:text-foreground hover:bg-accent"
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

function ChatInputHint({ trigger, label }: { trigger: "@" | "/"; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="font-mono text-[10px] font-semibold text-foreground">
        {trigger}
      </span>
      <span className="hidden sm:inline">for {label}</span>
    </span>
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
  const [fullViewOpen, setFullViewOpen] = useState(false);

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
    <div className="mobile-no-x mt-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.03]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-primary/10 bg-primary/[0.02] px-3 py-2 sm:px-4 sm:py-3">
        <Target className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{preview.name || mission?.name || "Mission"}</p>
          <p className="text-[11px] text-muted-foreground">
            {tasks.length} task{tasks.length !== 1 ? "s" : ""}
            {mission?.team && mission.team.length > 0 && (
              <> &middot; {mission.team.length} agent{mission.team.length !== 1 ? "s" : ""}</>
            )}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
              onClick={() => setFullViewOpen(true)}
              aria-label="Open full mission view"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">Open full view</TooltipContent>
        </Tooltip>
        <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex">
          Preview
        </Badge>
      </div>

      <MissionPreviewDialog
        preview={preview}
        open={fullViewOpen}
        onOpenChange={setFullViewOpen}
      />

      {/* Task list — interleaved with checkpoints, delays, quality gates at correct positions */}
      <div className="max-h-56 space-y-0.5 overflow-y-auto px-3 py-2 sm:max-h-80 sm:space-y-1 sm:px-4 sm:py-3">
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
                <div key={key} className="ml-0 flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.03] px-2.5 py-1.5 sm:ml-6 sm:px-3 sm:py-2">
                  <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <p className="min-w-0 text-sm font-medium leading-snug">{cp.name}</p>
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
                <div key={key} className="ml-0 flex items-start gap-2 rounded-lg border border-blue-500/15 bg-blue-500/[0.03] px-2.5 py-1.5 sm:ml-6 sm:px-3 sm:py-2">
                  <Timer className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <p className="min-w-0 text-sm font-medium leading-snug">{dl.name}</p>
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
              <div key={key} className="ml-0 flex items-start gap-2 rounded-lg border border-violet-500/15 bg-violet-500/[0.03] px-2.5 py-1.5 sm:ml-6 sm:px-3 sm:py-2">
                <BarChart3 className="h-3.5 w-3.5 text-violet-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <p className="min-w-0 text-sm font-medium leading-snug">{qg.name}</p>
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
                  className="flex w-full items-start gap-2 px-1 py-1.5 text-left sm:px-1.5 sm:py-2"
                  onClick={() => toggleTask(idx)}
                >
                  <span className="text-[11px] font-mono text-muted-foreground mt-0.5 w-5 text-right shrink-0">
                    {idx + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm leading-snug">{task.title}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
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
        <div className="border-t border-primary/10 px-3 pb-3 sm:px-4">
          <p className="text-xs text-muted-foreground mt-2 mb-1.5">What would you like to change?</p>
          <Textarea
            placeholder="e.g., Add a task for writing tests, change the agent assignment..."
            className="min-h-[60px] bg-background/60 text-base sm:text-sm"
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
        <div className="grid grid-cols-2 gap-2 border-t border-primary/10 bg-primary/[0.02] px-3 py-2.5 sm:flex sm:items-center sm:px-4 sm:py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || submitting}
            onClick={() => handleAction("cancel")}
            className="w-full gap-1.5 text-muted-foreground hover:text-destructive sm:w-auto"
          >
            <Ban className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <div className="hidden flex-1 sm:block" />
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || submitting}
            onClick={() => setRefineMode(true)}
            className="w-full gap-1.5 sm:w-auto"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refine
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || submitting}
            onClick={() => handleAction("draft")}
            className="w-full gap-1.5 sm:w-auto"
          >
            <Save className="h-3.5 w-3.5" />
            <span className="sm:hidden">Draft</span>
            <span className="hidden sm:inline">Save Draft</span>
          </Button>
          <Button
            size="sm"
            disabled={disabled || submitting}
            onClick={() => handleAction("execute")}
            className="w-full gap-1.5 sm:w-auto"
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

// ── Design Preview Card ──

type DesignMode = "light" | "dark";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function themePatchFromPreview(preview: SetDesignData, mode: DesignMode) {
  const nested = preview[mode];
  if (nested && isRecord(nested)) return nested;

  const patch: Record<string, unknown> = {};
  for (const key of ["primary", "secondary", "text", "radius", "fontFamily"] as const) {
    if (preview[key] !== undefined) patch[key] = preview[key];
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function applyThemePatch(
  base: AppearanceThemeSettings,
  patch: Record<string, unknown> | null,
  label: string,
): { theme: AppearanceThemeSettings; changed: string[]; error?: string } {
  const next = { ...base };
  const changed: string[] = [];
  if (!patch) return { theme: next, changed };

  for (const key of ["primary", "secondary", "text"] as const) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== "string" || !isHexColor(patch[key])) {
      return { theme: next, changed, error: `${label} ${key} must be a 6-digit hex color` };
    }
    next[key] = patch[key];
    changed.push(`${label} ${key} ${patch[key]}`);
  }

  if (patch.radius !== undefined) {
    if (typeof patch.radius !== "number" || !Number.isFinite(patch.radius)) {
      return { theme: next, changed, error: `${label} radius must be a number` };
    }
    next.radius = Math.min(24, Math.max(0, patch.radius));
    changed.push(`${label} radius ${next.radius}px`);
  }

  if (patch.fontFamily !== undefined) {
    if (typeof patch.fontFamily !== "string" || !patch.fontFamily.trim()) {
      return { theme: next, changed, error: `${label} fontFamily cannot be empty` };
    }
    next.fontFamily = patch.fontFamily.trim();
    changed.push(`${label} font`);
  }

  return { theme: next, changed };
}

function buildAppearancePreview(preview: SetDesignData, current: AppearanceSettings) {
  if (preview.enabled === false) {
    return {
      next: { ...current, enabled: false },
      changed: ["overrides off"],
    };
  }

  const light = applyThemePatch(current.light, themePatchFromPreview(preview, "light"), "light");
  if (light.error) return { error: light.error };
  const dark = applyThemePatch(current.dark, themePatchFromPreview(preview, "dark"), "dark");
  if (dark.error) return { error: dark.error };

  const changed = ["overrides on", ...light.changed, ...dark.changed];
  return {
    next: {
      ...current,
      enabled: true,
      light: light.theme,
      dark: dark.theme,
    },
    changed,
  };
}

function hasAppearancePreview(
  value: ReturnType<typeof buildAppearancePreview>,
): value is { next: AppearanceSettings; changed: string[] } {
  return "next" in value;
}

function ThemeSwatch({ label, theme }: { label: string; theme: AppearanceThemeSettings }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">{label}</p>
        <span className="text-[10px] text-muted-foreground">{theme.radius}px radius</span>
      </div>
      <div className="mb-2 flex h-8 overflow-hidden rounded-md border border-border/30">
        <span className="flex-1" style={{ background: theme.primary }} />
        <span className="flex-1" style={{ background: theme.secondary }} />
        <span className="flex-1" style={{ background: theme.text }} />
      </div>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
        <span className="text-muted-foreground">Primary</span>
        <code className="truncate">{theme.primary}</code>
        <span className="text-muted-foreground">Secondary</span>
        <code className="truncate">{theme.secondary}</code>
        <span className="text-muted-foreground">Text</span>
        <code className="truncate">{theme.text}</code>
        <span className="text-muted-foreground">Font</span>
        <code className="truncate">{theme.fontFamily}</code>
      </div>
    </div>
  );
}

function DesignPreviewCard({
  preview,
  onRespond,
  disabled,
}: {
  preview: SetDesignData;
  onRespond: (result?: { applied: boolean; description: string }) => void;
  disabled?: boolean;
}) {
  const { appearance, setAppearance } = useAppearance();
  const [submitting, setSubmitting] = useState(false);
  const computed = useMemo(() => buildAppearancePreview(preview, appearance), [appearance, preview]);
  const canApply = hasAppearancePreview(computed);
  const nextAppearance = canApply ? computed.next : appearance;

  const apply = () => {
    if (!hasAppearancePreview(computed)) {
      toast.error("Design preview is invalid", { description: computed.error });
      return;
    }
    setSubmitting(true);
    setAppearance(computed.next);
    onRespond({ applied: true, description: computed.changed.join(", ") });
    toast.success("Design updated");
    setSubmitting(false);
  };

  const cancel = () => {
    onRespond({ applied: false, description: "user declined preview" });
  };

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.03]">
      <div className="flex items-center gap-2 border-b border-primary/10 bg-primary/[0.02] px-4 py-3">
        <Palette className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Design preview</p>
          <p className="text-[11px] text-muted-foreground">
            {preview.enabled === false ? "Appearance overrides will be disabled" : "Review the proposed light and dark theme before applying"}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">Preview</Badge>
      </div>

      <div className="space-y-3 px-4 py-3">
        {preview.enabled === false ? (
          <div className="rounded-lg border border-border/40 bg-background/70 p-3 text-xs text-muted-foreground">
            The selected palette and default theme variables will be restored.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <ThemeSwatch label="Light" theme={nextAppearance.light} />
            <ThemeSwatch label="Dark" theme={nextAppearance.dark} />
          </div>
        )}
        {!canApply && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{computed.error}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-primary/10 bg-primary/[0.02] px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || submitting}
          onClick={cancel}
          className="gap-1.5 text-muted-foreground hover:text-destructive"
        >
          <Ban className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled || submitting || !canApply}
          onClick={apply}
          className="gap-1.5"
        >
          {submitting ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Apply design
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

// ── Speak button (TTS via /api/v1/audio/speak — edge-tts under the hood) ──

// Singleton: only one message can play at a time. Clicking another stops the previous.
let currentTtsAudio: HTMLAudioElement | null = null;
let currentTtsStop: (() => void) | null = null;

function SpeakAction({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (currentTtsAudio === audioRef.current) currentTtsAudio = null;
    if (currentTtsStop === stop) currentTtsStop = null;
    setState("idle");
  }, []);

  const play = useCallback(async () => {
    if (state === "loading") return;
    if (state === "playing") { stop(); return; }

    // Stop any other speak action that's currently active
    if (currentTtsStop && currentTtsStop !== stop) currentTtsStop();

    setState("loading");
    try {
      const base = config.baseUrl || "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
      const language = (navigator.language || "en").split("-")[0];
      // Giuseppe (it-IT) is multilingual — handles IT + EN + FR + ES well in one voice.
      const voice = "it-IT-GiuseppeMultilingualNeural";
      const res = await fetch(`${base}/api/v1/audio/speak`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, language, voice }),
      });
      if (!res.ok) {
        let msg = `TTS failed (${res.status})`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch { /* ignore */ }
        console.warn("[TTS]", msg);
        setState("idle");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      currentTtsAudio = audio;
      currentTtsStop = stop;
      audio.onended = stop;
      audio.onerror = stop;
      await audio.play();
      setState("playing");
    } catch (err) {
      console.warn("[TTS] play error:", err);
      setState("idle");
    }
  }, [state, text, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) audioRef.current.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const tooltip = state === "playing" ? "Stop" : state === "loading" ? "Generating…" : "Read aloud";

  return (
    <MessageAction tooltip={tooltip} onClick={play}>
      {state === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "playing" ? (
        <Pause className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Volume2 className="h-3.5 w-3.5" />
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

const orchestratorSuggestions = [
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
    icon: MessageSquare,
    title: "Create a new agent",
    description: "Add a specialist agent to the team",
  },
];

const MAX_AGENT_SUGGESTIONS = 4;

type AgentStarterSuggestion = string | {
  title: string;
  prompt?: string;
  description?: string;
};

interface LazyMentionData {
  tasks: Task[];
  missions: Mission[];
  skills: SkillWithAssignment[];
  playbooks: PlaybookInfo[];
  files: MentionFile[];
}

function parseMissionAgents(data: string): string[] {
  try {
    const parsed = JSON.parse(data) as {
      tasks?: Array<{ assignTo?: string }>;
      team?: Array<{ name?: string }>;
    };
    const agents = new Set<string>();

    if (Array.isArray(parsed.tasks)) {
      for (const task of parsed.tasks) {
        if (task.assignTo) agents.add(task.assignTo);
      }
    }

    if (Array.isArray(parsed.team)) {
      for (const agent of parsed.team) {
        if (agent.name) agents.add(agent.name);
      }
    }

    return Array.from(agents);
  } catch {
    return [];
  }
}

function normalizeMentionPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function isFileAllowedForAgent(file: MentionFile, agent?: AgentConfig): boolean {
  const allowedPaths = agent?.allowedPaths;
  if (!allowedPaths || allowedPaths.length === 0) return true;

  const filePath = normalizeMentionPath(file.path);
  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizeMentionPath(allowedPath);
    if (!normalizedAllowed || normalizedAllowed === ".") return true;
    return filePath === normalizedAllowed || filePath.startsWith(`${normalizedAllowed}/`);
  });
}

const missionSuggestions = [
  {
    icon: ShieldCheck,
    title: "Review and harden OAuth login",
    prompt: "Create a mission to review and harden OAuth login flows, including callback handling, error states, and user-facing recovery steps.",
  },
  {
    icon: FileCode,
    title: "Refactor auth module",
    prompt: "Create a mission to refactor the auth module, reduce duplication, improve naming, and add focused tests for the main login paths.",
  },
  {
    icon: Compass,
    title: "Improve onboarding setup",
    prompt: "Create a mission to improve the onboarding setup flow, fixing confusing states, redirects, and deployment-specific edge cases.",
  },
  {
    icon: ListChecks,
    title: "Stabilize tests and CI",
    prompt: "Create a mission to inspect failing tests and CI checks, identify the root causes, and implement the smallest reliable fixes.",
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

// ── Session sidebar (two-level: agent groups → session list) ──

/** Key used for orchestrator (non-agent) sessions in the group map */
const ORCHESTRATOR_KEY = "__orchestrator__";
const SIDEBAR_VIEW_KEY = "polpo-chat-sidebar-view";
const SESSION_SIDEBAR_WIDTH_KEY = "polpo-chat-session-sidebar-width";
const SESSION_SIDEBAR_DEFAULT_WIDTH = 288;
const SESSION_SIDEBAR_MIN_WIDTH = 240;
const SESSION_SIDEBAR_MAX_WIDTH = 420;

type SessionItem = { id: string; title?: string; createdAt: string; updatedAt: string; messageCount: number; agent?: string };
type SidebarView = "drill" | "flat";

const clampSessionSidebarWidth = (value: number) => {
  const viewportCap = typeof window === "undefined"
    ? SESSION_SIDEBAR_MAX_WIDTH
    : Math.max(SESSION_SIDEBAR_MIN_WIDTH, Math.min(SESSION_SIDEBAR_MAX_WIDTH, window.innerWidth - 560));
  return Math.min(Math.max(value, SESSION_SIDEBAR_MIN_WIDTH), viewportCap);
};

const readStoredSessionSidebarWidth = () => {
  if (typeof window === "undefined") return SESSION_SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY));
  return Number.isFinite(parsed) ? clampSessionSidebarWidth(parsed) : SESSION_SIDEBAR_DEFAULT_WIDTH;
};

/** Shared session row — used by both drill-down and flat views */
function SessionRow({
  session,
  isActive,
  isStreaming,
  onSelect,
  onDelete,
}: {
  session: SessionItem;
  isActive: boolean;
  /** True when this session is actively receiving a streaming response */
  isStreaming?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors",
        isActive
          ? "bg-accent/80 text-accent-foreground"
          : "hover:bg-accent/30 text-muted-foreground"
      )}
      onClick={() => onSelect(session.id)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className={cn(
            "text-[13px] font-medium truncate",
            isActive ? "text-accent-foreground" : "text-foreground"
          )}>
            {session.title || "Untitled"}
          </p>
          <div className="flex items-center gap-1.5 shrink-0">
            {isStreaming && (
              <span className="flex items-center gap-1 text-[10px] text-primary font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                </span>
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">
              {formatDistanceToNow(new Date(session.updatedAt), { addSuffix: false })}
            </span>
          </div>
        </div>
        <p className="text-[10px] opacity-50 mt-0.5">
          {isStreaming ? (
            <span className="text-primary/70">Streaming...</span>
          ) : (
            <>{session.messageCount} message{session.messageCount !== 1 ? "s" : ""}</>
          )}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive -mr-1"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(session.id);
        }}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

function SessionSidebar({
  sessions,
  activeSessionId,
  streamingSessionIds,
  onSelect,
  onNew,
  onDelete,
  onBack,
  fullWidth,
  mobileFullWidth,
  mobileOnlyBack,
}: {
  sessions: SessionItem[];
  activeSessionId: string | null;
  /** Session IDs currently receiving a streaming response. */
  streamingSessionIds: string[];
  onSelect: (id: string) => void;
  onNew: (agent?: string) => void;
  onDelete: (id: string) => void;
  /** Callback to close the sidebar (used in compact/overlay mode) */
  onBack?: () => void;
  /** When true, sidebar takes full width instead of fixed w-72 */
  fullWidth?: boolean;
  /** Full width on mobile, resizable fixed width on desktop. */
  mobileFullWidth?: boolean;
  /** Show the close/back control only while the mobile overlay layout applies. */
  mobileOnlyBack?: boolean;
}) {
  const { agents } = useAgents();
  const agentMap = agents ? Object.fromEntries(agents.map((a) => [a.name, a])) : {};
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSessionSidebarWidth);

  useEffect(() => {
    if (!fullWidth) {
      localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    }
  }, [fullWidth, sidebarWidth]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (fullWidth) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSessionSidebarWidth(startWidth + moveEvent.clientX - startX));
    };

    const stopResize = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [fullWidth, sidebarWidth]);

  // ── View toggle (drill-down vs flat/accordion) ──
  const [view, setView] = useState<SidebarView>(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_VIEW_KEY);
      return stored === "flat" ? "flat" : "drill";
    } catch {
      return "drill";
    }
  });
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_VIEW_KEY, view); } catch { /* silent */ }
  }, [view]);

  // ── Drill-down state ──
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const lastAutoDrilledSessionRef = useRef<string | null>(null);

  // Auto-drill into the group that contains the active session
  useEffect(() => {
    if (view !== "drill" || !activeSessionId) return;
    if (lastAutoDrilledSessionRef.current === activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session) {
      setActiveGroup(session.agent ?? ORCHESTRATOR_KEY);
      lastAutoDrilledSessionRef.current = activeSessionId;
    }
  }, [activeSessionId, sessions, view]);

  // ── Flat/accordion state: which groups are expanded ──
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    // Auto-expand the group that contains the active session
    if (activeSessionId) {
      const s = sessions.find((s) => s.id === activeSessionId);
      if (s) return new Set([s.agent ?? ORCHESTRATOR_KEY]);
    }
    return new Set<string>();
  });
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Within-group "show more": which groups have all sessions visible ──
  // Per-group cap so an agent with 30 sessions doesn't flood the sidebar.
  const [showAllGroups, setShowAllGroups] = useState<Set<string>>(new Set());
  const SESSIONS_PER_GROUP_PREVIEW = 4;
  const toggleShowAll = useCallback((key: string) => {
    setShowAllGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Auto-expand group of active session when it changes
  useEffect(() => {
    if (view !== "flat" || !activeSessionId) return;
    const s = sessions.find((s) => s.id === activeSessionId);
    if (s) {
      const key = s.agent ?? ORCHESTRATOR_KEY;
      setExpandedGroups((prev) => prev.has(key) ? prev : new Set(prev).add(key));
    }
  }, [activeSessionId, sessions, view]);

  // ── Build groups: key → sessions[], sorted by most-recent-first ──
  const groups = useMemo((): [string, SessionItem[]][] => {
    const map = new Map<string, SessionItem[]>();
    for (const s of sessions) {
      const key = s.agent ?? ORCHESTRATOR_KEY;
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    // Sort sessions within each group by updatedAt desc
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    // Sort groups by the most recent session in each
    return [...map.entries()].sort((a, b) => {
      const aLatest = new Date(a[1][0].updatedAt).getTime();
      const bLatest = new Date(b[1][0].updatedAt).getTime();
      return bLatest - aLatest;
    });
  }, [sessions]);

  // ── Header ──
  const renderHeader = () => {
    // Drill-down mode with an active group → show back + agent name
    if (view === "drill" && activeGroup) {
      const agent = activeGroup !== ORCHESTRATOR_KEY ? agentMap[activeGroup] : undefined;
      const name = agent ? (agent.identity?.displayName ?? agent.name) : "Polpo";
      return (
        <div className="px-3 py-2.5 border-b border-border/40 flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setActiveGroup(null)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {agent ? (
              <AgentAvatar
                avatar={agent.identity?.avatar}
                name={name}
                size="sm"
                fallbackVariant="circle"
                shape="circle"
              />
            ) : (
              <span className="text-sm leading-none">🐙</span>
            )}
            <span className="text-sm font-medium truncate">{name}</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => onNew(activeGroup !== ORCHESTRATOR_KEY ? activeGroup! : undefined)}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">New session</TooltipContent>
          </Tooltip>
        </div>
      );
    }

    // Top-level header (both views when no drill-down is active).
    // Sidebar toggle now lives on the RIGHT (using Columns2 to evoke
    // "show/hide a column"). The "+ new session" button used to live there;
    // it's been removed because each group already exposes a "+" inline,
    // and orchestrator new-session is reachable via that group's header.
    return (
      <div className="px-3 py-2.5 border-b border-border/40 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex-1">
          Agent Chats
        </span>
        {/* View toggle — text labels, not icons */}
        <div className="flex items-center bg-muted/60 rounded-md p-0.5 gap-0.5">
          <button
            className={cn(
              "h-6 px-2 flex items-center justify-center rounded text-[10.5px] font-medium transition-colors",
              view === "drill"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setView("drill")}
          >
            By agent
          </button>
          <button
            className={cn(
              "h-6 px-2 flex items-center justify-center rounded text-[10.5px] font-medium transition-colors",
              view === "flat"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setView("flat")}
          >
            All
          </button>
        </div>
        {/* Sidebar close button — pure close (the open action lives elsewhere) */}
        {onBack && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-7 w-7 shrink-0", mobileOnlyBack && "lg:hidden")}
                onClick={onBack}
                aria-label="Close chat sidebar"
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Close</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  };

  // ── Drill-down view: session list for a single group ──
  const renderSessionList = (groupSessions: SessionItem[]) => (
    <div className="p-1.5 space-y-0.5">
      <div className="px-3 pt-1.5 pb-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Sessions
        </span>
      </div>
      {groupSessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          isActive={activeSessionId === s.id}
          isStreaming={streamingSessionIds.includes(s.id)}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </div>
  );

  // ── Drill-down view: grouped overview ──
  const renderGroups = () => (
    <div className="p-1.5 space-y-0.5">
      {groups.map(([key, groupSessions]: [string, SessionItem[]]) => {
        const agent = key !== ORCHESTRATOR_KEY ? agentMap[key] : undefined;
        const displayName = agent ? (agent.identity?.displayName ?? agent.name) : "Polpo";
        const latestSession = groupSessions[0];
        const count = groupSessions.length;
        const hasActive = groupSessions.some((s: SessionItem) => s.id === activeSessionId);

        return (
          <div
            key={key}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-3 cursor-pointer transition-colors",
              hasActive
                ? "bg-accent/60 text-accent-foreground"
                : "hover:bg-accent/30 text-muted-foreground"
            )}
            onClick={() => setActiveGroup(key)}
          >
            <div className="shrink-0">
              {agent ? (
                <AgentAvatar
                  avatar={agent.identity?.avatar}
                  name={displayName}
                  size="md"
                  fallbackVariant="circle"
                  shape="circle"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-base">
                  🐙
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <p className={cn(
                  "text-[13px] font-semibold truncate",
                  hasActive ? "text-accent-foreground" : "text-foreground"
                )}>
                  {displayName}
                </p>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {formatDistanceToNow(new Date(latestSession.updatedAt), { addSuffix: false })}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[11px] opacity-60">
                  {count} chat{count !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
          </div>
        );
      })}
    </div>
  );

  // ── Flat/accordion view: all groups inline with collapsible sections ──
  const renderFlat = () => (
    <div className="p-1.5 space-y-1">
      {groups.map(([key, groupSessions]: [string, SessionItem[]]) => {
        const agent = key !== ORCHESTRATOR_KEY ? agentMap[key] : undefined;
        const displayName = agent ? (agent.identity?.displayName ?? agent.name) : "Polpo";
        const count = groupSessions.length;
        const isExpanded = expandedGroups.has(key);
        const hasActive = groupSessions.some((s: SessionItem) => s.id === activeSessionId);

        return (
          <div key={key}>
            {/* Group header — click to expand/collapse */}
            <div
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer transition-colors",
                hasActive
                  ? "bg-accent/40"
                  : "hover:bg-accent/20"
              )}
              onClick={() => toggleGroup(key)}
            >
              <div className="shrink-0">
                {agent ? (
                  <AgentAvatar
                    avatar={agent.identity?.avatar}
                    name={displayName}
                    size="sm"
                    fallbackVariant="circle"
                    shape="circle"
                  />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs">
                    🐙
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-bold tracking-tight truncate text-foreground leading-tight">
                    {displayName}
                  </span>
                  <span className="shrink-0 text-[8px] font-bold tracking-[0.12em] uppercase text-muted-foreground/55 border border-border/60 rounded-sm px-1 py-px leading-none">
                    {agent ? "Agent" : "Orchestrator"}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground/60">
                  {count} chat{count !== 1 ? "s" : ""}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onNew(key !== ORCHESTRATOR_KEY ? key : undefined);
                }}
              >
                <Plus className="h-3 w-3" />
              </Button>
              {isExpanded ? (
                <ChevronUp className="h-3 w-3 text-muted-foreground/50 shrink-0" />
              ) : (
                <ChevronDown className="h-3 w-3 text-muted-foreground/50 shrink-0" />
              )}
            </div>
            {/* Collapsible session list — capped to N most-recent unless "show more" clicked.
                groupSessions is already sorted most-recent-first upstream. */}
            {isExpanded && (() => {
              const showAll = showAllGroups.has(key);
              // Always show the active session even if outside the cap, so the
              // visible row never disappears just because the user clicks an
              // older one in another view.
              const activeIdx = groupSessions.findIndex((s) => s.id === activeSessionId);
              const cap = showAll
                ? groupSessions.length
                : Math.max(SESSIONS_PER_GROUP_PREVIEW, activeIdx + 1);
              const visible = groupSessions.slice(0, cap);
              const hidden = groupSessions.length - visible.length;
              return (
                <div className="pl-4 pr-1 pb-1 space-y-0.5 mt-0.5">
                  {visible.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isActive={activeSessionId === s.id}
                      isStreaming={streamingSessionIds.includes(s.id)}
                      onSelect={onSelect}
                      onDelete={onDelete}
                    />
                  ))}
                  {(hidden > 0 || showAll) && (
                    <button
                      type="button"
                      onClick={() => toggleShowAll(key)}
                      className="w-full text-left text-[10.5px] font-medium text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-accent/30 transition-colors"
                    >
                      {showAll
                        ? "Show less"
                        : `Show ${hidden} more`}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );

  // ── Find sessions for the active group (drill-down view) ──
  const activeGroupSessions = activeGroup
    ? (groups.find(([k]: [string, SessionItem[]]) => k === activeGroup)?.[1] ?? [])
    : [];
  const sidebarStyle = fullWidth
    ? undefined
    : ({ "--session-sidebar-width": `${sidebarWidth}px` } as CSSProperties);

  return (
    <div className={cn(
      "relative border-r border-border/30 flex flex-col bg-card/40 h-full",
      fullWidth
        ? "w-full"
        : mobileFullWidth
          ? "w-full lg:w-[var(--session-sidebar-width)] lg:shrink-0"
          : "w-[var(--session-sidebar-width)] shrink-0"
    )}
    style={sidebarStyle}
    >
      {!fullWidth && (
        <button
          type="button"
          aria-label="Resize Agent Chats sidebar"
          onPointerDown={startResize}
          className={cn(
            "absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group",
            mobileFullWidth && "hidden lg:block"
          )}
        >
          <span className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full bg-border transition-all group-hover:w-[3px] group-hover:bg-primary/40" />
        </button>
      )}
      {renderHeader()}
      <div className="flex-1 overflow-y-auto min-h-0">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center text-center py-8 px-3 text-muted-foreground">
            <p className="text-xs font-medium">No sessions yet</p>
            <p className="text-[10px] mt-1">
              Start a new session or use the CLI — sessions are shared
              between both interfaces.
            </p>
          </div>
        ) : view === "flat" ? (
          renderFlat()
        ) : activeGroup ? (
          renderSessionList(activeGroupSessions)
        ) : (
          renderGroups()
        )}
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
  const { messages, isLoading, sessionId, sessions, selectedAgent } = useChatState();
  const { newSession, clear } = useChatActions();
  const { agents } = useAgents();
  // Resolve agent for the current session
  const sessionAgent = selectedAgent ?? sessions.find((s: { id: string; agent?: string }) => s.id === sessionId)?.agent ?? null;
  const agentConfig = sessionAgent && agents ? agents.find((a) => a.name === sessionAgent) : undefined;

  return (
    <div className="flex items-center gap-1.5 px-2 py-2 border-b border-border/40 bg-background/80 backdrop-blur-md shrink-0 sm:gap-2 sm:px-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onToggleSidebar}
          >
            {sidebarOpen ? <ChevronsLeft className="h-4 w-4" /> : <History className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {sidebarOpen ? "Hide threads" : "Threads"}
        </TooltipContent>
      </Tooltip>
      {/* New session — only when sidebar is closed (or in compact mode) */}
      {(!sidebarOpen || compact) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
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
      {/* Left: agent avatar + name */}
      {agentConfig ? (
        <div className="flex min-w-0 max-w-[8rem] items-center gap-1.5 shrink-0 sm:max-w-48">
          <AgentAvatar
            avatar={agentConfig.identity?.avatar}
            name={agentConfig.identity?.displayName ?? agentConfig.name}
            size="xs"
          />
          <span className="truncate text-sm font-medium text-foreground">
            {agentConfig.identity?.displayName ?? agentConfig.name}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-sm leading-none">🐙</span>
          <span className="text-sm font-medium text-foreground">Polpo</span>
        </div>
      )}
      {/* Session title — flex-1 pushes right-side actions to the edge */}
      <div className="flex-1 min-w-0">
        {sessionId ? (
          <span className="text-xs text-muted-foreground truncate block">
            {sessions.find((s: { id: string; title?: string }) => s.id === sessionId)?.title || "Session"}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">New session</span>
        )}
      </div>
      {/* Right: message count + actions */}
      {messages.length > 0 && (
        <>
          <Badge variant="secondary" className="hidden shrink-0 text-[10px] sm:inline-flex">
            {messages.length} messages
          </Badge>
          {!isLoading && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
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
  const { send, setSelectedAgent } = useChatActions();
  const { selectedAgent } = useChatState();
  const { agents } = useAgents();
  const { skills } = useSkills();
  const [showMissionSuggestions, setShowMissionSuggestions] = useState(false);
  const agentConfig = selectedAgent && agents ? agents.find((a) => a.name === selectedAgent) : undefined;
  const name = agentConfig?.identity?.displayName ?? agentConfig?.name ?? "Polpo";
  const agentSuggestions = useMemo(() => {
    if (!agentConfig) return [];

    const configuredSuggestions =
      ((agentConfig as typeof agentConfig & { suggestions?: AgentStarterSuggestion[] }).suggestions ?? []);
    const configured = configuredSuggestions.map((suggestion: AgentStarterSuggestion) => {
      const title = typeof suggestion === "string" ? suggestion : suggestion.title;
      return {
        icon: MessageSquare,
        title,
        description: typeof suggestion === "string"
          ? "Agent starter prompt"
          : suggestion.description ?? "Agent starter prompt",
        prompt: typeof suggestion === "string" ? suggestion : suggestion.prompt ?? suggestion.title,
      };
    });

    const configuredTitles = new Set(configured.map((s: { title: string }) => s.title.toLowerCase()));
    const assignedSkills = (skills ?? [])
      .filter((skill) =>
        skill.assignedTo?.includes(agentConfig.name) ||
        agentConfig.skills?.includes(skill.name)
      )
      .filter((skill) => !configuredTitles.has(skill.name.toLowerCase()))
      .slice(0, Math.max(0, MAX_AGENT_SUGGESTIONS - configured.length))
      .map((skill) => ({
        icon: FileCode,
        title: skill.name,
        description: skill.description || "Use this agent skill",
        prompt: skill.name,
      }));

    return [...configured, ...assignedSkills].slice(0, MAX_AGENT_SUGGESTIONS);
  }, [agentConfig, skills]);

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-8">
      {/* Avatar */}
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 mb-4 text-3xl">
        {agentConfig ? (
          <AgentAvatar avatar={agentConfig.identity?.avatar} name={name} size="xl" />
        ) : (
          <>🐙</>
        )}
      </div>
      <h2 className="mb-2 flex flex-wrap items-center justify-center gap-2 text-2xl font-semibold">
        <span>Chat with</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1 text-2xl font-semibold transition-colors hover:border-primary/35 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <span className="truncate">{name}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuItem
              onClick={() => setSelectedAgent(null)}
              className="gap-2"
            >
              <span className="text-xs leading-none">🐙</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Polpo</p>
                <p className="text-[11px] text-muted-foreground">Orchestrator</p>
              </div>
              {!selectedAgent && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
            </DropdownMenuItem>
            {agents && agents.length > 0 && <DropdownMenuSeparator />}
            {agents?.map((a) => (
              <DropdownMenuItem
                key={a.name}
                onClick={() => setSelectedAgent(a.name)}
                className="gap-2"
              >
                <AgentAvatar
                  avatar={a.identity?.avatar}
                  name={a.identity?.displayName ?? a.name}
                  size="xs"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{a.identity?.displayName ?? a.name}</p>
                  {a.role && <p className="text-[11px] text-muted-foreground truncate">{a.role}</p>}
                </div>
                {selectedAgent === a.name && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </h2>
      <p className="text-sm text-muted-foreground mb-5 max-w-md text-center">
        {agentConfig?.role ?? "Orchestrator"}
      </p>
      <div className="mb-5 w-full max-w-3xl">
        <ChatInput embedded />
      </div>
      {agentConfig ? (
        agentSuggestions.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-w-xl w-full">
            {agentSuggestions.map((s) => (
              <button
                key={s.title}
                type="button"
                onClick={() => send(s.prompt)}
                className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border/40 p-2.5 text-left transition-all hover:bg-accent/30 hover:border-primary/20"
              >
                <s.icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{s.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {s.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )
      ) : showMissionSuggestions ? (
        <div className="w-full max-w-2xl">
          <button
            type="button"
            onClick={() => setShowMissionSuggestions(false)}
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to suggestions
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {missionSuggestions.map((s) => (
              <button
                key={s.title}
                type="button"
                onClick={() => send(s.prompt)}
                className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-card/40 p-3 text-left transition-all hover:bg-accent/35 hover:border-primary/25"
              >
                <s.icon className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Create a multi-task mission</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-w-xl w-full">
          <button
            type="button"
            onClick={() => setShowMissionSuggestions(true)}
            className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 p-3 text-left transition-all hover:bg-primary/10 hover:border-primary/35"
          >
            <Target className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium">Create a mission</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Pick from common mission prompts
              </p>
            </div>
          </button>
          {orchestratorSuggestions.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => send(s.title)}
              className="flex items-start gap-2.5 rounded-lg border border-border/40 p-3 text-left transition-all hover:bg-accent/30 hover:border-primary/20"
            >
              <s.icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium">{s.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {s.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ChatMessages — Virtuoso message list, empty state, scroll-to-bottom ──

function ChatMessages() {
  const { messages, isLoading, messagesLoading, pendingQuestions, pendingMission, pendingVault, pendingSetDesign, selectedAgent, sessions, sessionId } = useChatState();
  const { answerQuestions, respondToMission, respondToVault, consumeSetDesign } = useChatActions();

  // Resolve agent config for agent-direct sessions
  const { agents } = useAgents();
  const agentMap = agents ? Object.fromEntries(agents.map((a) => [a.name, a])) : {};
  // Derive current agent: from selectedAgent (for new sessions) or from the active session's agent field
  const currentAgentName = selectedAgent ?? sessions.find((s) => s.id === sessionId)?.agent ?? null;
  const currentAgent = currentAgentName ? agentMap[currentAgentName] : undefined;
  const assistantName = currentAgent?.identity?.displayName ?? currentAgent?.name ?? "Polpo";
  const assistantAvatar = currentAgent?.identity?.avatar;

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
                        {assistantAvatar ? (
                          <AgentAvatar avatar={assistantAvatar} name={assistantName} size="sm" />
                        ) : currentAgent ? (
                          <AgentAvatar name={assistantName} size="sm" />
                        ) : (
                          <>🐙</>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-xs font-semibold">{assistantName}</p>
                          {msg.ts && (
                            <span className="text-[10px] text-muted-foreground">
                              {chatTimeAgo(new Date(msg.ts))}
                            </span>
                          )}
                        </div>
                        {/* Render segments chronologically, grouping consecutive tools and reasoning chunks */}
                        {msg.segments && msg.segments.length > 0 ? (
                          (() => {
                            const groups: Array<
                              | { type: "text"; content: string }
                              | { type: "thinking"; content: string }
                              | { type: "tools"; tools: ToolCallInfo[] }
                            > = [];
                            for (const seg of msg.segments as MessageSegment[]) {
                              if (seg.type === "text") {
                                groups.push({ type: "text", content: seg.content });
                              } else if (seg.type === "thinking") {
                                const last = groups[groups.length - 1];
                                if (last && last.type === "thinking") {
                                  last.content += seg.content;
                                } else {
                                  groups.push({ type: "thinking", content: seg.content });
                                }
                              } else if (seg.type === "tool") {
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
                              ) : g.type === "thinking" ? (
                                <Reasoning key={`r-${gi}`} isStreaming={isStreaming}>
                                  <ReasoningTrigger />
                                  <ReasoningContent>{g.content}</ReasoningContent>
                                </Reasoning>
                              ) : g.tools.length === 1 ? (
                                <ToolInvocation key={g.tools[0].id} tool={g.tools[0]} />
                              ) : (
                                <ToolCallGroup key={`tg-${gi}`} tools={g.tools} />
                              )
                            );
                          })()
                        ) : (
                          <>
                            {msg.thinkingText && (
                              <Reasoning isStreaming={isStreaming}>
                                <ReasoningTrigger />
                                <ReasoningContent>{msg.thinkingText}</ReasoningContent>
                              </Reasoning>
                            )}
                            {msg.toolCalls && msg.toolCalls.length > 0 && (
                              <ToolCallList tools={msg.toolCalls} />
                            )}
                            <MessageContent>
                              <MessageResponse mode={isStreaming ? "streaming" : "static"}>{msg.content}</MessageResponse>
                            </MessageContent>
                          </>
                        )}
                        {!isStreaming && !msg.askUserQuestions?.length && !msg.missionPreview && !msg.vaultPreview && !msg.setDesign && (
                          <MessageActions className="mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyAction text={msg.content} />
                            {msg.content.trim() && <SpeakAction text={msg.content} />}
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
                        {msg.setDesign && (
                          <DesignPreviewCard
                            preview={msg.setDesign}
                            onRespond={consumeSetDesign}
                            disabled={isLoading || !pendingSetDesign}
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
                    <span className="relative flex h-4 w-4 items-center justify-center">
                      <span className="absolute h-4 w-4 rounded-full border border-primary/20" />
                      <span className="absolute h-4 w-4 animate-spin rounded-full border-2 border-transparent border-r-primary/70 border-t-primary" />
                      <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      Agent is working
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

function ChatInput({ embedded = false }: { embedded?: boolean } = {}) {
  const { isLoading, pendingQuestions, pendingMission, pendingVault, pendingSetDesign, sessionId, selectedAgent, sessions } = useChatState();
  const { send, stop } = useChatActions();
  const inputDisabled = useChatInputDisabled({ includeLoading: false });
  const { client } = usePolpo();

  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<MentionPopoverHandle>(null);
  const [isRecording, setIsRecording] = useState(false);

  // Mention autocomplete data
  const { agents } = useAgents();
  const [mentionData, setMentionData] = useState<LazyMentionData>({
    tasks: [],
    missions: [],
    skills: [],
    playbooks: [],
    files: [],
  });
  const mentionLoadedRef = useRef<Record<MentionTrigger, boolean>>({ "@": false, "/": false });
  const mentionLoadingRef = useRef<Record<MentionTrigger, boolean>>({ "@": false, "/": false });

  const ensureMentionData = useCallback(async (trigger: MentionTrigger) => {
    if (mentionLoadedRef.current[trigger] || mentionLoadingRef.current[trigger]) return;

    mentionLoadingRef.current[trigger] = true;
    try {
      if (trigger === "@") {
        const base = config.baseUrl || "";
        const [tasks, missions, filesJson] = await Promise.all([
          client.getTasks(),
          client.getMissions(),
          fetch(`${base}/api/v1/files/search?limit=200`)
            .then((r) => r.json())
            .catch(() => ({ ok: false })),
        ]);

        setMentionData((prev) => ({
          ...prev,
          tasks,
          missions,
          files: filesJson.ok ? filesJson.data.files : prev.files,
        }));
      } else {
        const [skills, playbooks] = await Promise.all([
          client.getSkills(),
          client.getPlaybooks(),
        ]);

        setMentionData((prev) => ({
          ...prev,
          skills,
          playbooks,
        }));
      }

      mentionLoadedRef.current[trigger] = true;
    } catch (error) {
      toast.error(`Could not load ${trigger === "@" ? "mentions" : "commands"}`);
      console.error(error);
    } finally {
      mentionLoadingRef.current[trigger] = false;
    }
  }, [client]);

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      if (isLoading) {
        throw new Error("Cannot submit while a response is streaming.");
      }
      if (!message.text.trim()) return;
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

  // Resolve selected agent config for display
  const currentAgentName =
    selectedAgent ?? sessions.find((s: { id: string; agent?: string }) => s.id === sessionId)?.agent ?? null;
  const isOrchestratorChat = !currentAgentName || currentAgentName === "orchestrator";
  const selectedAgentConfig = currentAgentName && agents ? agents.find((a) => a.name === currentAgentName) : undefined;
  const recipientName = selectedAgentConfig?.identity?.displayName ?? selectedAgentConfig?.name ?? "Polpo";

  const mentionAgents = useMemo(
    () => (isOrchestratorChat ? agents : []),
    [agents, isOrchestratorChat],
  );
  const mentionTasks = useMemo(
    () => isOrchestratorChat
      ? mentionData.tasks
      : mentionData.tasks.filter((task) => task.assignTo === currentAgentName),
    [currentAgentName, isOrchestratorChat, mentionData.tasks],
  );
  const mentionMissions = useMemo(
    () => isOrchestratorChat
      ? mentionData.missions
      : mentionData.missions.filter((mission) => parseMissionAgents(mission.data).includes(currentAgentName ?? "")),
    [currentAgentName, isOrchestratorChat, mentionData.missions],
  );
  const mentionSkills = useMemo(
    () => isOrchestratorChat
      ? mentionData.skills
      : mentionData.skills.filter((skill) =>
          skill.assignedTo?.includes(currentAgentName ?? "") ||
          selectedAgentConfig?.skills?.includes(skill.name),
        ),
    [currentAgentName, isOrchestratorChat, mentionData.skills, selectedAgentConfig?.skills],
  );
  const mentionPlaybooks = useMemo(
    () => (isOrchestratorChat ? mentionData.playbooks : []),
    [isOrchestratorChat, mentionData.playbooks],
  );
  const mentionFiles = useMemo(
    () => isOrchestratorChat
      ? mentionData.files
      : mentionData.files.filter((file) => isFileAllowedForAgent(file, selectedAgentConfig)),
    [isOrchestratorChat, mentionData.files, selectedAgentConfig],
  );

  return (
    <div
      className={cn(
        "shrink-0",
        embedded
          ? "bg-transparent px-0 pt-0 pb-0"
          : "bg-background/80 backdrop-blur-md px-4 pt-2 pb-1.5",
      )}
      ref={inputWrapperRef}
    >
      <div className="mx-auto max-w-3xl">
        <MentionPopover
          ref={mentionRef}
          textareaRef={textareaRef}
          agents={mentionAgents}
          tasks={mentionTasks}
          missions={mentionMissions}
          skills={mentionSkills}
          templates={mentionPlaybooks}
          files={mentionFiles}
          onTriggerOpen={(trigger) => { void ensureMentionData(trigger); }}
        >
          <PromptInput
            onSubmit={handleSubmit}
            accept="image/*"
            multiple
            globalDrop
            maxFiles={5}
            maxFileSize={10 * 1024 * 1024}
            onError={(err) => toast.error(err.message)}
            className="[&_[data-slot=input-group]]:rounded-[calc(var(--radius)+8px)] [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-input"
          >
            <AttachmentPreview />
            <PromptInputTextarea
              ref={textareaRef}
              placeholder={isLoading ? `Draft next message for ${recipientName}...` : pendingQuestions ? "Answer the questions above first..." : pendingMission ? "Review the mission preview above..." : pendingVault ? "Review the vault entry above..." : pendingSetDesign ? "Review the design preview above..." : `Message ${recipientName}...`}
              disabled={inputDisabled}
              onKeyDown={(e) => {
                mentionRef.current?.handleTextareaKeyDown(e);
                if (
                  !e.defaultPrevented &&
                  isLoading &&
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                }
              }}
              onInput={(e) => {
                if (!textareaRef.current) textareaRef.current = e.currentTarget;
                mentionRef.current?.handleInput();
              }}
            />
            <PromptInputFooter>
              <div className="flex min-w-0 items-center gap-1">
                <AttachButton disabled={inputDisabled} />
                <div className="ml-1 flex min-w-0 items-center gap-2.5">
                  <ChatInputHint trigger="@" label="mentions" />
                  <ChatInputHint trigger="/" label="skills" />
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                {sessionId && (
                  <span className="hidden max-w-32 truncate text-[10px] text-muted-foreground lg:inline-flex">
                    <SessionIdCopy sessionId={sessionId} />
                  </span>
                )}
                <MicButton
                  onTranscript={setTextareaValue}
                  disabled={inputDisabled}
                  onListeningChange={setIsRecording}
                />
                {isRecording ? (
                  <div className="inline-flex h-8 items-center gap-2 rounded-[calc(var(--radius)+999px)] border border-red-500/30 bg-red-500/10 px-3 text-xs font-medium text-red-500">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                    </span>
                    Recording
                  </div>
                ) : (
                  <PromptInputSubmit
                    status={isLoading ? "streaming" : undefined}
                    disabled={isLoading ? false : inputDisabled}
                    onStop={stop}
                  />
                )}
              </div>
            </PromptInputFooter>
          </PromptInput>
        </MentionPopover>
        <p className="hidden text-center text-[10px] text-muted-foreground sm:block">
          Enter to send · Shift+Enter for new line
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
            <PromptInput onSubmit={() => {}} className="[&_[data-slot=input-group]]:rounded-[calc(var(--radius)+8px)]">
              <PromptInputTextarea placeholder="Message Polpo..." disabled />
              <PromptInputFooter>
                <div className="flex items-center gap-1" />
                <PromptInputSubmit disabled />
              </PromptInputFooter>
            </PromptInput>
            <p className="hidden sm:block text-[10px] text-muted-foreground text-center mt-0.5">
              @ to mention · / for skills · Enter to send · Shift+Enter for new line.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ChatPage — full-page composition with session sidebar ──

export function ChatPage({ compact, embedded }: { compact?: boolean; embedded?: boolean } = {}) {
  const { sessions, sessionsLoading, sessionId, streamingSessionIds, messages, messagesLoading } = useChatState();
  const { loadSession, newSession, deleteSession, setSelectedAgent } = useChatActions();

  // In embedded mode, session sidebar is controlled externally
  const externalSessionsOpen = useChatFirstSessionsOpen();
  const [internalSidebarOpen, setInternalSidebarOpen] = useState(false);
  const sidebarOpen = embedded ? externalSessionsOpen : internalSidebarOpen;
  const setSidebarOpen = embedded
    ? setChatFirstSessionsOpen
    : setInternalSidebarOpen;

  // Filter out empty/orphan sessions
  const visibleSessions = sessions.filter(
    (s: { messageCount: number; title?: string }) => s.messageCount > 1 || (s.messageCount === 1 && s.title),
  );
  const isEmptyThread = messages.length === 0 && !messagesLoading;

  const shouldCloseSidebarAfterMobileAction = useCallback(() => {
    if (compact) return true;
    if (embedded || typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 1023px)").matches;
  }, [compact, embedded]);

  // All hooks MUST be above the early return to satisfy Rules of Hooks
  const handleSelectSession = useCallback((id: string) => {
    loadSession(id);
    if (shouldCloseSidebarAfterMobileAction()) setSidebarOpen(false);
  }, [loadSession, setSidebarOpen, shouldCloseSidebarAfterMobileAction]);

  const handleNewSession = useCallback((agent?: string) => {
    newSession();
    setSelectedAgent(agent ?? null);
    if (shouldCloseSidebarAfterMobileAction()) setSidebarOpen(false);
  }, [newSession, setSelectedAgent, setSidebarOpen, shouldCloseSidebarAfterMobileAction]);

  if (sessionsLoading) {
    return <ChatLoadingSkeleton compact={compact} />;
  }

  return (
    <div className={cn(
      "relative flex flex-1 min-h-0",
      !compact && !embedded && "-mx-4 -mt-4 -mb-2 lg:-mx-6 lg:-mt-6 lg:-mb-3",
    )}>
      {/* Compact mode: sidebar replaces the entire chat area */}
      {compact && sidebarOpen ? (
        <SessionSidebar
          sessions={visibleSessions}
          activeSessionId={sessionId}
          streamingSessionIds={streamingSessionIds}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
          onDelete={deleteSession}
          onBack={() => setSidebarOpen(false)}
          fullWidth
        />
      ) : (
        <>
          {/* Session sidebar panel — full-page or embedded mode */}
          {!compact && sidebarOpen && (
            <div className={cn(
              embedded
                ? "flex"
                : "absolute inset-0 z-40 flex bg-background lg:static lg:inset-auto lg:z-auto lg:bg-transparent"
            )}>
              <SessionSidebar
                sessions={visibleSessions}
                activeSessionId={sessionId}
                streamingSessionIds={streamingSessionIds}
                onSelect={handleSelectSession}
                onNew={handleNewSession}
                onDelete={deleteSession}
                onBack={embedded || !compact ? () => setSidebarOpen(false) : undefined}
                mobileFullWidth={!embedded && !compact}
                mobileOnlyBack={!embedded && !compact}
              />
            </div>
          )}

          {/* Main chat area */}
          <div className="flex-1 flex flex-col min-w-0 h-full">
            {!embedded && (
              <ChatToolbar
                sidebarOpen={sidebarOpen}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                compact={compact}
              />
            )}
            <ChatMessages />
            {!isEmptyThread && <ChatInput />}
          </div>
        </>
      )}
    </div>
  );
}
