import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One row in the sync history log. Append-only — rotate by truncating
 * the file when it grows past `MAX_ENTRIES` lines, keeping the most
 * recent ones. */
export type SyncHistoryEntry = {
  id: string;
  /** "push" | "pull" — direction. */
  direction: "push" | "pull";
  /** "copy" (update mode) | "sync" (replace mode). */
  mode: "copy" | "sync";
  startedAt: string;   // ISO
  endedAt: string;     // ISO
  durationMs: number;
  ok: boolean;
  /** Files actually transferred (rclone's `transfers`). */
  files: number;
  /** Bytes actually transferred. */
  bytes: number;
  /** Error message when ok=false. */
  error?: string;
};

const FILE_NAME = "sync-history.jsonl";
const MAX_ENTRIES = 500;

function historyPath(polpoDir: string): string {
  return join(polpoDir, FILE_NAME);
}

export function appendHistoryEntry(polpoDir: string, entry: SyncHistoryEntry): void {
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
  const file = historyPath(polpoDir);
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  // Best-effort cap. Read whole file and truncate to last MAX_ENTRIES rows.
  // Fast enough at ~500 lines; if this ever becomes a hotspot we can rotate
  // properly with rename.
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    if (lines.length > MAX_ENTRIES) {
      const kept = lines.slice(lines.length - MAX_ENTRIES);
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync(file, kept.join("\n") + "\n", "utf-8");
    }
  } catch { /* ignore */ }
}

export function readHistory(polpoDir: string, limit = 100): SyncHistoryEntry[] {
  const file = historyPath(polpoDir);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    return tail
      .map((l) => { try { return JSON.parse(l) as SyncHistoryEntry; } catch { return null; } })
      .filter((e): e is SyncHistoryEntry => !!e)
      .reverse(); // newest first
  } catch {
    return [];
  }
}
