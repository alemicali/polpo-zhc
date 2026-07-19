import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type { AppRegistryStore, CreateRegisteredApp, RegisteredApp } from "../core/app-registry.js";

type RegistryFile = { version: 1; apps: RegisteredApp[] };

export class FileAppRegistryStore implements AppRegistryStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(polpoDir: string) {
    this.path = join(polpoDir, "apps.json");
  }

  async list(): Promise<RegisteredApp[]> {
    return (await this.read()).apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<RegisteredApp | null> {
    const apps = (await this.read()).apps;
    return apps.find((app) => app.id === id || app.slug === id) ?? null;
  }

  async create(input: CreateRegisteredApp): Promise<RegisteredApp> {
    const now = new Date().toISOString();
    const app: RegisteredApp = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    await this.mutate((data) => {
      if (data.apps.some((item) => item.id === app.id || item.slug === app.slug)) {
        throw new Error(`An app with id or slug "${app.slug}" already exists`);
      }
      data.apps.push(app);
    });
    return app;
  }

  async update(id: string, input: Partial<Omit<RegisteredApp, "id" | "createdAt">>): Promise<RegisteredApp | null> {
    let updated: RegisteredApp | null = null;
    await this.mutate((data) => {
      const index = data.apps.findIndex((app) => app.id === id || app.slug === id);
      if (index < 0) return;
      const current = data.apps[index]!;
      const next = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      if (data.apps.some((item, itemIndex) => itemIndex !== index && item.slug === next.slug)) {
        throw new Error(`An app with slug "${next.slug}" already exists`);
      }
      data.apps[index] = next;
      updated = next;
    });
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => {
      const index = data.apps.findIndex((app) => app.id === id || app.slug === id);
      if (index >= 0) {
        data.apps.splice(index, 1);
        deleted = true;
      }
    });
    return deleted;
  }

  private async read(): Promise<RegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as RegistryFile;
      return { version: 1, apps: Array.isArray(parsed.apps) ? parsed.apps : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, apps: [] };
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
