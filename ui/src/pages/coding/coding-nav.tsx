/**
 * The Coding app's navigation: projects → worktrees → sessions, with "Add workspace" (a new
 * worktree), new sessions, archive, PR state and git stats. Shown in the drill-in sidebar's Coding
 * level, in the chat-first layout's column on /coding, and in the page's sessions sheet when
 * neither is on screen (classic sidebar, collapsed rail). It reads the shared Coding store, so the
 * page and the navigation always agree.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Activity, Archive, ChevronDown, ChevronRight, GitBranch, GitMerge, GitPullRequest, MessageSquare, Plus, Settings, Terminal as TerminalIcon, Trash2,
} from "lucide-react";
import { useCodingChats } from "@polpo-ai/react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { apiFetch, apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import { CodingSettingsDialog } from "./settings-dialog";
import { ProcessesDialog } from "./processes-dialog";
import { useCodingSettings } from "./coding-settings";
import { useGitInfo } from "./use-git-info";
import { NewWorkspacePopover } from "./workspace-controls";
import { codingActions, useCodingState } from "./use-coding-state";
import { canOpenAsChat } from "./chat-parts";
import type { CodingTerminal, CodingWorkspace, PendingWorkspace } from "./types";

/** A project is bound to a folder: its name is the folder's. */
function projectLabel(project: CodingWorkspace): string {
  if (project.cwd && project.cwd !== ".") return project.cwd.split("/").filter(Boolean).pop() ?? project.name;
  return project.name;
}

/** One git worktree of a project: its sessions grouped by (branch, cwd); none = the project's checkout. */
type WorkspaceGroup = {
  key: string;
  projectId: string;
  branch: string | undefined;
  cwd: string;
  label: string | undefined;
  terminals: CodingTerminal[];
};

function groupTerminalsIntoWorkspaces(project: CodingWorkspace, terminals: CodingTerminal[]): WorkspaceGroup[] {
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
  return Array.from(map.values()).sort((a, b) => {
    if (!a.branch && b.branch) return -1;
    if (a.branch && !b.branch) return 1;
    return (a.branch ?? "").localeCompare(b.branch ?? "");
  });
}

let workDirCache: string | undefined;
/** The server's agent workspace (the project picker starts there). */
function useWorkDir(): string | undefined {
  const [workDir, setWorkDir] = useState(workDirCache);
  useEffect(() => {
    if (workDirCache) return;
    let cancelled = false;
    apiFetch(apiUrl("/api/v1/terminal/status"))
      .then((r) => r.json())
      .then((b) => { if (!cancelled && b?.ok) { workDirCache = b.data.workDir as string; setWorkDir(workDirCache); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return workDir;
}

export interface CodingNavProps {
  /** Where it is drawn: the main sidebar's tokens, or the page's surfaces. */
  surface?: "sidebar" | "page";
  /** After picking a session (the mobile sheet closes). */
  onNavigate?: () => void;
  className?: string;
}

export function CodingNav({ surface = "page", onNavigate, className }: CodingNavProps) {
  const s = useCodingState();
  const navigate = useNavigate();
  const workDir = useWorkDir();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [settings] = useCodingSettings();
  const extraRoots = settings.allowOutsideWorkspace ? settings.allowedExtraRoots : [];
  const { chats } = useCodingChats();
  const chatStatus = new Map(chats.map((c) => [c.id, c.status]));

  // this panel shows the sessions: the page need not offer its own
  useEffect(() => codingActions.registerNavPanel(), []);

  const toCoding = () => {
    if (!window.location.pathname.startsWith("/coding")) navigate("/coding");
    onNavigate?.();
  };
  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const sidebar = surface === "sidebar";

  return (
    <div className={cn("flex min-h-0 w-full flex-1 flex-col", className)} data-testid="coding-nav">
      <CodingSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ProcessesDialog open={processesOpen} onOpenChange={setProcessesOpen} terminals={s.terminals} workspaces={s.workspaces} />
      <div className="flex h-8 shrink-0 items-center px-3">
        <span className={cn("text-label", sidebar ? "text-sidebar-foreground/50" : "text-muted-foreground")}>Projects</span>
        {s.workspaces.length > 0 && <span className="ml-1.5 text-micro tabular-nums text-muted-foreground/60">{s.workspaces.length}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-1.5 pb-2">
        {s.workspaces.map((project) => {
          const concrete = groupTerminalsIntoWorkspaces(project, s.terminals);
          const keys = new Set(concrete.map((g) => g.key));
          const pending = s.pendingWorkspaces
            .filter((p) => p.projectId === project.id && !keys.has(`${p.branch ?? ""}::${p.cwd}`))
            .map((p: PendingWorkspace): WorkspaceGroup => ({ key: `${p.branch ?? ""}::${p.cwd}`, projectId: project.id, branch: p.branch || undefined, cwd: p.cwd, label: p.label, terminals: [] }));
          const isCollapsed = collapsed.has(project.id);
          return (
            <section key={project.id} className="mb-3" aria-label={projectLabel(project)}>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => toggle(project.id)}
                    aria-expanded={!isCollapsed}
                    className="group/header flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-muted/50"
                  >
                    <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
                      {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </span>
                    <span title={project.cwd} className="flex-1 truncate text-small font-medium text-muted-foreground">{projectLabel(project)}</span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => codingActions.closeWorkspace(project.id)} variant="destructive">
                    <Trash2 className="h-3.5 w-3.5" /> Remove project
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              {!isCollapsed && (
                <div className="ml-3 mt-0.5 space-y-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      void codingActions.addWorkspaceFast(project.id).then(toCoding).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Failed to create workspace"));
                    }}
                    aria-label="Add workspace"
                    title="New workspace (worktree)"
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-caption font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span className="flex-1">Add workspace</span>
                  </button>
                  {[...concrete, ...pending].map((ws) => {
                    const isPending = ws.terminals.length === 0;
                    const pendingKey = `${project.id}::${ws.branch ?? ""}::${ws.cwd}`;
                    const active = isPending ? s.activePendingKey === pendingKey : !s.activePendingKey && ws.terminals.some((t) => t.id === s.activeId);
                    return (
                      <WorkspaceRow
                        key={ws.key}
                        workspace={ws}
                        active={active}
                        pending={isPending}
                        activeId={s.activePendingKey ? "" : s.activeId}
                        chatStatus={chatStatus}
                        onSelect={() => {
                          if (isPending) codingActions.setActivePendingKey(pendingKey);
                          else {
                            const first = ws.terminals.find((t) => !t.tabHidden) ?? ws.terminals[0];
                            if (first) codingActions.setActiveId(first.id);
                          }
                          toCoding();
                        }}
                        onSelectSession={(id) => { codingActions.unhideTerminalTab(id); toCoding(); }}
                        onNewSession={() => {
                          const t = ws.terminals[0];
                          codingActions.addTerminal(project.id, { agentKind: "claude", cwdOverride: t?.cwdOverride ?? (ws.cwd !== project.cwd ? ws.cwd : undefined), branch: ws.branch, workspaceLabel: ws.label });
                          toCoding();
                        }}
                        onCloseAll={() => { for (const t of ws.terminals) codingActions.closeTerminal(t.id); }}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className={cn("flex shrink-0 items-center gap-0.5 border-t px-1 py-1.5", sidebar ? "border-sidebar-border" : "border-border/70")}>
        <NewWorkspacePopover
          root={workDir}
          extraRoots={extraRoots}
          label="Add project"
          onCreate={(cwd, name) => { codingActions.addWorkspace({ cwd, name }); toCoding(); }}
        />
        <div className="flex-1" />
        <FooterIconButton label="Processes" onClick={() => setProcessesOpen(true)}><Activity className="h-4 w-4" /></FooterIconButton>
        <FooterIconButton label="Settings" onClick={() => setSettingsOpen(true)}><Settings className="h-4 w-4" /></FooterIconButton>
      </div>
    </div>
  );
}

function SessionIcon({ terminal }: { terminal: CodingTerminal }) {
  if (terminal.chatId || (terminal.agentKind && terminal.agentKind !== "terminal" && !terminal.agentSessionId && !terminal.agentCommand)) {
    return <MessageSquare className="h-3 w-3 shrink-0" aria-label="Chat" />;
  }
  return <TerminalIcon className="h-3 w-3 shrink-0" aria-label="Terminal" />;
}

const STATUS_DOT: Record<string, string> = { running: "bg-info", "awaiting-approval": "bg-warning", error: "bg-destructive" };
const STATUS_TEXT: Record<string, string> = { running: "Working", "awaiting-approval": "Needs approval", error: "Error" };

function WorkspaceRow({
  workspace, active, pending, activeId, chatStatus, onSelect, onSelectSession, onNewSession, onCloseAll,
}: {
  workspace: WorkspaceGroup;
  active: boolean;
  pending: boolean;
  activeId: string;
  chatStatus: Map<string, string>;
  onSelect: () => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onCloseAll: () => void;
}) {
  const refreshKey = workspace.terminals.reduce((acc, t) => acc + t.revision, 0);
  const git = useGitInfo(workspace.cwd, refreshKey);
  const branchLabel = git?.branch || workspace.branch || "main";
  const hasGitMeta = !pending && (git?.pr || (git && (git.insertions > 0 || git.deletions > 0 || git.ahead > 0 || git.behind > 0)));
  return (
    <div data-testid="coding-worktree">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
            aria-current={active ? "true" : undefined}
            className={cn("group/ws relative cursor-pointer rounded-md px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-muted text-foreground" : "hover:bg-muted/50")}
          >
            <div className="flex items-center gap-1.5">
              <GitBranch className={cn("h-3 w-3 shrink-0", active ? "text-foreground/70" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate font-mono text-caption font-medium text-foreground/85" title={branchLabel}>{branchLabel}</span>
              {pending ? (
                <span className="shrink-0 rounded-xs bg-warning/15 px-1.5 py-px text-micro font-medium text-warning">empty</span>
              ) : (
                <span className="shrink-0 rounded-xs bg-background/70 px-1.5 py-px text-micro tabular-nums text-muted-foreground">{workspace.terminals.length}</span>
              )}
              {!pending && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onNewSession(); }}
                  aria-label="New session in this workspace"
                  title="New Claude Code session"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onCloseAll(); }}
                aria-label="Archive workspace"
                title="Archive (ends all sessions on this branch)"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100"
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            </div>
            {(workspace.label || hasGitMeta) && (
              <div className="mt-1 flex items-center gap-2 pl-[18px] text-micro text-muted-foreground">
                {workspace.label && <span className="font-medium text-foreground/70" title={workspace.label}>{workspace.label}</span>}
                {git?.pr && <PrPill state={git.pr.state} number={git.pr.number} url={git.pr.url} />}
                {git && (git.insertions > 0 || git.deletions > 0) && (
                  <span className="flex items-center gap-1 font-mono tabular-nums">
                    {git.insertions > 0 && <span className="text-success">+{git.insertions}</span>}
                    {git.deletions > 0 && <span className="text-destructive">−{git.deletions}</span>}
                  </span>
                )}
                {git && git.ahead > 0 && <span className="font-mono tabular-nums text-info">↑{git.ahead}</span>}
                {git && git.behind > 0 && <span className="font-mono tabular-nums text-warning">↓{git.behind}</span>}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onCloseAll} variant="destructive">
            <Archive className="h-3.5 w-3.5" /> Archive workspace
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!pending && (
        <ul className="ml-4 mt-0.5 space-y-px border-l border-border/60 pl-1.5" aria-label={`Sessions in ${branchLabel}`}>
          {workspace.terminals.map((t) => {
            const status = t.chatId ? chatStatus.get(t.chatId) : undefined;
            return (
              <li key={t.id}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onSelectSession(t.id)}
                      aria-current={t.id === activeId ? "true" : undefined}
                      data-testid="coding-session-row"
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-xs px-1.5 py-1 text-left text-caption transition-colors",
                        t.id === activeId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        t.tabHidden && "opacity-60",
                      )}
                    >
                      <SessionIcon terminal={t} />
                      <span className="min-w-0 flex-1 truncate">{t.label || "Session"}</span>
                      {status && STATUS_DOT[status] && (
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-pill", STATUS_DOT[status])} title={STATUS_TEXT[status]} aria-label={STATUS_TEXT[status]} />
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {canOpenAsChat(t) ? (
                      <ContextMenuItem onClick={() => {
                        void codingActions.openTerminalAsChat(t.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not open the session as a chat"));
                      }}>
                        <MessageSquare className="h-3.5 w-3.5" /> {t.convertedToChatId ? "Go to chat" : "Open as chat"}
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem onClick={() => codingActions.closeTerminal(t.id)} variant="destructive">
                      <Archive className="h-3.5 w-3.5" /> End session
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Compact PR indicator: merged, closed or open. */
function PrPill({ state, number, url }: { state: string | undefined; number: number; url: string }) {
  const s = (state ?? "open").toLowerCase();
  const tint = s === "merged" ? "bg-chart-5/15 text-chart-5 hover:bg-chart-5/25" : s === "closed" ? "bg-destructive/15 text-destructive hover:bg-destructive/25" : "bg-success/15 text-success hover:bg-success/25";
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`PR #${number} · ${s}`}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-px text-micro font-medium transition-colors", tint)}
    >
      {s === "merged" ? <GitMerge className="h-2.5 w-2.5" /> : <GitPullRequest className="h-2.5 w-2.5" />}
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
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
