import { eq } from "drizzle-orm";
import type { MemoryStore } from "@polpo-ai/core/memory-store";

type AnyTable = any;

const MEMORY_KEY = "default";

export class DrizzleMemoryStore implements MemoryStore {
  constructor(
    private db: any,
    private memory: AnyTable,
  ) {}

  async exists(): Promise<boolean> {
    const rows: any[] = await this.db.select().from(this.memory)
      .where(eq(this.memory.key, MEMORY_KEY));
    return rows.length > 0;
  }

  async get(): Promise<string> {
    const rows: any[] = await this.db.select().from(this.memory)
      .where(eq(this.memory.key, MEMORY_KEY));
    return rows.length > 0 ? rows[0].content : "";
  }

  async save(content: string): Promise<void> {
    await this.db.insert(this.memory).values({ key: MEMORY_KEY, content })
      .onConflictDoUpdate({ target: this.memory.key, set: { content } });
  }

  async append(line: string): Promise<void> {
    const current = await this.get();
    const updated = current ? `${current}\n${line}` : line;
    await this.save(updated);
  }

  async update(oldText: string, newText: string): Promise<true | string> {
    const current = await this.get();
    if (!current.includes(oldText)) {
      return `Text not found: "${oldText.slice(0, 50)}..."`;
    }
    const updated = current.replace(oldText, newText);
    await this.save(updated);
    return true;
  }
}
