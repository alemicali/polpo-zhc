import { useEffect, useMemo, useState } from "react";
import {
  Code2,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Play,
  Square,
  TerminalSquare,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import { ChangesPanel } from "./changes-panel";
import { BrowserTab } from "./browser-tab";
import { TerminalSession } from "./terminal-session";

type Props = {
  workspaces: { id: string; cwd: string }[];
  activeWorkspaceId: string | undefined;
  cwd: string;
  refreshKey: number;
};

type RightTab = "changes" | "browser" | "terminal" | "vscode";

/**
 * Right-hand panel — stacks Changes / Files / Browser / Terminal / VS Code.
 *
 * Content is mounted *outside* the radix Tabs primitive: tab triggers use
 * radix for keyboard nav + styling, but the panes themselves live in a
 * single absolute-positioned stack. Inactive panes get `opacity-0
 * pointer-events-none` so layout (and therefore ResizeObserver, terminal
 * sizing, iframes) stays valid even when hidden — switching tabs never
 * unmounts a running terminal or breaks an iframe's state.
 *
 * Terminal and Browser are *also* mounted per-workspace, so flipping the
 * active workspace doesn't tear down processes for the workspaces you're
 * not currently looking at.
 */
export function RightPanel({ workspaces, activeWorkspaceId, cwd, refreshKey }: Props) {
  const [tab, setTab] = useState<RightTab>("changes");

  return (
    <div className="@container flex h-full w-full flex-col">
      <Tabs value={tab} onValueChange={(v) => setTab(v as RightTab)} className="contents">
        <TabsList className="h-9 shrink-0 rounded-none border-b border-white/[0.06] bg-transparent p-0 px-2 gap-0.5">
          <RightTabTrigger value="changes" icon={<FileText className="h-3.5 w-3.5" />} label="Changes" />
          <RightTabTrigger value="browser" icon={<Globe className="h-3.5 w-3.5" />} label="Browser" />
          <RightTabTrigger value="terminal" icon={<TerminalSquare className="h-3.5 w-3.5" />} label="Terminal" />
          <RightTabTrigger value="vscode" icon={<Code2 className="h-3.5 w-3.5" />} label="VS Code" />
        </TabsList>
      </Tabs>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <TabPane visible={tab === "changes"}>
          <ChangesPanel cwd={cwd} refreshKey={refreshKey} />
        </TabPane>

        <TabPane visible={tab === "browser"}>
          {workspaces.length === 0 ? (
            <PlaceholderTab title="No workspace" detail="Open a workspace first." />
          ) : (
            workspaces.map((w) => (
              <WorkspaceLayer key={w.id} visible={w.id === activeWorkspaceId}>
                <BrowserTab />
              </WorkspaceLayer>
            ))
          )}
        </TabPane>

        <TabPane visible={tab === "terminal"} className="bg-[#0a0a0a]">
          {workspaces.length === 0 ? (
            <PlaceholderTab title="No workspace" detail="Open a workspace first." />
          ) : (
            workspaces.map((w) => (
              <WorkspaceLayer key={w.id} visible={w.id === activeWorkspaceId}>
                <TerminalSession
                  sessionId={`${w.id}_aux`}
                  revision={0}
                  cwd={w.cwd}
                  active={tab === "terminal" && w.id === activeWorkspaceId}
                  onConnectionChange={() => undefined}
                />
              </WorkspaceLayer>
            ))
          )}
        </TabPane>

        <TabPane visible={tab === "vscode"}>
          <VsCodeTab workspaceId={activeWorkspaceId} cwd={cwd} />
        </TabPane>
      </div>
    </div>
  );
}

/** Absolute-positioned pane — visible toggles opacity, never unmounts. */
function TabPane({ visible, children, className }: { visible: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "absolute inset-0 transition-opacity duration-100",
        visible ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Same as TabPane but used to stack workspace-specific instances inside a tab. */
function WorkspaceLayer({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "absolute inset-0",
        visible ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
      )}
    >
      {children}
    </div>
  );
}

function RightTabTrigger({ value, icon, label }: { value: RightTab; icon: React.ReactNode; label: string }) {
  return (
    <TabsTrigger
      value={value}
      title={label}
      className={cn(
        "h-7 gap-1.5 rounded-md px-2 text-[11px] font-medium",
        "text-white/40 hover:text-white/70",
        "data-[state=active]:bg-white/[0.05] data-[state=active]:text-white/90 data-[state=active]:shadow-none",
      )}
    >
      {icon}
      {/* Container query: only render the label when the right panel is wide
          enough to fit it without crowding the icons. */}
      <span className="hidden @[330px]:inline">{label}</span>
    </TabsTrigger>
  );
}

function PlaceholderTab({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <p className="text-[12px] font-medium text-white/70">{title}</p>
        <p className="mt-1 text-[11px] text-white/40">{detail}</p>
      </div>
    </div>
  );
}


function VsCodeTab({ workspaceId, cwd }: { workspaceId: string | undefined; cwd: string }) {
  const { resolved } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const externalUrl = useMemo(() => (url ? new URL(url, window.location.href).toString() : null), [url]);

  useEffect(() => {
    setUrl(null);
    setError(null);
  }, [cwd, workspaceId]);

  const start = async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/v1/coding/code-server/start"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, cwd, theme: resolved, force: Boolean(url) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `VS Code failed to start (${res.status})`);
      setUrl(body.data.directUrl ?? apiUrl(body.data.url));
    } catch (err) {
      setError(err instanceof Error ? err.message : "VS Code failed to start.");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/v1/coding/code-server/stop"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `VS Code failed to stop (${res.status})`);
      setUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "VS Code failed to stop.");
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId) {
    return <PlaceholderTab title="No workspace" detail="Open a workspace first." />;
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/45">{cwd}</div>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            title="Open in new tab"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-white/45 hover:bg-white/[0.06] hover:text-white"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {url && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={stop}
            className="h-6 rounded px-2 text-[10px] font-medium text-white/55 hover:bg-white/[0.06] hover:text-white disabled:opacity-60"
          >
            <Square className="h-3 w-3" />
            Stop
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={start}
          className="h-6 rounded px-2 text-[10px] font-medium text-white/70 hover:bg-white/[0.06] hover:text-white disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {url ? "Restart" : "Start"}
        </Button>
      </div>
      {url ? (
        <iframe
          key={url}
          src={url}
          className="flex-1 w-full border-0 bg-white"
          title="VS Code"
          allow="clipboard-read; clipboard-write"
        />
      ) : error ? (
        <PlaceholderTab title="VS Code unavailable" detail={error} />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-[18rem] text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.05] text-white/70">
              <Code2 className="h-5 w-5" />
            </span>
            <p className="mt-3 text-[12px] font-medium text-white/75">VS Code for this workspace</p>
            <p className="mt-1 text-[11px] text-white/40">Start a code-server instance rooted at the selected workspace.</p>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={start}
              className="mt-4 h-7 rounded-md px-3 text-[11px]"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start VS Code
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
