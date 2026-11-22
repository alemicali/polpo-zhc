import { OpenAPIHono } from "@hono/zod-openapi";
import { TOKEN_USAGE_RANGES, tokenUsageRangeStart } from "@polpo-ai/core/token-usage";
import type { RunStore } from "../../core/run-store.js";
import {
  FileTokenUsageStore,
  readTaskTokenEvents,
  type TokenUsageRange,
} from "../../stores/file-token-usage-store.js";
import { databaseStoresFor } from "../../core/storage.js";

const VALID_RANGES = new Set<string>(TOKEN_USAGE_RANGES);

/**
 * GET /token-usage?range=&taskId=
 * - range: 1h, today, 24h, 7d (default), 30d or all; anything else is a 400 (never a silent 7d).
 * - taskId: only that task: its runs' tokens (activity logs, else the run records) and its harness
 *   cost (agent_harness records carry the task id as their session). Chat usage belongs to no task.
 * - inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens: chats plus agent harness runs
 *   (the split each harness turn reports); a task on Polpo's engine records only its total.
 */
export function tokenUsageRoutes(getPolpoDir: () => string, getRunStore: () => RunStore): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", async (c) => {
    const requested = c.req.query("range");
    if (requested && !VALID_RANGES.has(requested)) {
      return c.json({ ok: false, error: `range must be one of ${TOKEN_USAGE_RANGES.join(", ")}` }, 400);
    }
    const range = (requested as TokenUsageRange | undefined) ?? "7d";
    const taskId = c.req.query("taskId")?.trim() || undefined;
    const store = databaseStoresFor(getPolpoDir())?.tokenUsageStore ?? new FileTokenUsageStore(getPolpoDir());
    const records = (await store.list(range)).filter((r) => !taskId || (r.source === "agent_harness" && r.sessionId === taskId));
    const cutoff = tokenUsageRangeStart(range);
    const taskEvents = (await readTaskTokenEvents(getPolpoDir()))
      .filter((event) => Date.parse(event.timestamp) >= cutoff && (!taskId || event.taskId === taskId));

    // agent harness runs (Claude Code, Codex) record their cost and their token split (input,
    // output, cache read/write); their total is counted with the tasks (taskTokens)
    const harness = records.filter((r) => r.source === "agent_harness").reduce((total, r) => ({
      inputTokens: total.inputTokens + (r.inputTokens || 0),
      outputTokens: total.outputTokens + (r.outputTokens || 0),
      cacheReadTokens: total.cacheReadTokens + (r.cacheReadTokens || 0),
      cacheWriteTokens: total.cacheWriteTokens + (r.cacheWriteTokens || 0),
      cost: total.cost + (r.cost || 0),
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
    const harnessCost = harness.cost;
    const chat = records.filter((r) => r.source !== "agent_harness").reduce((total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
      totalTokens: total.totalTokens + record.totalTokens,
      cost: total.cost + record.cost,
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 });
    let taskTokens = taskEvents.reduce((total, event) => total + event.totalTokens, 0);
    // Stores without filesystem activity logs still expose current run totals.
    if (taskEvents.length === 0) {
      const runs = [
        ...await getRunStore().getActiveRuns(),
        ...await getRunStore().getTerminalRuns(),
      ].filter((run) => Date.parse(run.updatedAt) >= cutoff && (!taskId || run.taskId === taskId));
      taskTokens = runs.reduce((total, run) => total + (run.activity?.totalTokens ?? 0), 0);
    }

    return c.json({
      ok: true,
      data: {
        range,
        ...(taskId ? { taskId } : {}),
        ...chat,
        inputTokens: chat.inputTokens + harness.inputTokens,
        outputTokens: chat.outputTokens + harness.outputTokens,
        cacheReadTokens: chat.cacheReadTokens + harness.cacheReadTokens,
        cacheWriteTokens: chat.cacheWriteTokens + harness.cacheWriteTokens,
        cost: chat.cost + harnessCost,
        totalTokens: chat.totalTokens + taskTokens,
        taskTokens,
        harnessCost,
        calls: records.length,
      },
    });
  });

  return app;
}
