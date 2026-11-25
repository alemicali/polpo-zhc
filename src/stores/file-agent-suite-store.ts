import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARK_LIMITS, DEPLOY_GATE_LIMITS, SUITE_LIMITS, suiteRunMatches, suiteRunsToDrop, type AgentDeployGate, type AgentSuite, type AgentSuiteStore, type SuiteCassetteRecord, type SuiteRun, type SuiteRunListOptions } from "@polpo-ai/core/agent-suites";

/**
 * File-based AgentSuiteStore, per agent under `.polpo/agent-suites/<agent>/`:
 *   suites/<id>.json   one suite (cases, datasets, mocks)
 *   runs/<id>.json     one run (results with their traces); the newest {@link SUITE_LIMITS.runsKept} kept, and marked baselines
 *   cassettes/<id>.json a recorded exchange (secrets redacted) replayed by a case
 *   gates/<id>.json    one deploy gate (the required suites run against a version); the newest {@link DEPLOY_GATE_LIMITS.kept} kept
 */
export class FileAgentSuiteStore implements AgentSuiteStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "agent-suites");
  }

  private agentDir(agent: string): string { return join(this.dir, encodeURIComponent(agent)); }
  private suitesDir(agent: string): string { return join(this.agentDir(agent), "suites"); }
  private runsDir(agent: string): string { return join(this.agentDir(agent), "runs"); }
  private gatesDir(agent: string): string { return join(this.agentDir(agent), "gates"); }

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
      .filter((r) => suiteRunMatches(r, opts))
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
    // keep the newest runs only, benchmark runs counted apart (a running one and a suite's marked baseline are never dropped)
    for (const id of suiteRunsToDrop(this.allRuns(run.agent), BENCHMARK_LIMITS.suiteRunsKept)) {
      rmSync(join(dir, `${encodeURIComponent(id)}.json`), { force: true });
    }
  }

  private allGates(agent: string): AgentDeployGate[] {
    const dir = this.gatesDir(agent);
    return FileAgentSuiteStore.jsonFiles(dir)
      .map((f) => FileAgentSuiteStore.readJson<AgentDeployGate>(join(dir, f)))
      .filter((g): g is AgentDeployGate => !!g)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async listGates(agent: string, opts: { version?: string; limit?: number } = {}): Promise<AgentDeployGate[]> {
    return this.allGates(agent).filter((g) => !opts.version || g.version === opts.version).slice(0, Math.max(1, opts.limit ?? DEPLOY_GATE_LIMITS.kept));
  }

  async getGate(agent: string, id: string): Promise<AgentDeployGate | undefined> {
    return FileAgentSuiteStore.readJson<AgentDeployGate>(join(this.gatesDir(agent), `${encodeURIComponent(id)}.json`));
  }

  async saveGate(gate: AgentDeployGate): Promise<void> {
    const dir = this.gatesDir(gate.agent);
    const isNew = !existsSync(join(dir, `${encodeURIComponent(gate.id)}.json`));
    FileAgentSuiteStore.writeJson(dir, `${encodeURIComponent(gate.id)}.json`, gate);
    if (!isNew) return;
    for (const old of this.allGates(gate.agent).slice(DEPLOY_GATE_LIMITS.kept)) {
      if (old.status === "running") continue;
      rmSync(join(dir, `${encodeURIComponent(old.id)}.json`), { force: true });
    }
  }

  private cassettesDir(agent: string): string { return join(this.agentDir(agent), "cassettes"); }

  async listCassettes(agent: string): Promise<SuiteCassetteRecord[]> {
    const dir = this.cassettesDir(agent);
    return FileAgentSuiteStore.jsonFiles(dir).map((f) => FileAgentSuiteStore.readJson<SuiteCassetteRecord>(join(dir, f))).filter((c): c is SuiteCassetteRecord => !!c);
  }

  async getCassette(agent: string, id: string): Promise<SuiteCassetteRecord | undefined> {
    return FileAgentSuiteStore.readJson<SuiteCassetteRecord>(join(this.cassettesDir(agent), `${encodeURIComponent(id)}.json`));
  }

  async saveCassette(cassette: SuiteCassetteRecord): Promise<void> {
    FileAgentSuiteStore.writeJson(this.cassettesDir(cassette.agent), `${encodeURIComponent(cassette.id)}.json`, cassette);
  }

  async deleteCassette(agent: string, id: string): Promise<boolean> {
    const path = join(this.cassettesDir(agent), `${encodeURIComponent(id)}.json`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  async deleteAgent(agent: string): Promise<void> {
    rmSync(this.agentDir(agent), { recursive: true, force: true });
  }
}
