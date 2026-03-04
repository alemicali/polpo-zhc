/**
 * OrgChartView — ReactFlow-based org chart with team clusters.
 * Consumes AgentsPageContext for teams, agents, and processes.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Users, ChevronRight, Zap } from "lucide-react";
import type { AgentConfig, AgentProcess, Team } from "@lumea-labs/polpo-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { useAgentsPage } from "./agents-page-provider";
import { getTeamColor } from "./agents-team-colors";
import { cn } from "@/lib/utils";

// ─── Custom node data types ─────────────────────────────

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

// ─── Custom nodes ────────────────────────────────────────

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
      <Badge variant="outline" className={cn("text-[10px] shrink-0 font-bold border-0", tc.badgeBg, tc.text)}>
        {data.agentCount}
      </Badge>
      <Handle type="target" position={Position.Top} className="!bg-primary/60 !w-2 !h-2 !border-0" />
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

// ─── Layout constants ────────────────────────────────────

const NODE_W = 210;
const NODE_H = 140;
const H_GAP = 40;
const V_GAP = 60;
const TEAM_HEADER_H = 56;
const LEVEL_GAP = 200;

// ─── Layout helpers ──────────────────────────────────────

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
  return Math.max(140, name.length * 8 + 100);
}

/** Derive team hierarchy levels from cross-team reportsTo relationships. */
function deriveTeamLevels(teams: Team[]): Map<string, number> {
  const teamOf = new Map<string, string>();
  for (const team of teams) for (const a of team.agents) teamOf.set(a.name, team.name);

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

// ─── Layout builders ─────────────────────────────────────

/** Cluster view — team header boxes arranged by hierarchy level with cross-team edges */
function buildClusterLayout(
  teams: Team[],
  onClickTeam: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const BOX_GAP = 80;
  const LEVEL_V_GAP = 120;

  const levels = deriveTeamLevels(teams);

  const byLevel = new Map<number, typeof teams>();
  for (const team of teams) {
    const lvl = levels.get(team.name) ?? 0;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(team);
  }

  const teamIdx = new Map<string, number>();
  teams.forEach((t, i) => teamIdx.set(t.name, i));

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const lvl of sortedLevels) {
    const row = byLevel.get(lvl)!;
    const widths = row.map(t => estimateTeamHeaderWidth(t.name));
    const totalW = widths.reduce((s, w) => s + w, 0) + BOX_GAP * Math.max(0, row.length - 1);
    let x = -totalW / 2;
    const y = lvl * (TEAM_HEADER_H + LEVEL_V_GAP);

    for (let i = 0; i < row.length; i++) {
      const team = row[i];
      nodes.push({
        id: `team-header-${team.name}`,
        type: "teamHeader",
        position: { x, y },
        data: {
          label: team.name,
          teamColorIdx: teamIdx.get(team.name) ?? 0,
          agentCount: team.agents.length,
          onClick: () => onClickTeam(team.name),
        } satisfies TeamHeaderNodeData,
      });
      x += widths[i] + BOX_GAP;
    }
  }

  // Cross-team edges
  const teamOf = new Map<string, string>();
  for (const team of teams) for (const a of team.agents) teamOf.set(a.name, team.name);

  const drawnEdges = new Set<string>();
  for (const team of teams) {
    for (const agent of team.agents) {
      if (!agent.reportsTo) continue;
      const managerTeam = teamOf.get(agent.reportsTo);
      if (managerTeam && managerTeam !== team.name) {
        const edgeKey = `${managerTeam}->${team.name}`;
        if (drawnEdges.has(edgeKey)) continue;
        drawnEdges.add(edgeKey);
        edges.push({
          id: `cluster-${edgeKey}`,
          source: `team-header-${managerTeam}`,
          target: `team-header-${team.name}`,
          type: "smoothstep",
          style: { stroke: "oklch(0.7 0.15 300 / 50%)", strokeWidth: 2, strokeDasharray: "6 4" },
          markerEnd: EDGE_MARKER,
          animated: true,
        });
      }
    }
  }

  return { nodes, edges };
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

/** Show all — every team expanded, stacked by derived hierarchy level. */
function buildShowAllLayout(
  teams: Team[],
  processes: AgentProcess[],
  onClickTeam: (name: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const activeSet = new Set(processes.map(p => p.agentName));
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const TEAM_GAP = 100;

  const teamLevels = deriveTeamLevels(teams);
  const maxLevel = Math.max(...[...teamLevels.values()], 0);

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

  const levelHeights = levelGroups.map(group => {
    if (group.length === 0) return 0;
    const maxDepth = Math.max(...group.map(t => teamTreeDepth(t)));
    return TEAM_HEADER_H + V_GAP + maxDepth * NODE_H + Math.max(0, maxDepth - 1) * V_GAP;
  });

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

  // Cross-team reportsTo edges (dashed)
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

// ─── Org Chart Inner (with ReactFlow hooks) ──────────────

type OrgMode = "clusters" | "detail" | "all";

function OrgChartInner() {
  const { state } = useAgentsPage();
  const { teams, agents, processes } = state;

  const [mode, setMode] = useState<OrgMode>("all");
  const [focusedTeam, setFocusedTeam] = useState<string | null>(null);
  const [prevMode, setPrevMode] = useState<OrgMode>("all");
  const { fitView } = useReactFlow();

  const onClickTeam = useCallback((name: string) => {
    if (mode === "all" || mode === "clusters") {
      setPrevMode(mode);
      setFocusedTeam(name);
      setMode("detail");
    }
  }, [mode]);

  const onBack = useCallback(() => {
    setFocusedTeam(null);
    setMode(prevMode);
  }, [prevMode]);

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
      return buildClusterLayout(teams, onClickTeam);
    }
    return buildShowAllLayout(teams, processes, onClickTeam);
  }, [mode, focusedTeam, teams, processes, onClickTeam]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  useEffect(() => {
    setNodes(layoutNodes);
    setEdges(layoutEdges);
    requestAnimationFrame(() => {
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
            {prevMode === "clusters" ? "Clusters" : "All teams"}
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
        <Background gap={20} size={1} className="!text-zinc-800/40" />
        <Controls
          showInteractive={false}
          className="!bg-card !border-border/40 !shadow-md [&>button]:!bg-card [&>button]:!border-border/30 [&>button]:!text-muted-foreground [&>button:hover]:!bg-muted/50"
        />
      </ReactFlow>
    </>
  );
}

// ─── Exported wrapper ────────────────────────────────────

export function OrgChartView() {
  return (
    <div className="relative flex-1 min-h-0 rounded-lg border border-border/40 bg-card/30 overflow-hidden">
      <ReactFlowProvider>
        <OrgChartInner />
      </ReactFlowProvider>
    </div>
  );
}
