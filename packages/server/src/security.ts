/**
 * Security redaction module — pure functions for sanitizing sensitive data
 * before exposing it through API responses or persisting to transcript logs.
 *
 * Handles:
 * - Provider API key masking
 * - Transcript parameter sanitization (passwords, tokens, secrets)
 *
 * NOTE: Vault credentials are no longer stored on AgentConfig — they live in
 * the encrypted vault store (.polpo/vault.enc). Agent/team/state redaction
 * functions are kept as pass-throughs for API compatibility.
 */

import type { AgentConfig, Team, PolpoState, PolpoConfig, PolpoFileConfig } from "@polpo-ai/core/types";

// ── Constants ──

/** Regex matching parameter names that likely contain secrets. */
export const SENSITIVE_PARAM_RE = /pass|secret|token|key|auth|password|credential/i;

// ── Agent Config Redaction ──

/**
 * Returns the agent config as-is (vault credentials are no longer inline).
 * Kept for backward compatibility with callers that expect redaction.
 */
export function redactAgentConfig(agent: AgentConfig): AgentConfig {
  return agent;
}

// ── Team Redaction ──

/** Returns the team as-is (no inline credentials to redact). */
export function redactTeam(team: Team): Team {
  return team;
}

// ── State Redaction ──

/** Returns the state as-is (no inline credentials to redact). */
export function redactPolpoState(state: PolpoState): PolpoState {
  return state;
}

// ── Config Redaction ──

/** Return config as-is — providers no longer contain secrets (API keys resolved via env/OAuth only). */
export function redactPolpoConfig<T extends PolpoConfig | PolpoFileConfig>(config: T): T {
  return config;
}

// ── Transcript Sanitization ──

/**
 * Sanitize a transcript entry by masking sensitive parameter values in tool_use inputs.
 * Only touches entries with `type === "tool_use"` that have an `input` object.
 * Returns the entry unchanged for all other types (assistant, tool_result, etc.).
 */
export function sanitizeTranscriptEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.type !== "tool_use") return entry;

  const input = entry.input;
  if (!input || typeof input !== "object") return entry;

  const sanitized: Record<string, unknown> = {};
  let changed = false;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_PARAM_RE.test(key) && typeof value === "string") {
      sanitized[key] = "[REDACTED]";
      changed = true;
    } else {
      sanitized[key] = value;
    }
  }

  if (!changed) return entry;

  return { ...entry, input: sanitized };
}
