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
  it("returns all 8 tools by default", () => {
    const tools = createEmailTools(CWD);
    expect(tools).toHaveLength(8);
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
    expect(names).toContain("email_count");
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

// ─── email_search — new filters ─────────────────────

describe("email_search — new filters", () => {
  afterEach(clearEnv);

  it("accepts 'to' as a search criterion", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const searchTool = tools.find(t => t.name === "email_search")!;
    const result = await searchTool.execute("test-id", { to: "bob@test.com" } as any);
    expect(result.content[0]).toBeDefined();
    expect(result.details?.query).toHaveProperty("to", "bob@test.com");
  });

  it("accepts 'before' as a search criterion", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const searchTool = tools.find(t => t.name === "email_search")!;
    const result = await searchTool.execute("test-id", { before: "2025-01-01" } as any);
    expect(result.content[0]).toBeDefined();
    expect(result.details?.query).toHaveProperty("before", "2025-01-01");
  });

  it("accepts 'answered' as a search criterion", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const searchTool = tools.find(t => t.name === "email_search")!;
    const result = await searchTool.execute("test-id", { answered: true } as any);
    expect(result.content[0]).toBeDefined();
    expect(result.details?.query).toHaveProperty("answered", true);
  });

  it("accepts combined date range (since + before)", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const searchTool = tools.find(t => t.name === "email_search")!;
    const result = await searchTool.execute("test-id", {
      since: "2025-01-01",
      before: "2025-06-01",
    } as any);
    expect(result.content[0]).toBeDefined();
    expect(result.details?.query).toHaveProperty("since", "2025-01-01");
    expect(result.details?.query).toHaveProperty("before", "2025-06-01");
  });

  it("still rejects empty search criteria (including new fields)", async () => {
    const tools = createEmailTools(CWD);
    const searchTool = tools.find(t => t.name === "email_search")!;
    await expect(searchTool.execute("test-id", {} as any)).rejects.toThrow("at least one search criterion");
  });
});

// ─── email_count ─────────────────────────────────────

describe("email_count", () => {
  afterEach(clearEnv);

  it("counts all emails in a folder with no filters", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const countTool = tools.find(t => t.name === "email_count")!;
    expect(countTool).toBeDefined();
    expect(countTool.label).toBe("Count Emails");

    const result = await countTool.execute("test-id", {} as any);
    const text = (result.content[0] as any).text;
    expect(text).toContain("INBOX");
    expect(text).toContain("email(s)");
    expect(result.details).toHaveProperty("total");
    expect(result.details).toHaveProperty("unread");
    expect(typeof result.details?.total).toBe("number");
  });

  it("counts emails with from filter", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const countTool = tools.find(t => t.name === "email_count")!;
    const result = await countTool.execute("test-id", { from: "boss@company.com" } as any);
    expect(result.details?.filters).toHaveProperty("from", "boss@company.com");
    expect(result.details).toHaveProperty("total");
  });

  it("counts emails with date range", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const countTool = tools.find(t => t.name === "email_count")!;
    const result = await countTool.execute("test-id", {
      since: "2025-01-01",
      before: "2025-06-01",
    } as any);
    expect(result.details?.filters).toHaveProperty("since", "2025-01-01");
    expect(result.details?.filters).toHaveProperty("before", "2025-06-01");
  });

  it("counts unseen-only emails", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const countTool = tools.find(t => t.name === "email_count")!;
    const result = await countTool.execute("test-id", { unseen_only: true } as any);
    expect(result.details).toHaveProperty("total");
    // When unseen_only, unread === total
    expect(result.details?.unread).toBe(result.details?.total);
  });

  it("counts answered emails", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const countTool = tools.find(t => t.name === "email_count")!;
    const result = await countTool.execute("test-id", { answered: false } as any);
    expect(result.details?.filters).toHaveProperty("answered", false);
  });

  it("counts emails in a specific folder", async () => {
    setEnv("IMAP_HOST", "imap.test.com");
    setEnv("IMAP_USER", "alice@test.com");

    const tools = createEmailTools(CWD);
    const countTool = tools.find(t => t.name === "email_count")!;
    const result = await countTool.execute("test-id", { folder: "Sent" } as any);
    expect(result.details?.folder).toBe("Sent");
  });

  it("is included in email_* wildcard filtering", () => {
    const tools = createEmailTools(CWD, undefined, ["email_count"]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("email_count");
  });
});
