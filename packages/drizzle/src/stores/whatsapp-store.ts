import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  whatsappJidToPhone,
  type WhatsAppChat,
  type WhatsAppContact,
  type WhatsAppMessage,
  type WhatsAppMessageStore,
} from "@polpo-ai/core/whatsapp-store";
import { affectedRows, type Dialect } from "../utils.js";

type AnyTable = any;

export class DrizzleWhatsAppStore implements WhatsAppMessageStore {
  constructor(
    private db: any,
    private tables: { messages: AnyTable; contacts: AnyTable },
    private dialect: Dialect,
  ) {}

  /** Case-insensitive substring match (SQLite LIKE already is; PostgreSQL needs ILIKE). */
  private contains(column: any, query: string): SQL {
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.dialect === "pg" ? sql`${column} ILIKE ${pattern} ESCAPE '\\'` : sql`${column} LIKE ${pattern} ESCAPE '\\'`;
  }

  // ── Messages ─────────────────────────────────────────────────────────

  async appendMessage(msg: WhatsAppMessage): Promise<void> {
    const m = this.tables.messages;
    const excluded = (column: string) => sql.raw(`excluded."${column}"`);
    // Keep what we already know unless the new copy brings it.
    const keep = (column: string) => sql`COALESCE(${excluded(column)}, ${sql.raw(`"whatsapp_messages"."${column}"`)})`;
    await this.db.insert(m).values({
      id: msg.id,
      chatJid: msg.chatJid,
      senderJid: msg.senderJid,
      senderName: msg.senderName ?? null,
      text: msg.text,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      mediaType: msg.mediaType ?? null,
      mediaPath: msg.mediaPath ?? null,
      mimeType: msg.mimeType ?? null,
      fileName: msg.fileName ?? null,
      mediaSize: msg.mediaSize ?? null,
      readAt: msg.readAt ?? null,
    }).onConflictDoUpdate({
      target: m.id,
      set: {
        senderName: keep("sender_name"),
        // A placeholder ("[image]") is replaced by the real text once it arrives.
        text: sql`CASE WHEN ${m.text} LIKE '[%' AND ${excluded("text")} NOT LIKE '[%' THEN ${excluded("text")} ELSE ${m.text} END`,
        mediaType: keep("media_type"),
        mediaPath: keep("media_path"),
        mimeType: keep("mime_type"),
        fileName: keep("file_name"),
        mediaSize: keep("media_size"),
        readAt: keep("read_at"),
      },
    });
  }

  async listMessages(chatJid: string, limit = 50, before?: number): Promise<WhatsAppMessage[]> {
    const m = this.tables.messages;
    const where = before ? and(eq(m.chatJid, chatJid), lt(m.timestamp, before)) : eq(m.chatJid, chatJid);
    const rows: any[] = await this.db.select().from(m).where(where).orderBy(desc(m.timestamp)).limit(limit);
    return rows.map(toMessage);
  }

  async searchMessages(query: string, limit = 30, chatJid?: string): Promise<WhatsAppMessage[]> {
    const m = this.tables.messages;
    const match = this.contains(m.text, query);
    const rows: any[] = await this.db.select().from(m)
      .where(chatJid ? and(eq(m.chatJid, chatJid), match) : match)
      .orderBy(desc(m.timestamp)).limit(limit);
    return rows.map(toMessage);
  }

  async listChats(limit = 30): Promise<WhatsAppChat[]> {
    const m = this.tables.messages;
    const c = this.tables.contacts;
    const unread = this.dialect === "pg"
      ? sql<number>`COUNT(*) FILTER (WHERE ${m.fromMe} = false AND ${m.readAt} IS NULL)`
      : sql<number>`SUM(CASE WHEN ${m.fromMe} = 0 AND ${m.readAt} IS NULL THEN 1 ELSE 0 END)`;
    // One pass over the messages for counts, then the last text of only the chats returned.
    const chats: any[] = await this.db.select({
      jid: m.chatJid,
      lastTs: sql<number>`MAX(${m.timestamp})`,
      count: sql<number>`COUNT(*)`,
      unread,
    }).from(m).groupBy(m.chatJid).orderBy(sql`MAX(${m.timestamp}) DESC`).limit(limit);
    if (chats.length === 0) return [];
    const jids = chats.map((chat) => chat.jid);
    const [contacts, lastMessages] = await Promise.all([
      this.db.select().from(c).where(inArray(c.jid, jids)) as Promise<any[]>,
      this.db.select({ chatJid: m.chatJid, text: m.text, timestamp: m.timestamp }).from(m)
        .where(and(inArray(m.chatJid, jids), sql`(${m.chatJid}, ${m.timestamp}) IN (SELECT ${m.chatJid}, MAX(${m.timestamp}) FROM ${m} WHERE ${inArray(m.chatJid, jids)} GROUP BY ${m.chatJid})`)) as Promise<any[]>,
    ]);
    const nameOf = new Map(contacts.map((contact) => [contact.jid, contact.name]));
    const lastOf = new Map(lastMessages.map((message) => [message.chatJid, message.text]));
    return chats.map((chat) => ({
      jid: chat.jid,
      name: nameOf.get(chat.jid) ?? undefined,
      phone: whatsappJidToPhone(chat.jid),
      isGroup: String(chat.jid).endsWith("@g.us"),
      lastMessage: lastOf.get(chat.jid) ?? undefined,
      lastMessageAt: chat.lastTs == null ? undefined : Number(chat.lastTs),
      messageCount: Number(chat.count ?? 0),
      unread: Number(chat.unread ?? 0),
    }));
  }

  // ── Contacts ─────────────────────────────────────────────────────────

  async upsertContact(jid: string, name: string, timestamp?: number): Promise<void> {
    const c = this.tables.contacts;
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const greatest = this.dialect === "pg" ? "GREATEST" : "MAX";
    await this.db.insert(c).values({ jid, name, phone: whatsappJidToPhone(jid), lastSeen: ts })
      .onConflictDoUpdate({
        target: c.jid,
        set: {
          name: sql`CASE WHEN excluded."last_seen" >= ${c.lastSeen} THEN excluded."name" ELSE ${c.name} END`,
          lastSeen: sql`${sql.raw(greatest)}(${c.lastSeen}, excluded."last_seen")`,
        },
      });
  }

  async listContacts(limit = 100): Promise<WhatsAppContact[]> {
    const c = this.tables.contacts;
    const rows: any[] = await this.db.select().from(c).orderBy(desc(c.lastSeen)).limit(limit);
    return rows.map(toContact);
  }

  async searchContacts(query: string, limit = 20): Promise<WhatsAppContact[]> {
    const c = this.tables.contacts;
    const rows: any[] = await this.db.select().from(c)
      .where(or(this.contains(c.name, query), this.contains(c.phone, query)))
      .orderBy(desc(c.lastSeen)).limit(limit);
    return rows.map(toContact);
  }

  async resolveContact(nameOrPhone: string): Promise<WhatsAppContact | undefined> {
    const c = this.tables.contacts;
    const clean = nameOrPhone.replace(/[+\s-]/g, "");
    const byPhone: any[] = await this.db.select().from(c).where(eq(c.phone, clean)).limit(1);
    if (byPhone[0]) return toContact(byPhone[0]);
    const byName: any[] = await this.db.select().from(c).where(this.contains(c.name, nameOrPhone)).limit(1);
    return byName[0] ? toContact(byName[0]) : undefined;
  }

  async markRead(ids: string[], readAt = Math.floor(Date.now() / 1000)): Promise<number> {
    if (ids.length === 0) return 0;
    const m = this.tables.messages;
    const result = await this.db.update(m).set({ readAt }).where(inArray(m.id, ids));
    return affectedRows(result);
  }

  async messageCount(): Promise<number> {
    const rows: any[] = await this.db.select({ n: sql<number>`COUNT(*)` }).from(this.tables.messages);
    return Number(rows[0]?.n ?? 0);
  }

  close(): void {
    // The connection belongs to the storage, not to this store.
  }
}

function toMessage(r: any): WhatsAppMessage {
  return {
    id: r.id,
    chatJid: r.chatJid,
    senderJid: r.senderJid,
    senderName: r.senderName ?? undefined,
    text: r.text,
    fromMe: !!r.fromMe,
    timestamp: Number(r.timestamp),
    mediaType: r.mediaType ?? undefined,
    mediaPath: r.mediaPath ?? undefined,
    mimeType: r.mimeType ?? undefined,
    fileName: r.fileName ?? undefined,
    mediaSize: r.mediaSize == null ? undefined : Number(r.mediaSize),
    readAt: r.readAt == null ? undefined : Number(r.readAt),
  };
}

function toContact(r: any): WhatsAppContact {
  return { jid: r.jid, name: r.name, phone: r.phone, lastSeen: Number(r.lastSeen) };
}
