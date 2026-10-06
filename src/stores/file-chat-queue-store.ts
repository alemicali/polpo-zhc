import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { ChatQueueItem, ChatQueueState, ChatQueueStore } from "@polpo-ai/core";

type Stored = Record<string, { items: ChatQueueItem[]; autoSend?: boolean }>;

/**
 * File-backed ChatQueueStore: every session's prompt queue in `.polpo/chat-queue.json`.
 * Operations are synchronous read-modify-write, so they never interleave within the process.
 */
export class FileChatQueueStore implements ChatQueueStore {
  private readonly filePath: string;

  constructor(private readonly polpoDir: string) {
    this.filePath = join(polpoDir, "chat-queue.json");
  }

  private read(): Stored {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed as Stored : {};
    } catch {
      return {};
    }
  }

  private write(data: Stored): void {
    if (!existsSync(this.polpoDir)) mkdirSync(this.polpoDir, { recursive: true });
    for (const [sessionId, entry] of Object.entries(data)) {
      if (entry.items.length === 0 && entry.autoSend !== false) delete data[sessionId];
    }
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }

  private mutate<T>(sessionId: string, change: (entry: { items: ChatQueueItem[]; autoSend?: boolean }) => T): T {
    const data = this.read();
    const entry = data[sessionId] ?? { items: [] };
    data[sessionId] = entry;
    const result = change(entry);
    this.write(data);
    return result;
  }

  async get(sessionId: string): Promise<ChatQueueState> {
    const entry = this.read()[sessionId];
    return { items: [...(entry?.items ?? [])], autoSend: entry?.autoSend ?? true };
  }

  async add(sessionId: string, content: string, opts?: { front?: boolean }): Promise<ChatQueueItem> {
    const item: ChatQueueItem = { id: nanoid(12), sessionId, content, createdAt: new Date().toISOString() };
    return this.mutate(sessionId, (entry) => {
      if (opts?.front) entry.items.unshift(item);
      else entry.items.push(item);
      return item;
    });
  }

  async update(sessionId: string, id: string, content: string): Promise<ChatQueueItem | undefined> {
    return this.mutate(sessionId, (entry) => {
      const item = entry.items.find((i) => i.id === id);
      if (item) item.content = content;
      return item ? { ...item } : undefined;
    });
  }

  async remove(sessionId: string, id: string): Promise<ChatQueueItem | undefined> {
    return this.mutate(sessionId, (entry) => {
      const index = entry.items.findIndex((i) => i.id === id);
      return index >= 0 ? entry.items.splice(index, 1)[0] : undefined;
    });
  }

  async reorder(sessionId: string, ids: string[]): Promise<ChatQueueItem[]> {
    return this.mutate(sessionId, (entry) => {
      const byId = new Map(entry.items.map((i) => [i.id, i]));
      const listed = [...new Set(ids)].filter((id) => byId.has(id));
      const listedSet = new Set(listed);
      entry.items = [
        ...listed.map((id) => byId.get(id)!),
        ...entry.items.filter((i) => !listedSet.has(i.id)),
      ];
      return [...entry.items];
    });
  }

  async clear(sessionId: string): Promise<number> {
    return this.mutate(sessionId, (entry) => {
      const count = entry.items.length;
      entry.items = [];
      return count;
    });
  }

  async shift(sessionId: string): Promise<ChatQueueItem | undefined> {
    return this.mutate(sessionId, (entry) => entry.items.shift());
  }

  async setAutoSend(sessionId: string, autoSend: boolean): Promise<void> {
    this.mutate(sessionId, (entry) => { entry.autoSend = autoSend; });
  }

  async sessionsWithItems(): Promise<string[]> {
    return Object.entries(this.read()).filter(([, entry]) => entry.items.length > 0).map(([sessionId]) => sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const data = this.read();
    if (!(sessionId in data)) return;
    delete data[sessionId];
    this.write(data);
  }
}
