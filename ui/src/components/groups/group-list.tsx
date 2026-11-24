/**
 * "Groups" section of the chat history: web groups, then the Telegram rooms
 * in a collapsed, read-only sub-section. Sits between Pinned and Recents.
 */
import { useState } from "react";
import { ChevronRight, Plus, RefreshCw, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { cn } from "@/lib/utils";
import type { Room } from "@/lib/rooms-api";
import { matchesQuery } from "@/lib/chat-history";
import { historyStyles, type HistoryStyles, type HistorySurface } from "@/components/chat/history-styles";
import type { GroupMember } from "./use-member-directory";

/** "Untitled group", or the title. */
function groupTitle(room: Room): string {
  return room.title || "Untitled group";
}

function GroupRow({ room, active, unread, resolve, onSelect, styles }: {
  room: Room;
  active: boolean;
  unread: boolean;
  resolve: (id: string) => GroupMember;
  onSelect: (id: string) => void;
  styles: HistoryStyles;
}) {
  const names = room.agents.map((id) => resolve(id).name).join(", ");
  return (
    <button
      type="button"
      data-history-row
      onClick={() => onSelect(room.id)}
      aria-current={active ? "page" : undefined}
      title={names ? `${groupTitle(room)} · ${names}` : groupTitle(room)}
      className={cn(styles.row, active ? styles.rowActive : styles.rowIdle)}
    >
      {room.kind === "telegram"
        ? <ChannelLogo type="telegram" size={14} />
        : <UsersRound className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />}
      <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold")}>{groupTitle(room)}</span>
      {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-primary" aria-label="New messages" />}
    </button>
  );
}

function ListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-2 px-3 py-1.5">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-2/3 rounded-xs" />
      ))}
    </div>
  );
}

/** Groups shown before "Show N more" (the open one always stays visible). */
const GROUPS_PREVIEW = 5;

/**
 * Flat on the surface (no box, no card); hidden when there are no groups — a new group starts
 * from the New chat menu, or from the small + next to the label once there are groups.
 */
export function GroupSidebarSection({
  rooms,
  loading,
  error,
  activeRoomId,
  unread,
  resolve,
  onSelect,
  onNew,
  onRetry,
  query = "",
  surface = "panel",
}: {
  rooms: Room[];
  loading: boolean;
  error: string | null;
  activeRoomId: string | null;
  unread: Set<string>;
  resolve: (id: string) => GroupMember;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  /** The history's search: only the groups whose title matches. */
  query?: string;
  surface?: HistorySurface;
}) {
  const styles = historyStyles(surface);
  const searching = query.trim() !== "";
  const matching = searching ? rooms.filter((r) => matchesQuery(groupTitle(r), query)) : rooms;
  const webRooms = matching.filter((r) => r.kind !== "telegram");
  const telegramRooms = matching.filter((r) => r.kind === "telegram");
  const [showAll, setShowAll] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);

  // Opening a Telegram room from elsewhere (deep link) reveals its sub-section
  // (adjusted during render, not in an effect).
  const activeIsTelegram = !!activeRoomId && telegramRooms.some((r) => r.id === activeRoomId);
  const revealKey = activeIsTelegram ? activeRoomId : null;
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  if (revealKey !== revealedFor) {
    setRevealedFor(revealKey);
    if (revealKey) setTelegramOpen(true);
  }

  const activeIndex = webRooms.findIndex((r) => r.id === activeRoomId);
  const cap = showAll || searching ? webRooms.length : Math.max(GROUPS_PREVIEW, activeIndex + 1);
  const visible = webRooms.slice(0, cap);
  const hidden = webRooms.length - visible.length;
  const telegramUnread = telegramRooms.some((r) => unread.has(r.id));
  const failed = !!error && rooms.length === 0;
  const pending = loading && rooms.length === 0;
  const telegramShown = telegramOpen || searching;

  // Nothing to show: no section at all (a search hides loading and errors too).
  if (searching ? matching.length === 0 : !pending && !failed && rooms.length === 0) return null;

  const row = (room: Room) => (
    <GroupRow
      key={room.id}
      room={room}
      active={room.id === activeRoomId}
      unread={unread.has(room.id)}
      resolve={resolve}
      onSelect={onSelect}
      styles={styles}
    />
  );

  return (
    <section aria-label="Groups" className="pb-2">
      <div className="group/label flex items-center gap-1 px-3 pb-1 pt-3">
        <span className={cn("flex-1", styles.label)}>Groups</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNew}
              aria-label="New group"
              className={cn(
                "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/label:opacity-100",
                styles.iconButton,
              )}
            >
              <Plus className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">New group</TooltipContent>
        </Tooltip>
      </div>

      {pending ? (
        <ListSkeleton />
      ) : failed ? (
        <div className={cn("flex items-center gap-2 px-3 py-1 text-caption", styles.muted)}>
          <span className="min-w-0 flex-1 truncate" title={error ?? undefined}>Could not load groups</span>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-caption" onClick={onRetry}>
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-px">
          {visible.map(row)}
          {(hidden > 0 || (showAll && webRooms.length > GROUPS_PREVIEW)) && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={cn(styles.row, styles.rowIdle, "py-1 text-caption")}
            >
              {showAll ? "Show less" : `Show ${hidden} more`}
            </button>
          )}
        </div>
      )}

      {telegramRooms.length > 0 && (
        <Collapsible open={telegramShown} onOpenChange={setTelegramOpen} className="mt-px">
          <CollapsibleTrigger asChild>
            <button type="button" className={cn(styles.row, styles.rowIdle, "py-1.5")}>
              <ChevronRight className={cn("h-3 w-3 shrink-0 opacity-60 transition-transform", telegramShown && "rotate-90")} />
              <ChannelLogo type="telegram" size={12} />
              <span className="min-w-0 flex-1 truncate text-caption">Telegram groups</span>
              {telegramUnread && !telegramShown && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-primary" aria-label="New messages" />
              )}
              <span className={cn("text-micro tabular-nums", styles.muted)}>{telegramRooms.length}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-px pt-px">
            {telegramRooms.map(row)}
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
