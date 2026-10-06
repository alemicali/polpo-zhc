import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidContextCheckpoint, type ContextCheckpoint, type ContextCheckpointStore } from "@polpo-ai/core/context-checkpoint";

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
      const value: unknown = JSON.parse(readFileSync(this.file(sessionId), "utf8"));
      return isValidContextCheckpoint(value) ? value : null;
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
