import { eq } from "drizzle-orm";
import type { CheckpointStore, CheckpointState } from "@polpo-ai/core/checkpoint-store";
import { type Dialect, deserializeJson } from "../utils.js";

type AnyTable = any;

const CHECKPOINT_KEY = "checkpoints";

const EMPTY_STATE: CheckpointState = { definitions: {}, active: {}, resumed: [] };

export class DrizzleCheckpointStore implements CheckpointStore {
  constructor(
    private db: any,
    private metadata: AnyTable,
    private dialect: Dialect,
  ) {}

  async load(): Promise<CheckpointState> {
    const rows: any[] = await this.db.select().from(this.metadata)
      .where(eq(this.metadata.key, CHECKPOINT_KEY));
    if (rows.length === 0) return { ...EMPTY_STATE };
    return deserializeJson<CheckpointState>(rows[0].value, { ...EMPTY_STATE }, this.dialect);
  }

  async save(state: CheckpointState): Promise<void> {
    const value = this.dialect === "sqlite" ? JSON.stringify(state) : state;
    await this.db.insert(this.metadata).values({ key: CHECKPOINT_KEY, value })
      .onConflictDoUpdate({ target: this.metadata.key, set: { value } });
  }

  async removeGroup(state: CheckpointState, group: string): Promise<CheckpointState> {
    const { definitions, active, resumed } = state;
    const next: CheckpointState = {
      definitions: { ...definitions },
      active: { ...active },
      resumed: resumed.filter((r) => !r.startsWith(`${group}:`)),
    };
    delete next.definitions[group];
    for (const key of Object.keys(next.active)) {
      if (key.startsWith(`${group}:`)) delete next.active[key];
    }
    await this.save(next);
    return next;
  }
}
