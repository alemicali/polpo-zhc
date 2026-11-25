import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TEST_HISTORY_LIMIT, type AgentTestRun, type AgentTestStore } from "@polpo-ai/core/agent-tests";

/**
 * File-based AgentTestStore: one JSON file per agent in `.polpo/agent-tests/<name>.json`, newest
 * run first, the last {@link AGENT_TEST_HISTORY_LIMIT} kept.
 */
export class FileAgentTestStore implements AgentTestStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "agent-tests");
  }

  private file(agent: string): string {
    return join(this.dir, `${encodeURIComponent(agent)}.json`);
  }

  private read(agent: string): AgentTestRun[] {
    const path = this.file(agent);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { runs?: AgentTestRun[] };
      return Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch { return []; }
  }

  async list(agent: string, limit = AGENT_TEST_HISTORY_LIMIT): Promise<AgentTestRun[]> {
    return this.read(agent).slice(0, Math.max(1, limit));
  }

  async get(agent: string, id: string): Promise<AgentTestRun | undefined> {
    return this.read(agent).find((r) => r.id === id);
  }

  async add(run: AgentTestRun): Promise<void> {
    const runs = [run, ...this.read(run.agent).filter((r) => r.id !== run.id)].slice(0, AGENT_TEST_HISTORY_LIMIT);
    mkdirSync(this.dir, { recursive: true });
    const path = this.file(run.agent);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs }, null, 2));
    renameSync(tmp, path);
  }

  async deleteAgent(agent: string): Promise<void> {
    rmSync(this.file(agent), { force: true });
  }
}
