import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Cloud,
  GitBranch,
  GitMerge,
  GitPullRequest as GitPullRequestIcon,
  Home as HomeIcon,
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
import { TerminalSession } from "./coding/terminal-session";

type TerminalStatus = {
  enabled: boolean;
  workDir: string;
  agentWorkDir: string;
  shell: string;
};

export function CodingPage() {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());

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
    renameTerminal,
    setConnection,
  } = useCodingState();

  const [busy, setBusy] = useState(false);

  const activeTerminal = terminals.find((t) => t.id === activeId);
  const activeWorkspace = workspaces.find((w) => w.id === activeTerminal?.workspaceId);
  const activeCwd = activeWorkspace?.cwd ?? ".";
  const activeRevision = activeTerminal?.revision ?? 0;
  const git = useGitInfo(activeCwd, activeRevision);

  const openPR = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/v1/git/pr/create"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: activeCwd }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `Create PR failed (${res.status})`);
      toast.success(body.data?.url ? `PR opened: #${body.data.number}` : "PR opened");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open PR");
    } finally {
      setBusy(false);
    }
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

  const toggleCollapsed = (id: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#0d0d0d] text-white/85">
      {/* Top bar — minimal: home · sidebar toggle · restart active */}
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.06] pl-3 pr-2">
        <Link
          to="/dashboard"
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-white/55 hover:bg-white/[0.05] hover:text-white"
          title="Back to dashboard"
        >
          <HomeIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Home</span>
        </Link>
        <div className="h-4 w-px bg-white/[0.08] mx-0.5" />
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 rounded-md transition-colors",
            sidebarOpen ? "text-white/80 bg-white/[0.05]" : "text-white/40 hover:text-white/70 hover:bg-white/[0.03]",
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
            rightOpen ? "text-white/80 bg-white/[0.05]" : "text-white/40 hover:text-white/70 hover:bg-white/[0.03]",
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
        <ResizablePanelGroup orientation="horizontal" id="polpo-coding-panels" className="flex-1">
          {sidebarOpen && (
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
                  connections={connections}
                  collapsed={collapsedWorkspaces}
                  workDir={status.workDir}
                  onToggleCollapsed={toggleCollapsed}
                  onSelect={setActiveId}
                  onAddWorkspace={addWorkspace}
                  onCloseWorkspace={closeWorkspace}
                  onAddTerminal={addTerminal}
                  onCloseTerminal={closeTerminal}
                  onRenameTerminal={renameTerminal}
                />
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}

          <ResizablePanel id="main">
            <main className="relative flex h-full w-full flex-col overflow-hidden bg-[#0a0a0a]">
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
                      onConnectionChange={(state) => setConnection(terminal.id, state)}
                    />
                  );
                })}
              </div>
            </main>
          </ResizablePanel>

          {rightOpen && (
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
                  activeWorkspaceId={activeWorkspace?.id}
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
