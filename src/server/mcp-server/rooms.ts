/**
 * Rooms: group chats of people and agents (the dashboard's groups). Posting writes as the MCP
 * principal; the agents answer in the background, as on the web (mentions, replies, the room's
 * reply mode), and polpo_room_wait follows their replies.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, MAX_WAIT_SECONDS, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, decodeCursor,
  enc, encodeCursor, fail, limitParam, ok, pageBackwards, pageOutput, progress, short, sleep,
  type McpDeps, type Register,
} from "./kit.js";

/** Most messages the API returns for a room (its latest). */
const MAX_TRANSCRIPT = 500;

type RoomSettings = { replyMode?: string; intentThreshold?: number; replyOrder?: string; agentToAgent?: boolean; maxAgentHops?: number; goal?: string; owner?: string };
type Room = { id: string; kind: string; title: string; agents: string[]; settings: RoomSettings; createdAt?: string; updatedAt?: string };
type RoomMessage = { id: string; ts: string; authorKind: string; authorId: string; authorName: string; text: string; addressedTo?: string[]; replyToId?: string };

const settingsSchema = {
  goal: z.string().max(500).optional().describe("What the group is for: the outcome every agent works toward ('' to clear)"),
  owner: z.string().max(120).optional().describe("The agent that owns the next step: it answers what nobody else picks up ('' to clear)"),
  reply_mode: z.enum(["mentions", "intent"]).optional().describe("mentions: agents answer @mentions, replies and commands only; intent: also what is clearly for them"),
  reply_order: z.enum(["parallel", "sequential"]).optional().describe("Several agents answer at once (parallel) or one after the other"),
  agent_to_agent: z.boolean().optional().describe("Agents may answer each other's messages"),
  max_agent_hops: z.number().int().min(0).max(10).optional().describe("Agent turns one message can set off, at most (with agent_to_agent)"),
};
type SettingsArgs = { goal?: string; owner?: string; reply_mode?: string; reply_order?: string; agent_to_agent?: boolean; max_agent_hops?: number };

function settingsBody(a: SettingsArgs): RoomSettings | undefined {
  const s: RoomSettings = {
    ...(a.goal !== undefined ? { goal: a.goal } : {}), ...(a.owner !== undefined ? { owner: a.owner } : {}),
    ...(a.reply_mode !== undefined ? { replyMode: a.reply_mode } : {}), ...(a.reply_order !== undefined ? { replyOrder: a.reply_order } : {}),
    ...(a.agent_to_agent !== undefined ? { agentToAgent: a.agent_to_agent } : {}), ...(a.max_agent_hops !== undefined ? { maxAgentHops: a.max_agent_hops } : {}),
  };
  return Object.keys(s).length ? s : undefined;
}

export const roomItem = z.object({
  id: z.string(), kind: z.string(), title: z.string(), agents: z.array(z.string()),
  goal: z.string().optional(), owner: z.string().optional(), updatedAt: z.string().optional(),
}).passthrough();
const messageItem = z.object({
  id: z.string(), ts: z.string(), author: z.string(), author_kind: z.string(), text: z.string(),
  reply_to_id: z.string().optional(), addressed_to: z.array(z.string()).optional(),
});

const roomView = (r: Room) => ({ ...r, ...(r.settings?.goal ? { goal: r.settings.goal } : {}), ...(r.settings?.owner ? { owner: r.settings.owner } : {}) });
const messageView = (m: RoomMessage) => ({
  id: m.id, ts: m.ts, author: m.authorName || m.authorId, author_kind: m.authorKind, text: m.text,
  ...(m.replyToId ? { reply_to_id: m.replyToId } : {}), ...(m.addressedTo?.length ? { addressed_to: m.addressedTo } : {}),
});
const messageLine = (m: ReturnType<typeof messageView>) => `- [${m.id}] ${m.ts.slice(0, 16).replace("T", " ")} ${m.author}${m.author_kind === "agent" ? " (agent)" : ""}: ${short(m.text, 400)}`;
const roomLine = (r: Room) => `- ${r.id} "${r.title}" (${r.kind}) agents: ${r.agents.join(", ") || "none"}${r.settings?.goal ? ` · goal: ${short(r.settings.goal, 80)}` : ""}`;

const notFound = (id: string) => fail(`There is no room ${id}. Find the id with polpo_rooms_list.`);

async function loadRoom(deps: McpDeps, id: string): Promise<{ ok: true; room: Room } | { ok: false; status: number; error: string }> {
  const r = await apiGet(deps, `/rooms/${enc(id)}`);
  return r.ok ? { ok: true, room: r.data as Room } : r;
}

/** The agents answering in a room right now. */
async function typingIn(deps: McpDeps, id: string): Promise<string[]> {
  const t = await apiGet(deps, `/rooms/${enc(id)}/typing`);
  return t.ok && Array.isArray(t.data) ? (t.data as Array<string | { agent?: string; name?: string }>).map((x) => typeof x === "string" ? x : x.agent ?? x.name ?? "?") : [];
}

async function loadMessages(deps: McpDeps, id: string) {
  const r = await apiGet(deps, `/rooms/${enc(id)}/messages?limit=${MAX_TRANSCRIPT}`);
  return r.ok ? { ok: true as const, messages: ((r.data as RoomMessage[]) ?? []) } : r;
}

export function registerRoomTools(tool: Register, deps: McpDeps): void {
  tool("rooms", "polpo_rooms_list", {
    title: "List rooms",
    description: "The rooms (group chats of people and agents), newest first: id, title, agents, goal. Web rooms are written here; "
      + "Telegram groups are read-only. With id, one room in full: its agents, goal, owner, reply settings and who is answering right now. "
      + "Read its messages with polpo_room_messages.",
    inputSchema: {
      id: z.string().optional().describe("One room (its id), in full"),
      kind: z.enum(["web", "telegram"]).optional().describe("Only web rooms or Telegram groups"),
      text: z.string().optional().describe("Words in the title"),
      limit: limitParam(30, 100),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(roomItem), typing: z.array(z.string()).optional().describe("With id: the agents answering right now") },
    annotations: READ,
  }, async ({ id, kind, text, limit, cursor }) => {
    if (id) {
      const r = await loadRoom(deps, id);
      if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Reading room ${id}`);
      const typing = await typingIn(deps, id);
      const room = r.room;
      const s = room.settings ?? {};
      return ok([
        `${room.id} "${room.title}" (${room.kind})`,
        `agents: ${room.agents.join(", ") || "none"}${s.owner ? ` · owner: ${s.owner}` : ""}`,
        ...(s.goal ? [`goal: ${s.goal}`] : []),
        `replies: ${s.replyMode ?? "mentions"}, ${s.replyOrder ?? "parallel"}${s.agentToAgent ? `, agents answer each other (up to ${s.maxAgentHops ?? 3} hops)` : ""}`,
        ...(typing.length ? [`answering now: ${typing.join(", ")}`] : []),
      ].join("\n"), { items: [roomView(room)], next_cursor: null, total: 1, typing });
    }
    const c = decodeCursor(cursor);
    if (!c) return fail(BAD_CURSOR);
    const r = await apiGet(deps, `/rooms${kind ? `?kind=${kind}` : ""}`);
    if (!r.ok) return apiError(r, "Listing rooms");
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = ((r.data as Room[]) ?? []).filter((x) => words.every((w) => x.title.toLowerCase().includes(w)));
    const n = limit ?? 30;
    const start = c.o ?? 0;
    const items = all.slice(start, start + n);
    const next = start + n < all.length ? encodeCursor({ o: start + n }) : null;
    return ok(`${items.map(roomLine).join("\n") || "No rooms."}${next ? `\n(more: cursor ${next})` : ""}`, { items: items.map(roomView), next_cursor: next, total: all.length });
  });

  tool("rooms", "polpo_room_create", {
    title: "Create a room",
    description: "Open a group chat with some agents (and the people who use the dashboard), with an optional goal and owner. "
      + "Then post in it with polpo_room_post.",
    inputSchema: {
      title: z.string().trim().min(1).max(120).describe("The room's title"),
      agents: z.array(z.string().min(1)).min(1).max(20).describe("The agents in it (polpo_agents_list; 'polpo' for Polpo itself)"),
      ...settingsSchema,
    },
    outputSchema: { room: roomItem },
    annotations: WRITE,
  }, async ({ title, agents, ...settings }) => {
    const s = settingsBody(settings);
    const r = await apiSend(deps, "POST", "/rooms", { title, agents, ...(s ? { settings: s } : {}) });
    if (!r.ok) return apiError(r, "Creating the room", /agent/i.test(r.error) ? "Check the names with polpo_agents_list." : undefined);
    const room = r.data as Room;
    return ok(`Created room ${room.id} "${room.title}" with ${room.agents.join(", ")}.`, { room: roomView(room) });
  });

  tool("rooms", "polpo_room_update", {
    title: "Update a room",
    description: "Rename a room, change its agents (the list replaces the old one), its goal, owner or reply settings. Only the fields given change. "
      + "Telegram groups keep their bots as agents.",
    inputSchema: {
      id: z.string().min(1).describe("The room's id"),
      title: z.string().trim().min(1).max(120).optional().describe("The new title"),
      agents: z.array(z.string().min(1)).min(1).max(20).optional().describe("The agents in it from now on"),
      ...settingsSchema,
    },
    outputSchema: { room: roomItem, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ id, title, agents, ...settings }) => {
    const before = await loadRoom(deps, id);
    if (!before.ok) return before.status === 404 ? notFound(id) : apiError(before, `Reading room ${id}`);
    const s = settingsBody(settings);
    if (title === undefined && !agents && !s) return fail("Nothing to change: give title, agents, goal, owner or a reply setting.");
    const r = await apiSend(deps, "PATCH", `/rooms/${enc(id)}`, { ...(title ? { title } : {}), ...(agents ? { agents } : {}), ...(s ? { settings: s } : {}) });
    if (!r.ok) return apiError(r, `Updating room ${id}`, /agent/i.test(r.error) ? "Check the names with polpo_agents_list." : undefined);
    const room = r.data as Room;
    const changed = [
      ...(title !== undefined && title !== before.room.title ? ["title"] : []),
      ...(agents && JSON.stringify(agents) !== JSON.stringify(before.room.agents) ? ["agents"] : []),
      ...Object.keys(s ?? {}).filter((k) => JSON.stringify((before.room.settings as Record<string, unknown>)[k]) !== JSON.stringify((room.settings as Record<string, unknown>)[k])),
    ];
    return ok(changed.length ? `Updated room ${id}: ${changed.join(", ")}.` : `Nothing changed on room ${id} (the values were the same).`, { room: roomView(room), changed });
  });

  tool("rooms", "polpo_room_delete", {
    title: "Delete a room",
    description: "Delete a web room and its whole transcript. It cannot be undone. Needs confirm: true after the person agreed.",
    inputSchema: { id: z.string().min(1).describe("The room's id"), confirm: confirmParam("delete the room and its messages") },
    outputSchema: { id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const r = await loadRoom(deps, id);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Reading room ${id}`);
    if (r.room.kind !== "web") return fail("A Telegram room goes with its group: it cannot be deleted here.");
    if (confirm !== true) return fail(`Deleting "${r.room.title}" removes its whole transcript: ask the person, then call again with confirm: true.`);
    const d = await apiSend(deps, "DELETE", `/rooms/${enc(id)}`);
    if (!d.ok) return apiError(d, `Deleting room ${id}`);
    return ok(`Deleted room ${id} "${r.room.title}".`, { id, deleted: true });
  });

  tool("rooms", "polpo_room_messages", {
    title: "Read a room",
    description: `A room's messages, oldest first within the page: the latest page first, then older ones with cursor (the last ${MAX_TRANSCRIPT} messages are reachable). `
      + "latest_id is what to pass to polpo_room_wait as after_id.",
    inputSchema: {
      id: z.string().min(1).describe("The room's id"),
      limit: limitParam(30, 200),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(messageItem), latest_id: z.string().nullable() },
    annotations: READ,
  }, async ({ id, limit, cursor }) => {
    const m = await loadMessages(deps, id);
    if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading room ${id}`);
    const p = pageBackwards(m.messages.map(messageView), limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    const latest = m.messages.at(-1)?.id ?? null;
    return ok(`${p.items.map(messageLine).join("\n") || "No messages yet."}${p.next_cursor ? `\n(older: cursor ${p.next_cursor})` : ""}`, { ...p, latest_id: latest });
  });

  tool("rooms", "polpo_room_post", {
    title: "Post in a room",
    description: "Write in a web room as yourself (the connected person). Agents answer as on the web: @name mentions call them in, "
      + "reply_to_id answers a message (replying to an agent's message calls that agent), and the room's reply mode decides the rest. "
      + "Returns the message id; follow the replies with polpo_room_wait (after_id = that id).",
    inputSchema: {
      id: z.string().min(1).describe("The room's id"),
      text: z.string().trim().min(1).max(20_000).describe("The message; @agent-name to address agents"),
      reply_to_id: z.string().max(100).optional().describe("The message this one replies to (polpo_room_messages)"),
    },
    outputSchema: { message: messageItem },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id, text, reply_to_id }) => {
    const r = await apiSend(deps, "POST", `/rooms/${enc(id)}/messages`, {
      text, name: (deps.principal?.actor ?? "mcp").slice(0, 80), ...(reply_to_id ? { replyToId: reply_to_id } : {}),
    });
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Posting in room ${id}`);
    const msg = messageView(r.data as RoomMessage);
    return ok(`Posted ${msg.id} in ${id}${msg.addressed_to?.length ? ` (to ${msg.addressed_to.join(", ")})` : ""}. Wait for replies with polpo_room_wait { id: "${id}", after_id: "${msg.id}" }.`, { message: msg });
  });

  tool("rooms", "polpo_room_wait", {
    title: "Wait for room messages",
    description: `Wait for new messages in a room after a given message (after_id: from polpo_room_post or latest_id of polpo_room_messages), `
      + `at most ${MAX_WAIT_SECONDS} s. By default it returns as soon as an agent has answered and nobody is still typing. Returns the new messages and the id to wait after next time.`,
    inputSchema: {
      id: z.string().min(1).describe("The room's id"),
      after_id: z.string().optional().describe("Only messages after this one; omit to wait for any new message from now"),
      until: z.enum(["agents_done", "any"]).optional().describe("agents_done (default): an agent answered and none is still typing; any: the first new message"),
      timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait at most (default 30, max ${MAX_WAIT_SECONDS})`),
    },
    outputSchema: { messages: z.array(messageItem), latest_id: z.string().nullable(), typing: z.array(z.string()), timed_out: z.boolean(), waited_seconds: z.number() },
    annotations: READ,
  }, async ({ id, after_id, until, timeout_seconds }, extra) => {
    const timeout = (timeout_seconds ?? 30) * 1000;
    const started = Date.now();
    const interval = deps.pollIntervalMs ?? 1000;
    let after = after_id;
    let seen = 0;
    for (;;) {
      const m = await loadMessages(deps, id);
      if (!m.ok) return m.status === 404 ? notFound(id) : apiError(m, `Reading room ${id}`);
      if (after === undefined) after = m.messages.at(-1)?.id ?? "";
      const idx = after ? m.messages.findIndex((x) => x.id === after) : -1;
      if (after && idx < 0) return fail(`Message ${after_id} is not among the latest ${MAX_TRANSCRIPT} of room ${id}: pass latest_id from polpo_room_messages.`);
      const fresh = m.messages.slice(idx + 1);
      const typing = await typingIn(deps, id);
      const waited = Math.round((Date.now() - started) / 100) / 10;
      if (fresh.length !== seen) { seen = fresh.length; await progress(extra, waited, timeout / 1000, `${fresh.length} new message(s)`); }
      const done = until === "any" ? fresh.length > 0 : fresh.some((x) => x.authorKind === "agent") && typing.length === 0;
      if (done || Date.now() - started >= timeout || extra.signal.aborted) {
        const messages = fresh.map(messageView);
        const latest = m.messages.at(-1)?.id ?? null;
        return ok(`${messages.map(messageLine).join("\n") || "No new messages."}${typing.length ? `\n(still answering: ${typing.join(", ")})` : ""}`
          + `${done ? "" : `\nNothing settled after ${waited} s: call polpo_room_wait again with after_id ${latest ?? after}.`}`,
          { messages, latest_id: latest, typing, timed_out: !done, waited_seconds: waited });
      }
      await sleep(Math.min(interval, Math.max(0, timeout - (Date.now() - started))), extra.signal);
    }
  });
}
