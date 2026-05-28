import { eq } from "drizzle-orm";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

/**
 * Shape mirrors the CodingSessionStore interface from the polpo shell layer.
 * We declare it locally so this package stays decoupled from the shell.
 */
export interface CodingSessionState {
  workspaces: unknown[];
  terminals: unknown[];
  codeServers: unknown[];
  activeId: string;
}

export interface CodingSessionStoreLike {
  getState(): Promise<{ state: CodingSessionState; initialized: boolean }>;
  saveState(state: CodingSessionState): Promise<CodingSessionState>;
}

type AnyTable = any;

const SINGLETON_ID = "default";

/**
 * Single-row Drizzle backing for the Coding page workspace/session blob.
 *
 * Calling `saveState` upserts the row keyed by `SINGLETON_ID` — the table
 * could grow to multi-user later by varying the id (e.g. user/session key)
 * without a schema change.
 */
export class DrizzleCodingSessionStore implements CodingSessionStoreLike {
  constructor(
    private db: any,
    private codingSessions: AnyTable,
    private dialect: Dialect,
  ) {}

  async getState(): Promise<{ state: CodingSessionState; initialized: boolean }> {
    const rows: any[] = await this.db.select().from(this.codingSessions)
      .where(eq(this.codingSessions.id, SINGLETON_ID));
    if (rows.length === 0) {
      return { state: defaultState(), initialized: false };
    }
    const row = rows[0];
    const state = deserializeJson<CodingSessionState>(row.state, defaultState(), this.dialect);
    // SQLite returns 0/1 for boolean mode; pg returns a real boolean.
    const initialized = row.initialized === true || row.initialized === 1;
    return { state, initialized };
  }

  async saveState(state: CodingSessionState): Promise<CodingSessionState> {
    const now = new Date().toISOString();
    const stateValue = serializeJson(state, this.dialect);
    // Drizzle insert + onConflictDoUpdate works on both PG and SQLite.
    await this.db.insert(this.codingSessions).values({
      id: SINGLETON_ID,
      state: stateValue,
      initialized: true,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: this.codingSessions.id,
      set: { state: stateValue, initialized: true, updatedAt: now },
    });
    return state;
  }
}

function defaultState(): CodingSessionState {
  return { workspaces: [], terminals: [], codeServers: [], activeId: "" };
}
