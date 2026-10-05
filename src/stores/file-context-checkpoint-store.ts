import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextCheckpoint, ContextCheckpointStore } from "@polpo-ai/server";

/** Atomic sidecar, private permissions, compare-and-swap against stale turns. */
export class FileContextCheckpointStore implements ContextCheckpointStore {
  private readonly directory: string;
  constructor(polpoDir: string) { this.directory = join(polpoDir, "context-checkpoints"); }
  private file(sessionId: string) {
    if (!/^[\w-]{1,128}$/.test(sessionId)) throw new Error("Invalid checkpoint session id");
    return join(this.directory, `${sessionId}.json`);
  }
  private read(sessionId: string): ContextCheckpoint | null {
    try {
      const value = JSON.parse(readFileSync(this.file(sessionId), "utf8"));
      if (value.version !== 1 || typeof value.revision !== "string" || typeof value.scope !== "string" ||
          typeof value.summary !== "string" || value.summary.length > 25_000 ||
          !Array.isArray(value.prefixHashes) || !value.prefixHashes.length ||
          !value.prefixHashes.every((hash: unknown) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) return null;
      return value;
    } catch { return null; }
  }
  async load(sessionId: string) { return this.read(sessionId); }
  async save(sessionId: string, value: ContextCheckpoint, expectedRevision: string | null) {
    // No await between CAS and rename: concurrent requests in this process
    // cannot interleave or publish an older prefix over a newer checkpoint.
    if ((this.read(sessionId)?.revision ?? null) !== expectedRevision) return false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(sessionId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
      return true;
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed successfully */ }
    }
  }
}
