/**
 * Unit tests for EncryptedVaultStore — the file-based AES-256-GCM vault backend.
 *
 * Uses a temp directory and POLPO_VAULT_KEY env var for deterministic keys.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultEntry } from "../core/types.js";

// Provide a deterministic vault key for tests (32 bytes hex-encoded)
const TEST_KEY = randomBytes(32).toString("hex");
process.env.POLPO_VAULT_KEY = TEST_KEY;

let polpoDir: string;
let store: EncryptedVaultStore;

beforeEach(() => {
  polpoDir = mkdtempSync(join(tmpdir(), "polpo-vault-test-"));
  store = new EncryptedVaultStore(polpoDir);
});

afterEach(() => {
  rmSync(polpoDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// Basic CRUD
// ═══════════════════════════════════════════════════════════════════════

describe("EncryptedVaultStore CRUD", () => {
  it("set + get round-trip", async () => {
    const entry: VaultEntry = { type: "api_key", credentials: { key: "sk-secret-123" } };
    await store.set("claude", "openai", entry);

    const fetched = await store.get("claude", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.type).toBe("api_key");
    expect(fetched!.credentials.key).toBe("sk-secret-123");
  });

  it("get returns undefined for non-existent", async () => {
    expect(await store.get("ghost", "none")).toBeUndefined();
  });

  it("set with label preserves label", async () => {
    const entry: VaultEntry = { type: "oauth", label: "Main Account", credentials: { token: "abc" } };
    await store.set("claude", "github", entry);

    const fetched = await store.get("claude", "github");
    expect(fetched!.label).toBe("Main Account");
  });

  it("set overwrites existing entry", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "old" } });
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "new" } });

    const fetched = await store.get("claude", "openai");
    expect(fetched!.credentials.key).toBe("new");
  });

  it("getAllForAgent returns map by service", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k1" } });
    await store.set("claude", "smtp", { type: "smtp", credentials: { host: "mail.test" } });
    await store.set("gpt", "openai", { type: "api_key", credentials: { key: "k2" } });

    const claudeEntries = await store.getAllForAgent("claude");
    expect(Object.keys(claudeEntries).sort()).toEqual(["openai", "smtp"]);
    expect(claudeEntries.openai.credentials.key).toBe("k1");
  });

  it("getAllForAgent returns empty for unknown agent", async () => {
    const result = await store.getAllForAgent("ghost");
    expect(result).toEqual({});
  });

  it("remove deletes entry and returns true", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k" } });
    const ok = await store.remove("claude", "openai");
    expect(ok).toBe(true);
    expect(await store.get("claude", "openai")).toBeUndefined();
  });

  it("remove returns false for non-existent", async () => {
    expect(await store.remove("ghost", "none")).toBe(false);
  });

  it("remove cleans up empty agent record", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k" } });
    await store.remove("claude", "openai");
    expect(await store.hasEntries("claude")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// patch
// ═══════════════════════════════════════════════════════════════════════

describe("EncryptedVaultStore patch", () => {
  it("merges credentials with existing entry", async () => {
    await store.set("claude", "smtp", { type: "smtp", credentials: { host: "mail.test", port: "587" } });
    const keys = await store.patch("claude", "smtp", { credentials: { user: "alice" } });
    expect(keys.sort()).toEqual(["host", "port", "user"]);

    const fetched = await store.get("claude", "smtp");
    expect(fetched!.credentials.user).toBe("alice");
    expect(fetched!.credentials.host).toBe("mail.test"); // preserved
  });

  it("creates new entry when type is provided", async () => {
    const keys = await store.patch("claude", "new-svc", { type: "custom", credentials: { token: "abc" } });
    expect(keys).toEqual(["token"]);

    const fetched = await store.get("claude", "new-svc");
    expect(fetched).toBeDefined();
    expect(fetched!.type).toBe("custom");
  });

  it("throws when entry does not exist and no type provided", async () => {
    await expect(
      store.patch("claude", "ghost", { credentials: { key: "val" } }),
    ).rejects.toThrow(/type is required/);
  });

  it("updates type and label", async () => {
    await store.set("claude", "svc", { type: "api_key", credentials: { key: "k" } });
    await store.patch("claude", "svc", { type: "oauth", label: "New Label" });

    const fetched = await store.get("claude", "svc");
    expect(fetched!.type).toBe("oauth");
    expect(fetched!.label).toBe("New Label");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// list + hasEntries
// ═══════════════════════════════════════════════════════════════════════

describe("EncryptedVaultStore list + hasEntries", () => {
  it("list returns metadata without credential values", async () => {
    await store.set("claude", "openai", { type: "api_key", label: "Main", credentials: { key: "sk", org: "o" } });
    const list = await store.list("claude");
    expect(list).toHaveLength(1);
    expect(list[0].service).toBe("openai");
    expect(list[0].type).toBe("api_key");
    expect(list[0].label).toBe("Main");
    expect(list[0].keys.sort()).toEqual(["key", "org"]);
  });

  it("list returns empty for unknown agent", async () => {
    expect(await store.list("ghost")).toEqual([]);
  });

  it("hasEntries returns correct boolean", async () => {
    expect(await store.hasEntries("claude")).toBe(false);
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k" } });
    expect(await store.hasEntries("claude")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// renameAgent + removeAgent
// ═══════════════════════════════════════════════════════════════════════

describe("EncryptedVaultStore agent operations", () => {
  it("renameAgent moves entries to new name", async () => {
    await store.set("old-agent", "openai", { type: "api_key", credentials: { key: "k" } });
    await store.renameAgent("old-agent", "new-agent");

    expect(await store.get("old-agent", "openai")).toBeUndefined();
    const fetched = await store.get("new-agent", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.credentials.key).toBe("k");
  });

  it("renameAgent is no-op for unknown agent", async () => {
    await store.renameAgent("ghost", "other"); // should not throw
    expect(await store.hasEntries("other")).toBe(false);
  });

  it("removeAgent deletes all entries for agent", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k1" } });
    await store.set("claude", "smtp", { type: "smtp", credentials: { host: "h" } });
    await store.removeAgent("claude");
    expect(await store.hasEntries("claude")).toBe(false);
  });

  it("removeAgent is no-op for unknown agent", async () => {
    await store.removeAgent("ghost"); // should not throw
  });
});

// ═══════════════════════════════════════════════════════════════════════
// migrateFromConfigs
// ═══════════════════════════════════════════════════════════════════════

describe("EncryptedVaultStore migrateFromConfigs", () => {
  it("migrates inline vault credentials to encrypted store", async () => {
    const agents = [
      {
        name: "claude",
        vault: {
          openai: { type: "api_key" as const, credentials: { key: "sk-real-key" } },
          smtp: { type: "smtp" as const, credentials: { host: "mail.test", port: "587" } },
        },
      },
      { name: "gpt" }, // no vault — should be skipped
    ];

    const count = await store.migrateFromConfigs(agents);
    expect(count).toBe(2);

    // Verify entries were written
    const openai = await store.get("claude", "openai");
    expect(openai!.credentials.key).toBe("sk-real-key");

    const smtp = await store.get("claude", "smtp");
    expect(smtp!.credentials.host).toBe("mail.test");
  });

  it("strips credential values from agent configs", async () => {
    const agents = [
      {
        name: "claude",
        vault: {
          openai: { type: "api_key" as const, credentials: { key: "sk-real-key" } },
        },
      },
    ];

    await store.migrateFromConfigs(agents);

    // The original config should have empty strings for credential values
    expect(agents[0].vault!.openai.credentials.key).toBe("");
  });

  it("skips entries already in vault", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "existing" } });

    const agents = [
      {
        name: "claude",
        vault: {
          openai: { type: "api_key" as const, credentials: { key: "should-not-overwrite" } },
          smtp: { type: "smtp" as const, credentials: { host: "new" } },
        },
      },
    ];

    const count = await store.migrateFromConfigs(agents);
    expect(count).toBe(1); // only smtp should be migrated

    const openai = await store.get("claude", "openai");
    expect(openai!.credentials.key).toBe("existing"); // not overwritten
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Persistence + Encryption
// ═══════════════════════════════════════════════════════════════════════

describe("EncryptedVaultStore persistence", () => {
  it("data survives store re-instantiation", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "persistent" } });

    // Re-create store from same directory
    const store2 = new EncryptedVaultStore(polpoDir);
    const fetched = await store2.get("claude", "openai");
    expect(fetched).toBeDefined();
    expect(fetched!.credentials.key).toBe("persistent");
  });

  it("vault file is encrypted (not readable plaintext)", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "top-secret" } });

    const vaultPath = join(polpoDir, "vault.enc");
    expect(existsSync(vaultPath)).toBe(true);

    const raw = readFileSync(vaultPath);
    const asString = raw.toString("utf-8");
    // Encrypted data should not contain the plaintext secret
    expect(asString).not.toContain("top-secret");
    expect(asString).not.toContain("api_key");
  });

  it("loads empty vault when file does not exist", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "polpo-vault-empty-"));
    try {
      const freshStore = new EncryptedVaultStore(freshDir);
      expect(await freshStore.hasEntries("claude")).toBe(false);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("handles corrupted vault file gracefully", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k" } });

    // Corrupt the vault file
    const vaultPath = join(polpoDir, "vault.enc");
    const { writeFileSync: wfs } = await import("node:fs");
    wfs(vaultPath, Buffer.from("corrupted-data"));

    // Re-create store — should warn and start empty
    const store2 = new EncryptedVaultStore(polpoDir);
    expect(await store2.hasEntries("claude")).toBe(false);
  });

  it("decryption with wrong key fails gracefully", async () => {
    await store.set("claude", "openai", { type: "api_key", credentials: { key: "k" } });

    // Use a different key
    const otherKey = randomBytes(32).toString("hex");
    const originalKey = process.env.POLPO_VAULT_KEY;
    process.env.POLPO_VAULT_KEY = otherKey;

    try {
      // Re-create store — should fail decryption gracefully
      const store2 = new EncryptedVaultStore(polpoDir);
      expect(await store2.hasEntries("claude")).toBe(false);
    } finally {
      process.env.POLPO_VAULT_KEY = originalKey;
    }
  });
});
