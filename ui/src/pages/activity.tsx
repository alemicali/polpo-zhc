import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Activity,
  Search,
  Wifi,
  WifiOff,
  ListChecks,
  Bot,
  Shield,
  Target,
  AlertTriangle,
  Info,
  Zap,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  FileText,
  Pause,
  Trash2,
  Loader2,
  RefreshCw,
  Radio,
  Archive,
  Bell,
  UsersRound,
  CalendarClock,
  Box,
} from "lucide-react";
import { useEvents, usePolpo, useLogs } from "@polpo-ai/react";
import type { LogEntry } from "@polpo-ai/react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { JsonBlock } from "@/components/json-block";

// ── Event categories ──

type EventCategory =
  | "task"
  | "agent"
  | "assessment"
  | "mission"
  | "deadlock"
  | "orchestrator"
  | "session"
  | "notification"
  | "approval"
  | "room"
  | "channel"
  | "schedule"
  | "sandbox"
  | "log"
  | "other";

function getCategory(event: string): EventCategory {
  if (event.startsWith("task:")) return "task";
  if (event.startsWith("agent:")) return "agent";
  if (event.startsWith("assessment:")) return "assessment";
  if (event.startsWith("mission:")) return "mission";
  if (event.startsWith("deadlock:")) return "deadlock";
  if (event.startsWith("orchestrator:")) return "orchestrator";
  if (event.startsWith("session:") || event.startsWith("message:") || event.startsWith("chat:") || event.startsWith("context:"))
    return "session";
  if (event.startsWith("notification:")) return "notification";
  if (event.startsWith("approval:") || event.startsWith("escalation:")) return "approval";
  if (event.startsWith("room:")) return "room";
  if (event.startsWith("peer:") || event.startsWith("gateway:")) return "channel";
  if (event.startsWith("schedule:") || event.startsWith("delay:") || event.startsWith("watcher:") || event.startsWith("background-wait:")) return "schedule";
  if (event.startsWith("sandbox:") || event.startsWith("storage:")) return "sandbox";
  if (event === "log") return "log";
  return "other";
}

const categoryConfig: Record<
  EventCategory,
  { icon: React.ElementType; label: string; color: string; bg: string }
> = {
  task: {
    icon: ListChecks,
    label: "Tasks",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
  },
  agent: {
    icon: Bot,
    label: "Agents",
    color: "text-violet-400",
    bg: "bg-violet-500/10",
  },
  assessment: {
    icon: Shield,
    label: "Assessment",
    color: "text-amber-400",
    bg: "bg-amber-500/10",
  },
  mission: {
    icon: Target,
    label: "Missions",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
  },
  deadlock: {
    icon: AlertTriangle,
    label: "Deadlock",
    color: "text-red-400",
    bg: "bg-red-500/10",
  },
  orchestrator: {
    icon: Zap,
    label: "Orchestrator",
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
  },
  session: {
    icon: MessageSquare,
    label: "Sessions",
    color: "text-sky-400",
    bg: "bg-sky-500/10",
  },
  notification: {
    icon: Bell,
    label: "Notifications",
    color: "text-pink-400",
    bg: "bg-pink-500/10",
  },
  approval: {
    icon: Shield,
    label: "Approvals",
    color: "text-orange-400",
    bg: "bg-orange-500/10",
  },
  room: {
    icon: UsersRound,
    label: "Groups",
    color: "text-cyan-400",
    bg: "bg-cyan-500/10",
  },
  channel: {
    icon: MessageSquare,
    label: "Channels",
    color: "text-sky-400",
    bg: "bg-sky-500/10",
  },
  schedule: {
    icon: CalendarClock,
    label: "Schedules",
    color: "text-indigo-400",
    bg: "bg-indigo-500/10",
  },
  sandbox: {
    icon: Box,
    label: "Sandbox",
    color: "text-teal-400",
    bg: "bg-teal-500/10",
  },
  log: {
    icon: Info,
    label: "System",
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
  },
  other: {
    icon: HelpCircle,
    label: "Other",
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
  },
};

// ── Semantic severity ──

type Severity = "success" | "info" | "warning" | "error" | "neutral";

function getSeverity(event: string): Severity {
  if (
    event.includes("created") ||
    event.includes("spawned") ||
    event.includes("saved") ||
    event.includes("complete") ||
    event.includes("completed") ||
    event.includes("resolved") ||
    event.includes("approved")
  )
    return "success";
  if (
    event.includes("failed") ||
    event.includes("maxRetries") ||
    event.includes("unresolvable") ||
    event.includes("rejected")
  )
    return "error";
  if (
    event.includes("retry") ||
    event.includes("fix") ||
    event.includes("deadlock") ||
    event.includes("stale") ||
    event.includes("timeout") ||
    event.includes("warning")
  )
    return "warning";
  if (event.includes("activity") || event.includes("tick")) return "neutral";
  return "info";
}

const severityStyles: Record<Severity, { dot: string; border: string }> = {
  success: { dot: "bg-emerald-500", border: "border-l-emerald-500/40" },
  error: { dot: "bg-red-500", border: "border-l-red-500/40" },
  warning: { dot: "bg-amber-500", border: "border-l-amber-500/40" },
  info: { dot: "bg-blue-500", border: "border-l-blue-500/40" },
  neutral: { dot: "bg-zinc-500", border: "border-l-zinc-500/20" },
};

// ── Event action icon ──

function EventActionIcon({ event }: { event: string }) {
  const action = event.split(":")[1] ?? "";
  switch (action) {
    case "created":
    case "spawned":
    case "saved":
      return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
    case "finished":
    case "complete":
    case "completed":
    case "resolved":
      return <CheckCircle2 className="h-3 w-3 text-blue-400" />;
    case "failed":
    case "maxRetries":
    case "unresolvable":
      return <XCircle className="h-3 w-3 text-red-400" />;
    case "retry":
    case "fix":
      return <RotateCcw className="h-3 w-3 text-amber-400" />;
    case "transition":
    case "updated":
      return <ChevronRight className="h-3 w-3 text-zinc-400" />;
    case "activity":
    case "tick":
      return <Clock className="h-3 w-3 text-zinc-500" />;
    case "started":
      return <Zap className="h-3 w-3 text-blue-400" />;
    case "deleted":
    case "removed":
      return <Trash2 className="h-3 w-3 text-red-400" />;
    case "executed":
    case "resumed":
      return <Zap className="h-3 w-3 text-emerald-400" />;
    case "aborted":
      return <Pause className="h-3 w-3 text-amber-400" />;
    default:
      return <FileText className="h-3 w-3 text-zinc-400" />;
  }
}

// ── Narrative builder ──

function buildNarrative(
  eventName: string,
  data: Record<string, unknown>,
): string {
  const category = getCategory(eventName);
  const action = eventName.split(":")[1] ?? eventName;

  if (eventName === "context:compacted") {
    const k = (n: unknown) => `${Math.round(Number(n ?? 0) / 1000)}k`;
    const who = data?.scope === "task"
      ? `Task run${data?.agentName ? ` (${data.agentName})` : ""}`
      : `Chat${data?.agentName ? ` with ${data.agentName}` : ""}`;
    const how = data?.mode === "prune"
      ? `${data?.prunedToolResults ?? 0} old tool results cleared`
      : data?.mode === "fallback"
        ? `${data?.removedMessages ?? 0} messages summarized (fallback extract)`
        : `${data?.removedMessages ?? 0} messages summarized${data?.model ? ` by ${data.model}` : ""}`;
    const why = data?.reason === "overflow" ? " after a context overflow" : data?.reason === "manual" ? " on request" : "";
    const facts = data?.savedFacts ? `, ${data.savedFacts} facts saved to memory` : "";
    return `${who} compacted${why}: ${k(data?.beforeTokens)} → ${k(data?.afterTokens)} tokens, ${how}${facts}`;
  }

  if (category === "sandbox") {
    const where = data?.scope === "task"
      ? `task ${String(data?.taskId ?? "").slice(0, 8)}${data?.agentName ? ` (${data.agentName})` : ""}`
      : `chat${data?.agentName ? ` with ${data.agentName}` : ""}`;
    const seconds = (ms: unknown) => `${Math.round(Number(ms ?? 0) / 100) / 10}s`;
    switch (eventName) {
      case "sandbox:created": return `Sandbox ${data?.provider} opened for ${where}, network ${data?.network}`;
      case "sandbox:ready": return `Sandbox ${data?.provider} ready in ${seconds(data?.durationMs)}`;
      case "sandbox:failed": return `Sandbox ${data?.provider} could not start for ${where}: ${data?.error}`;
      case "sandbox:destroyed": return `Sandbox ${data?.provider} closed after ${seconds(data?.durationMs)} (${data?.reason})`;
      case "sandbox:override-denied": {
        const show = (v: unknown) => typeof v === "object" && v !== null ? ((v as { mode?: string }).mode ?? JSON.stringify(v)) : String(v);
        return `${data?.level === "mission" ? "Mission" : "Task"} asked for ${data?.field} ${show(data?.requested)} for ${where}; kept ${show(data?.applied)}`;
      }
      case "storage:changed": return `Storage "${data?.name}" ${data?.action}${data?.error ? `: ${data.error}` : ""}`;
    }
  }

  switch (category) {
    case "task": {
      const title =
        (data?.task as { title?: string })?.title ??
        (data?.title as string) ??
        "";
      const agent =
        (data?.agentName as string) ?? (data?.assignTo as string) ?? "";
      const taskId = (data?.taskId as string)?.slice(0, 8) ?? "";

      switch (action) {
        case "created":
          return title
            ? `Task "${title}" created${agent ? ` for ${agent}` : ""}`
            : `Task ${taskId} created`;
        case "transition": {
          const from = data?.from as string;
          const to = data?.to as string;
          return `${title || taskId} moved ${from} → ${to}${agent ? ` (${agent})` : ""}`;
        }
        case "retry":
          return `Retrying ${title || taskId}${agent ? ` with ${agent}` : ""}`;
        case "fix":
          return `Fix attempt on ${title || taskId}`;
        case "maxRetries":
          return `${title || taskId} exhausted all retries`;
        case "question":
          return `Agent asked a question about ${title || taskId}`;
        case "answered":
          return `Question answered for ${title || taskId}`;
        case "timeout":
          return `${title || taskId} timed out`;
        case "recovered":
          return `${title || taskId} recovered`;
        default:
          return title || taskId || action;
      }
    }
    case "agent": {
      const name = (data?.agentName as string) ?? "";
      switch (action) {
        case "spawned":
          return `Agent ${name} spawned${data?.taskId ? ` for task ${(data.taskId as string).slice(0, 8)}` : ""}`;
        case "finished":
          return `Agent ${name} finished${data?.exitCode !== undefined ? ` (exit ${data.exitCode})` : ""}`;
        case "activity":
          return `${name}: ${(data?.summary as string) ?? (data?.lastTool ? `using ${data.lastTool}` : "active")}`;
        case "stale":
          return `Agent ${name} is stale — no activity detected`;
        default:
          return name || action;
      }
    }
    case "assessment": {
      const taskId = (data?.taskId as string)?.slice(0, 8) ?? "";
      switch (action) {
        case "started":
          return `Assessment started for ${taskId}`;
        case "progress":
          return `Assessment progress: ${data?.message ?? taskId}`;
        case "complete": {
          const passed = data?.passed as boolean;
          const score = data?.globalScore as number | undefined;
          return `Assessment ${passed ? "PASSED" : "FAILED"} for ${taskId}${score != null ? ` (score: ${Math.round(score * 100)}%)` : ""}`;
        }
        case "corrected":
          return `Assessment corrected for ${taskId}`;
        default:
          return taskId || action;
      }
    }
    case "mission": {
      const missionName =
        (data?.name as string) ??
        (data?.missionId as string)?.slice(0, 8) ??
        "";
      switch (action) {
        case "saved":
          return `Mission "${missionName}" saved`;
        case "executed":
          return `Mission "${missionName}" started execution`;
        case "completed":
          return `Mission "${missionName}" completed`;
        case "resumed":
          return `Mission "${missionName}" resumed`;
        case "deleted":
          return `Mission "${missionName}" deleted`;
        default:
          return missionName || action;
      }
    }
    case "deadlock": {
      switch (action) {
        case "detected":
          return `Deadlock detected — ${data?.message ?? "circular dependency"}`;
        case "resolving":
          return `Resolving deadlock...`;
        case "resolved":
          return `Deadlock resolved`;
        case "unresolvable":
          return `Deadlock is unresolvable — manual intervention needed`;
        default:
          return action;
      }
    }
    case "orchestrator": {
      switch (action) {
        case "started":
          return "Orchestrator started";
        case "tick":
          return `Tick: ${data?.pending ?? 0} pending, ${data?.running ?? 0} running, ${data?.done ?? 0} done`;
        case "deadlock":
          return "Orchestrator detected a deadlock";
        case "shutdown":
          return "Orchestrator shutting down";
        default:
          return action;
      }
    }
    case "session": {
      const sessionId = (data?.sessionId as string)?.slice(0, 8) ?? "";
      return action === "created"
        ? `Chat session ${sessionId} created`
        : `Message added to session ${sessionId}`;
    }
    case "notification": {
      switch (action) {
        case "sent":
          return `Notification sent via ${data?.channel ?? "unknown"} for ${data?.event ?? "event"}`;
        case "failed":
          return `Notification failed on ${data?.channel ?? "unknown"}: ${data?.error ?? "unknown error"}`;
        default:
          return action;
      }
    }
    case "approval": {
      const reqId = (data?.requestId as string)?.slice(0, 8) ?? "";
      switch (action) {
        case "requested":
          return `Approval requested: ${data?.gateName ?? reqId}`;
        case "resolved":
          return `Approval ${data?.status ?? "resolved"}: ${reqId}`;
        case "rejected":
          return `Approval rejected: ${reqId}${data?.feedback ? ` — ${data.feedback}` : ""}`;
        case "timeout":
          return `Approval timed out: ${reqId} → auto-${data?.action ?? "unknown"}`;
        default:
          return reqId || action;
      }
    }
    default: {
      if (data?.message) return String(data.message).slice(0, 120);
      return eventName;
    }
  }
}

// ── Shared event row (works for both SSE events and log entries) ──

interface EventRowData {
  id: string;
  event: string;
  data: unknown;
  timestamp: string;
}

function EventRow({ event }: { event: EventRowData }) {
  const [expanded, setExpanded] = useState(false);
  const category = getCategory(event.event);
  const catCfg = categoryConfig[category];
  const CatIcon = catCfg.icon;
  const severity = getSeverity(event.event);
  const sevStyle = severityStyles[severity];
  const narrative = buildNarrative(
    event.event,
    (event.data as Record<string, unknown>) ?? {},
  );

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div
        className={cn(
          "border-l-2 transition-colors",
          sevStyle.border,
          expanded && "bg-accent/10",
        )}
      >
        <CollapsibleTrigger asChild>
          <div className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-accent/20 transition-colors">
            {/* Category icon */}
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md mt-0.5 backdrop-blur-sm",
                catCfg.bg,
              )}
            >
              <CatIcon className={cn("h-3.5 w-3.5", catCfg.color)} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <EventActionIcon event={event.event} />
                <span className="text-xs font-medium text-foreground">
                  {narrative}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <Badge
                  variant="outline"
                  className="text-[9px] font-mono px-1.5 py-0"
                >
                  {event.event}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  {formatDistanceToNow(new Date(event.timestamp), {
                    addSuffix: true,
                  })}
                </span>
              </div>
            </div>

            {/* Severity dot + expand */}
            <div className="flex items-center gap-2 shrink-0 mt-1">
              <div className={cn("h-1.5 w-1.5 rounded-full", sevStyle.dot)} />
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 ml-10">
            <JsonBlock
              data={event.data}
              className="text-[10px] leading-relaxed font-mono bg-muted/30 border border-border/20 rounded-md p-3 whitespace-pre-wrap overflow-x-auto"
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── Category stats ──

function CategoryStats({ events }: { events: EventRowData[] }) {
  const counts = useMemo(() => {
    const c: Partial<Record<EventCategory, number>> = {};
    for (const e of events) {
      const cat = getCategory(e.event);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [events]);

  const severityCounts = useMemo(() => {
    const c: Partial<Record<Severity, number>> = {};
    for (const e of events) {
      const s = getSeverity(e.event);
      if (s === "neutral") continue;
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [events]);

  return (
    <div className="flex items-center gap-4">
      {/* Severity indicators */}
      {(["error", "warning", "success", "info"] as const).map((sev) => {
        const count = severityCounts[sev] ?? 0;
        if (count === 0) return null;
        const labels: Record<string, string> = {
          error: "Errors",
          warning: "Warnings",
          success: "Success",
          info: "Info",
        };
        return (
          <Tooltip key={sev}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-help">
                <div
                  className={cn(
                    "h-2 w-2 rounded-full",
                    severityStyles[sev].dot,
                  )}
                />
                <span className="text-[10px] text-muted-foreground">
                  {count}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {labels[sev]}: {count}
            </TooltipContent>
          </Tooltip>
        );
      })}
      <div className="h-3 w-px bg-border" />
      {/* Category counts */}
      {Object.entries(counts)
        .filter(([cat]) => cat !== "orchestrator")
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([cat, count]) => {
          const cfg = categoryConfig[cat as EventCategory];
          const Icon = cfg.icon;
          return (
            <Tooltip key={cat}>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1 cursor-help">
                  <Icon className={cn("h-3 w-3", cfg.color)} />
                  <span className="text-[10px] text-muted-foreground">
                    {count}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {cfg.label}: {count} events
              </TooltipContent>
            </Tooltip>
          );
        })}
    </div>
  );
}

// ── Filtered event list with category tabs ──

/** The categories in the order the filter shows them. */
const CATEGORY_ORDER: EventCategory[] = [
  "task", "agent", "mission", "approval", "assessment", "notification", "session", "room",
  "channel", "schedule", "deadlock", "log", "orchestrator", "other",
];

/** Who an event is about, when it names an agent. */
function agentOf(data: unknown): string | undefined {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const task = (d.task && typeof d.task === "object" ? d.task : {}) as Record<string, unknown>;
  for (const v of [d.agentName, d.agent, d.assignTo, task.assignTo]) if (typeof v === "string" && v) return v;
  return undefined;
}

const ALL = "__all__";

/**
 * The events, filtered: by category, by event type, by agent and by text. The same filters for
 * the live stream and for the history (which adds its own period and session pickers).
 */
function EventStream({ events, toolbar, emptyHint }: { events: EventRowData[]; toolbar?: React.ReactNode; emptyHint?: string }) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<EventCategory | "all">("all");
  const [eventType, setEventType] = useState<string>(ALL);
  const [agent, setAgent] = useState<string>(ALL);
  const [severity, setSeverity] = useState<string>(ALL);

  // The orchestrator's tick fires every few seconds: hidden unless asked for
  const baseEvents = useMemo(
    () =>
      eventType === "orchestrator:tick" || search.toLowerCase().includes("tick")
        ? events
        : events.filter((e) => e.event !== "orchestrator:tick"),
    [events, search, eventType],
  );

  const tabCounts = useMemo(() => {
    const c: Partial<Record<EventCategory | "all", number>> = { all: baseEvents.length };
    for (const e of baseEvents) {
      const cat = getCategory(e.event);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [baseEvents]);

  const inTab = useMemo(
    () => (tab === "all" ? baseEvents : baseEvents.filter((e) => getCategory(e.event) === tab)),
    [baseEvents, tab],
  );

  // the event types and agents present, with how many of each
  const typeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of inTab) m.set(e.event, (m.get(e.event) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [inTab]);
  const agentOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of inTab) {
      const a = agentOf(e.data);
      if (a) m.set(a, (m.get(a) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [inTab]);

  const filtered = useMemo(() => {
    let result = inTab;
    if (eventType !== ALL) result = result.filter((e) => e.event === eventType);
    if (agent !== ALL) result = result.filter((e) => agentOf(e.data) === agent);
    if (severity !== ALL) result = result.filter((e) => getSeverity(e.event) === severity);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.event.toLowerCase().includes(q) ||
          buildNarrative(e.event, (e.data as Record<string, unknown>) ?? {}).toLowerCase().includes(q) ||
          JSON.stringify(e.data).toLowerCase().includes(q),
      );
    }
    return result;
  }, [inTab, eventType, agent, severity, search]);

  const display = useMemo(() => [...filtered].reverse(), [filtered]);
  const filtering = tab !== "all" || eventType !== ALL || agent !== ALL || severity !== ALL || search !== "";
  const reset = () => {
    setTab("all");
    setEventType(ALL);
    setAgent(ALL);
    setSeverity(ALL);
    setSearch("");
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <Select value={eventType} onValueChange={setEventType}>
          <SelectTrigger size="sm" className="h-8 w-[210px] text-xs" aria-label="Event type">
            <SelectValue placeholder="All event types" />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={ALL} className="text-xs">All event types</SelectItem>
            {typeOptions.map(([type, n]) => (
              <SelectItem key={type} value={type} className="text-xs">
                <span className="font-mono">{type}</span>
                <span className="ml-auto pl-3 text-muted-foreground">{n}</span>
              </SelectItem>
            ))}
            {eventType !== ALL && !typeOptions.some(([t]) => t === eventType) && (
              <SelectItem value={eventType} className="text-xs font-mono">{eventType}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger size="sm" className="h-8 w-[170px] text-xs" aria-label="Agent">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={ALL} className="text-xs">All agents</SelectItem>
            {agentOptions.map(([name, n]) => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
                <span className="ml-auto pl-3 text-muted-foreground">{n}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger size="sm" className="h-8 w-[130px] text-xs" aria-label="Severity">
            <SelectValue placeholder="Any outcome" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">Any outcome</SelectItem>
            <SelectItem value="error" className="text-xs">Errors</SelectItem>
            <SelectItem value="warning" className="text-xs">Warnings</SelectItem>
            <SelectItem value="success" className="text-xs">Success</SelectItem>
            <SelectItem value="info" className="text-xs">Info</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative w-56">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search events…"
            className="pl-9 h-8 text-xs bg-input/50 border-border/40"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {filtering && (
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={reset}>
            <XCircle className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
        <Badge variant="secondary" className="ml-auto text-xs">
          {display.length} event{display.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      <CategoryStats events={inTab} />

      {/* Categories + stream */}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as EventCategory | "all");
          setEventType(ALL);
        }}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList className="flex-wrap h-auto shrink-0">
          <TabsTrigger value="all">
            All{" "}
            <Badge variant="secondary" className="ml-1.5 text-[10px]">
              {tabCounts.all ?? 0}
            </Badge>
          </TabsTrigger>
          {CATEGORY_ORDER.map((cat) => {
            const count = tabCounts[cat] ?? 0;
            if (count === 0) return null;
            const cfg = categoryConfig[cat];
            return (
              <TabsTrigger key={cat} value={cat}>
                <cfg.icon className={cn("h-3 w-3 mr-1", cfg.color)} />
                {cfg.label}{" "}
                <Badge variant="secondary" className="ml-1.5 text-[10px]">
                  {count}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value={tab} className="mt-3 flex-1 min-h-0">
          <Card className="h-full flex flex-col overflow-hidden bg-card/80 backdrop-blur-sm border-border/40">
            <ScrollArea className="h-full">
              {display.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Activity className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm font-medium">{filtering ? "No matching events" : "No events yet"}</p>
                  {!filtering && emptyHint && <p className="text-xs mt-1">{emptyHint}</p>}
                </CardContent>
              ) : (
                <div className="divide-y divide-border/30">
                  {display.map((event, i) => (
                    <EventRow key={`${event.id}-${i}`} event={event} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Convert LogEntry to EventRowData ──

function logEntryToEventRow(entry: LogEntry, index: number): EventRowData {
  return {
    id: `log-${index}`,
    event: entry.event,
    data: entry.data,
    timestamp: typeof entry.ts === "number" ? new Date(entry.ts).toISOString() : String(entry.ts),
  };
}

// ── History: the stored events, by period or by server session, with the same filters ──

type Period = "1h" | "24h" | "7d" | "30d";
const PERIODS: Array<[Period, string, number]> = [
  ["1h", "Last hour", 60 * 60_000],
  ["24h", "Last 24 hours", 24 * 60 * 60_000],
  ["7d", "Last 7 days", 7 * 24 * 60 * 60_000],
  ["30d", "Last 30 days", 30 * 24 * 60 * 60_000],
];
/** Sessions read at once for a period: each server start is one. */
const MAX_SESSIONS = 60;

function HistoryView() {
  const { sessions, isLoading: sessionsLoading, error: sessionsError, getLogEntries, refetch } = useLogs();
  const [period, setPeriod] = useState<Period>("24h");
  const [sessionId, setSessionId] = useState<string>(ALL);
  const [rows, setRows] = useState<EventRowData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [tick, setTick] = useState(0);

  const ordered = useMemo(() => [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [sessions]);

  useEffect(() => {
    if (sessionsLoading) return;
    let alive = true;
    const since = Date.now() - PERIODS.find(([p]) => p === period)![2];
    // a session runs from its start to the next one's: it counts when that overlaps the period
    const wanted = sessionId !== ALL
      ? ordered.filter((s) => s.sessionId === sessionId)
      : ordered.filter((s, i) => {
          const end = i === 0 ? Date.now() : Date.parse(ordered[i - 1]!.startedAt);
          return end >= since && s.entries > 0;
        });
    const picked = wanted.slice(0, MAX_SESSIONS);
    setCapped(wanted.length > picked.length);
    setLoading(true);
    setError(null);
    void Promise.all(picked.map((s) => getLogEntries(s.sessionId).then((entries) => ({ s, entries })).catch(() => ({ s, entries: [] as LogEntry[] }))))
      .then((lists) => {
        if (!alive) return;
        const out: EventRowData[] = [];
        for (const { s, entries } of lists) {
          entries.forEach((e, i) => {
            const row = logEntryToEventRow(e, i);
            if (sessionId === ALL && Date.parse(row.timestamp) < since) return;
            out.push({ ...row, id: `${s.sessionId}-${i}` });
          });
        }
        out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        setRows(out);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : "Could not read the history"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [ordered, sessionsLoading, period, sessionId, getLogEntries, tick]);

  const toolbar = (
    <>
      <Select value={sessionId === ALL ? period : "session"} onValueChange={(v) => { if (v !== "session") { setPeriod(v as Period); setSessionId(ALL); } }}>
        <SelectTrigger size="sm" className="h-8 w-[150px] text-xs" aria-label="Period">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIODS.map(([p, label]) => (
            <SelectItem key={p} value={p} className="text-xs">{label}</SelectItem>
          ))}
          {sessionId !== ALL && <SelectItem value="session" className="text-xs">One session</SelectItem>}
        </SelectContent>
      </Select>
      <Select value={sessionId} onValueChange={setSessionId}>
        <SelectTrigger size="sm" className="h-8 w-[230px] text-xs" aria-label="Server session">
          <Archive className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue placeholder="All sessions" />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          <SelectItem value={ALL} className="text-xs">All sessions in the period</SelectItem>
          {ordered.map((s) => (
            <SelectItem key={s.sessionId} value={s.sessionId} className="text-xs">
              {new Date(s.startedAt).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              <span className="ml-auto pl-3 text-muted-foreground">{s.entries} events</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Refresh" onClick={() => { void refetch(); setTick((n) => n + 1); }}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">Refresh</TooltipContent>
      </Tooltip>
    </>
  );

  if (sessionsError || error) {
    return (
      <Card className="flex-1 flex flex-col items-center justify-center bg-card/80 border-border/40">
        <CardContent className="flex flex-col items-center py-16 text-muted-foreground">
          <AlertTriangle className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">Could not read the history</p>
          <p className="text-xs mt-1">{error ?? sessionsError?.message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {capped && (
        <p className="text-[11px] text-muted-foreground">
          Showing the {MAX_SESSIONS} most recent server sessions of the period: pick a shorter period or one session for the rest.
        </p>
      )}
      <EventStream
        events={rows}
        toolbar={toolbar}
        emptyHint={sessionsLoading || loading ? "Reading the history…" : "Nothing was recorded in this period."}
      />
    </div>
  );
}

/**
 * Events: what polpo-zhc emits (tasks, agents, missions, approvals, notifications, system
 * messages…), live as it happens or from the history kept per server start.
 */
export function EventsPage() {
  const { events } = useEvents(undefined, 500);
  const { connectionStatus } = usePolpo();
  const connected = connectionStatus === "connected";
  const [params, setParams] = useSearchParams();
  const mode: "live" | "history" = params.get("view") === "history" ? "history" : "live";
  const setMode = (next: "live" | "history") =>
    setParams((p) => {
      const out = new URLSearchParams(p);
      if (next === "history") out.set("view", "history");
      else out.delete("view");
      return out;
    }, { replace: true });

  // Normalize SSE events to EventRowData
  const liveEvents: EventRowData[] = useMemo(
    () =>
      events.map((e) => ({
        id: e.id,
        event: e.event,
        data: e.data,
        timestamp: e.timestamp,
      })),
    [events],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header: mode switch + connection status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Mode toggle */}
          <div className="flex items-center rounded-lg border border-border/40 bg-muted/20 p-0.5">
            <button
              onClick={() => setMode("live")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                mode === "live"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Radio
                className={cn(
                  "h-3 w-3",
                  mode === "live" && connected && "text-teal-500",
                )}
              />
              Live
              {mode === "live" && connected && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
                </span>
              )}
            </button>
            <button
              onClick={() => setMode("history")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all",
                mode === "history"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Archive className="h-3 w-3" />
              History
            </button>
          </div>

          {/* Connection status (live mode only) */}
          {mode === "live" && (
            <>
              <div className="h-4 w-px bg-border" />
              <div className="flex items-center gap-2">
                {connected ? (
                  <Wifi className="h-3.5 w-3.5 text-teal-500" />
                ) : (
                  <WifiOff className="h-3.5 w-3.5 text-red-500" />
                )}
                <span className={cn("text-xs", connected ? "text-teal-400" : "text-muted-foreground")}>
                  {connected ? "Connected" : "Disconnected"}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {mode === "live" ? (
        connected ? (
          <EventStream events={liveEvents} />
        ) : (
          <Card className="flex-1 flex flex-col items-center justify-center bg-card/80 backdrop-blur-sm border-border/40">
            <CardContent className="flex flex-col items-center py-16 text-muted-foreground">
              <WifiOff className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">Not connected to server</p>
              <p className="text-xs mt-1">
                Check that the Polpo server is running to see live events
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <HistoryView />
      )}
    </div>
  );
}

/** @deprecated the page is Events now; kept for old imports. */
export const ActivityPage = EventsPage;
