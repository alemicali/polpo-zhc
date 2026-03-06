import { describe, it, expect, vi, afterEach } from "vitest";
import { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "../tools/email-tools.js";
import type { ResolvedVault, SmtpCredentials } from "../vault/resolver.js";

// Mock nodemailer so we never actually connect to SMTP
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({
        messageId: "test-id",
        accepted: ["to@test.com"],
        rejected: [],
        message: Buffer.from("From: alice@test.com\r\nSubject: Test\r\n\r\nBody"),
      }),
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}));

// Mock imapflow so we never actually connect to IMAP
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    search: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockImplementation(async function* () {
      yield { path: "Drafts", specialUse: "\\Drafts" };
    }),
    append: vi.fn().mockResolvedValue({ uid: 42 }),
    logout: vi.fn().mockResolvedValue(undefined),
  })),
}));

const CWD = "/tmp/email-test";

// ─── Env helpers ─────────────────────────────────────

const envKeys: string[] = [];
function setEnv(key: string, value: string) { envKeys.push(key); process.env[key] = value; }
function clearEnv() { for (const key of envKeys) delete process.env[key]; envKeys.length = 0; }

// ─── Mock vault ──────────────────────────────────────

function createMockVault(smtp?: SmtpCredentials): ResolvedVault {
  return {
    get: () => undefined,
    getSmtp: () => smtp,
    getImap: () => undefined,
    getKey: () => undefined,
    has: () => false,
    list: () => [],
  };
}

// ─── Factory tests ───────────────────────────────────

describe("createEmailTools — factory", () => {
  it("returns all 7 tools by default", () => {
    const tools = createEmailTools(CWD);
    expect(tools).toHaveLength(7);
    const names = tools.map(t => t.name);
    expect(names).toEqual(ALL_EMAIL_TOOL_NAMES);
  });

  it("filters tools by allowedTools", () => {
    const tools = createEmailTools(CWD, undefined, ["email_send"]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("email_send");
  });

  it("returns correct tool names", () => {
    const tools = createEmailTools(CWD);
    const names = tools.map(t => t.name);
    expect(names).toContain("email_send");
    expect(names).toContain("email_draft");
    expect(names).toContain("email_verify");
    expect(names).toContain("email_list");
    expect(names).toContain("email_read");
    expect(names).toContain("email_search");
    expect(names).toContain("email_download_attachment");
  });
});

describe("email_draft", () => {
  afterEach(clearEnv);

  it("saves draft email using IMAP credentials from env", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const draftTool = tools.find(t => t.name === "email_draft")!;
    const result = await draftTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Draft subject",
      body: "Draft body",
    } as any);

    const firstContent = result.content[0] as any;
    expect(firstContent.text).toContain("Draft saved successfully");
    expect(result.details?.folder).toBe("Drafts");
  });
});

// ─── email_send — credential resolution ─────────────

describe("email_send — credential resolution", () => {
  afterEach(clearEnv);

  it("throws when no SMTP host configured", async () => {
    const tools = createEmailTools(CWD);
    const sendTool = tools.find(t => t.name === "email_send")!;
    await expect(sendTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Hi",
      body: "Hello",
    } as any)).rejects.toThrow("SMTP host not configured");
  });

  it("throws when no from address configured", async () => {
    setEnv("SMTP_HOST", "smtp.test.com");
    const tools = createEmailTools(CWD);
    const sendTool = tools.find(t => t.name === "email_send")!;
    await expect(sendTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Hi",
      body: "Hello",
    } as any)).rejects.toThrow("Sender address not configured");
  });

  it("sends email when env vars are configured", async () => {
    setEnv("SMTP_HOST", "smtp.test.com");
    setEnv("SMTP_FROM", "alice@test.com");
    const tools = createEmailTools(CWD);
    const sendTool = tools.find(t => t.name === "email_send")!;
    const result = await sendTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Hi",
      body: "Hello world",
    } as any);
    expect(result.details?.messageId).toBe("test-id");
  });
});

// ─── email_send — sandbox enforcement ────────────────

describe("email_send — sandbox enforcement", () => {
  afterEach(clearEnv);

  it("rejects attachment outside sandbox", async () => {
    setEnv("SMTP_HOST", "smtp.test.com");
    setEnv("SMTP_FROM", "alice@test.com");
    const tools = createEmailTools(CWD);
    const sendTool = tools.find(t => t.name === "email_send")!;
    // Should throw because /etc/passwd is outside CWD sandbox
    await expect(sendTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Hi",
      body: "Hello",
      attachments: [{ path: "/etc/passwd" }],
    } as any)).rejects.toThrow("sandbox");
  });

  it("rejects nonexistent attachment", async () => {
    setEnv("SMTP_HOST", "smtp.test.com");
    setEnv("SMTP_FROM", "alice@test.com");
    // Use a path inside CWD to pass sandbox check but that doesn't exist
    const tools = createEmailTools(CWD, ["/tmp/email-test"]);
    const sendTool = tools.find(t => t.name === "email_send")!;
    await expect(sendTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Hi",
      body: "Hello",
      attachments: [{ path: "nonexistent-file.txt" }],
    } as any)).rejects.toThrow("Attachment not found");
  });
});

// ─── email_search — validation ───────────────────────

describe("email_search — validation", () => {
  it("throws when no search criteria provided", async () => {
    const tools = createEmailTools(CWD);
    const searchTool = tools.find(t => t.name === "email_search")!;
    await expect(searchTool.execute("test-id", {} as any)).rejects.toThrow("at least one search criterion");
  });
});

// ─── email_verify — credential resolution ────────────

describe("email_verify — credential resolution", () => {
  afterEach(clearEnv);

  it("throws when no SMTP host configured", async () => {
    const tools = createEmailTools(CWD);
    const verifyTool = tools.find(t => t.name === "email_verify")!;
    await expect(verifyTool.execute("test-id", {} as any)).rejects.toThrow("SMTP host not configured");
  });

  it("verifies when env vars are set", async () => {
    setEnv("SMTP_HOST", "smtp.test.com");
    const tools = createEmailTools(CWD);
    const verifyTool = tools.find(t => t.name === "email_verify")!;
    const result = await verifyTool.execute("test-id", {} as any);
    expect(result.details?.verified).toBe(true);
  });
});

// ─── Vault integration ──────────────────────────────

describe("email_send — vault integration", () => {
  afterEach(clearEnv);

  it("uses vault SMTP credentials", async () => {
    const vault = createMockVault({
      host: "vault-smtp.example.com",
      port: 465,
      user: "vaultuser",
      pass: "vaultpass",
      from: "vault@example.com",
      secure: true,
    });
    const tools = createEmailTools(CWD, undefined, undefined, vault);
    const sendTool = tools.find(t => t.name === "email_send")!;
    const result = await sendTool.execute("test-id", {
      to: "bob@test.com",
      subject: "Via Vault",
      body: "Sent using vault credentials",
    } as any);
    expect(result.details?.messageId).toBe("test-id");
  });
});
