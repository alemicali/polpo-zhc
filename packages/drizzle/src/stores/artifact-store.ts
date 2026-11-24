import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  applyArtifactPatch, ArtifactEditConflictError, buildArtifact, matchesArtifactFilter, summarizeArtifact,
  type Artifact, type ArtifactFilter, type ArtifactPatch, type ArtifactStore, type ArtifactSummary, type NewArtifact,
} from "@polpo-ai/core/artifacts";
import { deserializeJson, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** Artifacts: the whole artifact is the `doc`; type, author, session and times are copied for lookups. */
export class DrizzleArtifactStore implements ArtifactStore {
  constructor(private db: any, private table: AnyTable, private dialect: Dialect) {}

  async list(filter: ArtifactFilter = {}): Promise<ArtifactSummary[]> {
    const query = this.db.select().from(this.table);
    const rows: any[] = filter.sessionId
      ? await query.where(eq(this.table.sessionId, filter.sessionId)).orderBy(desc(this.table.updatedAt))
      : await query.orderBy(desc(this.table.updatedAt));
    return rows.map((r) => this.toArtifact(r)).filter((a) => matchesArtifactFilter(a, filter)).map(summarizeArtifact);
  }

  async get(id: string): Promise<Artifact | undefined> {
    const rows: any[] = await this.db.select().from(this.table).where(eq(this.table.id, id));
    return rows[0] ? this.toArtifact(rows[0]) : undefined;
  }

  async create(input: NewArtifact): Promise<Artifact> {
    const artifact = buildArtifact(`art_${nanoid(12)}`, input);
    await this.db.insert(this.table).values(this.toRow(artifact));
    return artifact;
  }

  async update(id: string, patch: ArtifactPatch): Promise<Artifact | undefined> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.get(id);
      if (!current) return undefined;
      const timestamp = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
      const next = applyArtifactPatch(current, patch, timestamp);
      const changed = await this.db.update(this.table).set(this.toRow(next))
        .where(and(eq(this.table.id, id), eq(this.table.updatedAt, current.updatedAt)))
        .returning({ id: this.table.id });
      if (changed.length) return next;
    }
    throw new ArtifactEditConflictError();
  }

  async restore(id: string, version: number, author?: string): Promise<Artifact | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const old = current.versions.find((v) => v.version === version);
    if (!old) throw new Error(`No version ${version} of this artifact`);
    return this.update(id, { content: old.content, ...(old.blob ? { blob: old.blob } : {}), expectedVersion: current.version, author, note: `restored version ${version}` });
  }

  async put(artifact: Artifact, options: { ifUpdatedAt?: string | null } = {}): Promise<boolean> {
    const row = this.toRow(artifact);
    if (options.ifUpdatedAt === null) {
      const inserted = await this.db.insert(this.table).values(row).onConflictDoNothing().returning({ id: this.table.id });
      return inserted.length > 0;
    }
    if (options.ifUpdatedAt !== undefined) {
      const changed = await this.db.update(this.table).set(row)
        .where(and(eq(this.table.id, artifact.id), eq(this.table.updatedAt, options.ifUpdatedAt)))
        .returning({ id: this.table.id });
      return changed.length > 0;
    }
    await this.db.insert(this.table).values(row).onConflictDoUpdate({ target: this.table.id, set: row });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await this.db.delete(this.table).where(eq(this.table.id, id));
    return true;
  }

  private toRow(artifact: Artifact) {
    return {
      id: artifact.id,
      type: artifact.type,
      createdBy: artifact.createdBy,
      sessionId: artifact.sessionId ?? null,
      doc: serializeJson(artifact, this.dialect),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    };
  }

  private toArtifact(row: any): Artifact {
    return deserializeJson<Artifact>(row.doc, { id: row.id } as Artifact, this.dialect);
  }
}
