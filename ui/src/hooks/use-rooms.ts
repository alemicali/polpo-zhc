/**
 * Groups (rooms) state for the /groups page.
 *
 * - Lists web + Telegram rooms and keeps them fresh from SSE
 *   (room:created / room:updated / room:deleted / room:message).
 * - Holds the open conversation: transcript, live typing indicators, send.
 *
 * Live updates ride the app's single SSE connection (useEvents from the SDK —
 * no second EventSource). Messages are deduped by id, so the POST response and
 * the SSE echo of the person's own message collapse into one. As a safety net,
 * while no room event has been seen on the stream yet the open conversation is
 * polled (fast right after sending, slow otherwise), so the page still works
 * if the stream does not carry room events.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEvents, usePolpo } from "@polpo-ai/react";
import {
  mergeRoomMessages,
  roomsApi,
  sortRooms,
  type Room,
  type RoomInput,
  type RoomMessage,
  type RoomTypingEntry,
} from "@/lib/rooms-api";

type SSEEvent = ReturnType<typeof useEvents>["events"][number];

const ROOM_EVENTS = ["room:*"];
/** A typing flag without a follow-up event is dropped after this long. */
const TYPING_TTL_MS = 90_000;
/** Poll cadence while SSE has not delivered room events yet. */
const FAST_POLL_MS = 2_500;
const SLOW_POLL_MS = 15_000;
/** How long after a send (or a new reply) polling stays fast. */
const FAST_WINDOW_MS = 120_000;

interface TypingState {
  name: string;
  expiresAt: number;
}

export interface TypingAgent {
  agent: string;
  name: string;
}

/** Calls `handler` once for every room event that arrives after mount. */
function useRoomEventHandler(handler: (event: SSEEvent) => void) {
  const { events } = useEvents(ROOM_EVENTS, 200);
  // Skip the backlog already buffered before this page mounted: the initial
  // fetch covers it, and replaying stale typing flags would be wrong.
  const lastRef = useRef<SSEEvent | undefined>(events.at(-1));
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const latest = events.at(-1);
    if (!latest || latest === lastRef.current) return;
    const previous = lastRef.current ? events.indexOf(lastRef.current) : -1;
    const added = events.slice(previous + 1);
    lastRef.current = latest;
    for (const event of added) handlerRef.current(event);
  }, [events]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function isRoom(value: unknown): value is Room {
  const v = asRecord(value);
  return !!v && typeof v.id === "string" && typeof v.title === "string" && Array.isArray(v.agents);
}

function isRoomMessage(value: unknown): value is RoomMessage {
  const v = asRecord(value);
  return !!v && typeof v.id === "string" && typeof v.text === "string" && typeof v.authorId === "string";
}

function laterIso(a: string, b: string): string {
  return (Date.parse(b) || 0) > (Date.parse(a) || 0) ? b : a;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Web + Telegram rooms, merged and sorted. Fails only when both lists fail. */
async function fetchRoomList(): Promise<{ rooms: Room[] } | { error: string }> {
  const [web, telegram] = await Promise.allSettled([roomsApi.list("web"), roomsApi.list("telegram")]);
  if (web.status === "rejected" && telegram.status === "rejected") return { error: errorMessage(web.reason) };
  const byId = new Map<string, Room>();
  for (const result of [web, telegram]) {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
    for (const room of result.value) byId.set(room.id, room);
  }
  return { rooms: sortRooms([...byId.values()]) };
}

async function fetchConversation(roomId: string) {
  const [messages, typing] = await Promise.allSettled([roomsApi.messages(roomId), roomsApi.typing(roomId)]);
  return { messages, typing };
}

export function useGroups(activeRoomId: string | null) {
  const { connectionStatus } = usePolpo();

  // ── Room list ──────────────────────────────────────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [unread, setUnread] = useState<Set<string>>(() => new Set());

  const refreshRooms = useCallback(() => fetchRoomList().then((result) => {
    if ("error" in result) setRoomsError(result.error);
    else {
      setRooms(result.rooms);
      setRoomsError(null);
    }
    setRoomsLoading(false);
  }), []);

  useEffect(() => {
    void refreshRooms();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshRooms();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshRooms]);

  const upsertRoom = useCallback((room: Room) => {
    setRooms((prev) => sortRooms([room, ...prev.filter((r) => r.id !== room.id)]));
  }, []);

  const dropRoom = useCallback((roomId: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
  }, []);

  // ── Open conversation ──────────────────────────────────────────────
  const [fetchedRoom, setFetchedRoom] = useState<Room | null>(null);
  const [roomMissing, setRoomMissing] = useState(false);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, TypingState>>({});

  const activeRoomRef = useRef(activeRoomId);
  useEffect(() => {
    activeRoomRef.current = activeRoomId;
  }, [activeRoomId]);

  const sseSeenRef = useRef(false);
  const fastUntilRef = useRef(0);
  const lastPollRef = useRef(0);

  const room = useMemo(
    () => rooms.find((r) => r.id === activeRoomId) ?? (fetchedRoom?.id === activeRoomId ? fetchedRoom : null),
    [activeRoomId, fetchedRoom, rooms],
  );

  const applyTyping = useCallback((entries: RoomTypingEntry[]) => {
    const now = Date.now();
    setTyping(Object.fromEntries(entries.map((entry) => [entry.agent, { name: entry.name, expiresAt: now + TYPING_TTL_MS }])));
  }, []);

  // The loading flag is raised by the room-change reset below.
  const loadConversation = useCallback((roomId: string, silent: boolean) => {
    lastPollRef.current = Date.now();
    return fetchConversation(roomId).then(({ messages: msgs, typing: typingNow }) => {
      if (activeRoomRef.current !== roomId) return;
      if (msgs.status === "fulfilled") {
        const list = Array.isArray(msgs.value) ? msgs.value : [];
        // Merge (not replace): SSE may have delivered newer messages while this was in flight.
        setMessages((prev) => mergeRoomMessages(prev, list));
        setMessagesError(null);
      } else if (!silent) {
        setMessagesError(errorMessage(msgs.reason));
      }
      if (typingNow.status === "fulfilled" && Array.isArray(typingNow.value)) applyTyping(typingNow.value);
      if (!silent) setMessagesLoading(false);
    });
  }, [applyTyping]);

  // Reset when the open room changes (adjusted during render, not in an effect).
  const [shownRoomId, setShownRoomId] = useState<string | null>(null);
  if (shownRoomId !== activeRoomId) {
    setShownRoomId(activeRoomId);
    setMessages([]);
    setTyping({});
    setMessagesError(null);
    setRoomMissing(false);
    setMessagesLoading(!!activeRoomId);
    if (activeRoomId && unread.has(activeRoomId)) {
      const next = new Set(unread);
      next.delete(activeRoomId);
      setUnread(next);
    }
  }

  useEffect(() => {
    if (activeRoomId) void loadConversation(activeRoomId, false);
  }, [activeRoomId, loadConversation]);

  // Deep link to a room that is not (yet) in the list: fetch it directly.
  useEffect(() => {
    if (!activeRoomId || roomsLoading) return;
    if (rooms.some((r) => r.id === activeRoomId)) return;
    if (fetchedRoom?.id === activeRoomId) return;
    let cancelled = false;
    roomsApi.get(activeRoomId).then((r) => {
      if (!cancelled) setFetchedRoom(r);
    }).catch(() => {
      if (!cancelled) setRoomMissing(true);
    });
    return () => { cancelled = true; };
  }, [activeRoomId, fetchedRoom?.id, rooms, roomsLoading]);

  // Drop expired typing flags (a lost "typing: false" must not stick forever).
  const hasTyping = Object.keys(typing).length > 0;
  useEffect(() => {
    if (!hasTyping) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        const entries = Object.entries(prev).filter(([, t]) => t.expiresAt > now);
        return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasTyping]);

  // Fallback polling until the SSE stream proves it carries room events.
  useEffect(() => {
    if (!activeRoomId) return;
    const timer = window.setInterval(() => {
      if (sseSeenRef.current || document.visibilityState !== "visible") return;
      const now = Date.now();
      const interval = now < fastUntilRef.current ? FAST_POLL_MS : SLOW_POLL_MS;
      if (now - lastPollRef.current < interval) return;
      void loadConversation(activeRoomId, true);
    }, FAST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeRoomId, loadConversation]);

  // Fill SSE gaps after a reconnect and when the tab becomes visible again.
  const prevStatusRef = useRef(connectionStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = connectionStatus;
    if (connectionStatus !== "connected" || prev === "connected") return;
    void refreshRooms();
    if (activeRoomRef.current) void loadConversation(activeRoomRef.current, true);
  }, [connectionStatus, loadConversation, refreshRooms]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && activeRoomRef.current) {
        void loadConversation(activeRoomRef.current, true);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadConversation]);

  // ── SSE ────────────────────────────────────────────────────────────
  useRoomEventHandler((event) => {
    sseSeenRef.current = true;
    const data = asRecord(event.data);
    if (!data) return;
    switch (event.event) {
      case "room:created":
      case "room:updated": {
        if (isRoom(data.room)) {
          const updated = data.room;
          upsertRoom(updated);
          setFetchedRoom((prev) => (prev?.id === updated.id ? updated : prev));
        }
        break;
      }
      case "room:deleted": {
        if (typeof data.roomId === "string") {
          dropRoom(data.roomId);
          if (data.roomId === activeRoomRef.current) setRoomMissing(true);
        }
        break;
      }
      case "room:message": {
        const roomId = typeof data.roomId === "string" ? data.roomId : null;
        if (!roomId || !isRoomMessage(data.message)) break;
        const message = data.message;
        setRooms((prev) => {
          const target = prev.find((r) => r.id === roomId);
          if (!target) return prev;
          const updatedAt = laterIso(target.updatedAt, message.ts);
          if (updatedAt === target.updatedAt) return prev;
          return sortRooms(prev.map((r) => (r.id === roomId ? { ...r, updatedAt } : r)));
        });
        if (roomId === activeRoomRef.current) {
          setMessages((prev) => mergeRoomMessages(prev, [message]));
          if (message.authorKind === "agent") {
            setTyping((prev) => {
              if (!prev[message.authorId]) return prev;
              const next = { ...prev };
              delete next[message.authorId];
              return next;
            });
          }
        } else if (message.authorKind === "agent") {
          setUnread((prev) => (prev.has(roomId) ? prev : new Set(prev).add(roomId)));
        }
        break;
      }
      case "room:typing": {
        if (data.roomId !== activeRoomRef.current || typeof data.agent !== "string") break;
        const agent = data.agent;
        const name = typeof data.name === "string" && data.name ? data.name : agent;
        setTyping((prev) => {
          if (data.typing === false) {
            if (!prev[agent]) return prev;
            const next = { ...prev };
            delete next[agent];
            return next;
          }
          return { ...prev, [agent]: { name, expiresAt: Date.now() + TYPING_TTL_MS } };
        });
        break;
      }
    }
  });

  // ── Actions ────────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const roomId = activeRoomRef.current;
    if (!roomId) throw new Error("No group selected");
    const message = await roomsApi.send(roomId, text);
    fastUntilRef.current = Date.now() + FAST_WINDOW_MS;
    lastPollRef.current = Date.now();
    if (activeRoomRef.current === roomId && isRoomMessage(message)) {
      setMessages((prev) => mergeRoomMessages(prev, [message]));
    }
    setRooms((prev) => sortRooms(prev.map((r) => (
      r.id === roomId ? { ...r, updatedAt: laterIso(r.updatedAt, message?.ts ?? new Date().toISOString()) } : r
    ))));
    return message;
  }, []);

  const createRoom = useCallback(async (input: RoomInput) => {
    const created = await roomsApi.create(input);
    upsertRoom(created);
    return created;
  }, [upsertRoom]);

  const updateRoom = useCallback(async (roomId: string, patch: Partial<RoomInput>) => {
    const updated = await roomsApi.update(roomId, patch);
    upsertRoom(updated);
    setFetchedRoom((prev) => (prev?.id === updated.id ? updated : prev));
    return updated;
  }, [upsertRoom]);

  const deleteRoom = useCallback(async (roomId: string) => {
    await roomsApi.remove(roomId);
    dropRoom(roomId);
  }, [dropRoom]);

  const reloadConversation = useCallback(() => {
    if (activeRoomRef.current) void loadConversation(activeRoomRef.current, false);
  }, [loadConversation]);

  const typingAgents = useMemo<TypingAgent[]>(
    () => Object.entries(typing).map(([agent, t]) => ({ agent, name: t.name })),
    [typing],
  );

  return {
    rooms,
    roomsLoading,
    roomsError,
    refreshRooms,
    unread,
    room,
    roomMissing,
    messages,
    messagesLoading,
    messagesError,
    typingAgents,
    send,
    createRoom,
    updateRoom,
    deleteRoom,
    reloadConversation,
  };
}
