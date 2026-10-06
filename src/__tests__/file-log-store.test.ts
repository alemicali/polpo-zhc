import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogStore } from "../stores/file-log-store.js";

describe("FileLogStore", () => {
  let dir: string;
  let logs: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-file-log-"));
    logs = join(dir, "logs");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const age = (file: string, days: number) => {
    const t = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    utimesSync(join(logs, file), t, t);
  };

  /** A finished session written by an earlier process. */
  const oldSession = (id: string, entries: number) => {
    const lines = [JSON.stringify({ _session: true, sessionId: id, startedAt: "2025-01-01T00:00:00Z" })];
    for (let i = 0; i < entries; i++) lines.push(JSON.stringify({ ts: "2025-01-01T00:00:00Z", event: "e", data: i }));
    writeFileSync(join(logs, `${id}.jsonl`), lines.join("\n") + "\n");
  };

  it("pruneBefore removes session files last written before the cutoff, never the current one or run transcripts", async () => {
    const store = new FileLogStore(dir);
    const current = await store.startSession();
    await store.append({ ts: new Date().toISOString(), event: "now", data: null });
    oldSession("oldSession1", 3);
    oldSession("newSession1", 1);
    writeFileSync(join(logs, "run-abc.jsonl"), "{}\n");
    age("oldSession1.jsonl", 40);
    age("newSession1.jsonl", 5);
    age("run-abc.jsonl", 400);
    age(`${current}.jsonl`, 400); // a long-running process: still never removed

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    expect(await store.pruneBefore(cutoff)).toEqual({ sessions: 1, entries: 3 });
    expect(existsSync(join(logs, "oldSession1.jsonl"))).toBe(false);
    expect(existsSync(join(logs, "newSession1.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "run-abc.jsonl"))).toBe(true);
    expect(existsSync(join(logs, `${current}.jsonl`))).toBe(true);
  });

  it("listSessions and prune ignore the run transcripts in the same directory", async () => {
    const store = new FileLogStore(dir);
    await store.startSession();
    for (let i = 0; i < 3; i++) writeFileSync(join(logs, `run-${i}.jsonl`), JSON.stringify({ _run: true }) + "\n");
    oldSession("older", 1);
    age("older.jsonl", 2);

    expect((await store.listSessions()).map((s) => s.sessionId)).not.toContain("run-0");
    expect(await store.listSessions()).toHaveLength(2);
    expect(await store.prune(1)).toBe(1);
    for (let i = 0; i < 3; i++) expect(existsSync(join(logs, `run-${i}.jsonl`))).toBe(true);
  });
});
