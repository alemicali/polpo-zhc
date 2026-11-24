/**
 * The MCP connector end to end on large artifacts: a client (Claude, ChatGPT…) uploads a content in
 * base64 parts, creates the artifact, changes a few bytes of it (update), changes one part of a
 * workspace (ops), and reads parts — through the real REST routes, never sending a content whole.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setArtifactLimits } from "@polpo-ai/core/artifacts";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { artifactRoutes } from "../server/routes/artifacts.js";
import { FileArtifactStore } from "../stores/file-artifact-store.js";
import { ArtifactBlobs } from "../artifacts/blobs.js";
import { LargeArtifactStore } from "../artifacts/store.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

const roots: string[] = [];
afterEach(async () => {
  setArtifactLimits(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** MCP deps whose API is the artifact routes, called in process as the server does. */
async function instance(): Promise<{ deps: McpDeps; store: LargeArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), "polpo-mcp-artifacts-"));
  roots.push(root);
  const polpoDir = join(root, ".polpo");
  const store = new LargeArtifactStore(new FileArtifactStore(polpoDir), new ArtifactBlobs(polpoDir, { gcGraceMs: 0 }));
  const app = new OpenAPIHono();
  app.route("/api/v1/artifacts", artifactRoutes(() => ({ store, author: () => "person:mcp" })));
  const api = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
    const binary = body instanceof Uint8Array;
    const res = await app.request(path, {
      method,
      ...(body !== undefined ? { body: binary ? body as BodyInit : JSON.stringify(body), headers: binary ? {} : { "content-type": "application/json" } } : {}),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers, bytes };
  };
  return { deps: { api, version: "test" }, store };
}

async function rpc(deps: McpDeps, method: string, params: Record<string, unknown> = {}) {
  const res = await handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), deps);
  return (await res.json() as { result?: any }).result;
}

const call = async (deps: McpDeps, name: string, args: Record<string, unknown>) => {
  const result = await rpc(deps, "tools/call", { name, arguments: args });
  await expectValidOutput(deps, async () => (await rpc(deps, "tools/list")).tools, name, result);
  return result as { content: Array<{ text: string }>; structuredContent?: any; isError?: boolean };
};

describe("MCP: large artifacts without sending them whole", () => {
  it("uploads in base64 parts, finalizes, updates a few bytes, changes a workspace part with ops, and reads parts", async () => {
    // small limits: blobs from 1 KB, contents up to 64 KB
    setArtifactLimits({ inlineBytes: 1024, maxBytes: 64 * 1024 });
    const { deps, store } = await instance();
    const tools = (await rpc(deps, "tools/list")).tools as Array<{ name: string; description: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["polpo_artifact_upload_prepare", "polpo_artifact_upload_finalize", "polpo_artifact_update", "polpo_artifact_get"]));
    const update = tools.find((t) => t.name === "polpo_artifact_update")!;
    expect(update.description).toMatch(/Prefer command "update"/);
    expect(update.description).toMatch(/"rewrite".*only when most of it changes/);
    expect(tools.find((t) => t.name === "polpo_artifact_create")!.description).toMatch(/Only for contents of a few KB.*polpo_artifact_upload_prepare/);

    // a 12 KB report in three base64 parts
    const report = `# Quarterly report\n\n${Array.from({ length: 300 }, (_, i) => `- line ${i}: revenue up across every region and product line`).join("\n")}\n`;
    const parts = [report.slice(0, 4000), report.slice(4000, 8000), report.slice(8000)];
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const first = await call(deps, "polpo_artifact_upload_prepare", { source: { base64: b64(parts[0]!), filename: "report.md", more: true } });
    expect(first.structuredContent).toMatchObject({ complete: false, size: 4000 });
    expect(first.content[0]!.text).toMatch(/Send the next part with append_to/);
    const uploadId = first.structuredContent.upload_id as string;
    await call(deps, "polpo_artifact_upload_prepare", { source: { base64: b64(parts[1]!), append_to: uploadId, more: true } });
    const last = await call(deps, "polpo_artifact_upload_prepare", { source: { base64: b64(parts[2]!), append_to: uploadId } });
    expect(last.structuredContent).toMatchObject({ upload_id: uploadId, complete: true, size: Buffer.byteLength(report) });
    const created = await call(deps, "polpo_artifact_upload_finalize", { upload_id: uploadId, title: "Q3 report" });
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent.artifact.id as string;
    expect(created.content[0]!.text).toMatch(/^Created artifact art_[\w-]+: Q3 report \(v1, \d+ KB\)\. Versions: 0 earlier versions/);
    expect(created.structuredContent.artifact.content).toBeUndefined();
    expect(await store.readContent((await store.get(id))!)).toBe(report);

    // a targeted update: a few bytes sent, a new version
    const changed = await call(deps, "polpo_artifact_update", { id, expectedVersion: 1, command: "update", old_str: "- line 150: revenue up across", new_str: "- line 150: revenue up 12% across" });
    expect(changed.content[0]!.text).toMatch(/now v2, 1 update/);
    expect(await store.readContent((await store.get(id))!)).toContain("- line 150: revenue up 12% across every region and product line\n- line 151");
    const stale = await call(deps, "polpo_artifact_update", { id, expectedVersion: 1, old_str: "line 1:", new_str: "x" });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toMatch(/HTTP 409.*read it again with polpo_artifact_get/s);
    const miss = await call(deps, "polpo_artifact_update", { id, old_str: "- line 999", new_str: "x" });
    expect(miss.content[0]!.text).toMatch(/Closest match/);
    // a whole content too large for one call points to the upload tools
    const tooBig = await call(deps, "polpo_artifact_update", { id, command: "rewrite", content: "x".repeat(70 * 1024) });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.content[0]!.text).toMatch(/HTTP 413.*polpo_artifact_upload_prepare/s);

    // a partial read: bytes, then the rest from where it stopped
    const head = await call(deps, "polpo_artifact_get", { id, offset: 0, limit: 64 });
    expect(head.structuredContent.read).toMatchObject({ start: 0, end: 64, more: true, size: Buffer.byteLength(report) + 4 });
    expect(head.content[0]!.text).toMatch(/--- content \(bytes 0–64 of \d+; more: offset 64\) ---\n# Quarterly report/);
    expect(head.content[0]!.text).toMatch(/Versions: v2 \(current\), v1 — 1 earlier version/);

    // a workspace: one op changes one range of one sheet
    const book = { version: 1, sheets: [{ name: "Revenue", cells: { A1: "Quarter", B1: "Total", A2: "Q1", B2: "100" } }, { name: "Notes", cells: { A1: "draft" } }] };
    const sheets = await call(deps, "polpo_artifact_create", { title: "Revenue", type: "html", kind: "sheets", content: JSON.stringify(book) });
    const sheetId = sheets.structuredContent.artifact.id as string;
    const op = await call(deps, "polpo_artifact_update", { id: sheetId, expectedVersion: 1, ops: [{ op: "set_range", sheet: "Revenue", start: "A3", values: [["Q2", "140"], ["Total", "=SUM(B2:B3)"]] }] });
    expect(op.content[0]!.text).toMatch(/now v2, set_range/);
    const range = await call(deps, "polpo_artifact_get", { id: sheetId, sheet: "Revenue", range: "A3:B4" });
    expect(JSON.parse(range.structuredContent.read.text)).toEqual({ name: "Revenue", range: "A3:B4", cells: { A3: "Q2", B3: "140", A4: "Total", B4: "=SUM(B2:B3)" } });
    const outline = await call(deps, "polpo_artifact_get", { id: sheetId, outline: true });
    expect(outline.content[0]!.text).toMatch(/0\. "Revenue" 8 cells \(A1:B4\)\n {2}1\. "Notes" 1 cells/);
    const badOp = await call(deps, "polpo_artifact_update", { id: sheetId, ops: [{ op: "delete_sheet", sheet: "Nope" }] });
    expect(badOp.content[0]!.text).toMatch(/No sheet "Nope"/);
  });
});
