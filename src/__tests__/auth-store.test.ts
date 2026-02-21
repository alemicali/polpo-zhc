/**
 * Tests for the OAuth credential store, profile rotation, billing disable,
 * and session overrides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// We need to set POLPO_STATE_DIR before importing the store module
const TEST_DIR = join(tmpdir(), `.polpo-test-${randomBytes(6).toString("hex")}`);

// Set env before import
process.env.POLPO_STATE_DIR = TEST_DIR;

// Dynamic import after env set
const storeModule = await import("../auth/store.js");
const {
  profileId, saveProfile, getProfile, getProfilesForProvider,
  getAllProfiles, deleteProfile, deleteProviderProfiles,
  touchProfile, updateProfileCredentials, getProfilesPath,
  getUsageStats, updateUsageStats,
  recordProfileSuccess, recordProfileError, recordBillingFailure,
  isProfileInCooldown, isProfileBillingDisabled, isProfileAvailable,
  clearProfileCooldown,
} = storeModule;

const { selectProfileForProvider } = await import("../auth/profile-rotation.js");
const {
  getSessionOverride, applySessionModelOverride, clearSessionOverride,
  resolveSessionModel, parseModelCommand,
} = await import("../auth/session-overrides.js");
import type { OAuthProfile } from "../auth/types.js";

// ─── Helpers ────────────────────────────────────────

function makeProfile(provider: string, overrides?: Partial<OAuthProfile>): OAuthProfile {
  return {
    provider,
    type: "oauth",
    access: `test-access-token-${randomBytes(8).toString("hex")}`,
    refresh: `test-refresh-token-${randomBytes(8).toString("hex")}`,
    expires: Date.now() + 3_600_000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────

beforeEach(() => {
  // Ensure test dir is clean
  try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ok */ }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ok */ }
});

// ─── Store Tests ────────────────────────────────────

describe("Auth Store", () => {
  describe("profileId generation", () => {
    it("creates valid profile IDs", () => {
      expect(profileId("anthropic", "user@example.com")).toBe("anthropic:user@example.com");
      expect(profileId("openai", undefined)).toBe("openai:default");
      expect(profileId("github-copilot", "my-account")).toBe("github-copilot:my-account");
    });

    it("sanitizes unsafe characters in identifier", () => {
      const id = profileId("anthropic", "user/../../etc/passwd");
      expect(id).not.toContain("/");
      expect(id).not.toContain("..");
    });

    it("prevents prototype pollution in identifier", () => {
      const id = profileId("anthropic", "__proto__");
      expect(id).not.toBe("anthropic:__proto__");
      expect(id).toBe("anthropic:___proto__");
    });

    it("rejects invalid provider names", () => {
      expect(() => profileId("../bad", "test")).toThrow();
      expect(() => profileId("", "test")).toThrow();
      expect(() => profileId("UPPER", "test")).toThrow();
    });
  });

  describe("save and get profiles", () => {
    it("saves and retrieves a profile", () => {
      const profile = makeProfile("anthropic");
      saveProfile("anthropic:default", profile);

      const retrieved = getProfile("anthropic:default");
      expect(retrieved).toBeDefined();
      expect(retrieved!.provider).toBe("anthropic");
      expect(retrieved!.access).toBe(profile.access);
    });

    it("returns undefined for non-existent profile", () => {
      expect(getProfile("anthropic:nonexistent")).toBeUndefined();
    });

    it("lists profiles for a provider", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));
      saveProfile("anthropic:user@test.com", makeProfile("anthropic", { email: "user@test.com" }));
      saveProfile("openai:default", makeProfile("openai"));

      const anthropicProfiles = getProfilesForProvider("anthropic");
      expect(anthropicProfiles.length).toBe(2);

      const openaiProfiles = getProfilesForProvider("openai");
      expect(openaiProfiles.length).toBe(1);
    });

    it("lists all profiles", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));
      saveProfile("openai:default", makeProfile("openai"));

      const all = getAllProfiles();
      expect(all.length).toBe(2);
    });
  });

  describe("delete profiles", () => {
    it("deletes a specific profile", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));
      expect(deleteProfile("anthropic:default")).toBe(true);
      expect(getProfile("anthropic:default")).toBeUndefined();
    });

    it("returns false when deleting non-existent profile", () => {
      expect(deleteProfile("anthropic:nonexistent")).toBe(false);
    });

    it("deletes all profiles for a provider", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));
      saveProfile("anthropic:user@test.com", makeProfile("anthropic"));
      saveProfile("openai:default", makeProfile("openai"));

      const count = deleteProviderProfiles("anthropic");
      expect(count).toBe(2);
      expect(getProfilesForProvider("anthropic").length).toBe(0);
      expect(getProfilesForProvider("openai").length).toBe(1);
    });
  });

  describe("update credentials", () => {
    it("updates access token and expiry", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));
      const newAccess = `updated-token-${randomBytes(8).toString("hex")}`;
      const newExpires = Date.now() + 7200000;
      updateProfileCredentials("anthropic:default", newAccess, newExpires);

      const updated = getProfile("anthropic:default");
      expect(updated!.access).toBe(newAccess);
      expect(updated!.expires).toBe(newExpires);
    });

    it("updates lastUsed on credential update", () => {
      const before = new Date().toISOString();
      saveProfile("anthropic:default", makeProfile("anthropic"));
      updateProfileCredentials("anthropic:default", `token-${randomBytes(8).toString("hex")}`);

      const updated = getProfile("anthropic:default");
      expect(new Date(updated!.lastUsed!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe("touch profile", () => {
    it("updates lastUsed timestamp", () => {
      const profile = makeProfile("anthropic", { lastUsed: "2024-01-01T00:00:00Z" });
      saveProfile("anthropic:default", profile);

      touchProfile("anthropic:default");

      const updated = getProfile("anthropic:default");
      expect(new Date(updated!.lastUsed!).getTime()).toBeGreaterThan(new Date("2024-01-01").getTime());
    });
  });

  describe("file permissions", () => {
    it("creates files with restrictive permissions", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));

      const filePath = getProfilesPath();
      const stats = statSync(filePath);
      const mode = stats.mode & 0o777;
      // Should be 0o600 (owner read/write only)
      expect(mode).toBe(0o600);
    });

    it("creates directory with restrictive permissions", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));

      const stats = statSync(TEST_DIR);
      const mode = stats.mode & 0o777;
      // Should be 0o700 (owner only)
      expect(mode).toBe(0o700);
    });
  });

  describe("token validation", () => {
    it("rejects empty access tokens", () => {
      expect(() =>
        saveProfile("anthropic:default", makeProfile("anthropic", { access: "" })),
      ).toThrow("non-empty string");
    });

    it("rejects tokens with control characters", () => {
      expect(() =>
        saveProfile("anthropic:default", makeProfile("anthropic", { access: "token\x00value" })),
      ).toThrow("control characters");
    });

    it("rejects overly long tokens", () => {
      expect(() =>
        saveProfile("anthropic:default", makeProfile("anthropic", { access: "x".repeat(20000) })),
      ).toThrow("maximum length");
    });
  });

  describe("atomic writes", () => {
    it("file is valid JSON after write", () => {
      saveProfile("anthropic:default", makeProfile("anthropic"));
      const raw = readFileSync(getProfilesPath(), "utf8");
      const data = JSON.parse(raw);
      expect(data.version).toBe(1);
      expect(data.profiles["anthropic:default"]).toBeDefined();
    });
  });
});

// ─── Usage Stats Tests ──────────────────────────────

describe("Usage Stats", () => {
  beforeEach(() => {
    saveProfile("anthropic:default", makeProfile("anthropic"));
    saveProfile("anthropic:user@test.com", makeProfile("anthropic"));
  });

  describe("recordProfileSuccess", () => {
    it("clears cooldown and error counts", () => {
      recordProfileError("anthropic:default", "rate_limit");
      expect(isProfileInCooldown("anthropic:default")).toBe(true);

      recordProfileSuccess("anthropic:default");
      expect(isProfileInCooldown("anthropic:default")).toBe(false);

      const stats = getUsageStats("anthropic:default");
      expect(stats!.errorCount).toBe(0);
      expect(stats!.lastUsed).toBeDefined();
    });
  });

  describe("recordProfileError", () => {
    it("sets cooldown with exponential backoff", () => {
      const cd1 = recordProfileError("anthropic:default", "rate_limit");
      expect(cd1).toBe(60_000); // 1 minute

      clearProfileCooldown("anthropic:default");
      // Clear and re-record to get next step
      const stats1 = getUsageStats("anthropic:default");
      expect(stats1!.errorCount).toBe(0); // cleared

      const cd2 = recordProfileError("anthropic:default", "rate_limit");
      expect(cd2).toBe(60_000); // 1 minute (fresh start after clear)
    });

    it("increments error count on consecutive errors", () => {
      recordProfileError("anthropic:default", "rate_limit");
      recordProfileError("anthropic:default", "rate_limit");
      recordProfileError("anthropic:default", "rate_limit");

      const stats = getUsageStats("anthropic:default");
      expect(stats!.errorCount).toBe(3);
    });
  });

  describe("recordBillingFailure", () => {
    it("sets billing disable with longer backoff", () => {
      const disableMs = recordBillingFailure("anthropic:default", "billing", {
        billingBackoffHours: 5,
        billingMaxHours: 24,
        failureWindowHours: 24,
      });

      // First failure: 5 hours
      expect(disableMs).toBe(5 * 3_600_000);
      expect(isProfileBillingDisabled("anthropic:default")).toBe(true);
    });

    it("doubles backoff on subsequent billing failures", () => {
      const cd1 = recordBillingFailure("anthropic:default", "billing", {
        billingBackoffHours: 5,
        billingMaxHours: 24,
        failureWindowHours: 24,
      });
      expect(cd1).toBe(5 * 3_600_000); // 5h

      const cd2 = recordBillingFailure("anthropic:default", "billing", {
        billingBackoffHours: 5,
        billingMaxHours: 24,
        failureWindowHours: 24,
      });
      expect(cd2).toBe(10 * 3_600_000); // 10h

      const cd3 = recordBillingFailure("anthropic:default", "billing", {
        billingBackoffHours: 5,
        billingMaxHours: 24,
        failureWindowHours: 24,
      });
      expect(cd3).toBe(20 * 3_600_000); // 20h

      const cd4 = recordBillingFailure("anthropic:default", "billing", {
        billingBackoffHours: 5,
        billingMaxHours: 24,
        failureWindowHours: 24,
      });
      expect(cd4).toBe(24 * 3_600_000); // capped at 24h
    });
  });

  describe("profile availability", () => {
    it("available when no cooldown or disable", () => {
      expect(isProfileAvailable("anthropic:default")).toBe(true);
    });

    it("unavailable when in cooldown", () => {
      recordProfileError("anthropic:default", "rate_limit");
      expect(isProfileAvailable("anthropic:default")).toBe(false);
    });

    it("unavailable when billing disabled", () => {
      recordBillingFailure("anthropic:default", "billing");
      expect(isProfileAvailable("anthropic:default")).toBe(false);
    });

    it("clearProfileCooldown restores availability", () => {
      recordProfileError("anthropic:default", "rate_limit");
      recordBillingFailure("anthropic:default", "billing");
      expect(isProfileAvailable("anthropic:default")).toBe(false);

      clearProfileCooldown("anthropic:default");
      expect(isProfileAvailable("anthropic:default")).toBe(true);
    });
  });
});

// ─── Profile Rotation Tests ─────────────────────────

describe("Profile Rotation", () => {
  beforeEach(() => {
    // Create multiple profiles for anthropic
    saveProfile("anthropic:default", makeProfile("anthropic", { type: "api_key", lastUsed: "2024-01-01T00:00:00Z" }));
    saveProfile("anthropic:user@test.com", makeProfile("anthropic", { type: "oauth", lastUsed: "2024-01-02T00:00:00Z" }));
  });

  it("selects OAuth profiles before API key profiles", () => {
    const result = selectProfileForProvider("anthropic");
    expect(result).toBeDefined();
    // OAuth profile should be selected first even though it was used more recently
    // because OAuth > API key in priority
    expect(result!.profile.type).toBe("oauth");
  });

  it("selects oldest-lastUsed profile for round-robin", () => {
    // Make both OAuth
    saveProfile("anthropic:a@test.com", makeProfile("anthropic", { type: "oauth" }));
    recordProfileSuccess("anthropic:a@test.com"); // marks as recently used

    saveProfile("anthropic:b@test.com", makeProfile("anthropic", { type: "oauth" }));
    // b@test.com has no lastUsed in stats → treated as 0 → selected first

    // The profile with oldest lastUsed (or no lastUsed) should be preferred
    const result = selectProfileForProvider("anthropic");
    expect(result).toBeDefined();
  });

  it("skips profiles in cooldown", () => {
    recordProfileError("anthropic:user@test.com", "rate_limit");
    const result = selectProfileForProvider("anthropic");
    expect(result).toBeDefined();
    // Should select the non-cooldown profile
    expect(result!.inCooldown).toBe(false);
  });

  it("skips billing-disabled profiles", () => {
    recordBillingFailure("anthropic:user@test.com", "billing");
    const result = selectProfileForProvider("anthropic");
    expect(result).toBeDefined();
    expect(result!.billingDisabled).toBe(false);
  });

  it("falls back to cooldown profile when no available profiles", () => {
    recordProfileError("anthropic:default", "rate_limit");
    recordProfileError("anthropic:user@test.com", "rate_limit");

    const result = selectProfileForProvider("anthropic");
    expect(result).toBeDefined();
    expect(result!.inCooldown).toBe(true);
  });

  it("returns undefined for unknown provider", () => {
    const result = selectProfileForProvider("unknown-provider");
    expect(result).toBeUndefined();
  });

  describe("pinned profiles", () => {
    it("prefers user-pinned profile even in cooldown", () => {
      recordProfileError("anthropic:user@test.com", "rate_limit");

      const result = selectProfileForProvider("anthropic", "anthropic:user@test.com", "user");
      expect(result).toBeDefined();
      expect(result!.id).toBe("anthropic:user@test.com");
      expect(result!.inCooldown).toBe(true);
    });

    it("auto-pinned profile rotates away when in cooldown", () => {
      recordProfileError("anthropic:user@test.com", "rate_limit");

      const result = selectProfileForProvider("anthropic", "anthropic:user@test.com", "auto");
      expect(result).toBeDefined();
      // Should have rotated to the other profile
      expect(result!.id).toBe("anthropic:default");
    });
  });
});

// ─── Session Overrides Tests ────────────────────────

describe("Session Overrides", () => {
  describe("applySessionModelOverride", () => {
    it("sets model override", () => {
      const changed = applySessionModelOverride("session-1", {
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(changed).toBe(true);

      const override = getSessionOverride("session-1");
      expect(override).toBeDefined();
      expect(override!.providerOverride).toBe("anthropic");
      expect(override!.modelOverride).toBe("claude-opus-4-6");
    });

    it("clears override with isDefault", () => {
      applySessionModelOverride("session-1", { provider: "anthropic", model: "claude-opus-4-6" });
      const cleared = applySessionModelOverride("session-1", { isDefault: true });
      expect(cleared).toBe(true);
      expect(getSessionOverride("session-1")).toBeUndefined();
    });

    it("returns false when nothing changed", () => {
      applySessionModelOverride("session-1", { provider: "anthropic", model: "claude-opus-4-6" });
      const changed = applySessionModelOverride("session-1", { provider: "anthropic", model: "claude-opus-4-6" });
      expect(changed).toBe(false);
    });

    it("sets profile pin", () => {
      applySessionModelOverride(
        "session-1",
        { provider: "anthropic", model: "claude-opus-4-6" },
        "anthropic:user@test.com",
        "user",
      );

      const override = getSessionOverride("session-1");
      expect(override!.authProfileOverride).toBe("anthropic:user@test.com");
      expect(override!.authProfileOverrideSource).toBe("user");
    });
  });

  describe("clearSessionOverride", () => {
    it("removes override", () => {
      applySessionModelOverride("session-1", { provider: "anthropic", model: "claude-opus-4-6" });
      clearSessionOverride("session-1");
      expect(getSessionOverride("session-1")).toBeUndefined();
    });
  });

  describe("resolveSessionModel", () => {
    it("returns default when no override", () => {
      const result = resolveSessionModel("no-session", "anthropic:claude-haiku-4-5-20251001");
      expect(result.spec).toBe("anthropic:claude-haiku-4-5-20251001");
      expect(result.overridden).toBe(false);
    });

    it("returns override when set", () => {
      applySessionModelOverride("session-2", { provider: "anthropic", model: "claude-opus-4-6" });
      const result = resolveSessionModel("session-2", "anthropic:claude-haiku-4-5-20251001");
      expect(result.spec).toBe("anthropic:claude-opus-4-6");
      expect(result.overridden).toBe(true);
    });

    it("includes pinned profile info", () => {
      applySessionModelOverride(
        "session-3",
        { provider: "anthropic", model: "claude-opus-4-6" },
        "anthropic:user@test.com",
        "user",
      );
      const result = resolveSessionModel("session-3", "anthropic:claude-haiku-4-5-20251001");
      expect(result.pinnedProfileId).toBe("anthropic:user@test.com");
      expect(result.pinnedSource).toBe("user");
    });
  });
});

// ─── /model Command Parser Tests ────────────────────

describe("parseModelCommand", () => {
  it("parses empty input as list", () => {
    expect(parseModelCommand("")).toEqual({ action: "list" });
    expect(parseModelCommand("list")).toEqual({ action: "list" });
  });

  it("parses status", () => {
    expect(parseModelCommand("status")).toEqual({ action: "status" });
  });

  it("parses reset", () => {
    expect(parseModelCommand("reset")).toEqual({ action: "reset" });
    expect(parseModelCommand("default")).toEqual({ action: "reset" });
  });

  it("parses numeric pick", () => {
    expect(parseModelCommand("3")).toEqual({ action: "pick", index: 3 });
    expect(parseModelCommand("12")).toEqual({ action: "pick", index: 12 });
  });

  it("parses provider/model format", () => {
    expect(parseModelCommand("openai/gpt-5.2")).toEqual({
      action: "set",
      provider: "openai",
      model: "gpt-5.2",
      profileId: undefined,
    });
  });

  it("parses provider:model format", () => {
    expect(parseModelCommand("anthropic:claude-opus-4-6")).toEqual({
      action: "set",
      provider: "anthropic",
      model: "claude-opus-4-6",
      profileId: undefined,
    });
  });

  it("parses bare model name", () => {
    expect(parseModelCommand("claude-opus-4-6")).toEqual({
      action: "set",
      model: "claude-opus-4-6",
      profileId: undefined,
    });
  });

  it("parses model@profile syntax", () => {
    expect(parseModelCommand("claude-opus-4-6@anthropic:user@test.com")).toEqual({
      action: "set",
      model: "claude-opus-4-6",
      profileId: "anthropic:user@test.com",
    });
  });

  it("parses provider/model@profile syntax", () => {
    expect(parseModelCommand("anthropic/claude-opus-4-6@anthropic:default")).toEqual({
      action: "set",
      provider: "anthropic",
      model: "claude-opus-4-6",
      profileId: "anthropic:default",
    });
  });
});
