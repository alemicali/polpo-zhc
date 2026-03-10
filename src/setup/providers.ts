import { PROVIDER_ENV_MAP, listProviders } from "../llm/pi-client.js";
import { getAllProfiles } from "../auth/store.js";

export interface DetectedProvider {
  /** Provider name exactly as it appears in the pi-ai catalog (e.g. "openai", "openai-codex", "google") */
  name: string;
  /** Environment variable for API key (if any) */
  envVar: string | undefined;
  /** Whether a usable credential exists (env key or OAuth profile) */
  hasKey: boolean;
  /** Source of credentials */
  source: "env" | "oauth" | "none";
}

/**
 * Detect all providers from the pi-ai catalog with their credential status.
 *
 * This is a 1:1 pass-through of the catalog — every provider that pi-ai knows about
 * is returned. No deduplication, no name mapping. The UI is a mere wrapper on this.
 *
 * Credential detection:
 * - env: the provider has a known env var (PROVIDER_ENV_MAP) and it's set
 * - oauth: there's an OAuth profile stored with exactly this provider name
 * - none: no credentials found
 */
export function detectProviders(): DetectedProvider[] {
  // All providers from the pi-ai catalog — this is the single source of truth
  const catalogProviders = listProviders();

  // Build set of provider names that have OAuth profiles (exact match, no mapping)
  const oauthProviders = new Set<string>();
  try {
    for (const { profile } of getAllProfiles()) {
      oauthProviders.add(profile.provider);
    }
  } catch {
    // No profiles file — that's fine
  }

  return catalogProviders.map((name) => {
    const envVar = PROVIDER_ENV_MAP[name];
    const hasEnvKey = envVar ? !!process.env[envVar] : false;
    const hasOAuth = oauthProviders.has(name);

    return {
      name,
      envVar,
      hasKey: hasEnvKey || hasOAuth,
      source: hasEnvKey ? "env" as const : hasOAuth ? "oauth" as const : "none" as const,
    };
  });
}

/**
 * Check if a provider has any OAuth profiles available (exact name match).
 */
export function hasOAuthProfilesForProvider(provider: string): boolean {
  try {
    const profiles = getAllProfiles();
    return profiles.some(({ profile }) => profile.provider === provider);
  } catch {
    return false;
  }
}
