import { eq } from "drizzle-orm";
import type { ConfigStore } from "@polpo/core/config-store";
import type { PolpoConfig } from "@polpo/core/types";
import { type Dialect, deserializeJson } from "../utils.js";

type AnyTable = any;

const CONFIG_KEY = "config";

export class DrizzleConfigStore implements ConfigStore {
  constructor(
    private db: any,
    private metadata: AnyTable,
    private dialect: Dialect,
  ) {}

  async exists(): Promise<boolean> {
    const rows: any[] = await this.db.select().from(this.metadata)
      .where(eq(this.metadata.key, CONFIG_KEY));
    return rows.length > 0;
  }

  async get(): Promise<PolpoConfig | undefined> {
    const rows: any[] = await this.db.select().from(this.metadata)
      .where(eq(this.metadata.key, CONFIG_KEY));
    if (rows.length === 0) return undefined;
    return deserializeJson<PolpoConfig | undefined>(rows[0].value, undefined, this.dialect);
  }

  async save(config: PolpoConfig): Promise<void> {
    const value = JSON.stringify(config);
    await this.db.insert(this.metadata).values({ key: CONFIG_KEY, value })
      .onConflictDoUpdate({ target: this.metadata.key, set: { value } });
  }
}
