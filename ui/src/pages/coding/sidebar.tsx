import { useState } from "react";
import { Activity, Archive, ChevronDown, ChevronRight, GitBranch, Plus, Settings, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { CodingSettingsDialog } from "./settings-dialog";
import { ProcessesDialog } from "./processes-dialog";
import { useCodingSettings } from "./coding-settings";

/** A workspace is bound to a folder, so the displayed name = basename(cwd). */
function workspaceLabel(workspace: CodingWorkspace): string {
  if (workspace.cwd && workspace.cwd !== ".") {
    return workspace.cwd.split("/").filter(Boolean).pop() ?? workspace.name;
  }
  return workspace.name;
}
import { useGitInfo } from "./use-git-info";
import { NewWorkspacePopover } from "./workspace-controls";
import { NewTerminalDialog } from "./new-terminal-dialog";
import type { CodingAgentKind, CodingTerminal, CodingWorkspace, ConnectionState, GitInfo } from "./types";

export type NewTerminalConfig = {
  agentKind: CodingAgentKind;
  agentCommand?: string;
  cwdOverride?: string;
  branch?: string;
  label?: string;
};

type SidebarProps = {
  workspaces: CodingWorkspace[];
  terminals: CodingTerminal[];
  activeId: string;
  connections: Record<string, ConnectionState>;
  collapsed: Set<string>;
  /** Server work directory — clamps the path picker so users can't escape it. */
  workDir?: string;
  onToggleCollapsed: (id: string) => void;
  onSelect: (id: string) => void;
  onAddWorkspace: (opts?: { cwd?: string; name?: string }) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onAddTerminal: (workspaceId: string, opts?: NewTerminalConfig) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTerminal: (id: string, label: string) => void;
};

export function CodingSidebar(props: SidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [settings] = useCodingSettings();
  const extraRoots = settings.allowOutsideWorkspace ? settings.allowedExtraRoots : [];
  return (
    <aside className="flex h-full w-full flex-col">
      <CodingSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ProcessesDialog open={processesOpen} onOpenChange={setProcessesOpen} />
      <div className="flex h-9 shrink-0 items-center px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
          Workspaces
        </span>
        {props.workspaces.length > 0 && (
          <span className="ml-1.5 text-[10px] tabular-nums text-white/25">{props.workspaces.length}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {props.workspaces.map((workspace) => (
          <WorkspaceGroup
            key={workspace.id}
            workspace={workspace}
            terminals={props.terminals.filter((t) => t.workspaceId === workspace.id)}
            activeId={props.activeId}
            connections={props.connections}
            collapsed={props.collapsed.has(workspace.id)}
            onToggleCollapsed={() => props.onToggleCollapsed(workspace.id)}
            onSelect={props.onSelect}
            onAddTerminal={(opts) => props.onAddTerminal(workspace.id, opts)}
            onCloseTerminal={props.onCloseTerminal}
            onRenameTerminal={props.onRenameTerminal}
            onCloseWorkspace={() => props.onCloseWorkspace(workspace.id)}
          />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-t border-white/[0.06] px-1 py-1.5">
        <NewWorkspacePopover
          root={props.workDir}
          extraRoots={extraRoots}
          onCreate={(cwd, name) => props.onAddWorkspace({ cwd, name })}
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

type WorkspaceGroupProps = {
  workspace: CodingWorkspace;
  terminals: CodingTerminal[];
  activeId: string;
  connections: Record<string, ConnectionState>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (id: string) => void;
  onAddTerminal: (opts: NewTerminalConfig) => void;
  onCloseTerminal: (id: string) => void;
  onRenameTerminal: (id: string, label: string) => void;
  onCloseWorkspace: () => void;
};

function WorkspaceGroup({
  workspace,
  terminals,
  activeId,
  connections,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onAddTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onCloseWorkspace,
}: WorkspaceGroupProps) {
  return (
    <section className="mb-4">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <header
            className="group/header flex items-center gap-1 rounded-md px-1.5 py-1 cursor-pointer hover:bg-white/[0.025]"
            onClick={onToggleCollapsed}
          >
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center text-white/35 group-hover/header:text-white/60"
            >
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>

            <span
              title={workspace.cwd}
              className="flex-1 truncate text-left text-[12.5px] font-medium tracking-tight text-white/40"
            >
              {workspaceLabel(workspace)}
            </span>

            <NewTerminalDialog
              workspaceCwd={workspace.cwd}
              onCreate={onAddTerminal}
              trigger={
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="New session in this workspace"
                  title="New session"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/40 hover:bg-white/[0.06] hover:text-white"
                >
                  <Plus className="h-4 w-4" />
                </button>
              }
            />
          </header>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onAddTerminal({ agentKind: "terminal" })}>
            <Plus className="h-3.5 w-3.5" />
            New terminal
          </ContextMenuItem>
          <ContextMenuItem onClick={onCloseWorkspace} variant="destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Remove workspace
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {!collapsed && (
        <div className="mt-0.5 ml-3 space-y-0.5">
          {terminals.map((terminal) => (
            <TerminalRecord
              key={terminal.id}
              terminal={terminal}
              workspaceCwd={workspace.cwd}
              selected={terminal.id === activeId}
              connection={connections[terminal.id] ?? "loading"}
              onSelect={() => onSelect(terminal.id)}
              onRename={(label) => onRenameTerminal(terminal.id, label)}
              onClose={() => onCloseTerminal(terminal.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type TerminalRecordProps = {
  terminal: CodingTerminal;
  workspaceCwd: string;
  selected: boolean;
  connection: ConnectionState;
  onSelect: () => void;
  onRename: (label: string) => void;
  onClose: () => void;
};

function TerminalRecord({
  terminal,
  workspaceCwd,
  selected,
  connection,
  onSelect,
  onRename,
  onClose,
}: TerminalRecordProps) {
  const [editing, setEditing] = useState(false);
  const git = useGitInfo(workspaceCwd, terminal.revision);

  const fallbackLabel = git?.branch || (workspaceCwd && workspaceCwd !== "." ? workspaceCwd : "untitled");
  const displayLabel = terminal.label.trim() || fallbackLabel;

  return (
    <div
      onClick={onSelect}
      className={cn(
        "group/term relative rounded-md px-2 py-1.5 cursor-pointer transition-colors",
        selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {editing ? (
          <Input
            autoFocus
            value={terminal.label}
            placeholder={fallbackLabel}
            onChange={(e) => onRename(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
            className="h-5 min-w-0 flex-1 border-0 bg-transparent px-0.5 text-[12.5px] font-medium text-white/90 placeholder:text-white/40 shadow-none focus-visible:ring-1 focus-visible:ring-white/15"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            title="Double-click to rename"
            className={cn(
              "min-w-0 flex-1 truncate text-left text-[12.5px] font-medium",
              selected ? "text-white" : "text-white/80",
            )}
          >
            {displayLabel}
          </button>
        )}

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Archive terminal"
          title="Archive"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/30 opacity-0 hover:bg-white/[0.08] hover:text-white group-hover/term:opacity-100"
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Branch + diff stats — only when we have signal */}
      {git && (git.branch || git.insertions > 0 || git.deletions > 0) && (
        <GitBadgeRow git={git} />
      )}

      {/* Connection state — silent when good, only shows on error/connecting/closed */}
      {connection !== "connected" && connection !== "loading" && (
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
          <span className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            connection === "error" ? "bg-rose-400"
            : connection === "connecting" ? "bg-amber-400"
            : "bg-zinc-500",
          )} />
          <span className={cn(
            "capitalize",
            connection === "error" ? "text-rose-400/80"
            : connection === "connecting" ? "text-amber-400/80"
            : "text-white/40",
          )}>{connection}</span>
        </div>
      )}
    </div>
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

function GitBadgeRow({ git }: { git: GitInfo }) {
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
      {git.branch && (
        <span className="flex items-center gap-1 font-mono text-white/45 truncate max-w-[10rem]">
          <GitBranch className="h-2.5 w-2.5 shrink-0 text-white/35" />
          {git.branch}
        </span>
      )}
      {(git.insertions > 0 || git.deletions > 0) && (
        <span className="flex items-center gap-1 font-mono tabular-nums">
          {git.insertions > 0 && <span className="text-emerald-400/85">+{git.insertions}</span>}
          {git.deletions > 0 && <span className="text-rose-400/85">−{git.deletions}</span>}
        </span>
      )}
      {git.ahead > 0 && <span className="font-mono text-sky-400/80">↑{git.ahead}</span>}
      {git.behind > 0 && <span className="font-mono text-amber-400/80">↓{git.behind}</span>}
    </div>
  );
}
