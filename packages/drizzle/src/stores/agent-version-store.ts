import { and, desc, eq } from "drizzle-orm";
import type {
  AgentDeployEntry, AgentDraft, AgentPointer, AgentVersion, AgentVersionStore,
} from "@polpo-ai/core/agent-versions";
import { type Dialect, serializeJson, deserializeJson, isUniqueViolation } from "../utils.js";

type AnyTable = any;

/** Agent versions, drafts, pointers and deploy history in SQLite / PostgreSQL. */
export class DrizzleAgentVersionStore implements AgentVersionStore {
  constructor(
    private db: any,
    private tables: { versions: AnyTable; drafts: AnyTable; pointers: AnyTable; deploys: AnyTable },
    private dialect: Dialect,
  ) {}

  async listVersions(agent: string): Promise<AgentVersion[]> {
    const t = this.tables.versions;
    const rows: any[] = await this.db.select().from(t).where(eq(t.agentName, agent));
    return rows.map((r) => deserializeJson<AgentVersion>(r.data, undefined as never, this.dialect))
      .filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getVersion(agent: string, version: string): Promise<AgentVersion | undefined> {
    const t = this.tables.versions;
    const rows: any[] = await this.db.select().from(t).where(and(eq(t.agentName, agent), eq(t.version, version)));
    return rows[0] ? deserializeJson<AgentVersion>(rows[0].data, undefined as never, this.dialect) : undefined;
  }

  async addVersion(version: AgentVersion): Promise<void> {
    try {
      await this.db.insert(this.tables.versions).values({
        agentName: version.agent,
        version: version.version,
        data: serializeJson(version, this.dialect),
        createdAt: version.createdAt,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`Version ${version.version} of ${version.agent} already exists`);
      throw err;
    }
  }

  async getDraft(agent: string): Promise<AgentDraft | undefined> {
    const t = this.tables.drafts;
    const rows: any[] = await this.db.select().from(t).where(eq(t.agentName, agent));
    return rows[0] ? deserializeJson<AgentDraft>(rows[0].data, undefined as never, this.dialect) : undefined;
  }

  async saveDraft(draft: AgentDraft): Promise<void> {
    const t = this.tables.drafts;
    const values = { agentName: draft.agent, data: serializeJson(draft, this.dialect), updatedAt: draft.updatedAt };
    await this.db.insert(t).values(values).onConflictDoUpdate({
      target: t.agentName,
      set: { data: values.data, updatedAt: values.updatedAt },
    });
  }

  async deleteDraft(agent: string): Promise<void> {
    const t = this.tables.drafts;
    await this.db.delete(t).where(eq(t.agentName, agent));
  }

  async getPointers(agent: string): Promise<AgentPointer[]> {
    const t = this.tables.pointers;
    const rows: any[] = await this.db.select().from(t).where(eq(t.agentName, agent));
    return rows.map((r) => ({ agent: r.agentName, pointer: r.pointer, version: r.version, updatedAt: r.updatedAt, updatedBy: r.updatedBy }));
  }

  async setPointer(p: AgentPointer): Promise<void> {
    const t = this.tables.pointers;
    await this.db.insert(t).values({
      agentName: p.agent, pointer: p.pointer, version: p.version, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
    }).onConflictDoUpdate({
      target: [t.agentName, t.pointer],
      set: { version: p.version, updatedAt: p.updatedAt, updatedBy: p.updatedBy },
    });
  }

  async addDeploy(e: AgentDeployEntry): Promise<void> {
    await this.db.insert(this.tables.deploys).values({
      id: e.id, agentName: e.agent, pointer: e.pointer, fromVersion: e.from ?? null, toVersion: e.to,
      action: e.action, actor: e.actor, note: e.note ?? null, at: e.at,
    });
  }

  async listDeploys(agent: string, limit?: number): Promise<AgentDeployEntry[]> {
    const t = this.tables.deploys;
    let q = this.db.select().from(t).where(eq(t.agentName, agent)).orderBy(desc(t.at), desc(t.id));
    if (limit) q = q.limit(limit);
    const rows: any[] = await q;
    return rows.map((r) => ({
      id: r.id, agent: r.agentName, pointer: r.pointer, ...(r.fromVersion ? { from: r.fromVersion } : {}), to: r.toVersion,
      action: r.action, actor: r.actor, ...(r.note ? { note: r.note } : {}), at: r.at,
    }));
  }

  async deleteAgent(agent: string): Promise<void> {
    await this.db.delete(this.tables.versions).where(eq(this.tables.versions.agentName, agent));
    await this.db.delete(this.tables.drafts).where(eq(this.tables.drafts.agentName, agent));
    await this.db.delete(this.tables.pointers).where(eq(this.tables.pointers.agentName, agent));
    await this.db.delete(this.tables.deploys).where(eq(this.tables.deploys.agentName, agent));
  }
}
