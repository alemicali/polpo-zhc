import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskTokenEvents } from "../stores/file-token-usage-store.js";

describe("task token usage history", () => {
  test("converts cumulative activity snapshots into non-duplicated deltas", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-token-history-"));
    const logs = join(root, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "run-test.jsonl"), [
      JSON.stringify({ ts: "2026-07-01T10:00:00.000Z", event: "activity", data: { totalTokens: 0 } }),
      JSON.stringify({ ts: "2026-07-01T10:01:00.000Z", event: "activity", data: { totalTokens: 100 } }),
      JSON.stringify({ ts: "2026-07-01T10:02:00.000Z", event: "activity", data: { totalTokens: 100 } }),
      JSON.stringify({ ts: "2026-07-01T10:03:00.000Z", event: "activity", data: { totalTokens: 250 } }),
      "",
    ].join("\n"));

    try {
      expect(await readTaskTokenEvents(root)).toEqual([
        { timestamp: "2026-07-01T10:01:00.000Z", totalTokens: 100 },
        { timestamp: "2026-07-01T10:03:00.000Z", totalTokens: 150 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("GET /token-usage: range and taskId", () => {
  test("honors range (1h included), filters by task, and refuses an unknown range", async () => {
    const { tokenUsageRoutes } = await import("../server/routes/token-usage.js");
    const { FileTokenUsageStore } = await import("../stores/file-token-usage-store.js");
    const root = await mkdtemp(join(tmpdir(), "polpo-token-route-"));
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const MIN = 60_000;
    try {
      const store = new FileTokenUsageStore(root);
      const rec = (o: Record<string, unknown>) => ({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, cost: 0.01, ...o }) as any;
      await store.record(rec({ timestamp: ago(10 * MIN), source: "agent_harness", sessionId: "task-a", cost: 0.05 }));
      await store.record(rec({ timestamp: ago(3 * 60 * MIN), source: "agent_harness", sessionId: "task-a", cost: 0.02 }));
      await store.record(rec({ timestamp: ago(5 * MIN), source: "agent_harness", sessionId: "task-b", cost: 0.1 }));
      await store.record(rec({ timestamp: ago(5 * MIN), source: "agent_chat", sessionId: "chat-1", cost: 0.3 }));
      const logs = join(root, "logs");
      await mkdir(logs, { recursive: true });
      const runLog = (taskId: string, at: number, total: number) => [
        JSON.stringify({ _run: true, runId: `r-${taskId}`, taskId, agentName: "ada", startedAt: ago(at) }),
        JSON.stringify({ ts: ago(at), event: "activity", data: { totalTokens: total } }), "",
      ].join("\n");
      await writeFile(join(logs, "run-r-task-a.jsonl"), runLog("task-a", 10 * MIN, 500));
      await writeFile(join(logs, "run-r-task-b.jsonl"), runLog("task-b", 5 * MIN, 900));
      const app = tokenUsageRoutes(() => root, () => ({ getActiveRuns: async () => [], getTerminalRuns: async () => [] }) as any);
      const get = async (q: string) => { const r = await app.request(`/?${q}`); return { status: r.status, body: await r.json() as any }; };

      const all7d = (await get("")).body.data;
      expect(all7d).toMatchObject({ range: "7d", harnessCost: 0.17, taskTokens: 1400, calls: 4 });
      expect(all7d.cost).toBeCloseTo(0.47);

      const taskA = (await get("taskId=task-a")).body.data;
      expect(taskA).toMatchObject({ range: "7d", taskId: "task-a", taskTokens: 500, calls: 2, inputTokens: 0 });
      expect(taskA.harnessCost).toBeCloseTo(0.07);
      expect(taskA.cost).toBeCloseTo(0.07);

      const taskA1h = (await get("taskId=task-a&range=1h")).body.data;
      expect(taskA1h).toMatchObject({ range: "1h", taskTokens: 500, calls: 1, harnessCost: 0.05 });

      const bad = await get("range=1y");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/1h, today, 24h, 7d, 30d, all/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
