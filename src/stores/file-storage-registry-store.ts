import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type {
  CreateStorageEntry,
  StorageEntry,
  StorageRegistryChangeEmitter,
  StorageRegistryStore,
} from "@polpo-ai/core/storage-registry";

type RegistryFile = { version: 1; entries: StorageEntry[] };

/** Storage entries in <polpoDir>/storage.json, for projects without a database. No secrets here. */
export class FileStorageRegistryStore implements StorageRegistryStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(polpoDir: string, private emitChange?: StorageRegistryChangeEmitter) {
    this.path = join(polpoDir, "storage.json");
  }

  setEmitter(emitChange?: StorageRegistryChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  async list(): Promise<StorageEntry[]> {
    return (await this.read()).entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(idOrSlug: string): Promise<StorageEntry | null> {
    const entries = (await this.read()).entries;
    return entries.find((item) => item.id === idOrSlug) ?? entries.find((item) => item.slug === idOrSlug) ?? null;
  }

  async create(input: CreateStorageEntry): Promise<StorageEntry> {
    const now = new Date().toISOString();
    const entry: StorageEntry = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    await this.mutate((data) => {
      if (data.entries.some((item) => item.id === entry.id || item.slug === entry.slug)) {
        throw new Error(`A storage entry with id or slug "${entry.slug}" already exists`);
      }
      data.entries.push(entry);
    });
    this.emit(entry, "created");
    return entry;
  }

  async update(idOrSlug: string, input: Partial<Omit<StorageEntry, "id" | "createdAt">>): Promise<StorageEntry | null> {
    let result: StorageEntry | null = null;
    await this.mutate((data) => {
      let index = data.entries.findIndex((item) => item.id === idOrSlug);
      if (index < 0) index = data.entries.findIndex((item) => item.slug === idOrSlug);
      if (index < 0) return;
      const current = data.entries[index]!;
      const next: StorageEntry = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      if (data.entries.some((item, i) => i !== index && item.slug === next.slug)) {
        throw new Error(`A storage entry with slug "${next.slug}" already exists`);
      }
      data.entries[index] = next;
      result = next;
    });
    const updated = result as StorageEntry | null;
    if (updated) this.emit(updated, "updated");
    return updated;
  }

  async delete(idOrSlug: string): Promise<boolean> {
    let removed: StorageEntry | undefined;
    await this.mutate((data) => {
      removed = data.entries.find((item) => item.id === idOrSlug) ?? data.entries.find((item) => item.slug === idOrSlug);
      if (removed) data.entries = data.entries.filter((item) => item.id !== removed!.id);
    });
    if (removed) this.emit(removed, "deleted");
    return !!removed;
  }

  private emit(entry: StorageEntry, action: "created" | "updated" | "deleted"): void {
    this.emitChange?.({ entryId: entry.id, slug: entry.slug, action, timestamp: new Date().toISOString() });
  }

  private async read(): Promise<RegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<RegistryFile>;
      return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
  }

  private async mutate(change: (data: RegistryFile) => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const data = await this.read();
      change(data);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
