import { and, eq } from "drizzle-orm";
import {
  isValidContextCheckpoint,
  type ContextCheckpoint,
  type ContextCheckpointStore,
} from "@polpo-ai/core/context-checkpoint";
import { affectedRows, deserializeJson, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** One checkpoint per chat session; saves are atomic compare-and-swap on the revision. */
export class DrizzleContextCheckpointStore implements ContextCheckpointStore {
  constructor(
    private db: any,
    private checkpoints: AnyTable,
    private dialect: Dialect,
  ) {}

  async load(sessionId: string): Promise<ContextCheckpoint | null> {
    const rows: any[] = await this.db.select().from(this.checkpoints)
      .where(eq(this.checkpoints.sessionId, sessionId));
    if (rows.length === 0) return null;
    const value = deserializeJson<unknown>(rows[0].checkpoint, null, this.dialect);
    return isValidContextCheckpoint(value) ? value : null;
  }

  async save(sessionId: string, checkpoint: ContextCheckpoint, expectedRevision: string | null): Promise<boolean> {
    const values = {
      revision: checkpoint.revision,
      checkpoint: serializeJson(checkpoint, this.dialect),
      updatedAt: new Date().toISOString(),
    };
    if (expectedRevision === null) {
      const result = await this.db.insert(this.checkpoints)
        .values({ sessionId, ...values })
        .onConflictDoNothing({ target: this.checkpoints.sessionId });
      return affectedRows(result) > 0;
    }
    const result = await this.db.update(this.checkpoints)
      .set(values)
      .where(and(eq(this.checkpoints.sessionId, sessionId), eq(this.checkpoints.revision, expectedRevision)));
    return affectedRows(result) > 0;
  }
}
