import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { interpretChannelCompletion, resolveSharedFile } from "../server/channel-chat-result.js";
import { TelegramCallbackPoller } from "../notifications/channels/telegram.js";

let base: string;
let workspace: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "polpo-channel-files-"));
  workspace = join(base, "workspace");
  mkdirSync(join(workspace, "team", "health", "weeks"), { recursive: true });
  mkdirSync(join(workspace, ".polpo"), { recursive: true });
  writeFileSync(join(workspace, "team", "health", "weeks", "meal-plan.pdf"), "%PDF");
  writeFileSync(join(workspace, ".polpo", "polpo.json"), "{\"botToken\":\"x\"}");
  writeFileSync(join(workspace, "team", "prod.env"), "SECRET=1");
  writeFileSync(join(workspace, "team", "server.pem"), "key");
  writeFileSync(join(base, "outside.txt"), "nope");
  symlinkSync(join(base, "outside.txt"), join(workspace, "team", "link.txt"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("resolveSharedFile", () => {
  it("resolves files inside the workspace, relative or absolute", () => {
    const rel = resolveSharedFile("team/health/weeks/meal-plan.pdf", [workspace]);
    expect(rel).toMatch(/meal-plan\.pdf$/);
    expect(resolveSharedFile(rel!, [workspace])).toBe(rel);
  });

  it("refuses paths outside the workspace, including via .. and symlinks", () => {
    expect(resolveSharedFile(join(base, "outside.txt"), [workspace])).toBeUndefined();
    expect(resolveSharedFile("../outside.txt", [workspace])).toBeUndefined();
    expect(resolveSharedFile("team/link.txt", [workspace])).toBeUndefined();
  });

  it("refuses hidden directories and credential-like names", () => {
    expect(resolveSharedFile(".polpo/polpo.json", [workspace])).toBeUndefined();
    expect(resolveSharedFile("team/prod.env", [workspace])).toBeUndefined();
    expect(resolveSharedFile("team/server.pem", [workspace])).toBeUndefined();
  });

  it("refuses directories and missing files", () => {
    expect(resolveSharedFile("team", [workspace])).toBeUndefined();
    expect(resolveSharedFile("team/none.pdf", [workspace])).toBeUndefined();
  });
});

describe("interpretChannelCompletion", () => {
  it("turns open_file into a document, keeping the text", () => {
    const out = interpretChannelCompletion({ finish_reason: "open_file", message: { content: "Ecco il piano" }, open_file: { path: "team/health/weeks/meal-plan.pdf" } }, [workspace]);
    expect(out.text).toBe("Ecco il piano");
    expect(out.files).toEqual([expect.objectContaining({ filename: "meal-plan.pdf" })]);
  });

  it("open_file with no text still produces the file (no empty reply)", () => {
    const out = interpretChannelCompletion({ finish_reason: "open_file", message: { content: "" }, open_file: { path: "team/health/weeks/meal-plan.pdf" } }, [workspace]);
    expect(out.text).toBe("");
    expect(out.files).toHaveLength(1);
  });

  it("explains a file it cannot attach", () => {
    const out = interpretChannelCompletion({ finish_reason: "open_file", message: { content: "" }, open_file: { path: ".polpo/polpo.json" } }, [workspace]);
    expect(out.files).toEqual([]);
    expect(out.text).toContain("Could not attach polpo.json");
  });

  it("renders open_tab as a link, web-only actions as a notice and ask_user as text", () => {
    expect(interpretChannelCompletion({ finish_reason: "open_tab", message: { content: "Guarda" }, open_tab: { url: "https://ex.com", label: "Ricetta" } }, []).text)
      .toBe("Guarda\n\n🔗 [Ricetta](https://ex.com)");
    expect(interpretChannelCompletion({ finish_reason: "widget_render", message: { content: "" } }, []).text).toContain("open the web chat");
    expect(interpretChannelCompletion({ finish_reason: "ask_user", message: { content: "Una domanda" }, ask_user: { questions: [{ question: "Mattina o sera?", options: [{ label: "Mattina" }, { label: "Sera" }] }] } }, []).text)
      .toBe("Una domanda\n\n• Mattina o sera?\n  1. Mattina\n  2. Sera\n\nReply with your answer.");
  });

  it("leaves plain replies untouched", () => {
    expect(interpretChannelCompletion({ finish_reason: "stop", message: { content: " ciao " } }, [])).toEqual({ text: "ciao", files: [] });
  });
});

describe("TelegramCallbackPoller.sendDocument", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uploads the file as a multipart document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const ok = await new TelegramCallbackPoller("123:abc", "1").sendDocument("chat", join(workspace, "team", "health", "weeks", "meal-plan.pdf"), "meal-plan.pdf");

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendDocument");
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("chat");
    expect((form.get("document") as File).name).toBe("meal-plan.pdf");
  });

  it("tells the chat when the upload fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "file is too big" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await new TelegramCallbackPoller("123:abc", "1").sendDocument("chat", join(workspace, "team", "health", "weeks", "meal-plan.pdf"), "meal-plan.pdf")).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).text).toContain("Could not send meal-plan.pdf");
  });
});
