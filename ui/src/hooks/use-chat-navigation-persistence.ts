/**
 * Keeps "where I was" in the chat across reloads and devices:
 *
 *  - loads the person's chat navigation preferences from the server
 *    (GET /api/v1/preferences) and saves changes back (PATCH, debounced);
 *  - chooses the first chat shown: a link (`/chat?session=`) wins, otherwise
 *    the last chat this person had open (thread, new chat with its agent,
 *    group), otherwise the most recent thread;
 *  - opens threads requested by links and history entries, with a notice and
 *    a fallback when the thread no longer exists;
 *  - records the open thread / group / agent as they change.
 *
 * Mounted once, in ChatProvider, so it works the same in every layout
 * (sidebar, chat-first, phones) and for every chat kind (Polpo, agent chats,
 * channel chats, groups).
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatNavigationPreferences, MemberPreferencesPatch, MemberPreferencesResponse } from "@polpo-ai/react";
import {
  claimInitialChatSelection,
  claimInitialRoomSelection,
  getChatNavigation,
  hydrateChatNavigation,
  markChatNavigationOffline,
  setChatNavigationSaver,
  updateChatNavigation,
  useChatNavigationHydrated,
} from "@/lib/chat-navigation";
import {
  getActiveChatRoom,
  setActiveChatRoom,
  settleChatSessionRequest,
  useActiveChatRoom,
  useChatSessionRequest,
} from "./use-chat-room";

export interface PreferencesApi {
  getPreferences(): Promise<MemberPreferencesResponse>;
  updatePreferences(patch: MemberPreferencesPatch): Promise<MemberPreferencesResponse>;
}

interface ChatSessionLike {
  id: string;
  title?: string;
  messageCount: number;
}

export interface ChatNavigationTarget {
  sessions: ChatSessionLike[];
  sessionsLoading: boolean;
  sessionId: string | null;
  selectedAgent: string | null;
  loadSession: (id: string) => Promise<boolean>;
  newSession: () => void;
  setSelectedAgent: (agent: string | null) => void;
}

/** How long the chat waits for the server's preferences before using the local copy. */
const PREFERENCES_WAIT_MS = 2500;

/** Threads worth reopening (placeholder-only sessions from failed sends are skipped). */
function isListed(s: ChatSessionLike): boolean {
  return s.messageCount > 1 || (s.messageCount === 1 && !!s.title);
}

export function useChatNavigationPersistence(api: PreferencesApi | null | undefined, chat: ChatNavigationTarget): void {
  const hydrated = useChatNavigationHydrated();
  const roomId = useActiveChatRoom();
  const request = useChatSessionRequest();
  const chatRef = useRef(chat);
  const justRestoredRef = useRef(false);
  useEffect(() => { chatRef.current = chat; });

  // ── 1. Server preferences: load once per client, save changes back ──
  useEffect(() => {
    if (!api) {
      markChatNavigationOffline();
      return;
    }
    let cancelled = false;
    setChatNavigationSaver((patch) => api.updatePreferences({ chatNavigation: patch }));
    const timer = setTimeout(markChatNavigationOffline, PREFERENCES_WAIT_MS);
    api.getPreferences()
      .then((res) => {
        if (cancelled) return;
        hydrateChatNavigation(res.member, res.preferences?.chatNavigation as ChatNavigationPreferences | undefined);
      })
      .catch(() => { if (!cancelled) markChatNavigationOffline(); })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setChatNavigationSaver(null);
    };
  }, [api]);

  // Fallback when the requested/remembered thread is gone: the last thread
  // (unless it's the one that failed), else the most recent one, else new.
  const openFallback = (exclude: string | null) => {
    const { sessions, loadSession, newSession } = chatRef.current;
    const last = getChatNavigation().lastSessionId;
    const remembered = typeof last === "string" && last !== exclude ? sessions.find((s) => s.id === last) : undefined;
    const newest = sessions.find((s) => s.id !== exclude && isListed(s));
    const target = remembered ?? newest;
    if (target) void loadSession(target.id);
    else newSession();
  };

  // ── 2. First chat shown: restore the last one ──────────────────────
  useEffect(() => {
    if (chat.sessionsLoading || !hydrated) return;
    if (!claimInitialChatSelection()) return;
    // The restore's own state updates land on the next render: don't record
    // the not-yet-restored state in between.
    justRestoredRef.current = true;
    const nav = getChatNavigation();
    if (nav.lastRoomId && getActiveChatRoom() === null && claimInitialRoomSelection()) {
      setActiveChatRoom(nav.lastRoomId);
    }
    const { sessions, loadSession, setSelectedAgent } = chatRef.current;
    const last = nav.lastSessionId;
    if (typeof last === "string") {
      // Not listed (yet)? It may still exist — the list can be a stale cache.
      void loadSession(last).then((ok) => { if (!ok) openFallback(last); });
      return;
    }
    if (last === null) {
      // Last time this person was in a new chat: keep them there, same agent.
      setSelectedAgent(nav.lastAgent ?? null);
      return;
    }
    const newest = sessions.find(isListed);
    if (newest) void loadSession(newest.id);
  }, [chat.sessionsLoading, hydrated]);

  // ── 3. Threads requested by links / history entries ────────────────
  const handlingRef = useRef<typeof request>(null);
  useEffect(() => {
    if (!request || chat.sessionsLoading || handlingRef.current === request) return;
    handlingRef.current = request;
    const { sessionId, loadSession, newSession } = chatRef.current;
    const wanted = request.sessionId;
    if (wanted === null) {
      if (sessionId !== null) newSession();
      settleChatSessionRequest(request);
      return;
    }
    if (sessionId === wanted) {
      settleChatSessionRequest(request);
      return;
    }
    void loadSession(wanted).then((ok) => {
      if (!ok) {
        toast.info("This chat no longer exists", {
          description: "It may have been deleted. Showing your last chat instead.",
        });
        openFallback(wanted);
      }
      settleChatSessionRequest(request);
    });
  }, [request, chat.sessionsLoading]);

  // ── 4. Remember where the person is ────────────────────────────────
  useEffect(() => {
    // Only once the first chat was chosen and the server copy is in: an
    // early "nothing open yet" must not overwrite the remembered chat.
    if (!hydrated || request) return;
    if (chat.sessionsLoading) return;
    if (justRestoredRef.current) {
      justRestoredRef.current = false;
      return;
    }
    updateChatNavigation({
      lastSessionId: chat.sessionId,
      lastRoomId: roomId,
      ...(chat.sessionId === null ? { lastAgent: chat.selectedAgent } : {}),
    });
  }, [hydrated, request, chat.sessionsLoading, chat.sessionId, chat.selectedAgent, roomId]);
}
