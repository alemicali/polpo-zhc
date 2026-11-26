/**
 * File store of triggers, one folder per trigger under `.polpo/triggers/<id>/`:
 *
 *   trigger.json            the definition (secrets as hashes only; the HMAC secret is in the vault)
 *   contracts.json          the contract's revisions (the newest TRIGGER_LIMITS.contractRevisionsKept)
 *   deliveries/index.json   the deliveries' summaries, newest first (the newest `retention` kept)
 *   deliveries/<id>.json    one delivery with its (capped, redacted) body, headers and mapped values
 *   dedupe.json             dedupe key hashes → the delivery that first carried them, until their TTL
 *   action-usage.json       today's (UTC) actions started and the agent actions' spend (the limits)
 *
 * Like the agent suites and the webhook event logs: per-instance files whatever the instance's
 * store (file, SQLite or Postgres), bounded, never queried across instances, no table or migration.
 * Writes go through a temporary file and a rename.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRIGGER_LIMITS, emptyStatusCounts,
  type Trigger, type TriggerContractRevision, type TriggerDelivery, type TriggerDeliveryPage, type TriggerDeliveryStatus,
  type TriggerDeliverySummary, type TriggerStats,
} from "./types.js";

const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
/** Ids are slugs; anything else never reaches the file system. */
export const isTriggerId = (id: string): boolean => ID.test(id);
const DELIVERY_ID = /^tdl_[a-z0-9]{6,40}$/;

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown, pretty = false): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  renameSync(tmp, path);
}

/** A trigger's action usage for one (UTC) day: actions started and what its agent actions spent. */
export interface TriggerActionUsage { day: string; actions: number; agentUsd: number }

export const summarizeDelivery = ({ body: _b, headers: _h, query: _q, files: _f, mapped: _m, previousActions: _p, actions, ...summary }: TriggerDelivery): TriggerDeliverySummary => ({
  ...summary,
  ...(actions ? { actions: actions.map(({ outputs: _o, ...run }) => run) } : {}),
});

export class FileTriggerStore {
  constructor(private readonly polpoDir: () => string) {}

  private root(): string { return join(this.polpoDir(), "triggers"); }
  private dir(id: string): string {
    if (!isTriggerId(id)) throw new Error(`Invalid trigger id "${id}"`);
    return join(this.root(), id);
  }
  private deliveriesDir(id: string): string { return join(this.dir(id), "deliveries"); }

  // ── Definitions ──

  list(): Trigger[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(isTriggerId)
      .map((id) => readJson<Trigger>(join(root, id, "trigger.json")))
      .filter((t): t is Trigger => !!t)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Trigger | undefined {
    if (!isTriggerId(id)) return undefined;
    return readJson<Trigger>(join(this.dir(id), "trigger.json"));
  }

  exists(id: string): boolean {
    return isTriggerId(id) && existsSync(join(this.dir(id), "trigger.json"));
  }

  save(trigger: Trigger): void {
    writeJson(join(this.dir(trigger.id), "trigger.json"), trigger, true);
  }

  delete(id: string): boolean {
    if (!this.exists(id)) return false;
    rmSync(this.dir(id), { recursive: true, force: true });
    return true;
  }

  // ── Contract revisions ──

  contractRevisions(id: string): TriggerContractRevision[] {
    if (!isTriggerId(id)) return [];
    return readJson<TriggerContractRevision[]>(join(this.dir(id), "contracts.json")) ?? [];
  }

  addContractRevision(id: string, revision: TriggerContractRevision): void {
    const all = [...this.contractRevisions(id), revision].slice(-TRIGGER_LIMITS.contractRevisionsKept);
    writeJson(join(this.dir(id), "contracts.json"), all, true);
  }

  // ── Deliveries ──

  private index(id: string): TriggerDeliverySummary[] {
    if (!isTriggerId(id)) return [];
    const d = readJson<{ deliveries?: TriggerDeliverySummary[] }>(join(this.deliveriesDir(id), "index.json"));
    return Array.isArray(d?.deliveries) ? d.deliveries : [];
  }

  private writeIndex(id: string, deliveries: TriggerDeliverySummary[]): void {
    writeJson(join(this.deliveriesDir(id), "index.json"), { version: 1, deliveries });
  }

  /** Record a delivery; the oldest beyond `retention` are pruned (their files too). */
  addDelivery(delivery: TriggerDelivery, retention: number): void {
    const dir = this.deliveriesDir(delivery.triggerId);
    writeJson(join(dir, `${delivery.id}.json`), delivery);
    const all = [summarizeDelivery(delivery), ...this.index(delivery.triggerId).filter((d) => d.id !== delivery.id)];
    const keep = Math.max(1, retention);
    for (const old of all.slice(keep)) rmSync(join(dir, `${old.id}.json`), { force: true });
    this.writeIndex(delivery.triggerId, all.slice(0, keep));
  }

  /** Change a recorded delivery (summary and file); false when it is no longer kept. */
  updateDelivery(triggerId: string, deliveryId: string, patch: Partial<TriggerDelivery>): boolean {
    const current = this.getDelivery(triggerId, deliveryId);
    if (!current) return false;
    const next = { ...current, ...patch };
    writeJson(join(this.deliveriesDir(triggerId), `${deliveryId}.json`), next);
    this.writeIndex(triggerId, this.index(triggerId).map((d) => (d.id === deliveryId ? summarizeDelivery(next) : d)));
    return true;
  }

  getDelivery(triggerId: string, deliveryId: string): TriggerDelivery | undefined {
    if (!isTriggerId(triggerId) || !DELIVERY_ID.test(deliveryId)) return undefined;
    return readJson<TriggerDelivery>(join(this.deliveriesDir(triggerId), `${deliveryId}.json`));
  }

  /** The newest delivery summary (rate-limit aggregation). */
  latestDelivery(triggerId: string): TriggerDeliverySummary | undefined {
    return this.index(triggerId)[0];
  }

  /** Prune to a new retention (when it is lowered). */
  prune(triggerId: string, retention: number): void {
    const all = this.index(triggerId);
    if (all.length <= retention) return;
    const dir = this.deliveriesDir(triggerId);
    for (const old of all.slice(retention)) rmSync(join(dir, `${old.id}.json`), { force: true });
    this.writeIndex(triggerId, all.slice(0, retention));
  }

  /** A page of summaries, newest first; `cursor`: the last id of the previous page. */
  listDeliveries(triggerId: string, o: { limit?: number; cursor?: string; statuses?: readonly TriggerDeliveryStatus[]; test?: boolean } = {}): TriggerDeliveryPage {
    const all = this.index(triggerId);
    const counts = emptyStatusCounts();
    for (const d of all) if (d.status in counts) counts[d.status]++;
    let filtered = o.statuses?.length ? all.filter((d) => o.statuses!.includes(d.status)) : all;
    if (o.test !== undefined) filtered = filtered.filter((d) => !!d.test === o.test);
    let start = 0;
    if (o.cursor) {
      const i = filtered.findIndex((d) => d.id === o.cursor);
      start = i < 0 ? filtered.length : i + 1;
    }
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const slice = filtered.slice(start, start + limit);
    const more = start + limit < filtered.length;
    return { deliveries: slice, ...(more && slice.length ? { nextCursor: slice.at(-1)!.id } : {}), total: all.length, counts };
  }

  stats(triggerId: string): TriggerStats {
    const all = this.index(triggerId);
    const counts = emptyStatusCounts();
    for (const d of all) if (d.status in counts) counts[d.status] += d.count && d.status === "rate_limited" ? d.count : 1;
    return { counts, total: all.length, ...(all[0] ? { lastDeliveryAt: all[0].receivedAt, lastStatus: all[0].status } : {}) };
  }

  /** Deliveries whose actions are still queued or running (as recorded). */
  unfinishedActionDeliveries(triggerId: string): TriggerDeliverySummary[] {
    return this.index(triggerId).filter((d) => d.actionsStatus === "queued" || d.actionsStatus === "running");
  }

  // ── Action usage (per day: actions started, agent spend) ──

  actionUsage(triggerId: string): TriggerActionUsage | undefined {
    if (!isTriggerId(triggerId)) return undefined;
    return readJson<TriggerActionUsage>(join(this.dir(triggerId), "action-usage.json"));
  }

  saveActionUsage(triggerId: string, usage: TriggerActionUsage): void {
    if (!this.exists(triggerId)) return;
    writeJson(join(this.dir(triggerId), "action-usage.json"), usage);
  }

  // ── Dedupe ──

  private dedupeFile(id: string): string { return join(this.dir(id), "dedupe.json"); }

  /** The delivery that first carried this key hash, while its window lasts. */
  dedupeLookup(triggerId: string, hash: string, now: number): string | undefined {
    const map = readJson<Record<string, { deliveryId: string; until: number }>>(this.dedupeFile(triggerId)) ?? {};
    const hit = map[hash];
    return hit && hit.until > now ? hit.deliveryId : undefined;
  }

  /** Remember a key hash until `until` (expired ones are dropped; the oldest beyond the cap too). */
  dedupeRemember(triggerId: string, hash: string, deliveryId: string, until: number, now: number): void {
    const map = readJson<Record<string, { deliveryId: string; until: number }>>(this.dedupeFile(triggerId)) ?? {};
    const live = Object.entries(map).filter(([, v]) => v.until > now);
    live.push([hash, { deliveryId, until }]);
    const kept = live.slice(-TRIGGER_LIMITS.maxDedupeKeys);
    writeJson(this.dedupeFile(triggerId), Object.fromEntries(kept));
  }
}
