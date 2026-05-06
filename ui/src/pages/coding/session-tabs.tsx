import { useState } from "react";
import { ChevronDown, Clock, History, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { Icon } from "@iconify/react";
import { ensureLogosPack } from "@/lib/iconify-bootstrap";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { NewTerminalDialog } from "./new-terminal-dialog";
import type { CodingAgentKind, CodingTerminal, CodingWorkspace, ConnectionState } from "./types";

/** Hard cap on tabs we render inline before spilling into the overflow
 * selector. The container doesn't scroll, so we'd squish/clip otherwise.
 * Active tab is always promoted into the visible window. */
const MAX_VISIBLE_TABS = 6;

type Props = {
  workspace: CodingWorkspace | undefined;
  terminals: CodingTerminal[];
  hidden: CodingTerminal[];
  activeId: string;
  /** Used to inherit the cwdOverride+branch of the active session into
   * the new one, so "+" in the tabs always lands in the same worktree. */
  activeTerminal: CodingTerminal | undefined;
  connections: Record<string, ConnectionState>;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onUnhideTab: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onRename: (id: string, label: string) => void;
  onAddTerminal: (workspaceId: string, opts?: {
    agentKind: CodingAgentKind;
    agentCommand?: string;
    cwdOverride?: string;
    branch?: string;
    label?: string;
  }) => void;
};

export function SessionTabs({
  workspace,
  terminals,
  hidden,
  activeId,
  activeTerminal,
  connections,
  onSelect,
  onCloseTab,
  onUnhideTab,
  onReorder,
  onRename,
  onAddTerminal,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Always keep the active tab in the visible window.
  const { visible, overflow } = partitionTabs(terminals, activeId);
  const overflowHasActive = overflow.some((t) => t.id === activeId);

  if (!workspace) return null;
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-white/[0.08] bg-[#0d0d0d]">
      {/* Tabs (left) */}
      <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        {visible.map((terminal) => (
          <SessionTab
            key={terminal.id}
            terminal={terminal}
            active={terminal.id === activeId}
            connection={connections[terminal.id] ?? "loading"}
            dragging={draggingId === terminal.id}
            onSelect={() => onSelect(terminal.id)}
            onCloseTab={() => onCloseTab(terminal.id)}
            onRename={(label) => onRename(terminal.id, label)}
            onDragStart={() => setDraggingId(terminal.id)}
            onDragEnd={() => setDraggingId(null)}
            onDropOn={() => {
              if (draggingId && draggingId !== terminal.id) onReorder(draggingId, terminal.id);
              setDraggingId(null);
            }}
          />
        ))}
        {overflow.length > 0 && (
          <OverflowSelector
            tabs={overflow}
            activeFlash={overflowHasActive}
            onSelect={onSelect}
            onCloseTab={onCloseTab}
          />
        )}
      </div>

      {/* Pinned actions (right) — always visible regardless of tab count. */}
      <div className="flex shrink-0 items-center gap-0.5 px-1.5">
        <NewTerminalDialog
          workspaceCwd={workspace.cwd}
          forceMode="same"
          onCreate={(opts) => onAddTerminal(workspace.id, {
            ...opts,
            // Inherit the active session's worktree so "+" stays in the
            // same workspace (same branch, cwd, friendly label) —
            // Conductor pattern.
            cwdOverride: activeTerminal?.cwdOverride,
            branch: activeTerminal?.branch,
            workspaceLabel: activeTerminal?.workspaceLabel,
          })}
          trigger={
            <button
              type="button"
              aria-label="New session"
              title="New session in this workspace"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-white/45 hover:bg-white/[0.06] hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          }
        />
        {hidden.length > 0 && (
          <HistoryPopover hidden={hidden} onUnhide={onUnhideTab} />
        )}
      </div>
    </div>
  );
}

/** Compute (visible[], overflow[]). Active tab is always promoted into
 * visible — if it would have been overflowed we swap it with the last
 * visible slot so it stays selectable without opening the popover. */
function partitionTabs(terminals: CodingTerminal[], activeId: string): {
  visible: CodingTerminal[];
  overflow: CodingTerminal[];
} {
  if (terminals.length <= MAX_VISIBLE_TABS) return { visible: terminals, overflow: [] };
  const visible = terminals.slice(0, MAX_VISIBLE_TABS);
  const overflow = terminals.slice(MAX_VISIBLE_TABS);
  const activeOverflowIdx = overflow.findIndex((t) => t.id === activeId);
  if (activeOverflowIdx >= 0) {
    const promoted = overflow[activeOverflowIdx]!;
    const demoted = visible[visible.length - 1]!;
    visible[visible.length - 1] = promoted;
    overflow[activeOverflowIdx] = demoted;
  }
  return { visible, overflow };
}

function SessionTab({
  terminal,
  active,
  connection,
  dragging,
  onSelect,
  onCloseTab,
  onRename,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  terminal: CodingTerminal;
  active: boolean;
  connection: ConnectionState;
  dragging: boolean;
  onSelect: () => void;
  onCloseTab: () => void;
  onRename: (label: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const fallbackLabel = terminal.branch || "session";
  const displayLabel = terminal.label.trim() || fallbackLabel;

  const onPointerEnter = () => {
    if (terminal.agentKind && terminal.agentKind !== "terminal") ensureLogosPack();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable={!editing}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", terminal.id);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
          onDrop={(e) => { e.preventDefault(); onDropOn(); }}
          onPointerEnter={onPointerEnter}
          onClick={onSelect}
          className={cn(
            "group/tab relative flex h-9 min-w-0 shrink-0 select-none items-center gap-1.5 px-3 text-[12px] cursor-pointer transition-colors",
            "border-r border-white/[0.04]",
            active ? "text-white" : "text-white/55 hover:text-white/85 hover:bg-white/[0.02]",
            dragging && "opacity-40",
          )}
        >
          {active && (
            <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-white/85" />
          )}
          <AgentDot kind={terminal.agentKind} />
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
              className="h-5 w-32 rounded-none border-0 bg-transparent px-0.5 text-[12px] font-medium text-white/90 placeholder:text-white/40 shadow-none focus-visible:ring-0"
            />
          ) : (
            <span
              onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
              className="max-w-[10rem] truncate font-medium"
              title={`${displayLabel} — double-click to rename`}
            >
              {displayLabel}
            </span>
          )}
          <ConnectionDot state={connection} />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCloseTab(); }}
            aria-label="Close tab"
            title="Close tab (session keeps running — find it in History)"
            className={cn(
              "ml-1 inline-flex h-4 w-4 items-center justify-center rounded transition-opacity",
              active ? "opacity-60 hover:opacity-100 hover:bg-white/[0.10]" : "opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 hover:bg-white/[0.10]",
            )}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => setEditing(true)}>Rename</ContextMenuItem>
        <ContextMenuItem onClick={onCloseTab}>
          <X className="h-3.5 w-3.5" />
          Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function OverflowSelector({
  tabs,
  activeFlash,
  onSelect,
  onCloseTab,
}: {
  tabs: CodingTerminal[];
  activeFlash: boolean;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${tabs.length} more session${tabs.length === 1 ? "" : "s"}`}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1 border-r border-white/[0.04] px-2.5 text-[11px] font-medium transition-colors",
            activeFlash
              ? "text-emerald-300/85 hover:bg-emerald-400/[0.06]"
              : "text-white/55 hover:bg-white/[0.04] hover:text-white/85",
          )}
        >
          <span className="tabular-nums">+{tabs.length}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-72 p-0 border-white/[0.08] bg-[#141414] text-white/85"
      >
        <div className="border-b border-white/[0.06] px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-white/40">
          More sessions
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {tabs.map((t) => (
            <div key={t.id} className="group/row flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04]">
              <AgentDot kind={t.agentKind} />
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="flex-1 truncate text-left text-[12px] text-white/85"
              >
                {t.label.trim() || t.branch || "session"}
              </button>
              {t.branch && (
                <span className="shrink-0 truncate font-mono text-[10px] text-white/35">
                  {t.branch}
                </span>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                aria-label="Close tab"
                title="Close tab"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-white/30 opacity-0 hover:bg-white/[0.10] hover:text-white group-hover/row:opacity-60"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function HistoryPopover({ hidden, onUnhide }: { hidden: CodingTerminal[]; onUnhide: (id: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Reopen hidden tabs"
          title={`History (${hidden.length} hidden)`}
          className="relative inline-flex h-6 w-6 items-center justify-center rounded text-white/45 hover:bg-white/[0.06] hover:text-white"
        >
          <History className="h-3.5 w-3.5" />
          {hidden.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-3 min-w-3 items-center justify-center rounded-full bg-emerald-400 px-1 text-[8.5px] font-bold tabular-nums text-black">
              {hidden.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-72 p-0 border-white/[0.08] bg-[#141414] text-white/85"
      >
        <div className="border-b border-white/[0.06] px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-white/40">
          History · click to reopen
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {hidden.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onUnhide(t.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.04]"
            >
              <Clock className="h-3 w-3 shrink-0 text-white/35" />
              <AgentDot kind={t.agentKind} />
              <span className="flex-1 truncate text-[12px] text-white/85">
                {t.label.trim() || t.branch || "session"}
              </span>
              {t.branch && (
                <span className="shrink-0 truncate font-mono text-[10px] text-white/35">
                  {t.branch}
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentDot({ kind }: { kind: CodingAgentKind | undefined }) {
  if (kind === "claude") return <img src="/claude-favicon.svg" alt="Claude" className="h-3 w-3 shrink-0" />;
  if (kind === "codex") return <Icon icon="logos:openai-icon" className="h-3 w-3 shrink-0 invert" />;
  return <TerminalIcon className="h-3 w-3 shrink-0 text-white/45" />;
}

function ConnectionDot({ state }: { state: ConnectionState }) {
  if (state === "connected" || state === "loading") return null;
  return (
    <span
      title={state}
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full",
        state === "error" ? "bg-rose-400"
        : state === "connecting" ? "bg-amber-400"
        : "bg-zinc-500",
      )}
    />
  );
}
