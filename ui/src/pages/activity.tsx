import { useState, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";
import { useEvents, usePolpo } from "@openpolpo/react-sdk";
import type { SSEEvent } from "@openpolpo/react-sdk";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Event categories ──

type EventCategory = "task" | "agent" | "assessment" | "plan" | "deadlock" | "orchestrator" | "session" | "log" | "other";

function getCategory(event: string): EventCategory {
  if (event.startsWith("task:")) return "task";
  if (event.startsWith("agent:")) return "agent";
  if (event.startsWith("assessment:")) return "assessment";
  if (event.startsWith("plan:")) return "plan";
  if (event.startsWith("deadlock:")) return "deadlock";
  if (event.startsWith("orchestrator:")) return "orchestrator";
  if (event.startsWith("session:") || event.startsWith("message:")) return "session";
  if (event === "log") return "log";
  return "other";
}

const categoryConfig: Record<
  EventCategory,
  { icon: React.ElementType; label: string; color: string; bg: string }
> = {
  task: { icon: ListChecks, label: "Tasks", color: "text-blue-400", bg: "bg-blue-500/10" },
  agent: { icon: Bot, label: "Agents", color: "text-violet-400", bg: "bg-violet-500/10" },
  assessment: { icon: Shield, label: "Assessment", color: "text-amber-400", bg: "bg-amber-500/10" },
  plan: { icon: Map, label: "Plans", color: "text-emerald-400", bg: "bg-emerald-500/10" },
  deadlock: { icon: AlertTriangle, label: "Deadlock", color: "text-red-400", bg: "bg-red-500/10" },
  orchestrator: { icon: Zap, label: "Orchestrator", color: "text-zinc-400", bg: "bg-zinc-500/10" },
  session: { icon: MessageSquare, label: "Sessions", color: "text-sky-400", bg: "bg-sky-500/10" },
  log: { icon: Info, label: "Logs", color: "text-zinc-400", bg: "bg-zinc-500/10" },
  other: { icon: HelpCircle, label: "Other", color: "text-zinc-400", bg: "bg-zinc-500/10" },
};

// ── Semantic severity ──

type Severity = "success" | "info" | "warning" | "error" | "neutral";

function getSeverity(event: string): Severity {
  if (event.includes("created") || event.includes("spawned") || event.includes("saved") ||
      event.includes("complete") || event.includes("completed") || event.includes("resolved"))
    return "success";
  if (event.includes("failed") || event.includes("maxRetries") || event.includes("unresolvable"))
    return "error";
  if (event.includes("retry") || event.includes("fix") || event.includes("deadlock") ||
      event.includes("stale") || event.includes("timeout"))
    return "warning";
  if (event.includes("activity") || event.includes("tick"))
    return "neutral";
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
    case "created": case "spawned": case "saved":
      return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
    case "finished": case "complete": case "completed": case "resolved":
      return <CheckCircle2 className="h-3 w-3 text-blue-400" />;
    case "failed": case "maxRetries": case "unresolvable":
      return <XCircle className="h-3 w-3 text-red-400" />;
    case "retry": case "fix":
      return <RotateCcw className="h-3 w-3 text-amber-400" />;
    case "transition": case "updated":
      return <ChevronRight className="h-3 w-3 text-zinc-400" />;
    case "activity": case "tick":
      return <Clock className="h-3 w-3 text-zinc-500" />;
    case "started":
      return <Zap className="h-3 w-3 text-blue-400" />;
    case "deleted": case "removed":
      return <Trash2 className="h-3 w-3 text-red-400" />;
    case "executed": case "resumed":
      return <Zap className="h-3 w-3 text-emerald-400" />;
    case "aborted":
      return <Pause className="h-3 w-3 text-amber-400" />;
    default:
      return <FileText className="h-3 w-3 text-zinc-400" />;
  }
}

// ── Narrative builder ──

function buildNarrative(event: SSEEvent): string {
  const d = event.data as Record<string, unknown>;
  const category = getCategory(event.event);
  const action = event.event.split(":")[1] ?? event.event;

  switch (category) {
    case "task": {
      const title = (d?.task as { title?: string })?.title ?? (d?.title as string) ?? "";
      const agent = (d?.agentName as string) ?? (d?.assignTo as string) ?? "";
      const taskId = (d?.taskId as string)?.slice(0, 8) ?? "";

      switch (action) {
        case "created": return title ? `Task "${title}" created${agent ? ` for ${agent}` : ""}` : `Task ${taskId} created`;
        case "transition": {
          const from = d?.from as string;
          const to = d?.to as string;
          return `${title || taskId} moved ${from} → ${to}${agent ? ` (${agent})` : ""}`;
        }
        case "retry": return `Retrying ${title || taskId}${agent ? ` with ${agent}` : ""}`;
        case "fix": return `Fix attempt on ${title || taskId}`;
        case "maxRetries": return `${title || taskId} exhausted all retries`;
        case "question": return `Agent asked a question about ${title || taskId}`;
        case "answered": return `Question answered for ${title || taskId}`;
        case "timeout": return `${title || taskId} timed out`;
        case "recovered": return `${title || taskId} recovered`;
        default: return title || taskId || action;
      }
    }
    case "agent": {
      const name = (d?.agentName as string) ?? "";
      switch (action) {
        case "spawned": return `Agent ${name} spawned${d?.taskId ? ` for task ${(d.taskId as string).slice(0, 8)}` : ""}`;
        case "finished": return `Agent ${name} finished${d?.exitCode !== undefined ? ` (exit ${d.exitCode})` : ""}`;
        case "activity": return `${name}: ${(d?.summary as string) ?? (d?.lastTool ? `using ${d.lastTool}` : "active")}`;
        case "stale": return `Agent ${name} is stale — no activity detected`;
        default: return name || action;
      }
    }
    case "assessment": {
      const taskId = (d?.taskId as string)?.slice(0, 8) ?? "";
      switch (action) {
        case "started": return `Assessment started for ${taskId}`;
        case "progress": return `Assessment progress: ${d?.message ?? taskId}`;
        case "complete": {
          const passed = d?.passed as boolean;
          const score = d?.globalScore as number | undefined;
          return `Assessment ${passed ? "PASSED" : "FAILED"} for ${taskId}${score != null ? ` (score: ${Math.round(score * 100)}%)` : ""}`;
        }
        case "corrected": return `Assessment corrected for ${taskId}`;
        default: return taskId || action;
      }
    }
    case "plan": {
      const planName = (d?.name as string) ?? (d?.planId as string)?.slice(0, 8) ?? "";
      switch (action) {
        case "saved": return `Plan "${planName}" saved`;
        case "executed": return `Plan "${planName}" started execution`;
        case "completed": return `Plan "${planName}" completed`;
        case "resumed": return `Plan "${planName}" resumed`;
        case "deleted": return `Plan "${planName}" deleted`;
        default: return planName || action;
      }
    }
    case "deadlock": {
      switch (action) {
        case "detected": return `Deadlock detected — ${d?.message ?? "circular dependency"}`;
        case "resolving": return `Resolving deadlock...`;
        case "resolved": return `Deadlock resolved`;
        case "unresolvable": return `Deadlock is unresolvable — manual intervention needed`;
        default: return action;
      }
    }
    case "orchestrator": {
      switch (action) {
        case "started": return "Orchestrator started";
        case "tick": return `Tick: ${d?.pending ?? 0} pending, ${d?.running ?? 0} running, ${d?.done ?? 0} done`;
        case "deadlock": return "Orchestrator detected a deadlock";
        case "shutdown": return "Orchestrator shutting down";
        default: return action;
      }
    }
    case "session": {
      const sessionId = (d?.sessionId as string)?.slice(0, 8) ?? "";
      return action === "created" ? `Chat session ${sessionId} created` : `Message added to session ${sessionId}`;
    }
    default: {
      if (d?.message) return String(d.message).slice(0, 100);
      return event.event;
    }
  }
}

// ── Event row ──

function EventRow({ event }: { event: SSEEvent }) {
  const [expanded, setExpanded] = useState(false);
  const category = getCategory(event.event);
  const catCfg = categoryConfig[category];
  const CatIcon = catCfg.icon;
  const severity = getSeverity(event.event);
  const sevStyle = severityStyles[severity];
  const narrative = buildNarrative(event);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className={cn("border-l-2 transition-colors", sevStyle.border, expanded && "bg-muted/20")}>
        <CollapsibleTrigger asChild>
          <div className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors">
            {/* Category icon */}
            <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md mt-0.5", catCfg.bg)}>
              <CatIcon className={cn("h-3.5 w-3.5", catCfg.color)} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <EventActionIcon event={event.event} />
                <span className="text-xs font-medium text-foreground">{narrative}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0">
                  {event.event}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  {formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}
                </span>
              </div>
            </div>

            {/* Severity dot + expand */}
            <div className="flex items-center gap-2 shrink-0 mt-1">
              <div className={cn("h-1.5 w-1.5 rounded-full", sevStyle.dot)} />
              <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")} />
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 ml-10">
            <pre className="text-[10px] bg-muted/50 rounded-md p-3 whitespace-pre-wrap font-mono overflow-x-auto text-muted-foreground">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── Category stats ──

function CategoryStats({ events }: { events: SSEEvent[] }) {
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
      if (s === "neutral") continue; // Skip tick noise
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
          error: "Errors", warning: "Warnings", success: "Success", info: "Info",
        };
        return (
          <Tooltip key={sev}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-help">
                <div className={cn("h-2 w-2 rounded-full", severityStyles[sev].dot)} />
                <span className="text-[10px] text-muted-foreground">{count}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{labels[sev]}: {count}</TooltipContent>
          </Tooltip>
        );
      })}
      <div className="h-3 w-px bg-border" />
      {/* Category counts */}
      {Object.entries(counts)
        .filter(([cat]) => cat !== "orchestrator") // Skip tick noise in overview
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
                  <span className="text-[10px] text-muted-foreground">{count}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">{cfg.label}: {count} events</TooltipContent>
            </Tooltip>
          );
        })}
    </div>
  );
}

// ── Main page ──

export function ActivityPage() {
  const { events } = useEvents(undefined, 500);
  const { connectionStatus } = usePolpo();
  const connected = connectionStatus === "connected";
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");

  // Filter out tick events unless searching for them
  const baseEvents = useMemo(
    () => (search.toLowerCase().includes("tick")
      ? events
      : events.filter((e) => e.event !== "orchestrator:tick")),
    [events, search]
  );

  const filtered = useMemo(() => {
    let result = baseEvents;

    // Tab filter
    if (tab !== "all") {
      result = result.filter((e) => getCategory(e.event) === tab);
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.event.toLowerCase().includes(q) ||
          buildNarrative(e).toLowerCase().includes(q) ||
          JSON.stringify(e.data).toLowerCase().includes(q)
      );
    }

    return result;
  }, [baseEvents, tab, search]);

  // Show newest first
  const display = useMemo(() => [...filtered].reverse(), [filtered]);

  const tabCounts = useMemo(() => {
    const c: Partial<Record<EventCategory | "all", number>> = { all: baseEvents.length };
    for (const e of baseEvents) {
      const cat = getCategory(e.event);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [baseEvents]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {connected ? (
              <Wifi className="h-4 w-4 text-emerald-500" />
            ) : (
              <WifiOff className="h-4 w-4 text-red-500" />
            )}
            <span className="text-sm font-medium">
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>
          <div className="h-4 w-px bg-border" />
          <CategoryStats events={baseEvents} />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {display.length} event{display.length !== 1 ? "s" : ""}
          </Badge>
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter events..."
              className="pl-9 h-8 text-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Category tabs */}
      <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="flex-wrap shrink-0">
          <TabsTrigger value="all">
            All <Badge variant="secondary" className="ml-1.5 text-[10px]">{tabCounts.all ?? 0}</Badge>
          </TabsTrigger>
          {(["task", "agent", "assessment", "plan", "deadlock", "session"] as EventCategory[]).map((cat) => {
            const count = tabCounts[cat] ?? 0;
            if (count === 0) return null;
            const cfg = categoryConfig[cat];
            return (
              <TabsTrigger key={cat} value={cat}>
                <cfg.icon className={cn("h-3 w-3 mr-1", cfg.color)} />
                {cfg.label} <Badge variant="secondary" className="ml-1.5 text-[10px]">{count}</Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value={tab} className="mt-4 flex-1 min-h-0">
          <Card className="h-full flex flex-col overflow-hidden">
             <ScrollArea className="h-full">
              {display.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Activity className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm font-medium">
                    {connected
                      ? search || tab !== "all"
                        ? "No matching events"
                        : "Waiting for events..."
                      : "Not connected to server"}
                  </p>
                  <p className="text-xs mt-1">
                    {connected
                      ? "Events will stream here in real-time"
                      : "Check that the Polpo server is running"}
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
