/**
 * Formatters — single source of truth for styled text segments.
 * Every piece of UI uses Seg[] for styled output.
 */

import type { Seg } from "./store.js";
import type { TaskStatus } from "../core/types.js";

// ─── Segment factory ────────────────────────────────────

export const seg = (
  text: string,
  color?: string,
  bold?: boolean,
  dim?: boolean,
): Seg => ({ text, color, bold, dim });

// ─── Status display ─────────────────────────────────────

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "○",
  assigned: "◎",
  in_progress: "●",
  review: "◉",
  done: "✓",
  failed: "✗",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: "gray",
  assigned: "yellow",
  in_progress: "cyan",
  review: "magenta",
  done: "green",
  failed: "red",
};

export function statusIcon(status: TaskStatus): string {
  return STATUS_ICONS[status] ?? "?";
}

export function statusColor(status: TaskStatus): string {
  return STATUS_COLORS[status] ?? "white";
}

// ─── Time formatting ────────────────────────────────────

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ─── Provider labels ────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}
