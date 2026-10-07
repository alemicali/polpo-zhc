/**
 * Tools that work on the agent's files do all their file I/O through the FileSystem they are
 * given (open Polpo's model): with a remote sandbox the bytes live in the VM and never touch this
 * machine's disk. The fake FileSystem below keeps files in memory under /vm, a path that does not
 * exist here, so any direct node:fs access would fail the test.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { FileEntry, FileStat, FileSystem } from "@polpo-ai/core/filesystem";
import { TOOL_PLACEMENT, toolPlacement } from "@polpo-ai/core/sandbox";
import { createAllTools } from "../tools/system-tools.js";
import { createPdfTools } from "../tools/pdf-tools.js";
import { AGENT_BROWSER_CHECK_COMMAND } from "../tools/browser-tools.js";
import { createExcelTools } from "../tools/excel-tools.js";
import { createDocxTools } from "../tools/docx-tools.js";
import { createImageTools } from "../tools/image-tools.js";
import { createAudioTools } from "../tools/audio-tools.js";
import { createHttpTools } from "../tools/http-tools.js";
import { createOutcomeTools } from "../tools/outcome-tools.js";
import { createAttachmentTools } from "../tools/attachment-tools.js";
import { createWhatsAppTools } from "../tools/whatsapp-tools.js";

/** In-memory FileSystem: what a remote VM looks like to the tools. */
class MemoryFs implements FileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/tmp"]);
  async readFile(path: string) { return new TextDecoder().decode(await this.readFileBuffer(path)); }
  async writeFile(path: string, content: string) { await this.writeFileBuffer(path, new TextEncoder().encode(content)); }
  async readFileBuffer(path: string) {
    const data = this.files.get(path);
    if (!data) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return data;
  }
  async writeFileBuffer(path: string, data: Uint8Array) {
    if (!this.dirs.has(dirname(path))) throw new Error(`ENOENT: parent of ${path}`);
    this.files.set(path, new Uint8Array(data));
  }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async readdir(path: string) { return (await this.readdirWithTypes(path)).map((e) => e.name); }
  async readdirWithTypes(path: string): Promise<FileEntry[]> {
    return [...this.files.keys()].filter((f) => dirname(f) === path).map((f) => ({ name: f.slice(path.length + 1), isDirectory: false, isFile: true }));
  }
  async mkdir(path: string) { for (let p = path; p !== "/"; p = dirname(p)) this.dirs.add(p); }
  async remove(path: string) { this.files.delete(path); }
  async stat(path: string): Promise<FileStat> {
    const data = this.files.get(path);
    if (data) return { size: data.byteLength, isFile: true, isDirectory: false };
    if (this.dirs.has(path)) return { size: 0, isFile: false, isDirectory: true };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }
  async rename(a: string, b: string) { this.files.set(b, this.files.get(a)!); this.files.delete(a); }
}

const CWD = "/vm/work";
const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
const tool = (tools: any[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const vault = { getKey: () => "test-key" } as any;

afterEach(() => {
  vi.restoreAllMocks();
  expect(existsSync("/vm")).toBe(false);
});

async function onePagePdf(title: string): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.addPage([200, 100]);
  return doc.save();
}

describe("file tools through the given FileSystem", () => {
  test("excel: write and read xlsx and csv in the sandbox's files", async () => {
    const fs = new MemoryFs();
    const tools = createExcelTools(CWD, undefined, undefined, fs);
    expect(text(await tool(tools, "excel_write").execute("1", { path: "out/data.xlsx", headers: ["name", "n"], rows: [["a", 1], ["b", 2]] }))).toContain("Excel written");
    expect(fs.files.get("/vm/work/out/data.xlsx")?.byteLength).toBeGreaterThan(1000);
    const read = text(await tool(tools, "excel_read").execute("2", { path: "out/data.xlsx" }));
    expect(read).toContain("Rows: 3");
    expect(read).toContain("b\t2");
    expect(text(await tool(tools, "excel_query").execute("3", { path: "out/data.xlsx", filter_column: "name", filter_value: "b" }))).toContain("1 rows matched");
    expect(text(await tool(tools, "excel_info").execute("4", { path: "out/data.xlsx" }))).toContain("Sheet1: 3 rows");

    await tool(tools, "excel_write").execute("5", { path: "t.csv", headers: ["x"], rows: [["1,5"]] });
    expect(await fs.readFile("/vm/work/t.csv")).toBe('x\n"1,5"');
    expect(text(await tool(tools, "excel_read").execute("6", { path: "t.csv" }))).toContain("1,5");
  });

  test("pdf: info, read and merge on bytes from the FileSystem", async () => {
    const fs = new MemoryFs();
    await fs.mkdir(CWD);
    await fs.writeFileBuffer("/vm/work/a.pdf", await onePagePdf("Alpha"));
    await fs.writeFileBuffer("/vm/work/b.pdf", await onePagePdf("Beta"));
    const tools = createPdfTools(CWD, undefined, undefined, fs);
    expect(text(await tool(tools, "pdf_info").execute("1", { path: "a.pdf" }))).toContain("Title: Alpha");
    expect(text(await tool(tools, "pdf_read").execute("2", { path: "b.pdf" }))).toContain("Pages: 1 | Title: Beta");
    expect(text(await tool(tools, "pdf_merge").execute("3", { inputs: ["a.pdf", "b.pdf"], output: "merged/ab.pdf" }))).toContain("2 pages");
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(fs.files.get("/vm/work/merged/ab.pdf")!)).getPageCount()).toBe(2);
  });

  test("pdf_create with a remote VM's shell renders in the VM (driver + params written through fs)", async () => {
    const fs = new MemoryFs();
    const commands: string[] = [];
    const pdf = await onePagePdf("VM");
    const shell = {
      isRemote: async () => true,
      execute: async (command: string) => {
        commands.push(command);
        if (command === AGENT_BROWSER_CHECK_COMMAND) return { stdout: "/usr/bin/agent-browser", stderr: "", exitCode: 0 };
        // the driver: node <driver> <params> <out>
        const [, , params, out] = command.split(" ").map((x) => x.replace(/^'|'$/g, ""));
        const p = JSON.parse(await fs.readFile(params!));
        expect(p).toMatchObject({ html: "<h1>x</h1>", waitUntil: "domcontentloaded", pdf: { format: "A4", landscape: true } });
        await fs.writeFileBuffer(out!, pdf);
        return { stdout: JSON.stringify({ success: true, bytes: pdf.byteLength }), stderr: "", exitCode: 0 };
      },
    };
    const [create] = createPdfTools(CWD, undefined, ["pdf_create"], fs, shell);
    const r = await create!.execute("1", { path: "out/r.pdf", html: "<h1>x</h1>", landscape: true, wait_for_network: false });
    expect(text(r)).toContain("PDF created: /vm/work/out/r.pdf (1 pages");
    expect(commands[1]).toMatch(/^node '\/tmp\/polpo-pdf-render-[0-9a-f]+\.mjs' '\/tmp\/polpo-pdf-[\w-]+\.json' '\/vm\/work\/out\/r\.pdf'$/);
    // the driver stays for the next call, the params file is gone
    expect([...fs.files.keys()].filter((f) => f.startsWith("/tmp/")).map((f) => f.replace(/[0-9a-f]{12}/, "H"))).toEqual(["/tmp/polpo-pdf-render-H.mjs"]);
  });

  test("docx: create then read in the sandbox's files", async () => {
    const fs = new MemoryFs();
    const tools = createDocxTools(CWD, undefined, undefined, fs);
    await tool(tools, "docx_create").execute("1", { path: "doc.docx", title: "Report", content: [{ type: "paragraph", text: "Hello from the VM" }] });
    expect(fs.files.has("/vm/work/doc.docx")).toBe(true);
    expect(text(await tool(tools, "docx_read").execute("2", { path: "doc.docx" }))).toContain("Hello from the VM");
  });

  test("http_download saves into the FileSystem", async () => {
    const fs = new MemoryFs();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    const tools = createHttpTools(CWD, undefined, ["http_download"], "/vm/out", fs);
    expect(text(await tool(tools, "http_download").execute("1", { url: "https://example.com/f.bin", path: "dl/f.bin" }))).toContain("Downloaded 4 bytes");
    expect([...fs.files.get("/vm/work/dl/f.bin")!]).toEqual([1, 2, 3, 4]);
  });

  test("image_analyze reads the image from the FileSystem", async () => {
    const fs = new MemoryFs();
    await fs.mkdir(CWD);
    await fs.writeFileBuffer("/vm/work/pic.png", new Uint8Array([137, 80, 78, 71]));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "a tiny png" } }] })));
    const tools = createImageTools(CWD, undefined, ["image_analyze"], vault, fs);
    expect(text(await tool(tools, "image_analyze").execute("1", { path: "pic.png" }))).toContain("a tiny png");
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(JSON.stringify(body)).toContain(Buffer.from([137, 80, 78, 71]).toString("base64"));
  });

  test("audio: transcribe reads from the FileSystem, speak writes there", async () => {
    const fs = new MemoryFs();
    await fs.mkdir(CWD);
    await fs.writeFileBuffer("/vm/work/voice.mp3", new Uint8Array([9, 9, 9]));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).includes("transcriptions")
      ? new Response(JSON.stringify({ text: "hello there", language: "en", duration: 1 }))
      : new Response(new Uint8Array([7, 7])));
    const tools = createAudioTools(CWD, undefined, undefined, vault, fs);
    expect(text(await tool(tools, "audio_transcribe").execute("1", { path: "voice.mp3" }))).toContain("hello there");
    await tool(tools, "audio_speak").execute("2", { path: "out/say.mp3", text: "hi" });
    expect([...fs.files.get("/vm/work/out/say.mp3")!]).toEqual([7, 7]);
  });

  test("register_outcome checks the file where the agent's files are", async () => {
    const fs = new MemoryFs();
    const [outcome] = createOutcomeTools(CWD, undefined, undefined, undefined, fs);
    expect((await outcome!.execute("1", { type: "file", label: "Report", path: "r.pdf" })).details).toMatchObject({ error: "file_not_found" });
    await fs.mkdir(CWD);
    await fs.writeFileBuffer("/vm/work/r.pdf", new Uint8Array(2048));
    const ok = await outcome!.execute("2", { type: "file", label: "Report", path: "r.pdf" });
    expect(ok.details).toMatchObject({ path: "/vm/work/r.pdf", outcomeSize: 2048, outcomeMimeType: "application/pdf" });
  });

  test("read_attachment reads from the FileSystem", async () => {
    const fs = new MemoryFs();
    await fs.mkdir(CWD);
    await fs.writeFile("/vm/work/a.csv", "x,y\n1,2");
    const [readAttachment] = createAttachmentTools(CWD, undefined, undefined, fs);
    expect(text(await readAttachment!.execute("1", { path: "a.csv" }))).toBe("x,y\n1,2");
  });

  test("whatsapp_send_file sends the bytes read from the FileSystem", async () => {
    const fs = new MemoryFs();
    await fs.mkdir(CWD);
    await fs.writeFileBuffer("/vm/work/r.pdf", new Uint8Array([1, 2]));
    const sendMedia = vi.fn(async () => "msg-1");
    const store = { resolveContact: async () => undefined } as any;
    const tools = createWhatsAppTools({ store, sendMessage: async () => "x", sendMedia }, ["whatsapp_send_file"], CWD, undefined, fs);
    await tool(tools, "whatsapp_send_file").execute("1", { to: "+391234567890", path: "r.pdf" });
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const opts = (sendMedia.mock.calls[0] as any[])[1];
    expect(opts.path).toBe("/vm/work/r.pdf");
    expect([...opts.data]).toEqual([1, 2]);
  });

  test("path guards still apply to the path string", async () => {
    const fs = new MemoryFs();
    const tools = createExcelTools(CWD, undefined, undefined, fs);
    await expect(tool(tools, "excel_write").execute("1", { path: "/etc/x.csv", headers: ["a"], rows: [] })).rejects.toThrow();
  });

  test("createAllTools threads the FileSystem to every file tool", async () => {
    const fs = new MemoryFs();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([5])));
    const tools = await createAllTools({ cwd: CWD, allowedTools: ["excel_*", "pdf_*", "docx_*", "http_download", "write", "register_outcome"], fs });
    await tool(tools, "excel_write").execute("1", { path: "a.csv", headers: ["h"], rows: [] });
    await tool(tools, "http_download").execute("2", { url: "https://example.com/x", path: "x.bin" });
    await tool(tools, "write").execute("3", { path: "w.txt", content: "w" });
    expect([...fs.files.keys()].sort()).toEqual(["/vm/work/a.csv", "/vm/work/w.txt", "/vm/work/x.bin"]);
    expect(text(await tool(tools, "register_outcome").execute("4", { type: "file", label: "x", path: "x.bin" }))).toContain("Outcome registered");
  });
});

describe("tool placement (open Polpo's requiresSandbox)", () => {
  test("files, commands and media act in the sandbox; keys stay here", () => {
    for (const name of ["read", "write", "edit", "bash", "glob", "grep", "ls", "http_download", "email_download_attachment", "run_command",
      "browser_navigate", "browser_screenshot", "image_generate", "image_analyze", "video_generate", "audio_speak", "audio_transcribe",
      "excel_read", "pdf_create", "docx_create"]) {
      expect(toolPlacement(name), name).toBe("sandbox");
    }
    for (const name of ["email_send", "email_read", "vault_get", "storage_read", "storage_write", "whatsapp_send_file", "register_outcome",
      "read_attachment", "http_fetch", "search_web", "memory_save"]) {
      expect(toolPlacement(name), name).toBe("host");
    }
    expect(new Set(TOOL_PLACEMENT.map((p) => p.placement))).toEqual(new Set(["sandbox"]));
  });
});
