import { asc, gte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tokenUsageRangeStart, type TokenUsageRange, type TokenUsageRecord, type TokenUsageStore } from "@polpo-ai/core/token-usage";
import type { Dialect } from "../utils.js";

type AnyTable = any;

export class DrizzleTokenUsageStore implements TokenUsageStore {
  constructor(
    private db: any,
    private usage: AnyTable,
    private dialect: Dialect,
  ) {}

  async record(record: TokenUsageRecord): Promise<void> {
    await this.db.insert(this.usage).values({
      id: nanoid(),
      timestamp: record.timestamp,
      source: record.source,
      provider: record.provider ?? null,
      model: record.model ?? null,
      sessionId: record.sessionId ?? null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      totalTokens: record.totalTokens,
      cost: record.cost,
    });
  }

  async list(range: TokenUsageRange): Promise<TokenUsageRecord[]> {
    const start = new Date(tokenUsageRangeStart(range)).toISOString();
    const rows: any[] = await this.db.select().from(this.usage)
      .where(gte(this.usage.timestamp, start))
      .orderBy(asc(this.usage.timestamp));
    void this.dialect;
    return rows.map((r) => ({
      timestamp: r.timestamp,
      source: r.source,
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      totalTokens: Number(r.totalTokens),
      cost: Number(r.cost),
    }));
  }

  /** Bulk insert (used when moving usage/*.jsonl into the database). */
  async recordMany(records: TokenUsageRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += 500) {
      await this.db.insert(this.usage).values(records.slice(i, i + 500).map((record) => ({
        id: nanoid(),
        timestamp: record.timestamp,
        source: record.source,
        provider: record.provider ?? null,
        model: record.model ?? null,
        sessionId: record.sessionId ?? null,
        inputTokens: record.inputTokens ?? 0,
        outputTokens: record.outputTokens ?? 0,
        cacheReadTokens: record.cacheReadTokens ?? 0,
        cacheWriteTokens: record.cacheWriteTokens ?? 0,
        totalTokens: record.totalTokens ?? 0,
        cost: record.cost ?? 0,
      })));
    }
  }
}
