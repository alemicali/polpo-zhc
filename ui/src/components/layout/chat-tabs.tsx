/**
 * ChatTabs — browser-style tab strip for open chat sessions.
 *
 * Model: opening a session (sidebar click, new session) auto-pushes a tab.
 * Closing the X removes the tab from the visible strip — the underlying
 * session stays in the database. Tabs are an "active workspace aggregator",
 * not a deletion control.
 *
 * Persistence: tab list is stored in localStorage under `polpo:chat:tabs`.
 * Bounds: max 12 tabs. When exceeded, the least-recently-used non-active
 * tab is dropped.
 *
 * Mounted in two places:
 *  - sidebar layout: directly below the global Header on `/chat`
 *  - chat-first layout: below ChatPanelHeader in the left chat panel
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatActions, useChatState } from "@/hooks/chat-context";

const STORAGE_KEY = "polpo:chat:tabs";
const MAX_TABS = 12;
const TITLE_MAX_LEN = 22;

// ─── External store (useSyncExternalStore) ────────────────────────────

function readInitial(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

let _tabs: string[] = readInitial();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_tabs));
  } catch {
    /* quota or disabled — ignore */
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): string[] {
  return _tabs;
}

function setTabs(next: string[]) {
  // identity comparison — ok because we always replace the array
  if (next === _tabs) return;
  // shallow equality check to skip no-op updates
  if (next.length === _tabs.length && next.every((id, i) => id === _tabs[i])) return;
  _tabs = next;
  persist();
  listeners.forEach((cb) => cb());
}

/** Hook: read current open-tab ids. Re-renders only when the list changes. */
export function useOpenTabs(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ─── Tab actions (pure, work on _tabs) ────────────────────────────────

/**
 * Insert `id` if missing. If size would exceed MAX_TABS, drop the
 * least-recently-used (= leftmost) tab that isn't `activeId`.
 */
function openTab(id: string, activeId: string | null) {
  if (_tabs.includes(id)) return;
  let next = [..._tabs, id];
  if (next.length > MAX_TABS) {
    const dropIdx = next.findIndex((t) => t !== activeId);
    if (dropIdx >= 0) next.splice(dropIdx, 1);
    else next = next.slice(-MAX_TABS);
  }
  setTabs(next);
}

function closeTab(id: string): { next: string[]; wasLast: boolean } {
  const idx = _tabs.indexOf(id);
  if (idx < 0) return { next: _tabs, wasLast: _tabs.length === 0 };
  const next = _tabs.filter((t) => t !== id);
  setTabs(next);
  return { next, wasLast: next.length === 0 };
}

function pruneOrphans(validIds: Set<string>) {
  if (_tabs.length === 0) return;
  const next = _tabs.filter((id) => validIds.has(id));
  if (next.length !== _tabs.length) setTabs(next);
}

// ─── Components ───────────────────────────────────────────────────────

interface TabItemProps {
  id: string;
  title: string;
  active: boolean;
  streaming: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function TabItem({ id, title, active, streaming, onSelect, onClose }: TabItemProps) {
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
        "group flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs transition-colors",
        active
          ? "border-primary bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {streaming && (
        <span
          aria-label="Streaming"
          className="relative inline-flex h-2 w-2 shrink-0"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
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
  );
}

export function ChatTabs() {
  const { sessionId, sessions, streamingSessionIds } = useChatState();
  const { loadSession, newSession } = useChatActions();
  const tabIds = useOpenTabs();
  const streamingSet = useMemo(() => new Set(streamingSessionIds), [streamingSessionIds]);

  // Indexed lookup by id — sessions can be 100s
  const sessionMap = useMemo(() => {
    const m = new Map<string, { id: string; title?: string }>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  // Auto-open: when sessionId enters and isn't tabbed, push it.
  useEffect(() => {
    if (!sessionId) return;
    openTab(sessionId, sessionId);
  }, [sessionId]);

  // Orphan prune: drop tabs whose session no longer exists in the list.
  // Only run once sessions have loaded (>0) to avoid wiping on cold-start.
  useEffect(() => {
    if (sessions.length === 0) return;
    pruneOrphans(new Set(sessions.map((s) => s.id)));
  }, [sessions]);

  const handleClose = useCallback(
    (id: string) => {
      const wasActive = id === sessionId;
      const { next } = closeTab(id);
      if (!wasActive) return;
      if (next.length === 0) {
        newSession();
      } else {
        // fall back to the last (rightmost) remaining tab
        const fallback = next[next.length - 1];
        void loadSession(fallback);
      }
    },
    [sessionId, loadSession, newSession],
  );

  // Hide the strip entirely when there are no tabs to show — the [+] button
  // lives in the headers (existing UI); a phantom strip would just add
  // vertical noise. Show it as soon as one tab is open.
  if (tabIds.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open conversations"
      className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-background/60 px-2 py-1 backdrop-blur-sm"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabIds.map((id) => {
          const session = sessionMap.get(id);
          // Orphan tabs (not yet pruned) render with placeholder; the prune
          // effect will sweep them on the next sessions update.
          const title = session?.title || "New session";
          return (
            <TabItem
              key={id}
              id={id}
              title={title}
              active={id === sessionId}
              streaming={streamingSet.has(id)}
              onSelect={() => {
                if (id === sessionId) return;
                void loadSession(id);
              }}
              onClose={() => handleClose(id)}
            />
          );
        })}
      </div>
      <button
        type="button"
        aria-label="New conversation"
        onClick={() => newSession()}
        className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
