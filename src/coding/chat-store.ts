/**
 * Coding chats on disk: one JSON file per session in <polpoDir>/coding-chats/ (the transcript, the
 * approvals, the program's conversation id — never a credential). Written atomically (a temporary
 * file renamed over the old one); read once and kept in memory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodingChatSession } from "./chat-types.js";

const ID = /^cc_[A-Za-z0-9_-]{4,64}$/;

export function isCodingChatId(id: string): boolean {
  return ID.test(id);
}

export class CodingChatStore {
  private cache = new Map<string, CodingChatSession>();
  private loaded = false;

  constructor(private readonly polpoDir: string) {}

  get dir(): string {
    return join(this.polpoDir, "coding-chats");
  }

  private loadAll(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as CodingChatSession;
        if (s && typeof s.id === "string" && isCodingChatId(s.id)) this.cache.set(s.id, s);
      } catch { /* a damaged file is skipped, never deleted */ }
    }
  }

  list(): CodingChatSession[] {
    this.loadAll();
    return [...this.cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): CodingChatSession | undefined {
    if (!isCodingChatId(id)) return undefined;
    this.loadAll();
    return this.cache.get(id);
  }

  save(session: CodingChatSession): void {
    if (!isCodingChatId(session.id)) throw new Error(`Invalid coding chat id: ${session.id}`);
    this.loadAll();
    this.cache.set(session.id, session);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${session.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
    renameSync(tmp, file);
  }

  delete(id: string): boolean {
    this.loadAll();
    const had = this.cache.delete(id);
    if (isCodingChatId(id)) rmSync(join(this.dir, `${id}.json`), { force: true });
    return had;
  }
}
