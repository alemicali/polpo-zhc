/**
 * Mirrors the open group (use-chat-room store) to the /chat URL:
 *
 *   /chat?room=<id>   a group is open in the chat
 *   /chat             normal chat
 *   /chat?newGroup=1  opens the "New group" dialog (one-shot, `agent=` preselects)
 *
 * URL → store when the location changes (deep links, back/forward), store →
 * URL when the chat opens or leaves a group. Only mounted where /chat is a real
 * route (sidebar layout, chat-first on mobile); the chat-first desktop panel
 * keeps the room in the store only.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  getActiveChatRoom,
  requestNewGroup,
  setActiveChatRoom,
  useActiveChatRoom,
} from "@/hooks/use-chat-room";

function searchString(params: URLSearchParams): string {
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function ChatRoomRouteSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const roomId = useActiveChatRoom();
  const lastKeyRef = useRef<string | null>(null);
  const lastPathRef = useRef<string | null>(null);
  const lastRoomRef = useRef(roomId);

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
    if (urlRoom) {
      setActiveChatRoom(urlRoom);
    } else if (previousPath === "/chat") {
      // Back/forward inside the chat to a plain /chat entry.
      setActiveChatRoom(null);
    } else {
      // Arriving on /chat while a group is open in another chat surface: keep it.
      const open = getActiveChatRoom();
      if (open) {
        params.set("room", open);
        rewrite = true;
      }
    }
    if (rewrite) {
      navigate({ pathname: "/chat", search: searchString(params), hash: location.hash }, { replace: true });
    }
  }, [location, navigate]);

  // Store → URL (only when the open room actually changes).
  useEffect(() => {
    if (lastRoomRef.current === roomId) return;
    lastRoomRef.current = roomId;
    if (location.pathname !== "/chat") return;
    const params = new URLSearchParams(location.search);
    if ((params.get("room") ?? null) === roomId) return;
    if (roomId) params.set("room", roomId);
    else params.delete("room");
    navigate({ pathname: "/chat", search: searchString(params) });
  }, [roomId, location, navigate]);

  return null;
}
