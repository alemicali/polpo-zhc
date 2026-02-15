import { useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  FileText,
  Loader2,
  ChevronDown,
  Clock,
  Hash,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Info,
  Zap,
  Bot,
  Shield,
  ListChecks,
  Map,
  RefreshCw,
} from "lucide-react";
import { useLogs } from "@openpolpo/react-sdk";
import type { LogEntry } from "@openpolpo/react-sdk";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Log event styling ──

function getLogEventStyle(event: string): { icon: React.ElementType; color: string; bg: string } {
  if (event.startsWith("task:")) return { icon: ListChecks, color: "text-blue-400", bg: "bg-blue-500/10" };
  if (event.startsWith("agent:")) return { icon: Bot, color: "text-violet-400", bg: "bg-violet-500/10" };
  if (event.startsWith("assessment:")) return { icon: Shield, color: "text-amber-400", bg: "bg-amber-500/10" };
  if (event.startsWith("plan:")) return { icon: Map, color: "text-emerald-400", bg: "bg-emerald-500/10" };
  if (event.startsWith("deadlock:")) return { icon: AlertTriangle, color: "text-red-400", bg: "bg-red-500/10" };
  if (event.startsWith("orchestrator:")) return { icon: Zap, color: "text-zinc-400", bg: "bg-zinc-500/10" };
  if (event === "log") return { icon: Info, color: "text-zinc-400", bg: "bg-zinc-500/10" };
  return { icon: FileText, color: "text-zinc-400", bg: "bg-zinc-500/10" };
}

function getLogSeverityDot(event: string): string {
  if (event.includes("failed") || event.includes("maxRetries") || event.includes("unresolvable")) return "bg-red-500";
  if (event.includes("created") || event.includes("complete") || event.includes("resolved")) return "bg-emerald-500";
  if (event.includes("retry") || event.includes("fix") || event.includes("deadlock")) return "bg-amber-500";
  return "bg-zinc-500";
}

// ── Log entry row ──

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const style = getLogEventStyle(entry.event);
  const Icon = style.icon;
  const hasData = entry.data != null && Object.keys(entry.data as object).length > 0;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <div className={cn(
          "flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors",
          expanded ? "bg-muted/40" : "hover:bg-muted/20"
        )}>
          <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getLogSeverityDot(entry.event))} />
          <div className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded", style.bg)}>
            <Icon className={cn("h-3 w-3", style.color)} />
          </div>
          <Badge variant="outline" className="text-[8px] font-mono px-1 py-0 shrink-0">
            {entry.event}
          </Badge>
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
            {new Date(entry.ts).toLocaleTimeString()}
          </span>
          {hasData && (
            <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform shrink-0", expanded && "rotate-180")} />
          )}
        </div>
      </CollapsibleTrigger>
      {hasData && (
        <CollapsibleContent>
          <pre className="text-[9px] bg-muted/30 rounded px-3 py-2 ml-7 mr-2 mb-1 whitespace-pre-wrap font-mono overflow-x-auto text-muted-foreground">
            {JSON.stringify(entry.data, null, 2)}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

// ── Main page ──

export function LogsPage() {
  const { sessions, isLoading: logsLoading, error: logsError, getLogEntries, refetch } = useLogs();
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
    [getLogEntries]
  );

  // Entry severity summary
  const entrySeverityCounts = entries.reduce(
    (acc, e) => {
      if (e.event.includes("failed") || e.event.includes("error")) acc.errors++;
      else if (e.event.includes("retry") || e.event.includes("fix") || e.event.includes("deadlock")) acc.warnings++;
      else acc.ok++;
      return acc;
    },
    { errors: 0, warnings: 0, ok: 0 }
  );

  if (logsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-6 flex-1 min-h-0">
      {/* ── Left: Session list ── */}
      <Card className="flex flex-col overflow-hidden">
        <CardHeader className="pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Log Sessions</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                {sessions.length}
              </Badge>
            </div>
            <Button variant="outline" size="sm" onClick={refetch}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden">
          {logsError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <AlertTriangle className="h-10 w-10 mb-3 opacity-40 text-red-400" />
              <p className="text-sm font-medium">Failed to load sessions</p>
              <p className="text-xs text-red-400 mt-1">{logsError.message}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={refetch}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <FileText className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">No log sessions yet</p>
              <p className="text-xs mt-1">Sessions appear when the orchestrator runs</p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="space-y-1 pr-2">
                {sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => loadEntries(s.sessionId)}
                    className={cn(
                      "w-full text-left rounded-lg px-3 py-2.5 transition-colors border",
                      selectedSession === s.sessionId
                        ? "bg-accent text-accent-foreground border-accent"
                        : "border-transparent hover:bg-muted/50 text-muted-foreground"
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs truncate">{s.sessionId.slice(0, 20)}</span>
                      <Badge variant="secondary" className="text-[9px] shrink-0 ml-2">
                        <Hash className="h-2 w-2 mr-0.5" />
                        {s.entries}
                      </Badge>
                    </div>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" />
                      {formatDistanceToNow(new Date(s.startedAt), { addSuffix: true })}
                    </span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ── Right: Entry viewer ── */}
      <Card className="flex flex-col overflow-hidden">
        <CardHeader className="pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">
                {selectedSession ? "Session Events" : "Select a Session"}
              </CardTitle>
              {selectedSession && (
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary" className="text-[10px]">
                    {entries.length} events
                  </Badge>
                  {entrySeverityCounts.errors > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="destructive" className="text-[10px] cursor-help">
                          <XCircle className="h-2.5 w-2.5 mr-0.5" />
                          {entrySeverityCounts.errors}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">{entrySeverityCounts.errors} error events</TooltipContent>
                    </Tooltip>
                  )}
                  {entrySeverityCounts.warnings > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="text-[10px] text-amber-400 cursor-help">
                          <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                          {entrySeverityCounts.warnings}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">{entrySeverityCounts.warnings} warning events</TooltipContent>
                    </Tooltip>
                  )}
                  {entrySeverityCounts.ok > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1 cursor-help">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          <span className="text-[10px] text-muted-foreground">{entrySeverityCounts.ok}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">{entrySeverityCounts.ok} normal events</TooltipContent>
                    </Tooltip>
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
        <CardContent className="flex-1 overflow-hidden">
          {!selectedSession ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <FileText className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">No session selected</p>
              <p className="text-xs mt-1">Pick a session from the left to view its events</p>
            </div>
          ) : entriesLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : entriesError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mb-2 opacity-40 text-red-400" />
              <p className="text-xs text-red-400">{entriesError}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => selectedSession && loadEntries(selectedSession)}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Info className="h-8 w-8 mb-2 opacity-40" />
              <p className="text-xs">No events in this session</p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="space-y-0.5 pr-2">
                {entries.map((entry, i) => (
                  <LogEntryRow key={i} entry={entry} />
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
