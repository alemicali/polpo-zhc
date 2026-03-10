/**
 * OAuth manager — login, refresh, and API key resolution for OAuth-enabled providers.
 *
 * Wraps pi-ai's OAuth login functions with Polpo's credential persistence layer.
 * Supports all 5 OAuth providers: Anthropic, OpenAI Codex, GitHub Copilot,
 * Google Gemini CLI, Google Antigravity.
 *
 * Security:
 * - Expired tokens without refresh tokens are explicitly rejected (not silently used)
 * - Error messages are sanitized to prevent token/endpoint leakage
 * - Typed credential extraction avoids excessive `as any` casts
 */

import {
  loginAnthropic,
  loginOpenAICodex,
  loginGitHubCopilot,
  loginGeminiCli,
  loginAntigravity,
  refreshAnthropicToken,
  refreshOpenAICodexToken,
  refreshGitHubCopilotToken,
  refreshGoogleCloudToken,
  refreshAntigravityToken,
  getOAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { OAuthProviderName, OAuthProfile } from "./types.js";
import {
  profileId,
  saveProfile,
  getProfilesForProvider,
  updateProfileCredentials,
  touchProfile,
  recordProfileSuccess,
  recordProfileError,
  recordBillingFailure,
} from "./store.js";
import { selectProfileForProvider } from "./profile-rotation.js";

// ─── Types ──────────────────────────────────────────

/**
 * Extended OAuth credentials — pi-ai returns these additional fields
 * on some providers but the base OAuthCredentials type doesn't include them.
 */
interface ExtendedOAuthCredentials extends OAuthCredentials {
  email?: string;
  accountId?: string;
  projectId?: string;
  enterpriseUrl?: string;
}

// ─── Security Helpers ───────────────────────────────

/**
 * Sanitize an error message to prevent leaking sensitive data.
 * Strips anything that looks like a token, URL path, or credential.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";

  let msg = err.message;

  // Strip potential tokens (long hex/base64 strings)
  msg = msg.replace(/[A-Za-z0-9+/=_-]{40,}/g, "[REDACTED]");

  // Strip URLs that might contain tokens in query params
  msg = msg.replace(/https?:\/\/[^\s]+/g, (url) => {
    try {
      const u = new URL(url);
      // Keep host, strip path/query if they might contain tokens
      if (u.search || u.pathname.length > 20) {
        return `${u.origin}/...`;
      }
      return url;
    } catch {
      return "[REDACTED_URL]";
    }
  });

  return msg;
}

/**
 * Extract extended credentials from an OAuthCredentials object safely.
 * Uses type narrowing instead of `as any` casts.
 */
function extractExtendedFields(creds: OAuthCredentials): {
  email?: string;
  accountId?: string;
  projectId?: string;
  enterpriseUrl?: string;
} {
  const ext = creds as Partial<ExtendedOAuthCredentials>;
  return {
    email: typeof ext.email === "string" ? ext.email : undefined,
    accountId: typeof ext.accountId === "string" ? ext.accountId : undefined,
    projectId: typeof ext.projectId === "string" ? ext.projectId : undefined,
    enterpriseUrl: typeof ext.enterpriseUrl === "string" ? ext.enterpriseUrl : undefined,
  };
}

// ─── Login Callbacks ────────────────────────────────

export interface LoginCallbacks {
  /** Called when the user needs to open a URL (browser auth) */
  onAuthUrl: (url: string, instructions?: string) => void;
  /** Called when the user needs to enter a code or respond to a prompt */
  onPrompt: (message: string, placeholder?: string) => Promise<string>;
  /** Called for progress messages */
  onProgress?: (message: string) => void;
}

// ─── Login Functions ────────────────────────────────

/**
 * Login to a provider via OAuth. Returns the profile ID.
 */
export async function oauthLogin(
  provider: OAuthProviderName,
  callbacks: LoginCallbacks,
): Promise<string> {
  let creds: OAuthCredentials;

  switch (provider) {
    case "anthropic":
      creds = await loginAnthropic(
        (url) =>
          callbacks.onAuthUrl(
            url,
            "Open this URL in your browser and paste the authorization code",
          ),
        () =>
          callbacks.onPrompt(
            "Paste the authorization code from the browser (format: code#state)",
            "code#state",
          ),
      );
      break;

    case "openai-codex":
      creds = await loginOpenAICodex({
        onAuth: (info) => callbacks.onAuthUrl(info.url, info.instructions),
        onPrompt: (prompt) => callbacks.onPrompt(prompt.message, prompt.placeholder),
        onProgress: callbacks.onProgress,
        onManualCodeInput: () =>
          callbacks.onPrompt(
            "Paste the redirect URL or authorization code",
            "http://localhost:1455/auth/callback?code=...",
          ),
      });
      break;

    case "github-copilot":
      creds = await loginGitHubCopilot({
        onAuth: (url, instructions) => callbacks.onAuthUrl(url as string, instructions),
        onPrompt: (prompt) => callbacks.onPrompt(prompt.message, prompt.placeholder),
        onProgress: callbacks.onProgress,
      });
      break;

    case "google-gemini-cli":
      creds = await loginGeminiCli(
        (info) => callbacks.onAuthUrl(info.url, info.instructions),
        callbacks.onProgress,
        () =>
          callbacks.onPrompt(
            "Paste the redirect URL or authorization code",
            "http://localhost:8085/oauth2callback?...",
          ),
      );
      break;

    case "google-antigravity":
      creds = await loginAntigravity(
        (info) => callbacks.onAuthUrl(info.url, info.instructions),
        callbacks.onProgress,
        () =>
          callbacks.onPrompt(
            "Paste the redirect URL or authorization code",
            "http://localhost:51121/oauth-callback?...",
          ),
      );
      break;

    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  // Extract extended fields safely (no `as any`)
  const ext = extractExtendedFields(creds);
  const identifier = ext.email || ext.accountId || "default";
  const id = profileId(provider, identifier);

  // Build extra fields
  const extra: Record<string, unknown> = {};
  if (ext.accountId) extra.accountId = ext.accountId;
  if (ext.projectId) extra.projectId = ext.projectId;
  if (ext.enterpriseUrl) extra.enterpriseUrl = ext.enterpriseUrl;
  if (ext.email) extra.email = ext.email;

  // Save profile
  const profile: OAuthProfile = {
    provider,
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: ext.email,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };

  saveProfile(id, profile);
  return id;
}

// ─── Token Refresh ──────────────────────────────────

/**
 * Refresh credentials for a provider profile.
 * Updates the stored profile with new tokens.
 *
 * Throws if no refresh token is available — callers must handle this
 * and NOT fall back to using the expired access token.
 */
export async function refreshProfile(
  id: string,
  profile: OAuthProfile,
): Promise<OAuthProfile> {
  if (!profile.refresh) {
    throw new Error(
      `Profile ${id} has no refresh token — re-authentication required (run "polpo auth login ${profile.provider}")`,
    );
  }

  let creds: OAuthCredentials;

  try {
    switch (profile.provider) {
      case "anthropic":
        creds = await refreshAnthropicToken(profile.refresh);
        break;

      case "openai-codex":
        creds = await refreshOpenAICodexToken(profile.refresh);
        break;

      case "github-copilot":
        creds = await refreshGitHubCopilotToken(
          profile.refresh,
          profile.extra?.enterpriseUrl as string | undefined,
        );
        break;

      case "google-gemini-cli":
        creds = await refreshGoogleCloudToken(
          profile.refresh,
          (profile.extra?.projectId as string) || "",
        );
        break;

      case "google-antigravity":
        creds = await refreshAntigravityToken(
          profile.refresh,
          (profile.extra?.projectId as string) || "",
        );
        break;

      default:
        throw new Error(`Unknown OAuth provider: ${profile.provider}`);
    }
  } catch (err) {
    // Sanitize the error message before re-throwing
    const safeMsg = sanitizeErrorMessage(err);
    throw new Error(`Token refresh failed for ${profile.provider}: ${safeMsg}`);
  }

  // Extract extended fields safely
  const ext = extractExtendedFields(creds);
  const extra: Record<string, unknown> = {};
  if (ext.accountId) extra.accountId = ext.accountId;
  if (ext.projectId) extra.projectId = ext.projectId;

  updateProfileCredentials(
    id,
    creds.access,
    creds.expires,
    creds.refresh || profile.refresh,
    Object.keys(extra).length > 0 ? extra : undefined,
  );

  return {
    ...profile,
    access: creds.access,
    expires: creds.expires,
    refresh: creds.refresh || profile.refresh,
    extra: { ...profile.extra, ...extra },
  };
}

// ─── API Key Resolution ─────────────────────────────

/**
 * Get an API key for a provider from stored OAuth profiles.
 *
 * Uses profile rotation algorithm (OpenClaw-compatible):
 * - OAuth profiles before API keys
 * - Round-robin by oldest lastUsed
 * - Respects cooldown and billing disable
 * - Optional session stickiness via pinnedProfileId
 *
 * Automatically refreshes expired tokens.
 *
 * Security:
 * - Expired tokens WITHOUT a refresh token are SKIPPED (not used)
 * - Refresh failures are logged and the profile is skipped
 * - Error messages are sanitized
 *
 * Returns the API key string or undefined if no usable profiles exist.
 */
export async function getOAuthApiKeyForProvider(
  provider: string,
  pinnedProfileId?: string,
  pinnedSource?: "auto" | "user",
): Promise<{ apiKey: string; profileId: string } | undefined> {
  // Use profile rotation to select the best profile
  const selection = selectProfileForProvider(provider, pinnedProfileId, pinnedSource);
  if (!selection) return undefined;

  const { id, profile } = selection;

  try {
    let current = profile;

    // Check expiry
    const isExpired = current.expires != null && Date.now() >= current.expires;

    if (isExpired) {
      if (!current.refresh) {
        // Do NOT use expired tokens without refresh capability
        process.stderr.write(
          `[polpo/auth] Skipping expired profile "${id}" — no refresh token available. Run "polpo auth login ${current.provider}" to re-authenticate.\n`,
        );
        // If user-pinned, don't try other profiles
        if (pinnedSource === "user") return undefined;
        // Try to find the next available profile (exclude this one by recursing with no pin)
        return getOAuthApiKeyForProviderExcluding(provider, id);
      }

      // Try refresh
      try {
        current = await refreshProfile(id, current);
      } catch (refreshErr) {
        process.stderr.write(
          `[polpo/auth] Refresh failed for profile "${id}": ${sanitizeErrorMessage(refreshErr)}\n`,
        );
        recordProfileError(id, "refresh_failed");
        if (pinnedSource === "user") return undefined;
        return getOAuthApiKeyForProviderExcluding(provider, id);
      }
    }

    // Get the API key using the provider's getApiKey method
    const piProvider = getOAuthProvider(provider);
    if (piProvider) {
      const apiKey = piProvider.getApiKey({
        access: current.access,
        refresh: current.refresh || "",
        expires: current.expires || 0,
        ...current.extra,
      });
      recordProfileSuccess(id);
      return { apiKey, profileId: id };
    }

    // Fallback: use raw access token
    recordProfileSuccess(id);
    return { apiKey: current.access, profileId: id };
  } catch (err) {
    process.stderr.write(
      `[polpo/auth] Profile "${id}" failed: ${sanitizeErrorMessage(err)}\n`,
    );
    recordProfileError(id, "unknown");
    if (pinnedSource === "user") return undefined;
    return getOAuthApiKeyForProviderExcluding(provider, id);
  }
}

/**
 * Try to get an API key from a provider, excluding a specific profile.
 * Used when the primary selection fails and we need to rotate.
 */
async function getOAuthApiKeyForProviderExcluding(
  provider: string,
  excludeId: string,
): Promise<{ apiKey: string; profileId: string } | undefined> {
  const profiles = getProfilesForProvider(provider);
  const remaining = profiles.filter(p => p.id !== excludeId);
  if (remaining.length === 0) return undefined;

  // Try remaining profiles in rotation order (simple fallback)
  for (const { id, profile } of remaining) {
    try {
      let current = profile;
      const isExpired = current.expires != null && Date.now() >= current.expires;

      if (isExpired && !current.refresh) continue;
      if (isExpired && current.refresh) {
        try {
          current = await refreshProfile(id, current);
        } catch {
          continue;
        }
      }

      const piProvider = getOAuthProvider(provider);
      if (piProvider) {
        const apiKey = piProvider.getApiKey({
          access: current.access,
          refresh: current.refresh || "",
          expires: current.expires || 0,
          ...current.extra,
        });
        recordProfileSuccess(id);
        return { apiKey, profileId: id };
      }
      recordProfileSuccess(id);
      return { apiKey: current.access, profileId: id };
    } catch {
      continue;
    }
  }

  return undefined;
}
