import { PROVIDER_ENV_MAP } from "../llm/pi-client.js";
import { getAllProfiles } from "../auth/store.js";

/**
 * Maps OAuth profile provider names → canonical PROVIDER_ENV_MAP names they satisfy.
 * E.g. a profile with provider "openai-codex" satisfies both "openai" and "openai-codex".
 */
export const OAUTH_TO_CANONICAL: Record<string, string[]> = {
  "anthropic":          ["anthropic"],
  "openai-codex":       ["openai", "openai-codex"],
  "github-copilot":     ["github-copilot"],
  "google-gemini-cli":  ["google", "google-gemini-cli"],
  "google-antigravity": ["google", "google-antigravity"],
};

/**
 * Reverse map: canonical PROVIDER_ENV_MAP name → OAuth profile names that satisfy it.
 * E.g. "openai" → ["openai-codex"], "google" → ["google-gemini-cli", "google-antigravity"]
 */
export const CANONICAL_TO_OAUTH: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [oauthName, canonicals] of Object.entries(OAUTH_TO_CANONICAL)) {
    for (const canonical of canonicals) {
      (map[canonical] ??= []).push(oauthName);
    }
  }
  return map;
})();

export interface DetectedProvider {
  /** Canonical provider name from PROVIDER_ENV_MAP (e.g. "openai", "google") */
  name: string;
  /** Environment variable for API key */
  envVar: string;
  /** Whether a usable credential exists (env key or OAuth profile) */
  hasKey: boolean;
  /** Source of credentials */
  source: "env" | "oauth" | "none";
}

/**
 * Get the set of canonical provider names that have OAuth profiles.
 * Reads auth-profiles.json and maps profile provider names through OAUTH_TO_CANONICAL.
 */
function getOAuthProviderSet(): Set<string> {
  const result = new Set<string>();
  try {
    const profiles = getAllProfiles();
    for (const { profile } of profiles) {
      const canonicals = OAUTH_TO_CANONICAL[profile.provider];
      if (canonicals) {
        for (const c of canonicals) result.add(c);
      } else {
        // Direct match (provider name is already canonical)
        result.add(profile.provider);
      }
    }
  } catch {
    // No profiles file — that's fine
  }
  return result;
}

/**
 * Detect all providers with their credential status.
 * Single source of truth — used by both CLI and server.
 */
export function detectProviders(): DetectedProvider[] {
  const oauthSet = getOAuthProviderSet();
  const seen = new Set<string>();

  return Object.entries(PROVIDER_ENV_MAP)
    // Deduplicate by env var (e.g. openai and openai-codex share OPENAI_API_KEY)
    .filter(([, envVar]) => {
      if (seen.has(envVar)) return false;
      seen.add(envVar);
      return true;
    })
    .map(([name, envVar]) => {
      const hasEnvKey = !!process.env[envVar];
      const hasOAuth = oauthSet.has(name);
      return {
        name,
        envVar,
        hasKey: hasEnvKey || hasOAuth,
        source: hasEnvKey ? "env" as const : hasOAuth ? "oauth" as const : "none" as const,
      };
    });
}

/**
 * Check if a canonical provider name has any OAuth profiles available.
 * Handles the name mismatch: "openai" checks for "openai-codex" profiles, etc.
 */
export function hasOAuthProfilesForProvider(provider: string): boolean {
  const oauthNames = CANONICAL_TO_OAUTH[provider] ?? [provider];
  try {
    const profiles = getAllProfiles();
    return profiles.some(({ profile }) => oauthNames.includes(profile.provider));
  } catch {
    return false;
  }
}
