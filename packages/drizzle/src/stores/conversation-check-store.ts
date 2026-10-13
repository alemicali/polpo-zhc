import { and, asc, desc, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ConversationCheck, ConversationCheckStore, NewConversationCheck } from "@polpo-ai/core/conversation-checks";
import { deserializeJson, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** Recurring chat checks: the whole check is the `doc`; session, state and next run are copied for lookups. */
export class DrizzleConversationCheckStore implements ConversationCheckStore {
  constructor(private db: any, private table: AnyTable, private dialect: Dialect) {}

  async createCheck(input: NewConversationCheck): Promise<ConversationCheck> {
    const now = new Date();
    const { firstRunAt, proposed, ...fields } = input;
    const check: ConversationCheck = {
      ...fields,
      id: `chk_${nanoid(12)}`,
      state: proposed ? "proposed" : "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: firstRunAt ?? new Date(now.getTime() + input.everyMinutes * 60_000).toISOString(),
      runs: 0,
    };
    await this.db.insert(this.table).values(this.toRow(check));
    return check;
  }

  async getCheck(id: string): Promise<ConversationCheck | undefined> {
    const rows: any[] = await this.db.select().from(this.table).where(eq(this.table.id, id));
    return rows[0] ? this.toCheck(rows[0]) : undefined;
  }

  async listChecks(filter: Parameters<ConversationCheckStore["listChecks"]>[0] = {}): Promise<ConversationCheck[]> {
    const rows: any[] = filter.sessionId
      ? await this.db.select().from(this.table).where(eq(this.table.sessionId, filter.sessionId)).orderBy(desc(this.table.createdAt))
      : await this.db.select().from(this.table).orderBy(desc(this.table.createdAt));
    return rows.map((r) => this.toCheck(r)).filter((c) => (filter.agent === undefined || c.agent === filter.agent)
      && (!filter.states || filter.states.includes(c.state)));
  }

  async dueChecks(now: string): Promise<ConversationCheck[]> {
    const rows: any[] = await this.db.select().from(this.table)
      .where(and(eq(this.table.state, "active"), lte(this.table.nextRunAt, now)))
      .orderBy(asc(this.table.nextRunAt));
    return rows.map((r) => this.toCheck(r));
  }

  async updateCheck(id: string, patch: Partial<Omit<ConversationCheck, "id" | "createdAt">>): Promise<ConversationCheck | undefined> {
    const current = await this.getCheck(id);
    if (!current) return undefined;
    const next: ConversationCheck = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    await this.db.update(this.table).set(this.toRow(next)).where(eq(this.table.id, id));
    return next;
  }

  private toRow(check: ConversationCheck) {
    return {
      id: check.id,
      sessionId: check.sessionId,
      state: check.state,
      nextRunAt: check.nextRunAt,
      doc: serializeJson(check, this.dialect),
      createdAt: check.createdAt,
      updatedAt: check.updatedAt,
    };
  }

  private toCheck(row: any): ConversationCheck {
    return deserializeJson<ConversationCheck>(row.doc, { id: row.id } as ConversationCheck, this.dialect);
  }
}
