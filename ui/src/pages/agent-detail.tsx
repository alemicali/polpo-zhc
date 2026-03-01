import { useParams, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bot,
  Loader2,

  Wrench,
  ArrowLeft,
  RefreshCw,
  Zap,
  FileCode,
  FilePlus,
  FileEdit,
  Activity,
  Sparkles,
  Hash,
  Shield,
  CheckCircle2,
  XCircle,
  Layers,

  FolderOpen,
  Terminal,
  Globe,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
  Clock,
  Star,
  AlertTriangle,
  Building2,
  Mail,
  MapPin,
  Heart,
  MessageSquare,
  ListChecks,
  KeyRound,
  ArrowUpRight,
  Brain,
  Cake,
  Users,
  Search,
  GitBranch,
  Package,
  Table2,
  FileText,
  Mic,
  Image,
  Palette,
  Plug,
  Wand2,
  Upload,
  Target,
  type LucideIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAgent, useAgents, useProcesses, useSkills, useTasks, useVaultEntries } from "@lumea-labs/polpo-react";
import type { AgentProcess, AgentConfig, SkillInfo, Task, TaskStatus, VaultEntryMeta } from "@lumea-labs/polpo-react";
import { formatDistanceToNow } from "date-fns";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";

// ── Tool & skill icon mapping ──

type ToolMeta = { icon: LucideIcon; color: string; bg: string };

function getToolMeta(name: string): ToolMeta {
  const n = name.toLowerCase();
  // Core file ops
  if (n === "read") return { icon: FileCode, color: "text-teal-400", bg: "bg-teal-500/10" };
  if (n === "write") return { icon: FilePlus, color: "text-emerald-400", bg: "bg-emerald-500/10" };
  if (n === "edit" || n === "multi_edit") return { icon: FileEdit, color: "text-sky-400", bg: "bg-sky-500/10" };
  // Terminal
  if (n === "bash" || n === "ls") return { icon: Terminal, color: "text-amber-400", bg: "bg-amber-500/10" };
  // Search
  if (n === "glob" || n === "grep" || n === "regex_replace") return { icon: Search, color: "text-blue-400", bg: "bg-blue-500/10" };
  // Browser
  if (n.startsWith("browser_")) return { icon: Globe, color: "text-indigo-400", bg: "bg-indigo-500/10" };
  // HTTP
  if (n.startsWith("http_")) return { icon: ArrowUpRight, color: "text-cyan-400", bg: "bg-cyan-500/10" };
  // Git
  if (n.startsWith("git_")) return { icon: GitBranch, color: "text-green-400", bg: "bg-green-500/10" };
  // Excel
  if (n.startsWith("excel_")) return { icon: Table2, color: "text-green-400", bg: "bg-green-500/10" };
  // PDF
  if (n.startsWith("pdf_")) return { icon: FileText, color: "text-red-400", bg: "bg-red-500/10" };
  // Docx
  if (n.startsWith("docx_")) return { icon: FileText, color: "text-blue-400", bg: "bg-blue-500/10" };
  // Email
  if (n.startsWith("email_")) return { icon: Mail, color: "text-rose-400", bg: "bg-rose-500/10" };
  // Audio
  if (n.startsWith("audio_")) return { icon: Mic, color: "text-pink-400", bg: "bg-pink-500/10" };
  // Image
  if (n.startsWith("image_")) return { icon: Image, color: "text-emerald-400", bg: "bg-emerald-500/10" };
  // Dependencies
  if (n.startsWith("dep_") || n === "bulk_rename") return { icon: Package, color: "text-amber-400", bg: "bg-amber-500/10" };
  // Outcome
  if (n === "register_outcome") return { icon: Target, color: "text-teal-400", bg: "bg-teal-500/10" };
  // Fallback
  return { icon: Wrench, color: "text-muted-foreground", bg: "bg-muted/30" };
}

function getSkillMeta(name: string): { icon: LucideIcon; color: string } {
  const n = name.toLowerCase();
  if (n.includes("git") || n.includes("commit") || n.includes("feature-dev")) return { icon: GitBranch, color: "text-green-400" };
  if (n.includes("browser")) return { icon: Globe, color: "text-indigo-400" };
  if (n.includes("test")) return { icon: CheckCircle2, color: "text-teal-400" };
  if (n.includes("deploy") || n.includes("vercel") || n.includes("ship")) return { icon: Upload, color: "text-blue-400" };
  if (n.includes("design") || n.includes("frontend") || n.includes("ui") || n.includes("web-design")) return { icon: Palette, color: "text-pink-400" };
  if (n.includes("email")) return { icon: Mail, color: "text-rose-400" };
  if (n.includes("mcp")) return { icon: Plug, color: "text-cyan-400" };
  if (n.includes("linear")) return { icon: ListChecks, color: "text-purple-400" };
  if (n.includes("docker") || n.includes("runner")) return { icon: Package, color: "text-orange-400" };
  if (n.includes("skill") || n.includes("find")) return { icon: Wand2, color: "text-amber-400" };
  if (n.includes("llm") || n.includes("model") || n.includes("litellm")) return { icon: Brain, color: "text-violet-400" };
  if (n.includes("key") || n.includes("binding")) return { icon: KeyRound, color: "text-zinc-400" };
  if (n.includes("review") || n.includes("audit") || n.includes("best-practice")) return { icon: Eye, color: "text-sky-400" };
  if (n.includes("propagat") || n.includes("sync") || n.includes("change")) return { icon: RefreshCw, color: "text-yellow-400" };
  if (n.includes("remotion") || n.includes("video")) return { icon: Image, color: "text-red-400" };
  if (n.includes("composition") || n.includes("pattern")) return { icon: Layers, color: "text-orange-400" };
  return { icon: Sparkles, color: "text-violet-400" };
}

// ── Tool category detection from allowedTools ──

const toolCategories: { prefix: string; label: string; tools: string }[] = [
  { prefix: "browser_", label: "Browser", tools: "browser_navigate, browser_click, browser_fill, browser_snapshot, browser_screenshot, ..." },
  { prefix: "email_", label: "Email", tools: "email_send, email_verify, email_list, email_read, email_search" },
];

const taskStatusConfig: Record<TaskStatus, { color: string; icon: React.ElementType; label: string }> = {
  draft: { color: "text-zinc-500", icon: Clock, label: "Draft" },
  pending: { color: "text-zinc-400", icon: Clock, label: "Queued" },
  awaiting_approval: { color: "text-amber-400", icon: Clock, label: "Approval" },
  assigned: { color: "text-violet-400", icon: Clock, label: "Assigned" },
  in_progress: { color: "text-blue-400", icon: Loader2, label: "Running" },
  review: { color: "text-amber-400", icon: Eye, label: "Review" },
  done: { color: "text-emerald-400", icon: CheckCircle2, label: "Done" },
  failed: { color: "text-red-400", icon: AlertTriangle, label: "Failed" },
};

const responsibilityPriorityColors: Record<string, string> = {
  critical: "text-red-400 border-red-500/30",
  high: "text-amber-400 border-amber-500/30",
  medium: "text-blue-400 border-blue-500/30",
  low: "text-zinc-400 border-zinc-500/30",
};


/** Format agent age as a human-friendly string, e.g. "3 months" / "12 days" / "1 year, 2 months" */
function formatAgentAge(isoDate: string): string {
  const created = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "born today";
  if (days === 1) return "1 day old";
  if (days < 30) return `${days} days old`;
  const months = Math.floor(days / 30);
  const remainDays = days % 30;
  if (months < 12) {
    if (remainDays === 0) return `${months} month${months > 1 ? "s" : ""} old`;
    return `${months}m ${remainDays}d old`;
  }
  const years = Math.floor(months / 12);
  const remainMonths = months % 12;
  if (remainMonths === 0) return `${years} year${years > 1 ? "s" : ""} old`;
  return `${years}y ${remainMonths}m old`;
}

const reasoningMeta: Record<string, { label: string; color: string }> = {
  off: { label: "Off", color: "text-zinc-500" },
  minimal: { label: "Minimal", color: "text-zinc-400" },
  low: { label: "Low", color: "text-blue-400" },
  medium: { label: "Medium", color: "text-violet-400" },
  high: { label: "High", color: "text-amber-400" },
  xhigh: { label: "X-High", color: "text-red-400" },
};

// ── Section header ──

function SectionHeader({ title, icon: Icon, count, className }: {
  title: string;
  icon: React.ElementType;
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 mb-3", className)}>
      <Icon className="h-3.5 w-3.5 text-primary" />
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>
      {count != null && count > 0 && (
        <Badge variant="secondary" className="text-[9px] ml-1">{count}</Badge>
      )}
    </div>
  );
}

// ── Activity heatmap (GitHub-style contribution graph) ──

const HEATMAP_WEEKS = 20;
const DAY_NAMES = ["", "Mon", "", "Wed", "", "Fri", ""];

function ActivityHeatmap({ tasks }: { tasks: Task[] }) {
  const { grid, maxCount, totalActive, streakDays } = useMemo(() => {
    // Build day → task list index covering last N weeks up to today
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Start from the most recent Sunday, then go back HEATMAP_WEEKS weeks
    const dayOfWeek = today.getDay(); // 0 = Sunday
    const endSunday = new Date(today);
    endSunday.setDate(today.getDate() - dayOfWeek + 6); // end of this week (Saturday)
    const startDate = new Date(endSunday);
    startDate.setDate(endSunday.getDate() - (HEATMAP_WEEKS * 7 - 1));

    const dayMap = new Map<string, { count: number; done: number; failed: number; scores: number[] }>();

    for (const t of tasks) {
      const d = new Date(t.updatedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const existing = dayMap.get(key) ?? { count: 0, done: 0, failed: 0, scores: [] };
      existing.count++;
      if (t.status === "done") existing.done++;
      if (t.status === "failed") existing.failed++;
      if (t.result?.assessment?.globalScore != null) existing.scores.push(t.result.assessment.globalScore);
      dayMap.set(key, existing);
    }

    // Build weeks × 7 grid
    const weeks: { date: Date; key: string; data: { count: number; done: number; failed: number; scores: number[] } | null }[][] = [];
    let max = 0;
    let cursor = new Date(startDate);
    let currentWeek: typeof weeks[number] = [];

    // Pad the first week if startDate isn't a Sunday
    const startDay = cursor.getDay();
    if (startDay !== 0) {
      for (let i = 0; i < startDay; i++) {
        currentWeek.push({ date: new Date(0), key: "", data: null });
      }
    }

    const totalDays = HEATMAP_WEEKS * 7;
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(cursor);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const data = dayMap.get(key) ?? { count: 0, done: 0, failed: 0, scores: [] };
      if (data.count > max) max = data.count;
      const isFuture = d > now;
      currentWeek.push({ date: d, key, data: isFuture ? null : data });
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    // Compute streak (consecutive days with activity, ending today or yesterday)
    let streak = 0;
    const checkDate = new Date(today);
    for (let i = 0; i < 365; i++) {
      const k = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, "0")}-${String(checkDate.getDate()).padStart(2, "0")}`;
      const d = dayMap.get(k);
      if (d && d.count > 0) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (i === 0) {
        // Today might have no activity yet, check yesterday
        checkDate.setDate(checkDate.getDate() - 1);
        continue;
      } else {
        break;
      }
    }

    const total = tasks.filter(t => t.status !== "draft" && t.status !== "pending").length;

    return { grid: weeks, maxCount: max, totalActive: total, streakDays: streak };
  }, [tasks]);

  if (tasks.length === 0) return null;

  const getCellColor = (data: { count: number; done: number; failed: number; scores: number[] } | null) => {
    if (!data) return "bg-muted/20";
    if (data.count === 0) return "bg-muted/30";
    // Color by intensity: ratio of count to max
    const ratio = maxCount > 0 ? data.count / maxCount : 0;
    // Use emerald tones for success-heavy, red for failure-heavy
    const failRatio = data.count > 0 ? data.failed / data.count : 0;
    if (failRatio > 0.5) {
      if (ratio > 0.7) return "bg-red-500";
      if (ratio > 0.4) return "bg-red-500/70";
      return "bg-red-500/40";
    }
    if (ratio > 0.75) return "bg-emerald-400";
    if (ratio > 0.5) return "bg-emerald-400/70";
    if (ratio > 0.25) return "bg-emerald-400/50";
    return "bg-emerald-400/30";
  };

  const formatDate = (d: Date) =>
    d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="space-y-2">
      {/* Stats row */}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{totalActive} tasks</span>
        <span>in the last {HEATMAP_WEEKS} weeks</span>
        {streakDays > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <Zap className="h-3 w-3 text-amber-400" />
            <span className="font-medium text-foreground">{streakDays}d</span> streak
          </span>
        )}
      </div>

      {/* Heatmap grid */}
      <div className="flex gap-[3px]">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] pr-1.5 pt-0">
          {DAY_NAMES.map((name, i) => (
            <div key={i} className="h-[11px] flex items-center">
              <span className="text-[9px] text-muted-foreground/60 leading-none w-5">{name}</span>
            </div>
          ))}
        </div>
        {/* Weeks */}
        {grid.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((cell, di) => (
              <Tooltip key={cell.key || `empty-${di}`}>
                <TooltipTrigger asChild>
                  <div className={cn(
                    "h-[11px] w-[11px] rounded-[2px] transition-colors",
                    getCellColor(cell.data),
                    cell.data && cell.data.count > 0 && "hover:ring-1 hover:ring-primary/50"
                  )} />
                </TooltipTrigger>
                {cell.data && (
                  <TooltipContent className="text-[11px] space-y-0.5">
                    <p className="font-medium">{formatDate(cell.date)}</p>
                    {cell.data.count > 0 ? (
                      <>
                        <p>{cell.data.count} task{cell.data.count !== 1 ? "s" : ""}: {cell.data.done} done, {cell.data.failed} failed</p>
                        {cell.data.scores.length > 0 && (
                          <p className="text-muted-foreground">
                            avg score {Math.round((cell.data.scores.reduce((a, b) => a + b, 0) / cell.data.scores.length) * 100)}%
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-muted-foreground">No activity</p>
                    )}
                  </TooltipContent>
                )}
              </Tooltip>
            ))}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 justify-end">
        <span className="text-[9px] text-muted-foreground/60">Less</span>
        <div className="h-[9px] w-[9px] rounded-[2px] bg-muted/30" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400/30" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400/50" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400/70" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400" />
        <span className="text-[9px] text-muted-foreground/60">More</span>
      </div>
    </div>
  );
}

// ── Live Activity panel ──

function LiveActivity({ process }: { process: AgentProcess }) {
  const act = process.activity;
  const totalFiles = (act.filesCreated?.length ?? 0) + (act.filesEdited?.length ?? 0);

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("h-2.5 w-2.5 rounded-full", process.alive ? "bg-primary animate-pulse" : "bg-zinc-500")} />
          <span className="text-xs font-semibold text-primary uppercase tracking-wider">
            {process.alive ? "Active" : "Finished"}
          </span>
          <Badge variant="secondary" className="text-[10px]">PID {process.pid}</Badge>
          {act.sessionId && (
            <span className="text-[10px] font-mono text-muted-foreground">session:{act.sessionId.slice(0, 8)}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {act.lastUpdate && (
            <span>updated {formatDistanceToNow(new Date(act.lastUpdate), { addSuffix: true })}</span>
          )}
          <span>started {formatDistanceToNow(new Date(process.startedAt), { addSuffix: true })}</span>
        </div>
      </div>

      {/* Summary + task link */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground flex-1">
          {act.summary
            ? act.summary
            : act.lastTool && act.lastFile
            ? <>Using <code className="text-foreground font-mono text-xs">{act.lastTool}</code> on <code className="text-foreground font-mono text-xs">{act.lastFile}</code></>
            : act.lastTool
            ? <>Using <code className="text-foreground font-mono text-xs">{act.lastTool}</code></>
            : "Running..."}
        </p>
        <Link
          to={`/tasks/${process.taskId}`}
          className="shrink-0 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          View task <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Metrics */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Wrench className="h-3.5 w-3.5" />
          <span className="font-mono font-bold text-foreground">{act.toolCalls}</span> calls
        </div>
        {totalFiles > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode className="h-3.5 w-3.5" />
            <span className="font-mono font-bold text-foreground">{totalFiles}</span> files
          </div>
        )}
        {act.totalTokens != null && act.totalTokens > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Hash className="h-3.5 w-3.5" />
            <span className="font-mono font-bold text-foreground">{(act.totalTokens / 1000).toFixed(1)}k</span> tokens
          </div>
        )}
      </div>

      {/* File lists */}
      {act.filesCreated && act.filesCreated.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1.5">
            <FilePlus className="h-3 w-3 text-emerald-400" /> Created ({act.filesCreated.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesCreated.slice(0, 12).map((f) => (
              <Badge key={f} variant="secondary" className="text-[10px] font-mono max-w-[250px] truncate">{f}</Badge>
            ))}
            {act.filesCreated.length > 12 && (
              <Badge variant="secondary" className="text-[10px]">+{act.filesCreated.length - 12}</Badge>
            )}
          </div>
        </div>
      )}
      {act.filesEdited && act.filesEdited.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1.5">
            <FileEdit className="h-3 w-3 text-amber-400" /> Edited ({act.filesEdited.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesEdited.slice(0, 12).map((f) => (
              <Badge key={f} variant="outline" className="text-[10px] font-mono max-w-[250px] truncate">{f}</Badge>
            ))}
            {act.filesEdited.length > 12 && (
              <Badge variant="outline" className="text-[10px]">+{act.filesEdited.length - 12}</Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Task row ──

function TaskRow({ task }: { task: Task }) {
  const cfg = taskStatusConfig[task.status];
  const StatusIcon = cfg.icon;
  const score = task.result?.assessment?.globalScore;

  return (
    <Link
      to={`/tasks/${task.id}`}
      className="flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-accent/10 transition-colors group"
    >
      <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", cfg.color, task.status === "in_progress" && "animate-spin")} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{task.title}</p>
        <p className="text-[10px] text-muted-foreground truncate mt-0.5">
          {task.group && <span className="mr-2">{task.group}</span>}
          {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {score != null && (
          <Badge variant={score >= 0.7 ? "default" : "destructive"} className="text-[9px]">
            <Star className="h-2.5 w-2.5 mr-0.5" />
            {Math.round(score * 100)}%
          </Badge>
        )}
        <Badge variant="outline" className={cn("text-[9px]", cfg.color)}>{cfg.label}</Badge>
        {task.result?.duration != null && (
          <span className="text-[10px] text-muted-foreground">{Math.round(task.result.duration / 1000)}s</span>
        )}
      </div>
    </Link>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Main page ──
// ══════════════════════════════════════════════════════════════

export function AgentDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { agent, isLoading, error, refetch } = useAgent(name ?? "");
  const { agents } = useAgents();
  const { processes } = useProcesses();
  const { skills: allSkills } = useSkills();
  const { entries: vaultEntries } = useVaultEntries(name ?? "");
  const { tasks: agentTasks } = useTasks({ assignTo: name });
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  // Skill pool map
  const skillPool = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const s of allSkills) map.set(s.name, s);
    return map;
  }, [allSkills]);

  // Active process for this agent
  const process = processes.find((p: AgentProcess) => p.agentName === name);

  // Agents that report to this one (subordinates)
  const subordinates = useMemo(
    () => agents.filter((a: AgentConfig) => a.reportsTo === name),
    [agents, name],
  );

  // Manager agent (who this agent reports to)
  const manager = useMemo(
    () => agent?.reportsTo ? agents.find((a: AgentConfig) => a.name === agent.reportsTo) : null,
    [agents, agent],
  );

  // Task stats
  const taskStats = useMemo(() => {
    const done = agentTasks.filter((t: Task) => t.status === "done").length;
    const failed = agentTasks.filter((t: Task) => t.status === "failed").length;
    const active = agentTasks.filter((t: Task) => t.status === "in_progress" || t.status === "review" || t.status === "assigned").length;
    const pending = agentTasks.filter((t: Task) => t.status === "pending" || t.status === "awaiting_approval" || t.status === "draft").length;
    const total = agentTasks.length;
    const successRate = done + failed > 0 ? Math.round((done / (done + failed)) * 100) : null;
    const avgScore = agentTasks
      .filter((t: Task) => t.result?.assessment?.globalScore != null)
      .reduce((acc: { sum: number; count: number }, t: Task) => ({
        sum: acc.sum + (t.result!.assessment!.globalScore ?? 0),
        count: acc.count + 1,
      }), { sum: 0, count: 0 });
    return { done, failed, active, pending, total, successRate, avgScore: avgScore.count > 0 ? avgScore.sum / avgScore.count : null };
  }, [agentTasks]);

  // Sorted tasks: active first, then recent
  const sortedTasks = useMemo(() =>
    [...agentTasks].sort((a, b) => {
      const statusOrder: Record<string, number> = { in_progress: 0, review: 1, assigned: 2, pending: 3, awaiting_approval: 4, draft: 5, done: 6, failed: 7 };
      const oa = statusOrder[a.status] ?? 10;
      const ob = statusOrder[b.status] ?? 10;
      if (oa !== ob) return oa - ob;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }),
    [agentTasks],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 bg-card/60 rounded-lg p-8">
        <Bot className="h-16 w-16 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">
          {error ? `Error loading agent: ${error.message}` : "Agent not found"}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/agents"><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Agents</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={refetch}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  const identity = agent.identity;
  const agentAny = agent as unknown as Record<string, unknown>;
  const mcpEntries = agent.mcpServers ? Object.entries(agent.mcpServers) : [];
  const agentAllowedTools: string[] = (agentAny.allowedTools as string[] | undefined) ?? [];
  const enabledCategories = toolCategories.filter(c => agentAllowedTools.some(t => (t as string).toLowerCase().startsWith(c.prefix)));

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Breadcrumb ── */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
        <Link to="/agents" className="hover:text-foreground transition-colors">Agents</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-medium">{identity?.displayName ?? agent.name}</span>
      </div>

      {/* ── 2-column layout ── */}
      <div className="flex flex-1 min-h-0 gap-6">

        {/* ════════════ LEFT COLUMN: Identity + Activity ════════════ */}
        <div className="w-80 shrink-0 hidden lg:flex flex-col gap-4 overflow-auto pb-bottom-nav lg:pb-0 pr-1">

          {/* ── Hero card ── */}
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 overflow-hidden">
            {/* Gradient header bar */}
            <div className="h-16 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent" />
            <CardContent className="pt-0 -mt-8 pb-4 space-y-3">
              {/* Avatar + name */}
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-card border-2 border-background shadow-lg">
                  <AgentAvatar avatar={identity?.avatar} name={agent.name} size="xl" iconClassName="text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-lg font-bold tracking-tight leading-tight truncate">
                      {identity?.displayName ?? agent.name}
                    </h1>
                    {process && (
                      <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                    )}
                  </div>
                  {identity?.displayName && identity.displayName !== agent.name && (
                    <p className="text-[10px] font-mono text-muted-foreground">@{agent.name}</p>
                  )}
                </div>
              </div>

              {/* Badges row — only volatile/mission (contextual flags) */}
              {(agent.volatile || agent.missionGroup) && (
                <div className="flex flex-wrap gap-1.5">
                  {agent.volatile && (
                    <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                      <Zap className="h-2.5 w-2.5 mr-0.5" /> Volatile
                    </Badge>
                  )}
                  {agent.missionGroup && (
                    <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                      mission: {agent.missionGroup}
                    </Badge>
                  )}
                </div>
              )}

              {/* Identity — ALL fields, always visible */}
              <div className="divide-y divide-border/20 text-[11px]">
                <div className="flex items-center gap-2 py-1.5">
                  <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground/60 shrink-0">Title</span>
                  <span className={cn("ml-auto truncate", identity?.title ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.title || "not set"}</span>
                </div>
                <div className="flex items-center gap-2 py-1.5">
                  <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground/60 shrink-0">Company</span>
                  <span className={cn("ml-auto truncate", identity?.company ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.company || "not set"}</span>
                </div>
                <div className="flex items-center gap-2 py-1.5">
                  <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground/60 shrink-0">Email</span>
                  <span className={cn("ml-auto truncate font-mono", identity?.email ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.email || "not set"}</span>
                </div>
                <div className="flex items-center gap-2 py-1.5">
                  <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground/60 shrink-0">Timezone</span>
                  <span className={cn("ml-auto", identity?.timezone ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.timezone || "not set"}</span>
                </div>
                {identity?.socials && Object.keys(identity.socials).length > 0 && (
                  <div className="flex items-center gap-2 py-1.5">
                    <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground/60 shrink-0">Socials</span>
                    <div className="ml-auto flex flex-wrap gap-1.5 justify-end">
                      {Object.entries(identity.socials).map(([platform, handle]) => (
                        <Badge key={platform} variant="secondary" className="text-[9px] font-mono gap-1">
                          {platform}
                          <span className="text-muted-foreground">{handle}</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2 py-1.5">
                  <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground/60 shrink-0">Model</span>
                  <span className={cn("ml-auto truncate font-mono", agent.model ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{agent.model || "not set"}</span>
                </div>
                <div className="flex items-center gap-2 py-1.5">
                  <Brain className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground/60 shrink-0">Reasoning</span>
                  {agent.reasoning && agent.reasoning !== "off" ? (
                    <Badge variant="outline" className={cn("text-[9px] ml-auto", reasoningMeta[agent.reasoning]?.color)}>
                      {reasoningMeta[agent.reasoning]?.label ?? agent.reasoning}
                    </Badge>
                  ) : (
                    <span className="ml-auto text-muted-foreground/30 italic">off</span>
                  )}
                </div>
                {agent.createdAt && (
                  <div className="flex items-center gap-2 py-1.5">
                    <Cake className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground/60 shrink-0">Age</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-auto text-muted-foreground cursor-help">
                          {formatAgentAge(agent.createdAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">
                        Created {new Date(agent.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>

              {/* Refresh */}
              <div className="pt-1">
                <Button variant="outline" size="sm" className="w-full text-xs" onClick={refetch}>
                  <RefreshCw className="h-3 w-3 mr-1.5" /> Refresh
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ── Reporting hierarchy ── */}
          {(agent.reportsTo || subordinates.length > 0) && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
              <CardContent className="pt-4 pb-4 space-y-3">
                <SectionHeader title="Hierarchy" icon={Users} />

                {/* Manager */}
                {manager && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                      <ArrowUpRight className="h-2.5 w-2.5 inline mr-1" />
                      Manager
                    </p>
                    <Link
                      to={`/agents/${manager.name}`}
                      className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 hover:bg-accent/10 transition-colors"
                    >
                      <AgentAvatar avatar={manager.identity?.avatar} name={manager.name} size="sm" iconClassName="text-primary" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium">{manager.identity?.displayName ?? manager.name}</p>
                        {manager.identity?.title && (
                          <p className="text-[10px] text-muted-foreground truncate">{manager.identity.title}</p>
                        )}
                      </div>
                      <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
                    </Link>
                  </div>
                )}
                {agent.reportsTo && !manager && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                      <ArrowUpRight className="h-2.5 w-2.5 inline mr-1" />
                      Manager
                    </p>
                    <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                      <Bot className="h-4 w-4 shrink-0" />
                      <span className="font-mono">{agent.reportsTo}</span>
                    </div>
                  </div>
                )}

                {/* Direct reports */}
                {subordinates.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                      <Users className="h-2.5 w-2.5 inline mr-1" />
                      Direct reports ({subordinates.length})
                    </p>
                    <div className="space-y-1">
                      {subordinates.map((sub) => (
                        <Link
                          key={sub.name}
                          to={`/agents/${sub.name}`}
                          className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 hover:bg-accent/10 transition-colors"
                        >
                          <AgentAvatar avatar={sub.identity?.avatar} name={sub.name} size="sm" iconClassName="text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="text-xs font-medium">{sub.identity?.displayName ?? sub.name}</p>
                            {sub.identity?.title && (
                              <p className="text-[10px] text-muted-foreground truncate">{sub.identity.title}</p>
                            )}
                          </div>
                          <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Task stats summary ── */}
          {taskStats.total > 0 && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
              <CardContent className="pt-4 pb-4 space-y-3">
                <SectionHeader title="Performance" icon={Star} />
                <div className="grid grid-cols-2 gap-3">
                  <div className="text-center">
                    <p className="text-lg font-bold font-mono">{taskStats.total}</p>
                    <p className="text-[10px] text-muted-foreground">Total tasks</p>
                  </div>
                  {taskStats.successRate != null && (
                    <div className="text-center">
                      <p className={cn("text-lg font-bold font-mono", taskStats.successRate >= 70 ? "text-emerald-400" : "text-amber-400")}>
                        {taskStats.successRate}%
                      </p>
                      <p className="text-[10px] text-muted-foreground">Success rate</p>
                    </div>
                  )}
                  {taskStats.avgScore != null && (
                    <div className="text-center">
                      <p className="text-lg font-bold font-mono">{Math.round(taskStats.avgScore * 100)}%</p>
                      <p className="text-[10px] text-muted-foreground">Avg score</p>
                    </div>
                  )}
                  <div className="text-center">
                    <p className="text-lg font-bold font-mono text-emerald-400">{taskStats.done}</p>
                    <p className="text-[10px] text-muted-foreground">Done</p>
                  </div>
                </div>
                {/* Mini bar */}
                {taskStats.done + taskStats.failed > 0 && (
                  <div className="space-y-1">
                    <Progress value={taskStats.successRate ?? 0} className="h-1.5" />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{taskStats.done} done</span>
                      <span>{taskStats.failed} failed</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

        </div>

        {/* ════════════ RIGHT COLUMN: Tabs ════════════ */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {/* Mobile: identity summary (hidden on desktop where left column exists) */}
          <div className="lg:hidden mb-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <AgentAvatar avatar={identity?.avatar} name={agent.name} size="lg" iconClassName="text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold truncate">{identity?.displayName ?? agent.name}</h1>
                  {process && <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />}
                </div>
                {identity?.title && <p className="text-xs text-muted-foreground">{identity.title}</p>}
                {agent.model && <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{agent.model}</p>}
              </div>
              <Button variant="outline" size="sm" onClick={refetch} className="shrink-0 ml-auto">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Live activity (shows on right column for better visibility) */}
          {process && <LiveActivity process={process} />}

          {/* Activity heatmap */}
          {agentTasks.length > 0 && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 mb-3">
              <CardContent className="pt-3 pb-3 overflow-x-auto">
                <ActivityHeatmap tasks={agentTasks} />
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0 mt-2">
            <TabsList className="shrink-0">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="instructions">Instructions</TabsTrigger>
              <TabsTrigger value="tools">
                Tools & Skills
                <Badge variant="secondary" className="ml-1.5 text-[9px]">
                  {(agent.allowedTools?.length ?? 0) + enabledCategories.length + (agent.skills?.length ?? 0) + mcpEntries.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="config">Config</TabsTrigger>
              <TabsTrigger value="tasks">
                Tasks
                {taskStats.total > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[9px]">{taskStats.total}</Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* ═══ OVERVIEW TAB ═══ */}
            <TabsContent value="overview" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

                  {/* Bio */}
                  {identity?.bio && (
                    <div>
                      <SectionHeader title="Bio" icon={MessageSquare} />
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                        <CardContent className="pt-3 pb-3">
                          <p className="text-sm text-muted-foreground leading-relaxed">{identity.bio}</p>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Role */}
                  <div>
                    <SectionHeader title="Role" icon={Shield} />
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                      <CardContent className="pt-3 pb-3">
                        {agent.role ? (
                          <MessageResponse>{agent.role}</MessageResponse>
                        ) : (
                          <p className="text-xs text-muted-foreground/40 italic">No role configured</p>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {/* Personality & Tone */}
                  <div>
                    <SectionHeader title="Personality & Tone" icon={Heart} />
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                      <CardContent className="pt-3 pb-3 divide-y divide-border/20">
                        <div className="pb-3">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Heart className="h-3 w-3 text-pink-400" />
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Personality</span>
                          </div>
                          {identity?.personality ? (
                            <p className="text-xs text-muted-foreground leading-relaxed">{identity.personality}</p>
                          ) : (
                            <p className="text-xs text-muted-foreground/40 italic">Not configured</p>
                          )}
                        </div>
                        <div className="pt-3">
                          <div className="flex items-center gap-1.5 mb-1">
                            <MessageSquare className="h-3 w-3 text-sky-400" />
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Communication Tone</span>
                          </div>
                          {identity?.tone ? (
                            <p className="text-xs text-muted-foreground leading-relaxed">{identity.tone}</p>
                          ) : (
                            <p className="text-xs text-muted-foreground/40 italic">Not configured</p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Responsibilities */}
                  <div>
                    <SectionHeader title="Responsibilities" icon={ListChecks} count={identity?.responsibilities?.length} />
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                      <CardContent className="pt-3 pb-3">
                        {identity?.responsibilities && identity.responsibilities.length > 0 ? (
                          <div className="space-y-2">
                            {identity.responsibilities.map((resp, i) => {
                              if (typeof resp === "string") {
                                return (
                                  <div key={i} className="flex items-start gap-2 text-xs">
                                    <div className="h-1.5 w-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                                    <span className="text-muted-foreground">{resp}</span>
                                  </div>
                                );
                              }
                              return (
                                <div key={i} className="rounded-md border border-border/30 bg-muted/10 px-3 py-2 space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium">{resp.area}</span>
                                    {resp.priority && (
                                      <Badge
                                        variant="outline"
                                        className={cn("text-[8px] capitalize", responsibilityPriorityColors[resp.priority])}
                                      >
                                        {resp.priority}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-[11px] text-muted-foreground leading-relaxed">{resp.description}</p>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground/40 italic">No responsibilities configured</p>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {/* Capabilities overview */}
                  <div>
                    <SectionHeader title="Capabilities" icon={Zap} />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{agent.allowedTools?.length ?? 0}</p>
                          <p className="text-[10px] text-muted-foreground">Tools</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{enabledCategories.length}</p>
                          <p className="text-[10px] text-muted-foreground">Extensions</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{agent.skills?.length ?? 0}</p>
                          <p className="text-[10px] text-muted-foreground">Skills</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{mcpEntries.length}</p>
                          <p className="text-[10px] text-muted-foreground">MCP Servers</p>
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ═══ INSTRUCTIONS TAB ═══ */}
            <TabsContent value="instructions" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="space-y-4 pr-4 pb-bottom-nav lg:pb-4">
                  {agent.systemPrompt ? (
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {agent.systemPrompt.length.toLocaleString()} chars
                        </span>
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost" size="sm" className="h-6 w-6 p-0"
                                onClick={() => navigator.clipboard.writeText(agent.systemPrompt!)}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">Copy</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost" size="sm" className="h-6 w-6 p-0"
                                onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                              >
                                {showSystemPrompt ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">{showSystemPrompt ? "Collapse" : "Expand"}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                      <div className={cn(
                        "px-4 py-3 text-sm overflow-hidden",
                        !showSystemPrompt && "max-h-[70vh]"
                      )}>
                        <MessageResponse>{agent.systemPrompt}</MessageResponse>
                      </div>
                      {!showSystemPrompt && (
                        <div className="h-8 bg-gradient-to-t from-card/95 to-transparent -mt-8 relative pointer-events-none" />
                      )}
                    </Card>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <Terminal className="h-10 w-10 mb-3 opacity-40" />
                      <p className="text-sm">No system prompt configured</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">Add a <code className="font-mono text-[10px]">systemPrompt</code> field in the agent config</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ═══ TASKS TAB ═══ */}
            <TabsContent value="tasks" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="space-y-4 pr-4 pb-bottom-nav lg:pb-4">
                  {/* Task stats bar */}
                  {taskStats.total > 0 && (
                    <div className="flex items-center gap-4 flex-wrap">
                      <div className="flex items-center gap-1.5 text-xs">
                        <div className="h-2 w-2 rounded-full bg-blue-400" />
                        <span className="text-muted-foreground">Active</span>
                        <span className="font-mono font-bold">{taskStats.active}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs">
                        <div className="h-2 w-2 rounded-full bg-zinc-400" />
                        <span className="text-muted-foreground">Pending</span>
                        <span className="font-mono font-bold">{taskStats.pending}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs">
                        <div className="h-2 w-2 rounded-full bg-emerald-400" />
                        <span className="text-muted-foreground">Done</span>
                        <span className="font-mono font-bold">{taskStats.done}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs">
                        <div className="h-2 w-2 rounded-full bg-red-400" />
                        <span className="text-muted-foreground">Failed</span>
                        <span className="font-mono font-bold">{taskStats.failed}</span>
                      </div>
                      {taskStats.successRate != null && (
                        <div className="flex items-center gap-1.5 text-xs ml-auto">
                          <span className="text-muted-foreground">Success rate:</span>
                          <span className={cn("font-mono font-bold", taskStats.successRate >= 70 ? "text-emerald-400" : "text-amber-400")}>
                            {taskStats.successRate}%
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Task list */}
                  {sortedTasks.length > 0 ? (
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                      <CardContent className="pt-2 pb-2 divide-y divide-border/20">
                        {sortedTasks.map((task) => (
                          <TaskRow key={task.id} task={task} />
                        ))}
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <ListChecks className="h-10 w-10 mb-3 opacity-40" />
                      <p className="text-sm">No tasks assigned to this agent yet</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ═══ TOOLS & SKILLS TAB ═══ */}
            <TabsContent value="tools" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

                  {/* Allowed tools */}
                  {agent.allowedTools && agent.allowedTools.length > 0 && (
                    <div>
                      <SectionHeader title={`Allowed Tools`} icon={Wrench} count={agent.allowedTools.length} />
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
                        {agent.allowedTools.map((t) => {
                          const meta = getToolMeta(t);
                          const ToolIcon = meta.icon;
                          return (
                            <div
                              key={t}
                              className={cn(
                                "flex items-center gap-2 rounded-lg border border-border/30 px-3 py-2 transition-colors",
                                meta.bg,
                              )}
                            >
                              <ToolIcon className={cn("h-3.5 w-3.5 shrink-0", meta.color)} />
                              <span className="text-xs font-mono truncate">{t}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Tool categories from allowedTools */}
                  <div>
                    <SectionHeader title="Tool Extensions" icon={Layers} count={enabledCategories.length} />
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                      {toolCategories.map(({ prefix, label, tools }) => {
                        const enabled = agentAllowedTools.some(t => (t as string).toLowerCase().startsWith(prefix));
                        return (
                          <Tooltip key={prefix}>
                            <TooltipTrigger asChild>
                              <div className={cn(
                                "flex items-center gap-2 rounded-md border px-3 py-2 cursor-help transition-colors",
                                enabled
                                  ? "border-teal-500/30 bg-teal-500/5"
                                  : "border-border/30 bg-card/30"
                              )}>
                                {enabled ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-teal-500 shrink-0" />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                                )}
                                <span className={cn("text-xs font-medium", enabled ? "text-foreground" : "text-muted-foreground/60")}>
                                  {label}
                                </span>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-72">
                              <p className="font-medium mb-0.5">{label} tools — {enabled ? "Enabled" : "Disabled"}</p>
                              <p className="text-muted-foreground font-mono text-[10px]">{tools}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>

                    {/* Browser profile details */}
                    {agentAllowedTools.some(t => (t as string).toLowerCase().startsWith("browser_")) && agent.browserProfile && (
                      <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground px-1">
                        <span>Profile: <code className="font-mono text-foreground">{agent.browserProfile}</code></span>
                      </div>
                    )}

                    {/* Email domain restrictions */}
                    {agentAllowedTools.some(t => (t as string).toLowerCase().startsWith("email_")) && agent.emailAllowedDomains && agent.emailAllowedDomains.length > 0 && (
                      <div className="mt-3 px-1">
                        <p className="text-[10px] text-muted-foreground mb-1">Allowed email domains:</p>
                        <div className="flex flex-wrap gap-1">
                          {agent.emailAllowedDomains.map((d) => (
                            <Badge key={d} variant="outline" className="text-[9px] font-mono">{d}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Skills */}
                  {agent.skills && agent.skills.length > 0 && (
                    <div>
                      <SectionHeader title="Skills" icon={Sparkles} count={agent.skills.length} />
                      <div className="space-y-2">
                        {agent.skills.map((skillName) => {
                          const info = skillPool.get(skillName);
                          const skillMeta = getSkillMeta(skillName);
                          const SkillIcon = skillMeta.icon;
                          return (
                            <div
                              key={skillName}
                              className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-1.5"
                            >
                              <div className="flex items-center gap-2">
                                <SkillIcon className={cn("h-3.5 w-3.5 shrink-0", skillMeta.color)} />
                                <span className="text-sm font-medium">{skillName}</span>
                                {info && (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 ml-auto">{info.source}</Badge>
                                )}
                              </div>
                              {info?.description && (
                                <p className="text-xs text-muted-foreground">{info.description}</p>
                              )}
                              {info?.path && (
                                <p className="text-[10px] font-mono text-muted-foreground/70 truncate" title={info.path}>
                                  {info.path}
                                </p>
                              )}
                              {info?.allowedTools && info.allowedTools.length > 0 && (
                                <div className="flex items-center gap-1 pt-0.5">
                                  <Wrench className="h-2.5 w-2.5 text-muted-foreground" />
                                  {info.allowedTools.map(t => (
                                    <Badge key={t} variant="outline" className="text-[9px] py-0 px-1 font-mono">{String(t)}</Badge>
                                  ))}
                                </div>
                              )}
                              {!info && (
                                <p className="text-[10px] text-muted-foreground italic">
                                  Skill not found in project pool — may be installed at runtime
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* MCP Servers */}
                  {mcpEntries.length > 0 && (
                    <div>
                      <SectionHeader title="MCP Servers" icon={Globe} count={mcpEntries.length} />
                      <div className="space-y-2">
                        {mcpEntries.map(([serverName, cfg]) => {
                          const type = "command" in cfg ? "stdio" : ("type" in cfg ? (cfg as { type: string }).type : "http");
                          const command = "command" in cfg ? (cfg as { command: string; args?: string[] }).command : undefined;
                          const args = "args" in cfg ? (cfg as { args?: string[] }).args : undefined;
                          const url = "url" in cfg ? (cfg as { url: string }).url : undefined;
                          const env = "env" in cfg ? (cfg as { env?: Record<string, string> }).env : undefined;
                          const headers = "headers" in cfg ? (cfg as { headers?: Record<string, string> }).headers : undefined;

                          return (
                            <div
                              key={serverName}
                              className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-2"
                            >
                              <div className="flex items-center gap-2">
                                <Activity className="h-3.5 w-3.5 text-primary shrink-0" />
                                <span className="text-sm font-medium">{serverName}</span>
                                <Badge variant="outline" className="text-[10px] ml-auto">{type}</Badge>
                              </div>
                              {command && (
                                <div className="flex items-center gap-1.5">
                                  <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
                                  <code className="text-xs font-mono text-muted-foreground">
                                    {command}{args?.length ? ` ${args.join(" ")}` : ""}
                                  </code>
                                </div>
                              )}
                              {url && (
                                <div className="flex items-center gap-1.5">
                                  <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
                                  <code className="text-xs font-mono text-muted-foreground truncate">{url}</code>
                                </div>
                              )}
                              {env && Object.keys(env).length > 0 && (
                                <div className="flex flex-wrap gap-1 pt-0.5">
                                  <span className="text-[10px] text-muted-foreground mr-1">env:</span>
                                  {Object.keys(env).map(k => (
                                    <Badge key={k} variant="secondary" className="text-[9px] font-mono">{k}</Badge>
                                  ))}
                                </div>
                              )}
                              {headers && Object.keys(headers).length > 0 && (
                                <div className="flex flex-wrap gap-1 pt-0.5">
                                  <span className="text-[10px] text-muted-foreground mr-1">headers:</span>
                                  {Object.keys(headers).map(k => (
                                    <Badge key={k} variant="secondary" className="text-[9px] font-mono">{k}</Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Allowed Paths */}
                  {agent.allowedPaths && agent.allowedPaths.length > 0 && (
                    <div>
                      <SectionHeader title="Allowed Paths" icon={FolderOpen} count={agent.allowedPaths.length} />
                      <div className="flex flex-col gap-1">
                        {agent.allowedPaths.map((p) => (
                          <div key={p} className="flex items-center gap-2 rounded-md border border-border/40 bg-card/60 px-3 py-2">
                            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <code className="text-xs font-mono text-muted-foreground">{p}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Credential Vault */}
                  <div>
                    <SectionHeader title="Credential Vault" icon={KeyRound} count={vaultEntries.length || undefined} />
                    {vaultEntries.length > 0 ? (
                      <div className="space-y-2">
                        {vaultEntries.map((entry: VaultEntryMeta) => (
                          <div
                            key={entry.service}
                            className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-2"
                          >
                            <div className="flex items-center gap-2">
                              <KeyRound className="h-3.5 w-3.5 text-primary shrink-0" />
                              <span className="text-sm font-medium">{entry.service}</span>
                              <Badge variant="outline" className="text-[10px] ml-auto">{entry.type}</Badge>
                            </div>
                            {entry.label && (
                              <p className="text-xs text-muted-foreground ml-5.5">{entry.label}</p>
                            )}
                            <div className="flex flex-wrap gap-1.5 ml-5.5">
                              {entry.keys.map((k: string) => (
                                <span
                                  key={k}
                                  className="inline-flex items-center gap-1 rounded bg-muted/50 border border-border/30 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
                                >
                                  {k}: <span className="text-[10px] opacity-60">***</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                        <p className="text-[10px] text-muted-foreground/60 mt-1">
                          Encrypted with AES-256-GCM in <code className="font-mono">.polpo/vault.enc</code>. Use the chat to manage entries.
                        </p>
                      </div>
                    ) : (
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
                        <CardContent className="pt-4 pb-4">
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            No credentials configured for this agent. Use the chat to add vault entries — they are encrypted with AES-256-GCM in <code className="text-[10px] font-mono">.polpo/vault.enc</code>.
                          </p>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ═══ CONFIG TAB — Raw JSON ═══ */}
            <TabsContent value="config" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="pr-4 pb-bottom-nav lg:pb-4">
                  <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
                      <span className="text-[10px] text-muted-foreground font-mono">polpo.json &mdash; agent configuration</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost" size="sm" className="h-6 w-6 p-0"
                            onClick={() => navigator.clipboard.writeText(JSON.stringify(agent, null, 2))}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">Copy JSON</TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="px-4 py-3 text-xs leading-relaxed overflow-x-auto">
                      <MessageResponse>{"```json\n" + JSON.stringify(agent, null, 2) + "\n```"}</MessageResponse>
                    </div>
                  </Card>
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
