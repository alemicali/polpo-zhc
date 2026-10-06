/** Summary of the compacted start of a chat session, reused while the prefix it covers is unchanged. */
export interface ContextCheckpoint {
  version: 1;
  revision: string;
  scope: string;
  prefixHashes: string[];
  summary: string;
}

export interface ContextCheckpointStore {
  load(sessionId: string): Promise<ContextCheckpoint | null>;
  /** Compare-and-swap: saves only if the stored revision is still `expectedRevision` (null = none yet). */
  save(sessionId: string, checkpoint: ContextCheckpoint, expectedRevision: string | null): Promise<boolean>;
}

/** Shape check for checkpoints read back from storage (untrusted: files can be edited by hand). */
export function isValidContextCheckpoint(value: unknown): value is ContextCheckpoint {
  const v = value as Partial<ContextCheckpoint> | null;
  return !!v && v.version === 1 && typeof v.revision === "string" && typeof v.scope === "string" &&
    typeof v.summary === "string" && v.summary.length <= 25_000 &&
    Array.isArray(v.prefixHashes) && v.prefixHashes.length > 0 &&
    v.prefixHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
}
