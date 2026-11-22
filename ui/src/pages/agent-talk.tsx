/**
 * Agent conversations — how agents talked to each other, live.
 *
 * Left: the pairs (one conversation per direction) and a live feed of the recent exchanges
 * (ask_agent questions and message_agent handoffs). Right: the selected pair's full transcript,
 * refreshed when one of its exchanges is answered. On phones the two are shown one at a time.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@polpo-ai/react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  MessageCircle,
  MessagesSquare,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { MessageResponse } from "@/components/ai-elements/message";
import { useChatActions } from "@/hooks/chat-context";
import { setActiveChatRoom } from "@/hooks/use-chat-room";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { useAgentTalk } from "@/hooks/use-agent-talk";
import {
  agentTalkApi,
  splitIntro,
  type AgentExchange,
  type AgentPair,
  type TranscriptMessage,
} from "@/lib/agent-talk-api";
import { cn } from "@/lib/utils";

// ── Helpers ─────────────────────────────────────────────────────────────────

function ago(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNow(date, { addSuffix: true });
}

function fullDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

function took(start: string, end: string | undefined): string | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** Opens a chat session in the app's chat. */
function useOpenChat() {
  const { loadSession } = useChatActions();
  const navigate = useNavigate();
  const layoutMode = useLayoutMode();
  return useCallback((sessionId: string) => {
    setActiveChatRoom(null);
    void loadSession(sessionId);
    // Chat-first on desktop: the chat is the left panel already, stay on this page.
    const mobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023px)").matches;
    if (layoutMode === "chat-first" && !mobile) return;
    navigate("/chat");
  }, [loadSession, navigate, layoutMode]);
}

function useAvatars(): (name: string) => string | undefined {
  const { agents } = useAgents();
  const byName = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const agent of agents ?? []) map.set(agent.name, agent.identity?.avatar);
    return map;
  }, [agents]);
  return useCallback((name: string) => byName.get(name), [byName]);
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function PairLabel({ from, to, avatar }: { from: string; to: string; avatar: (name: string) => string | undefined }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
      <AgentAvatar name={from} avatar={avatar(from)} size="xs" fallbackVariant="circle" shape="circle" />
      <span className="truncate">{from}</span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="to" />
      <AgentAvatar name={to} avatar={avatar(to)} size="xs" fallbackVariant="circle" shape="circle" />
      <span className="truncate">{to}</span>
    </span>
  );
}

function StatusBadge({ exchange }: { exchange: AgentExchange }) {
  if (exchange.status === "working") {
    return (
      <Badge variant="outline" className="gap-1 text-micro text-warning">
        <Loader2 className="animate-spin" />Working
      </Badge>
    );
  }
  if (exchange.status === "failed") {
    return (
      <Badge variant="outline" className="gap-1 text-micro text-destructive">
        <AlertCircle />Failed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-micro text-success">
      <CheckCircle2 />Answered
    </Badge>
  );
}

function ExchangeCard({
  exchange, selected, onSelect, onOpenChat, avatar,
}: {
  exchange: AgentExchange;
  selected: boolean;
  onSelect?: () => void;
  onOpenChat?: () => void;
  avatar: (name: string) => string | undefined;
}) {
  const duration = took(exchange.startedAt, exchange.answeredAt);
  return (
    <li
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors",
        onSelect && "cursor-pointer hover:bg-accent/40",
        selected && "border-primary/50 bg-accent/30",
      )}
      onClick={onSelect}
      onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } } : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      data-testid="agent-exchange"
    >
      <div className="flex flex-wrap items-center gap-2">
        <PairLabel from={exchange.from} to={exchange.to} avatar={avatar} />
        <Badge variant="secondary" className="text-micro">
          {exchange.kind === "handoff" ? "Handoff" : "Question"}
        </Badge>
        <StatusBadge exchange={exchange} />
      </div>
      <div className="mt-1 text-caption text-muted-foreground">
        <span title={fullDate(exchange.startedAt)}>{ago(exchange.startedAt)}</span>
        {duration && exchange.status !== "working" && (
          <span title={fullDate(exchange.answeredAt)}> · {exchange.status === "failed" ? "failed" : "answered"} after {duration}</span>
        )}
      </div>
      <div className="mt-2 text-sm whitespace-pre-wrap break-words">{exchange.message}</div>
      {exchange.status === "answered" && exchange.answer && (
        <div className="mt-2 rounded-md border-l-2 border-success/50 bg-muted/40 px-3 py-2 text-sm">
          <div className="mb-1 text-caption font-medium text-muted-foreground">{exchange.to} answered</div>
          <MessageResponse>{exchange.answer}</MessageResponse>
        </div>
      )}
      {exchange.status === "failed" && (
        <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive break-words">
          {exchange.error || "The exchange failed."}
        </div>
      )}
      {onOpenChat && (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={(e) => { e.stopPropagation(); onOpenChat(); }}
          >
            <MessageCircle />Open the chat
          </Button>
        </div>
      )}
    </li>
  );
}

function Transcript({
  pair, version, onBack, avatar,
}: {
  pair: AgentPair;
  version: number;
  onBack: () => void;
  avatar: (name: string) => string | undefined;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Loading until the transcript for this pair/version/reload has come back
  const requestKey = `${pair.sessionId}:${version}:${reloads}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    agentTalkApi.transcript(pair.sessionId).then((list) => {
      if (cancelled) return;
      setMessages(list.filter((m) => m.role === "user" || m.role === "assistant"));
      setError(null);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoadedKey(requestKey);
    });
    return () => { cancelled = true; };
  }, [pair.sessionId, requestKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card" data-testid="agent-transcript">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onBack} aria-label="Back to the list">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1"><PairLabel from={pair.from} to={pair.to} avatar={avatar} /></div>
        <Button variant="ghost" size="icon-sm" onClick={() => setReloads((n) => n + 1)} aria-label="Refresh the conversation">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages in this conversation yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {messages.map((message) => {
              const mine = message.role === "assistant";
              const { intro, text } = mine ? { intro: null, text: message.content } : splitIntro(message.content);
              const author = mine ? pair.to : pair.from;
              return (
                <li key={message.id} className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
                  <div className="flex max-w-full items-center gap-1.5 text-caption text-muted-foreground">
                    <AgentAvatar name={author} avatar={avatar(author)} size="xs" fallbackVariant="circle" shape="circle" />
                    <span className="truncate">{intro ?? author}</span>
                    <span className="shrink-0" title={fullDate(message.ts)}>· {ago(message.ts)}</span>
                  </div>
                  <div
                    className={cn(
                      "max-w-[92%] rounded-lg px-3 py-2 text-sm break-words",
                      mine ? "bg-primary/10" : "bg-muted",
                    )}
                  >
                    <MessageResponse>{text}</MessageResponse>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <MessagesSquare className="h-10 w-10 text-muted-foreground/60" />
      <div className="text-base font-medium">No agent conversations yet</div>
      <p className="max-w-md text-sm text-muted-foreground">
        Agents talk to each other with <code className="rounded bg-muted px-1">ask_agent</code> (a quick
        question, answered while they keep working) and <code className="rounded bg-muted px-1">message_agent</code> (a
        handoff for real work). Their exchanges show up here live, and you can read each pair's full conversation.
      </p>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function AgentTalkPage() {
  const { pairs, recent, loading, error, refresh, settled } = useAgentTalk();
  const [selected, setSelected] = useState<AgentPair | null>(null);
  const openChat = useOpenChat();
  const avatar = useAvatars();

  const countBySession = useMemo(() => {
    const counts = new Map<string, { total: number; last?: string; working: number }>();
    for (const x of recent) {
      if (!x.dmSessionId) continue;
      const entry = counts.get(x.dmSessionId) ?? { total: 0, working: 0 };
      entry.total += 1;
      if (x.status === "working") entry.working += 1;
      if (!entry.last || Date.parse(x.startedAt) > Date.parse(entry.last)) entry.last = x.startedAt;
      counts.set(x.dmSessionId, entry);
    }
    return counts;
  }, [recent]);

  if (loading) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const empty = pairs.length === 0 && recent.length === 0;
  const selectExchange = (x: AgentExchange) => {
    if (x.dmSessionId) setSelected({ from: x.from, to: x.to, sessionId: x.dmSessionId });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          How your agents talked to each other: questions and handoffs, live.
        </p>
        <Button variant="outline" size="sm" onClick={() => void refresh()} className="shrink-0">
          <RefreshCw />Refresh
        </Button>
      </div>
      {error && (
        <div className="shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {empty ? (
        <EmptyState />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          {/* List: pairs + live feed (hidden on phones while a transcript is open) */}
          <div className={cn("min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex", selected ? "hidden" : "flex")}>
            {pairs.length > 0 && (
              <section>
                <h2 className="mb-2 text-label text-muted-foreground">Conversations</h2>
                <ul className="flex flex-col gap-1.5">
                  {pairs.map((pair) => {
                    const stats = countBySession.get(pair.sessionId);
                    const active = selected?.sessionId === pair.sessionId;
                    return (
                      <li key={pair.sessionId}>
                        <button
                          type="button"
                          onClick={() => setSelected(pair)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40",
                            active && "border-primary/50 bg-accent/30",
                          )}
                          aria-current={active ? "true" : undefined}
                        >
                          <div className="min-w-0 flex-1"><PairLabel from={pair.from} to={pair.to} avatar={avatar} /></div>
                          {stats?.working ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" aria-label="Working" /> : null}
                          {stats?.last && (
                            <span className="shrink-0 text-caption text-muted-foreground">{ago(stats.last)}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <section>
              <h2 className="mb-2 text-label text-muted-foreground">Recent exchanges</h2>
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent exchanges.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {recent.map((x) => (
                    <ExchangeCard
                      key={x.id}
                      exchange={x}
                      avatar={avatar}
                      selected={!!x.dmSessionId && selected?.sessionId === x.dmSessionId}
                      onSelect={x.dmSessionId ? () => selectExchange(x) : undefined}
                      onOpenChat={x.fromSessionId ? () => openChat(x.fromSessionId!) : undefined}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Transcript */}
          <div className={cn("min-h-0 flex-1 flex-col lg:flex", selected ? "flex" : "hidden")}>
            {selected ? (
              <Transcript
                key={selected.sessionId}
                pair={selected}
                version={settled[selected.sessionId] ?? 0}
                onBack={() => setSelected(null)}
                avatar={avatar}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Select a conversation or an exchange to read the full transcript.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
