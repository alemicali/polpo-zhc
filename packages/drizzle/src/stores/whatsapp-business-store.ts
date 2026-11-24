import { and, desc, eq, inArray, lt, gte, ne, notInArray, sql } from "drizzle-orm";
import type {
  WaBizContact, WaBizMessage, WaBizMessageQuery, WaBusinessStore,
} from "@polpo-ai/core/whatsapp-business";
import { affectedRows, deserializeJson, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** WhatsApp Business contacts, messages and processed webhook keys (see schema/whatsapp-business.ts). */
export class DrizzleWaBusinessStore implements WaBusinessStore {
  constructor(
    private db: any,
    private t: { contacts: AnyTable; messages: AnyTable; processed: AnyTable },
    private dialect: Dialect,
  ) {}

  private contactId(channel: string, waId: string) { return `${channel}:${waId}`; }

  async getContact(channel: string, waId: string): Promise<WaBizContact | undefined> {
    const rows: any[] = await this.db.select().from(this.t.contacts).where(eq(this.t.contacts.id, this.contactId(channel, waId)));
    return rows[0] ? deserializeJson<WaBizContact>(rows[0].doc, undefined as unknown as WaBizContact, this.dialect) : undefined;
  }

  async saveContact(c: WaBizContact): Promise<void> {
    const row = {
      id: this.contactId(c.channel, c.waId), channel: c.channel, waId: c.waId,
      doc: serializeJson(c, this.dialect), activityAt: c.lastInboundAt ?? c.updatedAt,
    };
    await this.db.insert(this.t.contacts).values(row)
      .onConflictDoUpdate({ target: this.t.contacts.id, set: { doc: row.doc, activityAt: row.activityAt } });
  }

  async listContacts(channel: string, o: { limit?: number } = {}): Promise<WaBizContact[]> {
    const rows: any[] = await this.db.select().from(this.t.contacts).where(eq(this.t.contacts.channel, channel))
      .orderBy(desc(this.t.contacts.activityAt)).limit(o.limit ?? 100);
    return rows.map((r) => deserializeJson<WaBizContact>(r.doc, undefined as unknown as WaBizContact, this.dialect)).filter(Boolean);
  }

  async deleteContact(channel: string, waId: string): Promise<boolean> {
    const had = !!(await this.getContact(channel, waId));
    const msgs: any[] = await this.db.select({ id: this.t.messages.id }).from(this.t.messages)
      .where(and(eq(this.t.messages.channel, channel), eq(this.t.messages.waId, waId)));
    await this.db.delete(this.t.contacts).where(eq(this.t.contacts.id, this.contactId(channel, waId)));
    await this.db.delete(this.t.messages).where(and(eq(this.t.messages.channel, channel), eq(this.t.messages.waId, waId)));
    return had || msgs.length > 0;
  }

  async getMessage(id: string): Promise<WaBizMessage | undefined> {
    const rows: any[] = await this.db.select().from(this.t.messages).where(eq(this.t.messages.id, id));
    return rows[0] ? deserializeJson<WaBizMessage>(rows[0].doc, undefined as unknown as WaBizMessage, this.dialect) : undefined;
  }

  async saveMessage(m: WaBizMessage): Promise<void> {
    const row = {
      id: m.id, channel: m.channel, waId: m.waId, direction: m.direction, initiated: m.initiated ?? null, sentBy: m.sentBy ?? null,
      status: m.status, doc: serializeJson(m, this.dialect), createdAt: m.createdAt,
    };
    await this.db.insert(this.t.messages).values(row).onConflictDoUpdate({
      target: this.t.messages.id,
      set: { status: row.status, doc: row.doc, initiated: row.initiated, sentBy: row.sentBy, waId: row.waId },
    });
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.delete(this.t.messages).where(eq(this.t.messages.id, id));
  }

  async listMessages(channel: string, q: WaBizMessageQuery = {}): Promise<WaBizMessage[]> {
    const m = this.t.messages;
    const where = [eq(m.channel, channel)];
    if (q.waId) where.push(eq(m.waId, q.waId));
    if (q.status) where.push(eq(m.status, q.status));
    if (q.direction) where.push(eq(m.direction, q.direction));
    if (q.before) where.push(lt(m.createdAt, q.before));
    const rows: any[] = await this.db.select().from(m).where(and(...where)).orderBy(desc(m.createdAt)).limit(q.limit ?? 50);
    return rows.map((r) => deserializeJson<WaBizMessage>(r.doc, undefined as unknown as WaBizMessage, this.dialect)).filter(Boolean);
  }

  async countBusinessInitiated(channel: string, sinceIso: string, sentBy?: string): Promise<number> {
    const m = this.t.messages;
    const where = [
      eq(m.channel, channel), eq(m.direction, "out"), eq(m.initiated, "business"), gte(m.createdAt, sinceIso),
      notInArray(m.status, ["pending_approval", "rejected"]),
    ];
    if (sentBy) where.push(eq(m.sentBy, sentBy));
    const rows: any[] = await this.db.select({ n: sql<number>`count(*)` }).from(m).where(and(...where));
    return Number(rows[0]?.n ?? 0);
  }

  async markProcessed(key: string, atIso = new Date().toISOString()): Promise<boolean> {
    const res = await this.db.insert(this.t.processed).values({ key, createdAt: atIso }).onConflictDoNothing({ target: this.t.processed.key });
    return affectedRows(res) > 0;
  }

  async isProcessed(key: string): Promise<boolean> {
    const rows: any[] = await this.db.select({ key: this.t.processed.key }).from(this.t.processed).where(eq(this.t.processed.key, key));
    return rows.length > 0;
  }

  async purge(channel: string, beforeIso: string): Promise<{ messages: number; contacts: number }> {
    const m = this.t.messages;
    const old: any[] = await this.db.select({ id: m.id }).from(m)
      .where(and(eq(m.channel, channel), lt(m.createdAt, beforeIso), ne(m.status, "pending_approval")));
    if (old.length) await this.db.delete(m).where(inArray(m.id, old.map((r) => r.id)));
    const c = this.t.contacts;
    const stale: any[] = await this.db.select().from(c).where(and(eq(c.channel, channel), lt(c.activityAt, beforeIso)));
    // an opt-out is kept (it must keep blocking), whatever its age
    const drop = stale.filter((r) => !deserializeJson<WaBizContact | undefined>(r.doc, undefined, this.dialect)?.optOut).map((r) => r.id);
    if (drop.length) await this.db.delete(c).where(inArray(c.id, drop));
    return { messages: old.length, contacts: drop.length };
  }

  async purgeProcessed(beforeIso: string): Promise<number> {
    const p = this.t.processed;
    const old: any[] = await this.db.select({ key: p.key }).from(p).where(lt(p.createdAt, beforeIso));
    if (old.length) await this.db.delete(p).where(inArray(p.key, old.map((r) => r.key)));
    return old.length;
  }
}
