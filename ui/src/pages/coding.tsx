/**
 * The Coding app. Its navigation (projects → worktrees → sessions) lives in the main sidebar's
 * Coding level (drill-in), in the chat-first layout's column, or — when neither is on screen — in
 * the Sessions sheet of this page's header; the workspace gets the full width.
 *
 * A session is a coding chat (Claude Code / Codex through the CLI engine, as a chat) or a terminal
 * (xterm: the shell, and older claude / codex sessions). Changes, browser, the side terminal and
 * VS Code stay in the right panel.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Cloud,
  GitBranch,
  GitMerge,
  GitPullRequest as GitPullRequestIcon,
  Laptop,
  ListTree,
  Loader2,
  PanelRight,
  RefreshCcw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { apiFetch, apiUrl, endpointHost, isLocalEndpoint } from "@/lib/config";
import { cn } from "@/lib/utils";
import { codingActions, useCodingState } from "./coding/use-coding-state";
import { useGitInfo } from "./coding/use-git-info";
import { CodingNav } from "./coding/coding-nav";
import { RightPanel } from "./coding/right-panel";
import { SessionTabs } from "./coding/session-tabs";
import { TerminalSession } from "./coding/terminal-session";
import { CodingChatPane } from "./coding/coding-chat";
import { isChatSession } from "./coding/chat-parts";
import { EmptyWorkspaceQuickStart } from "./coding/empty-quickstart";
import { useCodingSettings } from "./coding/coding-settings";
import { useLocalState } from "./coding/use-local-state";
import type { CodingTerminal } from "./coding/types";

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
  const [rightOpen, setRightOpen] = useLocalState<boolean>("polpo:coding:rightOpen", true);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  // react-resizable-panels v4 dropped autoSaveId: defaultLayout and onLayoutChanged by hand
  const [panelLayout, setPanelLayout] = useLocalState<Record<string, number>>("polpo:coding:panelLayout", {});
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    workspaces, terminals, activeId, connections, pendingWorkspaces, activePendingKey, changesRevision, navPanels,
    setActiveId, addTerminal, hideTerminalTab, unhideTerminalTab, reorderTerminal, renameTerminal, setConnection,
  } = useCodingState();

  const [codingSettings] = useCodingSettings();
  const [busy, setBusy] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(() => window.innerWidth);

  const activeTerminal = terminals.find((t) => t.id === activeId);
  const activeWorkspace = workspaces.find((w) => w.id === activeTerminal?.workspaceId);
  const activeCwd = activeWorkspace?.cwd ?? ".";
  const activeRevision = activeTerminal?.revision ?? 0;
  // the header follows the active worktree (its branch, PR and diff), not the project root
  const headerCwd = activeTerminal?.cwdOverride || activeCwd;
  const git = useGitInfo(headerCwd, activeRevision + changesRevision);

  // a link to a coding chat (/coding?chat=cc_…, from MCP's card or Polpo's chat): open it
  const chatParam = searchParams.get("chat");
  useEffect(() => {
    if (!chatParam) return;
    void codingActions.openChat(chatParam).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Could not open the session"));
    setSearchParams((p) => { p.delete("chat"); return p; }, { replace: true });
  }, [chatParam, setSearchParams]);

  const openPR = () => {
    // a one-shot Claude Code command in a terminal (the configured prCommand): stage, commit, push,
    // open the PR; silent, so the current session stays in view
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
    toast.success("PR session started — see the sessions list / Activity");
  };

  const mergePR = async () => {
    if (busy || !git?.pr) return;
    setBusy(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/git/pr/merge"), {
        method: "POST",
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
    apiFetch(apiUrl("/api/v1/terminal/status"), { signal: controller.signal })
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

  const showCodingRightPanel = rightOpen && surfaceWidth >= 640;
  const pending = activePendingKey ? pendingWorkspaces.find((p) => p.key === activePendingKey) : undefined;
  const sameWorktree = (t: CodingTerminal) => !!activeTerminal && t.workspaceId === activeTerminal.workspaceId
    && (t.cwdOverride || "") === (activeTerminal.cwdOverride || "") && (t.branch || "") === (activeTerminal.branch || "");

  return (
    <div ref={surfaceRef} className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      <Sheet open={sessionsOpen} onOpenChange={setSessionsOpen}>
        <SheetContent side="left" className="flex w-80 max-w-[90vw] flex-col gap-0 p-0" data-testid="coding-sessions-sheet">
          <SheetHeader className="border-b border-border/70 px-3 py-2.5">
            <SheetTitle className="text-sm">Coding</SheetTitle>
          </SheetHeader>
          {sessionsOpen && <CodingNav onNavigate={() => setSessionsOpen(false)} />}
        </SheetContent>
      </Sheet>
      {/* Coding-local controls only; the navigation is the sidebar's Coding level */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/70 bg-background px-3">
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 text-muted-foreground", navPanels > 0 && !sessionsOpen && "lg:hidden")}
          onClick={() => setSessionsOpen(true)}
          title="Projects and sessions"
          aria-label="Projects and sessions"
        >
          <ListTree className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 transition-colors", showCodingRightPanel ? "bg-muted text-foreground" : "text-muted-foreground")}
          onClick={() => setRightOpen((v) => !v)}
          title="Toggle right panel"
          aria-label="Toggle right panel"
        >
          <PanelRight className="h-3.5 w-3.5" />
        </Button>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-small">
          <HeaderInfo
            workspace={activeWorkspace}
            state={activeTerminal && isChatSession(activeTerminal) ? "connected" : (activeTerminal && connections[activeTerminal.id]) ?? "loading"}
            git={git}
          />
        </div>

        {git?.pr ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="h-8 gap-1.5 border border-success/30 bg-success/10 px-2.5 text-xs font-medium text-success hover:bg-success/15"
            onClick={mergePR}
          >
            <GitMerge className="h-3.5 w-3.5" /> Merge
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy || !git?.branch} className="h-8 gap-1.5 px-2.5 text-xs" onClick={openPR}>
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
          <ResizablePanel id="main">
            <main className="relative flex h-full w-full flex-col overflow-hidden bg-background">
              {pending ? (
                <EmptyWorkspaceQuickStart
                  branch={pending.branch}
                  projectName={workspaces.find((w) => w.id === pending.projectId)?.name ?? ""}
                  cwd={pending.cwd}
                  onStart={codingActions.startQuickSession}
                />
              ) : (<>
                <SessionTabs
                  workspace={activeWorkspace}
                  terminals={terminals.filter((t) => sameWorktree(t) && !t.tabHidden)}
                  hidden={terminals.filter((t) => sameWorktree(t) && !!t.tabHidden)}
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
                <div className="relative min-h-0 flex-1">
                  {terminals.map((terminal) => {
                    const ws = workspaces.find((w) => w.id === terminal.workspaceId);
                    if (isChatSession(terminal)) {
                      return (
                        <CodingChatPane
                          key={terminal.id}
                          chatId={terminal.chatId}
                          createError={terminal.chatError}
                          kind={terminal.agentKind === "codex" ? "codex" : "claude"}
                          active={terminal.id === activeId}
                          onFilesChanged={codingActions.bumpChanges}
                        />
                      );
                    }
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
              <ResizablePanel id="right" defaultSize="288px" minSize="288px" maxSize="80%" className="border-l border-border/70 bg-background">
                <RightPanel
                  workspaces={workspaces}
                  terminals={terminals.map((t) => {
                    const ws = workspaces.find((w) => w.id === t.workspaceId);
                    // a coding chat's edits refresh the changes too
                    return { id: t.id, workspaceId: t.workspaceId, cwd: t.cwdOverride || ws?.cwd || ".", revision: t.revision + changesRevision };
                  })}
                  activeWorkspaceId={activeWorkspace?.id}
                  activeTerminalId={activeTerminal?.id}
                  cwd={activeCwd}
                  refreshKey={activeRevision + changesRevision}
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
        local ? "text-success/70" : "text-info/80",
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
          className="flex items-center gap-1 rounded-md border border-success/25 bg-success/[0.08] px-1.5 py-0.5 text-caption font-medium text-success hover:bg-success/[0.12]"
        >
          <GitPullRequestIcon className="h-3 w-3" />
          <span className="tabular-nums">#{git.pr.number}</span>
          <span className="hidden xl:inline max-w-[16rem] truncate text-success/80">{git.pr.title}</span>
        </a>
      )}
      <span className="flex items-center gap-1.5 truncate">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[12rem] truncate font-medium text-foreground">{repoLabel}</span>
        <EndpointBadge />
        {git?.branch && (
          <code className="hidden max-w-[14rem] truncate rounded-xs bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground md:inline-block">
            {git.branch}
          </code>
        )}
      </span>
      <span className="flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-micro text-muted-foreground">
        <span className={cn(
          "inline-flex h-2 w-2 shrink-0 rounded-pill",
          state === "connected" ? "bg-success"
          : state === "error" ? "bg-destructive"
          : state === "closed" ? "bg-muted-foreground"
          : "bg-warning",
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
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background p-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {icon}
        </span>
        <div>
          <h2 className="font-heading text-h3">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        {action}
      </div>
    </div>
  );
}
