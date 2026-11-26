import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARK_LIMITS, type BenchmarkDefinition, type BenchmarkRun } from "@polpo-ai/core/agent-suites";

/** Where benchmark definitions and benchmark runs are kept. */
export interface BenchmarkStore {
  listDefinitions(): Promise<BenchmarkDefinition[]>;
  getDefinition(id: string): Promise<BenchmarkDefinition | undefined>;
  saveDefinition(def: BenchmarkDefinition): Promise<void>;
  deleteDefinition(id: string): Promise<boolean>;
  /** Newest first. */
  listRuns(opts?: { benchmarkId?: string; limit?: number }): Promise<BenchmarkRun[]>;
  getRun(id: string): Promise<BenchmarkRun | undefined>;
  saveRun(run: BenchmarkRun): Promise<void>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class InMemoryBenchmarkStore implements BenchmarkStore {
  private defs = new Map<string, BenchmarkDefinition>();
  private runs = new Map<string, BenchmarkRun>();
  async listDefinitions() { return [...this.defs.values()].map(clone); }
  async getDefinition(id: string) { const d = this.defs.get(id); return d ? clone(d) : undefined; }
  async saveDefinition(def: BenchmarkDefinition) { this.defs.set(def.id, clone(def)); }
  async deleteDefinition(id: string) { return this.defs.delete(id); }
  async listRuns(opts: { benchmarkId?: string; limit?: number } = {}) {
    return [...this.runs.values()].filter((r) => !opts.benchmarkId || r.benchmarkId === opts.benchmarkId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, opts.limit ?? BENCHMARK_LIMITS.runsKept).map(clone);
  }
  async getRun(id: string) { const r = this.runs.get(id); return r ? clone(r) : undefined; }
  async saveRun(run: BenchmarkRun) {
    this.runs.set(run.id, clone(run));
    const all = [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const old of all.slice(BENCHMARK_LIMITS.runsKept)) if (old.status !== "running" && old.status !== "queued") this.runs.delete(old.id);
  }
}

/**
 * File-based BenchmarkStore under `.polpo/benchmarks/`:
 *   definitions/<id>.json  a saved benchmark (suites, variants, repetitions, budget, weights)
 *   runs/<id>.json         one benchmark run (its suite runs by id, progress, the leaderboard); the newest {@link BENCHMARK_LIMITS.runsKept} kept
 * The suite runs themselves stay with their suites (.polpo/agent-suites/<agent>/runs/, benchmarkRunId set).
 */
export class FileBenchmarkStore implements BenchmarkStore {
  private readonly dir: string;
  constructor(polpoDir: string) { this.dir = join(polpoDir, "benchmarks"); }

  private get defsDir() { return join(this.dir, "definitions"); }
  private get runsDir() { return join(this.dir, "runs"); }

  private static read<T>(path: string): T | undefined {
    try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return undefined; }
  }
  private static write(dir: string, file: string, value: unknown): void {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  }
  private static files(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  async listDefinitions(): Promise<BenchmarkDefinition[]> {
    return FileBenchmarkStore.files(this.defsDir).map((f) => FileBenchmarkStore.read<BenchmarkDefinition>(join(this.defsDir, f))).filter((d): d is BenchmarkDefinition => !!d);
  }
  async getDefinition(id: string) { return FileBenchmarkStore.read<BenchmarkDefinition>(join(this.defsDir, `${encodeURIComponent(id)}.json`)); }
  async saveDefinition(def: BenchmarkDefinition) { FileBenchmarkStore.write(this.defsDir, `${encodeURIComponent(def.id)}.json`, def); }
  async deleteDefinition(id: string) {
    const path = join(this.defsDir, `${encodeURIComponent(id)}.json`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  private allRuns(): BenchmarkRun[] {
    return FileBenchmarkStore.files(this.runsDir).map((f) => FileBenchmarkStore.read<BenchmarkRun>(join(this.runsDir, f)))
      .filter((r): r is BenchmarkRun => !!r).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async listRuns(opts: { benchmarkId?: string; limit?: number } = {}) {
    return this.allRuns().filter((r) => !opts.benchmarkId || r.benchmarkId === opts.benchmarkId).slice(0, Math.max(1, opts.limit ?? BENCHMARK_LIMITS.runsKept));
  }
  async getRun(id: string) { return FileBenchmarkStore.read<BenchmarkRun>(join(this.runsDir, `${encodeURIComponent(id)}.json`)); }
  async saveRun(run: BenchmarkRun) {
    const isNew = !existsSync(join(this.runsDir, `${encodeURIComponent(run.id)}.json`));
    FileBenchmarkStore.write(this.runsDir, `${encodeURIComponent(run.id)}.json`, run);
    if (!isNew) return;
    for (const old of this.allRuns().slice(BENCHMARK_LIMITS.runsKept)) {
      if (old.status === "running" || old.status === "queued") continue;
      rmSync(join(this.runsDir, `${encodeURIComponent(old.id)}.json`), { force: true });
    }
  }
}
