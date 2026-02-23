import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEnvVar, resolveVaultCredentials, resolveAgentVault } from "../vault/resolver.js";
import type { VaultEntry } from "../core/types.js";

// ─── Environment helpers ─────────────────────────────

const envKeys: string[] = [];

function setEnv(key: string, value: string) {
  envKeys.push(key);
  process.env[key] = value;
}

function clearEnv() {
  for (const key of envKeys) delete process.env[key];
  envKeys.length = 0;
}

// ─── resolveEnvVar ───────────────────────────────────

describe("resolveEnvVar", () => {
  beforeEach(() => setEnv("TEST_FOO", "bar"));
  afterEach(clearEnv);

  it("resolves ${VAR} to env value", () => {
    expect(resolveEnvVar("${TEST_FOO}")).toBe("bar");
  });

  it("resolves inline ${VAR}", () => {
    expect(resolveEnvVar("prefix-${TEST_FOO}-suffix")).toBe("prefix-bar-suffix");
  });

  it("replaces missing var with empty string", () => {
    expect(resolveEnvVar("${MISSING_XYZ}")).toBe("");
  });

  it("returns plain strings as-is", () => {
    expect(resolveEnvVar("plain-value")).toBe("plain-value");
  });

  it("resolves multiple vars in one string", () => {
    setEnv("TEST_A", "hello");
    setEnv("TEST_B", "world");
    expect(resolveEnvVar("${TEST_A}-${TEST_B}")).toBe("hello-world");
  });
});

// ─── resolveVaultCredentials ─────────────────────────

describe("resolveVaultCredentials", () => {
  beforeEach(() => {
    setEnv("SMTP_HOST_TEST", "mail.example.com");
    setEnv("SMTP_PASS_TEST", "s3cret");
  });
  afterEach(clearEnv);

  it("resolves mix of literal and env refs", () => {
    const entry: VaultEntry = {
      type: "smtp",
      credentials: {
        host: "${SMTP_HOST_TEST}",
        port: "587",
        user: "alice",
        pass: "${SMTP_PASS_TEST}",
      },
    };
    const resolved = resolveVaultCredentials(entry);
    expect(resolved).toEqual({
      host: "mail.example.com",
      port: "587",
      user: "alice",
      pass: "s3cret",
    });
  });

  it("returns all-literal credentials as-is", () => {
    const entry: VaultEntry = {
      type: "api_key",
      credentials: { key: "abc123", endpoint: "https://api.example.com" },
    };
    const resolved = resolveVaultCredentials(entry);
    expect(resolved).toEqual({ key: "abc123", endpoint: "https://api.example.com" });
  });
});

// ─── resolveAgentVault ───────────────────────────────

describe("resolveAgentVault", () => {
  afterEach(clearEnv);

  it("returns empty vault for undefined input", () => {
    const vault = resolveAgentVault(undefined);
    expect(vault.has("anything")).toBe(false);
    expect(vault.get("anything")).toBeUndefined();
    expect(vault.getSmtp()).toBeUndefined();
    expect(vault.getImap()).toBeUndefined();
  });

  it("getSmtp() returns correct SmtpCredentials", () => {
    setEnv("VR_PASS", "mypass");
    const vault = resolveAgentVault({
      email: {
        type: "smtp",
        credentials: {
          host: "smtp.example.com",
          port: "465",
          user: "alice",
          pass: "${VR_PASS}",
          from: "alice@example.com",
          secure: "true",
        },
      },
    });
    const smtp = vault.getSmtp();
    expect(smtp).toBeDefined();
    expect(smtp!.host).toBe("smtp.example.com");
    expect(smtp!.port).toBe(465);
    expect(smtp!.user).toBe("alice");
    expect(smtp!.pass).toBe("mypass");
    expect(smtp!.from).toBe("alice@example.com");
    expect(smtp!.secure).toBe(true);
  });

  it("getImap() returns correct ImapCredentials", () => {
    const vault = resolveAgentVault({
      inbox: {
        type: "imap",
        credentials: {
          host: "imap.example.com",
          port: "993",
          user: "bob",
          pass: "secret",
        },
      },
    });
    const imap = vault.getImap();
    expect(imap).toBeDefined();
    expect(imap!.host).toBe("imap.example.com");
    expect(imap!.port).toBe(993);
    expect(imap!.user).toBe("bob");
    expect(imap!.pass).toBe("secret");
    expect(imap!.tls).toBe(true);
  });

  it("get(service) returns resolved credentials", () => {
    setEnv("API_TOKEN", "tok_123");
    const vault = resolveAgentVault({
      github: {
        type: "api_key",
        credentials: { token: "${API_TOKEN}" },
      },
    });
    expect(vault.get("github")).toEqual({ token: "tok_123" });
  });

  it("has() returns true/false correctly", () => {
    const vault = resolveAgentVault({
      svc: { type: "custom", credentials: { a: "1" } },
    });
    expect(vault.has("svc")).toBe(true);
    expect(vault.has("nope")).toBe(false);
  });

  it("uses default port 587 for smtp when port omitted", () => {
    const vault = resolveAgentVault({
      mail: {
        type: "smtp",
        credentials: { host: "smtp.test.com", user: "u", pass: "p", from: "u@test.com" },
      },
    });
    expect(vault.getSmtp()!.port).toBe(587);
  });

  it("uses default port 993 for imap when port omitted", () => {
    const vault = resolveAgentVault({
      inbox: {
        type: "imap",
        credentials: { host: "imap.test.com", user: "u", pass: "p" },
      },
    });
    expect(vault.getImap()!.port).toBe(993);
  });

  it("secure 'false' resolves to undefined for smtp", () => {
    const vault = resolveAgentVault({
      mail: {
        type: "smtp",
        credentials: { host: "h", secure: "false", from: "a@b.c" },
      },
    });
    expect(vault.getSmtp()!.secure).toBeUndefined();
  });

  it("tls 'false' resolves to undefined for imap", () => {
    const vault = resolveAgentVault({
      inbox: {
        type: "imap",
        credentials: { host: "h", user: "u", pass: "p", tls: "false" },
      },
    });
    expect(vault.getImap()!.tls).toBeUndefined();
  });

  it("getSmtp() returns undefined when host is missing", () => {
    const vault = resolveAgentVault({
      mail: {
        type: "smtp",
        credentials: { user: "u", pass: "p" },
      },
    });
    expect(vault.getSmtp()).toBeUndefined();
  });

  it("getImap() returns undefined when host is missing", () => {
    const vault = resolveAgentVault({
      inbox: {
        type: "imap",
        credentials: { user: "u", pass: "p" },
      },
    });
    expect(vault.getImap()).toBeUndefined();
  });
});
