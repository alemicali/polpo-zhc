import { useEffect, useRef, useState } from "react";
import {
  Cloud,
  GitBranch,
  GitMerge,
  GitPullRequest as GitPullRequestIcon,
  Laptop,
  Loader2,
  PanelLeft,
  PanelRight,
  RefreshCcw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { apiUrl, endpointHost, isLocalEndpoint } from "@/lib/config";
import { cn } from "@/lib/utils";
import { useCodingState } from "./coding/use-coding-state";
import { useGitInfo } from "./coding/use-git-info";
import { CodingSidebar } from "./coding/sidebar";
import { RightPanel } from "./coding/right-panel";
import { SessionTabs } from "./coding/session-tabs";
import { TerminalSession } from "./coding/terminal-session";
import { EmptyWorkspaceQuickStart } from "./coding/empty-quickstart";
import { useCodingSettings } from "./coding/coding-settings";
import { useLocalState } from "./coding/use-local-state";

type TerminalStatus = {
  enabled: boolean;
  workDir: string;
  agentWorkDir: string;
  shell: string;
};

export function CodingPage() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useLocalState<boolean>("polpo:coding:sidebarOpen", true);
  const [rightOpen, setRightOpen] = useLocalState<boolean>("polpo:coding:rightOpen", true);
  // react-resizable-panels v4 dropped autoSaveId — wire defaultLayout and
  // onLayoutChanged manually. Layout is { panelId: percentage }.
  const [panelLayout, setPanelLayout] = useLocalState<Record<string, number>>("polpo:coding:panelLayout", {});

  const {
    workspaces,
    terminals,
    activeId,
    connections,
    setActiveId,
    addWorkspace,
    closeWorkspace,
    addTerminal,
    closeTerminal,
    hideTerminalTab,
    unhideTerminalTab,
    reorderTerminal,
    renameTerminal,
    setConnection,
  } = useCodingState();

  const [codingSettings] = useCodingSettings();
  const [busy, setBusy] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(() => window.innerWidth);

  /** Empty worktrees that exist on disk but haven't spawned a session yet.
   * Survives reloads via localStorage; removed when the first session lands.
   * Keyed by `${projectId}::${branch}::${cwd}` to match WorkspaceGroup keys. */
  type Pending = { key: string; projectId: string; branch: string; cwd: string; label: string };
  const [pendingWorkspaces, setPendingWorkspaces] = useLocalState<Pending[]>("polpo:coding:pendingWorkspaces", []);
  const [activePendingKey, setActivePendingKey] = useLocalState<string | null>("polpo:coding:activePendingKey", null);

  const activeTerminal = terminals.find((t) => t.id === activeId);
  const activeWorkspace = workspaces.find((w) => w.id === activeTerminal?.workspaceId);
  const activeCwd = activeWorkspace?.cwd ?? ".";
  const activeRevision = activeTerminal?.revision ?? 0;
  // Header git info follows the active *worktree* (where the user is
  // actually working) rather than the project root — otherwise branch /
  // PR / diff stats up top stay frozen on `main` while sessions live in
  // their own worktree branches.
  const headerCwd = activeTerminal?.cwdOverride || activeCwd;
  const git = useGitInfo(headerCwd, activeRevision);

  /** Conductor-style auto-name. The branch must be unique inside the repo
   * so we keep the suffix; the workspace label is just the city,
   * capitalized — that's the thing the user identifies the worktree by,
   * and it survives any future `git branch -m` rename. */
  const autoNames = () => {
    const cities = [
      "nagoya", "montreal", "salvador", "khartoum", "lisbon", "tokyo", "oslo",
      "vienna", "paris", "kyoto", "helsinki", "dublin", "prague", "vancouver",
      "lima", "athens", "dakar", "manila", "tunis", "cairo", "hanoi", "rome",
      "berlin", "madrid", "london", "sydney", "austin", "denver", "taipei",
      "seoul", "beirut", "mumbai", "bogota", "nairobi", "riga", "sofia",
      "zurich", "geneva", "valencia", "porto", "naples", "milan", "turin",
      "bologna", "florence", "venice", "palermo", "genoa", "bari", "trieste",
    ];
    const c = cities[Math.floor(Math.random() * cities.length)] ?? "session";
    const s = Math.random().toString(36).slice(2, 5);
    // Label and branch start identical — the label persists if the agent
    // later renames the branch, but at creation we don't prettify.
    const branch = `${c}-${s}`;
    return { branch, label: branch };
  };

  /** "+ Add workspace" handler — creates the worktree on disk in one shot
   * and lands the user on the empty quick-start screen. No agent picker,
   * no branch input. */
  const addWorkspaceFast = async (projectId: string) => {
    const project = workspaces.find((w) => w.id === projectId);
    if (!project) return;
    const { branch, label } = autoNames();
    try {
      const res = await fetch(apiUrl("/api/v1/git/worktree/create"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: project.cwd, branch }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `Worktree create failed (${res.status})`);
      const cwd = body.data.path as string;
      const resolvedBranch = (body.data.branch as string) || branch;
      const key = `${projectId}::${resolvedBranch}::${cwd}`;
      setPendingWorkspaces((prev) => prev.some((p) => p.key === key) ? prev : [...prev, { key, projectId, branch: resolvedBranch, cwd, label }]);
      setActivePendingKey(key);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create workspace");
    }
  };

  /** Quick-start spawn from the empty workspace screen — adds a session in
   * the pending worktree's branch+cwd and drops the pending placeholder. */
  const startQuickSession = (kind: "terminal" | "claude" | "codex") => {
    if (!activePendingKey) return;
    const pending = pendingWorkspaces.find((p) => p.key === activePendingKey);
    if (!pending) return;
    addTerminal(pending.projectId, {
      agentKind: kind,
      cwdOverride: pending.cwd,
      branch: pending.branch,
      workspaceLabel: pending.label,
    });
    setPendingWorkspaces((prev) => prev.filter((p) => p.key !== pending.key));
    setActivePendingKey(null);
  };

  const openPR = () => {
    // Spin up a one-shot Claude session that stages, commits, pushes, and
    // opens the PR for the active terminal's branch — using the user's
    // configured `prCommand` (default is non-interactive end-to-end).
    // `silent: true` means we do NOT steal focus; the session lives in the
    // sidebar so the user can peek at progress (or kill it from Activity).
    if (!activeTerminal || !activeWorkspace) {
      toast.error("Open a workspace first");
      return;
    }
    addTerminal(activeWorkspace.id, {
      agentKind: "claude",
      agentCommand: codingSettings.prCommand,
      cwdOverride: activeTerminal.cwdOverride || activeWorkspace.cwd,
      branch: activeTerminal.branch,
      label: "PR",
      silent: true,
    });
    toast.success("PR session started — see sidebar / Activity");
  };

  const mergePR = async () => {
    if (busy || !git?.pr) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/v1/git/pr/merge"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: activeCwd, number: git.pr.number, method: "squash" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `Merge failed (${res.status})`);
      toast.success(`Merged PR #${git.pr.number}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to merge");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);

    fetch(apiUrl("/api/v1/terminal/status"), { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error(body?.error || `Terminal status failed (${res.status})`);
        return body.data as TerminalStatus;
      })
      .then((data) => { if (!cancelled) setStatus(data); })
      .catch((err) => {
        if (cancelled) return;
        setStatusError(err instanceof Error && err.name === "AbortError"
          ? "Terminal status request timed out."
          : err instanceof Error ? err.message : "Terminal status failed");
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!status?.enabled || !surfaceRef.current) return;
    const update = () => setSurfaceWidth(surfaceRef.current?.getBoundingClientRect().width ?? window.innerWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surfaceRef.current);
    return () => observer.disconnect();
  }, [status?.enabled]);

  if (statusError) {
    return (
      <CodingNotice
        icon={<ShieldAlert className="h-5 w-5" />}
        title="Coding unavailable"
        detail={statusError}
        action={<Button size="sm" variant="outline" onClick={() => window.location.reload()}><RefreshCcw className="h-4 w-4" /> Retry</Button>}
      />
    );
  }
  if (!status) {
    return <CodingNotice icon={<Loader2 className="h-5 w-5 animate-spin" />} title="Loading coding workspace" detail="Checking terminal status..." />;
  }
  if (!status.enabled) {
    return (
      <CodingNotice
        icon={<ShieldAlert className="h-5 w-5" />}
        title="Terminal disabled"
        detail="Set POLPO_TERMINAL_ENABLED=true on the server to enable interactive coding sessions."
      />
    );
  }

  const showCodingSidebar = sidebarOpen && surfaceWidth >= 480;
  const showCodingRightPanel = rightOpen && (surfaceWidth >= 860 || !showCodingSidebar);

  return (
    <div ref={surfaceRef} className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0d0d0d] text-white/85">
      {/* Coding-local controls only; platform navigation stays outside. */}
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.08] px-2">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 rounded-md transition-colors",
            showCodingSidebar ? "text-white/80 bg-white/[0.05]" : "text-white/40 hover:text-white/70 hover:bg-white/[0.03]",
          )}
          onClick={() => setSidebarOpen((v) => !v)}
          title="Toggle sidebar"
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 rounded-md transition-colors",
            showCodingRightPanel ? "text-white/80 bg-white/[0.05]" : "text-white/40 hover:text-white/70 hover:bg-white/[0.03]",
          )}
          onClick={() => setRightOpen((v) => !v)}
          title="Toggle right panel"
        >
          <PanelRight className="h-3.5 w-3.5" />
        </Button>

        {/* Center: repo · branch · PR · connection pill */}
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] min-w-0">
          <HeaderInfo workspace={activeWorkspace} state={(activeTerminal && connections[activeTerminal.id]) ?? "loading"} git={git} />
        </div>

        {git?.pr ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-7 gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-500/[0.08] px-2 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/[0.14] hover:text-emerald-200"
            onClick={mergePR}
          >
            <GitMerge className="h-3.5 w-3.5" /> Merge
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !git?.branch}
            className="h-7 gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.02] px-2 text-[11px] text-white/75 hover:bg-white/[0.07] hover:text-white"
            onClick={openPR}
          >
            <GitPullRequestIcon className="h-3.5 w-3.5" /> Open PR
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup
          orientation="horizontal"
          id="polpo-coding-panels"
          defaultLayout={Object.keys(panelLayout).length > 0 ? panelLayout : undefined}
          onLayoutChanged={(layout) => setPanelLayout(layout)}
          className="flex-1"
        >
          {showCodingSidebar && (
            <>
              <ResizablePanel
                id="sidebar"
                defaultSize="272px"
                minSize="180px"
                maxSize="480px"
                className="border-r border-white/[0.06]"
              >
                <CodingSidebar
                  workspaces={workspaces}
                  terminals={terminals}
                  activeId={activeId}
                  pendingWorkspaces={pendingWorkspaces}
                  activePendingKey={activePendingKey}
                  workDir={status.workDir}
                  onSelectTerminal={(id) => { setActiveId(id); setActivePendingKey(null); }}
                  onSelectPending={(key) => { setActivePendingKey(key); }}
                  onAddProject={addWorkspace}
                  onCloseProject={closeWorkspace}
                  onAddWorkspace={addWorkspaceFast}
                  onCloseTerminal={closeTerminal}
                />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}

          <ResizablePanel id="main">
            <main className="relative flex h-full w-full flex-col overflow-hidden bg-[#0a0a0a]">
              {activePendingKey ? (() => {
                const pending = pendingWorkspaces.find((p) => p.key === activePendingKey);
                return pending ? (
                  <EmptyWorkspaceQuickStart
                    branch={pending.branch}
                    projectName={workspaces.find((w) => w.id === pending.projectId)?.name ?? ""}
                    cwd={pending.cwd}
                    onStart={startQuickSession}
                  />
                ) : null;
              })() : (<>
              <SessionTabs
                workspace={activeWorkspace}
                terminals={terminals.filter((t) => {
                  // Visible tabs of the active worktree.
                  if (!activeTerminal) return false;
                  if (t.workspaceId !== activeTerminal.workspaceId) return false;
                  if (t.tabHidden) return false;
                  return (t.cwdOverride || "") === (activeTerminal.cwdOverride || "")
                    && (t.branch || "") === (activeTerminal.branch || "");
                })}
                hidden={terminals.filter((t) => {
                  // Hidden tabs = "history" — only those of the active
                  // worktree, so the popover stays scoped.
                  if (!activeTerminal) return false;
                  if (t.workspaceId !== activeTerminal.workspaceId) return false;
                  if (!t.tabHidden) return false;
                  return (t.cwdOverride || "") === (activeTerminal.cwdOverride || "")
                    && (t.branch || "") === (activeTerminal.branch || "");
                })}
                activeId={activeId}
                activeTerminal={activeTerminal}
                connections={connections}
                onSelect={setActiveId}
                onCloseTab={hideTerminalTab}
                onUnhideTab={unhideTerminalTab}
                onReorder={reorderTerminal}
                onRename={renameTerminal}
                onAddTerminal={addTerminal}
              />
              <div className="relative flex-1 min-h-0">
                {terminals.map((terminal) => {
                  const ws = workspaces.find((w) => w.id === terminal.workspaceId);
                  return (
                    <TerminalSession
                      key={terminal.id}
                      sessionId={terminal.id}
                      revision={terminal.revision}
                      cwd={terminal.cwdOverride || ws?.cwd || "."}
                      active={terminal.id === activeId}
                      agent={terminal.agentKind}
                      agentSessionId={terminal.agentSessionId}
                      agentCommand={terminal.agentCommand ?? (terminal.agentKind ? codingSettings.agentCommands[terminal.agentKind] : undefined)}
                      onConnectionChange={(state) => setConnection(terminal.id, state)}
                    />
                  );
                })}
              </div>
              </>)}
            </main>
          </ResizablePanel>

          {showCodingRightPanel && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="right"
                defaultSize="288px"
                minSize="288px"
                maxSize="80%"
                className="border-l border-white/[0.06]"
              >
                <RightPanel
                  workspaces={workspaces}
                  terminals={terminals.map((t) => {
                    const ws = workspaces.find((w) => w.id === t.workspaceId);
                    return {
                      id: t.id,
                      workspaceId: t.workspaceId,
                      cwd: t.cwdOverride || ws?.cwd || ".",
                      revision: t.revision,
                    };
                  })}
                  activeWorkspaceId={activeWorkspace?.id}
                  activeTerminalId={activeTerminal?.id}
                  cwd={activeCwd}
                  refreshKey={activeRevision}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function EndpointBadge() {
  const local = isLocalEndpoint();
  const host = endpointHost();
  // Discreet — just the icon next to the repo name, no chrome.
  return (
    <span
      title={local ? `Local · ${host}` : `Remote · ${host}`}
      aria-label={local ? "Local endpoint" : "Remote endpoint"}
      className={cn(
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center",
        local ? "text-emerald-400/70" : "text-sky-400/80",
      )}
    >
      {local ? <Laptop className="h-3 w-3" /> : <Cloud className="h-3 w-3" />}
    </span>
  );
}

function HeaderInfo({
  workspace,
  state,
  git,
}: {
  workspace: ReturnType<typeof useCodingState>["workspaces"][number] | undefined;
  state: ReturnType<typeof useCodingState>["connections"][string];
  git: ReturnType<typeof useGitInfo>;
}) {
  if (!workspace) return null;

  // Repo name preference: git remote → workspace name (config-given) as fallback.
  const repoLabel = git?.repo ?? workspace.name;

  return (
    <>
      {git?.pr && (
        <a
          href={git.pr.url}
          target="_blank"
          rel="noreferrer"
          title={`PR #${git.pr.number}: ${git.pr.title}`}
          className="flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-400/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-400/[0.12]"
        >
          <GitPullRequestIcon className="h-3 w-3" />
          <span className="tabular-nums">#{git.pr.number}</span>
          <span className="hidden xl:inline max-w-[16rem] truncate text-emerald-200/80">{git.pr.title}</span>
        </a>
      )}
      <span className="flex items-center gap-1.5 truncate">
        <GitBranch className="h-3.5 w-3.5 text-white/40" />
        <span className="font-medium text-white/85 truncate max-w-[12rem]">{repoLabel}</span>
        <EndpointBadge />
        {git?.branch && (
          <code className="hidden md:inline-block rounded bg-white/[0.03] px-1.5 py-0.5 font-mono text-[11px] text-white/55 truncate max-w-[14rem]">
            {git.branch}
          </code>
        )}
      </span>
      <span className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-white/55">
        <span className={cn(
          "inline-flex h-2 w-2 shrink-0 rounded-full",
          state === "connected" ? "bg-emerald-400"
          : state === "error" ? "bg-rose-400"
          : state === "closed" ? "bg-zinc-500"
          : "bg-amber-400",
        )} />
        <span className="capitalize">{state}</span>
      </span>
    </>
  );
}


function CodingNotice({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-[#0d0d0d] p-6 text-white/85">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.05] text-white/70">
          {icon}
        </span>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-white/55">{detail}</p>
        </div>
        {action}
      </div>
    </div>
  );
}
