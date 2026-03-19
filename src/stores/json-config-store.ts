import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PolpoConfig, ProjectConfig } from "../core/types.js";
import type { ConfigStore } from "../core/config-store.js";

/**
 * JSON-file backed ConfigStore.
 * Reads/writes `.polpo/polpo.json`.
 */
export class PolpoConfigStore implements ConfigStore {
  private readonly filePath: string;

  constructor(polpoDir: string) {
    this.filePath = join(polpoDir, "polpo.json");
  }

  async exists(): Promise<boolean> {
    return existsSync(this.filePath);
  }

  async get(): Promise<PolpoConfig | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as PolpoConfig;
    } catch { return undefined; }
  }

  async save(config: PolpoConfig): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(config, null, 2), "utf-8");
  }
}

/**
 * Legacy JSON-file backed ConfigStore.
 * Reads/writes `config.json` directly in the given directory.
 */
export class JsonConfigStore {
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = join(dir, "config.json");
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  get(): ProjectConfig | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!parsed || typeof parsed !== "object") return undefined;
      if (typeof parsed.project !== "string") return undefined;
      return parsed as ProjectConfig;
    } catch { return undefined; }
  }

  save(config: ProjectConfig): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(config, null, 2), "utf-8");
  }
}
