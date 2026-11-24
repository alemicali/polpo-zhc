import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Loader2,
  Sparkles,
  Users,
  Wrench,
  FolderOpen,
  Globe,
  HardDrive,
  Copy,
  Check,
  Download,
  Bookmark,
  History,
  FileText,
  RotateCcw,
} from "lucide-react";
import { useSkills, useOrchestratorSkills, useAgents, usePolpo, useSkillFiles, useSkillVersions } from "@polpo-ai/react";
import type { SkillInfo, Team, LoadedSkill, SkillPool, SkillVersionFiles } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SkillFileTree, SkillFileViewer } from "@/components/skills/skill-file-browser";
import { SkillVersionsPanel } from "@/components/skills/skill-versions";
import { versionAuthor, versionSourceLabel } from "@/lib/skill-versions";
import { formatSize } from "@/lib/skill-files";

type ShownSkill = SkillInfo & { assignedTo?: string[] };

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
      <code className="text-caption font-mono text-muted-foreground truncate" title={text}>
        {label ?? text}
      </code>
      {copied ? (
        <Check className="h-3 w-3 text-success shrink-0" />
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
    <Badge variant="outline" className={cn("text-micro gap-1", isGlobal ? "text-info" : "text-success")}>
      {isGlobal ? <Globe className="h-3 w-3" /> : <HardDrive className="h-3 w-3" />}
      {isGlobal ? "Global" : "Project"}
    </Badge>
  );
}

// ── Metadata card ──

function MetadataCard({
  skill,
  pool,
  agentTeamMap,
  teams,
}: {
  skill: ShownSkill;
  pool: SkillPool;
  agentTeamMap: Map<string, string>;
  teams: Team[];
}) {
  const totalAgents = teams.reduce((s, t) => s + t.agents.length, 0);
  const assignedTo = skill.assignedTo ?? [];

  // Teams using this skill
  const teamSet = new Set<string>();
  for (const agent of assignedTo) {
    const team = agentTeamMap.get(agent);
    if (team) teamSet.add(team);
  }
  const skillTeams = [...teamSet];

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        {/* Identity */}
        <div className="space-y-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-heading text-h3 truncate">{skill.name}</h3>
              {skill.category && (
                <span className="text-micro text-chart-4 shrink-0">{skill.category}</span>
              )}
            </div>
            <SourceBadge source={skill.source} />
          </div>
          {skill.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{skill.description}</p>
          )}
        </div>

        {pool === "orchestrator" ? (
          <>
            <Separator />
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <Bookmark className="h-3 w-3" /> One of Polpo's own skills
            </p>
          </>
        ) : (
          <>
            <Separator />
            {/* Agents */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-label text-muted-foreground">
                  Agents
                </span>
                <span className="text-micro text-muted-foreground tabular-nums">
                  {assignedTo.length} / {totalAgents}
                </span>
              </div>
              {assignedTo.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {assignedTo.map((agent) => {
                    const team = agentTeamMap.get(agent);
                    return (
                      <Tooltip key={agent}>
                        <TooltipTrigger asChild>
                          <span>
                            <Badge variant="secondary" className="text-micro gap-1">
                              <AgentAvatar name={agent} size="xs" />
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
                <p className="text-caption text-muted-foreground/60 italic">Not assigned to any agent</p>
              )}
            </div>
          </>
        )}

        {/* Teams */}
        {skillTeams.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <span className="text-label text-muted-foreground">
                Teams
              </span>
              <div className="flex flex-wrap gap-1">
                {skillTeams.map((team) => (
                  <Badge key={team} variant="outline" className="text-micro gap-1">
                    <Users className="h-2.5 w-2.5" />
                    {team}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Tags */}
        {skill.tags && skill.tags.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <span className="text-label text-muted-foreground">
                Tags
              </span>
              <div className="flex flex-wrap gap-1">
                {skill.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-micro py-0 px-1.5 bg-info/10 text-info border-info/20">
                    {tag}
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
              <span className="text-label text-muted-foreground">
                Allowed Tools
              </span>
              <div className="flex flex-wrap gap-1">
                {skill.allowedTools.map((t) => (
                  <Badge key={t} variant="outline" className="text-micro font-mono py-0 px-1.5">
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
          <span className="text-label text-muted-foreground">
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

/**
 * A skill as a file browser: its files as a tree, the selected file in the main pane (SKILL.md by
 * default; ?file=references/api.md is linkable), relative links in markdown opening files in place,
 * downloads of one file or the whole skill. ?pool=orchestrator shows one of Polpo's own skills.
 * ?tab=versions shows its history (compare two, restore, download); ?version=3 browses that version's
 * files read-only in the same tree and viewer.
 *
 * Desktop: the layout's main area does not scroll, the page does inside it; here each column scrolls
 * on its own, so the file tree and the skill's details (left, sticky) stay in view while a long file
 * scrolls on the right. Mobile: one column, one scroll, as before.
 */
export function SkillDetailPage() {
  const { skillName } = useParams<{ skillName: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const pool: SkillPool = params.get("pool") === "orchestrator" ? "orchestrator" : "agent";
  const selected = params.get("file") || "SKILL.md";
  const tab = params.get("tab") === "versions" ? "versions" : "files";
  const viewVersion = Number(params.get("version")) > 0 ? Number(params.get("version")) : undefined;
  const { client } = usePolpo();
  const agentSkills = useSkills();
  const orchestratorSkills = useOrchestratorSkills();
  const { skills, isLoading: skillsLoading } = pool === "orchestrator" ? orchestratorSkills : agentSkills;
  const { teams } = useAgents();
  const files = useSkillFiles(skillName, pool);
  const versions = useSkillVersions(skillName, pool);
  // a version's files (?version=n): loaded on demand, tagged with what they belong to
  const versionKey = viewVersion ? `${pool}:${skillName}:${viewVersion}` : "";
  const [versionFiles, setVersionFiles] = useState<{ key: string; data?: SkillVersionFiles; error?: string } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const { files: loadVersionFiles } = versions;
  useEffect(() => {
    if (!viewVersion) return;
    let cancelled = false;
    loadVersionFiles(viewVersion)
      .then((data) => { if (!cancelled) setVersionFiles({ key: versionKey, data }); })
      .catch((err: unknown) => { if (!cancelled) setVersionFiles({ key: versionKey, error: err instanceof Error ? err.message : "Could not load the version" }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionKey]);

  // Content results are tagged with the skill they belong to, so switching
  // skills shows the loader without resetting state inside the effect.
  const contentKey = `${pool}:${skillName}`;
  const [content, setContent] = useState<{ key: string; skill: LoadedSkill | null; error: string | null } | null>(null);
  const contentLoading = !content || content.key !== contentKey;
  const loadedSkill = contentLoading ? null : content.skill;
  const contentError = contentLoading ? null : content.error;

  const agentTeamMap = new Map<string, string>();
  for (const team of teams) {
    for (const agent of team.agents) {
      agentTeamMap.set(agent.name, team.name);
    }
  }

  // Find the skill in the list
  const skill = (skills as ShownSkill[]).find((s) => s.name === skillName);

  // Fetch full content
  useEffect(() => {
    if (!skillName || !client) return;
    let cancelled = false;
    const load = pool === "orchestrator" ? client.getOrchestratorSkillContent(skillName) : client.getSkillContent(skillName);
    load
      .then((data) => {
        if (!cancelled) setContent({ key: contentKey, skill: data, error: null });
      })
      .catch((err) => {
        if (!cancelled) setContent({ key: contentKey, skill: null, error: err?.message ?? "Failed to load skill content" });
      });

    return () => {
      cancelled = true;
    };
  }, [skillName, client, pool, contentKey]);

  const openFile = useCallback((path: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (path === "SKILL.md") next.delete("file"); else next.set("file", path);
      return next;
    });
  }, [setParams]);

  const readText = useCallback((path: string) => client.getSkillFileText(skillName ?? "", path, pool), [client, skillName, pool]);
  const readVersionText = useCallback((path: string) => client.getSkillVersionFileText(skillName ?? "", viewVersion ?? 0, path, pool), [client, skillName, viewVersion, pool]);
  const setView = useCallback((next: { tab?: "files" | "versions"; version?: number | null }) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next.tab === "versions") p.set("tab", "versions"); else if (next.tab === "files") p.delete("tab");
      if (next.version === null) p.delete("version");
      else if (next.version !== undefined) { p.set("version", String(next.version)); p.delete("tab"); p.delete("file"); }
      return p;
    });
  }, [setParams]);

  // Loading state
  if (skillsLoading || contentLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Not found: a deleted skill whose history is kept can be restored from here
  if (!skill && versions.data?.deletedAt) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <Button variant="ghost" size="sm" aria-label="Back" onClick={() => navigate(pool === "orchestrator" ? "/config" : "/skills")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="font-heading text-h2 truncate">{skillName}</h1>
          <Badge variant="outline" className="text-micro text-warning border-warning/30">Deleted</Badge>
        </div>
        <div className="flex-1 min-h-0 overflow-auto pb-bottom-nav lg:pb-2">
          <SkillVersionsPanel versions={versions} />
        </div>
      </div>
    );
  }
  if (!skill) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Sparkles className="h-10 w-10 opacity-30" />
        <p className="text-sm">Skill "{skillName}" not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate(pool === "orchestrator" ? "/config" : "/skills")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to Skills
        </Button>
      </div>
    );
  }

  const shownVersion = viewVersion && versionFiles?.key === versionKey ? versionFiles : null;
  const fileList = viewVersion ? (shownVersion?.data?.files ?? []) : (files.data?.files ?? [{ path: "SKILL.md", size: 0 }]);
  const current = fileList.find((f) => f.path === selected);
  const missing = viewVersion ? !!shownVersion?.data && !current : !!files.data && !current;
  const versionCount = versions.data?.versions.length;
  const isCurrentVersion = viewVersion !== undefined && viewVersion === versions.data?.current;
  const restoreViewed = async () => {
    if (!viewVersion) return;
    setRestoring(true);
    try {
      await versions.restore(viewVersion);
      setConfirmRestore(false);
      setView({ version: null });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Title bar ── */}
      <div className="flex items-center gap-3 shrink-0">
        <Button variant="ghost" size="sm" aria-label="Back" onClick={() => navigate(pool === "orchestrator" ? "/config" : "/skills")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-h2 truncate">{skill.name}</h1>
            {skill.category && (
              <span className="text-caption text-chart-4 shrink-0">{skill.category}</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <SourceBadge source={skill.source} />
            {(skill.assignedTo?.length ?? 0) > 0 && (
              <span className="text-caption text-muted-foreground">
                {skill.assignedTo!.length} agent{skill.assignedTo!.length !== 1 ? "s" : ""}
              </span>
            )}
            {files.data && (
              <span className="text-caption text-muted-foreground">
                {files.data.files.length} file{files.data.files.length !== 1 ? "s" : ""} · {formatSize(files.data.totalBytes)}
              </span>
            )}
          </div>
        </div>

        <SegmentedControl
          size="sm"
          aria-label="Files or versions"
          value={tab === "versions" && !viewVersion ? "versions" : "files"}
          onValueChange={(v) => setView({ tab: v, version: null })}
        >
          <ToggleGroupItem value="files" aria-label="Files"><FileText className="h-3.5 w-3.5 mr-1" /> Files</ToggleGroupItem>
          <ToggleGroupItem value="versions" aria-label="Versions">
            <History className="h-3.5 w-3.5 mr-1" /> Versions{versionCount ? ` (${versionCount})` : ""}
          </ToggleGroupItem>
        </SegmentedControl>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <Download className="h-3.5 w-3.5 mr-1.5" /> Download
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild><a href={files.downloadUrl("skill")} download>{skill.name}.skill</a></DropdownMenuItem>
            <DropdownMenuItem asChild><a href={files.downloadUrl("zip")} download>{skill.name}.zip</a></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Content grid: on desktop each column scrolls on its own; the left one (tree, details) stays in view ── */}
      <div className="flex-1 min-h-0 overflow-auto pb-bottom-nav lg:overflow-hidden lg:pb-2" data-testid="skill-detail-scroll">
        <div className="grid grid-cols-1 lg:grid-cols-4 lg:grid-rows-1 lg:h-full gap-4">
          {/* Left: files and metadata (sticky on desktop, with its own scroll when taller than the window) */}
          <aside
            className="lg:col-span-1 space-y-4 min-w-0 lg:sticky lg:top-0 lg:self-start lg:max-h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain"
            data-testid="skill-detail-sidebar"
          >
            <nav aria-label="Files" className="rounded-lg border border-border/40 bg-card/80 p-2">
              <div className="flex items-center justify-between px-2 pb-1.5">
                <span className="text-label text-muted-foreground">{viewVersion ? `Files of v${viewVersion}` : "Files"}</span>
                {(viewVersion ? !shownVersion : files.isLoading) && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <SkillFileTree files={fileList} selected={selected} onSelect={openFile} />
              {!viewVersion && files.data?.truncated && <p className="px-2 pt-1 text-micro text-muted-foreground">More files than shown: download the skill to see them all</p>}
            </nav>
            <MetadataCard
              skill={skill}
              pool={pool}
              agentTeamMap={agentTeamMap}
              teams={teams}
            />
          </aside>

          {/* Main: the selected file (SKILL.md by default), a version's file, or the versions */}
          <div className="lg:col-span-3 min-w-0 space-y-4 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain" data-testid="skill-detail-main">
            {viewVersion && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-4 py-2" role="status" data-testid="version-banner">
                <History className="h-3.5 w-3.5 text-info" />
                <span className="min-w-0 flex-1 text-caption text-foreground">
                  Version {viewVersion} (read-only)
                  {shownVersion?.data && ` · ${new Date(shownVersion.data.version.createdAt).toLocaleString()} · ${versionAuthor(shownVersion.data.version.author)} · ${versionSourceLabel(shownVersion.data.version)}`}
                  {isCurrentVersion && " · current"}
                </span>
                <Button variant="ghost" size="sm" className="h-7" asChild>
                  <a href={versions.downloadUrl(viewVersion)} download aria-label={`Download version ${viewVersion}`}><Download className="h-3.5 w-3.5" /></a>
                </Button>
                {!isCurrentVersion && (
                  <Button variant="outline" size="sm" className="h-7" onClick={() => setConfirmRestore(true)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-7" onClick={() => setView({ version: null, tab: "versions" })}>Back to versions</Button>
                <Button variant="ghost" size="sm" className="h-7" onClick={() => setView({ version: null, tab: "files" })}>Current files</Button>
              </div>
            )}
            {tab === "versions" && !viewVersion ? (
              <SkillVersionsPanel versions={versions} onView={(n) => setView({ version: n })} />
            ) : viewVersion && shownVersion?.error ? (
              <div className="rounded-lg border border-border/40 bg-card/80 p-6 text-center">
                <p className="text-sm text-muted-foreground">{shownVersion.error}</p>
              </div>
            ) : viewVersion && !shownVersion ? (
              <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : viewVersion ? (
              missing ? (
                <div className="rounded-lg border border-border/40 bg-card/80 p-6 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">"{selected}" is not a file of version {viewVersion}</p>
                  <Button variant="outline" size="sm" onClick={() => openFile("SKILL.md")}>Open SKILL.md</Button>
                </div>
              ) : (
                <SkillFileViewer
                  path={selected}
                  file={current}
                  files={fileList}
                  fileUrl={(path, opts) => versions.fileUrl(viewVersion, path, opts)}
                  readText={readVersionText}
                  onOpen={openFile}
                />
              )
            ) : contentError && selected === "SKILL.md" ? (
              <div className="rounded-lg border border-border/40 bg-card/80 p-6 text-center">
                <p className="text-sm text-muted-foreground">{contentError}</p>
              </div>
            ) : missing ? (
              <div className="rounded-lg border border-border/40 bg-card/80 p-6 text-center space-y-3">
                <p className="text-sm text-muted-foreground">"{selected}" is not a file of this skill</p>
                <Button variant="outline" size="sm" onClick={() => openFile("SKILL.md")}>Open SKILL.md</Button>
              </div>
            ) : (
              <SkillFileViewer
                path={selected}
                file={current}
                files={fileList}
                skillBody={loadedSkill?.content}
                fileUrl={files.fileUrl}
                readText={readText}
                onOpen={openFile}
              />
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRestore}
        onOpenChange={setConfirmRestore}
        title={`Restore version ${viewVersion ?? ""}?`}
        description={`The skill's files become those of version ${viewVersion ?? ""}. The current files are kept as a version first, so you can undo this.`}
        confirmLabel="Restore"
        loading={restoring}
        onConfirm={() => void restoreViewed()}
      />
    </div>
  );
}
