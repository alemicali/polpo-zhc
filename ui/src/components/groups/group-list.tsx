/**
 * Left column of the Groups page: web groups, then Telegram rooms.
 */
import type { ReactNode } from "react";
import { Plus, RefreshCw, UsersRound } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
          {room.kind === "telegram" && <ChannelLogo type="telegram" size={12} />}
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
    <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
      {children}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-1.5">
      {Array.from({ length: 5 }).map((_, i) => (
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

export function GroupList({
  rooms,
  loading,
  error,
  activeRoomId,
  unread,
  resolve,
  onSelect,
  onNew,
  onRetry,
  className,
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
  className?: string;
}) {
  const webRooms = rooms.filter((r) => r.kind !== "telegram");
  const telegramRooms = rooms.filter((r) => r.kind === "telegram");

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card/40", className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2.5">
        <span className="flex-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Groups</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onNew}>
              <Plus className="h-3.5 w-3.5" />
              New group
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">Start a group with several agents</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-bottom-nav lg:pb-0">
        {loading && rooms.length === 0 ? (
          <ListSkeleton />
        ) : error && rooms.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <p className="text-xs font-medium text-foreground">Could not load groups</p>
            <p className="mt-1 max-w-xs text-[11px] text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-0.5 p-1.5">
              {webRooms.length === 0 ? (
                <div className="flex flex-col items-center px-3 py-8 text-center text-muted-foreground">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <UsersRound className="h-5 w-5" />
                  </div>
                  <p className="text-xs font-medium text-foreground">No groups yet</p>
                  <p className="mt-1 max-w-[16rem] text-[11px]">
                    Bring several agents into one conversation. They reply when mentioned or when the message is for them.
                  </p>
                  <Button size="sm" className="mt-4 gap-1.5" onClick={onNew}>
                    <Plus className="h-3.5 w-3.5" />
                    New group
                  </Button>
                </div>
              ) : webRooms.map((room) => (
                <GroupRow
                  key={room.id}
                  room={room}
                  active={room.id === activeRoomId}
                  unread={unread.has(room.id)}
                  resolve={resolve}
                  onSelect={onSelect}
                />
              ))}
            </div>
            {telegramRooms.length > 0 && (
              <div className="border-t border-border/30 p-1.5">
                <SectionLabel>
                  <ChannelLogo type="telegram" size={12} />
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Telegram</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60">read-only</span>
                </SectionLabel>
                <div className="space-y-0.5">
                  {telegramRooms.map((room) => (
                    <GroupRow
                      key={room.id}
                      room={room}
                      active={room.id === activeRoomId}
                      unread={unread.has(room.id)}
                      resolve={resolve}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
