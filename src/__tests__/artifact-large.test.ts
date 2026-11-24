/**
 * Large artifacts: blob storage, streaming reads with Range, versions (dedup, pruning), migration of
 * inline records, uploads (whole, in parts, from a file), partial changes (update, patch, ops) and
 * partial reads. Limits are set small here: no test allocates more than a few KB.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAPIHono } from "@hono/zod-openapi";
import { artifactLimits, buildArtifact, setArtifactLimits, DEFAULT_ARTIFACT_LIMITS, artifactVersionUsage } from "@polpo-ai/core/artifacts";
import { FileArtifactStore } from "../stores/file-artifact-store.js";
import { ArtifactBlobs } from "../artifacts/blobs.js";
import { LargeArtifactStore } from "../artifacts/store.js";
import { applyJsonPatch, applyTextUpdates, readDesign, readDoc, setLayer } from "../artifacts/ops.js";
import { detectArtifactType } from "../artifacts/detect.js";
import { artifactRoutes } from "../server/routes/artifacts.js";
import { executeArtifactTool, workspaceFileReader } from "../tools/artifact-tools.js";

const roots: string[] = [];
afterEach(async () => {
  setArtifactLimits(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Small limits: blobs from 64 bytes, contents up to 4 KB. */
function smallLimits(extra: Parameters<typeof setArtifactLimits>[0] = {}) {
  setArtifactLimits({ inlineBytes: 64, maxBytes: 4096, maxEditBytes: 2048, ...extra });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polpo-large-artifacts-"));
  roots.push(root);
  const polpoDir = join(root, ".polpo");
  const workDir = join(root, "work");
  await mkdir(workDir, { recursive: true });
  const records = new FileArtifactStore(polpoDir);
  const store = new LargeArtifactStore(records, new ArtifactBlobs(polpoDir, { gcGraceMs: 0 }));
  const app = new OpenAPIHono();
  app.route("/artifacts", artifactRoutes(() => ({ store, author: () => "person:ada@example.com", fileRoots: () => [workDir] })));
  const request = async (method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) => {
    const res = await app.request(`/artifacts${path}`, { method, ...init });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* a file */ }
    return { status: res.status, body, headers: res.headers };
  };
  const json = (method: string, path: string, value: unknown) => request(method, path, { body: JSON.stringify(value), headers: { "content-type": "application/json" } });
  return { root, polpoDir, workDir, records, store, request, json };
}

const blobFiles = async (polpoDir: string, id: string) => (await readdir(join(polpoDir, "artifact-blobs", id)).catch(() => [] as string[])).filter((n) => /^[a-f0-9]{64}$/.test(n));

describe("limits", () => {
  it("defaults to 100 MB per artifact, 30 versions / 500 MB, and takes settings.artifacts (invalid values keep the default)", () => {
    expect(artifactLimits()).toEqual(DEFAULT_ARTIFACT_LIMITS);
    expect(DEFAULT_ARTIFACT_LIMITS.maxBytes).toBe(100 * 1024 * 1024);
    const set = setArtifactLimits({ maxBytes: 2048, versions: { maxCount: 3 }, inlineBytes: -1 });
    expect(set).toMatchObject({ maxBytes: 2048, inlineBytes: DEFAULT_ARTIFACT_LIMITS.inlineBytes, versions: { maxCount: 3, maxTotalBytes: 500 * 1024 * 1024 } });
  });
});

describe("blob storage", () => {
  it("keeps a content over inlineBytes as a blob, reads it whole, as a file and by Range", async () => {
    smallLimits();
    const { store, request, json, polpoDir } = await fixture();
    const content = `# Report\n\n${"line of text ✓\n".repeat(20)}`;
    const created = await json("POST", "", { title: "Report", type: "doc", content });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const record = (await store.get(id))!;
    expect(record).toMatchObject({ content: "", blob: { size: Buffer.byteLength(content) }, size: Buffer.byteLength(content) });
    expect(record.excerpt).toBe(content);
    expect(await blobFiles(polpoDir, id)).toEqual([record.blob!.sha256]);
    // the API hydrates it (under the viewer limit), lists its size
    expect((await request("GET", `/${id}`)).body.data).toMatchObject({ content, size: Buffer.byteLength(content), usage: { count: 0, maxCount: 30 } });
    expect((await request("GET", `/${id}?content=none`)).body.data).toMatchObject({ content: "", contentOmitted: true });
    expect((await request("GET", "")).body.data[0]).toMatchObject({ id, size: Buffer.byteLength(content) });

    const file = await request("GET", `/${id}/content?download=1`);
    expect(file.status).toBe(200);
    expect(file.body).toBe(content);
    expect(file.headers.get("accept-ranges")).toBe("bytes");
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="report.md"');
    const part = await request("GET", `/${id}/content`, { headers: { range: "bytes=2-7" } });
    expect(part.status).toBe(206);
    expect(part.body).toBe("Report");
    expect(part.headers.get("content-range")).toBe(`bytes 2-7/${Buffer.byteLength(content)}`);
    expect((await request("GET", `/${id}/content`, { headers: { range: "bytes=-4" } })).body).toBe(Buffer.from(content).subarray(-4).toString());
    expect((await request("GET", `/${id}/content`, { headers: { range: "bytes=9999-" } })).status).toBe(416);
    // an inline content streams too
    const small = await json("POST", "", { title: "Small", type: "doc", content: "tiny" });
    expect((await request("GET", `/${small.body.data.id}/content`, { headers: { range: "bytes=1-2" } })).body).toBe("in");
  });

  it("shares a blob between identical versions, prunes by count and by bytes, and removes unreferenced blobs", async () => {
    smallLimits({ versions: { maxCount: 3 } });
    const { store, polpoDir } = await fixture();
    const text = (n: number) => `${String(n).padStart(3, "0")}${"x".repeat(97)}`; // 100 bytes each
    const a = await store.create({ title: "Doc", type: "doc", content: text(1), createdBy: "polpo" });
    await store.update(a.id, { content: text(2) });
    await store.restore(a.id, 1);
    // v3 has v1's content: one blob for both
    expect(await blobFiles(polpoDir, a.id)).toHaveLength(2);
    for (let i = 3; i <= 6; i += 1) await store.update(a.id, { content: text(i) });
    const after = (await store.get(a.id))!;
    expect(after.version).toBe(7);
    expect(after.versions.map((v) => v.version)).toEqual([6, 5, 4]);
    // current + 3 versions: the blobs of the pruned ones are gone
    expect(await blobFiles(polpoDir, a.id)).toHaveLength(4);
    expect(artifactVersionUsage(after)).toMatchObject({ count: 3, bytes: 300, currentBytes: 100, maxCount: 3 });

    setArtifactLimits({ inlineBytes: 64, maxBytes: 4096, versions: { maxCount: 30, maxTotalBytes: 250 } });
    await store.update(a.id, { content: text(7) });
    expect((await store.get(a.id))!.versions.map((v) => v.version)).toEqual([7, 6]);
    expect(await store.readContent((await store.get(a.id))!, 6)).toBe(text(5));
    // deleting removes its blobs
    await store.delete(a.id);
    expect(existsSync(join(polpoDir, "artifact-blobs", a.id))).toBe(false);
  });

  it("moves records written inline before blobs (current and versions) to blobs, once, without losing content", async () => {
    const { records, polpoDir } = await fixture();
    const v1 = "first ".repeat(30);
    const v2 = "second ".repeat(30);
    let legacy = buildArtifact("art_legacy0001", { title: "Old", type: "doc", content: v1, createdBy: "polpo" }, "2026-01-01T00:00:00.000Z");
    legacy = { ...legacy, content: v2, version: 2, versions: [{ version: 1, content: v1, author: "polpo", at: "2026-01-01T00:00:00.000Z" }], updatedAt: "2026-01-02T00:00:00.000Z" };
    delete legacy.size;
    await records.put(legacy);
    await records.put(buildArtifact("art_small00001", { title: "Small", type: "doc", content: "tiny", createdBy: "polpo" }));
    smallLimits();
    const store = new LargeArtifactStore(records, new ArtifactBlobs(polpoDir, { gcGraceMs: 0 }));
    expect(await store.migrate()).toBe(1);
    const moved = (await store.get("art_legacy0001"))!;
    expect(moved).toMatchObject({ content: "", blob: { size: v2.length }, versions: [{ version: 1, content: "", blob: { size: v1.length } }] });
    expect(await store.readContent(moved)).toBe(v2);
    expect(await store.readContent(moved, 1)).toBe(v1);
    expect((await store.get("art_small00001"))!.content).toBe("tiny");
    expect(await new LargeArtifactStore(records, new ArtifactBlobs(polpoDir)).migrate()).toBe(0);
  });

  it("refuses new content over the instance-wide limit", async () => {
    smallLimits({ maxTotalBytes: 300 });
    const { json } = await fixture();
    expect((await json("POST", "", { title: "A", type: "doc", content: "a".repeat(200) })).status).toBe(201);
    const over = await json("POST", "", { title: "B", type: "doc", content: "b".repeat(200) });
    expect(over.status).toBe(507);
    expect(over.body.error).toMatch(/maxTotalBytes/);
  });
});

describe("uploads", () => {
  it("creates from a raw body or a form, detects the type, replaces with expectedVersion, refuses office files and oversize bodies", async () => {
    smallLimits();
    const { request, polpoDir } = await fixture();
    const md = await request("POST", "/upload?filename=q3-report.md", { body: "# Q3\n\nAll good.", headers: { "content-type": "application/octet-stream" } });
    expect(md.status).toBe(201);
    expect(md.body.data).toMatchObject({ title: "q3-report", type: "doc", content: "# Q3\n\nAll good.", createdBy: "person:ada@example.com" });

    const deck = JSON.stringify({ version: 1, slides: [{ id: "s1", layout: "title", title: "Hello", body: "" }] });
    const form = new FormData();
    form.append("file", new File([deck], "deck.json", { type: "application/json" }));
    form.append("title", "Launch deck");
    const slides = await request("POST", "/upload", { body: form });
    expect(slides.status).toBe(201);
    expect(slides.body.data).toMatchObject({ title: "Launch deck", type: "html", kind: "slides" });

    const id = md.body.data.id as string;
    const stale = await request("PUT", `/${id}/content?expectedVersion=7`, { body: "# Q3 v2" });
    expect(stale.status).toBe(409);
    const replaced = await request("PUT", `/${id}/content`, { body: `# Q3 v2\n\n${"more ".repeat(40)}`, headers: { "x-expected-version": "1", "x-filename": "q3-v2.md" } });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toMatchObject({ version: 2, note: "Content replaced by upload (q3-v2.md)", blob: { size: 209 } });

    expect((await request("POST", "/upload?filename=memo.docx", { body: "PK..." })).status).toBe(415);
    const big = await request("POST", "/upload?filename=big.md", { body: "x".repeat(5000) });
    expect(big.status).toBe(413);
    expect((await readdir(join(polpoDir, "artifact-blobs", ".staging"))).filter((n) => !n.endsWith(".json")).length).toBe(0);
    expect((await request("POST", "/upload?filename=bad.svg", { body: "<div>not svg</div>" })).status).toBe(400);
    expect((await request("GET", "/usage")).body.data).toMatchObject({ maxBytes: DEFAULT_ARTIFACT_LIMITS.maxTotalBytes, limits: { maxBytes: 4096 } });
  });

  it("uploads in base64 parts or from a file of the instance, then finalizes into a new artifact or a replacement", async () => {
    smallLimits();
    const { json, workDir } = await fixture();
    const page = `<!doctype html><html><body>${"<p>row</p>".repeat(20)}</body></html>`;
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const first = await json("POST", "/uploads", { base64: b64(page.slice(0, 100)), filename: "page.html", more: true });
    expect(first.status).toBe(201);
    const uploadId = first.body.data.uploadId as string;
    expect(first.body.data).toMatchObject({ size: 100, complete: false });
    expect((await json("POST", `/uploads/${uploadId}/finalize`, {})).status).toBe(400);
    const last = await json("POST", "/uploads", { base64: b64(page.slice(100)), append_to: uploadId });
    expect(last.body.data).toMatchObject({ uploadId, size: page.length, complete: true });
    const created = await json("POST", `/uploads/${uploadId}/finalize`, { title: "Rows" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ title: "Rows", type: "html", kind: "page", content: page });
    expect((await json("POST", `/uploads/${uploadId}/finalize`, {})).status).toBe(404);
    expect((await json("POST", "/uploads", { base64: b64("x"), append_to: "upl_nonexistent1" })).status).toBe(400);

    await writeFile(join(workDir, "notes.md"), "# Notes from a file");
    const fromFile = await json("POST", "/uploads", { path: "notes.md" });
    expect(fromFile.body.data).toMatchObject({ complete: true, filename: "notes.md" });
    const replaced = await json("POST", `/uploads/${fromFile.body.data.uploadId}/finalize`, { id: created.body.data.id, expectedVersion: 1 });
    // replacing keeps the artifact's type: an html page now holding Markdown text is still a page
    expect(replaced.body.data).toMatchObject({ id: created.body.data.id, version: 2, content: "# Notes from a file" });
    expect((await json("POST", "/uploads", { path: "../outside.md" })).status).toBe(400);
    expect((await json("POST", "/uploads", { path: "missing.md" })).body.error).toMatch(/No file "missing.md"/);
  });
});

describe("partial changes", () => {
  it("update replaces old_str once (exactly, then ignoring smart quotes and trailing spaces), in sequence, all or nothing", async () => {
    smallLimits({ maxBytes: 8192, maxEditBytes: 8192 });
    const { json, store } = await fixture();
    const content = "# Plan\n\nWe ship on “Monday”.   \n\n- step one\n- step two\n- step one\n";
    const id = (await json("POST", "", { title: "Plan", type: "doc", content })).body.data.id as string;
    const exact = await json("PATCH", `/${id}`, { command: "update", old_str: "- step two", new_str: "- step 2" });
    expect(exact.body.data).toMatchObject({ version: 2, change: "1 update" });
    expect(exact.body.data.content).toBeUndefined();
    const fuzzy = await json("PATCH", `/${id}`, { old_str: 'We ship on "Monday".', new_str: "We ship on Tuesday." });
    expect(fuzzy.status).toBe(200);
    expect(await store.readContent((await store.get(id))!)).toContain("We ship on Tuesday.");
    const twice = await json("PATCH", `/${id}`, { old_str: "- step one", new_str: "- first" });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/found 2 times.*replace_all/);
    const missing = await json("PATCH", `/${id}`, { old_str: "- step three", new_str: "x" });
    expect(missing.body.error).toMatch(/old_str not found in the artifact\. Closest match/);
    const all = await json("PATCH", `/${id}`, { old_str: "- step one", new_str: "- first", replace_all: true });
    expect(all.body.data.version).toBe(4);
    // the second update fails: nothing is saved
    const failed = await json("PATCH", `/${id}`, { updates: [{ old_str: "- first", new_str: "- 1st", replace_all: true }, { old_str: "nope", new_str: "x" }] });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/updates\[1\]\.old_str not found.*Nothing was saved/s);
    expect((await store.get(id))!.version).toBe(4);
    const seq = await json("PATCH", `/${id}`, { updates: [{ old_str: "- first", new_str: "- 1st", replace_all: true }, { old_str: "- 1st\n- step 2", new_str: "- 1st\n- 2nd" }] });
    expect(seq.body.data).toMatchObject({ version: 5, change: "2 updates" });
    await json("PATCH", `/${id}`, { append: "\nThe end." });
    await json("PATCH", `/${id}`, { command: "prepend", text: "Draft\n" });
    const final = await store.readContent((await store.get(id))!);
    expect(final.startsWith("Draft\n# Plan")).toBe(true);
    expect(final.endsWith("The end.")).toBe(true);
    expect((await json("PATCH", `/${id}`, { content: "x", old_str: "a", new_str: "b" })).body.error).toMatch(/one kind of change/);
    expect((await json("PATCH", `/${id}`, { command: "rewrite", content: "# New" })).body.data).toMatchObject({ content: "# New", change: "rewritten" });
  });

  it("changes a blob content in place, and refuses in-place changes over maxEditBytes with a pointer to upload", async () => {
    smallLimits({ maxEditBytes: 300 });
    const { json, store } = await fixture();
    const id = (await json("POST", "", { title: "Big", type: "doc", content: `start ${"a".repeat(200)} end` })).body.data.id as string;
    expect((await json("PATCH", `/${id}`, { old_str: "end", new_str: "fin" })).body.data).toMatchObject({ version: 2, blob: {} });
    expect(await store.readContent((await store.get(id))!)).toMatch(/ fin$/);
    const huge = (await json("POST", "", { title: "Huge", type: "doc", content: "b".repeat(400) })).body.data.id as string;
    const refused = await json("PATCH", `/${huge}`, { old_str: "b", new_str: "c" });
    expect(refused.status).toBe(413);
    expect(refused.body.error).toMatch(/not changed in place.*PUT \/artifacts\/:id\/content/);
  });

  it("JSON Patch on a workspace model, checked before saving", async () => {
    const { json } = await fixture();
    const deck = { version: 1, slides: [{ id: "s1", layout: "title", title: "One", body: "" }, { id: "s2", layout: "content", title: "Two", body: "x" }] };
    const id = (await json("POST", "", { title: "Deck", type: "html", kind: "slides", content: JSON.stringify(deck) })).body.data.id as string;
    const patched = await json("PATCH", `/${id}`, { patch: [{ op: "replace", path: "/slides/1/title", value: "Second" }, { op: "add", path: "/slides/-", value: { id: "s3", layout: "content", title: "Three", body: "" } }] });
    expect(patched.status).toBe(200);
    const read = await json("GET", `/${id}`, undefined);
    expect(JSON.parse(read.body.data.content).slides.map((s: { title: string }) => s.title)).toEqual(["One", "Second", "Three"]);
    expect((await json("PATCH", `/${id}`, { patch: [{ op: "test", path: "/slides/0/title", value: "Nope" }] })).body.error).toMatch(/test failed/);
    expect((await json("PATCH", `/${id}`, { patch: [{ op: "replace", path: "/slides", value: [] }] })).body.error).toMatch(/at least one slide/);
    expect((await json("PATCH", `/${id}`, { patch: [{ op: "add", path: "/slides/-", value: { id: "s1", title: "dup" } }] })).body.error).toMatch(/Two slides have the id "s1"/);
    expect(applyJsonPatch({ a: [1, 2] }, [{ op: "move", from: "/a/0", path: "/b" }, { op: "copy", from: "/b", path: "/c" }, { op: "remove", path: "/a" }])).toEqual({ b: 1, c: 1 });
  });

  it("per-kind ops: doc tabs, sheets (formulas follow rows), slides, design boards and layers, motion", async () => {
    const { json, store } = await fixture();
    const content = async (id: string) => store.readContent((await store.get(id))!);
    const patchOps = (id: string, ops: unknown[]) => json("PATCH", `/${id}`, { ops });

    // doc: a plain document becomes tabbed
    const doc = (await json("POST", "", { title: "Doc", type: "doc", content: "# Intro" })).body.data.id as string;
    expect((await patchOps(doc, [{ op: "rename_tab", tab: 0, title: "Intro" }, { op: "insert_tab", title: "Details", content: "More here" }, { op: "edit_tab", tab: "Details", old_str: "here", new_str: "there" }])).status).toBe(200);
    expect(readDoc(await content(doc)).tabs.map((t) => [t.title, t.content])).toEqual([["Intro", "# Intro"], ["Details", "More there"]]);
    expect((await patchOps(doc, [{ op: "delete_tab", tab: "Missing" }])).body.error).toMatch(/No tab "Missing". There are: 0: main "Intro"/);

    // sheets
    const sheet = { version: 1, sheets: [{ name: "Data", cells: { A1: "1", A2: "2", A3: "3", A4: "=SUM(A1:A3)", B1: "=A2*2" }, charts: [{ range: "A1:A3", kind: "bar", title: "c" }] }] };
    const wb = (await json("POST", "", { title: "Book", type: "html", kind: "sheets", content: JSON.stringify(sheet) })).body.data.id as string;
    expect((await patchOps(wb, [{ op: "insert_rows", at: 2, count: 1 }, { op: "set_cells", cells: { A2: "1.5" } }, { op: "set_range", start: "C1", values: [["x", "y"], [1, true]] }])).status).toBe(200);
    let model = JSON.parse(await content(wb)).sheets[0];
    expect(model.cells).toMatchObject({ A1: "1", A2: "1.5", A3: "2", A4: "3", A5: "=SUM(A1:A4)", B1: "=A3*2", C1: "x", D1: "y", C2: "1", D2: "TRUE" });
    expect(model.charts[0].range).toBe("A1:A4");
    await patchOps(wb, [{ op: "delete_rows", at: 3 }]);
    model = JSON.parse(await content(wb)).sheets[0];
    expect(model.cells.B1).toBe("=#REF!*2");
    expect(model.cells.A4).toBe("=SUM(A1:A3)");
    await patchOps(wb, [{ op: "insert_columns", at: "A" }, { op: "add_sheet", name: "Summary", cells: { A1: "=Data!B1" } }, { op: "rename_sheet", sheet: "Data", name: "Raw" }]);
    const book = JSON.parse(await content(wb));
    expect(book.sheets[0].cells.B1).toBe("1");
    expect(book.sheets[1].cells.A1).toBe("=Raw!B1");
    expect((await patchOps(wb, [{ op: "add_sheet", name: "Raw" }])).body.error).toMatch(/A sheet is named "Raw"/);
    expect((await patchOps(wb, [{ op: "set_cells", cells: { ZZ9: "x" } }])).body.error).toMatch(/not a cell address/);

    // slides
    const deck = { version: 1, slides: [{ id: "s1", layout: "title", title: "One", body: "", elements: [{ id: "e1", type: "text", x: 0, y: 0, w: 10, h: 10, text: "hi" }] }] };
    const sl = (await json("POST", "", { title: "Deck", type: "html", kind: "slides", content: JSON.stringify(deck) })).body.data.id as string;
    expect((await patchOps(sl, [
      { op: "insert_slide", slide: { id: "s2", layout: "content", title: "Two", body: "b" } },
      { op: "update_element", slide: "s1", element: "e1", set: { text: "hello", color: "#ff0000" } },
      { op: "move_slide", slide: "Two", to: 0 },
    ])).status).toBe(200);
    const slides = JSON.parse(await content(sl)).slides;
    expect(slides.map((s: { id: string }) => s.id)).toEqual(["s2", "s1"]);
    expect(slides[1].elements[0]).toMatchObject({ text: "hello", color: "#ff0000" });
    expect((await patchOps(sl, [{ op: "update_slide", slide: "s1", set: { id: "x" } }])).body.error).toMatch(/id cannot be changed/);

    // design: a single page becomes a workspace with two boards; a layer changes in place
    const html = '<!doctype html><html><body><h1 id="headline" style="color: red">Old</h1></body></html>';
    const ds = (await json("POST", "", { title: "Design", type: "html", kind: "design", content: html })).body.data.id as string;
    expect((await patchOps(ds, [
      { op: "set_layer", board: 0, id: "headline", style: { color: "blue", fontSize: "48px" }, text: "New <title>" },
      { op: "insert_board", board: { name: "Mobile", width: 390, height: 844, html: "<p>m</p>" } },
      { op: "edit_board", board: "Mobile", old_str: "<p>m</p>", new_str: "<p>mobile</p>" },
    ])).status).toBe(200);
    const design = readDesign(await content(ds));
    expect(design.pages[0]!.boards.map((b) => b.name)).toEqual(["Artboard 1", "Mobile"]);
    expect(design.pages[0]!.boards[0]!.html).toContain('<h1 id="headline" style="color: blue; font-size: 48px">New &lt;title&gt;</h1>');
    expect(design.pages[0]!.boards[1]!.html).toBe("<p>mobile</p>");
    expect(() => setLayer("<p id=a>x</p><p id=a>y</p>", "a", { text: "z" })).toThrow(/Several elements/);

    // motion
    const motion = { version: 1, width: 1280, height: 720, scenes: [{ id: "intro", name: "Intro", duration: 3, background: "#000000", layers: [{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 50, color: "#ffffff", text: "Hi" }] }] };
    const mo = (await json("POST", "", { title: "Clip", type: "html", kind: "motion", content: JSON.stringify(motion) })).body.data.id as string;
    expect((await patchOps(mo, [{ op: "update_layer", scene: "intro", layer: "t", set: { text: "Hello" } }, { op: "insert_scene", scene: { name: "Outro", duration: 2, background: "#111111" } }, { op: "set_project", set: { width: 1920 } }])).status).toBe(200);
    const clip = JSON.parse(await content(mo));
    expect(clip).toMatchObject({ width: 1920, scenes: [{ layers: [{ text: "Hello" }] }, { name: "Outro", layers: [] }] });
    expect((await patchOps(mo, [{ op: "delete_scene", scene: 0 }, { op: "delete_scene", scene: 0 }])).body.error).toMatch(/keeps at least one scene.*Nothing was saved/);
    // ops on a kind without a model
    const svg = (await json("POST", "", { title: "Icon", type: "svg", content: "<svg></svg>" })).body.data.id as string;
    expect((await patchOps(svg, [{ op: "set_tab" }])).body.error).toMatch(/change this svg with update/);
  });
});

describe("partial reads", () => {
  it("by byte range (UTF-8 safe), outline and part", async () => {
    smallLimits({ maxBytes: 8192, maxEditBytes: 8192 });
    const { json, request } = await fixture();
    const text = "àèìòù".repeat(40);
    const id = (await json("POST", "", { title: "Accents", type: "doc", content: text })).body.data.id as string;
    const read = (await request("GET", `/${id}/read?offset=1&limit=9`)).body.data;
    // byte 1 is inside "à": the cut sequence is dropped at both ends
    expect(read).toMatchObject({ text: "èìòù", start: 2, end: 10, size: 400, more: true });

    const deck = { version: 1, slides: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, layout: "content", title: `Slide ${i}`, body: "" })) };
    const sl = (await json("POST", "", { title: "Deck", type: "html", kind: "slides", content: JSON.stringify(deck) })).body.data.id as string;
    expect((await request("GET", `/${sl}/read?outline=1`)).body.data.text).toMatch(/^Slides:\n {2}0\. s0 "Slide 0" content/);
    expect(JSON.parse((await request("GET", `/${sl}/read?slides=2-3`)).body.data.text).map((s: { id: string }) => s.id)).toEqual(["s2", "s3"]);
    expect(JSON.parse((await request("GET", `/${sl}/read?slide=Slide%205`)).body.data.text).id).toBe("s5");

    const wb = { version: 1, sheets: [{ name: "Data", cells: { A1: "a", B2: "b", D9: "far" } }] };
    const sh = (await json("POST", "", { title: "Book", type: "html", kind: "sheets", content: JSON.stringify(wb) })).body.data.id as string;
    expect(JSON.parse((await request("GET", `/${sh}/read?sheet=Data&range=A1:B2`)).body.data.text).cells).toEqual({ A1: "a", B2: "b" });
    expect((await request("GET", `/${sh}/read?sheet=Nope`)).body.error).toMatch(/No sheet "Nope"/);
  });
});

describe("artifact_from_file and the agents' reads", () => {
  it("publishes a file of the workspace as a new artifact or a replacement, inside the allowed folders only", async () => {
    smallLimits();
    const { store, workDir, root } = await fixture();
    await writeFile(join(workDir, "dashboard.html"), `<!doctype html><html><body>${"<div>kpi</div>".repeat(30)}</body></html>`);
    const ctx = { store, author: "analyst", readFile: workspaceFileReader({ cwd: workDir, tempDir: join(root, "tmp") }) };
    const created = await executeArtifactTool("artifact_from_file", { path: "dashboard.html", description: "KPIs" }, ctx);
    expect(created).toMatch(/Created artifact art_[\w-]+ from dashboard\.html \(html\/page, 4\d\d B\): "dashboard"/);
    const id = /art_[\w-]+/.exec(created)![0];
    expect((await store.get(id))!.blob).toBeDefined();
    expect(existsSync(join(workDir, "dashboard.html"))).toBe(true);

    await writeFile(join(workDir, "v2.html"), "<!doctype html><p>v2</p>");
    expect(await executeArtifactTool("artifact_from_file", { path: "v2.html", id, expectedVersion: 1 }, ctx)).toMatch(/Updated artifact .* from v2\.html \(now v2/);
    await expect(executeArtifactTool("artifact_from_file", { path: "/etc/hostname" }, ctx)).rejects.toThrow(/outside your allowed folders/);
    await expect(executeArtifactTool("artifact_from_file", { path: "v2.html", id, expectedVersion: 1 }, ctx)).rejects.toThrow(/changed since v1/);
    await expect(executeArtifactTool("artifact_from_file", { path: "v2.html", id }, { ...ctx, author: "intern" })).rejects.toThrow(/belongs to analyst/);

    // a sandbox's file is copied out to a temporary file, removed after use
    const remote = { readFileBuffer: async () => new TextEncoder().encode("# From the sandbox") };
    const sandboxed = { ...ctx, readFile: workspaceFileReader({ cwd: "/workspace", tempDir: join(root, "tmp"), remote }) };
    expect(await executeArtifactTool("artifact_from_file", { path: "notes.md" }, sandboxed)).toMatch(/\(doc, 18 B\): "notes"/);
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("artifact_get reads a large artifact by range, outline and part; artifact_update uses update by default", async () => {
    smallLimits({ maxBytes: 200_000, maxEditBytes: 200_000 });
    const { store } = await fixture();
    const polpo = { store, author: "polpo" };
    const tabs = `<!-- polpo-doc-tabs:v1 abcdefghijklmnopqr -->\n<!-- polpo-doc-tab:abcdefghijklmnopqr one One -->\n\n${"a".repeat(70_000)}\n\n<!-- polpo-doc-tab:abcdefghijklmnopqr two Two -->\n\nSecond tab\n\n`;
    const created = await executeArtifactTool("artifact_create", { title: "Long", type: "doc", content: tabs }, polpo);
    const id = /art_[\w-]+/.exec(created)![0];
    const first = await executeArtifactTool("artifact_get", { id }, polpo);
    expect(first).toMatch(/--- outline ---\nTabs:\n {2}0\. one "One" \(70000 characters\)\n {2}1\. two "Two"/);
    expect(first).toMatch(/bytes 0–60000 of \d+; more: offset 60000/);
    expect(first).toMatch(/0 earlier versions, 0 B of 500 MB/);
    expect(await executeArtifactTool("artifact_get", { id, tab: "two" }, polpo)).toMatch(/Tab two "Two":\nSecond tab$/);
    expect(await executeArtifactTool("artifact_get", { id, offset: 70_100, limit: 30 }, polpo)).toMatch(/bytes 70100–70130/);
    expect(await executeArtifactTool("artifact_update", { id, old_str: "Second tab", new_str: "2nd tab" }, polpo)).toMatch(/now v2, 1 update/);
    expect(await executeArtifactTool("artifact_update", { id, ops: [{ op: "set_tab", tab: 1, content: "Rewritten tab" }] }, polpo)).toMatch(/now v3, set_tab/);
    await expect(executeArtifactTool("artifact_update", { id, content: "short" }, polpo)).rejects.toThrow(/command update/);
  });
});

describe("helpers", () => {
  it("detects types from names, media types and content", () => {
    expect(detectArtifactType({ filename: "a.md", head: "" })).toEqual({ type: "doc" });
    expect(detectArtifactType({ filename: "d.html", head: "<html><script type=\"application/json\" data-polpo-design-workspace>" })).toEqual({ type: "html", kind: "design" });
    expect(detectArtifactType({ head: '<?xml version="1.0"?><svg viewBox="0 0 1 1">' })).toEqual({ type: "svg" });
    expect(detectArtifactType({ head: "flowchart LR\n A-->B" })).toEqual({ type: "mermaid" });
    expect(detectArtifactType({ filename: "m.json", head: '{"version":1,"scenes":[' })).toEqual({ type: "html", kind: "motion" });
    expect(() => detectArtifactType({ filename: "x.json", head: '{"a":1}' })).toThrow(/not an artifact workspace/);
    expect(() => detectArtifactType({ filename: "x.pptx", head: "" })).toThrow(/dashboard/);
  });

  it("keeps CRLF line endings when updating", () => {
    expect(applyTextUpdates("a\r\nb\r\nc", [{ old_str: "b\nc", new_str: "B\nC" }])).toBe("a\r\nB\r\nC");
  });
});
