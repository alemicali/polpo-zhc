import { useState, useMemo, useCallback, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAsyncAction } from "@/hooks/use-polpo";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  Loader2,
  Wrench,
  RefreshCw,
  Search,
  Zap,
  Users,
  ChevronRight,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  LayoutList,
  Network,
  FolderPlus,
} from "lucide-react";
import { useAgents, useProcesses } from "@lumea-labs/polpo-react";
import type { AgentConfig, AgentProcess, Team } from "@lumea-labs/polpo-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { cn } from "@/lib/utils";

// Team colors for visual distinction in org chart
const TEAM_COLORS = [
  { bg: "bg-primary/10", border: "border-primary/30", text: "text-primary", dot: "bg-primary" },
  { bg: "bg-violet-500/10", border: "border-violet-500/30", text: "text-violet-400", dot: "bg-violet-400" },
  { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400" },
  { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400" },
  { bg: "bg-rose-500/10", border: "border-rose-500/30", text: "text-rose-400", dot: "bg-rose-400" },
  { bg: "bg-cyan-500/10", border: "border-cyan-500/30", text: "text-cyan-400", dot: "bg-cyan-400" },
];

function getTeamColor(index: number) {
  return TEAM_COLORS[index % TEAM_COLORS.length];
}


// ─── Add Agent Dialog ────────────────────────────────────

function AddAgentDialog({
  teams,
  onAdd,
}: {
  teams: Team[];
  onAdd: (req: { name: string; role?: string; model?: string }, teamName?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [selectedTeam, setSelectedTeam] = useState(teams[0]?.name ?? "");

  const [handleSubmit, isSubmitting] = useAsyncAction(async () => {
    if (!name.trim()) return;
    await onAdd(
      { name: name.trim(), role: role.trim() || undefined, model: model.trim() || undefined },
      selectedTeam || undefined,
    );
    setName("");
    setRole("");
    setModel("");
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) setSelectedTeam(teams[0]?.name ?? ""); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Agent</DialogTitle>
          <DialogDescription>
            Add a new agent to your team. Configure advanced settings later from the agent detail page.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
          {teams.length > 1 && (
            <div className="space-y-2">
              <span className="text-sm font-medium">Team</span>
              <div className="flex flex-wrap gap-2">
                {teams.map(t => (
                  <button
                    key={t.name}
                    type="button"
                    className={cn(
                      "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                      selectedTeam === t.name
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "border-border/40 text-muted-foreground hover:border-primary/20",
                    )}
                    onClick={() => setSelectedTeam(t.name)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <span className="text-sm font-medium">Name</span>
            <Input placeholder="e.g. frontend-dev" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <p className="text-[11px] text-muted-foreground">Unique identifier. Use lowercase and hyphens.</p>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Role</span>
            <Input placeholder="e.g. Frontend developer specializing in React" value={role} onChange={(e) => setRole(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Helps the orchestrator assign the right tasks.</p>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <Input placeholder="e.g. claude-sonnet-4-20250514" value={model} onChange={(e) => setModel(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Leave empty to use the project default.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Team Dialog ─────────────────────────────────────

function AddTeamDialog({
  onAdd,
}: {
  onAdd: (req: { name: string; description?: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [handleSubmit, isSubmitting] = useAsyncAction(async () => {
    if (!name.trim()) return;
    await onAdd({ name: name.trim(), description: description.trim() || undefined });
    setName("");
    setDescription("");
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <FolderPlus className="h-3.5 w-3.5" />
          Add Team
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Team</DialogTitle>
          <DialogDescription>
            Create a new team to organize your agents. You can move agents between teams later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
          <div className="space-y-2">
            <span className="text-sm font-medium">Name</span>
            <Input placeholder="e.g. backend" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">Description</span>
            <Input placeholder="e.g. Backend API and database team" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Team"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Remove Agent Confirmation Dialog ────────────────────

function RemoveAgentDialog({
  agentName,
  onRemove,
}: {
  agentName: string;
  onRemove: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [handleRemove, isRemoving] = useAsyncAction(async () => {
    await onRemove(agentName);
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
          title="Remove agent"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove Agent</DialogTitle>
          <DialogDescription>
            Remove <strong>{agentName}</strong> from the team? This updates your <code className="text-[11px] bg-muted px-1 py-0.5 rounded">polpo.json</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isRemoving}>Cancel</Button>
          <Button variant="destructive" onClick={handleRemove} disabled={isRemoving}>
            {isRemoving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Inline Team Name Editor ─────────────────────────────

function TeamNameEditor({
  teamName,
  teamDescription,
  onRename,
}: {
  teamName: string;
  teamDescription?: string;
  onRename: (oldName: string, newName: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(teamName);
  const [handleSave, isSaving] = useAsyncAction(async () => {
    if (!value.trim() || value.trim() === teamName) { setEditing(false); return; }
    await onRename(teamName, value.trim());
    setEditing(false);
  });

  if (editing) {
    return (
      <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
        <Input
          value={value} onChange={(e) => setValue(e.target.value)}
          className="h-6 text-sm font-semibold w-40 px-1.5" autoFocus
          onKeyDown={(e) => { if (e.key === "Escape") { setValue(teamName); setEditing(false); } }}
        />
        <button type="submit" disabled={isSaving || !value.trim()} className="p-0.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-50">
          {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => { setValue(teamName); setEditing(false); }} className="p-0.5 rounded text-muted-foreground hover:bg-muted/30 transition-colors">
          <X className="h-3 w-3" />
        </button>
      </form>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="flex items-center gap-1.5 group/name cursor-pointer" onClick={() => { setValue(teamName); setEditing(true); }}>
          <span className="text-sm font-semibold">{teamName}</span>
          <Pencil className="h-2.5 w-2.5 text-muted-foreground opacity-0 group-hover/name:opacity-100 transition-opacity" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-xs max-w-60">{teamDescription ?? "Click to rename team"}</TooltipContent>
    </Tooltip>
  );
}

// ─── Summary Header ──────────────────────────────────────

function SummaryHeader({
  teams,
  agents,
  processes,
}: {
  teams: Team[];
  agents: AgentConfig[];
  processes: AgentProcess[];
}) {
  const activeCount = processes.filter(p => agents.some(a => a.name === p.agentName)).length;
  const utilization = agents.length > 0 ? Math.round((activeCount / agents.length) * 100) : 0;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm px-3 py-2">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] text-muted-foreground">Teams</span>
          <span className="text-[11px] font-bold">{teams.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-[11px] text-muted-foreground">Agents</span>
          <span className="text-[11px] font-bold">{agents.length}</span>
        </div>

      </div>
      <div className="flex items-center gap-2 ml-auto shrink-0">
        <Progress value={utilization} className="h-1.5 w-20" />
        <span className="text-[10px] font-mono text-muted-foreground w-7 text-right">{utilization}%</span>
      </div>
    </div>
  );
}

// ─── Agent Card (list view) ──────────────────────────────

function AgentCard({
  agent,
  process,
  onRemove,
  teamColor,
}: {
  agent: AgentConfig;
  process?: AgentProcess;
  onRemove?: (name: string) => Promise<void>;
  teamColor?: ReturnType<typeof getTeamColor>;
}) {
  const capabilityCount =
    (agent.allowedTools?.length ?? 0) + (agent.skills?.length ?? 0) + (agent.mcpServers ? Object.keys(agent.mcpServers).length : 0);

  return (
    <Link to={`/agents/${encodeURIComponent(agent.name)}`} className="block group">
      <div className={cn(
        "rounded-lg border transition-all bg-card/80 backdrop-blur-sm hover:bg-accent/5",
        process ? "border-primary/30 shadow-[0_0_20px_oklch(0.7_0.15_200_/_8%)]" : "border-border/40 hover:border-primary/20",
      )}>
        <div className="flex items-center gap-3 p-4">
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", teamColor?.bg ?? "bg-primary/10")}>
            <AgentAvatar avatar={agent.identity?.avatar} name={agent.name} size="lg" iconClassName={teamColor?.text ?? "text-primary"} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                {agent.identity?.displayName ?? agent.name}
              </span>
              {agent.identity?.displayName && agent.identity.displayName !== agent.name && (
                <span className="text-[10px] font-mono text-muted-foreground">@{agent.name}</span>
              )}
              {!!agent.volatile && (
                <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                  <Zap className="h-2.5 w-2.5 mr-0.5" /> mission
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {agent.identity?.title && <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">{agent.identity.title}</span>}
              {agent.model && (
                <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                  {agent.identity?.title ? <>&middot; </> : ""}{agent.model}
                </span>
              )}
              {agent.role && !agent.identity?.title && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[200px] hidden lg:inline">&middot; {agent.role}</span>
              )}
              {agent.reportsTo && (
                <span className="text-[10px] text-muted-foreground hidden md:inline">&middot; reports to <span className="font-mono">{agent.reportsTo}</span></span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {process && (
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="text-[10px] text-primary font-medium">Working</span>
              </div>
            )}
            {capabilityCount > 0 && <Badge variant="secondary" className="text-[10px] hidden sm:flex">{capabilityCount} cap.</Badge>}
            {onRemove && !agent.volatile && <RemoveAgentDialog agentName={agent.name} onRemove={onRemove} />}
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>
        {process && (
          <div className="flex items-center gap-3 px-4 py-1.5 bg-primary/5 border-t border-primary/10">
            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            {process.activity.lastTool && (
              <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0 text-primary border-primary/30 shrink-0">
                <Wrench className="h-2 w-2 mr-0.5" />{process.activity.lastTool}
              </Badge>
            )}
            {process.activity.lastFile && <span className="text-[10px] font-mono text-muted-foreground truncate">{process.activity.lastFile.split("/").pop()}</span>}
            {process.activity.summary && !process.activity.lastTool && <span className="text-[10px] text-muted-foreground truncate">{process.activity.summary}</span>}
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{process.activity.toolCalls} calls</span>
          </div>
        )}
      </div>
    </Link>
  );
}

// ─── Org Chart: custom nodes ─────────────────────────────

type TeamHeaderNodeData = {
  label: string;
  teamColorIdx: number;
  agentCount: number;
  onClick: () => void;
};

type AgentNodeData = {
  label: string;
  agent: AgentConfig;
  isActive: boolean;
  subordinateCount: number;
  teamName: string;
  teamColorIdx: number;
};

/** Team header — compact box with team name + agent count badge */
function TeamHeaderNode({ data }: NodeProps<Node<TeamHeaderNodeData>>) {
  const tc = getTeamColor(data.teamColorIdx);
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl border-2 bg-card shadow-md px-4 py-2.5 cursor-pointer select-none transition-all hover:shadow-lg",
        tc.border, tc.bg,
      )}
      onClick={data.onClick}
    >
      <Users className={cn("h-4 w-4 shrink-0", tc.text)} />
      <span className={cn("text-sm font-bold whitespace-nowrap", tc.text)}>{data.label}</span>
      <Badge variant="secondary" className={cn("text-[10px] shrink-0 font-bold", tc.text)}>
        {data.agentCount}
      </Badge>
      <Handle type="source" position={Position.Bottom} className="!bg-primary/60 !w-2 !h-2 !border-0" />
    </div>
  );
}

function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  const navigate = useNavigate();
  const { agent, isActive, subordinateCount, teamColorIdx } = data;
  const displayName = agent.identity?.displayName ?? agent.name;
  const tc = getTeamColor(teamColorIdx);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card shadow-md cursor-pointer transition-all hover:shadow-lg select-none",
        selected
          ? `border-primary shadow-[0_0_24px_oklch(0.7_0.15_200_/_18%)] ring-2 ring-primary/30`
          : isActive
            ? `${tc.border} shadow-[0_0_24px_oklch(0.7_0.15_200_/_12%)]`
            : "border-border/50 hover:border-primary/40",
      )}
      style={{ minWidth: 180, maxWidth: 240 }}
    >
      <Handle type="target" position={Position.Top} className="!bg-primary/60 !w-2 !h-2 !border-0" />
      <div className="px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-2.5">
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", tc.bg)}>
            <AgentAvatar avatar={agent.identity?.avatar} name={agent.name} size="md" iconClassName={tc.text} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold truncate">{displayName}</span>
              {isActive && <div className={cn("h-2 w-2 rounded-full animate-pulse shrink-0", tc.dot)} />}
            </div>
            {agent.identity?.displayName && agent.identity.displayName !== agent.name && (
              <span className="text-[10px] font-mono text-muted-foreground block truncate">@{agent.name}</span>
            )}
          </div>
        </div>
        {(agent.identity?.title || agent.role) && (
          <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">{agent.identity?.title ?? agent.role}</p>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          {agent.model && <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-mono">{agent.model}</Badge>}
          {!!agent.volatile && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-amber-400 border-amber-500/30">
              <Zap className="h-2 w-2 mr-0.5" /> mission
            </Badge>
          )}
          {subordinateCount > 0 && <Badge variant="outline" className="text-[9px] px-1.5 py-0">{subordinateCount} report{subordinateCount !== 1 ? "s" : ""}</Badge>}
        </div>
      </div>
      {/* Navigate button — only visible when selected */}
      {selected && (
        <div className="flex items-center border-t border-border/30 px-3 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-6 w-full text-[11px] font-medium gap-1", tc.text)}
            onClick={(e) => { e.stopPropagation(); navigate(`/agents/${encodeURIComponent(agent.name)}`); }}
          >
            View details
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-primary/60 !w-2 !h-2 !border-0" />
    </div>
  );
}

const nodeTypes = { agent: AgentNode, teamHeader: TeamHeaderNode };

// ─── Org Chart: layout helpers ───────────────────────────

const NODE_W = 210;
const NODE_H = 140;
const H_GAP = 40;
const V_GAP = 60;
const TEAM_HEADER_H = 56;
const LEVEL_GAP = 200;

/** Derive team hierarchy levels from cross-team reportsTo relationships.
 *  If an agent in Team B reports to an agent in Team A, Team B is one level below A. */
function deriveTeamLevels(teams: Team[]): Map<string, number> {
  const teamOf = new Map<string, string>();
  for (const team of teams) for (const a of team.agents) teamOf.set(a.name, team.name);

  // parentTeams: teamName → set of teams whose agents are managers of agents in this team
  const parentTeams = new Map<string, Set<string>>();
  for (const team of teams) {
    for (const agent of team.agents) {
      if (!agent.reportsTo) continue;
      const managerTeam = teamOf.get(agent.reportsTo);
      if (managerTeam && managerTeam !== team.name) {
        if (!parentTeams.has(team.name)) parentTeams.set(team.name, new Set());
        parentTeams.get(team.name)!.add(managerTeam);
      }
    }
  }

  const levels = new Map<string, number>();
  for (const t of teams) levels.set(t.name, 0);

  // Iteratively propagate: level = max(parentLevel) + 1
  let changed = true;
  while (changed) {
    changed = false;
    for (const [team, parents] of parentTeams) {
      const maxParent = Math.max(...[...parents].map(p => levels.get(p) ?? 0));
      if (maxParent + 1 > (levels.get(team) ?? 0)) {
        levels.set(team, maxParent + 1);
        changed = true;
      }
    }
  }
  return levels;
}

/** Max depth of an agent tree inside a team (for vertical sizing) */
function teamTreeDepth(team: Team): number {
  const { childrenOf, names } = buildChildrenMap(team.agents);
  const roots = team.agents.filter(a => !a.reportsTo || !names.has(a.reportsTo));
  if (roots.length === 0) return 1;

  function depth(name: string): number {
    const children = childrenOf.get(name) ?? [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map(c => depth(c.name)));
  }
  return Math.max(...roots.map(r => depth(r.name)));
}

const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "oklch(0.7 0.12 250 / 60%)",
};

function makeEdge(id: string, source: string, target: string, animated: boolean): Edge {
  return {
    id,
    source,
    target,
    type: "smoothstep",
    style: { stroke: "oklch(0.7 0.12 250 / 40%)", strokeWidth: 2 },
    markerEnd: EDGE_MARKER,
    animated,
  };
}

function buildChildrenMap(teamAgents: AgentConfig[]) {
  const names = new Set(teamAgents.map(a => a.name));
  const childrenOf = new Map<string, AgentConfig[]>();
  for (const a of teamAgents) {
    if (a.reportsTo && names.has(a.reportsTo)) {
      const siblings = childrenOf.get(a.reportsTo) ?? [];
      siblings.push(a);
      childrenOf.set(a.reportsTo, siblings);
    }
  }
  return { childrenOf, names };
}

function subtreeWidth(name: string, childrenOf: Map<string, AgentConfig[]>): number {
  const children = childrenOf.get(name) ?? [];
  if (children.length === 0) return NODE_W;
  return Math.max(NODE_W, children.reduce((s, c) => s + subtreeWidth(c.name, childrenOf), 0) + H_GAP * (children.length - 1));
}

function placeAgentTree(
  agent: AgentConfig,
  x: number,
  y: number,
  teamIdx: number,
  teamName: string,
  childrenOf: Map<string, AgentConfig[]>,
  activeSet: Set<string>,
  nodes: Node[],
  edges: Edge[],
) {
  const subCount = (childrenOf.get(agent.name) ?? []).length;
  nodes.push({
    id: agent.name,
    type: "agent",
    position: { x, y },
    data: {
      label: agent.identity?.displayName ?? agent.name,
      agent,
      isActive: activeSet.has(agent.name),
      subordinateCount: subCount,
      teamName,
      teamColorIdx: teamIdx,
    } satisfies AgentNodeData,
  });

  const children = (childrenOf.get(agent.name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
  if (children.length === 0) return;

  const totalW = children.reduce((s, c) => s + subtreeWidth(c.name, childrenOf), 0) + H_GAP * (children.length - 1);
  let cx = x + NODE_W / 2 - totalW / 2;

  for (const child of children) {
    const sw = subtreeWidth(child.name, childrenOf);
    edges.push(makeEdge(`${agent.name}->${child.name}`, agent.name, child.name, activeSet.has(child.name)));
    placeAgentTree(child, cx + sw / 2 - NODE_W / 2, y + NODE_H + V_GAP, teamIdx, teamName, childrenOf, activeSet, nodes, edges);
    cx += sw + H_GAP;
  }
}

/** Estimate rendered width of a team header node based on name length */
function estimateTeamHeaderWidth(name: string): number {
  // icon(16) + gap(10) + text(~8px per char) + gap(10) + badge(32) + padding(32)
  return Math.max(140, name.length * 8 + 100);
}

/** Cluster view — team header boxes only (no agents expanded) */
function buildClusterLayout(
  teams: Team[],
  onClickTeam: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const BOX_GAP = 80;
  const widths = teams.map(t => estimateTeamHeaderWidth(t.name));
  const totalW = widths.reduce((s, w) => s + w, 0) + BOX_GAP * Math.max(0, teams.length - 1);
  let x = -totalW / 2;

  teams.forEach((team, i) => {
    nodes.push({
      id: `team-header-${team.name}`,
      type: "teamHeader",
      position: { x, y: 0 },
      data: {
        label: team.name,
        teamColorIdx: i,
        agentCount: team.agents.length,
        onClick: () => onClickTeam(team.name),
      } satisfies TeamHeaderNodeData,
    });
    x += widths[i] + BOX_GAP;
  });

  return { nodes, edges: [] };
}

/** Expanded view for a single team — team header at top, agents in pyramid below */
function buildTeamDetailLayout(
  team: Team,
  teamIdx: number,
  processes: AgentProcess[],
): { nodes: Node[]; edges: Edge[] } {
  const activeSet = new Set(processes.map(p => p.agentName));
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const { childrenOf, names } = buildChildrenMap(team.agents);
  const roots = team.agents.filter(a => !a.reportsTo || !names.has(a.reportsTo));
  roots.sort((a, b) => a.name.localeCompare(b.name));

  const rootWidths = roots.map(r => subtreeWidth(r.name, childrenOf));
  const agentsWidth = rootWidths.reduce((s, w) => s + w, 0) + H_GAP * Math.max(0, roots.length - 1);

  // Team header box centered at top
  const headerId = `team-header-${team.name}`;
  const headerW = estimateTeamHeaderWidth(team.name);
  nodes.push({
    id: headerId,
    type: "teamHeader",
    position: { x: -headerW / 2, y: 0 },
    data: {
      label: team.name,
      teamColorIdx: teamIdx,
      agentCount: team.agents.length,
      onClick: () => {},
    } satisfies TeamHeaderNodeData,
  });

  // Agents below
  let rx = -agentsWidth / 2;
  const agentY = TEAM_HEADER_H + V_GAP;

  for (let i = 0; i < roots.length; i++) {
    const sw = rootWidths[i];
    edges.push(makeEdge(`${headerId}->${roots[i].name}`, headerId, roots[i].name, activeSet.has(roots[i].name)));
    placeAgentTree(roots[i], rx + sw / 2 - NODE_W / 2, agentY, teamIdx, team.name, childrenOf, activeSet, nodes, edges);
    rx += sw + H_GAP;
  }

  return { nodes, edges };
}

/** Show all — every team expanded, stacked by derived hierarchy level.
 *  Cross-team reportsTo relationships determine which teams sit above others. */
function buildShowAllLayout(
  teams: Team[],
  processes: AgentProcess[],
  onClickTeam: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const activeSet = new Set(processes.map(p => p.agentName));
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const TEAM_GAP = 100;

  // ── Derive team levels from cross-team reportsTo ──
  const teamLevels = deriveTeamLevels(teams);
  const maxLevel = Math.max(...[...teamLevels.values()], 0);

  // Group teams by level
  const levelGroups: Team[][] = [];
  for (let l = 0; l <= maxLevel; l++) {
    levelGroups.push(teams.filter(t => teamLevels.get(t.name) === l));
  }

  // Pre-compute each team's width
  const teamWidthMap = new Map<string, number>();
  for (const team of teams) {
    const { childrenOf, names } = buildChildrenMap(team.agents);
    const roots = team.agents.filter(a => !a.reportsTo || !names.has(a.reportsTo));
    if (roots.length === 0) {
      teamWidthMap.set(team.name, NODE_W);
    } else {
      const rootW = roots.map(r => subtreeWidth(r.name, childrenOf));
      teamWidthMap.set(team.name, Math.max(NODE_W, rootW.reduce((s, w) => s + w, 0) + H_GAP * (roots.length - 1)));
    }
  }

  // Height of each level row = tallest team in that row
  const levelHeights = levelGroups.map(group => {
    if (group.length === 0) return 0;
    const maxDepth = Math.max(...group.map(t => teamTreeDepth(t)));
    return TEAM_HEADER_H + V_GAP + maxDepth * NODE_H + Math.max(0, maxDepth - 1) * V_GAP;
  });

  // ── Place teams level by level ──
  let levelY = 0;
  for (let level = 0; level <= maxLevel; level++) {
    const group = levelGroups[level];
    if (group.length === 0) { levelY += levelHeights[level] + LEVEL_GAP; continue; }

    const groupWidths = group.map(t => teamWidthMap.get(t.name) ?? NODE_W);
    const totalWidth = groupWidths.reduce((s, w) => s + w, 0) + TEAM_GAP * Math.max(0, group.length - 1);
    let groupX = -totalWidth / 2;

    for (let ti = 0; ti < group.length; ti++) {
      const team = group[ti];
      const teamIdx = teams.indexOf(team);
      const groupWidth = groupWidths[ti];
      const centerX = groupX + groupWidth / 2;

      // Team header box
      const headerId = `team-header-${team.name}`;
      const headerW = estimateTeamHeaderWidth(team.name);
      nodes.push({
        id: headerId,
        type: "teamHeader",
        position: { x: centerX - headerW / 2, y: levelY },
        data: {
          label: team.name,
          teamColorIdx: teamIdx,
          agentCount: team.agents.length,
          onClick: () => onClickTeam(team.name),
        } satisfies TeamHeaderNodeData,
      });

      // Agents below in pyramid hierarchy
      const { childrenOf, names } = buildChildrenMap(team.agents);
      const roots = team.agents.filter(a => !a.reportsTo || !names.has(a.reportsTo));
      roots.sort((a, b) => a.name.localeCompare(b.name));

      const rootWidths = roots.map(r => subtreeWidth(r.name, childrenOf));
      const agentsWidth = rootWidths.reduce((s, w) => s + w, 0) + H_GAP * Math.max(0, roots.length - 1);
      let rx = centerX - agentsWidth / 2;
      const agentY = levelY + TEAM_HEADER_H + V_GAP;

      for (let i = 0; i < roots.length; i++) {
        const sw = rootWidths[i];
        edges.push(makeEdge(`${headerId}->${roots[i].name}`, headerId, roots[i].name, activeSet.has(roots[i].name)));
        placeAgentTree(roots[i], rx + sw / 2 - NODE_W / 2, agentY, teamIdx, team.name, childrenOf, activeSet, nodes, edges);
        rx += sw + H_GAP;
      }

      groupX += groupWidth + TEAM_GAP;
    }

    levelY += levelHeights[level] + LEVEL_GAP;
  }

  // ── Cross-team reportsTo edges (dashed) ──
  const teamOf = new Map<string, string>();
  for (const team of teams) for (const a of team.agents) teamOf.set(a.name, team.name);

  for (const team of teams) {
    for (const agent of team.agents) {
      if (!agent.reportsTo) continue;
      const managerTeam = teamOf.get(agent.reportsTo);
      if (managerTeam && managerTeam !== team.name) {
        edges.push({
          id: `cross-${agent.name}->${agent.reportsTo}`,
          source: agent.reportsTo,
          target: agent.name,
          type: "smoothstep",
          style: { stroke: "oklch(0.7 0.15 300 / 50%)", strokeWidth: 2, strokeDasharray: "6 4" },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "oklch(0.7 0.15 300 / 60%)" },
          animated: true,
        });
      }
    }
  }

  return { nodes, edges };
}

// ─── Org Chart View ──────────────────────────────────────

type OrgMode = "clusters" | "detail" | "all";

function OrgChartInner({ teams, agents, processes }: { teams: Team[]; agents: AgentConfig[]; processes: AgentProcess[] }) {
  // Default to "all" — full hierarchy with cluster headers
  const [mode, setMode] = useState<OrgMode>("all");
  const [focusedTeam, setFocusedTeam] = useState<string | null>(null);
  const { fitView } = useReactFlow();

  const onClickTeam = useCallback((name: string) => {
    if (mode === "all") {
      // Drill down from full view into a single team
      setFocusedTeam(name);
      setMode("detail");
    }
  }, [mode]);

  const onBack = useCallback(() => {
    setFocusedTeam(null);
    setMode("all");
  }, []);

  const onToggleMode = useCallback(() => {
    if (mode === "clusters") {
      setMode("all");
      setFocusedTeam(null);
    } else {
      setMode("clusters");
      setFocusedTeam(null);
    }
  }, [mode]);

  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    if (mode === "detail" && focusedTeam) {
      const teamIdx = teams.findIndex(t => t.name === focusedTeam);
      const team = teams[teamIdx];
      if (team) return buildTeamDetailLayout(team, teamIdx, processes);
    }
    if (mode === "clusters") {
      return buildClusterLayout(teams, (name) => {
        setFocusedTeam(name);
        setMode("detail");
      });
    }
    // Default: "all" — full hierarchy with cluster headers
    return buildShowAllLayout(teams, processes, onClickTeam);
  }, [mode, focusedTeam, teams, processes, onClickTeam]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  useEffect(() => {
    setNodes(layoutNodes);
    setEdges(layoutEdges);
    requestAnimationFrame(() => {
      // Tighter zoom for detail view, relaxed for overview
      const padding = mode === "detail" ? 0.1 : 0.25;
      fitView({ padding, duration: 300 });
    });
  }, [layoutNodes, layoutEdges, setNodes, setEdges, fitView, mode]);

  if (agents.length === 0) return null;

  const focusedTeamObj = focusedTeam ? teams.find(t => t.name === focusedTeam) : null;

  return (
    <>
      {/* Floating controls overlay */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        {mode === "detail" && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs bg-card/90 backdrop-blur-sm shadow-sm"
            onClick={onBack}
          >
            <ChevronRight className="h-3 w-3 mr-1 rotate-180" />
            All teams
          </Button>
        )}
        {mode === "detail" && focusedTeamObj && (
          <Badge variant="secondary" className="text-[10px]">
            {focusedTeamObj.name} — {focusedTeamObj.agents.length} agents
          </Badge>
        )}
      </div>
      <div className="absolute top-3 right-3 z-10">
        {mode !== "detail" && (
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-7 text-xs backdrop-blur-sm shadow-sm border",
              mode === "all"
                ? "bg-primary/15 border-primary/40 text-primary hover:bg-primary/25"
                : "bg-card/90 border-border/40 text-muted-foreground hover:text-foreground",
            )}
            onClick={onToggleMode}
          >
            {mode === "clusters" ? "Show all" : "Clusters"}
          </Button>
        )}
      </div>

      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView fitViewOptions={{ padding: mode === "detail" ? 0.1 : 0.25 }}
        minZoom={0.15} maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        className="[&_.react-flow__background]:!bg-transparent"
      >
        <Background gap={20} size={1} className="!text-border/20" />
        <Controls
          showInteractive={false}
          className="!bg-card !border-border/40 !shadow-md [&>button]:!bg-card [&>button]:!border-border/30 [&>button]:!text-muted-foreground [&>button:hover]:!bg-muted/50"
        />
      </ReactFlow>
    </>
  );
}

function OrgChartView({ teams, agents, processes }: { teams: Team[]; agents: AgentConfig[]; processes: AgentProcess[] }) {
  return (
    <div className="relative flex-1 min-h-0 rounded-lg border border-border/40 bg-card/30 overflow-hidden">
      <ReactFlowProvider>
        <OrgChartInner teams={teams} agents={agents} processes={processes} />
      </ReactFlowProvider>
    </div>
  );
}

// ─── List View (grouped by team) ─────────────────────────

function ListView({
  teams,
  processes,
  search,
  onRemoveAgent,
  onRenameTeam,
  onRemoveTeam,
}: {
  teams: Team[];
  processes: AgentProcess[];
  search: string;
  onRemoveAgent: (name: string) => Promise<void>;
  onRenameTeam: (oldName: string, newName: string) => Promise<void>;
  onRemoveTeam: (name: string) => Promise<void>;
}) {
  const [handleRemoveTeam, isRemovingTeam] = useAsyncAction(async (name: string) => {
    await onRemoveTeam(name);
  });

  return (
    <ScrollArea className="flex-1 min-h-0 -mx-1">
      <div className="space-y-6 px-1 pr-5 pb-2">
        {teams.map((team, teamIdx) => {
          const tc = getTeamColor(teamIdx);
          const teamAgents = team.agents.filter(a => {
            if (!search) return true;
            const q = search.toLowerCase();
            return a.name.toLowerCase().includes(q) || (a.role ?? "").toLowerCase().includes(q) ||
              (a.model ?? "").toLowerCase().includes(q) || (a.identity?.displayName ?? "").toLowerCase().includes(q);
          });

          return (
            <section key={team.name} className="space-y-2">
              {/* Team section header */}
              <div className={cn("flex items-center gap-3 rounded-lg border px-3 py-2", tc.border, tc.bg)}>
                <div className={cn("h-2 w-2 rounded-full", tc.dot)} />
                <TeamNameEditor teamName={team.name} teamDescription={team.description} onRename={onRenameTeam} />
                <Badge variant="secondary" className="text-[9px]">{team.agents.length} agent{team.agents.length !== 1 ? "s" : ""}</Badge>
                {team.description && <span className="text-[10px] text-muted-foreground truncate hidden md:inline">{team.description}</span>}
                <div className="ml-auto flex items-center gap-1">
                  {teams.length > 1 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          onClick={() => handleRemoveTeam(team.name)}
                          disabled={isRemovingTeam}
                        >
                          {isRemovingTeam ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">Remove team and all its agents</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>

              {/* Agents in this team — rendered with hierarchy indentation */}
              {teamAgents.length > 0 ? (
                <div className="space-y-2 pl-3 border-l-2 ml-1" style={{ borderColor: `oklch(0.7 0.12 ${[250, 280, 160, 80, 0, 200][teamIdx % 6]} / 30%)` }}>
                  {(() => {
                    // Build hierarchy from reportsTo
                    const nameSet = new Set(teamAgents.map(a => a.name));
                    const childrenOf = new Map<string, AgentConfig[]>();
                    for (const a of teamAgents) {
                      if (a.reportsTo && nameSet.has(a.reportsTo)) {
                        const siblings = childrenOf.get(a.reportsTo) ?? [];
                        siblings.push(a);
                        childrenOf.set(a.reportsTo, siblings);
                      }
                    }
                    const roots = teamAgents.filter(a => !a.reportsTo || !nameSet.has(a.reportsTo));

                    // Recursive renderer with depth-based indentation
                    const renderAgent = (agent: AgentConfig, depth: number): React.ReactNode[] => {
                      const children = (childrenOf.get(agent.name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
                      return [
                        <div key={agent.name} style={{ marginLeft: depth * 20 }}>
                          <AgentCard
                            agent={agent}
                            process={processes.find(p => p.agentName === agent.name)}
                            onRemove={!agent.volatile ? onRemoveAgent : undefined}
                            teamColor={tc}
                          />
                        </div>,
                        ...children.flatMap(child => renderAgent(child, depth + 1)),
                      ];
                    };

                    return roots.sort((a, b) => a.name.localeCompare(b.name)).flatMap(r => renderAgent(r, 0));
                  })()}
                </div>
              ) : (
                <div className="pl-3 border-l-2 border-border/20 ml-1 py-4">
                  <p className="text-xs text-muted-foreground">
                    {search ? "No agents match your search in this team." : "No agents in this team yet."}
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ─── Main Page ───────────────────────────────────────────

type ViewMode = "list" | "chart";

export function AgentsPage() {
  const { agents, teams, isLoading: loading, refetch, addAgent, removeAgent, addTeam, removeTeam, renameTeam } = useAgents();
  const { processes } = useProcesses();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>("list");

  // All hooks before any early return
  const [handleRefresh, isRefreshing] = useAsyncAction(async () => {
    await refetch();
  });

  const handleAddAgent = useCallback(
    async (req: { name: string; role?: string; model?: string }, teamName?: string) => { await addAgent(req, teamName); },
    [addAgent],
  );
  const handleRemoveAgent = useCallback(async (name: string) => { await removeAgent(name); }, [removeAgent]);
  const handleAddTeam = useCallback(
    async (req: { name: string; description?: string }) => { await addTeam(req); },
    [addTeam],
  );
  const handleRemoveTeam = useCallback(async (name: string) => { await removeTeam(name); }, [removeTeam]);
  const handleRenameTeam = useCallback(
    async (oldName: string, newName: string) => { await renameTeam(oldName, newName); },
    [renameTeam],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Filter agents for search
  const filtered = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.name.toLowerCase().includes(q) || (a.role ?? "").toLowerCase().includes(q) ||
      (a.model ?? "").toLowerCase().includes(q) || (a.identity?.displayName ?? "").toLowerCase().includes(q) ||
      (a.missionGroup ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Summary header */}
      <SummaryHeader teams={teams} agents={agents} processes={processes} />

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-border/40 bg-muted/20 p-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    view === "chart" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setView("chart")}
                >
                  <Network className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Org Chart</span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Visual org chart with reporting structure</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    view === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setView("list")}
                >
                  <LayoutList className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">List</span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Grouped list view by team</TooltipContent>
            </Tooltip>
          </div>

          {/* Search */}
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search agents..." className="pl-9 h-8 bg-input/50 border-border/40" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <AddTeamDialog onAdd={handleAddTeam} />
          <AddAgentDialog teams={teams} onAdd={handleAddAgent} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Content */}
      {agents.length === 0 && !search ? (
        <Card className="bg-card/60 backdrop-blur-sm flex-1">
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground h-full">
            <Bot className="h-12 w-12 mb-4 opacity-40" />
            <p className="text-sm font-medium">No agents yet</p>
            <p className="text-xs mt-1 text-center max-w-sm">
              Create a team and add your first agent to get started. Agents are saved in your project configuration.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <AddTeamDialog onAdd={handleAddTeam} />
              <AddAgentDialog teams={teams} onAdd={handleAddAgent} />
            </div>
          </CardContent>
        </Card>
      ) : view === "chart" ? (
        <OrgChartView teams={teams} agents={filtered} processes={processes} />
      ) : (
        <ListView
          teams={teams}
          processes={processes}
          search={search}
          onRemoveAgent={handleRemoveAgent}
          onRenameTeam={handleRenameTeam}
          onRemoveTeam={handleRemoveTeam}
        />
      )}
    </div>
  );
}
