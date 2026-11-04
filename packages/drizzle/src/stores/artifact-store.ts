import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  applyArtifactPatch, buildArtifact, matchesArtifactFilter, summarizeArtifact,
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
    const current = await this.get(id);
    if (!current) return undefined;
    const next = applyArtifactPatch(current, patch);
    await this.db.update(this.table).set(this.toRow(next)).where(eq(this.table.id, id));
    return next;
  }

  async restore(id: string, version: number, author?: string): Promise<Artifact | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const old = current.versions.find((v) => v.version === version);
    if (!old) throw new Error(`No version ${version} of this artifact`);
    return this.update(id, { content: old.content, author, note: `restored version ${version}` });
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
