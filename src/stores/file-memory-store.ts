import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { MemoryStore } from "../core/memory-store.js";

/**
 * File-backed MemoryStore.
 * Reads/writes `.polpo/memory.md` for shared memory (no scope).
 * Agent-scoped memory lives in `.polpo/memory/<agent-name>.md`.
 */
export class FileMemoryStore implements MemoryStore {
  private readonly sharedPath: string;
  private readonly scopeDir: string;

  constructor(polpoDir: string) {
    this.sharedPath = join(polpoDir, "memory.md");
    this.scopeDir = join(polpoDir, "memory");
  }

  /** Resolve the file path for a given scope. Undefined = shared memory. */
  private resolvePath(scope?: string): string {
    if (!scope) return this.sharedPath;
    // scope is "agent:<name>" — extract the name part for the filename
    const name = scope.startsWith("agent:") ? scope.slice(6) : scope;
    return join(this.scopeDir, `${name}.md`);
  }

  async exists(scope?: string): Promise<boolean> {
    return existsSync(this.resolvePath(scope));
  }

  async get(scope?: string): Promise<string> {
    const filePath = this.resolvePath(scope);
    if (!existsSync(filePath)) return "";
    try {
      return readFileSync(filePath, "utf-8");
    } catch { /* unreadable memory file */
      return "";
    }
  }

  async save(content: string, scope?: string): Promise<void> {
    const filePath = this.resolvePath(scope);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  }

  async append(line: string, scope?: string): Promise<void> {
    const filePath = this.resolvePath(scope);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().slice(0, 10);
    appendFileSync(filePath, `\n- ${ts}: ${line}\n`, "utf-8");
  }

  async update(oldText: string, newText: string, scope?: string): Promise<true | string> {
    const filePath = this.resolvePath(scope);
    if (!existsSync(filePath)) return "Memory file does not exist. Use save_memory to create it first.";
    const content = await this.get(scope);
    if (!content.includes(oldText)) {
      return "oldString not found in memory. Use get_memory to see the current content.";
    }
    const firstIdx = content.indexOf(oldText);
    const secondIdx = content.indexOf(oldText, firstIdx + 1);
    if (secondIdx !== -1) {
      return "oldString found multiple times in memory. Provide more surrounding context to make the match unique.";
    }
    const updated = content.replace(oldText, newText);
    await this.save(updated, scope);
    return true;
  }

  /** List all agent scopes that have memory files. Returns agent names (without "agent:" prefix). */
  async listScopes(): Promise<string[]> {
    if (!existsSync(this.scopeDir)) return [];
    try {
      return readdirSync(this.scopeDir)
        .filter(f => f.endsWith(".md"))
        .map(f => basename(f, ".md"));
    } catch {
      return [];
    }
  }
}
