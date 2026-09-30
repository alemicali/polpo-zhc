import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrainChangeEmitter, CompanyBrainSnapshot } from "../core/company-brain.js";

const EMPTY: CompanyBrainSnapshot = {
  version: 1,
  entities: [],
  relations: [],
  claims: [],
  grants: [],
  runs: [],
  activity: [],
};

export class FileCompanyBrainStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(polpoDir: string, private emitChange?: BrainChangeEmitter) {
    this.path = join(polpoDir, "company-brain.json");
  }

  setEmitter(emitChange?: BrainChangeEmitter): void {
    if (emitChange) this.emitChange = emitChange;
  }

  async snapshot(): Promise<CompanyBrainSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<CompanyBrainSnapshot>;
      return {
        version: 1,
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        claims: Array.isArray(parsed.claims) ? parsed.claims : [],
        grants: Array.isArray(parsed.grants) ? parsed.grants : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  async transaction<T>(change: (snapshot: CompanyBrainSnapshot) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.writeQueue.then(async () => {
      const snapshot = await this.snapshot();
      result = await change(snapshot);
      snapshot.runs = snapshot.runs.slice(0, 250);
      snapshot.activity = snapshot.activity.slice(0, 2_000);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  emit(event: Omit<Parameters<BrainChangeEmitter>[0], "timestamp">): void {
    this.emitChange?.({ ...event, timestamp: new Date().toISOString() });
  }
}
