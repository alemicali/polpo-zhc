import { EventEmitter } from "node:events";
import { readSessionSummaryFromPath } from "../core/session-reader.js";
import type { BridgeSessionState, BridgeConfig } from "./types.js";
import type { PolpoEventMap } from "../core/events.js";

/**
 * Decode Claude Code's project directory encoding back to a readable path.
 * `-home-user-my-project` → `/home/user/my-project`
 */
export function decodeProjectDir(encoded: string): string {
  // Claude Code encodes: /home/user/foo → -home-user-foo
  // The leading dash represents the root /, subsequent dashes are path separators
  if (!encoded.startsWith("-")) return encoded;
  return encoded.replace(/-/g, "/");
}

type BridgeEvent = Extract<keyof PolpoEventMap, `bridge:${string}`>;
type BridgePayload<K extends BridgeEvent> = PolpoEventMap[K];

/**
 * Maintains state for all discovered sessions.
 * Receives file events from SessionWatcher, parses transcripts,
 * manages session lifecycle (active → idle → completed).
 */
export class SessionTracker extends EventEmitter {
  private readonly sessions = new Map<string, BridgeSessionState>();
  private readonly config: BridgeConfig;
  private timeoutTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BridgeConfig) {
    super();
    this.config = config;
  }

  /** Handle a newly discovered transcript file. */
  handleDiscovered(transcriptPath: string, projectDir: string, fileSize: number): void {
    const summary = readSessionSummaryFromPath(transcriptPath);
    const sessionId = summary?.sessionId ?? transcriptPath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";
    const projectPath = decodeProjectDir(projectDir);
    const now = Date.now();

    const state: BridgeSessionState = {
      sessionId,
      transcriptPath,
      projectPath,
      status: "active",
      discoveredAt: now,
      lastActivityAt: now,
      lastFileSize: fileSize,
      summary,
    };

    this.sessions.set(transcriptPath, state);

    this.emitBridge("bridge:session:discovered", {
      sessionId,
      projectPath,
      transcriptPath,
    });

    if (summary) {
      this.emitBridge("bridge:session:activity", {
        sessionId,
        projectPath,
        messageCount: summary.messageCount,
        toolCalls: summary.toolCalls,
        filesCreated: summary.filesCreated,
        filesEdited: summary.filesEdited,
        lastMessage: summary.lastMessage,
      });
    }
  }

  /** Handle an updated (grown) transcript file. */
  handleUpdated(transcriptPath: string, _projectDir: string, fileSize: number): void {
    const state = this.sessions.get(transcriptPath);
    if (!state) return;

    const summary = readSessionSummaryFromPath(transcriptPath);
    const now = Date.now();

    state.lastActivityAt = now;
    state.lastFileSize = fileSize;
    state.summary = summary;
    state.status = "active";

    if (summary) {
      this.emitBridge("bridge:session:activity", {
        sessionId: state.sessionId,
        projectPath: state.projectPath,
        messageCount: summary.messageCount,
        toolCalls: summary.toolCalls,
        filesCreated: summary.filesCreated,
        filesEdited: summary.filesEdited,
        lastMessage: summary.lastMessage,
      });
    }
  }

  /** Check all sessions for inactivity timeout. */
  checkTimeouts(): void {
    const now = Date.now();
    for (const [, state] of this.sessions) {
      if (state.status === "completed") continue;

      const idle = now - state.lastActivityAt;
      if (idle >= this.config.sessionTimeout) {
        state.status = "completed";
        const duration = state.lastActivityAt - state.discoveredAt;

        this.emitBridge("bridge:session:completed", {
          sessionId: state.sessionId,
          projectPath: state.projectPath,
          summary: state.summary,
          duration,
        });
      } else if (idle >= this.config.sessionTimeout / 2 && state.status === "active") {
        state.status = "idle";
      }
    }
  }

  /** Start timeout checking loop. */
  startTimeoutChecks(): void {
    if (this.timeoutTimer) return;
    this.timeoutTimer = setInterval(() => this.checkTimeouts(), this.config.pollInterval);
  }

  /** Stop timeout checking loop. */
  stopTimeoutChecks(): void {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  getSessions(): BridgeSessionState[] {
    return [...this.sessions.values()];
  }

  getSession(transcriptPath: string): BridgeSessionState | undefined {
    return this.sessions.get(transcriptPath);
  }

  getStats(): { total: number; active: number; idle: number; completed: number } {
    let active = 0, idle = 0, completed = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "active") active++;
      else if (s.status === "idle") idle++;
      else completed++;
    }
    return { total: this.sessions.size, active, idle, completed };
  }

  private emitBridge<K extends BridgeEvent>(event: K, payload: BridgePayload<K>): void {
    this.emit(event, payload);
  }
}
