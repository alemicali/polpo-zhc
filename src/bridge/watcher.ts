import { statSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import type { BridgeConfig } from "./types.js";

export interface WatcherEvents {
  "file:discovered": { transcriptPath: string; projectDir: string; fileSize: number };
  "file:updated": { transcriptPath: string; projectDir: string; fileSize: number; previousSize: number };
}

/**
 * Polling-based filesystem scanner for Claude Code session transcripts.
 *
 * Scans `~/.claude/projects/<encoded-cwd>/*.jsonl` for JSONL files.
 * Tracks file size (JSONL is append-only — size change = new content).
 * Emits "file:discovered" and "file:updated" events.
 */
export class SessionWatcher extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly knownFiles = new Map<string, number>(); // path → last known size
  private readonly config: BridgeConfig;

  constructor(config: BridgeConfig) {
    super();
    this.config = config;
  }

  /** Build list of directories to scan based on config. */
  getWatchPaths(): string[] {
    const paths: string[] = [];

    if (this.config.watch.claudeCode) {
      const claudeProjectsDir = join(homedir(), ".claude", "projects");
      if (existsSync(claudeProjectsDir)) {
        try {
          const dirs = readdirSync(claudeProjectsDir, { withFileTypes: true });
          for (const d of dirs) {
            if (d.isDirectory()) {
              paths.push(join(claudeProjectsDir, d.name));
            }
          }
        } catch { /* ignore permission errors */ }
      }
    }

    for (const p of this.config.watch.paths) {
      if (existsSync(p)) paths.push(p);
    }

    return paths;
  }

  /** Scan all watch paths for JSONL files. */
  private scan(): void {
    const watchPaths = this.getWatchPaths();

    for (const dir of watchPaths) {
      let entries: string[];
      try {
        entries = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
      } catch { continue; /* unreadable dir */ }

      for (const file of entries) {
        const fullPath = join(dir, file);
        let size: number;
        try {
          size = statSync(fullPath).size;
        } catch { continue; /* file vanished */ }

        if (size === 0) continue;

        const previousSize = this.knownFiles.get(fullPath);

        if (previousSize === undefined) {
          // New file discovered
          this.knownFiles.set(fullPath, size);
          this.emit("file:discovered", {
            transcriptPath: fullPath,
            projectDir: basename(dir),
            fileSize: size,
          });
        } else if (size > previousSize) {
          // File grew (new content appended)
          this.knownFiles.set(fullPath, size);
          this.emit("file:updated", {
            transcriptPath: fullPath,
            projectDir: basename(dir),
            fileSize: size,
            previousSize,
          });
        }
        // size === previousSize → no change, skip
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.scan(); // immediate first scan
    this.timer = setInterval(() => this.scan(), this.config.pollInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Number of known transcript files. */
  get knownFileCount(): number {
    return this.knownFiles.size;
  }
}
