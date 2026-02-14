import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ProjectConfig } from "../core/types.js";
import type { ConfigStore } from "../core/config-store.js";

/**
 * JSON-file backed ConfigStore.
 * Reads/writes `.polpo/config.json` (human-readable, hand-editable).
 */
export class JsonConfigStore implements ConfigStore {
  private readonly filePath: string;

  constructor(orchestraDir: string) {
    this.filePath = join(orchestraDir, "config.json");
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  get(): ProjectConfig | undefined {
    if (!this.exists()) return undefined;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.judge === "string" && typeof parsed.agent === "string") {
        return parsed as ProjectConfig;
      }
      return undefined;
    } catch { /* corrupt or unreadable config */
      return undefined;
    }
  }

  save(config: ProjectConfig): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(config, null, 2), "utf-8");
  }
}
