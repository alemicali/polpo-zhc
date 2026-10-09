import { eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  CreateStorageEntry,
  StorageEntry,
  StorageRegistryChangeEmitter,
  StorageRegistryStore,
} from "@polpo-ai/core/storage-registry";
import { affectedRows, deserializeJson, isUniqueViolation, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** Storage entries (buckets): the whole entry is the `doc`; id, slug and name are copied for lookups. */
export class DrizzleStorageRegistryStore implements StorageRegistryStore {
  constructor(
    private db: any,
    private table: AnyTable,
    private dialect: Dialect,
    private emitChange?: StorageRegistryChangeEmitter,
  ) {}

  setEmitter(emitChange?: StorageRegistryChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  async list(): Promise<StorageEntry[]> {
    const rows: any[] = await this.db.select().from(this.table);
    return rows.map((r) => this.toEntry(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(idOrSlug: string): Promise<StorageEntry | null> {
    const rows: any[] = await this.db.select().from(this.table)
      .where(or(eq(this.table.id, idOrSlug), eq(this.table.slug, idOrSlug)));
    const row = rows.find((r) => r.id === idOrSlug) ?? rows[0];
    return row ? this.toEntry(row) : null;
  }

  async create(input: CreateStorageEntry): Promise<StorageEntry> {
    const now = new Date().toISOString();
    const entry: StorageEntry = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    try {
      await this.db.insert(this.table).values(this.toRow(entry));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`A storage entry with id or slug "${entry.slug}" already exists`);
      throw err;
    }
    this.emit(entry, "created");
    return entry;
  }

  async update(idOrSlug: string, input: Partial<Omit<StorageEntry, "id" | "createdAt">>): Promise<StorageEntry | null> {
    const current = await this.get(idOrSlug);
    if (!current) return null;
    const next: StorageEntry = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    try {
      await this.db.update(this.table).set(this.toRow(next)).where(eq(this.table.id, current.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`A storage entry with slug "${next.slug}" already exists`);
      throw err;
    }
    this.emit(next, "updated");
    return next;
  }

  async delete(idOrSlug: string): Promise<boolean> {
    const current = await this.get(idOrSlug);
    if (!current) return false;
    const result = await this.db.delete(this.table).where(eq(this.table.id, current.id));
    const deleted = affectedRows(result) > 0;
    if (deleted) this.emit(current, "deleted");
    return deleted;
  }

  /** Copy existing entries as they are, ids and dates included (used when moving storage.json). */
  async importEntries(entries: StorageEntry[]): Promise<void> {
    for (const entry of entries) await this.db.insert(this.table).values(this.toRow(entry)).onConflictDoNothing();
  }

  private toRow(entry: StorageEntry) {
    return {
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      doc: serializeJson(entry, this.dialect),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private toEntry(row: any): StorageEntry {
    return deserializeJson<StorageEntry>(row.doc, { id: row.id, slug: row.slug, name: row.name } as StorageEntry, this.dialect);
  }

  private emit(entry: StorageEntry, action: "created" | "updated" | "deleted"): void {
    this.emitChange?.({ entryId: entry.id, slug: entry.slug, action, timestamp: new Date().toISOString() });
  }
}
