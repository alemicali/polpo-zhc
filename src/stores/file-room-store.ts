import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { NewRoomMessage, Room, RoomKind, RoomMessage, RoomStore } from "@polpo-ai/core";

type Stored = { room: Room; messages: RoomMessage[] };

/** A room keeps this many messages on disk; older ones go (the agents read the last few anyway). */
const KEEP_MESSAGES = 2_000;

/**
 * File-backed RoomStore: one JSON file per room in `.polpo/rooms/`. Operations are synchronous
 * read-modify-write, so they never interleave within the process.
 */
export class FileRoomStore implements RoomStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "rooms");
  }

  private file(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  private read(id: string): Stored | undefined {
    const path = this.file(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Stored;
    } catch {
      return undefined;
    }
  }

  private write(data: Stored): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    data.messages = data.messages.slice(-KEEP_MESSAGES);
    const path = this.file(data.room.id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, path);
  }

  async getRoom(id: string): Promise<Room | undefined> {
    return this.read(id)?.room;
  }

  async listRooms(kind?: RoomKind): Promise<Room[]> {
    if (!existsSync(this.dir)) return [];
    const rooms = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.read(decodeURIComponent(f.slice(0, -5)))?.room)
      .filter((r): r is Room => !!r && (!kind || r.kind === kind));
    return rooms.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async ensureRoom(room: Pick<Room, "id" | "kind" | "title"> & Partial<Pick<Room, "agents" | "settings">>): Promise<Room> {
    const existing = this.read(room.id);
    if (existing) return existing.room;
    const now = new Date().toISOString();
    const created: Room = { id: room.id, kind: room.kind, title: room.title, agents: room.agents ?? [], settings: room.settings ?? {}, createdAt: now, updatedAt: now };
    this.write({ room: created, messages: [] });
    return created;
  }

  async updateRoom(id: string, patch: Partial<Pick<Room, "title" | "agents" | "settings">>): Promise<Room | undefined> {
    const data = this.read(id);
    if (!data) return undefined;
    data.room = { ...data.room, ...patch, updatedAt: new Date().toISOString() };
    this.write(data);
    return data.room;
  }

  async deleteRoom(id: string): Promise<boolean> {
    const path = this.file(id);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  async addMessage(roomId: string, message: NewRoomMessage): Promise<RoomMessage> {
    const data = this.read(roomId);
    if (!data) throw new Error(`Room not found: ${roomId}`);
    if (message.externalId) {
      const seen = data.messages.find((m) => m.externalId === message.externalId);
      if (seen) {
        // a copy of the same channel message may add who it was addressed to (each bot knows its own)
        const extra = (message.addressedTo ?? []).filter((a) => !(seen.addressedTo ?? []).includes(a));
        if (extra.length > 0) {
          seen.addressedTo = [...(seen.addressedTo ?? []), ...extra];
          this.write(data);
        }
        return seen;
      }
    }
    const { ts, addressedTo, ...rest } = message;
    const stored: RoomMessage = {
      ...rest,
      ...(addressedTo?.length ? { addressedTo } : {}),
      id: nanoid(12),
      roomId,
      ts: ts ?? new Date().toISOString(),
    };
    data.messages.push(stored);
    data.room.updatedAt = stored.ts;
    this.write(data);
    return stored;
  }

  async getRecentMessages(roomId: string, limit: number): Promise<RoomMessage[]> {
    return (this.read(roomId)?.messages ?? []).slice(-limit);
  }

  async getMessagesAfter(roomId: string, messageId: string | undefined, limit: number): Promise<RoomMessage[]> {
    const messages = this.read(roomId)?.messages ?? [];
    const i = messageId ? messages.findIndex((m) => m.id === messageId) : -1;
    return i < 0 ? messages.slice(-limit) : messages.slice(i + 1, i + 1 + limit);
  }
}
