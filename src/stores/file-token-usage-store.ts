import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TokenUsageRecord } from "@polpo-ai/server";

export type TokenUsageRange = "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<Exclude<TokenUsageRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

export class FileTokenUsageStore {
  private readonly usageDir: string;

  constructor(polpoDir: string) {
    this.usageDir = join(polpoDir, "usage");
  }

  async record(record: TokenUsageRecord): Promise<void> {
    await mkdir(this.usageDir, { recursive: true });
    const day = record.timestamp.slice(0, 10);
    await appendFile(join(this.usageDir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  }

  async list(range: TokenUsageRange): Promise<TokenUsageRecord[]> {
    const cutoff = range === "all" ? 0 : Date.now() - RANGE_MS[range];
    let files: string[];
    try {
      files = (await readdir(this.usageDir)).filter((file) => file.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const records: TokenUsageRecord[] = [];
    for (const file of files) {
      const content = await readFile(join(this.usageDir, file), "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as TokenUsageRecord;
          if (Date.parse(record.timestamp) >= cutoff) records.push(record);
        } catch {
          // A partial final line must not hide valid metrics from other records.
        }
      }
    }
    return records;
  }
}
