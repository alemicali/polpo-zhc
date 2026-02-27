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
  Settings2,
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
  Infinity as InfinityIcon,
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
  User,
  Building2,
  Mail,
  MapPin,
  Heart,
  MessageSquare,
  ListChecks,
  Lock,
  KeyRound,
  ArrowUpRight,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAgent, useAgents, useProcesses, useSkills, useTasks } from "@lumea-labs/polpo-react";
import type { AgentProcess, AgentConfig, SkillInfo, Task, TaskStatus } from "@lumea-labs/polpo-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";

// ── Enable flag meta ──

const enableFlags: { key: string; label: string; tools: string }[] = [
  { key: "enableBrowser", label: "Browser", tools: "browser_navigate, browser_click, browser_fill, browser_type, browser_screenshot, ..." },
  { key: "enableHttp", label: "HTTP", tools: "http_fetch, http_download" },
  { key: "enableGit", label: "Git", tools: "git_status, git_diff, git_log, git_commit, git_branch, ..." },
  { key: "enableMultifile", label: "Multi-file", tools: "multi_edit, regex_replace, bulk_rename" },
  { key: "enableDeps", label: "Dependencies", tools: "dep_install, dep_add, dep_remove, dep_outdated, dep_audit, dep_info" },
  { key: "enableExcel", label: "Excel/CSV", tools: "excel_read, excel_write, excel_query, excel_info" },
  { key: "enablePdf", label: "PDF", tools: "pdf_read, pdf_create, pdf_merge, pdf_info" },
  { key: "enableDocx", label: "DOCX", tools: "docx_read, docx_create" },
  { key: "enableEmail", label: "Email", tools: "email_send, email_verify, email_list, email_read, email_search" },
  { key: "enableAudio", label: "Audio", tools: "audio_transcribe, audio_speak" },
  { key: "enableImage", label: "Image", tools: "image_generate, image_analyze" },
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

const vaultTypeIcons: Record<string, { icon: React.ElementType; color: string }> = {
  smtp: { icon: Mail, color: "text-sky-400" },
  imap: { icon: Mail, color: "text-indigo-400" },
  oauth: { icon: KeyRound, color: "text-amber-400" },
  api_key: { icon: KeyRound, color: "text-emerald-400" },
  login: { icon: User, color: "text-violet-400" },
  custom: { icon: Lock, color: "text-zinc-400" },
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

// ── KV pair ──

function KV({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-[11px] text-right truncate", mono && "font-mono")}>{children}</span>
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
  const hasIdentity = identity && (identity.displayName || identity.title || identity.bio || identity.company);
  const agentAny = agent as unknown as Record<string, unknown>;
  const mcpEntries = agent.mcpServers ? Object.entries(agent.mcpServers) : [];
  const vaultEntries = agent.vault ? Object.entries(agent.vault) : [];
  const enabledFlags = enableFlags.filter(f => agentAny[f.key] === true);

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
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 overflow-hidden">
            {/* Gradient header bar */}
            <div className="h-16 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent" />
            <CardContent className="pt-0 -mt-8 pb-4 space-y-3">
              {/* Avatar + name */}
              <div className="flex items-end gap-3">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-card border-2 border-background shadow-lg">
                  <Bot className="h-7 w-7 text-primary" />
                </div>
                <div className="min-w-0 pb-0.5">
                  <div className="flex items-center gap-2">
                    <h1 className="text-lg font-bold tracking-tight leading-tight truncate">
                      {identity?.displayName ?? agent.name}
                    </h1>
                    {process && (
                      <div className="flex items-center gap-1">
                        <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                      </div>
                    )}
                  </div>
                  {identity?.displayName && identity.displayName !== agent.name && (
                    <p className="text-[10px] font-mono text-muted-foreground">@{agent.name}</p>
                  )}
                </div>
              </div>

              {/* Title + company */}
              {(identity?.title || identity?.company) && (
                <div className="space-y-0.5">
                  {identity.title && (
                    <p className="text-xs font-medium">{identity.title}</p>
                  )}
                  {identity.company && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <Building2 className="h-3 w-3" /> {identity.company}
                    </p>
                  )}
                </div>
              )}

              {/* Bio */}
              {identity?.bio && (
                <p className="text-xs text-muted-foreground leading-relaxed">{identity.bio}</p>
              )}

              {/* Metadata: email, timezone, model */}
              <div className="divide-y divide-border/20 text-[11px]">
                {identity?.email && (
                  <div className="flex items-center gap-2 py-1.5">
                    <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground truncate font-mono">{identity.email}</span>
                  </div>
                )}
                {identity?.timezone && (
                  <div className="flex items-center gap-2 py-1.5">
                    <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">{identity.timezone}</span>
                  </div>
                )}
                {agent.model && (
                  <div className="flex items-center gap-2 py-1.5">
                    <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground font-mono truncate">{agent.model}</span>
                  </div>
                )}
              </div>

              {/* Badges row */}
              <div className="flex flex-wrap gap-1.5">
                {agent.volatile && (
                  <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                    <Zap className="h-2.5 w-2.5 mr-0.5" /> Volatile
                  </Badge>
                )}
                {agent.planGroup && (
                  <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                    plan: {agent.planGroup}
                  </Badge>
                )}
                {enabledFlags.length > 0 && (
                  <Badge variant="secondary" className="text-[9px]">
                    {enabledFlags.length} extension{enabledFlags.length !== 1 ? "s" : ""}
                  </Badge>
                )}
                {agent.skills && agent.skills.length > 0 && (
                  <Badge variant="secondary" className="text-[9px]">
                    {agent.skills.length} skill{agent.skills.length !== 1 ? "s" : ""}
                  </Badge>
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

          {/* ── Personality & Tone ── */}
          {(identity?.personality || identity?.tone) && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-4 pb-4 space-y-3">
                {identity.personality && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <Heart className="h-3 w-3 text-pink-400" />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Personality</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{identity.personality}</p>
                  </div>
                )}
                {identity.tone && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <MessageSquare className="h-3 w-3 text-sky-400" />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Communication Tone</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{identity.tone}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Responsibilities ── */}
          {identity?.responsibilities && identity.responsibilities.length > 0 && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-4 pb-4">
                <SectionHeader title="Responsibilities" icon={ListChecks} count={identity.responsibilities.length} />
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
              </CardContent>
            </Card>
          )}

          {/* ── Reporting hierarchy ── */}
          {(agent.reportsTo || subordinates.length > 0) && (
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
              <CardContent className="pt-4 pb-4 space-y-3">
                <SectionHeader title="Org Chart" icon={Shield} />

                {/* Reports to */}
                {manager && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Reports to</p>
                    <Link
                      to={`/agents/${manager.name}`}
                      className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 hover:bg-accent/10 transition-colors"
                    >
                      <Bot className="h-4 w-4 text-primary shrink-0" />
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
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Reports to</p>
                    <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
                      <Bot className="h-4 w-4 shrink-0" />
                      <span className="font-mono">{agent.reportsTo}</span>
                    </div>
                  </div>
                )}

                {/* Subordinates */}
                {subordinates.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                      Direct reports ({subordinates.length})
                    </p>
                    <div className="space-y-1">
                      {subordinates.map((sub) => (
                        <Link
                          key={sub.name}
                          to={`/agents/${sub.name}`}
                          className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 hover:bg-accent/10 transition-colors"
                        >
                          <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
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
            <Card className="bg-card/80 backdrop-blur-sm border-border/40">
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
                <Bot className="h-6 w-6 text-primary" />
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

          <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0 mt-2">
            <TabsList className="shrink-0">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tasks">
                Tasks
                {taskStats.total > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[9px]">{taskStats.total}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="tools">
                Tools & Skills
                <Badge variant="secondary" className="ml-1.5 text-[9px]">
                  {(agent.allowedTools?.length ?? 0) + enabledFlags.length + (agent.skills?.length ?? 0) + mcpEntries.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="config">Config</TabsTrigger>
            </TabsList>

            {/* ═══ OVERVIEW TAB ═══ */}
            <TabsContent value="overview" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

                  {/* Role */}
                  {agent.role && (
                    <div>
                      <SectionHeader title="Role" icon={Shield} />
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                        <CardContent className="pt-4 pb-4">
                          <MessageResponse>{agent.role}</MessageResponse>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Capabilities overview */}
                  <div>
                    <SectionHeader title="Capabilities" icon={Zap} />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{agent.allowedTools?.length ?? 0}</p>
                          <p className="text-[10px] text-muted-foreground">Tools</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{enabledFlags.length}</p>
                          <p className="text-[10px] text-muted-foreground">Extensions</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{agent.skills?.length ?? 0}</p>
                          <p className="text-[10px] text-muted-foreground">Skills</p>
                        </CardContent>
                      </Card>
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                        <CardContent className="pt-3 pb-3 text-center">
                          <p className="text-2xl font-bold font-mono">{mcpEntries.length}</p>
                          <p className="text-[10px] text-muted-foreground">MCP Servers</p>
                        </CardContent>
                      </Card>
                    </div>
                  </div>

                  {/* Configuration summary */}
                  <div>
                    <SectionHeader title="Configuration" icon={Settings2} />
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                      <CardContent className="pt-4 pb-4">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-1 divide-y sm:divide-y-0">
                          <div className="divide-y divide-border/20">
                            <KV label="Max Turns">{agent.maxTurns ?? 150}</KV>
                            <KV label="Max Concurrency">
                              {agent.maxConcurrency != null ? agent.maxConcurrency : (
                                <span className="flex items-center gap-0.5"><InfinityIcon className="h-3 w-3" /></span>
                              )}
                            </KV>
                          </div>
                          <div className="divide-y divide-border/20">
                            <KV label="Model" mono>{agent.model ?? "default"}</KV>
                            <KV label="Type">
                              {agent.volatile ? (
                                <span className="flex items-center gap-1 text-amber-400"><Zap className="h-3 w-3" /> Volatile</span>
                              ) : (
                                <span className="flex items-center gap-1 text-emerald-400"><Shield className="h-3 w-3" /> Permanent</span>
                              )}
                            </KV>
                          </div>
                          <div className="divide-y divide-border/20">
                            {agent.reportsTo && <KV label="Reports To" mono>{agent.reportsTo}</KV>}
                            {agent.planGroup && <KV label="Plan Group" mono>{agent.planGroup}</KV>}
                            <KV label="Paths">{agent.allowedPaths?.length ?? 1}</KV>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Mobile-only: identity details that are in left column on desktop */}
                  <div className="lg:hidden space-y-4">
                    {(identity?.personality || identity?.tone) && (
                      <div>
                        <SectionHeader title="Personality & Tone" icon={Heart} />
                        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                          <CardContent className="pt-4 pb-4 space-y-3">
                            {identity?.personality && (
                              <div>
                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Personality</p>
                                <p className="text-xs text-muted-foreground">{identity.personality}</p>
                              </div>
                            )}
                            {identity?.tone && (
                              <div>
                                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Communication Tone</p>
                                <p className="text-xs text-muted-foreground">{identity.tone}</p>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </div>
                    )}

                    {identity?.responsibilities && identity.responsibilities.length > 0 && (
                      <div>
                        <SectionHeader title="Responsibilities" icon={ListChecks} count={identity.responsibilities.length} />
                        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                          <CardContent className="pt-4 pb-4 space-y-2">
                            {identity.responsibilities.map((resp, i) => (
                              typeof resp === "string" ? (
                                <div key={i} className="flex items-start gap-2 text-xs">
                                  <div className="h-1.5 w-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                                  <span className="text-muted-foreground">{resp}</span>
                                </div>
                              ) : (
                                <div key={i} className="rounded-md border border-border/30 bg-muted/10 px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium">{resp.area}</span>
                                    {resp.priority && (
                                      <Badge variant="outline" className={cn("text-[8px] capitalize", responsibilityPriorityColors[resp.priority])}>
                                        {resp.priority}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-[11px] text-muted-foreground mt-1">{resp.description}</p>
                                </div>
                              )
                            ))}
                          </CardContent>
                        </Card>
                      </div>
                    )}
                  </div>
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
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40">
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
                      <div className="flex flex-wrap gap-1.5">
                        {agent.allowedTools.map((t) => (
                          <Badge key={t} variant="secondary" className="text-xs font-mono">{t}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* All enable flags */}
                  <div>
                    <SectionHeader title="Tool Extensions" icon={Layers} count={enabledFlags.length} />
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                      {enableFlags.map(({ key, label, tools }) => {
                        const enabled = agentAny[key] === true;
                        return (
                          <Tooltip key={key}>
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

                    {/* Browser config details */}
                    {agentAny.enableBrowser && (agent.browserEngine || agent.browserProfile) && (
                      <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground px-1">
                        {agent.browserEngine && (
                          <span>Engine: <code className="font-mono text-foreground">{agent.browserEngine}</code></span>
                        )}
                        {agent.browserProfile && (
                          <span>Profile: <code className="font-mono text-foreground">{agent.browserProfile}</code></span>
                        )}
                      </div>
                    )}

                    {/* Email domain restrictions */}
                    {agentAny.enableEmail && agent.emailAllowedDomains && agent.emailAllowedDomains.length > 0 && (
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
                          return (
                            <div
                              key={skillName}
                              className="rounded-md border border-border/30 bg-card/60 px-4 py-3 space-y-1.5"
                            >
                              <div className="flex items-center gap-2">
                                <Sparkles className="h-3.5 w-3.5 text-violet-400 shrink-0" />
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
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ═══ CONFIG TAB ═══ */}
            <TabsContent value="config" className="mt-4 flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">

                  {/* System Prompt */}
                  {agent.systemPrompt && (
                    <div>
                      <SectionHeader title="System Prompt" icon={Terminal} />
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40 overflow-hidden">
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
                        <div className="px-4 py-3">
                          <pre className={cn(
                            "text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words",
                            !showSystemPrompt && "line-clamp-6"
                          )}>
                            {agent.systemPrompt}
                          </pre>
                        </div>
                      </Card>
                    </div>
                  )}

                  {/* Vault */}
                  {vaultEntries.length > 0 && (
                    <div>
                      <SectionHeader title="Credential Vault" icon={Lock} count={vaultEntries.length} />
                      <div className="space-y-2">
                        {vaultEntries.map(([serviceName, entry]) => {
                          const typeInfo = vaultTypeIcons[entry.type] ?? vaultTypeIcons.custom;
                          const TypeIcon = typeInfo.icon;
                          return (
                            <Card key={serviceName} className="bg-card/80 backdrop-blur-sm border-border/40">
                              <CardContent className="pt-3 pb-3">
                                <div className="flex items-center gap-2 mb-2">
                                  <TypeIcon className={cn("h-4 w-4", typeInfo.color)} />
                                  <span className="text-sm font-medium">{entry.label ?? serviceName}</span>
                                  <Badge variant="outline" className="text-[9px] ml-auto">{entry.type}</Badge>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {Object.keys(entry.credentials).map((key) => (
                                    <Badge key={key} variant="secondary" className="text-[9px] font-mono">{key}: ***</Badge>
                                  ))}
                                </div>
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Full config grid */}
                  <div>
                    <SectionHeader title="Agent Configuration" icon={Settings2} />
                    <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                      <CardContent className="pt-4 pb-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
                          <div className="divide-y divide-border/20">
                            <KV label="Name" mono>{agent.name}</KV>
                            <KV label="Model" mono>{agent.model ?? "default"}</KV>
                            <KV label="Max Turns">{agent.maxTurns ?? 150}</KV>
                            <KV label="Max Concurrency">
                              {agent.maxConcurrency ?? "unlimited"}
                            </KV>
                            <KV label="Volatile">{agent.volatile ? "Yes" : "No"}</KV>
                          </div>
                          <div className="divide-y divide-border/20">
                            {agent.planGroup && <KV label="Plan Group" mono>{agent.planGroup}</KV>}
                            {agent.reportsTo && <KV label="Reports To" mono>{agent.reportsTo}</KV>}
                            <KV label="Allowed Paths">{agent.allowedPaths?.length ?? 1}</KV>
                            <KV label="Allowed Tools">{agent.allowedTools?.length ?? 0}</KV>
                            <KV label="Skills">{agent.skills?.length ?? 0}</KV>
                            <KV label="MCP Servers">{mcpEntries.length}</KV>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Identity config (raw details for completeness) */}
                  {hasIdentity && (
                    <div>
                      <SectionHeader title="Identity Configuration" icon={User} />
                      <Card className="bg-card/80 backdrop-blur-sm border-border/40">
                        <CardContent className="pt-4 pb-4">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
                            <div className="divide-y divide-border/20">
                              {identity!.displayName && <KV label="Display Name">{identity!.displayName}</KV>}
                              {identity!.title && <KV label="Title">{identity!.title}</KV>}
                              {identity!.company && <KV label="Company">{identity!.company}</KV>}
                              {identity!.email && <KV label="Email" mono>{identity!.email}</KV>}
                            </div>
                            <div className="divide-y divide-border/20">
                              {identity!.timezone && <KV label="Timezone">{identity!.timezone}</KV>}
                              {identity!.tone && <KV label="Tone">{identity!.tone}</KV>}
                              {identity!.personality && <KV label="Personality">{identity!.personality}</KV>}
                              {identity!.responsibilities && (
                                <KV label="Responsibilities">{identity!.responsibilities.length} defined</KV>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
