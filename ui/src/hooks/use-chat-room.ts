/**
 * Group chat state shared by every chat surface (full page, compact side
 * panel, chat-first panel): which group (room) is open in the chat area and
 * whether the "New group" dialog is requested.
 *
 * Lives in an external store (like the chat sidebar stores) because the room
 * must survive switching surfaces, and because in the chat-first layout the
 * chat panel is visible while the URL points at another page. On /chat the
 * store is mirrored to `?room=<id>` by ChatRoomRouteSync.
 */
import { useSyncExternalStore } from "react";

interface NewGroupRequest {
  /** Agents preselected in the dialog. */
  agents: string[];
}

interface ChatRoomState {
  roomId: string | null;
  /** Title of the open room, published by the chat so headers can show it. */
  roomTitle: string | null;
  newGroup: NewGroupRequest | null;
}

let state: ChatRoomState = { roomId: null, roomTitle: null, newGroup: null };
const listeners = new Set<() => void>();

function update(next: Partial<ChatRoomState>) {
  state = { ...state, ...next };
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const getRoomId = () => state.roomId;
const getRoomTitle = () => state.roomTitle;
const getNewGroup = () => state.newGroup;

/** Id of the group open in the chat, or null for a normal chat. */
export function useActiveChatRoom(): string | null {
  return useSyncExternalStore(subscribe, getRoomId, getRoomId);
}

export function useActiveChatRoomTitle(): string | null {
  return useSyncExternalStore(subscribe, getRoomTitle, getRoomTitle);
}

export function getActiveChatRoom(): string | null {
  return state.roomId;
}

/** Open a group in the chat (or pass null to go back to the normal chat). */
export function setActiveChatRoom(roomId: string | null) {
  if (state.roomId === roomId) return;
  update({ roomId, roomTitle: null });
}

export function setActiveChatRoomTitle(title: string | null) {
  if (state.roomTitle === title) return;
  update({ roomTitle: title });
}

/** Pending "New group" dialog request, or null. */
export function useNewGroupRequest(): NewGroupRequest | null {
  return useSyncExternalStore(subscribe, getNewGroup, getNewGroup);
}

/** Ask the chat to open the "New group" dialog, optionally preselecting agents. */
export function requestNewGroup(agent?: string | null) {
  update({ newGroup: { agents: agent ? [agent] : [] } });
}

export function closeNewGroup() {
  if (!state.newGroup) return;
  update({ newGroup: null });
}

/** Link to a group inside the chat. */
export function chatRoomPath(roomId: string): string {
  return `/chat?room=${encodeURIComponent(roomId)}`;
}

/**
 * Apply the one-shot chat link params (`?room=`, `?newGroup=1&agent=`) to the
 * store. Used where /chat is not kept in the URL (chat-first desktop layout).
 */
export function applyChatLinkParams(search: string) {
  const params = new URLSearchParams(search);
  if (params.has("newGroup")) requestNewGroup(params.get("agent"));
  const room = params.get("room");
  if (room) setActiveChatRoom(room);
}
