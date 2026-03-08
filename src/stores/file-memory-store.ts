import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryStore } from "../core/memory-store.js";

/**
 * File-backed MemoryStore.
 * Reads/writes `.polpo/memory.md` — human-readable, hand-editable.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(polpoDir: string) {
    this.filePath = join(polpoDir, "memory.md");
  }

  async exists(): Promise<boolean> {
    return existsSync(this.filePath);
  }

  async get(): Promise<string> {
    if (!this.exists()) return "";
    try {
      return readFileSync(this.filePath, "utf-8");
    } catch { /* unreadable memory file */
      return "";
    }
  }

  async save(content: string): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, this.filePath);
  }

  async append(line: string): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().slice(0, 10);
    appendFileSync(this.filePath, `\n- ${ts}: ${line}\n`, "utf-8");
  }

  async update(oldText: string, newText: string): Promise<true | string> {
    if (!this.exists()) return "Memory file does not exist. Use save_memory to create it first.";
    const content = await this.get();
    if (!content.includes(oldText)) {
      return "oldString not found in memory. Use get_memory to see the current content.";
    }
    const firstIdx = content.indexOf(oldText);
    const secondIdx = content.indexOf(oldText, firstIdx + 1);
    if (secondIdx !== -1) {
      return "oldString found multiple times in memory. Provide more surrounding context to make the match unique.";
    }
    const updated = content.replace(oldText, newText);
    this.save(updated);
    return true;
  }
}
