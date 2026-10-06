import { eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  AppChangeEmitter,
  AppChangeEvent,
  AppRegistryStore,
  CreateRegisteredApp,
  RegisteredApp,
} from "@polpo-ai/core/app-registry";
import { affectedRows, deserializeJson, isUniqueViolation, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

export class DrizzleAppRegistryStore implements AppRegistryStore {
  constructor(
    private db: any,
    private apps: AnyTable,
    private dialect: Dialect,
    private emitChange?: AppChangeEmitter,
  ) {}

  setEmitter(emitChange?: AppChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  async list(): Promise<RegisteredApp[]> {
    const rows: any[] = await this.db.select().from(this.apps);
    return rows.map((r) => this.toApp(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<RegisteredApp | null> {
    const rows: any[] = await this.db.select().from(this.apps)
      .where(or(eq(this.apps.id, id), eq(this.apps.slug, id)));
    // An id wins over another app's slug, as in the file store.
    const row = rows.find((r) => r.id === id) ?? rows[0];
    return row ? this.toApp(row) : null;
  }

  async create(input: CreateRegisteredApp): Promise<RegisteredApp> {
    const now = new Date().toISOString();
    const app: RegisteredApp = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    try {
      await this.db.insert(this.apps).values(this.toRow(app));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`An app with id or slug "${app.slug}" already exists`);
      throw err;
    }
    this.emit("created", app.id);
    return app;
  }

  async update(id: string, input: Partial<Omit<RegisteredApp, "id" | "createdAt">>): Promise<RegisteredApp | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: RegisteredApp = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    try {
      await this.db.update(this.apps).set(this.toRow(next)).where(eq(this.apps.id, current.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`An app with slug "${next.slug}" already exists`);
      throw err;
    }
    this.emit("updated", next.id);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    const result = await this.db.delete(this.apps).where(eq(this.apps.id, current.id));
    const deleted = affectedRows(result) > 0;
    if (deleted) this.emit("deleted", current.id);
    return deleted;
  }

  private toRow(app: RegisteredApp) {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      doc: serializeJson(app, this.dialect),
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    };
  }

  private toApp(row: any): RegisteredApp {
    return deserializeJson<RegisteredApp>(row.doc, { id: row.id, slug: row.slug, name: row.name } as RegisteredApp, this.dialect);
  }

  private emit(action: AppChangeEvent["action"], appId: string): void {
    this.emitChange?.({ appId, action, timestamp: new Date().toISOString() });
  }
}
