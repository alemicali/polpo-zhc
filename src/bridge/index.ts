import { TypedEmitter } from "../core/events.js";
import { SessionWatcher } from "./watcher.js";
import { SessionTracker } from "./tracker.js";
import type { BridgeConfig, BridgeSessionState } from "./types.js";
import { DEFAULT_BRIDGE_CONFIG } from "./types.js";

export { SessionWatcher } from "./watcher.js";
export { SessionTracker, decodeProjectDir } from "./tracker.js";
export { DEFAULT_BRIDGE_CONFIG } from "./types.js";
export type { BridgeConfig, BridgeSessionState, BridgeSessionStatus } from "./types.js";

/**
 * BridgeManager — facade that composes SessionWatcher + SessionTracker.
 *
 * Can work standalone (creates its own TypedEmitter) or be wired into
 * an existing Orchestrator's emitter for integrated mode.
 */
export class BridgeManager {
  readonly watcher: SessionWatcher;
  readonly tracker: SessionTracker;
  readonly emitter: TypedEmitter;
  private readonly config: BridgeConfig;

  constructor(config?: Partial<BridgeConfig>, emitter?: TypedEmitter) {
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
    this.emitter = emitter ?? new TypedEmitter();
    this.watcher = new SessionWatcher(this.config);
    this.tracker = new SessionTracker(this.config);

    // Wire watcher → tracker
    this.watcher.on("file:discovered", ({ transcriptPath, projectDir, fileSize }) => {
      this.tracker.handleDiscovered(transcriptPath, projectDir, fileSize);
    });
    this.watcher.on("file:updated", ({ transcriptPath, projectDir, fileSize }) => {
      this.tracker.handleUpdated(transcriptPath, projectDir, fileSize);
    });

    // Wire tracker → emitter (forward bridge events)
    for (const event of [
      "bridge:session:discovered",
      "bridge:session:activity",
      "bridge:session:completed",
    ] as const) {
      this.tracker.on(event, (payload: any) => {
        this.emitter.emit(event, payload);
      });
    }
  }

  start(): void {
    this.watcher.start();
    this.tracker.startTimeoutChecks();
  }

  stop(): void {
    this.watcher.stop();
    this.tracker.stopTimeoutChecks();
  }

  getSessions(): BridgeSessionState[] {
    return this.tracker.getSessions();
  }

  getStats() {
    return this.tracker.getStats();
  }
}
