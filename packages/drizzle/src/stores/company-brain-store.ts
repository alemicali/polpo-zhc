import { and, eq, inArray, sql } from "drizzle-orm";
import {
  BRAIN_MAX_ACTIVITY,
  BRAIN_MAX_RUNS,
  type BrainChangeEmitter,
  type BrainChangeEvent,
  type CompanyBrainSnapshot,
  type CompanyBrainStore,
} from "@polpo-ai/core/company-brain";
import { deserializeJson, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** Snapshot array ↔ row kind. Kinds listed newest-first keep the newest item at index 0. */
const KINDS = [
  ["entities", "entity", "asc"],
  ["relations", "relation", "asc"],
  ["claims", "claim", "asc"],
  ["grants", "grant", "asc"],
  ["runs", "run", "desc"],
  ["activity", "activity", "desc"],
] as const;

type Key = (typeof KINDS)[number][0];
type Row = { kind: string; id: string; seq: number; doc: unknown };

/**
 * One row per brain item. A transaction loads the snapshot, applies the change to a copy and
 * writes only what changed (new, edited, removed items), keeping array order through `seq`.
 * Transactions are serialized within the process and, on PostgreSQL, across processes.
 */
export class DrizzleCompanyBrainStore implements CompanyBrainStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private db: any,
    private items: AnyTable,
    private dialect: Dialect,
    private emitChange?: BrainChangeEmitter,
  ) {}

  setEmitter(emitChange?: BrainChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  emit(event: Omit<BrainChangeEvent, "timestamp">): void {
    this.emitChange?.({ ...event, timestamp: new Date().toISOString() });
  }

  async snapshot(): Promise<CompanyBrainSnapshot> {
    return this.toSnapshot(await this.db.select().from(this.items));
  }

  async transaction<T>(change: (snapshot: CompanyBrainSnapshot) => T | Promise<T>): Promise<T> {
    const run = this.writeQueue.then(() =>
      this.dialect === "pg" ? this.transactionPg(change) : this.transactionSqlite(change),
    );
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async transactionPg<T>(change: (snapshot: CompanyBrainSnapshot) => T | Promise<T>): Promise<T> {
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('polpo:company-brain'))`);
      const rows: Row[] = await tx.select().from(this.items);
      const { result, writes } = await this.apply(rows, change);
      for (const write of writes) await write(tx);
      return result;
    });
  }

  private async transactionSqlite<T>(change: (snapshot: CompanyBrainSnapshot) => T | Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous: compute the change first, then write at once.
    const rows: Row[] = await this.db.select().from(this.items);
    const { result, writes } = await this.apply(rows, change);
    this.db.transaction((tx: any) => {
      for (const write of writes) write(tx).run();
    });
    return result;
  }

  private async apply<T>(rows: Row[], change: (snapshot: CompanyBrainSnapshot) => T | Promise<T>) {
    const before = this.toSnapshot(rows);
    const snapshot = structuredClone(before);
    const result = await change(snapshot);
    snapshot.runs = snapshot.runs.slice(0, BRAIN_MAX_RUNS);
    snapshot.activity = snapshot.activity.slice(0, BRAIN_MAX_ACTIVITY);

    const stored = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
    const writes: Array<(tx: any) => any> = [];
    for (const [key, kind, order] of KINDS) {
      const items = (snapshot[key as Key] as Array<{ id: string }>).filter((item) => item && typeof item.id === "string");
      const seen = new Set<string>();
      let maxSeq = rows.filter((r) => r.kind === kind).reduce((max, r) => Math.max(max, r.seq), 0);
      // Newest-first kinds: new items sit at the front, so number them from the back.
      const ordered = order === "desc" ? [...items].reverse() : items;
      for (const item of ordered) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const current = stored.get(`${kind}:${item.id}`);
        if (!current) {
          const seq = ++maxSeq;
          const doc = serializeJson(item, this.dialect);
          writes.push((tx) => tx.insert(this.items).values({ kind, id: item.id, seq, doc }));
        } else if (JSON.stringify(deserializeJson(current.doc, null, this.dialect)) !== JSON.stringify(item)) {
          const doc = serializeJson(item, this.dialect);
          writes.push((tx) => tx.update(this.items).set({ doc })
            .where(and(eq(this.items.kind, kind), eq(this.items.id, item.id))));
        }
      }
      const removed = rows.filter((r) => r.kind === kind && !seen.has(r.id)).map((r) => r.id);
      for (let i = 0; i < removed.length; i += 500) {
        const chunk = removed.slice(i, i + 500);
        writes.push((tx) => tx.delete(this.items).where(and(eq(this.items.kind, kind), inArray(this.items.id, chunk))));
      }
    }
    return { result, writes };
  }

  private toSnapshot(rows: Row[]): CompanyBrainSnapshot {
    const snapshot: CompanyBrainSnapshot = { version: 1, entities: [], relations: [], claims: [], grants: [], runs: [], activity: [] };
    for (const [key, kind, order] of KINDS) {
      const ofKind = rows.filter((r) => r.kind === kind).sort((a, b) => (order === "asc" ? a.seq - b.seq : b.seq - a.seq));
      (snapshot[key as Key] as unknown[]) = ofKind.map((r) => deserializeJson(r.doc, null, this.dialect)).filter(Boolean);
    }
    return snapshot;
  }
}
