import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  tokenUsageRangeStart,
  type TokenUsageRange,
  type TokenUsageRecord,
  type TokenUsageStore,
} from "@polpo-ai/core/token-usage";

export type { TokenUsageRange } from "@polpo-ai/core/token-usage";

export interface TaskTokenEvent {
  timestamp: string;
  totalTokens: number;
}

interface CachedTaskLog {
  fingerprint: string;
  events: TaskTokenEvent[];
}

const taskLogCache = new Map<string, Map<string, CachedTaskLog>>();

export class FileTokenUsageStore implements TokenUsageStore {
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
    const cutoff = tokenUsageRangeStart(range);
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
    return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}

function parseTaskTokenEvents(content: string): TaskTokenEvent[] {
  const events: TaskTokenEvent[] = [];
  let previousTotal = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { ts?: string; event?: string; data?: { totalTokens?: number } };
      if (record.event !== "activity" || !record.ts) continue;
      const currentTotal = Number(record.data?.totalTokens) || 0;
      if (currentTotal <= 0 || currentTotal === previousTotal) continue;
      const delta = currentTotal > previousTotal ? currentTotal - previousTotal : currentTotal;
      previousTotal = currentTotal;
      if (delta > 0) events.push({ timestamp: record.ts, totalTokens: delta });
    } catch {
      // Ignore partial or unrelated log records.
    }
  }
  return events;
}

/** Read cumulative task activity logs as timestamped token deltas. */
export async function readTaskTokenEvents(polpoDir: string): Promise<TaskTokenEvent[]> {
  const logsDir = join(polpoDir, "logs");
  let files: string[];
  try {
    files = (await readdir(logsDir)).filter((file) => file.startsWith("run-") && file.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const cache = taskLogCache.get(logsDir) ?? new Map<string, CachedTaskLog>();
  taskLogCache.set(logsDir, cache);
  const present = new Set(files);
  for (const cachedFile of cache.keys()) {
    if (!present.has(cachedFile)) cache.delete(cachedFile);
  }

  await Promise.all(files.map(async (file) => {
    const path = join(logsDir, file);
    const metadata = await stat(path).catch(() => null);
    if (!metadata) return;
    const fingerprint = `${metadata.size}:${metadata.mtimeMs}`;
    if (cache.get(file)?.fingerprint === fingerprint) return;
    const content = await readFile(path, "utf8").catch(() => "");
    cache.set(file, { fingerprint, events: parseTaskTokenEvents(content) });
  }));

  return [...cache.values()].flatMap((entry) => entry.events);
}
