import { useState } from "react";
import { Activity, Archive, ChevronDown, ChevronRight, GitBranch, GitMerge, GitPullRequest, Plus, Settings, Trash2 } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { CodingSettingsDialog } from "./settings-dialog";
import { ProcessesDialog } from "./processes-dialog";
import { useCodingSettings } from "./coding-settings";
import { useGitInfo } from "./use-git-info";
import { NewWorkspacePopover } from "./workspace-controls";
import type { CodingAgentKind, CodingTerminal, CodingWorkspace } from "./types";

/** A project is bound to a folder, so the displayed name = basename(cwd). */
function projectLabel(project: CodingWorkspace): string {
  if (project.cwd && project.cwd !== ".") {
    return project.cwd.split("/").filter(Boolean).pop() ?? project.name;
  }
  return project.name;
}

export type NewTerminalConfig = {
  agentKind: CodingAgentKind;
  agentCommand?: string;
  cwdOverride?: string;
  branch?: string;
  label?: string;
};

/** A "Workspace" in this UI = one git worktree of a Project. Computed
 * client-side by grouping a project's terminals by (branch, cwdOverride);
 * an undefined pair means "the project's main checkout" (Same mode). */
type WorkspaceGroup = {
  key: string;
  projectId: string;
  branch: string | undefined;
  cwd: string;
  /** Friendly workspace label (city name, etc.) — derived from the first
   * session's `workspaceLabel`. Survives branch renames. */
  label: string | undefined;
  terminals: CodingTerminal[];
};

function groupTerminalsIntoWorkspaces(
  project: CodingWorkspace,
  terminals: CodingTerminal[],
): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>();
  for (const t of terminals) {
    if (t.workspaceId !== project.id) continue;
    const branch = t.branch || undefined;
    const cwd = t.cwdOverride || project.cwd;
    const key = `${branch ?? ""}::${cwd}`;
    const existing = map.get(key);
    if (existing) {
      existing.terminals.push(t);
      if (!existing.label && t.workspaceLabel) existing.label = t.workspaceLabel;
    } else {
      map.set(key, { key, projectId: project.id, branch, cwd, label: t.workspaceLabel, terminals: [t] });
    }
  }
  // Stable order: main first, then branches alphabetically.
  return Array.from(map.values()).sort((a, b) => {
    if (!a.branch && b.branch) return -1;
    if (a.branch && !b.branch) return 1;
    return (a.branch ?? "").localeCompare(b.branch ?? "");
  });
}

type Pending = { key: string; projectId: string; branch: string; cwd: string; label: string };

type SidebarProps = {
  workspaces: CodingWorkspace[]; // these are *projects* in user-facing lingo
  terminals: CodingTerminal[];
  activeId: string;
  pendingWorkspaces: Pending[];
  activePendingKey: string | null;
  /** Server work directory — clamps the path picker so users can't escape it. */
  workDir?: string;
  onSelectTerminal: (id: string) => void;
  onSelectPending: (key: string) => void;
  onAddProject: (opts?: { cwd?: string; name?: string }) => void;
  onCloseProject: (projectId: string) => void;
  /** Fast path — creates a worktree on disk and lands the user on the empty
   * quick-start screen (no dialog). Replaces the previous NewTerminalDialog
   * entry from the project header. */
  onAddWorkspace: (projectId: string) => void;
  onCloseTerminal: (id: string) => void;
};

/**
 * Sidebar: Projects → Workspaces (= worktrees). Sessions live in horizontal
 * tabs inside the main pane; this column is for "which task on which repo".
 */
export function CodingSidebar(props: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [settings] = useCodingSettings();
  const extraRoots = settings.allowOutsideWorkspace ? settings.allowedExtraRoots : [];

  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <aside className="flex h-full w-full flex-col">
      <CodingSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ProcessesDialog
        open={processesOpen}
        onOpenChange={setProcessesOpen}
        terminals={props.terminals}
        workspaces={props.workspaces}
      />
      <div className="flex h-9 shrink-0 items-center px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
          Projects
        </span>
        {props.workspaces.length > 0 && (
          <span className="ml-1.5 text-[10px] tabular-nums text-white/25">{props.workspaces.length}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {props.workspaces.map((project) => {
          // Combine concrete (terminal-derived) groups with pending entries
          // for this project; dedupe by group key so a pending worktree
          // collapses into its real group as soon as a session lands.
          const concrete = groupTerminalsIntoWorkspaces(project, props.terminals);
          const concreteKeys = new Set(concrete.map((g) => g.key));
          const pendingForProject = props.pendingWorkspaces
            .filter((p) => p.projectId === project.id)
            .filter((p) => !concreteKeys.has(`${p.branch ?? ""}::${p.cwd}`))
            .map((p): WorkspaceGroup => ({
              key: `${p.branch ?? ""}::${p.cwd}`,
              projectId: project.id,
              branch: p.branch || undefined,
              cwd: p.cwd,
              label: p.label,
              terminals: [],
            }));
          return (
            <ProjectGroup
              key={project.id}
              project={project}
              workspaces={[...concrete, ...pendingForProject]}
              activeId={props.activeId}
              activePendingKey={props.activePendingKey}
              collapsed={collapsed.has(project.id)}
              onToggle={() => toggle(project.id)}
              onSelectTerminal={props.onSelectTerminal}
              onSelectPending={props.onSelectPending}
              onCloseTerminal={props.onCloseTerminal}
              onAddWorkspace={() => props.onAddWorkspace(project.id)}
              onCloseProject={() => props.onCloseProject(project.id)}
            />
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-t border-white/[0.06] px-1 py-1.5">
        <NewWorkspacePopover
          root={props.workDir}
          extraRoots={extraRoots}
          label="Add project"
          onCreate={(cwd, name) => props.onAddProject({ cwd, name })}
        />
        <div className="flex-1" />
        <FooterIconButton label="Processes" onClick={() => setProcessesOpen(true)}>
          <Activity className="h-4 w-4" />
        </FooterIconButton>
        <FooterIconButton label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="h-4 w-4" />
        </FooterIconButton>
      </div>
    </aside>
  );
}

type ProjectGroupProps = {
  project: CodingWorkspace;
  workspaces: WorkspaceGroup[];
  activeId: string;
  activePendingKey: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelectTerminal: (id: string) => void;
  onSelectPending: (key: string) => void;
  onCloseTerminal: (id: string) => void;
  onAddWorkspace: () => void;
  onCloseProject: () => void;
};

function ProjectGroup({
  project,
  workspaces,
  activeId,
  activePendingKey,
  collapsed,
  onToggle,
  onSelectTerminal,
  onSelectPending,
  onCloseTerminal,
  onAddWorkspace,
  onCloseProject,
}: ProjectGroupProps) {
  return (
    <section className="mb-4">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <header
            className="group/header flex items-center gap-1 rounded-md px-1.5 py-1 cursor-pointer hover:bg-white/[0.025]"
            onClick={onToggle}
          >
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center text-white/35 group-hover/header:text-white/60"
            >
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>

            <span
              title={project.cwd}
              className="flex-1 truncate text-left text-[12.5px] font-medium tracking-tight text-white/40"
            >
              {projectLabel(project)}
            </span>
          </header>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onCloseProject} variant="destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Remove project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {!collapsed && (
        <div className="mt-0.5 ml-3 space-y-0.5">
          {/* Add-workspace as the first row of every project, à la Conductor.
              Zero friction: clicking creates the worktree on disk and lands
              the user on the empty quick-start screen. */}
          <button
            type="button"
            onClick={onAddWorkspace}
            aria-label="Add workspace"
            title="New workspace (worktree)"
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] font-medium text-white/55 hover:bg-white/[0.04] hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="flex-1">Add workspace</span>
          </button>
          {workspaces.map((ws) => {
            const isPending = ws.terminals.length === 0;
            return (
              <WorkspaceRow
                key={ws.key}
                workspace={ws}
                active={isPending
                  ? activePendingKey === `${project.id}::${ws.branch ?? ""}::${ws.cwd}`
                  : ws.terminals.some((t) => t.id === activeId)}
                pending={isPending}
                onSelect={() => {
                  if (isPending) {
                    onSelectPending(`${project.id}::${ws.branch ?? ""}::${ws.cwd}`);
                    return;
                  }
                  const first = ws.terminals.find((t) => !t.tabHidden) ?? ws.terminals[0];
                  if (first) onSelectTerminal(first.id);
                }}
                onCloseAll={() => {
                  for (const t of ws.terminals) onCloseTerminal(t.id);
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function WorkspaceRow({
  workspace,
  active,
  pending,
  onSelect,
  onCloseAll,
}: {
  workspace: WorkspaceGroup;
  active: boolean;
  pending: boolean;
  onSelect: () => void;
  onCloseAll: () => void;
}) {
  const refreshKey = workspace.terminals.reduce((acc, t) => acc + t.revision, 0);
  const git = useGitInfo(workspace.cwd, refreshKey);
  // Branch label = live git branch when available (catches renames from
  // the user or the agent automatically), with the stored value as a
  // pre-hydration fallback so the row doesn't flash empty.
  const branchLabel = git?.branch || workspace.branch || "main";
  // Always render the workspace label even when it currently matches the
  // branch — they'll drift the moment someone renames the branch and the
  // user wants the original identifier to stay visible.
  const wsLabel = workspace.label || null;
  const hasGitMeta = !pending && (git?.pr || (git && (git.insertions > 0 || git.deletions > 0 || git.ahead > 0 || git.behind > 0)));
  const hasSecondLine = wsLabel || hasGitMeta;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={onSelect}
          className={cn(
            "group/ws relative rounded-md px-2 py-1.5 cursor-pointer transition-colors",
            active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
          )}
        >
          <div className="flex items-center gap-1.5">
            <GitBranch className={cn("h-3 w-3 shrink-0", active ? "text-white/65" : "text-white/40")} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-left font-mono text-[11.5px] font-medium",
                active ? "text-white" : "text-white/85",
              )}
              title={branchLabel}
            >
              {branchLabel}
            </span>
            {pending ? (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[9.5px] font-medium text-amber-300/85">
                empty
              </span>
            ) : (
              <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-px text-[9.5px] tabular-nums text-white/55">
                {workspace.terminals.length}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseAll(); }}
              aria-label="Archive workspace"
              title="Archive (terminates all sessions on this branch)"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/30 opacity-0 hover:bg-white/[0.08] hover:text-white group-hover/ws:opacity-100"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Second line: workspace label (city) + PR + git stats.
              Hidden when label == branch and the tree is clean. */}
          {hasSecondLine && (
            <div className="mt-1 flex items-center gap-2 pl-[18px] text-[10px] text-white/45">
              {wsLabel && (
                <span className="font-medium text-white/70" title={wsLabel}>{wsLabel}</span>
              )}
              {git?.pr && <PrPill state={git.pr.state} number={git.pr.number} url={git.pr.url} />}
              {git && (git.insertions > 0 || git.deletions > 0) && (
                <span className="flex items-center gap-1 font-mono tabular-nums">
                  {git.insertions > 0 && <span className="text-emerald-400/85">+{git.insertions}</span>}
                  {git.deletions > 0 && <span className="text-rose-400/85">−{git.deletions}</span>}
                </span>
              )}
              {git && git.ahead > 0 && <span className="font-mono tabular-nums text-sky-400/80">↑{git.ahead}</span>}
              {git && git.behind > 0 && <span className="font-mono tabular-nums text-amber-400/80">↓{git.behind}</span>}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onCloseAll} variant="destructive">
          <Archive className="h-3.5 w-3.5" />
          Archive workspace
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Compact PR indicator — color hints the state at a glance:
 * - merged   → muted purple, GitMerge icon
 * - closed   → rose
 * - open     → emerald  (default)
 * Click opens the PR on the host. */
function PrPill({ state, number, url }: { state: string | undefined; number: number; url: string }) {
  const s = (state ?? "open").toLowerCase();
  const isMerged = s === "merged";
  const isClosed = s === "closed";
  const tint = isMerged
    ? "bg-violet-500/15 text-violet-300/90 hover:bg-violet-500/25"
    : isClosed
      ? "bg-rose-500/15 text-rose-300/90 hover:bg-rose-500/25"
      : "bg-emerald-500/15 text-emerald-300/90 hover:bg-emerald-500/25";
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`PR #${number} · ${s}`}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[9.5px] font-medium transition-colors", tint)}
    >
      {isMerged ? <GitMerge className="h-2.5 w-2.5" /> : <GitPullRequest className="h-2.5 w-2.5" />}
      <span className="tabular-nums">#{number}</span>
    </a>
  );
}

function FooterIconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/40 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
