import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentVersionError,
  type AgentDeployEntry, type AgentDraft, type AgentPointer, type AgentVersion, type AgentVersionStore,
} from "@polpo-ai/core/agent-versions";

interface AgentVersionFile {
  versions: AgentVersion[];
  draft?: AgentDraft;
  pointers: AgentPointer[];
  /** Oldest first. */
  deploys: AgentDeployEntry[];
}

/**
 * File-based AgentVersionStore: one JSON file per agent in `.polpo/agent-versions/<name>.json`
 * (versions, draft, pointers, deploy history).
 */
export class FileAgentVersionStore implements AgentVersionStore {
  private readonly dir: string;
  private readonly cache = new Map<string, AgentVersionFile>();

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "agent-versions");
  }

  private file(agent: string): string {
    return join(this.dir, `${encodeURIComponent(agent)}.json`);
  }

  private read(agent: string): AgentVersionFile {
    const cached = this.cache.get(agent);
    if (cached) return cached;
    let data: AgentVersionFile = { versions: [], pointers: [], deploys: [] };
    const path = this.file(agent);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentVersionFile>;
        data = { versions: parsed.versions ?? [], pointers: parsed.pointers ?? [], deploys: parsed.deploys ?? [], ...(parsed.draft ? { draft: parsed.draft } : {}) };
      } catch { /* a broken file starts over: never block the agent */ }
    }
    this.cache.set(agent, data);
    return data;
  }

  private write(agent: string, data: AgentVersionFile): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(agent);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, path);
    this.cache.set(agent, data);
  }

  async listVersions(agent: string): Promise<AgentVersion[]> { return [...this.read(agent).versions]; }

  async getVersion(agent: string, version: string): Promise<AgentVersion | undefined> {
    return this.read(agent).versions.find((v) => v.version === version);
  }

  async addVersion(version: AgentVersion): Promise<void> {
    const data = this.read(version.agent);
    if (data.versions.some((v) => v.version === version.version)) {
      throw new AgentVersionError(`Version ${version.version} of ${version.agent} already exists`, "CONFLICT");
    }
    this.write(version.agent, { ...data, versions: [...data.versions, version] });
  }

  async getDraft(agent: string): Promise<AgentDraft | undefined> { return this.read(agent).draft; }

  async saveDraft(draft: AgentDraft): Promise<void> {
    this.write(draft.agent, { ...this.read(draft.agent), draft });
  }

  async deleteDraft(agent: string): Promise<void> {
    const data = this.read(agent);
    if (!data.draft) return;
    const { draft: _draft, ...rest } = data;
    this.write(agent, rest);
  }

  async getPointers(agent: string): Promise<AgentPointer[]> { return [...this.read(agent).pointers]; }

  async setPointer(p: AgentPointer): Promise<void> {
    const data = this.read(p.agent);
    this.write(p.agent, { ...data, pointers: [...data.pointers.filter((x) => x.pointer !== p.pointer), p] });
  }

  async addDeploy(entry: AgentDeployEntry): Promise<void> {
    const data = this.read(entry.agent);
    this.write(entry.agent, { ...data, deploys: [...data.deploys, entry] });
  }

  async listDeploys(agent: string, limit?: number): Promise<AgentDeployEntry[]> {
    const list = [...this.read(agent).deploys].reverse();
    return limit ? list.slice(0, limit) : list;
  }

  async deleteAgent(agent: string): Promise<void> {
    this.cache.delete(agent);
    rmSync(this.file(agent), { force: true });
  }
}
