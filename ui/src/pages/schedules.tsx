import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import {
  Calendar,
  Repeat,
  Timer,
  Loader2,
  Search,
  RefreshCw,
  Clock,
  Power,
  PowerOff,
} from "lucide-react";
import { useSchedules, useMissions } from "@lumea-labs/polpo-react";
import type { ScheduleEntry, Mission } from "@lumea-labs/polpo-react";
import { useAsyncAction } from "@/hooks/use-polpo";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";
import { cronToHuman } from "@/lib/cron";

// ── Schedule row ──

function ScheduleRow({
  entry,
  mission,
  onClick,
}: {
  entry: ScheduleEntry;
  mission?: Mission;
  onClick: () => void;
}) {
  const isOverdue = entry.nextRunAt && new Date(entry.nextRunAt).getTime() < Date.now();

  return (
    <div
      className={cn(
        "group relative flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-4 rounded-lg",
        "bg-card/80 backdrop-blur-sm border border-border/40",
        "transition-all duration-200 hover:border-primary/20 cursor-pointer",
        entry.enabled && "border-l-2 border-l-blue-400/60",
        !entry.enabled && "opacity-60",
      )}
      onClick={onClick}
    >
      {/* Icon */}
      <div className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
        entry.enabled ? "bg-blue-500/10" : "bg-zinc-500/10",
      )}>
        <Calendar className={cn("h-4 w-4", entry.enabled ? "text-blue-400" : "text-zinc-500")} />
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {mission?.name ?? entry.missionId}
          </span>
          <Badge variant="outline" className={cn("text-[10px] shrink-0", entry.enabled ? "text-emerald-400" : "text-zinc-500")}>
            {entry.enabled ? "Enabled" : "Disabled"}
          </Badge>
          {entry.recurring ? (
            <Badge variant="outline" className="text-[10px] gap-0.5 text-violet-400 shrink-0">
              <Repeat className="h-2.5 w-2.5" />Recurring
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">One-shot</Badge>
          )}
        </div>

        {/* Expression */}
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 font-medium text-foreground/80">
            <Timer className="h-3 w-3" />
            {cronToHuman(entry.expression)}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/60">{entry.expression}</span>
        </div>

        {/* Next/Last run */}
        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
          {entry.nextRunAt && (
            <span className={cn("flex items-center gap-1", isOverdue && "text-red-400")}>
              <Clock className="h-3 w-3" />
              Next: {isOverdue ? "overdue" : formatDistanceToNow(new Date(entry.nextRunAt), { addSuffix: true })}
            </span>
          )}
          {entry.lastRunAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last: {formatDistanceToNow(new Date(entry.lastRunAt), { addSuffix: true })}
            </span>
          )}
          <span>created {format(new Date(entry.createdAt), "MMM d, HH:mm")}</span>
        </div>
      </div>

      {/* Enabled indicator */}
      <div className="flex items-center shrink-0">
        {entry.enabled ? (
          <Power className="h-4 w-4 text-emerald-400" />
        ) : (
          <PowerOff className="h-4 w-4 text-zinc-500" />
        )}
      </div>
    </div>
  );
}

// ── Main page ──

export function SchedulesPage() {
  const navigate = useNavigate();
  const { schedules, isLoading, refetch } = useSchedules();
  const { missions } = useMissions();
  const [search, setSearch] = useState("");

  const [handleRefresh, isRefreshing] = useAsyncAction(async () => {
    await refetch();
  });

  // Build mission lookup
  const missionMap = useMemo(() => {
    const map = new Map<string, Mission>();
    for (const m of missions) map.set(m.id, m);
    return map;
  }, [missions]);

  // Filter
  const filtered = useMemo(() => {
    if (!search) return schedules;
    const q = search.toLowerCase();
    return schedules.filter(s => {
      const mission = missionMap.get(s.missionId);
      return (
        s.expression.toLowerCase().includes(q) ||
        s.missionId.toLowerCase().includes(q) ||
        (mission?.name ?? "").toLowerCase().includes(q) ||
        cronToHuman(s.expression).toLowerCase().includes(q)
      );
    });
  }, [schedules, search, missionMap]);

  const enabled = filtered.filter(s => s.enabled);
  const disabled = filtered.filter(s => !s.enabled);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary glow-cyan" />
      </div>
    );
  }

  const sections = [
    { label: "Active", schedules: enabled, defaultOpen: true },
    { label: "Disabled", schedules: disabled, defaultOpen: false },
  ].filter(s => s.schedules.length > 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 lg:gap-3 shrink-0">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search schedules..."
            className="pl-8 h-8 text-sm bg-input/50 backdrop-blur-sm border-border/40 focus:border-primary/50"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            <span className="font-mono">{filtered.length}</span>{search ? ` of ${schedules.length}` : ""} schedule{filtered.length !== 1 ? "s" : ""}
          </span>
          {enabled.length > 0 && (
            <Badge variant="default" className="text-[10px] font-mono">
              {enabled.length} active
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="hover:bg-accent/50">
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {schedules.length === 0 ? (
        <Card className="bg-card/60 backdrop-blur-sm border-border/40">
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Calendar className="h-12 w-12 mb-4 text-primary/30" />
            <p className="text-sm font-medium">No schedules</p>
            <p className="text-xs mt-1 text-center max-w-xs">
              Schedules are created when you add a <code className="bg-muted px-1 rounded">schedule</code> field to a mission definition.
            </p>
            <kbd className="mt-3 rounded border border-border bg-muted px-2 py-1 font-mono text-[10px]">
              {"{ \"schedule\": \"0 9 * * 1\", \"recurring\": true }"}
            </kbd>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 pr-4">
            {sections.map(({ label, schedules: sectionSchedules }) => (
              <section key={label}>
                <div className="mb-3">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                    {label} ({sectionSchedules.length})
                  </h3>
                  <div className="mt-1.5 h-px bg-border/40" />
                </div>
                <div className="space-y-2">
                  {sectionSchedules.map((entry) => (
                    <ScheduleRow
                      key={entry.id}
                      entry={entry}
                      mission={missionMap.get(entry.missionId)}
                      onClick={() => navigate(`/missions/${entry.missionId}`)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
