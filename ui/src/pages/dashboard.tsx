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
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  ArrowRight,
  Zap,
  Star,
  Eye,
  Hammer,
  HelpCircle,
  FileEdit,
  Binary,
} from "lucide-react";
import { useTasks, useMissions, useProcesses, useAgents, useStats } from "@polpo-ai/react";
import type { Task, AgentProcess, PolpoStats } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { useTokenUsage, type TokenUsageRange } from "@/hooks/use-token-usage";

const TOKEN_RANGES: { value: TokenUsageRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function TokenUsageStrip() {
  const [range, setRange] = useState<TokenUsageRange>("7d");
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
            <div className="text-[10px] text-muted-foreground">{usage?.calls ?? 0} model calls</div>
          </div>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-5">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0 border-l border-border/60 pl-3">
              <div className="truncate text-[10px] text-muted-foreground" title={metric.label}>{metric.label}</div>
              <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums" title={String(metric.raw)}>
                {metric.display}
              </div>
              {metric.detail && <div className="text-[10px] text-muted-foreground">{metric.detail}</div>}
            </div>
          ))}
        </div>
        <div className="flex h-8 items-center border border-border/70 bg-background/40 p-0.5" role="group" aria-label="Token usage period">
          {TOKEN_RANGES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRange(option.value)}
              className={cn(
                "h-7 min-w-10 px-2 text-[11px] font-medium transition-colors",
                range === option.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Phase icon helper ──

function PhaseIcon({ phase }: { phase?: string }) {
  switch (phase) {
    case "fix": return <Hammer className="h-3 w-3 text-orange-400" />;
    case "review": return <Eye className="h-3 w-3 text-amber-400" />;
    case "clarification": return <HelpCircle className="h-3 w-3 text-purple-400" />;
    default: return null;
  }
}

// ── Live ticker ──

const TICKER_ITEMS = [
  { label: "Pending", key: "pending" as const, color: "bg-zinc-500", glow: "" },
  { label: "Queued", key: "queued" as const, color: "bg-indigo-500", glow: "shadow-[0_0_6px_rgba(99,102,241,0.5)]" },
  { label: "Running", key: "running" as const, color: "bg-cyan-400", glow: "shadow-[0_0_6px_rgba(34,211,238,0.6)]" },
  { label: "Done", key: "done" as const, color: "bg-teal-400", glow: "shadow-[0_0_6px_rgba(45,212,191,0.5)]" },
  { label: "Failed", key: "failed" as const, color: "bg-rose-500", glow: "shadow-[0_0_6px_rgba(244,63,94,0.5)]" },
] satisfies { label: string; key: keyof PolpoStats; color: string; glow: string }[];

const LiveTicker = memo(function LiveTicker({ stats }: { stats: PolpoStats | null }) {
  if (!stats) return null;
  const total = stats.pending + stats.running + stats.done + stats.failed;

  return (
    <div className="flex items-center gap-4">
      {TICKER_ITEMS.map((item) => {
        const value = stats[item.key];
        return (
          <div key={item.label} className="flex items-center gap-1.5">
            <div className={cn(
              "h-2 w-2 rounded-full",
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
        <div className="text-[10px] text-muted-foreground ml-2 font-mono">
          Total: {total}
        </div>
      )}
    </div>
  );
});

// ── Stat card ──

const ACCENT_BAR_COLORS: Record<string, string> = {
  "text-blue-500": "bg-blue-500/60",
  "text-emerald-500": "bg-teal-400/60",
  "text-red-500": "bg-rose-500/60",
  "text-cyan-400": "bg-cyan-400/60",
  "text-muted-foreground": "bg-primary/30",
};

const StatCard = memo(function StatCard({
  title,
  value,
  icon: Icon,
  description,
  color,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  description?: string;
  color?: string;
}) {
  const accentBar = ACCENT_BAR_COLORS[color ?? "text-muted-foreground"] ?? "bg-primary/30";

  return (
    <Card className="relative overflow-hidden bg-card/80 backdrop-blur-sm border-border/50 transition-shadow hover:shadow-[0_0_20px_rgba(34,211,238,0.06)]">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className={cn("h-4 w-4", color ?? "text-muted-foreground")} />
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
      {/* Accent bar */}
      <div className={cn("absolute bottom-0 left-0 right-0 h-[2px]", accentBar)} />
    </Card>
  );
});

// ── Task progress donut chart ──

const progressChartConfig = {
  done: { label: "Done", color: "#2dd4bf" },
  failed: { label: "Failed", color: "#f43f5e" },
  running: { label: "Running", color: "#5eead4" },
  queued: { label: "Queued", color: "#6366f1" },
} satisfies ChartConfig;

const STATUS_COLORS = {
  done: "#2dd4bf",
  failed: "#f43f5e",
  running: "#5eead4",
  queued: "#6366f1",
};

const TaskProgress = memo(function TaskProgress({ tasks }: { tasks: Task[] }) {
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
    chartData.push({ status: "queued", count: 1, fill: "oklch(0.45 0.03 250)" });
  }

  return (
    <Card className="lg:col-span-7 bg-card/80 backdrop-blur-sm border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Task Progress</CardTitle>
            <CardDescription>{counts.done} of {total} completed</CardDescription>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-muted-foreground">
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
                stroke="hsl(var(--background))"
              >
                {chartData.map((entry) => (
                  <Cell key={entry.status} fill={entry.fill} />
                ))}
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                      return isEmpty ? (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 3} className="fill-muted-foreground text-[11px] font-medium">
                            No tasks
                          </tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 10} className="fill-muted-foreground/60 text-[9px]">
                            yet
                          </tspan>
                        </text>
                      ) : (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 5} className="fill-foreground text-xl font-bold">
                            {completionRate}%
                          </tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 10} className="fill-muted-foreground text-[9px]">
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
              ["Done", counts.done, STATUS_COLORS.done, "text-teal-400"],
              ["Failed", counts.failed, STATUS_COLORS.failed, "text-rose-500"],
              ["Running", counts.running, STATUS_COLORS.running, "text-cyan-400"],
              ["Queued", counts.queued, STATUS_COLORS.queued, "text-indigo-400"],
            ] as const).map(([label, count, dotColor, textColor]) => (
              <div key={label} className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: dotColor }} />
                <div>
                  <p className={cn("text-base font-semibold leading-none tabular-nums", count > 0 ? textColor : "text-muted-foreground")}>
                    {count}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Vital signs strip ── */}
        <VitalSignsStrip tasks={tasks} />
      </CardContent>
    </Card>
  );
});

// ── Vital signs strip — sits under the donut. Three small metrics:
//    24h throughput sparkline · avg quality score · first-pass success.
//    All deltas compare last-7d to the previous 7d window.

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

function DeltaBadge({ value, suffix = "", precision = 0 }: { value: number | null; suffix?: string; precision?: number }) {
  if (value == null) return null;
  const v = Number(value.toFixed(precision));
  if (v === 0) return <span className="text-[10px] text-muted-foreground/60">·</span>;
  const positive = v > 0;
  return (
    <span className={cn("text-[10px] font-medium tabular-nums", positive ? "text-emerald-500" : "text-rose-500")}>
      {positive ? "↑" : "↓"}{Math.abs(v).toFixed(precision)}{suffix}
    </span>
  );
}

const VitalSignsStrip = memo(function VitalSignsStrip({ tasks }: { tasks: Task[] }) {
  const stats = useMemo(() => {
    const now = Date.now();
    const HOUR = 3_600_000;
    const DAY = 86_400_000;

    // Throughput: 24 hourly slots, oldest first
    const buckets = Array<number>(24).fill(0);
    let last24Done = 0;
    let prior7Done = 0;
    // Duration buckets — last 7 days vs prior 7 days, in milliseconds
    const recentDurations: number[] = [];
    const priorDurations: number[] = [];

    for (const t of tasks) {
      const ts = new Date(t.updatedAt).getTime();
      const ago = now - ts;
      if (ago < 0) continue;

      if (t.status === "done") {
        if (ago < 24 * HOUR) {
          buckets[23 - Math.floor(ago / HOUR)]++;
          last24Done++;
        } else if (ago < 8 * DAY) {
          prior7Done++;
        }
        // Duration only for done tasks
        const created = new Date(t.createdAt).getTime();
        const dur = ts - created;
        if (dur > 0 && dur < 24 * HOUR) {
          if (ago < 7 * DAY) recentDurations.push(dur);
          else if (ago < 14 * DAY) priorDurations.push(dur);
        }
      }
    }
    const priorDailyAvg = prior7Done / 7;
    const throughputDelta = priorDailyAvg > 0
      ? ((last24Done - priorDailyAvg) / priorDailyAvg) * 100
      : null;

    // Median is more robust than mean for duration — outliers (a build that
    // got stuck for hours) shouldn't dominate.
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };
    const recentDuration = median(recentDurations);
    const priorDuration = median(priorDurations);
    // For duration, "down is good" so we invert the sign for display.
    const durationDelta = recentDuration != null && priorDuration != null
      ? ((recentDuration - priorDuration) / priorDuration) * 100
      : null;

    // Quality: last 7d vs prior 7d
    const recentScores: number[] = [];
    const priorScores: number[] = [];
    for (const t of tasks) {
      const score = t.result?.assessment?.globalScore;
      if (score == null) continue;
      const ago = now - new Date(t.updatedAt).getTime();
      if (ago < 0) continue;
      if (ago < 7 * DAY) recentScores.push(score);
      else if (ago < 14 * DAY) priorScores.push(score);
    }
    const recentAvg = recentScores.length > 0
      ? recentScores.reduce((s, n) => s + n, 0) / recentScores.length
      : null;
    const priorAvg = priorScores.length > 0
      ? priorScores.reduce((s, n) => s + n, 0) / priorScores.length
      : null;
    const qualityDelta = recentAvg != null && priorAvg != null ? recentAvg - priorAvg : null;

    // First-pass: %(done with retries=0) over (done + failed), 7d window
    let recentDoneOrFailed = 0, recentFirstPass = 0;
    let priorDoneOrFailed = 0,  priorFirstPass = 0;
    for (const t of tasks) {
      if (t.status !== "done" && t.status !== "failed") continue;
      const ago = now - new Date(t.updatedAt).getTime();
      if (ago < 0) continue;
      const isFirstPass = t.status === "done" && (t.retries ?? 0) === 0;
      if (ago < 7 * DAY) {
        recentDoneOrFailed++;
        if (isFirstPass) recentFirstPass++;
      } else if (ago < 14 * DAY) {
        priorDoneOrFailed++;
        if (isFirstPass) priorFirstPass++;
      }
    }
    const firstPassRecent = recentDoneOrFailed > 0
      ? (recentFirstPass / recentDoneOrFailed) * 100
      : null;
    const firstPassPrior = priorDoneOrFailed > 0
      ? (priorFirstPass / priorDoneOrFailed) * 100
      : null;
    const firstPassDelta = firstPassRecent != null && firstPassPrior != null
      ? firstPassRecent - firstPassPrior
      : null;

    return {
      buckets,
      last24Done,
      throughputDelta,
      recentAvg,
      qualityDelta,
      firstPassRecent,
      firstPassDelta,
      recentDuration,
      durationDelta,
    };
  }, [tasks]);

  return (
    <div className="mt-6 pt-5 border-t border-border/40 flex flex-col gap-6">
      {/* Block 1 — full-width 24h throughput sparkline (the visual hero) */}
      <div className="min-w-0 flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[9.5px] text-muted-foreground/80 uppercase tracking-wider font-medium leading-none">
            24h Throughput
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-semibold tabular-nums leading-none">{stats.last24Done}</span>
            <span className="text-[10px] text-muted-foreground/70 leading-none">tasks</span>
            <DeltaBadge value={stats.throughputDelta} suffix="%" />
          </div>
        </div>
        <Sparkline data={stats.buckets} height={36} />
        <span className="text-[10px] text-muted-foreground/55 leading-none">
          vs prior 7-day daily avg
        </span>
      </div>

      {/* Block 2 — three numeric KPIs in a row */}
      <div className="grid grid-cols-3 gap-x-6">
        <Metric label="Avg Quality" caption="last 7 days">
          {stats.recentAvg != null ? (
            <MetricBigValue
              value={stats.recentAvg.toFixed(1)}
              unit={
                <span className="flex items-center gap-1">
                  / 5 <Star className="h-3 w-3 text-amber-400" fill="currentColor" />
                </span>
              }
              delta={<DeltaBadge value={stats.qualityDelta} precision={1} />}
            />
          ) : (
            <MetricEmpty text="No assessments yet" />
          )}
        </Metric>

        <Metric label="First-Pass" caption="no retries · last 7 days">
          {stats.firstPassRecent != null ? (
            <MetricBigValue
              value={Math.round(stats.firstPassRecent).toString()}
              unit="%"
              delta={<DeltaBadge value={stats.firstPassDelta} suffix="pp" />}
            />
          ) : (
            <MetricEmpty text="No completed yet" />
          )}
        </Metric>

        <Metric label="Median Duration" caption="time to complete · last 7 days">
          {stats.recentDuration != null ? (
            <MetricBigValue
              value={formatShortDuration(stats.recentDuration)}
              unit=""
              // Faster is better → invert sign so "↓" shows green
              delta={
                <DeltaBadge
                  value={stats.durationDelta != null ? -stats.durationDelta : null}
                  suffix="%"
                />
              }
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
      <span className="text-[9.5px] text-muted-foreground/80 uppercase tracking-wider font-medium leading-none">
        {label}
      </span>
      <div className="flex-1 flex flex-col justify-center min-h-[40px]">
        {children}
      </div>
      {caption && (
        <span className="text-[10px] text-muted-foreground/55 leading-none">
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
      <span className="text-2xl font-bold tabular-nums leading-none">{value}</span>
      {unit && <span className="text-[10px] text-muted-foreground/70 leading-none">{unit}</span>}
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
      <Card className="bg-card/80 backdrop-blur-sm border-border/50">
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
    <Card className={cn("bg-card/80 backdrop-blur-sm border-border/50", processes.length > 0 && "glow-cyan")}>
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
            <div key={`${p.agentName}-${p.taskId}`} className="rounded-lg border border-border/40 bg-card/60 backdrop-blur-sm p-3">
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{p.agentName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px]">
                    {activity?.toolCalls ?? 0} calls
                  </Badge>
                  {activity?.filesCreated && activity.filesCreated.length > 0 && (
                    <Badge variant="outline" className="text-[10px]">
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
    <Card className="lg:col-span-5 bg-card/80 backdrop-blur-sm border-border/50">
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
              const cfg = {
                done: { icon: CheckCircle2, color: "text-teal-400" },
                failed: { icon: AlertTriangle, color: "text-rose-500" },
                in_progress: { icon: Loader2, color: "text-cyan-400" },
                review: { icon: Eye, color: "text-amber-500" },
                pending: { icon: Clock, color: "text-zinc-400" },
                awaiting_approval: { icon: Clock, color: "text-amber-400" },
                assigned: { icon: Clock, color: "text-violet-400" },
                draft: { icon: FileEdit, color: "text-zinc-500" },
              }[task.status] ?? { icon: Clock, color: "text-muted-foreground" };

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
                    <p className="text-[10px] text-muted-foreground">
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
                              "text-[10px] cursor-help",
                              task.result.assessment.passed
                                ? "bg-teal-500/20 text-teal-300 border-teal-500/30 hover:bg-teal-500/30"
                                : "bg-rose-500/20 text-rose-300 border-rose-500/30 hover:bg-rose-500/30",
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
                      <span className="text-[10px] text-muted-foreground">
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
  const statsRaw = useStats();
  const stats = (statsRaw as any)?.stats ?? statsRaw ?? null;

  // Single-pass count reduction instead of 3 separate .filter() calls
  const { activeMissions, doneCount, failedCount } = useMemo(() => {
    let active = 0, done = 0, failed = 0;
    for (const p of missions) if (p.status === "active") active++;
    for (const t of tasks) {
      if (t.status === "done") done++;
      else if (t.status === "failed") failed++;
    }
    return { activeMissions: active, doneCount: done, failedCount: failed };
  }, [missions, tasks]);

  if (tasksLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6 flex-1 min-h-0 overflow-auto pb-bottom-nav lg:pb-0">
      {/* Live ticker */}
      <LiveTicker stats={stats} />

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 lg:gap-4">
        <StatCard
          title="Total Tasks"
          value={tasks.length}
          icon={ListChecks}
          description={`${doneCount} completed, ${failedCount} failed`}
        />
        <StatCard
          title="Active Missions"
          value={activeMissions}
          icon={Target}
          description={`${missions.length} total`}
          color={activeMissions > 0 ? "text-blue-500" : undefined}
        />
        <StatCard
          title="Agents Online"
          value={processes.length}
          icon={Bot}
          description={`${agents.length} configured`}
          color={processes.length > 0 ? "text-emerald-500" : undefined}
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
          color={(() => {
            if (doneCount + failedCount === 0) return undefined;
            const rate = Math.round((doneCount / (doneCount + failedCount)) * 100);
            if (rate >= 90) return "text-emerald-500";
            if (rate >= 70) return "text-amber-500";
            return "text-red-500";
          })()}
        />
      </div>

      <TokenUsageStrip />

      {/* Main content — TaskProgress + Recent Activity in the top row,
          Active Agents below at full width so a busy team doesn't get
          squashed into 1/3 of the viewport.
          12-col grid lets us narrow TaskProgress a touch (7/12 ≈ 58%) so
          Recent Activity gets a more comfortable column. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <TaskProgress tasks={tasks} />
        <RecentTasks tasks={tasks} />
      </div>

      <ActiveAgents processes={processes} />
    </div>
  );
}
