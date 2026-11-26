import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionNodeState, DecisionNodeStore } from "@polpo-ai/core/decisions";

/**
 * Mission decision nodes' state (deciding, decided, waiting for a person) in
 * `.polpo/decisions/nodes.json`, so a decision taken (or waiting for a person) survives a restart.
 * Per-instance like the decision log, whatever the instance's store.
 */
export class FileDecisionNodeStore implements DecisionNodeStore {
  private readonly file: string;

  constructor(polpoDir: string) {
    this.file = join(polpoDir, "decisions", "nodes.json");
  }

  async load(): Promise<Record<string, DecisionNodeState>> {
    try {
      if (!existsSync(this.file)) return {};
      const data = JSON.parse(readFileSync(this.file, "utf-8")) as { nodes?: Record<string, DecisionNodeState> };
      return data.nodes && typeof data.nodes === "object" ? data.nodes : {};
    } catch {
      return {};
    }
  }

  async save(state: Record<string, DecisionNodeState>): Promise<void> {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, nodes: state }, null, 2));
      renameSync(tmp, this.file);
    } catch { /* best-effort, like checkpoints and delays */ }
  }
}
