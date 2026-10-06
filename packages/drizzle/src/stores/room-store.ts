import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { NewRoomMessage, Room, RoomKind, RoomMessage, RoomSettings, RoomStore } from "@polpo-ai/core/room-store";
import { type Dialect, pgSafe } from "../utils.js";

type AnyTable = any;

const parse = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

/** Rooms and their shared transcript (see RoomStore). */
export class DrizzleRoomStore implements RoomStore {
  constructor(
    private db: any,
    private rooms: AnyTable,
    private messages: AnyTable,
    private dialect: Dialect,
  ) {}

  private safe(text: string): string {
    return this.dialect === "pg" ? pgSafe(text) : text;
  }

  private toRoom(row: any): Room {
    return {
      id: row.id,
      kind: row.kind as RoomKind,
      title: row.title,
      agents: parse<string[]>(row.agents, []),
      settings: parse<RoomSettings>(row.settings, {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toMessage(row: any): RoomMessage {
    const addressedTo = parse<string[] | undefined>(row.addressedTo, undefined);
    return {
      id: row.id,
      roomId: row.roomId,
      ts: row.ts,
      authorKind: row.authorKind,
      authorId: row.authorId,
      authorName: row.authorName,
      text: row.text,
      ...(row.externalId ? { externalId: row.externalId } : {}),
      ...(addressedTo?.length ? { addressedTo } : {}),
      ...(row.replyToId ? { replyToId: row.replyToId } : {}),
    };
  }

  async getRoom(id: string): Promise<Room | undefined> {
    const rows: any[] = await this.db.select().from(this.rooms).where(eq(this.rooms.id, id));
    return rows[0] ? this.toRoom(rows[0]) : undefined;
  }

  async listRooms(kind?: RoomKind): Promise<Room[]> {
    const q = this.db.select().from(this.rooms);
    const rows: any[] = await (kind ? q.where(eq(this.rooms.kind, kind)) : q).orderBy(desc(this.rooms.updatedAt));
    return rows.map((r) => this.toRoom(r));
  }

  async ensureRoom(room: Pick<Room, "id" | "kind" | "title"> & Partial<Pick<Room, "agents" | "settings">>): Promise<Room> {
    const existing = await this.getRoom(room.id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const row = {
      id: room.id,
      kind: room.kind,
      title: this.safe(room.title),
      agents: JSON.stringify(room.agents ?? []),
      settings: JSON.stringify(room.settings ?? {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.db.insert(this.rooms).values(row);
    } catch {
      // created at the same moment by another bot of the group: read it back
      const again = await this.getRoom(room.id);
      if (again) return again;
      throw new Error(`Could not create room ${room.id}`);
    }
    return this.toRoom(row);
  }

  async updateRoom(id: string, patch: Partial<Pick<Room, "title" | "agents" | "settings">>): Promise<Room | undefined> {
    const current = await this.getRoom(id);
    if (!current) return undefined;
    await this.db.update(this.rooms).set({
      ...(patch.title !== undefined ? { title: this.safe(patch.title) } : {}),
      ...(patch.agents !== undefined ? { agents: JSON.stringify(patch.agents) } : {}),
      ...(patch.settings !== undefined ? { settings: JSON.stringify(patch.settings) } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(this.rooms.id, id));
    return this.getRoom(id);
  }

  async deleteRoom(id: string): Promise<boolean> {
    if (!await this.getRoom(id)) return false;
    await this.db.delete(this.messages).where(eq(this.messages.roomId, id));
    await this.db.delete(this.rooms).where(eq(this.rooms.id, id));
    return true;
  }

  private async byExternalId(roomId: string, externalId: string): Promise<RoomMessage | undefined> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(and(eq(this.messages.roomId, roomId), eq(this.messages.externalId, externalId)));
    return rows[0] ? this.toMessage(rows[0]) : undefined;
  }

  /** A copy of a stored channel message may add who it was addressed to (each bot knows its own). */
  private async merge(seen: RoomMessage, message: NewRoomMessage): Promise<RoomMessage> {
    const extra = (message.addressedTo ?? []).filter((a) => !(seen.addressedTo ?? []).includes(a));
    if (extra.length === 0) return seen;
    const addressedTo = [...(seen.addressedTo ?? []), ...extra];
    await this.db.update(this.messages).set({ addressedTo: JSON.stringify(addressedTo) }).where(eq(this.messages.id, seen.id));
    return { ...seen, addressedTo };
  }

  async addMessage(roomId: string, message: NewRoomMessage): Promise<RoomMessage> {
    if (message.externalId) {
      const seen = await this.byExternalId(roomId, message.externalId);
      if (seen) return this.merge(seen, message);
    }
    const last: any[] = await this.db.select({ seq: sql<number>`max(${this.messages.seq})` }).from(this.messages)
      .where(eq(this.messages.roomId, roomId));
    const seq = Number(last[0]?.seq ?? 0) + 1;
    const ts = message.ts ?? new Date().toISOString();
    const row = {
      id: nanoid(12),
      roomId,
      seq,
      ts,
      authorKind: message.authorKind,
      authorId: message.authorId,
      authorName: this.safe(message.authorName),
      text: this.safe(message.text),
      externalId: message.externalId ?? null,
      addressedTo: message.addressedTo?.length ? JSON.stringify(message.addressedTo) : null,
      replyToId: message.replyToId ?? null,
    };
    try {
      await this.db.insert(this.messages).values(row);
    } catch (err) {
      // the same channel message stored by another bot of the group a moment ago
      if (message.externalId) {
        const seen = await this.byExternalId(roomId, message.externalId);
        if (seen) return this.merge(seen, message);
      }
      throw err;
    }
    await this.db.update(this.rooms).set({ updatedAt: ts }).where(eq(this.rooms.id, roomId));
    return this.toMessage(row);
  }

  async getRecentMessages(roomId: string, limit: number): Promise<RoomMessage[]> {
    const rows: any[] = await this.db.select().from(this.messages)
      .where(eq(this.messages.roomId, roomId))
      .orderBy(desc(this.messages.seq), desc(this.messages.id))
      .limit(limit);
    return rows.reverse().map((r) => this.toMessage(r));
  }

  async getMessagesAfter(roomId: string, messageId: string | undefined, limit: number): Promise<RoomMessage[]> {
    if (!messageId) return this.getRecentMessages(roomId, limit);
    const anchor: any[] = await this.db.select().from(this.messages)
      .where(and(eq(this.messages.roomId, roomId), eq(this.messages.id, messageId)));
    if (!anchor[0]) return this.getRecentMessages(roomId, limit);
    const rows: any[] = await this.db.select().from(this.messages)
      // agents answering at once can share a seq: within one, the id breaks the tie
      .where(and(
        eq(this.messages.roomId, roomId),
        or(gt(this.messages.seq, anchor[0].seq), and(eq(this.messages.seq, anchor[0].seq), gt(this.messages.id, anchor[0].id))),
      ))
      .orderBy(asc(this.messages.seq), asc(this.messages.id))
      .limit(limit);
    return rows.map((r) => this.toMessage(r));
  }
}
