/**
 * ChatTabs — browser-style tab strip for open chat sessions.
 *
 * Model: opening a session (sidebar click, new session) auto-pushes a tab.
 * Closing the X removes the tab from the visible strip — the underlying
 * session stays in the database. Tabs are an "active workspace aggregator",
 * not a deletion control.
 *
 * Persistence: the tab list is part of the person's chat navigation
 * preferences (server-side per member, local copy per instance + member).
 * Bounds: max 12 tabs. When exceeded, the least-recently-used non-active
 * tab is dropped.
 *
 * Mounted in two places:
 *  - sidebar layout: directly below the global Header on `/chat`
 *  - chat-first layout: below ChatPanelHeader in the left chat panel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Star, StarOff, Pencil, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatActions, useChatSessionState } from "@/hooks/chat-context";
import { setActiveChatRoom, useActiveChatRoom } from "@/hooks/use-chat-room";
import { getChatNavigation, updateChatNavigation, useChatNavigation } from "@/lib/chat-navigation";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const MAX_TABS = 12;
const TITLE_MAX_LEN = 22;

// ─── Store: the person's chat navigation preferences (`openTabs`) ─────

const EMPTY_TABS: string[] = [];

function getTabs(): string[] {
  return getChatNavigation().openTabs ?? EMPTY_TABS;
}

function setTabs(next: string[]) {
  updateChatNavigation({ openTabs: next });
}

/** Hook: read current open-tab ids. Re-renders only when the list changes. */
function useOpenTabs(): string[] {
  return useChatNavigation().openTabs ?? EMPTY_TABS;
}

// ─── Tab actions (pure, work on the stored list) ──────────────────────

/**
 * Insert `id` if missing. If size would exceed MAX_TABS, drop the
 * least-recently-used (= leftmost) tab that isn't `activeId`.
 */
function openTab(id: string, activeId: string | null) {
  const tabs = getTabs();
  if (tabs.includes(id)) return;
  let next = [...tabs, id];
  if (next.length > MAX_TABS) {
    const dropIdx = next.findIndex((t) => t !== activeId);
    if (dropIdx >= 0) next.splice(dropIdx, 1);
    else next = next.slice(-MAX_TABS);
  }
  setTabs(next);
}

function closeTab(id: string): { next: string[]; wasLast: boolean } {
  const tabs = getTabs();
  const idx = tabs.indexOf(id);
  if (idx < 0) return { next: tabs, wasLast: tabs.length === 0 };
  const next = tabs.filter((t) => t !== id);
  setTabs(next);
  return { next, wasLast: next.length === 0 };
}

function pruneOrphans(removedIds: Set<string>) {
  const tabs = getTabs();
  if (tabs.length === 0) return;
  const next = tabs.filter((id) => !removedIds.has(id));
  if (next.length !== tabs.length) setTabs(next);
}

// ─── Components ───────────────────────────────────────────────────────

interface TabItemProps {
  id: string;
  title: string;
  active: boolean;
  streaming: boolean;
  starred: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: () => void;
  onToggleStar: () => void;
}

function TabItem({ id, title, active, streaming, starred, onSelect, onClose, onRename, onToggleStar }: TabItemProps) {
  const truncated = title.length > TITLE_MAX_LEN
    ? title.slice(0, TITLE_MAX_LEN - 1).trimEnd() + "…"
    : title;

  const handleAuxClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Middle-click closes (browser pattern)
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  };

  const handleCloseClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={active}
          data-tab-id={id}
          title={title}
          onClick={onSelect}
          onAuxClick={handleAuxClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect();
            }
          }}
          tabIndex={0}
          className={cn(
            "group flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
            active
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {streaming && (
            <span
              aria-label="Streaming"
              className="relative inline-flex h-2 w-2 shrink-0"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-pill bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-pill bg-primary" />
            </span>
          )}
          {starred && (
            <Star
              aria-label="Starred"
              className="h-3 w-3 shrink-0 fill-warning text-warning"
            />
          )}
          <span className="max-w-[140px] truncate leading-none">{truncated}</span>
          <button
            type="button"
            aria-label="Close tab"
            onClick={handleCloseClick}
            className={cn(
              "inline-flex h-4 w-4 items-center justify-center rounded-sm transition-opacity hover:bg-foreground/10",
              active
                ? "opacity-70 hover:opacity-100"
                : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
            )}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRename}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={onToggleStar}>
          {starred ? (
            <>
              <StarOff className="mr-2 h-3.5 w-3.5" />
              Unstar
            </>
          ) : (
            <>
              <Star className="mr-2 h-3.5 w-3.5" />
              Star
            </>
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}>
          <X className="mr-2 h-3.5 w-3.5" />
          Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ChatTabs() {
  const { sessionId, sessions, streamingSessionIds } = useChatSessionState();
  const { loadSession, newSession, renameSession, setStarred } = useChatActions();
  const tabIds = useOpenTabs();
  const streamingSet = useMemo(() => new Set(streamingSessionIds), [streamingSessionIds]);
  // While a group is open in the chat, no thread tab is active; picking one leaves the group.
  const inGroup = useActiveChatRoom() !== null;

  // Rename dialog — local state so chat-tabs is self-contained (doesn't
  // depend on the ChatPage's RenameSessionDialog, which lives in a
  // sibling tree on the chat page only).
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);

  // Indexed lookup by id — sessions can be 100s. Include `starred` so the
  // tab can render the star icon + dropdown label.
  const sessionMap = useMemo(() => {
    const m = new Map<string, { id: string; title?: string; starred?: boolean }>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  // Auto-open: when sessionId enters and isn't tabbed, push it.
  useEffect(() => {
    if (!sessionId) return;
    openTab(sessionId, sessionId);
  }, [sessionId]);

  // Orphan prune: drop tabs whose session disappeared from the list (deleted).
  // Only ids this list has shown before are pruned: tabs restored from the
  // person's preferences may point at threads a stale cached list doesn't
  // know yet (opened on another device) — those are hidden, not dropped.
  const seenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (sessions.length === 0) return;
    const current = new Set(sessions.map((s) => s.id));
    const gone = new Set([...seenIdsRef.current].filter((id) => !current.has(id)));
    for (const id of current) seenIdsRef.current.add(id);
    if (gone.size === 0) return;
    for (const id of gone) seenIdsRef.current.delete(id);
    pruneOrphans(gone);
  }, [sessions]);

  const handleClose = useCallback(
    (id: string) => {
      const wasActive = id === sessionId;
      const { next } = closeTab(id);
      if (!wasActive || inGroup) return;
      // fall back to the last (rightmost) remaining tab the list knows
      const fallback = next.filter((t) => sessionMap.has(t)).at(-1);
      if (fallback) void loadSession(fallback);
      else newSession();
    },
    [sessionId, inGroup, loadSession, newSession, sessionMap],
  );

  // Tabs of threads the list doesn't know (yet) stay hidden; the open thread
  // always shows (a brand-new chat may not be listed for a moment).
  const visibleTabIds = tabIds.filter((id) => sessionMap.has(id) || id === sessionId);

  // Hide the strip entirely when there are no tabs to show — the [+] button
  // lives in the headers (existing UI); a phantom strip would just add
  // vertical noise. Show it as soon as one tab is open.
  if (visibleTabIds.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open conversations"
      className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-background px-2 py-1"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {visibleTabIds.map((id) => {
          const session = sessionMap.get(id);
          const title = session?.title || "New session";
          const starred = !!session?.starred;
          return (
            <TabItem
              key={id}
              id={id}
              title={title}
              active={!inGroup && id === sessionId}
              streaming={streamingSet.has(id)}
              starred={starred}
              onSelect={() => {
                setActiveChatRoom(null);
                if (id === sessionId) return;
                void loadSession(id);
              }}
              onClose={() => handleClose(id)}
              onRename={() => setRenameTarget({ id, title })}
              onToggleStar={() => { void setStarred(id, !starred); }}
            />
          );
        })}
      </div>
      <button
        type="button"
        aria-label="New conversation"
        onClick={() => {
          setActiveChatRoom(null);
          newSession();
        }}
        className="ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <TabRenameDialog
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSubmit={async (id, title) => { await renameSession(id, title); }}
      />
    </div>
  );
}

// ─── Rename dialog (self-contained — same UX as ChatPage's) ────────────

function TabRenameDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: { id: string; title: string } | null;
  onClose: () => void;
  onSubmit: (id: string, title: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) setValue(target.title);
  }, [target]);

  const handleSubmit = useCallback(async () => {
    if (!target || submitting) return;
    const next = value.trim();
    // Empty or unchanged → just close, no network round-trip.
    if (!next || next === target.title.trim()) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(target.id, next);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [onClose, onSubmit, submitting, target, value]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            } else if (e.key === "Escape" && !submitting) {
              onClose();
            }
          }}
          placeholder="Session title"
          disabled={submitting}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
