/**
 * "Groups" section of the chat sidebar: web groups, then the Telegram rooms
 * in a collapsed, read-only sub-section. Sits above the threads.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight, Plus, RefreshCw, UsersRound } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { cn } from "@/lib/utils";
import type { Room } from "@/lib/rooms-api";
import { MemberAvatarStack } from "./group-members";
import type { GroupMember } from "./use-member-directory";

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (Date.now() - date.getTime() < 60_000) return "now";
  return formatDistanceToNow(date, { addSuffix: false });
}

function GroupRow({ room, active, unread, resolve, onSelect }: {
  room: Room;
  active: boolean;
  unread: boolean;
  resolve: (id: string) => GroupMember;
  onSelect: (id: string) => void;
}) {
  const members = room.agents.map((id) => resolve(id));
  const names = members.map((m) => m.name).join(", ");
  return (
    <button
      type="button"
      onClick={() => onSelect(room.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
        active ? "bg-accent/80 text-accent-foreground" : "text-muted-foreground hover:bg-accent/30",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {room.kind === "telegram"
            ? <ChannelLogo type="telegram" size={12} />
            : <UsersRound className="h-3 w-3 shrink-0 text-primary/80" aria-hidden />}
          <p className={cn(
            "min-w-0 truncate text-[13px] leading-snug",
            unread ? "font-semibold" : "font-medium",
            active ? "text-accent-foreground" : "text-foreground",
          )}>
            {room.title || "Untitled group"}
          </p>
          {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="New messages" />}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          {members.length > 0 && <MemberAvatarStack members={members} max={4} size="xs" />}
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">
            {names || "No agents"}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">{relativeTime(room.updatedAt)}</span>
        </div>
      </div>
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1">
      {children}
    </div>
  );
}

function ListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-0.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-lg px-3 py-2.5">
          <Skeleton className="h-3.5 w-2/3 rounded" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-12 rounded-full" />
            <Skeleton className="h-2.5 w-1/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Groups shown before "Show N more" (the open one always stays visible). */
const GROUPS_PREVIEW = 5;

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
}) {
  const webRooms = rooms.filter((r) => r.kind !== "telegram");
  const telegramRooms = rooms.filter((r) => r.kind === "telegram");
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
  const cap = showAll ? webRooms.length : Math.max(GROUPS_PREVIEW, activeIndex + 1);
  const visible = webRooms.slice(0, cap);
  const hidden = webRooms.length - visible.length;
  const telegramUnread = telegramRooms.some((r) => unread.has(r.id));

  const row = (room: Room) => (
    <GroupRow
      key={room.id}
      room={room}
      active={room.id === activeRoomId}
      unread={unread.has(room.id)}
      resolve={resolve}
      onSelect={onSelect}
    />
  );

  return (
    <section className="border-b border-border/30 p-1.5 pb-2" aria-label="Groups">
      <SectionLabel>
        <UsersRound className="h-3 w-3 text-primary" />
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Groups</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onNew}
              aria-label="New group"
            >
              <Plus className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">New group</TooltipContent>
        </Tooltip>
      </SectionLabel>

      {loading && rooms.length === 0 ? (
        <ListSkeleton />
      ) : error && rooms.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={error}>Could not load groups</span>
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={onRetry}>
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-0.5">
          {webRooms.length === 0 ? (
            <button
              type="button"
              onClick={onNew}
              className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-left text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent/30"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <UsersRound className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-foreground">New group</span>
                <span className="block text-[10.5px] leading-snug">Talk with several agents at once</span>
              </span>
            </button>
          ) : visible.map(row)}
          {(hidden > 0 || (showAll && webRooms.length > GROUPS_PREVIEW)) && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="w-full rounded-md px-3 py-1 text-left text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
            >
              {showAll ? "Show less" : `Show ${hidden} more`}
            </button>
          )}
        </div>
      )}

      {telegramRooms.length > 0 && (
        <Collapsible open={telegramOpen} onOpenChange={setTelegramOpen} className="mt-1">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-accent/30"
            >
              <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform", telegramOpen && "rotate-90")} />
              <ChannelLogo type="telegram" size={12} />
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Telegram groups</span>
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{telegramRooms.length}</span>
              {telegramUnread && !telegramOpen && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="New messages" />
              )}
              <span className="ml-auto text-[10px] text-muted-foreground/60">read-only</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-0.5 pt-0.5">
            {telegramRooms.map(row)}
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
