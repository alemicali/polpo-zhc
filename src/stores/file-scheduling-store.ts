import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { LeaseStore, ScheduleState, ScheduleStore, TaskWatcher, TaskWatcherStore } from "@polpo-ai/core";

function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${nanoid(6)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function readDir<T>(dir: string): T[] {
  const out: T[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const value = readJson<T>(join(dir, name));
    if (value) out.push(value);
  }
  return out;
}

/** Schedules' runtime state: one JSON file per mission in .polpo/schedules/. */
export class FileScheduleStore implements ScheduleStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "schedules");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(missionId: string): string {
    return join(this.dir, `${encodeURIComponent(missionId)}.json`);
  }

  async getSchedule(missionId: string): Promise<ScheduleState | undefined> {
    return readJson<ScheduleState>(this.path(missionId));
  }

  async listSchedules(): Promise<ScheduleState[]> {
    return readDir<ScheduleState>(this.dir);
  }

  async saveSchedule(state: ScheduleState): Promise<void> {
    atomicWrite(this.path(state.missionId), state);
  }

  async deleteSchedule(missionId: string): Promise<boolean> {
    if (!existsSync(this.path(missionId))) return false;
    rmSync(this.path(missionId), { force: true });
    return true;
  }
}

/** A lock file whose content cannot be read for this long (a crash while writing it) counts as expired. */
const UNREADABLE_LOCK_MS = 60_000;

/**
 * Claims as lock files in .polpo/leases/ (one per key), shared by the processes on this
 * directory: a claim is an exclusive create; an expired one is moved aside atomically (rename)
 * before it is taken, so two processes never both take it.
 */
export class FileLeaseStore implements LeaseStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "leases");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.lock`);
  }

  async tryClaim(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const path = this.path(key);
    const content = JSON.stringify({ key, owner, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
    if (this.create(path, content)) return true;

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      // gone meanwhile: one more try
      return this.create(path, content);
    }
    let current: { owner?: string; expiresAt?: string } | undefined;
    try { current = JSON.parse(raw); } catch { current = undefined; }
    if (current?.owner === owner) {
      atomicWrite(path, JSON.parse(content));
      return true;
    }
    const expired = current?.expiresAt
      ? Date.parse(current.expiresAt) <= Date.now()
      : Date.now() - this.mtime(path) > UNREADABLE_LOCK_MS;
    if (!expired) return false;

    // take over the expired claim: move it aside, check it was the one read, then create ours
    const aside = `${path}.${process.pid}.${nanoid(6)}.stale`;
    try {
      renameSync(path, aside);
    } catch {
      return false; // another process took it first
    }
    let moved = "";
    try { moved = readFileSync(aside, "utf-8"); } catch { /* gone */ }
    rmSync(aside, { force: true });
    if (moved !== raw) {
      // it was a fresh claim (taken over meanwhile): put it back
      if (moved) this.create(path, moved);
      return false;
    }
    return this.create(path, content);
  }

  async release(key: string, owner: string): Promise<void> {
    const path = this.path(key);
    const current = readJson<{ owner?: string }>(path);
    if (current?.owner === owner) rmSync(path, { force: true });
  }

  async prune(before: string): Promise<number> {
    let n = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".lock")) continue;
      const path = join(this.dir, name);
      const lease = readJson<{ expiresAt?: string }>(path);
      if (lease?.expiresAt && lease.expiresAt < before) {
        rmSync(path, { force: true });
        n++;
      }
    }
    return n;
  }

  private create(path: string, content: string): boolean {
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  private mtime(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return 0; }
  }
}

/** Task watchers: one JSON file per watcher in .polpo/watchers/. */
export class FileTaskWatcherStore implements TaskWatcherStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "watchers");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  async listWatchers(): Promise<TaskWatcher[]> {
    return readDir<TaskWatcher>(this.dir).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async saveWatcher(watcher: TaskWatcher): Promise<void> {
    atomicWrite(this.path(watcher.id), watcher);
  }

  async deleteWatcher(id: string): Promise<boolean> {
    if (!existsSync(this.path(id))) return false;
    rmSync(this.path(id), { force: true });
    return true;
  }
}
