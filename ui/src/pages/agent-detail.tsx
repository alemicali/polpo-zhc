import { useParams, Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Infinity,
  FolderOpen,
  Terminal,
  Globe,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAgents, useProcesses, useSkills } from "@openpolpo/react-sdk";
import type { AgentConfig, AgentProcess, SkillInfo } from "@openpolpo/react-sdk";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";

// ── Enable flag meta ──

const enableFlags: { key: string; label: string; tools: string }[] = [
  { key: "enableBrowser", label: "Browser", tools: "browser_navigate, browser_click, browser_fill, ..." },
  { key: "enableHttp", label: "HTTP", tools: "http_fetch, http_download" },
  { key: "enableGit", label: "Git", tools: "git_status, git_diff, git_log, git_commit, ..." },
  { key: "enableMultifile", label: "Multi-file", tools: "multi_edit, regex_replace, bulk_rename" },
  { key: "enableDeps", label: "Deps", tools: "dep_install, dep_add, dep_remove, dep_outdated, ..." },
  { key: "enableExcel", label: "Excel/CSV", tools: "excel_read, excel_write, excel_query, excel_info" },
  { key: "enablePdf", label: "PDF", tools: "pdf_read, pdf_create, pdf_merge, pdf_info" },
  { key: "enableDocx", label: "DOCX", tools: "docx_read, docx_create" },
  { key: "enableEmail", label: "Email", tools: "email_send, email_verify" },
  { key: "enableAudio", label: "Audio", tools: "audio_transcribe, audio_speak" },
  { key: "enableImage", label: "Image", tools: "image_generate, image_analyze" },
];

// ── Section component ──

function Section({ title, icon: Icon, children, className }: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </h3>
      {children}
    </div>
  );
}

// ── Live activity panel ──

function LiveActivity({ process }: { process: AgentProcess }) {
  const act = process.activity;
  const totalFiles = (act.filesCreated?.length ?? 0) + (act.filesEdited?.length ?? 0);

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("h-2.5 w-2.5 rounded-full", process.alive ? "bg-blue-500 animate-pulse" : "bg-zinc-500")} />
          <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">
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

      {/* Summary */}
      <p className="text-sm text-muted-foreground">
        {act.summary
          ? act.summary
          : act.lastTool && act.lastFile
          ? <>Using <code className="text-foreground font-mono text-xs">{act.lastTool}</code> on <code className="text-foreground font-mono text-xs">{act.lastFile}</code></>
          : act.lastTool
          ? <>Using <code className="text-foreground font-mono text-xs">{act.lastTool}</code></>
          : "Running..."}
      </p>

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
            {act.filesCreated.map((f) => (
              <Badge key={f} variant="secondary" className="text-[10px] font-mono max-w-[250px] truncate">
                {f}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {act.filesEdited && act.filesEdited.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1.5">
            <FileEdit className="h-3 w-3 text-amber-400" /> Edited ({act.filesEdited.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesEdited.map((f) => (
              <Badge key={f} variant="outline" className="text-[10px] font-mono max-w-[250px] truncate">
                {f}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ──

export function AgentDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { agents, isLoading, error, refetch } = useAgents();
  const { processes } = useProcesses();
  const { skills: allSkills } = useSkills();
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  // Find agent by name from the agents list
  const agent = useMemo(
    () => agents.find((a: AgentConfig) => a.name === name) ?? null,
    [agents, name],
  );

  // Skill pool map
  const skillPool = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const s of allSkills) map.set(s.name, s);
    return map;
  }, [allSkills]);

  // Active process for this agent
  const process = processes.find((p: AgentProcess) => p.agentName === name);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentAny = agent as unknown as Record<string, unknown>;
  const hasEnableFlags = enableFlags.some(f => agentAny[f.key] === true);
  const mcpEntries = agent.mcpServers ? Object.entries(agent.mcpServers) : [];

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="max-w-4xl mx-auto space-y-6 pb-8 px-1 pr-5">

        {/* ── Breadcrumb + Back ── */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/agents" className="hover:text-foreground transition-colors">Agents</Link>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground font-medium">{agent.name}</span>
        </div>

        {/* ── Hero header ── */}
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
            <Bot className="h-7 w-7 text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight">{agent.name}</h1>
              {agent.volatile && (
                <Badge variant="outline" className="text-xs text-amber-400 border-amber-500/30">
                  <Zap className="h-3 w-3 mr-1" /> Volatile
                </Badge>
              )}
              {process && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                  <span className="text-xs text-blue-400 font-medium">Working</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1">
              {agent.model && (
                <span className="text-xs text-muted-foreground font-mono">{agent.model}</span>
              )}
              {agent.planGroup && (
                <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                  plan: {agent.planGroup}
                </Badge>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={refetch} className="shrink-0">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* ── Live activity (if running) ── */}
        {process && <LiveActivity process={process} />}

        {/* ── Role ── */}
        {agent.role && (
          <Section title="Role" icon={Shield}>
            <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
              <MessageResponse>{agent.role}</MessageResponse>
            </div>
          </Section>
        )}

        {/* ── System Prompt ── */}
        {agent.systemPrompt && (
          <Section title="System Prompt" icon={Terminal}>
            <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
                <span className="text-[10px] text-muted-foreground font-mono">
                  {agent.systemPrompt.length.toLocaleString()} chars
                </span>
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => navigator.clipboard.writeText(agent.systemPrompt!)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">Copy to clipboard</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
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
            </div>
          </Section>
        )}

        {/* ── Tools ── */}
        {agent.allowedTools && agent.allowedTools.length > 0 && (
          <Section title={`Tools (${agent.allowedTools.length})`} icon={Wrench}>
            <div className="flex flex-wrap gap-1.5">
              {agent.allowedTools.map((t) => (
                <Badge key={t} variant="secondary" className="text-xs font-mono">{t}</Badge>
              ))}
            </div>
          </Section>
        )}

        {/* ── Extended Tool Categories (enable* flags) ── */}
        {hasEnableFlags && (
          <Section title="Extended Tool Categories" icon={Zap}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {enableFlags.map(({ key, label, tools }) => {
                const enabled = agentAny[key] === true;
                return (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <div className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 cursor-help transition-colors",
                        enabled
                          ? "border-emerald-500/30 bg-emerald-500/5"
                          : "border-border bg-muted/10 opacity-40"
                      )}>
                        {enabled ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                        )}
                        <span className={cn("text-xs font-medium", enabled ? "text-foreground" : "text-muted-foreground")}>
                          {label}
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs max-w-72">
                      <p className="font-medium mb-0.5">{label} tools</p>
                      <p className="text-muted-foreground font-mono text-[10px]">{tools}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── Skills ── */}
        {agent.skills && agent.skills.length > 0 && (
          <Section title={`Skills (${agent.skills.length})`} icon={Sparkles}>
            <div className="space-y-2">
              {agent.skills.map((skillName) => {
                const info = skillPool.get(skillName);
                return (
                  <div
                    key={skillName}
                    className="rounded-md border border-border bg-muted/20 px-4 py-3 space-y-1.5"
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
          </Section>
        )}

        {/* ── MCP Servers ── */}
        {mcpEntries.length > 0 && (
          <Section title={`MCP Servers (${mcpEntries.length})`} icon={Globe}>
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
                    className="rounded-md border border-border bg-muted/20 px-4 py-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <Activity className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
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
          </Section>
        )}

        {/* ── Allowed Paths ── */}
        {agent.allowedPaths && agent.allowedPaths.length > 0 && (
          <Section title={`Allowed Paths (${agent.allowedPaths.length})`} icon={FolderOpen}>
            <div className="flex flex-col gap-1">
              {agent.allowedPaths.map((p) => (
                <div key={p} className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <code className="text-xs font-mono text-muted-foreground">{p}</code>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Configuration summary ── */}
        <Section title="Configuration" icon={Settings2}>
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {/* Max Turns */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Max Turns</p>
                <p className="text-sm font-mono font-bold">{agent.maxTurns ?? 150}</p>
              </div>

              {/* Max Concurrency */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Max Concurrency</p>
                <p className="text-sm font-mono font-bold flex items-center gap-1">
                  {agent.maxConcurrency != null ? agent.maxConcurrency : (
                    <><Infinity className="h-4 w-4 inline" /> <span className="text-muted-foreground text-xs font-normal">Unlimited</span></>
                  )}
                </p>
              </div>

              {/* Model */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Model</p>
                <p className="text-sm font-mono truncate" title={agent.model}>
                  {agent.model ?? <span className="text-muted-foreground italic">default</span>}
                </p>
              </div>

              {/* Volatile */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Volatile</p>
                <p className="text-sm font-medium flex items-center gap-1.5">
                  {agent.volatile ? (
                    <><Zap className="h-3.5 w-3.5 text-amber-400" /> Yes</>
                  ) : (
                    <><Shield className="h-3.5 w-3.5 text-emerald-400" /> Permanent</>
                  )}
                </p>
              </div>

              {/* Plan Group */}
              {agent.planGroup && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Plan Group</p>
                  <p className="text-sm font-mono">{agent.planGroup}</p>
                </div>
              )}

              {/* Capability count */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Capabilities</p>
                <p className="text-sm font-mono font-bold">
                  {(agent.allowedTools?.length ?? 0) + (agent.skills?.length ?? 0) + mcpEntries.length}
                  <span className="text-xs text-muted-foreground font-normal ml-1">
                    ({agent.allowedTools?.length ?? 0} tools, {agent.skills?.length ?? 0} skills, {mcpEntries.length} MCP)
                  </span>
                </p>
              </div>
            </div>
          </div>
        </Section>

        {/* ── All enable* flags (full grid, including disabled) ── */}
        <Section title="All Tool Extensions" icon={Layers}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {enableFlags.map(({ key, label, tools }) => {
              const enabled = agentAny[key] === true;
              return (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <div className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 cursor-help transition-colors",
                      enabled
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-border bg-muted/10"
                    )}>
                      {enabled ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
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
        </Section>

      </div>
    </ScrollArea>
  );
}
