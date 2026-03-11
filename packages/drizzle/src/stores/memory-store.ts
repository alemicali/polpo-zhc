import { eq, like } from "drizzle-orm";
import type { MemoryStore } from "@polpo-ai/core/memory-store";

type AnyTable = any;

/** Default key for shared (unscoped) memory. */
const SHARED_KEY = "default";

export class DrizzleMemoryStore implements MemoryStore {
  constructor(
    private db: any,
    private memory: AnyTable,
  ) {}

  /** Resolve the DB key for a given scope. Undefined = shared memory ("default"). */
  private resolveKey(scope?: string): string {
    return scope ?? SHARED_KEY;
  }

  async exists(scope?: string): Promise<boolean> {
    const key = this.resolveKey(scope);
    const rows: any[] = await this.db.select().from(this.memory)
      .where(eq(this.memory.key, key));
    return rows.length > 0;
  }

  async get(scope?: string): Promise<string> {
    const key = this.resolveKey(scope);
    const rows: any[] = await this.db.select().from(this.memory)
      .where(eq(this.memory.key, key));
    return rows.length > 0 ? rows[0].content : "";
  }

  async save(content: string, scope?: string): Promise<void> {
    const key = this.resolveKey(scope);
    await this.db.insert(this.memory).values({ key, content })
      .onConflictDoUpdate({ target: this.memory.key, set: { content } });
  }

  async append(line: string, scope?: string): Promise<void> {
    const current = await this.get(scope);
    const updated = current ? `${current}\n${line}` : line;
    await this.save(updated, scope);
  }

  async update(oldText: string, newText: string, scope?: string): Promise<true | string> {
    const current = await this.get(scope);
    if (!current.includes(oldText)) {
      return `Text not found: "${oldText.slice(0, 50)}..."`;
    }
    const updated = current.replace(oldText, newText);
    await this.save(updated, scope);
    return true;
  }

  /** List all agent scopes that have memory rows. Returns scope keys matching "agent:*". */
  async listScopes(): Promise<string[]> {
    const rows: any[] = await this.db.select({ key: this.memory.key }).from(this.memory)
      .where(like(this.memory.key, "agent:%"));
    return rows.map((r: any) => r.key.slice(6)); // strip "agent:" prefix, return agent names
  }
}
