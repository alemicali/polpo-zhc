import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageNodeState, ImageNodeStore } from "@polpo-ai/core/media";

/**
 * Mission image nodes' state (generating, done, failed) in `.polpo/media/nodes.json`, so an image
 * made for a mission survives a restart. Per-instance like the media log, whatever the instance's store.
 */
export class FileImageNodeStore implements ImageNodeStore {
  private readonly file: string;

  constructor(polpoDir: string) {
    this.file = join(polpoDir, "media", "nodes.json");
  }

  async load(): Promise<Record<string, ImageNodeState>> {
    try {
      if (!existsSync(this.file)) return {};
      const data = JSON.parse(readFileSync(this.file, "utf-8")) as { nodes?: Record<string, ImageNodeState> };
      return data.nodes && typeof data.nodes === "object" ? data.nodes : {};
    } catch {
      return {};
    }
  }

  async save(state: Record<string, ImageNodeState>): Promise<void> {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, nodes: state }, null, 2));
      renameSync(tmp, this.file);
    } catch { /* best-effort, like checkpoints and delays */ }
  }
}
