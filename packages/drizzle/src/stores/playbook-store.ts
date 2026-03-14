import { eq } from "drizzle-orm";
import type { PlaybookStore, PlaybookDefinition, PlaybookInfo } from "@polpo-ai/core/playbook-store";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

type AnyTable = any;

/**
 * Drizzle ORM implementation of PlaybookStore.
 *
 * Stores playbooks in a `playbooks` table with `name` as primary key.
 * Mission objects and parameters are stored as JSON (TEXT for SQLite, JSONB for PG).
 */
export class DrizzlePlaybookStore implements PlaybookStore {
  constructor(
    private db: any,
    private playbooks: AnyTable,
    private dialect: Dialect,
  ) {}

  async list(): Promise<PlaybookInfo[]> {
    const rows: any[] = await this.db.select().from(this.playbooks);
    return rows.map((row: any) => ({
      name: row.name,
      description: row.description ?? "",
      parameters: deserializeJson<PlaybookInfo["parameters"]>(row.parameters, [], this.dialect),
      path: `db://playbooks/${row.name}`,
    }));
  }

  async get(name: string): Promise<PlaybookDefinition | null> {
    const rows: any[] = await this.db.select().from(this.playbooks)
      .where(eq(this.playbooks.name, name));
    if (rows.length === 0) return null;
    return this.rowToDefinition(rows[0]);
  }

  async save(definition: PlaybookDefinition): Promise<string> {
    const now = new Date().toISOString();
    const values = {
      name: definition.name,
      description: definition.description ?? "",
      mission: serializeJson(definition.mission, this.dialect),
      parameters: definition.parameters ? serializeJson(definition.parameters, this.dialect) : null,
      version: definition.version ?? null,
      author: definition.author ?? null,
      tags: definition.tags ? serializeJson(definition.tags, this.dialect) : null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(this.playbooks).values(values)
      .onConflictDoUpdate({
        target: this.playbooks.name,
        set: {
          description: values.description,
          mission: values.mission,
          parameters: values.parameters,
          version: values.version,
          author: values.author,
          tags: values.tags,
          updatedAt: now,
        },
      });

    return `db://playbooks/${definition.name}`;
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db.delete(this.playbooks)
      .where(eq(this.playbooks.name, name));
    const affected = result?.rowsAffected ?? result?.rowCount ?? result?.changes ?? 0;
    return affected > 0;
  }

  // ── Internal ──

  private rowToDefinition(row: any): PlaybookDefinition {
    const def: PlaybookDefinition = {
      name: row.name,
      description: row.description ?? "",
      mission: deserializeJson<Record<string, unknown>>(row.mission, {}, this.dialect),
    };
    const params = deserializeJson<PlaybookDefinition["parameters"]>(row.parameters, [] as any, this.dialect);
    if (params && Array.isArray(params) && params.length > 0) def.parameters = params;
    if (row.version) def.version = row.version;
    if (row.author) def.author = row.author;
    const tags = deserializeJson<string[]>(row.tags, [] as string[], this.dialect);
    if (tags && tags.length > 0) def.tags = tags;
    return def;
  }
}
