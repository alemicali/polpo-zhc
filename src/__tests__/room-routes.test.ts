import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRoomStore } from "../stores/file-room-store.js";
import { roomRoutes } from "../server/routes/rooms.js";
import type { RoomEngine } from "../rooms/room-engine.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-room-routes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function api() {
  const rooms = new FileRoomStore(dir);
  const post = vi.fn(async (roomId: string, person: { id: string; name: string }, text: string) =>
    rooms.addMessage(roomId, { authorKind: "person", authorId: person.id, authorName: person.name, text }));
  const engine = { post, typingIn: vi.fn(() => [{ agent: "growth", name: "Giulia" }]) } as unknown as RoomEngine;
  const emit = vi.fn();
  const emitDeleted = vi.fn();
  const app = roomRoutes(() => ({ rooms, engine, agentNames: async () => ["growth", "ops"], emit, emitDeleted }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  return { rooms, post, emit, emitDeleted, call };
}

describe("rooms API", () => {
  it("creates a web room with the defaults, and only with agents that exist", async () => {
    const { call, emit } = api();
    expect((await call("POST", "/", { title: "Team", agents: ["growth", "nobody"] })).status).toBe(400);
    const created = await call("POST", "/", { title: "Team", agents: ["growth", "polpo", "growth"], settings: { replyOrder: "sequential" } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ kind: "web", title: "Team", agents: ["growth", "polpo"], settings: { replyMode: "intent", replyOrder: "sequential", agentToAgent: true, maxAgentHops: 3 } });
    expect(created.body.data.id).toMatch(/^web:/);
    expect(emit).toHaveBeenCalledWith("room:created", { room: created.body.data });
    const id = encodeURIComponent(created.body.data.id);
    expect((await call("GET", `/${id}`)).body.data.title).toBe("Team");
    expect((await call("GET", "/?kind=web")).body.data).toHaveLength(1);
  });

  it("a person writes; the engine takes it from there", async () => {
    const { call, post } = api();
    const room = (await call("POST", "/", { title: "Team", agents: ["growth"] })).body.data;
    const id = encodeURIComponent(room.id);
    const sent = await call("POST", `/${id}/messages`, { text: "@growth budget?", name: "Ada" });
    expect(sent.status).toBe(201);
    expect(post).toHaveBeenCalledWith(room.id, { id: "web:user", name: "Ada" }, "@growth budget?");
    expect((await call("GET", `/${id}/messages`)).body.data.map((m: any) => m.text)).toEqual(["@growth budget?"]);
    expect((await call("GET", `/${id}/typing`)).body.data).toEqual([{ agent: "growth", name: "Giulia" }]);
  });

  it("changes settings and agents of a web room; deletes it", async () => {
    const { call, emitDeleted } = api();
    const room = (await call("POST", "/", { title: "Team", agents: ["growth"] })).body.data;
    const id = encodeURIComponent(room.id);
    const patched = await call("PATCH", `/${id}`, { agents: ["growth", "ops"], settings: { agentToAgent: false } });
    expect(patched.body.data).toMatchObject({ agents: ["growth", "ops"], settings: { agentToAgent: false, replyMode: "intent" } });
    expect((await call("DELETE", `/${id}`)).body.data).toEqual({ deleted: true });
    expect(emitDeleted).toHaveBeenCalledWith(room.id);
    expect((await call("GET", `/${id}`)).status).toBe(404);
  });

  it("a Telegram room is read-only here", async () => {
    const { call, rooms } = api();
    await rooms.ensureRoom({ id: "telegram:group:-1", kind: "telegram", title: "Team" });
    const id = encodeURIComponent("telegram:group:-1");
    expect((await call("POST", `/${id}/messages`, { text: "hi" })).status).toBe(400);
    expect((await call("PATCH", `/${id}`, { agents: ["growth"] })).status).toBe(400);
    expect((await call("DELETE", `/${id}`)).status).toBe(400);
    expect((await call("PATCH", `/${id}`, { settings: { replyMode: "intent" } })).status).toBe(200);
  });
});
