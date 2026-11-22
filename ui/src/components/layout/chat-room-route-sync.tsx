/**
 * Mirrors what the chat shows to the /chat URL, so reload, back/forward and
 * shared links land on the same chat:
 *
 *   /chat?room=<id>     a group is open in the chat
 *   /chat?session=<id>  a thread is open (Polpo, agent and channel chats alike)
 *   /chat               a new chat (or nothing chosen yet: the chat restores
 *                       the last one this person had open)
 *   /chat?newGroup=1    opens the "New group" dialog (one-shot, `agent=` preselects)
 *
 * URL → store when the location changes (deep links, back/forward), store →
 * URL when the chat opens or leaves a group or switches thread. Only mounted
 * where /chat is a real route (sidebar layout, chat-first on mobile); the
 * chat-first desktop panel keeps the chat in the stores only.
 *
 * Threads are opened by the chat provider (`requestChatSession`), which waits
 * for the thread list, and falls back with a notice for a deleted thread.
 */
import { use, useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { ChatSessionStateContext } from "@/hooks/chat-context";
import {
  getActiveChatRoom,
  requestChatSession,
  requestNewGroup,
  setActiveChatRoom,
  useActiveChatRoom,
  useChatSessionRequest,
} from "@/hooks/use-chat-room";

function searchString(params: URLSearchParams): string {
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function ChatRoomRouteSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const roomId = useActiveChatRoom();
  // Thread sync needs the chat; without a ChatProvider only groups are mirrored.
  const chatSession = use(ChatSessionStateContext);
  const sessionId = chatSession ? chatSession.sessionId : undefined;
  const sessionRequest = useChatSessionRequest();
  const lastKeyRef = useRef<string | null>(null);
  const lastPathRef = useRef<string | null>(null);
  const lastRoomRef = useRef(roomId);
  const lastSessionRef = useRef(sessionId);
  const wasRequestPendingRef = useRef(false);

  // URL → store (once per history entry).
  useEffect(() => {
    if (lastKeyRef.current === location.key) return;
    lastKeyRef.current = location.key;
    const previousPath = lastPathRef.current;
    lastPathRef.current = location.pathname;
    if (location.pathname !== "/chat") return;

    const params = new URLSearchParams(location.search);
    let rewrite = false;
    if (params.has("newGroup")) {
      requestNewGroup(params.get("agent"));
      params.delete("newGroup");
      params.delete("agent");
      rewrite = true;
    }
    const urlRoom = params.get("room");
    const urlSession = params.get("session");
    if (urlRoom) {
      setActiveChatRoom(urlRoom);
    } else if (urlSession && sessionId !== undefined) {
      setActiveChatRoom(null);
      if (urlSession !== sessionId) requestChatSession(urlSession);
    } else if (previousPath === "/chat" && navigationType === "POP") {
      // Back/forward inside the chat to a plain /chat entry: a new chat.
      setActiveChatRoom(null);
      if (sessionId) requestChatSession(null);
    } else {
      // Arriving on /chat while a chat is open (another surface, or a page
      // before): keep it and put it in the URL.
      const open = getActiveChatRoom();
      if (open) {
        params.set("room", open);
        params.delete("session");
        rewrite = true;
      } else if (sessionId && !urlSession) {
        params.set("session", sessionId);
        rewrite = true;
      }
    }
    if (rewrite) {
      navigate({ pathname: "/chat", search: searchString(params), hash: location.hash }, { replace: true });
    }
    // sessionId is read for the current entry only; changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, navigate]);

  // Store → URL (only when the open group or thread actually changes).
  useEffect(() => {
    const roomChanged = lastRoomRef.current !== roomId;
    const sessionChanged = lastSessionRef.current !== sessionId;
    // A requested thread is still opening: the URL already says where we go.
    const pending = sessionRequest !== null;
    const settledRequest = wasRequestPendingRef.current && !pending;
    wasRequestPendingRef.current = pending;
    if (pending) return;
    lastRoomRef.current = roomId;
    lastSessionRef.current = sessionId;
    if (!roomChanged && !sessionChanged && !settledRequest) return;
    if (location.pathname !== "/chat") return;

    const params = new URLSearchParams(location.search);
    const urlRoom = params.get("room");
    const urlSession = params.get("session");
    const wantRoom = roomId;
    const wantSession = roomId || sessionId === undefined ? null : sessionId;
    if (urlRoom === wantRoom && (sessionId === undefined || urlSession === wantSession)) return;

    if (wantRoom) params.set("room", wantRoom);
    else params.delete("room");
    if (wantSession) params.set("session", wantSession);
    else params.delete("session");
    // Opening/leaving a group or switching threads is a step back can undo.
    // Filling in a plain /chat (restore, first message of a new chat) or
    // replacing a dead link is not.
    const replace = settledRequest || (!roomChanged && !urlRoom && !urlSession);
    navigate({ pathname: "/chat", search: searchString(params) }, { replace });
  }, [roomId, sessionId, sessionRequest, location, navigate]);

  return null;
}
