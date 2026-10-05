/**
 * OAuth manager — login, refresh, and API key resolution for OAuth-enabled providers.
 *
 * Wraps pi-ai's OAuth login functions with Polpo's credential persistence layer.
 * Supports every OAuth provider exposed by the installed pi-ai catalog.
 *
 * Security:
 * - Expired tokens without refresh tokens are explicitly rejected (not silently used)
 * - Error messages are sanitized to prevent token/endpoint leakage
 * - Typed credential extraction avoids excessive `as any` casts
 */

import type { AuthEvent, AuthPrompt, ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { OAuthProviderName, OAuthProfile } from "./types.js";
import { getPiOAuthRuntime, oauthCredentialFromProfile } from "./pi-oauth-runtime.js";
import {
  profileId,
  saveProfile,
  getProfilesForProvider,
  updateProfileCredentials,
  recordProfileSuccess,
  recordProfileError,
} from "./store.js";
import { selectProfileForProvider } from "./profile-rotation.js";

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
function extractExtendedFields(creds: OAuthCredential): {
  email?: string;
  accountId?: string;
  projectId?: string;
  enterpriseUrl?: string;
} {
  return {
    email: typeof creds.email === "string" ? creds.email : undefined,
    accountId: typeof creds.accountId === "string" ? creds.accountId : undefined,
    projectId: typeof creds.projectId === "string" ? creds.projectId : undefined,
    enterpriseUrl: typeof creds.enterpriseUrl === "string" ? creds.enterpriseUrl : undefined,
  };
}

function extractCredentialExtra(creds: OAuthCredential): Record<string, unknown> | undefined {
  const { type: _type, access: _access, refresh: _refresh, expires: _expires, ...extra } = creds;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

export interface LoginPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface LoginPrompt {
  type: AuthPrompt["type"];
  message: string;
  placeholder?: string;
  options?: LoginPromptOption[];
}

export interface LoginDeviceCode {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

/** Convert pi-ai prompts into a serializable, app-facing contract. */
export function normalizeLoginPrompt(prompt: AuthPrompt): LoginPrompt {
  return {
    type: prompt.type,
    message: prompt.message,
    placeholder: prompt.type === "select" ? undefined : prompt.placeholder,
    options: prompt.type === "select"
      ? prompt.options.map((option) => ({ ...option }))
      : undefined,
  };
}

function promptMessage(prompt: LoginPrompt): { message: string; placeholder?: string } {
  if (prompt.type !== "select") {
    return { message: prompt.message, placeholder: prompt.placeholder };
  }
  const choices = (prompt.options ?? [])
    .map((option) => `${option.id}: ${option.label}${option.description ? ` — ${option.description}` : ""}`)
    .join("\n");
  return { message: `${prompt.message}\n${choices}` };
}

function notifyLogin(callbacks: LoginCallbacks, event: AuthEvent): void {
  switch (event.type) {
    case "auth_url":
      callbacks.onAuthUrl(event.url, event.instructions);
      break;
    case "device_code":
      if (callbacks.onDeviceCode) {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
      } else {
        callbacks.onAuthUrl(event.verificationUri, `Enter device code ${event.userCode}`);
      }
      break;
    case "info":
      callbacks.onProgress?.(event.message);
      if (event.links?.[0]) callbacks.onAuthUrl(event.links[0].url, event.links[0].label);
      break;
    case "progress":
      callbacks.onProgress?.(event.message);
      break;
  }
}

// ─── Login Callbacks ────────────────────────────────

export interface LoginCallbacks {
  /** Called when the user needs to open a URL (browser auth) */
  onAuthUrl: (url: string, instructions?: string) => void;
  /** Called when the user needs to enter a code or respond to a prompt */
  onPrompt: (message: string, placeholder?: string, prompt?: LoginPrompt) => Promise<string>;
  /** Called for device authorization flows that require a URL and one-time code. */
  onDeviceCode?: (deviceCode: LoginDeviceCode) => void;
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
  const oauth = getPiOAuthRuntime(provider);
  if (!oauth) throw new Error(`Unknown OAuth provider: ${provider}`);

  const signal = new AbortController().signal;
  const creds = await oauth.login({
    signal,
    prompt: async (prompt) => {
      const normalized = normalizeLoginPrompt(prompt);
      const display = promptMessage(normalized);
      return callbacks.onPrompt(display.message, display.placeholder, normalized);
    },
    notify: (event) => notifyLogin(callbacks, event),
  });

  // Extract extended fields safely (no `as any`)
  const ext = extractExtendedFields(creds);
  const identifier = ext.email || ext.accountId || "default";
  const id = profileId(provider, identifier);

  // Build extra fields
  const extra = extractCredentialExtra(creds);

  // Save profile
  const profile: OAuthProfile = {
    provider,
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    email: ext.email,
    extra,
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

  try {
    const oauth = getPiOAuthRuntime(profile.provider);
    if (!oauth) throw new Error(`Unknown OAuth provider: ${profile.provider}`);
    const creds = await oauth.refresh(
      oauthCredentialFromProfile(profile),
      new AbortController().signal,
    );

    const extra = extractCredentialExtra(creds);
    updateProfileCredentials(
      id,
      creds.access,
      creds.expires,
      creds.refresh || profile.refresh,
      extra,
    );

    return {
      ...profile,
      access: creds.access,
      expires: creds.expires,
      refresh: creds.refresh || profile.refresh,
      email: typeof creds.email === "string" ? creds.email : profile.email,
      extra: { ...profile.extra, ...extra },
    };
  } catch (err) {
    // Sanitize the error message before re-throwing
    const safeMsg = sanitizeErrorMessage(err);
    throw new Error(`Token refresh failed for ${profile.provider}: ${safeMsg}`);
  }
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
export async function getOAuthModelAuthForProvider(
  provider: string,
  pinnedProfileId?: string,
  pinnedSource?: "auto" | "user",
): Promise<{ auth: ModelAuth; profileId: string } | undefined> {
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
        return getOAuthModelAuthForProviderExcluding(provider, id);
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
        return getOAuthModelAuthForProviderExcluding(provider, id);
      }
    }

    const oauth = getPiOAuthRuntime(provider);
    if (oauth) {
      const auth = await oauth.toAuth(oauthCredentialFromProfile(current));
      recordProfileSuccess(id);
      return { auth, profileId: id };
    }

    // Fallback: use raw access token
    recordProfileSuccess(id);
    return { auth: { apiKey: current.access }, profileId: id };
  } catch (err) {
    process.stderr.write(
      `[polpo/auth] Profile "${id}" failed: ${sanitizeErrorMessage(err)}\n`,
    );
    recordProfileError(id, "unknown");
    if (pinnedSource === "user") return undefined;
    return getOAuthModelAuthForProviderExcluding(provider, id);
  }
}

/** Backward-compatible API-key-only view for older Polpo integrations. */
export async function getOAuthApiKeyForProvider(
  provider: string,
  pinnedProfileId?: string,
  pinnedSource?: "auto" | "user",
): Promise<{ apiKey: string; profileId: string } | undefined> {
  const resolved = await getOAuthModelAuthForProvider(provider, pinnedProfileId, pinnedSource);
  if (!resolved?.auth.apiKey) return undefined;
  return { apiKey: resolved.auth.apiKey, profileId: resolved.profileId };
}

/**
 * Try to get an API key from a provider, excluding a specific profile.
 * Used when the primary selection fails and we need to rotate.
 */
async function getOAuthModelAuthForProviderExcluding(
  provider: string,
  excludeId: string,
): Promise<{ auth: ModelAuth; profileId: string } | undefined> {
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

      const oauth = getPiOAuthRuntime(provider);
      if (oauth) {
        const auth = await oauth.toAuth(oauthCredentialFromProfile(current));
        recordProfileSuccess(id);
        return { auth, profileId: id };
      }
      recordProfileSuccess(id);
      return { auth: { apiKey: current.access }, profileId: id };
    } catch {
      continue;
    }
  }

  return undefined;
}
