/**
 * Security redaction module — pure functions for sanitizing sensitive data
 * before exposing it through API responses or persisting to transcript logs.
 *
 * Handles:
 * - Vault credential masking (agent configs, team, state, config)
 * - Provider API key masking
 * - Transcript parameter sanitization (passwords, tokens, secrets)
 */

import type { AgentConfig, Team, PolpoState, PolpoConfig, PolpoFileConfig } from "../core/types.js";

// ── Constants ──

/** Regex matching parameter names that likely contain secrets. */
export const SENSITIVE_PARAM_RE = /pass|secret|token|key|auth|password|credential/i;

const REDACTED = "***";

// ── Agent Config Redaction ──

/**
 * Deep-clone an AgentConfig and mask vault credential values.
 * Preserves vault structure (type, label, key names) but replaces values with "***".
 */
export function redactAgentConfig(agent: AgentConfig): AgentConfig {
  if (!agent.vault) return agent;

  const redactedVault: Record<string, any> = {};
  for (const [serviceName, entry] of Object.entries(agent.vault)) {
    const redactedCreds: Record<string, string> = {};
    for (const key of Object.keys(entry.credentials)) {
      redactedCreds[key] = REDACTED;
    }
    redactedVault[serviceName] = {
      type: entry.type,
      ...(entry.label ? { label: entry.label } : {}),
      credentials: redactedCreds,
    };
  }

  return { ...agent, vault: redactedVault };
}

// ── Team Redaction ──

/** Redact all agents in a team. */
export function redactTeam(team: Team): Team {
  return {
    ...team,
    agents: team.agents.map(redactAgentConfig),
  };
}

// ── State Redaction ──

/** Redact team inside an OrchestraState snapshot. */
export function redactPolpoState(state: PolpoState): PolpoState {
  return {
    ...state,
    teams: state.teams.map(redactTeam),
  };
}

// ── Config Redaction ──

/** Redact provider API keys and team vault in a PolpoConfig or PolpoFileConfig. */
export function redactPolpoConfig<T extends PolpoConfig | PolpoFileConfig>(config: T): T {
  const result: any = { ...config };

  // Redact teams
  if (result.teams) {
    result.teams = result.teams.map(redactTeam);
  }

  // Redact provider API keys
  if (result.providers) {
    const redactedProviders: Record<string, any> = {};
    for (const [name, provider] of Object.entries(result.providers as Record<string, any>)) {
      redactedProviders[name] = {
        ...provider,
        apiKey: provider.apiKey ? REDACTED : undefined,
      };
    }
    result.providers = redactedProviders;
  }

  return result;
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
