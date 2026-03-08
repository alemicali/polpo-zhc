import { eq } from "drizzle-orm";
import type { DelayStore, DelayState } from "@polpo/core/delay-store";
import { type Dialect, deserializeJson } from "../utils.js";

type AnyTable = any;

const DELAY_KEY = "delays";

const EMPTY_STATE: DelayState = { definitions: {}, active: {}, expired: [] };

export class DrizzleDelayStore implements DelayStore {
  constructor(
    private db: any,
    private metadata: AnyTable,
    private dialect: Dialect,
  ) {}

  async load(): Promise<DelayState> {
    const rows: any[] = await this.db.select().from(this.metadata)
      .where(eq(this.metadata.key, DELAY_KEY));
    if (rows.length === 0) return { ...EMPTY_STATE };
    return deserializeJson<DelayState>(rows[0].value, { ...EMPTY_STATE }, this.dialect);
  }

  async save(state: DelayState): Promise<void> {
    const value = JSON.stringify(state);
    await this.db.insert(this.metadata).values({ key: DELAY_KEY, value })
      .onConflictDoUpdate({ target: this.metadata.key, set: { value } });
  }

  async removeGroup(state: DelayState, group: string): Promise<DelayState> {
    const { definitions, active, expired } = state;
    const next: DelayState = {
      definitions: { ...definitions },
      active: { ...active },
      expired: expired.filter((e) => !e.startsWith(`${group}:`)),
    };
    delete next.definitions[group];
    for (const key of Object.keys(next.active)) {
      if (key.startsWith(`${group}:`)) delete next.active[key];
    }
    await this.save(next);
    return next;
  }
}
