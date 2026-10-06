/**
 * Rooms ("Groups" in the UI) — group conversations between people and agents.
 *
 * Thin client for /api/v1/rooms. Same envelope ({ ok, data } / { ok, error })
 * and auth conventions as the other page-level clients (use-apps, use-data).
 */
import { apiUrl, config } from "@/lib/config";

export type RoomKind = "web" | "telegram";
export type RoomReplyMode = "mentions" | "intent";
export type RoomReplyOrder = "parallel" | "sequential";

export interface RoomSettings {
  replyMode?: RoomReplyMode;
  intentThreshold?: number;
  replyOrder?: RoomReplyOrder;
  agentToAgent?: boolean;
  maxAgentHops?: number;
}

export interface Room {
  id: string;
  kind: RoomKind;
  title: string;
  agents: string[];
  settings: RoomSettings;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  ts: string;
  authorKind: "person" | "agent";
  authorId: string;
  authorName: string;
  text: string;
  externalId?: string;
  addressedTo?: string[];
  replyToId?: string;
}

export interface RoomTypingEntry {
  agent: string;
  name: string;
}

export interface RoomInput {
  title: string;
  agents: string[];
  settings?: RoomSettings;
}

/** Member id of the orchestrator when it takes part in a group. */
export const ORCHESTRATOR_MEMBER_ID = "polpo";

/** Defaults shown in the UI — kept in sync with the server defaults. */
export const DEFAULT_ROOM_SETTINGS: Required<RoomSettings> = {
  replyMode: "intent",
  intentThreshold: 0.7,
  replyOrder: "parallel",
  agentToAgent: true,
  maxAgentHops: 3,
};

export function resolveRoomSettings(settings: RoomSettings | undefined): Required<RoomSettings> {
  return { ...DEFAULT_ROOM_SETTINGS, ...(settings ?? {}) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1/rooms${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string"
      ? body.error
      : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `Groups request failed (${response.status})`);
  }
  return body.data as T;
}

const roomPath = (id: string) => `/${encodeURIComponent(id)}`;

export const roomsApi = {
  list: (kind?: RoomKind) =>
    request<Room[]>(kind ? `?kind=${kind}` : ""),
  get: (id: string) =>
    request<Room>(roomPath(id)),
  create: (input: RoomInput) =>
    request<Room>("", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: Partial<RoomInput>) =>
    request<Room>(roomPath(id), { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) =>
    request<{ deleted: true }>(roomPath(id), { method: "DELETE" }),
  messages: (id: string, limit = 200) =>
    request<RoomMessage[]>(`${roomPath(id)}/messages?limit=${limit}`),
  send: (id: string, text: string) =>
    request<RoomMessage>(`${roomPath(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  typing: (id: string) =>
    request<RoomTypingEntry[]>(`${roomPath(id)}/typing`),
};

/** Merge messages by id (later copies win) and keep them oldest → newest. */
export function mergeRoomMessages(current: RoomMessage[], incoming: RoomMessage[]): RoomMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, RoomMessage>();
  for (const message of current) byId.set(message.id, message);
  let changed = false;
  for (const message of incoming) {
    const existing = byId.get(message.id);
    // A re-emitted message may carry new fields (e.g. addressedTo after routing).
    if (existing && JSON.stringify(existing) === JSON.stringify(message)) continue;
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => {
    const diff = Date.parse(a.ts) - Date.parse(b.ts);
    return Number.isNaN(diff) || diff === 0 ? 0 : diff;
  });
}

/** Rooms newest-activity first. */
export function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

/** Typing line: "Giulia is typing…", "Giulia and Marco are typing…", "Giulia, Marco and 2 others are typing…" */
export function typingLabel(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing…`;
}

/** First non-empty line of a message, trimmed for a reply quote. */
export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line.replace(/^#+\s*/, "").replace(/[*_`>]/g, "");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
