/**
 * A capped, per-key log of webhook deliveries kept as one JSON file per key under
 * .polpo/<dir>/<key>.json (newest first, the last `max` entries): per-instance diagnostics,
 * bounded and never queried across instances, so they live next to the instance's files whatever
 * its store (file, SQLite or Postgres) and need no table or migration.
 *
 * Shared by the computers' provider webhooks (computer-webhook-events.ts) and the WhatsApp
 * Business webhooks (notifications/whatsapp-business-service.ts). What a record holds, and how it
 * is redacted before it is added, is the caller's.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WebhookEventOutcome = "accepted" | "ignored" | "rejected" | "error";
export const WEBHOOK_EVENT_OUTCOMES: readonly WebhookEventOutcome[] = ["accepted", "ignored", "rejected", "error"];

/** What every record has. */
export interface WebhookEventBase {
  id: string;
  receivedAt: string;
  outcome: WebhookEventOutcome;
}

export interface WebhookEventPage<S> {
  events: S[];
  /** Pass as `cursor` for the next (older) page. */
  nextCursor?: string;
  /** Entries kept for this key (any outcome). */
  total: number;
  /** Entries kept per outcome. */
  counts: Record<WebhookEventOutcome, number>;
}

export const emptyOutcomeCounts = (): Record<WebhookEventOutcome, number> => ({ accepted: 0, ignored: 0, rejected: 0, error: 0 });

/**
 * The log. `summarize` turns a record into its list form (e.g. without payload and headers).
 */
export class CappedWebhookEventLog<R extends WebhookEventBase, S = R> {
  constructor(
    private readonly polpoDir: () => string,
    private readonly dirName: string,
    private readonly max: number,
    private readonly summarize: (r: R) => S,
  ) {}

  private dir(): string { return join(this.polpoDir(), this.dirName); }
  private file(key: string): string { return join(this.dir(), `${key.replace(/[^a-z0-9._-]/gi, "")}.json`); }

  /** Every kept entry, newest first. */
  all(key: string): R[] {
    try {
      const f = this.file(key);
      if (!existsSync(f)) return [];
      const d = JSON.parse(readFileSync(f, "utf8")) as { version?: number; events?: R[] };
      return Array.isArray(d?.events) ? d.events : [];
    } catch {
      return []; // a broken file starts over
    }
  }

  private write(key: string, events: R[]): void {
    mkdirSync(this.dir(), { recursive: true });
    const f = this.file(key);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, events: events.slice(0, this.max) }));
    renameSync(tmp, f);
  }

  /** Add an entry (the oldest beyond the cap are dropped). */
  add(key: string, record: R): void {
    this.write(key, [record, ...this.all(key)]);
  }

  /** Change an entry; false when it is no longer kept. */
  update(key: string, id: string, patch: Partial<R>): boolean {
    const events = this.all(key);
    const i = events.findIndex((e) => e.id === id);
    if (i < 0) return false;
    events[i] = { ...events[i]!, ...patch };
    this.write(key, events);
    return true;
  }

  get(key: string, id: string): R | undefined {
    return this.all(key).find((e) => e.id === id);
  }

  /** Entries kept per outcome, and in all. */
  counts(key: string): { total: number; counts: Record<WebhookEventOutcome, number> } {
    const all = this.all(key);
    const counts = emptyOutcomeCounts();
    for (const e of all) if (e.outcome in counts) counts[e.outcome]++;
    return { total: all.length, counts };
  }

  /** A page of summaries, newest first; `cursor`: the last id of the previous page. */
  list(key: string, o: { limit?: number; cursor?: string; outcomes?: readonly WebhookEventOutcome[] } = {}): WebhookEventPage<S> {
    const all = this.all(key);
    const counts = emptyOutcomeCounts();
    for (const e of all) if (e.outcome in counts) counts[e.outcome]++;
    const filtered = o.outcomes?.length ? all.filter((e) => o.outcomes!.includes(e.outcome)) : all;
    let start = 0;
    if (o.cursor) {
      const i = filtered.findIndex((e) => e.id === o.cursor);
      start = i < 0 ? filtered.length : i + 1;
    }
    const limit = Math.max(1, Math.min(o.limit ?? 50, this.max));
    const slice = filtered.slice(start, start + limit);
    const more = start + limit < filtered.length;
    return { events: slice.map(this.summarize), ...(more && slice.length ? { nextCursor: slice.at(-1)!.id } : {}), total: all.length, counts };
  }
}
