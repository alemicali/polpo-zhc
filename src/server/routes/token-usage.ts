import { OpenAPIHono } from "@hono/zod-openapi";
import type { RunStore } from "../../core/run-store.js";
import { FileTokenUsageStore, type TokenUsageRange } from "../../stores/file-token-usage-store.js";

const VALID_RANGES = new Set<TokenUsageRange>(["24h", "7d", "30d", "all"]);
const RANGE_MS: Record<Exclude<TokenUsageRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

export function tokenUsageRoutes(getPolpoDir: () => string, getRunStore: () => RunStore): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", async (c) => {
    const requested = c.req.query("range") as TokenUsageRange | undefined;
    const range = requested && VALID_RANGES.has(requested) ? requested : "7d";
    const records = await new FileTokenUsageStore(getPolpoDir()).list(range);
    const cutoff = range === "all" ? 0 : Date.now() - RANGE_MS[range];
    const runs = [
      ...await getRunStore().getActiveRuns(),
      ...await getRunStore().getTerminalRuns(),
    ].filter((run) => Date.parse(run.updatedAt) >= cutoff);

    const chat = records.reduce((total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
      totalTokens: total.totalTokens + record.totalTokens,
      cost: total.cost + record.cost,
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 });
    const taskTokens = runs.reduce((total, run) => total + (run.activity?.totalTokens ?? 0), 0);

    return c.json({
      ok: true,
      data: {
        range,
        ...chat,
        totalTokens: chat.totalTokens + taskTokens,
        taskTokens,
        calls: records.length,
      },
    });
  });

  return app;
}
