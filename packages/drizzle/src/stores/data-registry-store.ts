import { and, desc, eq, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  CreateDataSource,
  CreateDataView,
  DataActivity,
  DataRegistryChangeEmitter,
  DataRegistryStore,
  DataSource,
  DataView,
} from "@polpo-ai/core/data-registry";
import { affectedRows, deserializeJson, isUniqueViolation, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** Activity entries kept (newest first), as in the file store. */
const MAX_ACTIVITY = 1_000;

export class DrizzleDataRegistryStore implements DataRegistryStore {
  constructor(
    private db: any,
    private tables: { sources: AnyTable; views: AnyTable; activity: AnyTable },
    private dialect: Dialect,
    private emitChange?: DataRegistryChangeEmitter,
  ) {}

  setEmitter(emitChange?: DataRegistryChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  // ── Sources ────────────────────────────────────────────────────────

  async listSources(): Promise<DataSource[]> {
    const rows: any[] = await this.db.select().from(this.tables.sources);
    return rows.map((r) => this.doc<DataSource>(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSource(id: string): Promise<DataSource | null> {
    const t = this.tables.sources;
    const rows: any[] = await this.db.select().from(t).where(or(eq(t.id, id), eq(t.slug, id)));
    const row = rows.find((r) => r.id === id) ?? rows[0];
    return row ? this.doc<DataSource>(row) : null;
  }

  async createSource(input: CreateDataSource): Promise<DataSource> {
    const now = new Date().toISOString();
    const source: DataSource = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    try {
      await this.db.insert(this.tables.sources).values(this.sourceRow(source));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`A data source with id or slug "${source.slug}" already exists`);
      throw err;
    }
    this.emitSource(source.id, "created");
    return source;
  }

  async updateSource(id: string, input: Partial<Omit<DataSource, "id" | "createdAt">>): Promise<DataSource | null> {
    const current = await this.getSource(id);
    if (!current) return null;
    const next: DataSource = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    try {
      await this.db.update(this.tables.sources).set(this.sourceRow(next)).where(eq(this.tables.sources.id, current.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`A data source with slug "${next.slug}" already exists`);
      throw err;
    }
    this.emitSource(next.id, "updated");
    return next;
  }

  async deleteSource(id: string): Promise<boolean> {
    const current = await this.getSource(id);
    if (!current) return false;
    const result = await this.db.delete(this.tables.sources).where(eq(this.tables.sources.id, current.id));
    const deleted = affectedRows(result) > 0;
    if (deleted) this.emitSource(current.id, "deleted");
    return deleted;
  }

  // ── Views ──────────────────────────────────────────────────────────

  async listViews(): Promise<DataView[]> {
    const rows: any[] = await this.db.select().from(this.tables.views).orderBy(desc(this.tables.views.updatedAt));
    return rows.map((r) => this.doc<DataView>(r));
  }

  async getView(id: string): Promise<DataView | null> {
    const rows: any[] = await this.db.select().from(this.tables.views).where(eq(this.tables.views.id, id));
    return rows[0] ? this.doc<DataView>(rows[0]) : null;
  }

  async createView(input: CreateDataView): Promise<DataView> {
    const now = new Date().toISOString();
    const view: DataView = { ...input, id: input.id ?? nanoid(), createdAt: now, updatedAt: now };
    try {
      await this.db.insert(this.tables.views).values(this.viewRow(view));
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`Data view "${view.id}" already exists`);
      throw err;
    }
    this.emitView(view.id, "created");
    return view;
  }

  async updateView(id: string, input: Partial<Omit<DataView, "id" | "createdAt">>): Promise<DataView | null> {
    const current = await this.getView(id);
    if (!current) return null;
    const next: DataView = { ...current, ...input, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    await this.db.update(this.tables.views).set(this.viewRow(next)).where(eq(this.tables.views.id, current.id));
    this.emitView(next.id, "updated");
    return next;
  }

  async deleteView(id: string): Promise<boolean> {
    const result = await this.db.delete(this.tables.views).where(eq(this.tables.views.id, id));
    const deleted = affectedRows(result) > 0;
    if (deleted) this.emitView(id, "deleted");
    return deleted;
  }

  // ── Activity ───────────────────────────────────────────────────────

  async addActivity(input: Omit<DataActivity, "id" | "createdAt">): Promise<DataActivity> {
    const activity: DataActivity = { ...input, id: nanoid(), createdAt: new Date().toISOString() };
    const t = this.tables.activity;
    await this.db.insert(t).values({
      id: activity.id,
      sourceId: activity.sourceId,
      doc: serializeJson(activity, this.dialect),
      createdAt: activity.createdAt,
    });
    // Keep the newest MAX_ACTIVITY entries: delete anything older than the last one kept.
    const boundary: any[] = await this.db.select({ createdAt: t.createdAt }).from(t)
      .orderBy(desc(t.createdAt)).limit(1).offset(MAX_ACTIVITY - 1);
    if (boundary[0]) await this.db.delete(t).where(lt(t.createdAt, boundary[0].createdAt));
    this.emitSource(input.sourceId, input.action === "mutate" && input.status === "succeeded" ? "data" : "activity");
    return activity;
  }

  async listActivity(sourceId?: string, limit = 100): Promise<DataActivity[]> {
    const t = this.tables.activity;
    const query = this.db.select().from(t).orderBy(desc(t.createdAt)).limit(Math.max(1, Math.min(limit, 500)));
    const rows: any[] = sourceId ? await query.where(and(eq(t.sourceId, sourceId))) : await query;
    return rows.map((r) => this.doc<DataActivity>(r));
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private sourceRow(source: DataSource) {
    return {
      id: source.id,
      slug: source.slug,
      name: source.name,
      doc: serializeJson(source, this.dialect),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }

  private viewRow(view: DataView) {
    return {
      id: view.id,
      doc: serializeJson(view, this.dialect),
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  }

  private doc<T>(row: any): T {
    return deserializeJson<T>(row.doc, {} as T, this.dialect);
  }

  private emitSource(sourceId: string, action: "created" | "updated" | "deleted" | "activity" | "data"): void {
    this.emitChange?.({ type: "source", sourceId, action, timestamp: new Date().toISOString() });
  }

  private emitView(viewId: string, action: "created" | "updated" | "deleted"): void {
    this.emitChange?.({ type: "view", viewId, action, timestamp: new Date().toISOString() });
  }

  /** Copy an existing registry as it is (used when moving data.json into the database). */
  async importAll(data: { sources: DataSource[]; views: DataView[]; activity: DataActivity[] }): Promise<void> {
    for (const source of data.sources) await this.db.insert(this.tables.sources).values(this.sourceRow(source)).onConflictDoNothing();
    for (const view of data.views) await this.db.insert(this.tables.views).values(this.viewRow(view)).onConflictDoNothing();
    for (const activity of data.activity.slice(0, MAX_ACTIVITY)) {
      await this.db.insert(this.tables.activity).values({
        id: activity.id,
        sourceId: activity.sourceId,
        doc: serializeJson(activity, this.dialect),
        createdAt: activity.createdAt,
      }).onConflictDoNothing();
    }
  }
}
