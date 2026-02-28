import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  Loader2,
  Sparkles,
  Bot,
  Users,
  Wrench,
  FolderOpen,
  Globe,
  HardDrive,
  Copy,
  Check,
} from "lucide-react";
import { useSkills, useAgents, usePolpo } from "@lumea-labs/polpo-react";
import type { SkillWithAssignment, Team, LoadedSkill } from "@lumea-labs/polpo-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

// ── Copyable text ──

function CopyableText({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="group/copy flex items-center gap-1.5 text-left min-w-0"
    >
      <code className="text-[11px] font-mono text-muted-foreground truncate" title={text}>
        {label ?? text}
      </code>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400 shrink-0" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover/copy:opacity-100 transition-opacity shrink-0" />
      )}
    </button>
  );
}

// ── Source badge ──

function SourceBadge({ source }: { source: string }) {
  const isGlobal = source === "global";
  return (
    <Badge variant="outline" className={cn("text-[10px] gap-1", isGlobal ? "text-sky-400" : "text-emerald-400")}>
      {isGlobal ? <Globe className="h-3 w-3" /> : <HardDrive className="h-3 w-3" />}
      {isGlobal ? "Global" : "Project"}
    </Badge>
  );
}

// ── Metadata card ──

function MetadataCard({
  skill,
  agentTeamMap,
  teams,
}: {
  skill: SkillWithAssignment;
  agentTeamMap: Map<string, string>;
  teams: Team[];
}) {
  const totalAgents = teams.reduce((s, t) => s + t.agents.length, 0);

  // Teams using this skill
  const teamSet = new Set<string>();
  for (const agent of skill.assignedTo) {
    const team = agentTeamMap.get(agent);
    if (team) teamSet.add(team);
  }
  const skillTeams = [...teamSet];

  return (
    <Card className="sticky top-0">
      <CardContent className="p-4 space-y-4">
        {/* Identity */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 shrink-0">
              <Sparkles className="h-4.5 w-4.5 text-violet-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold truncate">{skill.name}</h3>
              <SourceBadge source={skill.source} />
            </div>
          </div>
          {skill.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{skill.description}</p>
          )}
        </div>

        <Separator />

        {/* Agents */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Agents
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {skill.assignedTo.length} / {totalAgents}
            </span>
          </div>
          {skill.assignedTo.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {skill.assignedTo.map((agent) => {
                const team = agentTeamMap.get(agent);
                return (
                  <Tooltip key={agent}>
                    <TooltipTrigger asChild>
                      <span>
                        <Badge variant="secondary" className="text-[10px] gap-1">
                          <Bot className="h-2.5 w-2.5" />
                          {agent}
                        </Badge>
                      </span>
                    </TooltipTrigger>
                    {team && <TooltipContent className="text-xs">Team: {team}</TooltipContent>}
                  </Tooltip>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/60 italic">Not assigned to any agent</p>
          )}
        </div>

        {/* Teams */}
        {skillTeams.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Teams
              </span>
              <div className="flex flex-wrap gap-1">
                {skillTeams.map((team) => (
                  <Badge key={team} variant="outline" className="text-[10px] gap-1">
                    <Users className="h-2.5 w-2.5" />
                    {team}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Allowed Tools */}
        {Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Allowed Tools
              </span>
              <div className="flex flex-wrap gap-1">
                {skill.allowedTools.map((t) => (
                  <Badge key={t} variant="outline" className="text-[9px] font-mono py-0 px-1.5">
                    <Wrench className="h-2.5 w-2.5 mr-0.5" />
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Path */}
        <Separator />
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Path
          </span>
          <div className="flex items-center gap-1.5 min-w-0">
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <CopyableText text={skill.path} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main ──

export function SkillDetailPage() {
  const { skillName } = useParams<{ skillName: string }>();
  const navigate = useNavigate();
  const { client } = usePolpo();
  const { skills, isLoading: skillsLoading } = useSkills();
  const { teams } = useAgents();

  const [loadedSkill, setLoadedSkill] = useState<LoadedSkill | null>(null);
  const [contentLoading, setContentLoading] = useState(true);
  const [contentError, setContentError] = useState<string | null>(null);

  const agentTeamMap = new Map<string, string>();
  for (const team of teams) {
    for (const agent of team.agents) {
      agentTeamMap.set(agent.name, team.name);
    }
  }

  // Find the skill in the list
  const skill = skills.find((s) => s.name === skillName);

  // Fetch full content
  useEffect(() => {
    if (!skillName || !client) return;
    let cancelled = false;

    setContentLoading(true);
    setContentError(null);

    client
      .getSkillContent(skillName)
      .then((data) => {
        if (!cancelled) {
          setLoadedSkill(data);
          setContentLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setContentError(err?.message ?? "Failed to load skill content");
          setContentLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [skillName, client]);

  // Loading state
  if (skillsLoading || contentLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Not found
  if (!skill) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Sparkles className="h-10 w-10 opacity-30" />
        <p className="text-sm">Skill "{skillName}" not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/skills")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to Skills
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Title bar ── */}
      <div className="flex items-center gap-3 shrink-0">
        <Button variant="ghost" size="sm" onClick={() => navigate("/skills")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 shrink-0">
          <Sparkles className="h-4.5 w-4.5 text-violet-400" />
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold truncate">{skill.name}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <SourceBadge source={skill.source} />
            {skill.assignedTo.length > 0 && (
              <span className="text-[11px] text-muted-foreground">
                {skill.assignedTo.length} agent{skill.assignedTo.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Content grid ── */}
      <div className="flex-1 overflow-auto pb-bottom-nav lg:pb-2">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Left: Markdown content */}
          <div className="lg:col-span-3 min-w-0">
            {contentError ? (
              <div className="rounded-lg border border-border/40 bg-card/80 p-6 text-center">
                <p className="text-sm text-muted-foreground">{contentError}</p>
              </div>
            ) : loadedSkill?.content ? (
              <div className="rounded-lg border border-border/40 bg-card/80 p-6">
                <MessageResponse mode="static">
                  {loadedSkill.content}
                </MessageResponse>
              </div>
            ) : (
              <div className="rounded-lg border border-border/40 bg-card/80 p-6 text-center">
                <p className="text-sm text-muted-foreground italic">This skill has no content</p>
              </div>
            )}
          </div>

          {/* Right: Metadata sidebar */}
          <div className="lg:col-span-1">
            <MetadataCard
              skill={skill}
              agentTeamMap={agentTeamMap}
              teams={teams}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
