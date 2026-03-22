import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentStore, Attachment } from "@polpo-ai/core";

/**
 * File-backed AttachmentStore.
 * Metadata stored in `.polpo/attachments.json`.
 * Actual files are managed by the FileSystem abstraction in attachments/.
 */
export class FileAttachmentStore implements AttachmentStore {
  private readonly filePath: string;

  constructor(polpoDir: string) {
    if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
    this.filePath = join(polpoDir, "attachments.json");
  }

  private readAll(): Attachment[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as Attachment[];
    } catch {
      return [];
    }
  }

  private writeAll(attachments: Attachment[]): void {
    writeFileSync(this.filePath, JSON.stringify(attachments, null, 2), "utf-8");
  }

  async save(attachment: Attachment): Promise<void> {
    const all = this.readAll();
    all.push(attachment);
    this.writeAll(all);
  }

  async getBySession(sessionId: string): Promise<Attachment[]> {
    return this.readAll().filter(a => a.sessionId === sessionId);
  }

  async get(id: string): Promise<Attachment | undefined> {
    return this.readAll().find(a => a.id === id);
  }

  async delete(id: string): Promise<boolean> {
    const all = this.readAll();
    const idx = all.findIndex(a => a.id === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    this.writeAll(all);
    return true;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const all = this.readAll();
    const kept = all.filter(a => a.sessionId !== sessionId);
    const removed = all.length - kept.length;
    if (removed > 0) this.writeAll(kept);
    return removed;
  }
}
