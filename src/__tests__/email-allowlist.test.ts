import { describe, it, expect } from "vitest";
import { createEmailTools } from "../tools/email-tools.js";

/**
 * Tests for email recipient domain allowlist.
 * Does NOT send real emails — tests the domain validation logic
 * by triggering early rejection before SMTP connection.
 */

describe("email allowlist", () => {
  const cwd = "/tmp/test";

  it("blocks email to domain not in allowlist", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["acme.com"]);
    const sendTool = tools.find(t => t.name === "email_send")!;
    expect(sendTool).toBeDefined();

    // Provide SMTP config so we get past that check, but should fail on domain
    await expect(sendTool.execute("tc1", {
      to: "user@evil.com",
      subject: "Test",
      body: "Hello",
      smtp_host: "localhost",
      from: "sender@acme.com",
    })).rejects.toThrow("not in the allowed domains");
  });

  it("allows email to domain in allowlist (via smtp_host so we hit the domain check)", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["acme.com"]);
    const sendTool = tools.find(t => t.name === "email_send")!;

    // This will pass domain validation but fail on actual SMTP connection — that's expected
    await expect(sendTool.execute("tc2", {
      to: "user@acme.com",
      subject: "Test",
      body: "Hello",
      smtp_host: "nonexistent.invalid",
      smtp_port: 587,
      from: "sender@acme.com",
    })).rejects.not.toThrow("not in the allowed domains");
  });

  it("blocks when any one recipient is outside allowlist", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["acme.com"]);
    const sendTool = tools.find(t => t.name === "email_send")!;

    await expect(sendTool.execute("tc3", {
      to: ["user@acme.com", "outsider@evil.com"],
      subject: "Test",
      body: "Hello",
      smtp_host: "localhost",
      from: "sender@acme.com",
    })).rejects.toThrow("not in the allowed domains");
  });

  it("blocks CC recipients outside allowlist", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["acme.com"]);
    const sendTool = tools.find(t => t.name === "email_send")!;

    await expect(sendTool.execute("tc4", {
      to: "user@acme.com",
      cc: "hacker@evil.com",
      subject: "Test",
      body: "Hello",
      smtp_host: "localhost",
      from: "sender@acme.com",
    })).rejects.toThrow("not in the allowed domains");
  });

  it("blocks BCC recipients outside allowlist", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["acme.com"]);
    const sendTool = tools.find(t => t.name === "email_send")!;

    await expect(sendTool.execute("tc5", {
      to: "user@acme.com",
      bcc: "spy@evil.com",
      subject: "Test",
      body: "Hello",
      smtp_host: "localhost",
      from: "sender@acme.com",
    })).rejects.toThrow("not in the allowed domains");
  });

  it("allows all domains when no allowlist provided", async () => {
    // No allowlist — should NOT block on domain (will fail on SMTP instead)
    const tools = createEmailTools(cwd);
    const sendTool = tools.find(t => t.name === "email_send")!;

    // Should fail with SMTP error, NOT domain block
    await expect(sendTool.execute("tc6", {
      to: "anyone@anywhere.com",
      subject: "Test",
      body: "Hello",
      smtp_host: "nonexistent.invalid",
      from: "sender@example.com",
    })).rejects.not.toThrow("not in the allowed domains");
  });

  it("allows multiple allowlisted domains", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["acme.com", "partner.io"]);
    const sendTool = tools.find(t => t.name === "email_send")!;

    // Should pass domain validation but fail on SMTP
    await expect(sendTool.execute("tc7", {
      to: ["user@acme.com", "user@partner.io"],
      subject: "Test",
      body: "Hello",
      smtp_host: "nonexistent.invalid",
      from: "sender@acme.com",
    })).rejects.not.toThrow("not in the allowed domains");
  });

  it("is case-insensitive for domain matching", async () => {
    const tools = createEmailTools(cwd, undefined, undefined, undefined, ["Acme.COM"]);
    const sendTool = tools.find(t => t.name === "email_send")!;

    // Should pass domain check (case-insensitive), fail on SMTP
    await expect(sendTool.execute("tc8", {
      to: "user@acme.com",
      subject: "Test",
      body: "Hello",
      smtp_host: "nonexistent.invalid",
      from: "sender@acme.com",
    })).rejects.not.toThrow("not in the allowed domains");
  });
});
