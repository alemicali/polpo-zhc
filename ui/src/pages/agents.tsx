import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  Loader2,
  Settings2,
  Cpu,
  Wrench,
  RefreshCw,
  ChevronDown,
  Search,
  Zap,
  FileCode,
  FilePlus,
  FileEdit,
  Activity,
  Sparkles,
  Hash,
  Shield,
  Users,
  CheckCircle2,
  XCircle,
  Layers,
  Server,
  Infinity,
  BookOpen,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useAgents, useProcesses, useSkills } from "@openpolpo/react-sdk";
import type { AgentConfig, AgentProcess, SkillInfo } from "@openpolpo/react-sdk";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Adapter config ──

const adapterMeta: Record<
  string,
  {
    icon: React.ElementType;
    label: string;
    color: string;
    bg: string;
    description: string;
    features: { tools: boolean; skills: boolean; mcp: boolean; multiProvider: boolean; sessions: boolean };
  }
> = {
  engine: {
    icon: Cpu,
    label: "Engine",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    description: "Polpo's built-in Pi Agent engine. Multi-provider (Anthropic, OpenAI, Google, Groq). 7 built-in coding tools.",
    features: { tools: true, skills: true, mcp: false, multiProvider: true, sessions: false },
  },
  "claude-sdk": {
    icon: Bot,
    label: "Claude SDK",
    color: "text-violet-400",
    bg: "bg-violet-500/10",
    description: "Anthropic Claude Code SDK. Full tool suite, skills, MCP servers, session persistence.",
    features: { tools: true, skills: true, mcp: true, multiProvider: false, sessions: true },
  },
};

function getAdapterMeta(adapter?: string) {
  const key = adapter ?? "engine";
  return adapterMeta[key] ?? {
    icon: Settings2,
    label: key,
    color: "text-zinc-400",
    bg: "bg-zinc-500/10",
    description: `Custom adapter: ${key}`,
    features: { tools: false, skills: false, mcp: false, multiProvider: false, sessions: false },
  };
}

// ── Feature dot ──

function FeatureDot({ supported, label }: { supported: boolean; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 cursor-help">
          {supported ? (
            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          ) : (
            <XCircle className="h-3 w-3 text-zinc-600" />
          )}
          <span className={cn("text-[10px]", supported ? "text-foreground" : "text-muted-foreground/50")}>
            {label}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {label}: {supported ? "Supported" : "Not available"}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Skills pool (project-level) ──

function SkillsPool({
  skills,
  agents,
}: {
  skills: SkillInfo[];
  agents: AgentConfig[];
}) {
  if (skills.length === 0) return null;

  // Build usage map: skill name → agent names using it
  const usageMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const skill of skills) map.set(skill.name, []);
    for (const agent of agents) {
      for (const s of agent.skills ?? []) {
        const list = map.get(s);
        if (list) list.push(agent.name);
        else map.set(s, [agent.name]);
      }
    }
    return map;
  }, [skills, agents]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5" /> Project Skills
          <Badge variant="secondary" className="text-[9px] ml-1">{skills.length}</Badge>
          <span className="font-normal text-[10px] ml-2">
            Discovered from <code className="font-mono">.claude/skills/</code> &mdash; claude-sdk adapter only
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {skills.map((skill) => {
            const users = usageMap.get(skill.name) ?? [];
            return (
              <div
                key={skill.name}
                className="rounded-md border border-border bg-muted/20 px-3 py-2 space-y-1"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3 w-3 text-violet-400 shrink-0" />
                  <span className="text-xs font-medium truncate">{skill.name}</span>
                  {users.length > 0 ? (
                    <Badge variant="secondary" className="text-[9px] ml-auto shrink-0">
                      {users.length} agent{users.length !== 1 ? "s" : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] ml-auto shrink-0 text-muted-foreground">
                      unused
                    </Badge>
                  )}
                </div>
                {skill.description && (
                  <p className="text-[10px] text-muted-foreground line-clamp-2">{skill.description}</p>
                )}
                <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                  <Badge variant="outline" className="text-[8px] px-1 py-0">{skill.source}</Badge>
                  <span className="font-mono truncate" title={skill.path}>{skill.path}</span>
                </div>
                {users.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {users.map(u => (
                      <span key={u} className="text-[9px] font-mono text-muted-foreground">{u}</span>
                    ))}
                  </div>
                )}
                {skill.allowedTools && skill.allowedTools.length > 0 && (
                  <div className="flex items-center gap-1 pt-0.5">
                    <Wrench className="h-2.5 w-2.5 text-muted-foreground" />
                    {skill.allowedTools.slice(0, 4).map(t => (
                      <Badge key={t} variant="outline" className="text-[8px] py-0 px-1 font-mono">{t}</Badge>
                    ))}
                    {skill.allowedTools.length > 4 && (
                      <span className="text-[8px] text-muted-foreground">+{skill.allowedTools.length - 4}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Base team header ──

function BaseTeamHeader({
  teamName,
  teamDescription,
  agents,
  processes,
  volatileGroupCount,
}: {
  teamName: string;
  teamDescription?: string;
  agents: AgentConfig[]; // permanent only
  processes: AgentProcess[];
  volatileGroupCount: number;
}) {
  const activeCount = processes.filter(p => agents.some(a => a.name === p.agentName)).length;
  const utilization = agents.length > 0 ? Math.round((activeCount / agents.length) * 100) : 0;

  // Adapter distribution (permanent only)
  const adapterCounts = agents.reduce<Record<string, number>>((acc, a) => {
    const key = a.adapter ?? "engine";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="space-y-3">
          {/* Team name + description */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Users className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold">{teamName}</h3>
                <Badge variant="secondary" className="text-[9px]">Base Team</Badge>
              </div>
              {teamDescription && (
                <p className="text-xs text-muted-foreground">{teamDescription}</p>
              )}
            </div>
            {volatileGroupCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-help">
                    <Zap className="h-3.5 w-3.5 text-amber-400" />
                    <span className="text-xs font-bold">{volatileGroupCount}</span>
                    <span className="text-[10px] text-muted-foreground">plan team{volatileGroupCount !== 1 ? "s" : ""}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="text-xs max-w-60">
                  Volatile teams created by plans. Each plan can spawn its own agents that are auto-cleaned when the plan completes.
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-1.5">
              <div className={cn("h-2 w-2 rounded-full", activeCount > 0 ? "bg-blue-500 animate-pulse" : "bg-zinc-600")} />
              <span className="text-xs text-muted-foreground">Active</span>
              <span className="text-xs font-bold">{activeCount}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-muted-foreground">Agents</span>
              <span className="text-xs font-bold">{agents.length}</span>
            </div>
            <div className="h-4 w-px bg-border" />
            {/* Adapter breakdown */}
            <div className="flex items-center gap-3">
              {Object.entries(adapterCounts).map(([adapter, count]) => {
                const meta = getAdapterMeta(adapter);
                const Icon = meta.icon;
                return (
                  <Tooltip key={adapter}>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 cursor-help">
                        <Icon className={cn("h-3.5 w-3.5", meta.color)} />
                        <span className="text-xs font-bold">{count}</span>
                        <span className="text-[10px] text-muted-foreground">{meta.label}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs max-w-60">{meta.description}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          {/* Utilization */}
          <div className="flex items-center gap-3 max-w-xs">
            <span className="text-[10px] text-muted-foreground shrink-0">Utilization</span>
            <Progress value={utilization} className="h-1.5 flex-1" />
            <span className="text-[10px] font-mono w-8 text-right">{utilization}%</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Volatile team section header ──

function VolatileTeamHeader({
  planGroup,
  agents,
  processes,
}: {
  planGroup: string;
  agents: AgentConfig[];
  processes: AgentProcess[];
}) {
  const activeCount = processes.filter(p => agents.some(a => a.name === p.agentName)).length;
  const adapterCounts = agents.reduce<Record<string, number>>((acc, a) => {
    const key = a.adapter ?? "engine";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500/10">
          <Zap className="h-3.5 w-3.5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">Plan Team</h4>
            <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
              {planGroup}
            </Badge>
            <Badge variant="secondary" className="text-[9px]">
              {agents.length} agent{agents.length !== 1 ? "s" : ""}
            </Badge>
            {activeCount > 0 && (
              <Badge variant="outline" className="text-[9px] text-blue-400 border-blue-500/30">
                {activeCount} active
              </Badge>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Volatile agents created for this plan &mdash; auto-removed on plan completion
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {Object.entries(adapterCounts).map(([adapter, count]) => {
            const meta = getAdapterMeta(adapter);
            const Icon = meta.icon;
            return (
              <div key={adapter} className="flex items-center gap-1">
                <Icon className={cn("h-3 w-3", meta.color)} />
                <span className="text-[10px] font-bold">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Adapter feature matrix ──

function AdapterFeatureMatrix({ agents }: { agents: AgentConfig[] }) {
  const usedAdapters = [...new Set(agents.map(a => a.adapter ?? "engine"))];
  if (usedAdapters.length <= 1) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Server className="h-3.5 w-3.5" /> Adapter Capabilities
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${usedAdapters.length}, 1fr)` }}>
          {usedAdapters.map(adapter => {
            const meta = getAdapterMeta(adapter);
            const Icon = meta.icon;
            const f = meta.features;
            return (
              <div key={adapter} className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className={cn("flex h-6 w-6 items-center justify-center rounded", meta.bg)}>
                    <Icon className={cn("h-3.5 w-3.5", meta.color)} />
                  </div>
                  <span className="text-xs font-medium">{meta.label}</span>
                </div>
                <div className="space-y-1">
                  <FeatureDot supported={f.tools} label="Built-in Tools" />
                  <FeatureDot supported={f.skills} label="Skills" />
                  <FeatureDot supported={f.mcp} label="MCP Servers" />
                  <FeatureDot supported={f.multiProvider} label="Multi-provider" />
                  <FeatureDot supported={f.sessions} label="Sessions" />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Live activity panel (inside agent card) ──

function LiveActivity({ process }: { process: AgentProcess }) {
  const act = process.activity;
  const totalFiles = (act.filesCreated?.length ?? 0) + (act.filesEdited?.length ?? 0);

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn("h-2 w-2 rounded-full", process.alive ? "bg-blue-500 animate-pulse" : "bg-zinc-500")} />
          <span className="text-[10px] font-medium text-blue-400 uppercase tracking-wider">
            {process.alive ? "Active" : "Finished"}
          </span>
          <Badge variant="secondary" className="text-[9px]">PID {process.pid}</Badge>
          {act.sessionId && (
            <span className="text-[9px] font-mono text-muted-foreground">session:{act.sessionId.slice(0, 8)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {act.lastUpdate && (
            <span>updated {formatDistanceToNow(new Date(act.lastUpdate), { addSuffix: true })}</span>
          )}
          <span>started {formatDistanceToNow(new Date(process.startedAt), { addSuffix: true })}</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {act.summary
          ? act.summary
          : act.lastTool && act.lastFile
          ? <>Using <span className="font-mono text-foreground">{act.lastTool}</span> on <code className="text-foreground">{act.lastFile}</code></>
          : act.lastTool
          ? <>Using <span className="font-mono text-foreground">{act.lastTool}</span></>
          : "Running..."}
      </p>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Wrench className="h-3 w-3" />
          <span className="font-mono font-bold text-foreground">{act.toolCalls}</span> calls
        </div>
        {totalFiles > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <FileCode className="h-3 w-3" />
            <span className="font-mono font-bold text-foreground">{totalFiles}</span> files
          </div>
        )}
        {act.totalTokens != null && act.totalTokens > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Hash className="h-3 w-3" />
            <span className="font-mono font-bold text-foreground">{(act.totalTokens / 1000).toFixed(1)}k</span> tokens
          </div>
        )}
      </div>

      {/* File lists */}
      {act.filesCreated && act.filesCreated.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1">
            <FilePlus className="h-2.5 w-2.5 text-emerald-400" /> Created
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesCreated.slice(0, 8).map((f) => (
              <Badge key={f} variant="secondary" className="text-[9px] font-mono max-w-[200px] truncate">
                {f.split("/").pop()}
              </Badge>
            ))}
            {act.filesCreated.length > 8 && (
              <Badge variant="secondary" className="text-[9px]">+{act.filesCreated.length - 8}</Badge>
            )}
          </div>
        </div>
      )}
      {act.filesEdited && act.filesEdited.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-1">
            <FileEdit className="h-2.5 w-2.5 text-amber-400" /> Edited
          </p>
          <div className="flex flex-wrap gap-1">
            {act.filesEdited.slice(0, 8).map((f) => (
              <Badge key={f} variant="outline" className="text-[9px] font-mono max-w-[200px] truncate">
                {f.split("/").pop()}
              </Badge>
            ))}
            {act.filesEdited.length > 8 && (
              <Badge variant="outline" className="text-[9px]">+{act.filesEdited.length - 8}</Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Agent card (read-only, full inspection) ──

function AgentCard({
  agent,
  process,
  skillPool,
}: {
  agent: AgentConfig;
  process?: AgentProcess;
  skillPool: Map<string, SkillInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = getAdapterMeta(agent.adapter);
  const AdapterIcon = meta.icon;

  const capabilityCount =
    (agent.allowedTools?.length ?? 0) +
    (agent.skills?.length ?? 0) +
    (agent.mcpServers ? Object.keys(agent.mcpServers).length : 0);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className={cn(
        "rounded-lg border transition-colors bg-card",
        process ? "border-blue-500/30" : "border-border hover:border-border/80"
      )}>
        <CollapsibleTrigger asChild>
          <div className="flex items-center gap-3 p-4 cursor-pointer">
            {/* Adapter icon */}
            <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", meta.bg)}>
              <AdapterIcon className={cn("h-5 w-5", meta.color)} />
            </div>

            {/* Name + meta */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium truncate">{agent.name}</p>
                {agent.volatile && (
                  <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                    <Zap className="h-2.5 w-2.5 mr-0.5" /> volatile
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <Badge variant="outline" className={cn("text-[9px] py-0 px-1.5", meta.color)}>
                  {meta.label}
                </Badge>
                {agent.model && (
                  <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                    {agent.model}
                  </span>
                )}
                {agent.role && (
                  <span className="text-[10px] text-muted-foreground truncate max-w-[200px] hidden lg:inline">
                    &middot; {agent.role}
                  </span>
                )}
              </div>
            </div>

            {/* Right side: status + badges */}
            <div className="flex items-center gap-2 shrink-0">
              {process && (
                <div className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                  <span className="text-[10px] text-blue-400 font-medium">Working</span>
                </div>
              )}
              {agent.maxConcurrency != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="text-[10px] cursor-help">
                      <Layers className="h-2.5 w-2.5 mr-0.5" />
                      {agent.maxConcurrency}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Max {agent.maxConcurrency} concurrent tasks</TooltipContent>
                </Tooltip>
              )}
              {agent.maxTurns != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="text-[10px] cursor-help">
                      <Hash className="h-2.5 w-2.5 mr-0.5" />
                      {agent.maxTurns}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Max {agent.maxTurns} turns per task</TooltipContent>
                </Tooltip>
              )}
              {capabilityCount > 0 && (
                <span className="text-[10px] text-muted-foreground">{capabilityCount} capabilities</span>
              )}
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
            </div>
          </div>
        </CollapsibleTrigger>

        {/* Live activity strip for running agents */}
        {process && !expanded && (
          <div className="flex items-center gap-3 px-4 py-1.5 bg-blue-500/5 border-t border-blue-500/10">
            <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
            {process.activity.lastTool && (
              <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0 text-blue-400 border-blue-400/30 shrink-0">
                <Wrench className="h-2 w-2 mr-0.5" />
                {process.activity.lastTool}
              </Badge>
            )}
            {process.activity.lastFile && (
              <span className="text-[10px] font-mono text-muted-foreground truncate">
                {process.activity.lastFile.split("/").pop()}
              </span>
            )}
            {process.activity.summary && !process.activity.lastTool && (
              <span className="text-[10px] text-muted-foreground truncate">{process.activity.summary}</span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {process.activity.toolCalls} calls
            </span>
          </div>
        )}

        <CollapsibleContent>
          <div className="border-t border-border px-4 py-4 space-y-4">
            {/* Role as markdown */}
            {agent.role && (
              <div>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <Shield className="h-3 w-3" /> Role
                </p>
                <div className="rounded-md bg-muted/30 px-3 py-2 text-xs">
                  <MessageResponse>{agent.role}</MessageResponse>
                </div>
              </div>
            )}

            {/* System prompt */}
            {agent.systemPrompt && (
              <div>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                  System Prompt
                </p>
                <div className="rounded-md bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground line-clamp-6 font-mono whitespace-pre-wrap">{agent.systemPrompt}</p>
                </div>
              </div>
            )}

            {/* Capabilities grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Tools */}
              {agent.allowedTools && agent.allowedTools.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                    <Wrench className="h-3 w-3" /> Tools ({agent.allowedTools.length})
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {agent.allowedTools.map((t) => (
                      <Badge key={t} variant="secondary" className="text-[9px] font-mono">{t}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Skills — enriched with pool info */}
              {agent.skills && agent.skills.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Skills ({agent.skills.length})
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {agent.skills.map((s) => {
                      const info = skillPool.get(s);
                      return info ? (
                        <Tooltip key={s}>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="text-[9px] cursor-help">{s}</Badge>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs max-w-60">
                            {info.description || "No description"}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <Badge key={s} variant="outline" className="text-[9px] text-muted-foreground">{s}</Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* MCP Servers */}
              {agent.mcpServers && Object.keys(agent.mcpServers).length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                    <Activity className="h-3 w-3" /> MCP Servers ({Object.keys(agent.mcpServers).length})
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(agent.mcpServers).map(([name, cfg]) => {
                      const type = "command" in cfg ? "stdio" : ("type" in cfg ? cfg.type : "http");
                      const detail = "command" in cfg
                        ? `${cfg.command} ${"args" in cfg && Array.isArray(cfg.args) ? cfg.args.join(" ") : ""}`.trim()
                        : ("url" in cfg ? cfg.url : "");
                      return (
                        <Badge key={name} variant="secondary" className="text-[9px] font-mono" title={detail}>
                          {name} <span className="text-muted-foreground ml-0.5">({type})</span>
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Allowed Paths (sandbox) */}
              {agent.allowedPaths && agent.allowedPaths.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                    <Shield className="h-3 w-3" /> Allowed Paths ({agent.allowedPaths.length})
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {agent.allowedPaths.map((p) => (
                      <Badge key={p} variant="outline" className="text-[9px] font-mono">{p}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Adapter features for this agent */}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Settings2 className="h-3 w-3" /> Adapter Features
              </p>
              <div className="flex items-center gap-4">
                <FeatureDot supported={meta.features.tools} label="Tools" />
                <FeatureDot supported={meta.features.skills} label="Skills" />
                <FeatureDot supported={meta.features.mcp} label="MCP" />
                <FeatureDot supported={meta.features.multiProvider} label="Multi-provider" />
                <FeatureDot supported={meta.features.sessions} label="Sessions" />
              </div>
            </div>

            {/* Metadata row */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              {agent.maxTurns != null && (
                <span>Max turns: <span className="font-mono text-foreground">{agent.maxTurns}</span></span>
              )}
              {agent.maxConcurrency != null && (
                <span>Max concurrency: <span className="font-mono text-foreground">{agent.maxConcurrency}</span></span>
              )}
              {agent.maxConcurrency == null && (
                <span className="flex items-center gap-1">
                  Concurrency: <Infinity className="h-3 w-3 inline" />
                </span>
              )}
              {agent.volatile && <span className="text-amber-400">Volatile (auto-cleanup on plan complete)</span>}
              {agent.planGroup && <span>Plan group: <span className="font-mono text-foreground">{agent.planGroup}</span></span>}
            </div>

            {/* Live activity (expanded view) */}
            {process && <LiveActivity process={process} />}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── Adapter group section ──

function AdapterGroup({
  adapter,
  agents,
  processes,
  skillPool,
}: {
  adapter: string;
  agents: AgentConfig[];
  processes: AgentProcess[];
  skillPool: Map<string, SkillInfo>;
}) {
  const meta = getAdapterMeta(adapter);
  const Icon = meta.icon;
  const activeInGroup = agents.filter(a => processes.some(p => p.agentName === a.name)).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className={cn("flex h-5 w-5 items-center justify-center rounded", meta.bg)}>
          <Icon className={cn("h-3 w-3", meta.color)} />
        </div>
        <span className="text-xs font-medium">{meta.label}</span>
        <Badge variant="secondary" className="text-[9px]">{agents.length}</Badge>
        {activeInGroup > 0 && (
          <Badge variant="outline" className="text-[9px] text-blue-400 border-blue-500/30">
            {activeInGroup} active
          </Badge>
        )}
        <Separator className="flex-1" />
      </div>
      <div className="space-y-2">
        {agents.map((agent) => (
          <AgentCard
            key={agent.name}
            agent={agent}
            process={processes.find((p) => p.agentName === agent.name)}
            skillPool={skillPool}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main page ──

type ViewMode = "teams" | "adapters" | "flat";

export function AgentsPage() {
  const { agents, team, isLoading: loading, refetch } = useAgents();
  const { processes } = useProcesses();
  const { skills, refetch: refetchSkills } = useSkills();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>("teams");

  // Build skill pool map for enriched tooltips
  const skillPool = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const s of skills) map.set(s.name, s);
    return map;
  }, [skills]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Filter
  const filtered = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      (a.adapter ?? "engine").toLowerCase().includes(q) ||
      (a.role ?? "").toLowerCase().includes(q) ||
      (a.model ?? "").toLowerCase().includes(q) ||
      (a.skills ?? []).some(s => s.toLowerCase().includes(q)) ||
      (a.planGroup ?? "").toLowerCase().includes(q)
    );
  });

  // Split: permanent vs volatile
  const permanentAgents = filtered.filter(a => !a.volatile);
  const volatileAgents = filtered.filter(a => a.volatile);

  // Group volatile by planGroup
  const volatileGroups = volatileAgents.reduce<Record<string, AgentConfig[]>>((acc, a) => {
    const group = a.planGroup ?? "unknown";
    if (!acc[group]) acc[group] = [];
    acc[group].push(a);
    return acc;
  }, {});
  const volatileGroupNames = Object.keys(volatileGroups).sort();

  // For adapter view: group all filtered agents by adapter
  const adapterGroups = filtered.reduce<Record<string, AgentConfig[]>>((acc, a) => {
    const key = a.adapter ?? "engine";
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});
  const adapterOrder = ["engine", "claude-sdk"];
  const sortedAdapters = Object.keys(adapterGroups).sort((a, b) => {
    const ia = adapterOrder.indexOf(a);
    const ib = adapterOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  // Total volatile groups (unfiltered) for the header badge
  const allVolatileGroups = new Set(agents.filter(a => a.volatile && a.planGroup).map(a => a.planGroup!));

  const handleRefresh = async () => {
    await Promise.all([refetch(), refetchSkills()]);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Base team header */}
      <BaseTeamHeader
        teamName={team?.name ?? "Team"}
        teamDescription={team?.description}
        agents={agents.filter(a => !a.volatile)}
        processes={processes}
        volatileGroupCount={allVolatileGroups.size}
      />

      {/* Skills pool */}
      <SkillsPool skills={skills} agents={agents} />

      {/* Feature matrix (only if multiple adapters across all agents) */}
      <AdapterFeatureMatrix agents={agents} />

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents, skills, adapters..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={view === "teams" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 px-2.5"
                onClick={() => setView("teams")}
              >
                <Users className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Group by team</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={view === "adapters" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 px-2.5"
                onClick={() => setView("adapters")}
              >
                <Layers className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Group by adapter</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={view === "flat" ? "secondary" : "ghost"}
                size="sm"
                className="h-8 px-2.5"
                onClick={() => setView("flat")}
              >
                <Bot className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Flat list</TooltipContent>
          </Tooltip>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Agent list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-5 pr-4 pb-2">
          {filtered.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Bot className="h-12 w-12 mb-4 opacity-40" />
                <p className="text-sm font-medium">
                  {search ? "No agents match your search" : "No agents configured"}
                </p>
                <p className="text-xs mt-1 text-center max-w-xs">
                  {search
                    ? "Try a different search term"
                    : "Agents are configured in the team section of .polpo/polpo.json or created dynamically by plans."}
                </p>
              </CardContent>
            </Card>
          ) : view === "teams" ? (
            <>
              {/* Permanent (base) team */}
              {permanentAgents.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-5 w-5 items-center justify-center rounded bg-emerald-500/10">
                      <Users className="h-3 w-3 text-emerald-400" />
                    </div>
                    <span className="text-xs font-medium">Permanent Agents</span>
                    <Badge variant="secondary" className="text-[9px]">{permanentAgents.length}</Badge>
                    <Separator className="flex-1" />
                  </div>
                  <div className="space-y-2">
                    {permanentAgents.map((agent) => (
                      <AgentCard
                        key={agent.name}
                        agent={agent}
                        process={processes.find((p) => p.agentName === agent.name)}
                        skillPool={skillPool}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Volatile teams — one section per planGroup */}
              {volatileGroupNames.map(group => (
                <section key={group} className="space-y-2">
                  <VolatileTeamHeader
                    planGroup={group}
                    agents={volatileGroups[group]}
                    processes={processes}
                  />
                  <div className="space-y-2 pl-2 border-l-2 border-amber-500/20 ml-3">
                    {volatileGroups[group].map((agent) => (
                      <AgentCard
                        key={agent.name}
                        agent={agent}
                        process={processes.find((p) => p.agentName === agent.name)}
                        skillPool={skillPool}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          ) : view === "adapters" ? (
            sortedAdapters.map(adapter => (
              <AdapterGroup
                key={adapter}
                adapter={adapter}
                agents={adapterGroups[adapter]}
                processes={processes}
                skillPool={skillPool}
              />
            ))
          ) : (
            filtered.map((agent) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                process={processes.find((p) => p.agentName === agent.name)}
                skillPool={skillPool}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
