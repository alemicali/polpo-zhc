import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type {
  CreateDataSource,
  CreateDataView,
  DataActivity,
  DataRegistryStore,
  DataSource,
  DataView,
} from "../core/data-registry.js";

type RegistryFile = {
  version: 1;
  sources: DataSource[];
  views: DataView[];
  activity: DataActivity[];
};

const EMPTY: RegistryFile = { version: 1, sources: [], views: [], activity: [] };

export type DataRegistryChangeEvent =
  | { type: "source"; sourceId: string; action: "created" | "updated" | "deleted" | "activity" | "data"; timestamp: string }
  | { type: "view"; viewId: string; action: "created" | "updated" | "deleted"; timestamp: string };

export type DataRegistryChangeEmitter = (event: DataRegistryChangeEvent) => void;

export class FileDataRegistryStore implements DataRegistryStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(polpoDir: string, private emitChange?: DataRegistryChangeEmitter) {
    this.path = join(polpoDir, "data.json");
  }

  setEmitter(emitChange?: DataRegistryChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  async listSources(): Promise<DataSource[]> {
    return (await this.read()).sources.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSource(id: string): Promise<DataSource | null> {
    return (await this.read()).sources.find((item) => item.id === id || item.slug === id) ?? null;
  }

  async createSource(input: CreateDataSource): Promise<DataSource> {
    const now = new Date().toISOString();
    const source: DataSource = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    await this.mutate((data) => {
      if (data.sources.some((item) => item.id === source.id || item.slug === source.slug)) {
        throw new Error(`A data source with id or slug "${source.slug}" already exists`);
      }
      data.sources.push(source);
    });
    this.emitSource(source.id, "created");
    return source;
  }

  async updateSource(id: string, input: Partial<Omit<DataSource, "id" | "createdAt">>): Promise<DataSource | null> {
    let result: DataSource | null = null;
    await this.mutate((data) => {
      const index = data.sources.findIndex((item) => item.id === id || item.slug === id);
      if (index < 0) return;
      const current = data.sources[index]!;
      const next = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      if (data.sources.some((item, itemIndex) => itemIndex !== index && item.slug === next.slug)) {
        throw new Error(`A data source with slug "${next.slug}" already exists`);
      }
      data.sources[index] = next;
      result = next;
    });
    const updated = result as DataSource | null;
    if (updated) this.emitSource(updated.id, "updated");
    return updated;
  }

  async deleteSource(id: string): Promise<boolean> {
    let deleted = false;
    let sourceId = id;
    await this.mutate((data) => {
      const source = data.sources.find((item) => item.id === id || item.slug === id);
      if (!source) return;
      sourceId = source.id;
      data.sources = data.sources.filter((item) => item.id !== source.id);
      deleted = true;
    });
    if (deleted) this.emitSource(sourceId, "deleted");
    return deleted;
  }

  async listViews(): Promise<DataView[]> {
    return (await this.read()).views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getView(id: string): Promise<DataView | null> {
    return (await this.read()).views.find((item) => item.id === id) ?? null;
  }

  async createView(input: CreateDataView): Promise<DataView> {
    const now = new Date().toISOString();
    const view: DataView = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    await this.mutate((data) => {
      if (data.views.some((item) => item.id === view.id)) throw new Error(`Data view "${view.id}" already exists`);
      data.views.push(view);
    });
    this.emitView(view.id, "created");
    return view;
  }

  async updateView(id: string, input: Partial<Omit<DataView, "id" | "createdAt">>): Promise<DataView | null> {
    let result: DataView | null = null;
    await this.mutate((data) => {
      const index = data.views.findIndex((item) => item.id === id);
      if (index < 0) return;
      const current = data.views[index]!;
      result = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      data.views[index] = result;
    });
    const updated = result as DataView | null;
    if (updated) this.emitView(updated.id, "updated");
    return updated;
  }

  async deleteView(id: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => {
      const length = data.views.length;
      data.views = data.views.filter((item) => item.id !== id);
      deleted = data.views.length !== length;
    });
    if (deleted) this.emitView(id, "deleted");
    return deleted;
  }

  async addActivity(input: Omit<DataActivity, "id" | "createdAt">): Promise<DataActivity> {
    const activity: DataActivity = { ...input, id: nanoid(), createdAt: new Date().toISOString() };
    await this.mutate((data) => {
      data.activity.unshift(activity);
      data.activity = data.activity.slice(0, 1_000);
    });
    this.emitSource(input.sourceId, input.action === "mutate" && input.status === "succeeded" ? "data" : "activity");
    return activity;
  }

  private emitSource(sourceId: string, action: "created" | "updated" | "deleted" | "activity" | "data"): void {
    this.emitChange?.({ type: "source", sourceId, action, timestamp: new Date().toISOString() });
  }

  private emitView(viewId: string, action: "created" | "updated" | "deleted"): void {
    this.emitChange?.({ type: "view", viewId, action, timestamp: new Date().toISOString() });
  }

  async listActivity(sourceId?: string, limit = 100): Promise<DataActivity[]> {
    const items = (await this.read()).activity;
    return (sourceId ? items.filter((item) => item.sourceId === sourceId) : items).slice(0, Math.max(1, Math.min(limit, 500)));
  }

  private async read(): Promise<RegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<RegistryFile>;
      return {
        version: 1,
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        views: Array.isArray(parsed.views) ? parsed.views : [],
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
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
