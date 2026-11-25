import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUITE_LIMITS, type AgentSuite, type AgentSuiteStore, type SuiteRun, type SuiteRunListOptions } from "@polpo-ai/core/agent-suites";

/**
 * File-based AgentSuiteStore, per agent under `.polpo/agent-suites/<agent>/`:
 *   suites/<id>.json   one suite (cases, datasets, mocks)
 *   runs/<id>.json     one run (results with their traces); the newest {@link SUITE_LIMITS.runsKept} kept
 */
export class FileAgentSuiteStore implements AgentSuiteStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "agent-suites");
  }

  private agentDir(agent: string): string { return join(this.dir, encodeURIComponent(agent)); }
  private suitesDir(agent: string): string { return join(this.agentDir(agent), "suites"); }
  private runsDir(agent: string): string { return join(this.agentDir(agent), "runs"); }

  private static readJson<T>(path: string): T | undefined {
    try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return undefined; }
  }

  private static writeJson(dir: string, file: string, value: unknown): void {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  }

  private static jsonFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  }

  async listSuites(agent: string): Promise<AgentSuite[]> {
    const dir = this.suitesDir(agent);
    return FileAgentSuiteStore.jsonFiles(dir).map((f) => FileAgentSuiteStore.readJson<AgentSuite>(join(dir, f))).filter((s): s is AgentSuite => !!s);
  }

  async getSuite(agent: string, id: string): Promise<AgentSuite | undefined> {
    return FileAgentSuiteStore.readJson<AgentSuite>(join(this.suitesDir(agent), `${encodeURIComponent(id)}.json`));
  }

  async saveSuite(suite: AgentSuite): Promise<void> {
    FileAgentSuiteStore.writeJson(this.suitesDir(suite.agent), `${encodeURIComponent(suite.id)}.json`, suite);
  }

  async deleteSuite(agent: string, id: string): Promise<boolean> {
    const path = join(this.suitesDir(agent), `${encodeURIComponent(id)}.json`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  private allRuns(agent: string): SuiteRun[] {
    const dir = this.runsDir(agent);
    return FileAgentSuiteStore.jsonFiles(dir)
      .map((f) => FileAgentSuiteStore.readJson<SuiteRun>(join(dir, f)))
      .filter((r): r is SuiteRun => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async listRuns(agent: string, opts: SuiteRunListOptions = {}): Promise<SuiteRun[]> {
    return this.allRuns(agent)
      .filter((r) => (!opts.suiteId || r.suiteId === opts.suiteId) && (!opts.benchmarkRunId || r.benchmarkRunId === opts.benchmarkRunId))
      .slice(0, Math.max(1, opts.limit ?? SUITE_LIMITS.runsKept));
  }

  async getRun(agent: string, id: string): Promise<SuiteRun | undefined> {
    return FileAgentSuiteStore.readJson<SuiteRun>(join(this.runsDir(agent), `${encodeURIComponent(id)}.json`));
  }

  async saveRun(run: SuiteRun): Promise<void> {
    const dir = this.runsDir(run.agent);
    const isNew = !existsSync(join(dir, `${encodeURIComponent(run.id)}.json`));
    FileAgentSuiteStore.writeJson(dir, `${encodeURIComponent(run.id)}.json`, run);
    if (!isNew) return;
    // keep the newest runs only (finished ones are dropped first; a running one is never dropped)
    const runs = this.allRuns(run.agent);
    for (const old of runs.slice(SUITE_LIMITS.runsKept)) {
      if (old.status === "running" || old.status === "queued") continue;
      rmSync(join(dir, `${encodeURIComponent(old.id)}.json`), { force: true });
    }
  }

  async deleteAgent(agent: string): Promise<void> {
    rmSync(this.agentDir(agent), { recursive: true, force: true });
  }
}
