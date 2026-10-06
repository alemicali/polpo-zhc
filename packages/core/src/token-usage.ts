/** LLM usage of one model call (chat turns and background continuations), for cost reporting. */
export interface TokenUsageRecord {
  timestamp: string;
  source: "orchestrator_chat" | "agent_chat" | "background_wait";
  provider?: string;
  model?: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export type TokenUsageRange = "today" | "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<Exclude<TokenUsageRange, "all" | "today">, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

/** Epoch millis of the start of a range ("today" = local midnight, "all" = 0). */
export function tokenUsageRangeStart(range: TokenUsageRange, now = Date.now()): number {
  if (range === "all") return 0;
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  return now - RANGE_MS[range];
}

export interface TokenUsageStore {
  record(record: TokenUsageRecord): Promise<void>;
  /** Records in the range, oldest first. */
  list(range: TokenUsageRange): Promise<TokenUsageRecord[]>;
}
