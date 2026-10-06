/**
 * A group conversation inside the chat column: header (title, members, reply
 * mode, settings), transcript, typing line and composer. Same widths and
 * composer position as the normal chat.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowDown,
  Check,
  ChevronLeft,
  Copy,
  CornerDownRight,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { MentionText } from "@/components/ai-elements/mention-popover";
import { CollapsibleUserMessage } from "@/components/shared/collapsible-user-message";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { useNow } from "@/hooks/use-now";
import type { TypingAgent } from "@/hooks/use-rooms";
import { firstLine, resolveRoomSettings, typingLabel, type Room, type RoomMessage } from "@/lib/rooms-api";
import { GroupComposer } from "./group-composer";
import { MemberAvatar, MemberAvatarStack } from "./group-members";
import type { GroupMember } from "./use-member-directory";

function timeAgo(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (now - date.getTime() < 30_000) return "just now";
  return formatDistanceToNow(date, { addSuffix: true });
}

function fullTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction
      tooltip={copied ? "Copied!" : "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </MessageAction>
  );
}

function MessagesSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-48 rounded-2xl rounded-br-sm" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-2/3 rounded" />
          </div>
        </div>
      ))}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-36 rounded-2xl rounded-br-sm" />
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1 w-1 animate-bounce rounded-full bg-primary/70"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export function GroupConversation({
  room,
  roomMissing,
  messages,
  loading,
  error,
  typingAgents,
  resolve,
  onSend,
  onBack,
  backLabel = "Back to chat",
  leading,
  onOpenSettings,
  onRetry,
  autoFocusComposer,
}: {
  room: Room | null;
  roomMissing: boolean;
  messages: RoomMessage[];
  loading: boolean;
  error: string | null;
  typingAgents: TypingAgent[];
  resolve: (id: string, fallbackName?: string) => GroupMember;
  onSend: (text: string) => Promise<unknown>;
  /** Leaves the group (back to the normal chat). Shown on small screens. */
  onBack: () => void;
  backLabel?: string;
  /** Extra controls at the start of the header (e.g. the threads toggle in compact mode). */
  leading?: ReactNode;
  onOpenSettings: () => void;
  onRetry: () => void;
  autoFocusComposer?: boolean;
}) {
  const now = useNow();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  const members = useMemo(() => (room?.agents ?? []).map((id) => resolve(id)), [resolve, room?.agents]);
  const settings = resolveRoomSettings(room?.settings);
  const readOnly = room?.kind === "telegram";
  const byId = useMemo(() => new Map(messages.map((m, i) => [m.id, { message: m, index: i }])), [messages]);

  const authorOf = useCallback((message: RoomMessage): GroupMember | null => {
    if (message.authorKind !== "agent") return null;
    const member = resolve(message.authorId, message.authorName);
    return member.known ? member : { ...member, name: message.authorName || member.name };
  }, [resolve]);

  const nameOf = useCallback((message: RoomMessage) => authorOf(message)?.name ?? (message.authorName || "You"), [authorOf]);

  const scrollToMessage = useCallback((id: string) => {
    const target = byId.get(id);
    if (target) virtuosoRef.current?.scrollToIndex({ index: target.index, align: "center", behavior: "smooth" });
  }, [byId]);

  if (roomMissing && !room) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium">This group is no longer available</p>
        <p className="mt-1 text-xs text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={onBack}>
          <ChevronLeft className="h-3.5 w-3.5" />
          {backLabel}
        </Button>
      </div>
    );
  }

  const typingNames = typingAgents.map((t) => {
    const member = resolve(t.agent, t.name);
    return member.known ? member.name : t.name || member.name;
  });

  const renderReplyHint = (message: RoomMessage) => {
    if (!message.replyToId) return null;
    const target = byId.get(message.replyToId)?.message;
    return (
      <button
        type="button"
        disabled={!target}
        onClick={() => target && scrollToMessage(target.id)}
        className="mb-1 flex max-w-full items-center gap-1 rounded text-left text-[11px] text-muted-foreground transition-colors enabled:hover:text-foreground"
        title={target ? "Show the message this replies to" : undefined}
      >
        <CornerDownRight className="h-3 w-3 shrink-0" />
        {target ? (
          <>
            <span className="shrink-0">replying to</span>
            <span className="shrink-0 font-medium text-foreground/80">{nameOf(target)}</span>
            <span className="min-w-0 truncate italic">“{firstLine(target.text)}”</span>
          </>
        ) : (
          <span>replying to an earlier message</span>
        )}
      </button>
    );
  };

  const addressedHint = (message: RoomMessage) => {
    const ids = message.addressedTo?.filter(Boolean) ?? [];
    if (ids.length === 0) return null;
    return (
      <span className="truncate" title="Who this message was routed to">
        → {ids.map((id) => resolve(id).name).join(", ")}
      </span>
    );
  };

  const renderMessage = (message: RoomMessage) => {
    const author = authorOf(message);
    if (!author) {
      return (
        <div className="group w-full px-4 py-4">
          <div className="mx-auto max-w-3xl">
            <div className="flex justify-end">
              <div className="flex max-w-[85%] flex-col items-end">
                {renderReplyHint(message)}
                <div className="rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground">
                  <CollapsibleUserMessage key={message.id} text={message.text}>
                    <MentionText text={message.text} variant="inverted" />
                  </CollapsibleUserMessage>
                </div>
                <div className="mt-1 flex max-w-full items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
                  {addressedHint(message)}
                  {readOnly && message.authorName && <span className="shrink-0 font-medium">{message.authorName}</span>}
                  <span className="shrink-0" title={fullTime(message.ts)}>{timeAgo(message.ts, now)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="group w-full px-4 py-4">
        <div className="mx-auto max-w-3xl">
          <Message from="assistant">
            <div className="flex gap-3">
              <MemberAvatar member={author} size="sm" className="mt-0.5 h-7 w-7" />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex min-w-0 items-center gap-2">
                  <p className="truncate text-xs font-semibold">{author.name}</p>
                  {author.role && <span className="hidden truncate text-[10px] text-muted-foreground/70 sm:inline">{author.role}</span>}
                  <span className="shrink-0 text-[10px] text-muted-foreground" title={fullTime(message.ts)}>
                    {timeAgo(message.ts, now)}
                  </span>
                </div>
                {renderReplyHint(message)}
                <MessageContent>
                  <MessageResponse mode="static">{message.text}</MessageResponse>
                </MessageContent>
                <MessageActions className="mt-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <CopyAction text={message.text} />
                  {message.addressedTo?.length ? (
                    <span className="ml-1 min-w-0 text-[10px] text-muted-foreground">{addressedHint(message)}</span>
                  ) : null}
                </MessageActions>
              </div>
            </div>
          </Message>
        </div>
      </div>
    );
  };

  const header = (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border/40 bg-background/80 px-3 py-2 backdrop-blur-md lg:px-4">
      {leading}
      {!leading && (
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 lg:hidden" onClick={onBack} aria-label={backLabel}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}
      {room ? (
        <>
          {members.length > 0 && <MemberAvatarStack members={members} max={3} size="sm" className="shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-sm font-semibold tracking-tight">{room.title || "Untitled group"}</h2>
              {readOnly && (
                <Badge variant="outline" className="h-4 shrink-0 gap-1 px-1.5 text-[9px] font-semibold uppercase tracking-wider">
                  <ChannelLogo type="telegram" size={10} />
                  Telegram
                </Badge>
              )}
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {members.map((m) => m.name).join(", ") || "No agents"}
              {!readOnly && (
                <>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                  {settings.replyMode === "intent" ? "Replies by intent" : "Replies to mentions"}
                  {settings.replyOrder === "sequential" ? ", one at a time" : ""}
                </>
              )}
            </p>
          </div>
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={onOpenSettings}
                  aria-label="Group settings"
                >
                  <Settings2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Group settings</TooltipContent>
            </Tooltip>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center gap-2">
          <Skeleton className="h-6 w-14 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-32 rounded" />
            <Skeleton className="h-2.5 w-48 rounded" />
          </div>
        </div>
      )}
    </div>
  );

  const isEmpty = !loading && !error && messages.length === 0 && typingNames.length === 0;
  // Like the chat: an empty group shows the composer in the middle, under the greeting.
  const centerComposer = isEmpty && !!room && !readOnly;

  const composer = room && !readOnly ? (
    <>
      <GroupComposer
        key={room.id}
        members={members}
        onSend={onSend}
        autoFocus={autoFocusComposer}
        placeholder={`Message ${room.title || "the group"}…`}
      />
      <div className="mt-1 hidden flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground lg:flex">
        <span className="inline-flex items-center gap-1 text-[11px]">
          <span className="font-mono text-[10px] font-semibold text-foreground">@</span>
          <span>to mention</span>
        </span>
        <span aria-hidden="true">·</span>
        <span className="text-[11px]">Shift+Enter for a new line</span>
      </div>
    </>
  ) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <div className="relative min-h-0 flex-1">
        {loading && messages.length === 0 ? (
          <MessagesSkeleton />
        ) : error && messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium">Could not load the conversation</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-4 py-8 text-center">
            <div className="mb-4 flex min-h-14 items-center justify-center">
              {members.length > 0 && <MemberAvatarStack members={members} max={6} size="md" />}
            </div>
            <h2 className="mb-2 max-w-full truncate text-2xl font-semibold">{room?.title || "New group"}</h2>
            <p className="mb-5 max-w-md text-sm text-muted-foreground">
              {readOnly
                ? "No messages yet. Messages written in the Telegram group will show up here."
                : settings.replyMode === "intent"
                  ? "Say hello. Mention @someone to ask them directly, or just write — the agents your message is meant for will answer."
                  : "Say hello. Agents answer when you @mention them."}
            </p>
            {centerComposer && <div className="w-full max-w-3xl text-left">{composer}</div>}
          </div>
        ) : (
          <Virtuoso
            key={room?.id}
            ref={virtuosoRef}
            data={messages}
            computeItemKey={(_, message) => message.id}
            followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
            initialTopMostItemIndex={Math.max(0, messages.length - 1)}
            atBottomStateChange={setAtBottom}
            atBottomThreshold={80}
            increaseViewportBy={600}
            itemContent={(_, message) => renderMessage(message)}
            components={{
              Header: () => <div className="h-2" />,
              Footer: () => (typingNames.length > 0 ? (
                <div className="w-full px-4 py-2">
                  <div className="mx-auto flex max-w-3xl items-center gap-2.5 py-1.5">
                    <div className="flex w-7 shrink-0 justify-center">
                      <TypingDots />
                    </div>
                    <span className="text-[11px] text-muted-foreground" aria-live="polite">{typingLabel(typingNames)}</span>
                  </div>
                </div>
              ) : <div className="h-3" />),
            }}
          />
        )}

        {!atBottom && messages.length > 0 && (
          <Button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md"
            size="icon"
            variant="outline"
            aria-label="Scroll to the latest message"
            onClick={() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: "end", behavior: "smooth" })}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}
      </div>

      {room && (readOnly ? (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border/40 px-4 py-3 pb-[max(0.75rem,var(--safe-bottom))] text-[11px] text-muted-foreground">
          <ChannelLogo type="telegram" size={12} />
          Written on Telegram — read-only here.
        </div>
      ) : !centerComposer && (
        // Same container as the chat composer (ChatInput).
        <div className="shrink-0 bg-background/80 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] backdrop-blur-md lg:pb-1.5">
          <div className="mx-auto max-w-3xl">{composer}</div>
        </div>
      ))}
    </div>
  );
}
