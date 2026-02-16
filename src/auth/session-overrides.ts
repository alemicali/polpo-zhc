/**
 * Session-level model/profile overrides for stickiness.
 *
 * Aligned with OpenClaw's session override system:
 * - Auto-pin: router selects a profile, soft pin (rotates on failure)
 * - User-pin: explicit /model command, hard pin (fails rather than rotate)
 * - Overrides are stored per-session and cleared on reset
 *
 * This module manages the override state; actual session persistence
 * is handled by the caller (orchestrator, server, chat handler).
 */

import type { SessionModelOverride, ProfileOverrideSource } from "./types.js";

// ─── In-Memory Session Store ────────────────────────

/** Session overrides — stored in memory (sessions are ephemeral). */
const sessionOverrides = new Map<string, SessionModelOverride>();

// ─── Public API ─────────────────────────────────────

/**
 * Get the model/profile override for a session.
 */
export function getSessionOverride(sessionId: string): SessionModelOverride | undefined {
  return sessionOverrides.get(sessionId);
}

/**
 * Apply a model override to a session.
 *
 * @param sessionId — Session ID
 * @param selection — What to override
 * @returns Whether the override was actually changed
 */
export function applySessionModelOverride(
  sessionId: string,
  selection: {
    provider?: string;
    model?: string;
    isDefault?: boolean;
  },
  profileOverride?: string,
  profileOverrideSource?: ProfileOverrideSource,
): boolean {
  // isDefault clears all overrides
  if (selection.isDefault) {
    const existed = sessionOverrides.has(sessionId);
    sessionOverrides.delete(sessionId);
    return existed;
  }

  const existing = sessionOverrides.get(sessionId);
  const now = Date.now();

  const updated: SessionModelOverride = {
    providerOverride: selection.provider ?? existing?.providerOverride,
    modelOverride: selection.model ?? existing?.modelOverride,
    authProfileOverride: profileOverride ?? existing?.authProfileOverride,
    authProfileOverrideSource: profileOverrideSource ?? existing?.authProfileOverrideSource,
    updatedAt: now,
  };

  // Check if anything actually changed
  if (
    existing &&
    existing.providerOverride === updated.providerOverride &&
    existing.modelOverride === updated.modelOverride &&
    existing.authProfileOverride === updated.authProfileOverride &&
    existing.authProfileOverrideSource === updated.authProfileOverrideSource
  ) {
    return false;
  }

  sessionOverrides.set(sessionId, updated);
  return true;
}

/**
 * Clear all overrides for a session (e.g. on /reset or /new).
 */
export function clearSessionOverride(sessionId: string): void {
  sessionOverrides.delete(sessionId);
}

/**
 * Get the effective model spec for a session, considering overrides.
 *
 * @param sessionId — Session ID
 * @param defaultModel — Default model spec when no override is set
 * @returns The model spec to use, and whether it came from an override
 */
export function resolveSessionModel(
  sessionId: string,
  defaultModel: string,
): { spec: string; overridden: boolean; pinnedProfileId?: string; pinnedSource?: ProfileOverrideSource } {
  const override = sessionOverrides.get(sessionId);
  if (!override) {
    return { spec: defaultModel, overridden: false };
  }

  // Build the model spec from override
  let spec = defaultModel;
  if (override.providerOverride && override.modelOverride) {
    spec = `${override.providerOverride}:${override.modelOverride}`;
  } else if (override.modelOverride) {
    spec = override.modelOverride;
  } else if (override.providerOverride) {
    // Provider override without model — keep the model from default
    const colonIdx = defaultModel.indexOf(":");
    const modelPart = colonIdx > 0 ? defaultModel.slice(colonIdx + 1) : defaultModel;
    spec = `${override.providerOverride}:${modelPart}`;
  }

  return {
    spec,
    overridden: true,
    pinnedProfileId: override.authProfileOverride,
    pinnedSource: override.authProfileOverrideSource,
  };
}

/**
 * Parse a /model command input.
 *
 * Supported formats:
 *   "/model" or "/model list" → { action: "list" }
 *   "/model status" → { action: "status" }
 *   "/model reset" or "/model default" → { action: "reset" }
 *   "/model 3" → { action: "pick", index: 3 }
 *   "/model provider/model" → { action: "set", provider: "provider", model: "model" }
 *   "/model provider:model" → { action: "set", provider: "provider", model: "model" }
 *   "/model model-name" → { action: "set", model: "model-name" }
 *   "/model model@profile" → { action: "set", model: "model", profileId: "profile" }
 */
export type ModelCommandAction =
  | { action: "list" }
  | { action: "status" }
  | { action: "reset" }
  | { action: "pick"; index: number }
  | { action: "set"; provider?: string; model: string; profileId?: string };

export function parseModelCommand(input: string): ModelCommandAction {
  const trimmed = input.trim();

  // Empty or "list"
  if (!trimmed || trimmed === "list") {
    return { action: "list" };
  }

  // Status
  if (trimmed === "status") {
    return { action: "status" };
  }

  // Reset / default
  if (trimmed === "reset" || trimmed === "default") {
    return { action: "reset" };
  }

  // Numeric pick
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num > 0 && trimmed === String(num)) {
    return { action: "pick", index: num };
  }

  // Extract @profile suffix
  // Profile IDs have format "provider:identifier", so look for @provider: pattern
  // This avoids confusion with email-like identifiers (user@example.com)
  let profileId: string | undefined;
  let modelPart = trimmed;
  const profileMatch = trimmed.match(/^(.+?)@([a-z][a-z0-9_-]*:[a-zA-Z0-9._@-]+)$/);
  if (profileMatch) {
    modelPart = profileMatch[1];
    profileId = profileMatch[2];
  }

  // provider/model or provider:model
  const slashIdx = modelPart.indexOf("/");
  const colonIdx = modelPart.indexOf(":");
  if (slashIdx > 0) {
    return {
      action: "set",
      provider: modelPart.slice(0, slashIdx),
      model: modelPart.slice(slashIdx + 1),
      profileId,
    };
  }
  if (colonIdx > 0) {
    return {
      action: "set",
      provider: modelPart.slice(0, colonIdx),
      model: modelPart.slice(colonIdx + 1),
      profileId,
    };
  }

  // Bare model name
  return { action: "set", model: modelPart, profileId };
}

/**
 * List all active session overrides (for debugging).
 */
export function listSessionOverrides(): Map<string, SessionModelOverride> {
  return new Map(sessionOverrides);
}
