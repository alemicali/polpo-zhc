import { oauthLogin, OAUTH_PROVIDERS } from "../auth/index.js";
import type { LoginCallbacks } from "../auth/index.js";
import type { OAuthProviderName } from "../auth/types.js";

export type { LoginCallbacks };

/**
 * Find an OAuth provider by ID. Returns the provider definition or undefined.
 */
export function findOAuthProvider(providerId: string) {
  return OAUTH_PROVIDERS.find((p) => p.id === providerId);
}

/**
 * Get all available OAuth providers with free/paid info.
 * Single source of truth for both CLI and server.
 */
export function getOAuthProviderList() {
  return OAUTH_PROVIDERS.map((p) => ({
    ...p,
    free: p.id === "google-antigravity" || p.id === "google-gemini-cli",
  }));
}

/**
 * Run an OAuth login flow for a provider.
 * Returns the profile ID on success.
 * Both CLI and server use this — they differ only in the callbacks.
 */
export async function startOAuthLogin(
  providerId: string,
  callbacks: LoginCallbacks,
): Promise<string> {
  const match = findOAuthProvider(providerId);
  if (!match) throw new Error(`Unknown OAuth provider: ${providerId}`);
  return oauthLogin(providerId as OAuthProviderName, callbacks);
}
