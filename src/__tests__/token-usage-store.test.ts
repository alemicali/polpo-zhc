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
