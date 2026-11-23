import { memo, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { PieChart, Pie, Cell, Label } from "recharts";
import {
  ListChecks,
  Bot,
  Target,
  Clock,
  Loader2,
  ArrowRight,
  Zap,
  Star,
  Binary,
  CalendarDays,
} from "lucide-react";
import { useTasks, useMissions, useProcesses, useAgents } from "@polpo-ai/react";
import type { Task, AgentProcess, PolpoStats } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { taskStatusStyles, taskPhaseStyles } from "@/lib/status-tokens";
import { Eyebrow } from "@/components/shared/eyebrow";
import { StatValue, type StatTone } from "@/components/shared/stat-value";
import { useTokenUsage, type TokenUsageRange } from "@/hooks/use-token-usage";

const DASHBOARD_RANGES: { value: TokenUsageRange; label: string; shortLabel: string }[] = [
  { value: "today", label: "Today", shortLabel: "Today" },
  { value: "7d", label: "Last 7 days", shortLabel: "7d" },
  { value: "30d", label: "Last 30 days", shortLabel: "30d" },
  { value: "all", label: "All time", shortLabel: "All" },
];

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function TokenUsageStrip({ range }: { range: TokenUsageRange }) {
  const { usage, loading } = useTokenUsage(range);
  const metrics: Array<{ label: string; display: string; raw: string | number; detail?: string }> = [
    { label: "Processed", display: formatTokens(usage?.totalTokens ?? 0), raw: usage?.totalTokens ?? 0 },
    { label: "Uncached input", display: formatTokens(usage?.inputTokens ?? 0), raw: usage?.inputTokens ?? 0 },
    { label: "Generated", display: formatTokens(usage?.outputTokens ?? 0), raw: usage?.outputTokens ?? 0 },
    {
      label: "Cache read",
      display: formatTokens(usage?.cacheReadTokens ?? 0),
      raw: `${(usage?.cacheReadTokens ?? 0).toLocaleString()} read / ${(usage?.cacheWriteTokens ?? 0).toLocaleString()} write`,
      detail: `${formatTokens(usage?.cacheWriteTokens ?? 0)} write`,
    },
    { label: "Task processed", display: formatTokens(usage?.taskTokens ?? 0), raw: usage?.taskTokens ?? 0 },
  ] as const;

  return (
    <section className="border-y border-border/70 bg-card/35 px-4 py-3" aria-label="Token usage">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex items-center gap-2 lg:w-36 lg:shrink-0">
          <Binary className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <div className="text-xs font-semibold">Token usage</div>
            <div className="text-micro text-muted-foreground">{usage?.calls ?? 0} chat calls</div>
          </div>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-5">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0 border-l border-border/60 pl-3">
              <div className="truncate text-micro text-muted-foreground" title={metric.label}>{metric.label}</div>
              <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums" title={String(metric.raw)}>
                {metric.display}
              </div>
              {metric.detail && <div className="text-micro text-muted-foreground">{metric.detail}</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function dashboardRangeStart(range: TokenUsageRange, now = new Date()): number {
  if (range === "all") return 0;
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  const duration = range === "24h" ? 1 : range === "7d" ? 7 : 30;
  return now.getTime() - duration * 86_400_000;
}

function dashboardRangeLabel(range: TokenUsageRange): string {
  return DASHBOARD_RANGES.find((option) => option.value === range)?.label ?? "Last 24 hours";
}

function DashboardRangeControl({ range, onChange }: { range: TokenUsageRange; onChange: (range: TokenUsageRange) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="hidden items-center gap-1.5 text-small font-medium text-muted-foreground sm:flex">
        <CalendarDays className="h-4 w-4" /> Period
      </span>
      <SegmentedControl size="sm" aria-label="Dashboard period" value={range} onValueChange={onChange}>
        {DASHBOARD_RANGES.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} title={option.label}>
            {option.shortLabel}
          </ToggleGroupItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

// ── Phase icon helper ──

function PhaseIcon({ phase }: { phase?: string }) {
  if (phase !== "fix" && phase !== "review" && phase !== "clarification") return null;
  const p = taskPhaseStyles[phase];
  return <p.icon className={cn("h-3 w-3", p.color)} />;
}

// ── Live ticker ──

const TICKER_ITEMS = [
  { label: "Pending", key: "pending" as const, color: "bg-status-queued", glow: "" },
  { label: "Queued", key: "queued" as const, color: "bg-status-assigned", glow: "shadow-glow-strong glow-status-assigned" },
  { label: "Running", key: "running" as const, color: "bg-status-running", glow: "shadow-glow-strong glow-status-running" },
  { label: "Done", key: "done" as const, color: "bg-success", glow: "shadow-glow-strong glow-success" },
  { label: "Failed", key: "failed" as const, color: "bg-destructive", glow: "shadow-glow-strong glow-destructive" },
] satisfies { label: string; key: keyof PolpoStats; color: string; glow: string }[];

const LiveTicker = memo(function LiveTicker({ stats }: { stats: PolpoStats | null }) {
  if (!stats) return null;
  const total = stats.pending + stats.queued + stats.running + stats.done + stats.failed;

  return (
    <div className="flex items-center gap-4">
      {TICKER_ITEMS.map((item) => {
        const value = stats[item.key];
        return (
          <div key={item.label} className="flex items-center gap-1.5">
            <div className={cn(
              "h-2 w-2 rounded-pill",
              item.color,
              value > 0 && item.glow,
              value > 0 && item.key === "running" && "animate-pulse",
            )} />
            <span className="text-xs text-muted-foreground">{item.label}</span>
            <span className="text-xs font-bold font-mono">{value}</span>
          </div>
        );
      })}
      {total > 0 && (
        <div className="text-micro text-muted-foreground ml-2 font-mono">
          Total: {total}
        </div>
      )}
    </div>
  );
});

// ── Stat card ──

const ACCENT_BAR_COLORS: Record<StatTone, string> = {
  default: "bg-primary/30",
  muted: "bg-primary/30",
  info: "bg-info/60",
  success: "bg-success/60",
  warning: "bg-warning/60",
  destructive: "bg-destructive/60",
};

const StatCard = memo(function StatCard({
  title,
  value,
  icon,
  description,
  tone = "default",
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  description?: string;
  tone?: StatTone;
}) {
  return (
    <Card className="relative overflow-hidden transition-shadow hover:shadow-glow">
      <CardContent>
        <StatValue label={title} value={value} hint={description} icon={icon} tone={tone} />
      </CardContent>
      {/* Accent bar */}
      <div className={cn("absolute bottom-0 left-0 right-0 h-[2px]", ACCENT_BAR_COLORS[tone])} />
    </Card>
  );
});

// ── Task progress donut chart ──

const STATUS_COLORS = {
  done: taskStatusStyles.done.css,
  failed: taskStatusStyles.failed.css,
  running: taskStatusStyles.in_progress.css,
  queued: "var(--status-assigned)",
};

const progressChartConfig = {
  done: { label: "Done", color: STATUS_COLORS.done },
  failed: { label: "Failed", color: STATUS_COLORS.failed },
  running: { label: "Running", color: STATUS_COLORS.running },
  queued: { label: "Queued", color: STATUS_COLORS.queued },
} satisfies ChartConfig;

const TaskProgress = memo(function TaskProgress({ tasks, range, now }: { tasks: Task[]; range: TokenUsageRange; now: number }) {
  const total = tasks.length;
  // Single-pass count reduction instead of 4 separate .filter() calls
  const counts = useMemo(() => {
    const c = { done: 0, failed: 0, running: 0, queued: 0 };
    for (const t of tasks) {
      if (t.status === "done") c.done++;
      else if (t.status === "failed") c.failed++;
      else if (t.status === "in_progress" || t.status === "review") c.running++;
      else if (t.status === "pending" || t.status === "assigned") c.queued++;
    }
    return c;
  }, [tasks]);
  const completionRate = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const successRate = counts.done + counts.failed > 0
    ? Math.round((counts.done / (counts.done + counts.failed)) * 100)
    : 100;

  const chartData = [
    { status: "done", count: counts.done, fill: STATUS_COLORS.done },
    { status: "failed", count: counts.failed, fill: STATUS_COLORS.failed },
    { status: "running", count: counts.running, fill: STATUS_COLORS.running },
    { status: "queued", count: counts.queued, fill: STATUS_COLORS.queued },
  ].filter(d => d.count > 0);

  const isEmpty = chartData.length === 0;

  // If no tasks, show a visible empty ring
  if (isEmpty) {
    chartData.push({ status: "queued", count: 1, fill: "var(--muted)" });
  }

  return (
    <Card className="lg:col-span-7">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Task Progress</CardTitle>
            <CardDescription>{counts.done} of {total} completed</CardDescription>
          </div>
          <div className="text-right">
            <p className="text-micro text-muted-foreground">
              {successRate}% success rate
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-5">
          {/* Donut chart */}
          <ChartContainer config={progressChartConfig} className="h-[120px] w-[120px] shrink-0">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie
                data={chartData}
                dataKey="count"
                nameKey="status"
                innerRadius={36}
                outerRadius={56}
                strokeWidth={2}
                stroke="var(--background)"
              >
                {chartData.map((entry) => (
                  <Cell key={entry.status} fill={entry.fill} />
                ))}
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                      return isEmpty ? (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 3} className="fill-muted-foreground text-caption font-medium">
                            No tasks
                          </tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 10} className="fill-muted-foreground/60 text-micro">
                            yet
                          </tspan>
                        </text>
                      ) : (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 5} className="fill-foreground text-xl font-bold">
                            {completionRate}%
                          </tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 10} className="fill-muted-foreground text-micro">
                            complete
                          </tspan>
                        </text>
                      );
                    }
                  }}
                />
              </Pie>
            </PieChart>
          </ChartContainer>

          {/* Legend + counts */}
          <div className="flex-1 grid grid-cols-2 gap-2.5">
            {([
              ["Done", counts.done, STATUS_COLORS.done, "text-success"],
              ["Failed", counts.failed, STATUS_COLORS.failed, "text-destructive"],
              ["Running", counts.running, STATUS_COLORS.running, "text-status-running"],
              ["Queued", counts.queued, STATUS_COLORS.queued, "text-status-assigned"],
            ] as const).map(([label, count, dotColor, textColor]) => (
              <div key={label} className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: dotColor }} />
                <div>
                  <p className={cn("text-base font-semibold leading-none tabular-nums", count > 0 ? textColor : "text-muted-foreground")}>
                    {count}
                  </p>
                  <p className="text-micro text-muted-foreground mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Vital signs strip ── */}
        <VitalSignsStrip tasks={tasks} range={range} now={now} />
      </CardContent>
    </Card>
  );
});

// ── Vital signs strip — range-aware throughput, quality and completion metrics.

function Sparkline({ data, height = 30 }: { data: number[]; height?: number }) {
  if (data.length === 0) return null;
  const max = Math.max(...data, 1);
  const w = 100;
  const stepX = w / Math.max(data.length - 1, 1);
  const pad = 1.5; // top padding so the line never touches the edge
  const yFor = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const linePts = data.map((v, i) => `${(i * stepX).toFixed(2)},${yFor(v).toFixed(2)}`).join(" ");
  const areaPts = `0,${height} ${linePts} ${(data.length - 1) * stepX},${height}`;
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="w-full block"
      style={{ height }}
    >
      <polygon points={areaPts} fill="var(--primary)" opacity="0.16" />
      <polyline
        points={linePts}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const VitalSignsStrip = memo(function VitalSignsStrip({ tasks, range, now }: { tasks: Task[]; range: TokenUsageRange; now: number }) {
  const stats = useMemo(() => {
    const start = range === "all"
      ? Math.min(...tasks.map((task) => Date.parse(task.updatedAt)).filter(Number.isFinite), now)
      : dashboardRangeStart(range, new Date(now));
    const bucketCount = range === "today" || range === "24h" ? 24 : range === "7d" ? 7 : range === "30d" ? 30 : 24;
    const span = Math.max(1, now - start);
    const buckets = Array<number>(bucketCount).fill(0);
    const durations: number[] = [];
    const scores: number[] = [];
    let completed = 0;
    let doneOrFailed = 0;
    let firstPass = 0;

    for (const t of tasks) {
      const ts = new Date(t.updatedAt).getTime();
      if (t.status === "done") {
        completed++;
        const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(((ts - start) / span) * bucketCount)));
        buckets[bucket]++;
        const created = new Date(t.createdAt).getTime();
        const dur = ts - created;
        if (dur > 0) durations.push(dur);
      }
      const score = t.result?.assessment?.globalScore;
      if (score != null) scores.push(score);
      if (t.status === "done" || t.status === "failed") {
        doneOrFailed++;
        if (t.status === "done" && (t.retries ?? 0) === 0) firstPass++;
      }
    }

    const sortedDurations = durations.sort((a, b) => a - b);
    const midpoint = Math.floor(sortedDurations.length / 2);
    const medianDuration = sortedDurations.length === 0
      ? null
      : sortedDurations.length % 2 === 0
        ? (sortedDurations[midpoint - 1] + sortedDurations[midpoint]) / 2
        : sortedDurations[midpoint];

    return {
      buckets,
      completed,
      averageScore: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      firstPassRate: doneOrFailed > 0 ? (firstPass / doneOrFailed) * 100 : null,
      medianDuration,
    };
  }, [now, range, tasks]);

  const period = dashboardRangeLabel(range).toLocaleLowerCase();

  return (
    <div className="mt-6 pt-5 border-t border-border/40 flex flex-col gap-6">
      <div className="min-w-0 flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow as="span" className="leading-none text-muted-foreground/80">
            Throughput
          </Eyebrow>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-semibold tabular-nums leading-none">{stats.completed}</span>
            <span className="text-micro text-muted-foreground/70 leading-none">tasks</span>
          </div>
        </div>
        <Sparkline data={stats.buckets} height={36} />
        <span className="text-micro text-muted-foreground/55 leading-none">
          Completed during {period}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-x-6">
        <Metric label="Avg Quality" caption={period}>
          {stats.averageScore != null ? (
            <MetricBigValue
              value={stats.averageScore.toFixed(1)}
              unit={
                <span className="flex items-center gap-1">
                  / 5 <Star className="h-3 w-3 text-warning" fill="currentColor" />
                </span>
              }
            />
          ) : (
            <MetricEmpty text="No assessments yet" />
          )}
        </Metric>

        <Metric label="First-Pass" caption={`no retries · ${period}`}>
          {stats.firstPassRate != null ? (
            <MetricBigValue
              value={Math.round(stats.firstPassRate).toString()}
              unit="%"
            />
          ) : (
            <MetricEmpty text="No completed yet" />
          )}
        </Metric>

        <Metric label="Median Duration" caption={`time to complete · ${period}`}>
          {stats.medianDuration != null ? (
            <MetricBigValue
              value={formatShortDuration(stats.medianDuration)}
              unit=""
            />
          ) : (
            <MetricEmpty text="No completed yet" />
          )}
        </Metric>
      </div>
    </div>
  );
});

// ── Strip primitives — keep markup uniform across cells ──

function Metric({ label, caption, children }: { label: string; caption?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex flex-col gap-2">
      <Eyebrow as="span" className="leading-none text-muted-foreground/80">
        {label}
      </Eyebrow>
      <div className="flex-1 flex flex-col justify-center min-h-[40px]">
        {children}
      </div>
      {caption && (
        <span className="text-micro text-muted-foreground/55 leading-none">
          {caption}
        </span>
      )}
    </div>
  );
}

function MetricBigValue({
  value,
  unit,
  delta,
}: {
  value: string;
  unit: React.ReactNode;
  delta?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-heading text-h1 tabular-nums leading-none">{value}</span>
      {unit && <span className="text-micro text-muted-foreground/70 leading-none">{unit}</span>}
      {delta && <span className="ml-auto self-center">{delta}</span>}
    </div>
  );
}

function MetricEmpty({ text }: { text: string }) {
  return <span className="text-xs text-muted-foreground/55">{text}</span>;
}

function formatShortDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

// ── Active agents with narrative ──

const ActiveAgents = memo(function ActiveAgents({ processes }: { processes: AgentProcess[] }) {
  if (processes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Active Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Bot className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No agents running</p>
            <p className="text-xs">Agents will appear here when tasks are executing</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(processes.length > 0 && "glow-cyan")}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Active Agents</CardTitle>
        <CardDescription>{processes.length} agent{processes.length !== 1 ? "s" : ""} working</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {processes.map((p) => {
          const activity = p.activity;
          const narrative = activity?.summary
            ? activity.summary
            : activity?.lastTool && activity?.lastFile
            ? `Using **${activity.lastTool}** on \`${activity.lastFile}\``
            : activity?.lastTool
            ? `Using **${activity.lastTool}**`
            : "Working...";

          return (
            <div key={`${p.agentName}-${p.taskId}`} className="rounded-lg border border-border/40 bg-card/60 backdrop-blur-surface p-3">
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{p.agentName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-micro">
                    {activity?.toolCalls ?? 0} calls
                  </Badge>
                  {activity?.filesCreated && activity.filesCreated.length > 0 && (
                    <Badge variant="outline" className="text-micro">
                      +{activity.filesCreated.length} files
                    </Badge>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {narrative}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
});

// ── Recent tasks with richer info ──

const RecentTasks = memo(function RecentTasks({ tasks }: { tasks: Task[] }) {
  const recent = [...tasks]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  return (
    <Card className="lg:col-span-5">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
          <CardDescription>Latest task updates</CardDescription>
        </div>
        <Link to="/tasks">
          <Button variant="ghost" size="sm" className="text-xs">
            View all <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <ListChecks className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No tasks yet</p>
            <p className="text-xs">Tasks will appear when a mission is executed</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {recent.map((task) => {
              const cfg = taskStatusStyles[task.status] ?? { icon: Clock, color: "text-muted-foreground" };

              return (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/30"
                >
                  <cfg.icon className={cn("h-4 w-4 shrink-0", cfg.color, task.status === "in_progress" && "animate-spin")} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{task.title}</p>
                      <PhaseIcon phase={task.phase} />
                    </div>
                    <p className="text-micro text-muted-foreground">
                      {task.assignTo}
                      {task.group && ` / ${task.group}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {task.result?.assessment?.globalScore != null && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant={task.result.assessment.passed ? "default" : "destructive"}
                            className={cn(
                              "text-micro cursor-help",
                              task.result.assessment.passed
                                ? "bg-success/20 text-success border-success/30 hover:bg-success/30"
                                : "bg-destructive/20 text-destructive border-destructive/30 hover:bg-destructive/30",
                            )}
                          >
                            <Star className="h-2.5 w-2.5 mr-0.5" />
                            {task.result.assessment.globalScore.toFixed(1)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          Assessment score: {task.result.assessment.globalScore.toFixed(1)}/5
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {task.retries > 0 && (
                      <span className="text-micro text-muted-foreground">
                        retry {task.retries}/{task.maxRetries}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
});

// ── Main ──

export function DashboardPage() {
  const { tasks, isLoading: tasksLoading } = useTasks();
  const { missions } = useMissions();
  const { processes } = useProcesses();
  const { agents } = useAgents();
  const [range, setRange] = useState<TokenUsageRange>("today");
  const [rangeNow] = useState(() => Date.now());
  const filteredTasks = useMemo(
    () => {
      const cutoff = dashboardRangeStart(range, new Date(rangeNow));
      return tasks.filter((task) => range === "all" || Date.parse(task.updatedAt) >= cutoff);
    },
    [range, rangeNow, tasks],
  );
  const filteredMissions = useMemo(
    () => {
      const cutoff = dashboardRangeStart(range, new Date(rangeNow));
      return missions.filter((mission) => range === "all" || Date.parse(mission.updatedAt) >= cutoff);
    },
    [missions, range, rangeNow],
  );

  const { activeMissions, doneCount, failedCount, stats } = useMemo(() => {
    let active = 0, done = 0, failed = 0;
    const nextStats: PolpoStats = { pending: 0, queued: 0, running: 0, done: 0, failed: 0 };
    for (const mission of filteredMissions) if (mission.status === "active") active++;
    for (const task of filteredTasks) {
      if (task.status === "done") { done++; nextStats.done++; }
      else if (task.status === "failed") { failed++; nextStats.failed++; }
      else if (task.status === "in_progress" || task.status === "review") nextStats.running++;
      else if (task.status === "assigned" || task.status === "awaiting_approval") nextStats.queued++;
      else nextStats.pending++;
    }
    return { activeMissions: active, doneCount: done, failedCount: failed, stats: nextStats };
  }, [filteredMissions, filteredTasks]);

  if (tasksLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 flex-1 min-h-0 overflow-auto pb-bottom-nav lg:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <LiveTicker stats={stats} />
        <DashboardRangeControl range={range} onChange={setRange} />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 lg:gap-4">
        <StatCard
          title="Tasks"
          value={filteredTasks.length}
          icon={ListChecks}
          description={`${doneCount} completed, ${failedCount} failed · ${dashboardRangeLabel(range).toLocaleLowerCase()}`}
        />
        <StatCard
          title="Active Missions"
          value={activeMissions}
          icon={Target}
          description={`${filteredMissions.length} in selected period`}
          tone={activeMissions > 0 ? "info" : undefined}
        />
        <StatCard
          title="Agents Online"
          value={processes.length}
          icon={Bot}
          description={`${agents.length} configured · live now`}
          tone={processes.length > 0 ? "success" : undefined}
        />
        <StatCard
          title="Success Rate"
          value={
            doneCount + failedCount > 0
              ? `${Math.round((doneCount / (doneCount + failedCount)) * 100)}%`
              : "N/A"
          }
          icon={Zap}
          description={failedCount > 0 ? `${failedCount} failed` : "All clear"}
          tone={(() => {
            if (doneCount + failedCount === 0) return undefined;
            const rate = Math.round((doneCount / (doneCount + failedCount)) * 100);
            if (rate >= 90) return "success";
            if (rate >= 70) return "warning";
            return "destructive";
          })()}
        />
      </div>

      <TokenUsageStrip range={range} />

      {/* Main content — TaskProgress + Recent Activity in the top row,
          Active Agents below at full width so a busy team doesn't get
          squashed into 1/3 of the viewport.
          12-col grid lets us narrow TaskProgress a touch (7/12 ≈ 58%) so
          Recent Activity gets a more comfortable column. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <TaskProgress tasks={filteredTasks} range={range} now={rangeNow} />
        <RecentTasks tasks={filteredTasks} />
      </div>

      <ActiveAgents processes={processes} />
    </div>
  );
}
