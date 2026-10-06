/**
 * Rooms REST API — group chats of people and agents.
 *
 *   GET    /rooms?kind=web|telegram      the rooms, newest first
 *   POST   /rooms                        a new web room { title, agents, settings? }
 *   GET    /rooms/:id                    one room (ids contain ":", URL-encoded)
 *   PATCH  /rooms/:id                    rename, change agents or settings
 *   DELETE /rooms/:id                    a web room and its transcript
 *   GET    /rooms/:id/messages?limit=    the transcript, oldest first
 *   POST   /rooms/:id/messages           a person writes { text, name? }: the agents answer in
 *                                        the background (room:message / room:typing events)
 *   GET    /rooms/:id/typing             the agents answering right now
 *
 * Telegram rooms are read-only here: their messages come from the groups.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { Room, RoomStore } from "@polpo-ai/core";
import { POLPO, ROOM_DEFAULTS, newRoomId, type RoomEngine } from "../../rooms/room-engine.js";

const SettingsSchema = z.object({
  replyMode: z.enum(["mentions", "intent"]).optional(),
  intentThreshold: z.number().min(0).max(1).optional(),
  replyOrder: z.enum(["parallel", "sequential"]).optional(),
  agentToAgent: z.boolean().optional(),
  maxAgentHops: z.number().int().min(0).max(10).optional(),
}).strict();

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  agents: z.array(z.string().min(1)).min(1).max(20),
  settings: SettingsSchema.optional(),
}).strict();

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  agents: z.array(z.string().min(1)).min(1).max(20).optional(),
  settings: SettingsSchema.optional(),
}).strict();

const PostSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  name: z.string().trim().min(1).max(80).optional(),
}).strict();

export interface RoomRoutesDeps {
  rooms: RoomStore;
  engine: RoomEngine;
  /** Agent names that exist (a room may only hold those, and "polpo"). */
  agentNames: () => Promise<string[]>;
  emit: (event: "room:created" | "room:updated", payload: { room: Room }) => void;
  emitDeleted: (roomId: string) => void;
}

export function roomRoutes(getDeps: () => RoomRoutesDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const fail = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);

  const unknownAgents = async (agents: string[]) => {
    const known = new Set([...(await getDeps().agentNames()), POLPO]);
    return agents.filter((a) => !known.has(a));
  };

  app.get("/", async (c) => {
    const kind = c.req.query("kind");
    const rooms = await getDeps().rooms.listRooms(kind === "web" || kind === "telegram" ? kind : undefined);
    return c.json({ ok: true, data: rooms });
  });

  app.post("/", async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, parsed.error.issues[0]?.message ?? "Invalid room");
    const unknown = await unknownAgents(parsed.data.agents);
    if (unknown.length) return fail(c, 400, `Unknown agents: ${unknown.join(", ")}`);
    const room = await getDeps().rooms.ensureRoom({
      id: newRoomId(),
      kind: "web",
      title: parsed.data.title,
      agents: [...new Set(parsed.data.agents)],
      settings: { ...ROOM_DEFAULTS, ...parsed.data.settings },
    });
    getDeps().emit("room:created", { room });
    return c.json({ ok: true, data: room }, 201);
  });

  app.get("/:id", async (c) => {
    const room = await getDeps().rooms.getRoom(c.req.param("id"));
    return room ? c.json({ ok: true, data: room }) : fail(c, 404, "Room not found");
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const room = await getDeps().rooms.getRoom(id);
    if (!room) return fail(c, 404, "Room not found");
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, parsed.error.issues[0]?.message ?? "Invalid change");
    if (parsed.data.agents) {
      if (room.kind !== "web") return fail(c, 400, "The agents of a Telegram room are its bots");
      const unknown = await unknownAgents(parsed.data.agents);
      if (unknown.length) return fail(c, 400, `Unknown agents: ${unknown.join(", ")}`);
    }
    const updated = await getDeps().rooms.updateRoom(id, {
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
      ...(parsed.data.agents ? { agents: [...new Set(parsed.data.agents)] } : {}),
      ...(parsed.data.settings ? { settings: { ...room.settings, ...parsed.data.settings } } : {}),
    });
    if (updated) getDeps().emit("room:updated", { room: updated });
    return c.json({ ok: true, data: updated });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const room = await getDeps().rooms.getRoom(id);
    if (!room) return fail(c, 404, "Room not found");
    if (room.kind !== "web") return fail(c, 400, "A Telegram room goes with its group");
    await getDeps().rooms.deleteRoom(id);
    getDeps().emitDeleted(id);
    return c.json({ ok: true, data: { deleted: true } });
  });

  app.get("/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!await getDeps().rooms.getRoom(id)) return fail(c, 404, "Room not found");
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    return c.json({ ok: true, data: await getDeps().rooms.getRecentMessages(id, limit) });
  });

  app.post("/:id/messages", async (c) => {
    const id = c.req.param("id");
    const room = await getDeps().rooms.getRoom(id);
    if (!room) return fail(c, 404, "Room not found");
    if (room.kind !== "web") return fail(c, 400, "Telegram rooms are written from Telegram");
    const parsed = PostSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return fail(c, 400, parsed.error.issues[0]?.message ?? "Invalid message");
    const message = await getDeps().engine.post(id, { id: "web:user", name: parsed.data.name ?? "You" }, parsed.data.text);
    return c.json({ ok: true, data: message }, 201);
  });

  app.get("/:id/typing", async (c) => {
    return c.json({ ok: true, data: getDeps().engine.typingIn(c.req.param("id")) });
  });

  return app;
}
