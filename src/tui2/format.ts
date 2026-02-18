import chalk from "chalk";
import { theme, statusIcon, statusColor } from "./theme.js";

/** Format elapsed time from milliseconds */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs > 0 ? `${rs}s` : ""}`;
}

/** Format duration from milliseconds (longer form) */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  if (hr < 24) return `${hr}h ${rm}m`;
  const d = Math.floor(hr / 24);
  const rh = hr % 24;
  return `${d}d ${rh}h`;
}

/** Format token count (abbreviated) */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format a task status with icon and color */
export function formatStatus(status: string): string {
  const icon = statusIcon(status);
  const color = statusColor(status);
  return color(`${icon} ${status}`);
}

/** Get a human-readable provider label */
export function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    "google-vertex": "Vertex AI",
    "amazon-bedrock": "Bedrock",
    "azure-openai": "Azure",
    groq: "Groq",
    cerebras: "Cerebras",
    mistral: "Mistral",
    xai: "xAI",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    litellm: "LiteLLM",
  };
  return labels[provider] ?? provider;
}

/** Fire-and-forget orchestrator run with error logging */
export function kickRun(polpo: import("../core/orchestrator.js").Orchestrator): void {
  polpo.run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[polpo] run error: ${msg}`);
  });
}

/** Build a progress bar string */
export function progressBar(done: number, total: number, width = 20): string {
  if (total === 0) return chalk.dim("\u2591".repeat(width));
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return chalk.green("\u2588".repeat(filled)) + chalk.dim("\u2591".repeat(empty));
}

/** Braille spinner frames */
export const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

/** Get spinner frame for a tick */
export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}
