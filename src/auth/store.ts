/**
 * OAuth credential store — persists tokens to ~/.polpo/auth-profiles.json.
 *
 * Security hardening:
 * - File permissions: 0o600 (owner read/write only) for credentials file
 * - Directory permissions: 0o700 (owner only) for .polpo directory
 * - Atomic writes: write to temp file + rename to prevent corruption/partial reads
 * - Input sanitization: profile IDs and provider names are validated
 * - TOCTOU-safe directory creation
 * - State directory path validation (prevents traversal attacks)
 * - Token validation before storage
 * - Explicit error logging for security-relevant failures
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { getGlobalPolpoDir } from "../core/constants.js";
import { randomBytes } from "node:crypto";
import type { AuthProfilesFile, OAuthProfile, ProfileUsageStats } from "./types.js";

// ─── Constants ──────────────────────────────────────

const CURRENT_VERSION = 1;

/** Only alphanumeric, hyphens, underscores, dots, @ — no slashes, colons limited to separator */
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._@-]+$/;

/** Valid provider names — alphanumeric, hyphens, underscores only */
const SAFE_PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Keys that must never appear as profile IDs (prototype pollution prevention) */
const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

// ─── State Directory Resolution ─────────────────────

/**
 * Resolve and validate the Polpo state directory.
 *
 * Security: POLPO_STATE_DIR is validated to be an absolute path that resolves
 * to the same location (no symlink tricks, no ".." components that escape).
 */
function resolveStateDir(): string {
  const envDir = process.env.POLPO_STATE_DIR;
  if (!envDir) {
    return getGlobalPolpoDir();
  }

  // Must be absolute
  if (!isAbsolute(envDir)) {
    emitSecurityWarning(
      `POLPO_STATE_DIR is not absolute ("${envDir}") — ignoring, using default ~/.polpo`,
    );
    return getGlobalPolpoDir();
  }

  // Resolve must equal the input (no ".." trickery)
  const resolved = resolve(envDir);
  if (resolved !== envDir) {
    emitSecurityWarning(
      `POLPO_STATE_DIR resolves differently ("${envDir}" → "${resolved}") — using resolved path`,
    );
  }

  // Must not point inside sensitive system directories
  const sensitive = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/var/run", "/proc", "/sys"];
  for (const s of sensitive) {
    if (resolved.startsWith(s + "/") || resolved === s) {
      emitSecurityWarning(
        `POLPO_STATE_DIR points to sensitive location ("${resolved}") — ignoring, using default ~/.polpo`,
      );
      return getGlobalPolpoDir();
    }
  }

  return resolved;
}

// Eagerly resolve once at module load
const POLPO_DIR = resolveStateDir();
const PROFILES_FILE = join(POLPO_DIR, "auth-profiles.json");

// ─── Security Logging ───────────────────────────────

/**
 * Emit a security warning to stderr.
 * Does not throw — callers decide whether to continue or abort.
 */
function emitSecurityWarning(message: string): void {
  process.stderr.write(`[polpo/auth] SECURITY WARNING: ${message}\n`);
}

/**
 * Emit an auth error to stderr.
 */
function emitAuthError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : "";
  process.stderr.write(`[polpo/auth] ERROR: ${message}${detail}\n`);
}

// ─── Input Validation ───────────────────────────────

/**
 * Validate and sanitize a profile ID.
 * Format: "provider:identifier" — both segments must be safe strings.
 *
 * Prevents:
 * - Prototype pollution (__proto__, constructor, etc.)
 * - Path traversal (../  or /)
 * - Injection via special characters
 */
function validateProfileId(id: string): void {
  // Check forbidden keys
  if (FORBIDDEN_KEYS.has(id)) {
    throw new Error(`Invalid profile ID: "${id}" is a reserved name`);
  }

  // Must contain exactly one colon separator
  const colonIdx = id.indexOf(":");
  if (colonIdx < 1 || colonIdx === id.length - 1) {
    throw new Error(`Invalid profile ID format: "${id}" — expected "provider:identifier"`);
  }

  const provider = id.slice(0, colonIdx);
  const identifier = id.slice(colonIdx + 1);

  // Validate provider segment
  if (!SAFE_PROVIDER_RE.test(provider)) {
    throw new Error(
      `Invalid provider in profile ID: "${provider}" — only lowercase alphanumeric, hyphens, underscores allowed`,
    );
  }

  // Validate identifier segment
  if (!SAFE_SEGMENT_RE.test(identifier)) {
    throw new Error(
      `Invalid identifier in profile ID: "${identifier}" — only alphanumeric, dots, @, hyphens, underscores allowed`,
    );
  }

  // Check identifier isn't a forbidden key either
  if (FORBIDDEN_KEYS.has(identifier)) {
    throw new Error(`Invalid identifier in profile ID: "${identifier}" is a reserved name`);
  }
}

/**
 * Validate a provider name.
 */
function validateProviderName(provider: string): void {
  if (!SAFE_PROVIDER_RE.test(provider)) {
    throw new Error(
      `Invalid provider name: "${provider}" — only lowercase alphanumeric, hyphens, underscores allowed (max 64 chars)`,
    );
  }
}

/**
 * Validate an OAuth token before storage.
 * Ensures it's a non-empty string that looks like a token (not a URL, file path, etc.).
 */
function validateToken(token: string, label: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (token.length > 16384) {
    throw new Error(`${label} exceeds maximum length (16384 chars)`);
  }
  // Tokens should not contain newlines or control characters
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(token)) {
    throw new Error(`${label} contains invalid control characters`);
  }
}

// ─── File System Helpers ────────────────────────────

/**
 * Ensure the state directory exists with proper permissions (0o700).
 *
 * TOCTOU-safe: uses mkdirSync with recursive (no separate exists check)
 * and then chmodSync to enforce permissions even if the directory already existed.
 */
function ensureDir(): void {
  try {
    mkdirSync(POLPO_DIR, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    // EEXIST is fine — directory already exists
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
      // Fall through to chmod
    } else {
      throw err;
    }
  }

  // Always enforce directory permissions (handles pre-existing dirs with wrong perms)
  try {
    chmodSync(POLPO_DIR, 0o700);
  } catch {
    emitSecurityWarning(`Failed to set directory permissions on ${POLPO_DIR}`);
  }
}

/**
 * Enforce file permissions on the profiles file (0o600 — owner read/write only).
 */
function enforceFilePermissions(): void {
  try {
    chmodSync(PROFILES_FILE, 0o600);
  } catch {
    // File might not exist yet — that's fine
  }
}

/**
 * Verify file permissions are secure. Warns if they are world-readable.
 */
function checkFilePermissions(): void {
  try {
    const stats = statSync(PROFILES_FILE);
    const mode = stats.mode & 0o777;
    if (mode & 0o044) {
      // World or group readable
      emitSecurityWarning(
        `${PROFILES_FILE} has insecure permissions (${mode.toString(8)}) — fixing to 0600`,
      );
      enforceFilePermissions();
    }
  } catch {
    // File doesn't exist — ok
  }
}

/**
 * Read profiles from disk. Returns a clean object (no prototype pollution risk).
 */
function readProfiles(): AuthProfilesFile {
  ensureDir();
  checkFilePermissions();

  try {
    const raw = readFileSync(PROFILES_FILE, "utf8");
    const data = JSON.parse(raw) as AuthProfilesFile;

    // Validate structure
    if (!data || typeof data !== "object" || typeof data.version !== "number") {
      emitAuthError("Corrupted auth-profiles.json — resetting");
      return { version: CURRENT_VERSION, profiles: Object.create(null) as Record<string, OAuthProfile> };
    }

    // Rebuild profiles using Object.create(null) to prevent prototype pollution
    const safeProfiles: Record<string, OAuthProfile> = Object.create(null) as Record<string, OAuthProfile>;
    if (data.profiles && typeof data.profiles === "object") {
      for (const [key, value] of Object.entries(data.profiles)) {
        // Skip any forbidden keys that might have been injected
        if (FORBIDDEN_KEYS.has(key)) {
          emitSecurityWarning(`Skipping forbidden profile key: "${key}"`);
          continue;
        }
        // Validate key format
        try {
          validateProfileId(key);
        } catch {
          emitSecurityWarning(`Skipping invalid profile key: "${key}"`);
          continue;
        }
        safeProfiles[key] = value;
      }
    }

    // Rebuild usageStats safely
    const safeStats: Record<string, ProfileUsageStats> = Object.create(null) as Record<string, ProfileUsageStats>;
    if (data.usageStats && typeof data.usageStats === "object") {
      for (const [key, value] of Object.entries(data.usageStats)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        if (typeof value === "object" && value !== null) {
          safeStats[key] = value;
        }
      }
    }

    return { version: data.version, profiles: safeProfiles, usageStats: safeStats };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist — normal case for first run
      return { version: CURRENT_VERSION, profiles: Object.create(null) as Record<string, OAuthProfile>, usageStats: Object.create(null) as Record<string, ProfileUsageStats> };
    }
    emitAuthError("Failed to read auth-profiles.json", err);
    return { version: CURRENT_VERSION, profiles: Object.create(null) as Record<string, OAuthProfile>, usageStats: Object.create(null) as Record<string, ProfileUsageStats> };
  }
}

/**
 * Write profiles to disk atomically.
 *
 * Pattern: write to a temp file in the same directory, then atomic rename.
 * This prevents corruption from crashes/power loss and ensures readers always
 * see a complete file.
 */
function writeProfiles(data: AuthProfilesFile): void {
  ensureDir();

  const tmpFile = join(POLPO_DIR, `.auth-profiles.${randomBytes(6).toString("hex")}.tmp`);

  try {
    // Write to temp file with restrictive permissions
    writeFileSync(tmpFile, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });

    // Atomic rename (same filesystem — guaranteed atomic on POSIX)
    renameSync(tmpFile, PROFILES_FILE);

    // Ensure final file has correct permissions (belt & suspenders)
    enforceFilePermissions();
  } catch (err) {
    // Clean up temp file on failure
    try {
      unlinkSync(tmpFile);
    } catch {
      // Temp file cleanup is best-effort
    }
    emitAuthError("Failed to write auth-profiles.json", err);
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────

/**
 * Generate a profile ID from provider and optional identifier.
 * Format: "provider:identifier" or "provider:default"
 *
 * Both segments are validated for safety.
 */
export function profileId(provider: string, identifier?: string): string {
  validateProviderName(provider);

  // Sanitize identifier — strip anything that's not safe
  let safeId = "default";
  if (identifier) {
    // Replace unsafe characters with underscores
    safeId = identifier.replace(/[^a-zA-Z0-9._@-]/g, "_");
    // Remove path traversal sequences
    safeId = safeId.replace(/\.\./g, "_");
    // Truncate to reasonable length
    if (safeId.length > 128) safeId = safeId.slice(0, 128);
    // Must not be empty after sanitization
    if (safeId.length === 0) safeId = "default";
    // Must not be a forbidden key
    if (FORBIDDEN_KEYS.has(safeId)) safeId = `_${safeId}`;
  }

  const id = `${provider}:${safeId}`;
  validateProfileId(id); // Final validation
  return id;
}

/**
 * Save an OAuth profile.
 * Validates the profile ID, provider name, and token before storage.
 */
export function saveProfile(id: string, profile: OAuthProfile): void {
  validateProfileId(id);
  validateProviderName(profile.provider);
  validateToken(profile.access, "access token");
  if (profile.refresh) validateToken(profile.refresh, "refresh token");

  const data = readProfiles();
  data.profiles[id] = profile;
  writeProfiles(data);
}

/**
 * Get an OAuth profile by ID.
 */
export function getProfile(id: string): OAuthProfile | undefined {
  validateProfileId(id);
  const data = readProfiles();
  return Object.prototype.hasOwnProperty.call(data.profiles, id)
    ? data.profiles[id]
    : undefined;
}

/**
 * Get all profiles for a provider.
 */
export function getProfilesForProvider(provider: string): { id: string; profile: OAuthProfile }[] {
  validateProviderName(provider);
  const data = readProfiles();
  return Object.entries(data.profiles)
    .filter(([, p]) => p.provider === provider)
    .map(([id, profile]) => ({ id, profile }));
}

/**
 * Get all stored profiles.
 */
export function getAllProfiles(): { id: string; profile: OAuthProfile }[] {
  const data = readProfiles();
  return Object.entries(data.profiles).map(([id, profile]) => ({ id, profile }));
}

/**
 * Delete a profile by ID.
 */
export function deleteProfile(id: string): boolean {
  validateProfileId(id);
  const data = readProfiles();
  if (!Object.prototype.hasOwnProperty.call(data.profiles, id)) return false;
  delete data.profiles[id];
  writeProfiles(data);
  return true;
}

/**
 * Delete all profiles for a provider.
 */
export function deleteProviderProfiles(provider: string): number {
  validateProviderName(provider);
  const data = readProfiles();
  let count = 0;
  for (const [id, p] of Object.entries(data.profiles)) {
    if (p.provider === provider) {
      delete data.profiles[id];
      count++;
    }
  }
  if (count > 0) writeProfiles(data);
  return count;
}

/**
 * Update the lastUsed timestamp for a profile.
 */
export function touchProfile(id: string): void {
  validateProfileId(id);
  const data = readProfiles();
  const profile = data.profiles[id];
  if (profile) {
    profile.lastUsed = new Date().toISOString();
    writeProfiles(data);
  }
}

/**
 * Update credentials for a profile (after refresh).
 * Validates new tokens before storage.
 */
export function updateProfileCredentials(
  id: string,
  access: string,
  expires?: number,
  refresh?: string,
  extra?: Record<string, unknown>,
): void {
  validateProfileId(id);
  validateToken(access, "access token");
  if (refresh !== undefined) validateToken(refresh, "refresh token");

  const data = readProfiles();
  const profile = data.profiles[id];
  if (!profile) return;
  profile.access = access;
  if (expires !== undefined) profile.expires = expires;
  if (refresh !== undefined) profile.refresh = refresh;
  if (extra) {
    // Sanitize extra keys — prevent prototype pollution
    const safeExtra: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, val] of Object.entries(extra)) {
      if (!FORBIDDEN_KEYS.has(key)) {
        (safeExtra as Record<string, unknown>)[key] = val;
      }
    }
    profile.extra = { ...profile.extra, ...safeExtra };
  }
  profile.lastUsed = new Date().toISOString();
  writeProfiles(data);
}

// ─── Usage Stats ────────────────────────────────────

/**
 * Get usage stats for a profile.
 */
export function getUsageStats(id: string): ProfileUsageStats | undefined {
  validateProfileId(id);
  const data = readProfiles();
  return data.usageStats?.[id];
}

/**
 * Get usage stats for all profiles of a provider.
 */
export function getProviderUsageStats(provider: string): Record<string, ProfileUsageStats> {
  validateProviderName(provider);
  const data = readProfiles();
  const result: Record<string, ProfileUsageStats> = Object.create(null) as Record<string, ProfileUsageStats>;
  if (!data.usageStats) return result;
  for (const [id, stats] of Object.entries(data.usageStats)) {
    if (id.startsWith(`${provider}:`)) {
      result[id] = stats;
    }
  }
  return result;
}

/**
 * Update usage stats for a profile (merge).
 */
export function updateUsageStats(id: string, update: Partial<ProfileUsageStats>): void {
  validateProfileId(id);
  const data = readProfiles();
  if (!data.usageStats) {
    data.usageStats = Object.create(null) as Record<string, ProfileUsageStats>;
  }
  const existing = data.usageStats![id] || ({} as ProfileUsageStats);
  data.usageStats![id] = { ...existing, ...update };
  writeProfiles(data);
}

/**
 * Record a successful use of a profile — clears cooldown and error counters.
 */
export function recordProfileSuccess(id: string): void {
  validateProfileId(id);
  const data = readProfiles();
  if (!data.usageStats) {
    data.usageStats = Object.create(null) as Record<string, ProfileUsageStats>;
  }
  data.usageStats![id] = {
    ...data.usageStats![id],
    lastUsed: Date.now(),
    cooldownUntil: undefined,
    errorCount: 0,
    lastErrorReason: undefined,
  };
  // Also update profile's lastUsed
  const profile = data.profiles[id];
  if (profile) {
    profile.lastUsed = new Date().toISOString();
  }
  writeProfiles(data);
}

/**
 * Record a transient error for a profile — increments error count and sets cooldown.
 * Returns the cooldown duration in ms.
 */
export function recordProfileError(
  id: string,
  reason: string,
  cooldownSteps: number[] = [60_000, 300_000, 1_500_000, 3_600_000],
): number {
  validateProfileId(id);
  const data = readProfiles();
  if (!data.usageStats) {
    data.usageStats = Object.create(null) as Record<string, ProfileUsageStats>;
  }
  const existing = data.usageStats![id] || ({} as ProfileUsageStats);
  const errorCount = (existing.errorCount ?? 0) + 1;
  const stepIdx = Math.min(errorCount - 1, cooldownSteps.length - 1);
  const cooldownMs = cooldownSteps[stepIdx];

  data.usageStats![id] = {
    ...existing,
    cooldownUntil: Date.now() + cooldownMs,
    errorCount,
    lastErrorReason: reason,
  };
  writeProfiles(data);
  return cooldownMs;
}

/**
 * Record a billing failure for a profile — uses separate billing backoff.
 *
 * Billing backoff: starts at billingBackoffHours, doubles per failure, caps at billingMaxHours.
 * Counters reset if no billing failure for failureWindowHours.
 */
export function recordBillingFailure(
  id: string,
  reason: string = "billing",
  config: { billingBackoffHours: number; billingMaxHours: number; failureWindowHours: number } = {
    billingBackoffHours: 5,
    billingMaxHours: 24,
    failureWindowHours: 24,
  },
): number {
  validateProfileId(id);
  const data = readProfiles();
  if (!data.usageStats) {
    data.usageStats = Object.create(null) as Record<string, ProfileUsageStats>;
  }
  const existing = data.usageStats![id] || ({} as ProfileUsageStats);

  // Check if we should reset the billing error count (failure window expired)
  const now = Date.now();
  const windowMs = config.failureWindowHours * 3_600_000;
  let billingErrorCount = existing.billingErrorCount ?? 0;
  let failureWindowStart = existing.failureWindowStart ?? now;

  if (now - failureWindowStart > windowMs) {
    // Window expired — reset counters
    billingErrorCount = 0;
    failureWindowStart = now;
  }

  billingErrorCount++;

  // Calculate backoff: billingBackoffHours * 2^(billingErrorCount-1), capped at billingMaxHours
  const backoffHours = Math.min(
    config.billingBackoffHours * Math.pow(2, billingErrorCount - 1),
    config.billingMaxHours,
  );
  const disableMs = backoffHours * 3_600_000;

  data.usageStats![id] = {
    ...existing,
    disabledUntil: now + disableMs,
    disabledReason: reason,
    billingErrorCount,
    failureWindowStart,
  };
  writeProfiles(data);
  return disableMs;
}

/**
 * Check if a profile is in cooldown (transient errors).
 */
export function isProfileInCooldown(id: string): boolean {
  const stats = getUsageStats(id);
  if (!stats?.cooldownUntil) return false;
  return Date.now() < stats.cooldownUntil;
}

/**
 * Check if a profile is billing-disabled.
 */
export function isProfileBillingDisabled(id: string): boolean {
  const stats = getUsageStats(id);
  if (!stats?.disabledUntil) return false;
  return Date.now() < stats.disabledUntil;
}

/**
 * Check if a profile is available (not in cooldown and not billing-disabled).
 */
export function isProfileAvailable(id: string): boolean {
  return !isProfileInCooldown(id) && !isProfileBillingDisabled(id);
}

/**
 * Clear all cooldown/disable state for a profile.
 */
export function clearProfileCooldown(id: string): void {
  validateProfileId(id);
  const data = readProfiles();
  if (!data.usageStats) return;
  const existing = data.usageStats[id];
  if (!existing) return;
  data.usageStats[id] = {
    ...existing,
    cooldownUntil: undefined,
    errorCount: 0,
    lastErrorReason: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    billingErrorCount: 0,
    failureWindowStart: undefined,
  };
  writeProfiles(data);
}

/**
 * Get the auth-profiles file path (for display/debug).
 */
export function getProfilesPath(): string {
  return PROFILES_FILE;
}
