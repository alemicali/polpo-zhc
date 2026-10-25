import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import {
  applyArtifactPatch, buildArtifact, matchesArtifactFilter, summarizeArtifact,
  type Artifact, type ArtifactFilter, type ArtifactPatch, type ArtifactStore, type ArtifactSummary, type NewArtifact,
} from "@polpo-ai/core/artifacts";

function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${nanoid(6)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

/** One JSON file per artifact (content and versions) in .polpo/artifacts/. */
export class FileArtifactStore implements ArtifactStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "artifacts");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  private read(id: string): Artifact | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id), "utf-8")) as Artifact;
    } catch {
      return undefined;
    }
  }

  async list(filter?: ArtifactFilter): Promise<ArtifactSummary[]> {
    const out: ArtifactSummary[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const artifact = JSON.parse(readFileSync(join(this.dir, name), "utf-8")) as Artifact;
        if (matchesArtifactFilter(artifact, filter)) out.push(summarizeArtifact(artifact));
      } catch { /* a half-written or foreign file */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.read(id);
  }

  async create(input: NewArtifact): Promise<Artifact> {
    const artifact = buildArtifact(`art_${nanoid(12)}`, input);
    atomicWrite(this.path(artifact.id), artifact);
    return artifact;
  }

  async update(id: string, patch: ArtifactPatch): Promise<Artifact | undefined> {
    const current = this.read(id);
    if (!current) return undefined;
    const next = applyArtifactPatch(current, patch);
    atomicWrite(this.path(id), next);
    return next;
  }

  async restore(id: string, version: number, author?: string): Promise<Artifact | undefined> {
    const current = this.read(id);
    if (!current) return undefined;
    const old = current.versions.find((v) => v.version === version);
    if (!old) throw new Error(`No version ${version} of this artifact`);
    return this.update(id, { content: old.content, author, note: `restored version ${version}` });
  }

  async delete(id: string): Promise<boolean> {
    if (!this.read(id)) return false;
    rmSync(this.path(id), { force: true });
    return true;
  }
}
