import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Map,
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
  Hash,
  Loader2,
  RefreshCw,
  Radio,
  Archive,
  Bell,
} from "lucide-react";
import { useEvents, usePolpo, useLogs } from "@lumea-labs/polpo-react";
import type { LogEntry } from "@lumea-labs/polpo-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { JsonBlock } from "@/components/json-block";

// ── Event categories ──

type EventCategory =
  | "task"
  | "agent"
  | "assessment"
  | "plan"
  | "deadlock"
  | "orchestrator"
  | "session"
  | "notification"
  | "approval"
  | "log"
  | "other";

function getCategory(event: string): EventCategory {
  if (event.startsWith("task:")) return "task";
  if (event.startsWith("agent:")) return "agent";
  if (event.startsWith("assessment:")) return "assessment";
  if (event.startsWith("plan:")) return "plan";
  if (event.startsWith("deadlock:")) return "deadlock";
  if (event.startsWith("orchestrator:")) return "orchestrator";
  if (event.startsWith("session:") || event.startsWith("message:"))
    return "session";
  if (event.startsWith("notification:")) return "notification";
  if (event.startsWith("approval:")) return "approval";
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
  plan: {
    icon: Map,
    label: "Plans",
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
  log: {
    icon: Info,
    label: "Logs",
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
    case "plan": {
      const planName =
        (data?.name as string) ??
        (data?.planId as string)?.slice(0, 8) ??
        "";
      switch (action) {
        case "saved":
          return `Plan "${planName}" saved`;
        case "executed":
          return `Plan "${planName}" started execution`;
        case "completed":
          return `Plan "${planName}" completed`;
        case "resumed":
          return `Plan "${planName}" resumed`;
        case "deleted":
          return `Plan "${planName}" deleted`;
        default:
          return planName || action;
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

function EventStream({ events }: { events: EventRowData[] }) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");

  // Filter out tick events unless searching for them
  const baseEvents = useMemo(
    () =>
      search.toLowerCase().includes("tick")
        ? events
        : events.filter((e) => e.event !== "orchestrator:tick"),
    [events, search],
  );

  const filtered = useMemo(() => {
    let result = baseEvents;
    if (tab !== "all") {
      result = result.filter((e) => getCategory(e.event) === tab);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.event.toLowerCase().includes(q) ||
          buildNarrative(
            e.event,
            (e.data as Record<string, unknown>) ?? {},
          )
            .toLowerCase()
            .includes(q) ||
          JSON.stringify(e.data).toLowerCase().includes(q),
      );
    }
    return result;
  }, [baseEvents, tab, search]);

  const display = useMemo(() => [...filtered].reverse(), [filtered]);

  const tabCounts = useMemo(() => {
    const c: Partial<Record<EventCategory | "all", number>> = {
      all: baseEvents.length,
    };
    for (const e of baseEvents) {
      const cat = getCategory(e.event);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [baseEvents]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Search + count */}
      <div className="flex items-center justify-between">
        <CategoryStats events={baseEvents} />
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {display.length} event{display.length !== 1 ? "s" : ""}
          </Badge>
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter events..."
              className="pl-9 h-8 text-xs bg-input/50 border-border/40"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Category tabs + stream */}
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList className="flex-wrap shrink-0">
          <TabsTrigger value="all">
            All{" "}
            <Badge variant="secondary" className="ml-1.5 text-[10px]">
              {tabCounts.all ?? 0}
            </Badge>
          </TabsTrigger>
          {(
            [
              "task",
              "agent",
              "assessment",
              "plan",
              "deadlock",
              "session",
              "notification",
              "approval",
            ] as EventCategory[]
          ).map((cat) => {
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
                  <p className="text-sm font-medium">
                    {search || tab !== "all"
                      ? "No matching events"
                      : "No events yet"}
                  </p>
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

// ── History mode: session list + event viewer ──

function HistoryView() {
  const {
    sessions,
    isLoading: logsLoading,
    error: logsError,
    getLogEntries,
    refetch,
  } = useLogs();
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  const loadEntries = useCallback(
    async (sessionId: string) => {
      setSelectedSession(sessionId);
      setEntriesLoading(true);
      setEntriesError(null);
      try {
        const data = await getLogEntries(sessionId);
        setEntries(data);
      } catch (err) {
        setEntries([]);
        setEntriesError((err as Error).message);
      } finally {
        setEntriesLoading(false);
      }
    },
    [getLogEntries],
  );

  // Convert log entries to EventRowData for reuse
  const eventRows = useMemo(
    () => entries.map((e, i) => logEntryToEventRow(e, i)),
    [entries],
  );

  // Severity summary for selected session
  const severitySummary = useMemo(() => {
    const s = { errors: 0, warnings: 0, ok: 0 };
    for (const e of entries) {
      if (e.event.includes("failed") || e.event.includes("error"))
        s.errors++;
      else if (
        e.event.includes("retry") ||
        e.event.includes("fix") ||
        e.event.includes("deadlock")
      )
        s.warnings++;
      else s.ok++;
    }
    return s;
  }, [entries]);

  if (logsLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
  }

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[300px_1fr] gap-4 flex-1 min-h-0">
      {/* Left: Session list */}
      <Card className="flex flex-col overflow-hidden bg-card/80 backdrop-blur-sm border-border/40">
        <CardHeader className="pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Sessions</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                {sessions.length}
              </Badge>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={refetch}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden px-3 pb-3">
          {logsError ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mb-2 opacity-40 text-red-400" />
              <p className="text-xs font-medium">Failed to load sessions</p>
              <p className="text-[10px] text-red-400 mt-1">
                {logsError.message}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={refetch}
              >
                <RefreshCw className="h-3 w-3 mr-1.5" /> Retry
              </Button>
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Archive className="h-8 w-8 mb-2 opacity-40" />
              <p className="text-xs font-medium">No log sessions yet</p>
              <p className="text-[10px] mt-1">
                Sessions appear when the orchestrator runs
              </p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="space-y-1">
                {sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => loadEntries(s.sessionId)}
                    className={cn(
                      "w-full text-left rounded-lg px-3 py-2.5 transition-colors border",
                      selectedSession === s.sessionId
                        ? "bg-accent/80 text-accent-foreground border-accent"
                        : "border-transparent hover:bg-accent/30 text-muted-foreground",
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[11px] truncate">
                        {s.sessionId.slice(0, 20)}
                      </span>
                      <Badge
                        variant="secondary"
                        className="text-[9px] shrink-0 ml-2"
                      >
                        <Hash className="h-2 w-2 mr-0.5" />
                        {s.entries}
                      </Badge>
                    </div>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" />
                      {formatDistanceToNow(new Date(s.startedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Right: Session event viewer */}
      <Card className="flex flex-col overflow-hidden bg-card/80 backdrop-blur-sm border-border/40">
        <CardHeader className="pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">
                {selectedSession ? "Session Events" : "Select a Session"}
              </CardTitle>
              {selectedSession && entries.length > 0 && (
                <div className="flex items-center gap-2 mt-1.5">
                  <Badge variant="secondary" className="text-[10px]">
                    {entries.length} events
                  </Badge>
                  {severitySummary.errors > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="destructive"
                          className="text-[10px] cursor-help"
                        >
                          <XCircle className="h-2.5 w-2.5 mr-0.5" />
                          {severitySummary.errors}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">
                        {severitySummary.errors} error events
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {severitySummary.warnings > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="text-[10px] text-amber-400 cursor-help"
                        >
                          <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                          {severitySummary.warnings}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">
                        {severitySummary.warnings} warning events
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {severitySummary.ok > 0 && (
                    <div className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                      <span className="text-[10px] text-muted-foreground">
                        {severitySummary.ok}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {selectedSession && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {selectedSession.slice(0, 16)}...
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0">
          {!selectedSession ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Archive className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">No session selected</p>
              <p className="text-xs mt-1">
                Pick a session from the left to view its events
              </p>
            </div>
          ) : entriesLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : entriesError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mb-2 opacity-40 text-red-400" />
              <p className="text-xs text-red-400">{entriesError}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() =>
                  selectedSession && loadEntries(selectedSession)
                }
              >
                <RefreshCw className="h-3 w-3 mr-1.5" /> Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Info className="h-8 w-8 mb-2 opacity-40" />
              <p className="text-xs">No events in this session</p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="divide-y divide-border/30">
                {eventRows.map((event, i) => (
                  <EventRow key={`${event.id}-${i}`} event={event} />
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main page ──

export function ActivityPage() {
  const { events } = useEvents(undefined, 500);
  const { connectionStatus } = usePolpo();
  const connected = connectionStatus === "connected";
  const [mode, setMode] = useState<"live" | "history">("live");

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
