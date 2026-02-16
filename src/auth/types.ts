/**
 * OAuth auth profile types.
 *
 * Aligned with OpenClaw's auth-profiles.json schema:
 * - Profile storage with OAuth + API key types
 * - Per-profile usage stats with cooldown and billing disable tracking
 * - Session-level model/profile overrides for stickiness
 */

// ─── Profile Types ──────────────────────────────────

/** Stored OAuth credentials — persisted in auth-profiles.json */
export interface OAuthProfile {
  /** Provider ID (e.g. "anthropic", "openai-codex", "github-copilot") */
  provider: string;
  /** Profile type */
  type: "oauth" | "api_key";
  /** Access token / API key */
  access: string;
  /** Refresh token (OAuth only) */
  refresh?: string;
  /** Expiry timestamp (ms since epoch) */
  expires?: number;
  /** User email (if available from OAuth flow) */
  email?: string;
  /** Provider-specific extra fields (e.g. accountId, projectId, enterpriseUrl) */
  extra?: Record<string, unknown>;
  /** Last time this profile was used (ISO timestamp) */
  lastUsed?: string;
  /** When this profile was created (ISO timestamp) */
  createdAt: string;
}

// ─── Usage Stats ────────────────────────────────────

/** Per-profile usage statistics — tracked alongside profiles */
export interface ProfileUsageStats {
  /** Last time this profile was successfully used (ms since epoch) */
  lastUsed?: number;
  /** Cooldown until timestamp (ms since epoch) — transient errors (rate limit, auth, server) */
  cooldownUntil?: number;
  /** Number of consecutive errors (for exponential backoff) */
  errorCount?: number;
  /** Last error reason */
  lastErrorReason?: string;
  /** Billing disable until timestamp (ms since epoch) — separate from cooldown */
  disabledUntil?: number;
  /** Reason for disable (e.g. "billing", "quota_exceeded") */
  disabledReason?: string;
  /** Number of consecutive billing failures (for billing-specific backoff) */
  billingErrorCount?: number;
  /** Timestamp of the first failure in the current failure window (ms since epoch) */
  failureWindowStart?: number;
}

// ─── File Structure ─────────────────────────────────

/** The full auth-profiles.json structure */
export interface AuthProfilesFile {
  /** Schema version */
  version: number;
  /** Map of profileId → OAuthProfile. profileId format: "provider:identifier" */
  profiles: Record<string, OAuthProfile>;
  /** Per-profile usage statistics for rotation/cooldown/billing */
  usageStats?: Record<string, ProfileUsageStats>;
}

// ─── Session Overrides ──────────────────────────────

/** How the profile override was set */
export type ProfileOverrideSource = "auto" | "user";

/** Per-session model/profile override — for session stickiness */
export interface SessionModelOverride {
  /** Provider override (e.g. "anthropic") */
  providerOverride?: string;
  /** Model override (e.g. "claude-opus-4-6") */
  modelOverride?: string;
  /** Pinned auth profile ID (e.g. "anthropic:user@example.com") */
  authProfileOverride?: string;
  /** How the pin was set: "auto" (router) or "user" (/model command) */
  authProfileOverrideSource?: ProfileOverrideSource;
  /** When this override was last updated (ms since epoch) */
  updatedAt?: number;
}

// ─── Billing Disable Config ─────────────────────────

/** Configuration for billing disable backoff (OpenClaw-compatible) */
export interface BillingDisableConfig {
  /** Initial billing backoff in hours (default: 5) */
  billingBackoffHours: number;
  /** Max billing backoff in hours (default: 24) */
  billingMaxHours: number;
  /** Reset window in hours — billing error counters reset after this period without failure (default: 24) */
  failureWindowHours: number;
}

export const DEFAULT_BILLING_CONFIG: BillingDisableConfig = {
  billingBackoffHours: 5,
  billingMaxHours: 24,
  failureWindowHours: 24,
};

// ─── OAuth Provider Names ───────────────────────────

/** Supported OAuth provider IDs */
export type OAuthProviderName =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "google-gemini-cli"
  | "google-antigravity";

/** OAuth providers that are available */
export const OAUTH_PROVIDERS: { id: OAuthProviderName; name: string; flow: string }[] = [
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)", flow: "Browser + code paste" },
  { id: "openai-codex", name: "OpenAI Codex (ChatGPT Plus/Pro)", flow: "Browser + localhost callback" },
  { id: "github-copilot", name: "GitHub Copilot", flow: "Device code (no browser needed)" },
  { id: "google-gemini-cli", name: "Google Gemini CLI", flow: "Browser + localhost callback" },
  { id: "google-antigravity", name: "Google Antigravity", flow: "Browser + localhost callback" },
];
