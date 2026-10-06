import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = { value: "" };

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetchOne: vi.fn().mockImplementation(async () => ({
      uid: 7,
      envelope: { subject: "Report", from: [{ name: "A", address: "a@x.com" }], to: [{ name: "B", address: "b@x.com" }], date: "2026-10-01T00:00:00Z" },
      source: Buffer.from(source.value, "utf-8"),
      bodyStructure: undefined,
    })),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createEmailTools } from "../tools/email-tools.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polpo-email-offload-"));
  process.env.IMAP_HOST = "imap.test.com";
  process.env.IMAP_USER = "alice@test.com";
});
afterEach(() => {
  delete process.env.IMAP_HOST;
  delete process.env.IMAP_USER;
  rmSync(root, { recursive: true, force: true });
});

function readTool(outputDir: string) {
  return createEmailTools(root, undefined, ["email_read"], undefined, undefined, outputDir).find((t) => t.name === "email_read")!;
}

describe("email_read body offload", () => {
  it("small bodies are unchanged", async () => {
    source.value = "Subject: Report\r\n\r\nHello Bob";
    const r = await readTool(join(root, "out")).execute("id", { uid: 7, mark_read: false } as any);
    const text = (r.content[0] as any).text as string;
    expect(text.endsWith("\n\nHello Bob")).toBe(true);
    expect(r.details?.outputPath).toBeUndefined();
  });

  it("bodies above 10,000 chars are saved in full under <outputDir>/tool-output", async () => {
    const body = Array.from({ length: 1000 }, (_, i) => `paragraph ${i} ${"lorem ".repeat(5)}`).join("\r\n");
    source.value = `Subject: Report\r\n\r\n${body}`;
    const outputDir = join(root, "out");
    const r = await readTool(outputDir).execute("id", { uid: 7, mark_read: false } as any);
    const text = (r.content[0] as any).text as string;
    expect(text).toContain("paragraph 0 ");
    expect(text).toContain("paragraph 999 ");
    expect(text).toMatch(/omitted/);
    const path = r.details?.outputPath as string;
    expect(path.startsWith(join(outputDir, "tool-output"))).toBe(true);
    expect(text).toContain(`Full output saved to ${path}.`);
    expect(readFileSync(path, "utf-8")).toBe(body);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
