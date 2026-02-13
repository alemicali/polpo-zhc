import type { SessionSummary } from "../core/session-reader.js";

// --- Config ---

export interface BridgeConfig {
  enabled: boolean;
  mode: "read-only";
  watch: {
    claudeCode: boolean;
    opencode: boolean;
    paths: string[];
  };
  /** Polling interval in ms (default 5000). */
  pollInterval: number;
  /** Inactivity threshold in ms before marking session completed (default 60000). */
  sessionTimeout: number;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  enabled: true,
  mode: "read-only",
  watch: {
    claudeCode: true,
    opencode: false,
    paths: [],
  },
  pollInterval: 5000,
  sessionTimeout: 60_000,
};

// --- Session state ---

export type BridgeSessionStatus = "active" | "idle" | "completed";

export interface BridgeSessionState {
  sessionId: string;
  transcriptPath: string;
  projectPath: string;
  status: BridgeSessionStatus;
  discoveredAt: number;
  lastActivityAt: number;
  lastFileSize: number;
  summary: SessionSummary | null;
}
