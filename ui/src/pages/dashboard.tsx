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
  Map,
  Activity,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  ArrowRight,
  Zap,
  MessageSquare,
  Star,
  Eye,
  Hammer,
  HelpCircle,
  FileText,
  Brain,
} from "lucide-react";
import { useTasks, usePlans, useProcesses, useAgents, useStats } from "@openpolpo/react-sdk";
import type { Task, AgentProcess, PolpoStats } from "@openpolpo/react-sdk";
import { cn } from "@/lib/utils";

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

function LiveTicker({ stats }: { stats: PolpoStats | null }) {
  if (!stats) return null;
  const items = [
    { label: "Pending", value: stats.pending, color: "bg-zinc-500" },
    { label: "Queued", value: stats.queued, color: "bg-violet-500" },
    { label: "Running", value: stats.running, color: "bg-blue-500" },
    { label: "Done", value: stats.done, color: "bg-emerald-500" },
    { label: "Failed", value: stats.failed, color: "bg-red-500" },
  ];
  const total = stats.pending + stats.running + stats.done + stats.failed;

  return (
    <div className="flex items-center gap-4">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <div className={cn("h-2 w-2 rounded-full", item.color, item.value > 0 && item.label === "Running" && "animate-pulse")} />
          <span className="text-xs text-muted-foreground">{item.label}</span>
          <span className="text-xs font-bold">{item.value}</span>
        </div>
      ))}
      {total > 0 && (
        <div className="text-[10px] text-muted-foreground ml-2">
          Total: {total}
        </div>
      )}
    </div>
  );
}

// ── Stat card ──

function StatCard({
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
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className={cn("h-4 w-4", color ?? "text-muted-foreground")} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </CardContent>
    </Card>
  );
}

// ── Task progress donut chart ──

const progressChartConfig = {
  done: { label: "Done", color: "hsl(var(--chart-2, 142 76% 36%))" },
  failed: { label: "Failed", color: "hsl(var(--chart-5, 0 84% 60%))" },
  running: { label: "Running", color: "hsl(var(--chart-1, 221 83% 53%))" },
  queued: { label: "Queued", color: "hsl(var(--chart-4, 240 5% 64%))" },
} satisfies ChartConfig;

const STATUS_COLORS = {
  done: "#22c55e",
  failed: "#ef4444",
  running: "#3b82f6",
  queued: "#71717a",
};

function TaskProgress({ tasks }: { tasks: Task[] }) {
  const total = tasks.length;
  const counts = {
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    running: tasks.filter((t) => t.status === "in_progress" || t.status === "review").length,
    queued: tasks.filter((t) => t.status === "pending" || t.status === "assigned").length,
  };
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

  // If no tasks, show empty state
  if (total === 0) {
    chartData.push({ status: "queued", count: 1, fill: "hsl(var(--muted))" });
  }

  return (
    <Card className="col-span-2">
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
        <div className="flex items-center gap-6">
          {/* Donut chart */}
          <ChartContainer config={progressChartConfig} className="h-[140px] w-[140px] shrink-0">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie
                data={chartData}
                dataKey="count"
                nameKey="status"
                innerRadius={42}
                outerRadius={65}
                strokeWidth={2}
                stroke="hsl(var(--background))"
              >
                {chartData.map((entry) => (
                  <Cell key={entry.status} fill={entry.fill} />
                ))}
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                      return (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 6} className="fill-foreground text-2xl font-bold">
                            {completionRate}%
                          </tspan>
                          <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 12} className="fill-muted-foreground text-[10px]">
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
          <div className="flex-1 grid grid-cols-2 gap-3">
            {([
              ["Done", counts.done, STATUS_COLORS.done, "text-emerald-500"],
              ["Failed", counts.failed, STATUS_COLORS.failed, "text-red-500"],
              ["Running", counts.running, STATUS_COLORS.running, "text-blue-500"],
              ["Queued", counts.queued, STATUS_COLORS.queued, "text-zinc-400"],
            ] as const).map(([label, count, dotColor, textColor]) => (
              <div key={label} className="flex items-center gap-2.5">
                <div className="h-3 w-3 rounded-sm shrink-0" style={{ backgroundColor: dotColor }} />
                <div>
                  <p className={cn("text-lg font-semibold leading-none", count > 0 ? textColor : "text-muted-foreground")}>
                    {count}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Active agents with narrative ──

function ActiveAgents({ processes }: { processes: AgentProcess[] }) {
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
    <Card>
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
            <div key={`${p.agentName}-${p.taskId}`} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10">
                  <Bot className="h-4 w-4 text-blue-500" />
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
}

// ── Recent tasks with richer info ──

function RecentTasks({ tasks }: { tasks: Task[] }) {
  const recent = [...tasks]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8);

  return (
    <Card className="col-span-2">
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
            <p className="text-xs">Tasks will appear when a plan is executed</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {recent.map((task) => {
              const cfg = {
                done: { icon: CheckCircle2, color: "text-emerald-500" },
                failed: { icon: AlertTriangle, color: "text-red-500" },
                in_progress: { icon: Loader2, color: "text-blue-500" },
                review: { icon: Eye, color: "text-amber-500" },
                pending: { icon: Clock, color: "text-zinc-400" },
                assigned: { icon: Clock, color: "text-violet-400" },
              }[task.status] ?? { icon: Clock, color: "text-muted-foreground" };

              return (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted/50"
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
                            className="text-[10px] cursor-help"
                          >
                            <Star className="h-2.5 w-2.5 mr-0.5" />
                            {Math.round(task.result.assessment.globalScore * 100)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          Assessment score: {Math.round(task.result.assessment.globalScore * 100)}%
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
}

// ── Main ──

export function DashboardPage() {
  const { tasks, isLoading: tasksLoading } = useTasks();
  const { plans } = usePlans();
  const { processes } = useProcesses();
  const { agents } = useAgents();
  const stats = useStats();

  const activePlans = plans.filter((p) => p.status === "active").length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;

  if (tasksLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 flex-1 min-h-0 overflow-auto">
      {/* Live ticker */}
      <LiveTicker stats={stats} />

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          title="Total Tasks"
          value={tasks.length}
          icon={ListChecks}
          description={`${doneCount} completed, ${failedCount} failed`}
        />
        <StatCard
          title="Active Plans"
          value={activePlans}
          icon={Map}
          description={`${plans.length} total`}
          color={activePlans > 0 ? "text-blue-500" : undefined}
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
          color={failedCount === 0 && doneCount > 0 ? "text-emerald-500" : failedCount > 0 ? "text-red-500" : undefined}
        />
      </div>

      {/* Main content */}
      <div className="grid grid-cols-3 gap-4">
        <TaskProgress tasks={tasks} />
        <ActiveAgents processes={processes} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <RecentTasks tasks={tasks} />
        {/* Quick navigation — monitoring only, no CRUD */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Quick Navigation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link to="/tasks" className="block">
              <Button variant="outline" className="w-full justify-start gap-2">
                <ListChecks className="h-4 w-4" /> Inspect Tasks
              </Button>
            </Link>
            <Link to="/chat" className="block">
              <Button variant="outline" className="w-full justify-start gap-2">
                <MessageSquare className="h-4 w-4" /> Chat with Polpo
              </Button>
            </Link>
            <Link to="/activity" className="block">
              <Button variant="outline" className="w-full justify-start gap-2">
                <Activity className="h-4 w-4" /> Event Stream
              </Button>
            </Link>
            <Link to="/logs" className="block">
              <Button variant="outline" className="w-full justify-start gap-2">
                <FileText className="h-4 w-4" /> Session Logs
              </Button>
            </Link>
            <Link to="/memory" className="block">
              <Button variant="outline" className="w-full justify-start gap-2">
                <Brain className="h-4 w-4" /> Project Memory
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
