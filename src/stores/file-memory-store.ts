import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryStore } from "../core/memory-store.js";

/**
 * File-backed MemoryStore.
 * Reads/writes `.orchestra/memory.md` — human-readable, hand-editable.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(orchestraDir: string) {
    this.filePath = join(orchestraDir, "memory.md");
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  get(): string {
    if (!this.exists()) return "";
    try {
      return readFileSync(this.filePath, "utf-8");
    } catch {
      return "";
    }
  }

  save(content: string): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, content, "utf-8");
  }

  append(line: string): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().slice(0, 10);
    appendFileSync(this.filePath, `\n- ${ts}: ${line}\n`, "utf-8");
  }
}
