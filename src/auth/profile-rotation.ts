/**
 * Auth profile rotation — selects the best profile for a provider request.
 *
 * Algorithm (aligned with OpenClaw):
 * 1. Filter profiles for the target provider
 * 2. Separate into: available, cooldown, billing-disabled
 * 3. Sort available profiles:
 *    a. OAuth profiles before API key profiles
 *    b. Within each type: oldest lastUsed first (round-robin)
 * 4. Append cooldown profiles (sorted by soonest cooldown expiry)
 * 5. Append billing-disabled profiles (sorted by soonest disable expiry)
 *
 * Returns the selected profile or undefined if none available.
 */

import type { OAuthProfile, ProfileUsageStats } from "./types.js";
import {
  getProfilesForProvider,
  getProviderUsageStats,
  isProfileInCooldown,
  isProfileBillingDisabled,
} from "./store.js";

// ─── Types ──────────────────────────────────────────

export interface ProfileSelectionResult {
  /** Selected profile ID */
  id: string;
  /** The profile data */
  profile: OAuthProfile;
  /** Usage stats (if any) */
  stats?: ProfileUsageStats;
  /** Whether this profile was the only option (no rotation possible) */
  onlyOption: boolean;
  /** Whether this profile is in cooldown (selected as last resort) */
  inCooldown: boolean;
  /** Whether this profile is billing-disabled (selected as last resort) */
  billingDisabled: boolean;
}

interface RankedProfile {
  id: string;
  profile: OAuthProfile;
  stats?: ProfileUsageStats;
  cooldownUntil?: number;
  disabledUntil?: number;
}

// ─── Selection Logic ────────────────────────────────

/**
 * Select the best auth profile for a provider.
 *
 * Respects cooldown, billing disable, and rotation order.
 * If a pinnedProfileId is provided, it is preferred unless it's unavailable.
 *
 * @param provider — Provider name (e.g. "anthropic")
 * @param pinnedProfileId — Optional pinned profile ID (from session stickiness)
 * @param pinnedSource — How the pin was set: "auto" (can rotate away), "user" (hard pin)
 */
export function selectProfileForProvider(
  provider: string,
  pinnedProfileId?: string,
  pinnedSource?: "auto" | "user",
): ProfileSelectionResult | undefined {
  const profiles = getProfilesForProvider(provider);
  if (profiles.length === 0) return undefined;

  const allStats = getProviderUsageStats(provider);

  // Build ranked list
  const ranked: RankedProfile[] = profiles.map(({ id, profile }) => {
    const stats = allStats[id];
    return {
      id,
      profile,
      stats,
      cooldownUntil: stats?.cooldownUntil,
      disabledUntil: stats?.disabledUntil,
    };
  });

  // Handle pinned profile
  if (pinnedProfileId) {
    const pinned = ranked.find(r => r.id === pinnedProfileId);
    if (pinned) {
      const inCooldown = isProfileInCooldown(pinned.id);
      const billingDisabled = isProfileBillingDisabled(pinned.id);

      // User pin: always return the pinned profile (hard pin)
      if (pinnedSource === "user") {
        return {
          id: pinned.id,
          profile: pinned.profile,
          stats: pinned.stats,
          onlyOption: profiles.length === 1,
          inCooldown,
          billingDisabled,
        };
      }

      // Auto pin: prefer it if available, otherwise rotate
      if (!inCooldown && !billingDisabled) {
        return {
          id: pinned.id,
          profile: pinned.profile,
          stats: pinned.stats,
          onlyOption: profiles.length === 1,
          inCooldown: false,
          billingDisabled: false,
        };
      }
      // Auto pin is unavailable — fall through to rotation
    }
  }

  // Separate into buckets
  const available: RankedProfile[] = [];
  const cooldown: RankedProfile[] = [];
  const disabled: RankedProfile[] = [];

  const now = Date.now();
  for (const r of ranked) {
    const isCd = r.cooldownUntil != null && now < r.cooldownUntil;
    const isDis = r.disabledUntil != null && now < r.disabledUntil;

    if (isDis) {
      disabled.push(r);
    } else if (isCd) {
      cooldown.push(r);
    } else {
      available.push(r);
    }
  }

  // Sort available: OAuth first, then oldest lastUsed
  available.sort((a, b) => {
    // OAuth before API key
    if (a.profile.type !== b.profile.type) {
      return a.profile.type === "oauth" ? -1 : 1;
    }
    // Oldest lastUsed first (round-robin)
    const aUsed = a.stats?.lastUsed ?? 0;
    const bUsed = b.stats?.lastUsed ?? 0;
    return aUsed - bUsed;
  });

  // Sort cooldown by soonest expiry
  cooldown.sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));

  // Sort disabled by soonest expiry
  disabled.sort((a, b) => (a.disabledUntil ?? 0) - (b.disabledUntil ?? 0));

  // Select the best option
  if (available.length > 0) {
    const best = available[0];
    return {
      id: best.id,
      profile: best.profile,
      stats: best.stats,
      onlyOption: profiles.length === 1,
      inCooldown: false,
      billingDisabled: false,
    };
  }

  // No available profiles — try cooldown (soonest to clear)
  if (cooldown.length > 0) {
    const best = cooldown[0];
    return {
      id: best.id,
      profile: best.profile,
      stats: best.stats,
      onlyOption: profiles.length === 1,
      inCooldown: true,
      billingDisabled: false,
    };
  }

  // Last resort — billing-disabled
  if (disabled.length > 0) {
    const best = disabled[0];
    return {
      id: best.id,
      profile: best.profile,
      stats: best.stats,
      onlyOption: profiles.length === 1,
      inCooldown: false,
      billingDisabled: true,
    };
  }

  return undefined;
}
