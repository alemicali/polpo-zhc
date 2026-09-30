import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileRoutes as nodeRoutes } from "../server/routes/files.js";
import { fileRoutes as sharedRoutes } from "../../packages/server/src/routes/files.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.each([["node", nodeRoutes], ["shared", sharedRoutes]] as const)("%s Mermaid file routes", (_name, factory) => {
  it.each(["diagram.mmd", "diagram.MERMAID"])("lists, previews and reads %s as Mermaid text", async name => {
    const root = await mkdtemp(join(tmpdir(), "polpo-mermaid-test-")); roots.push(root);
    const source = "flowchart TD\n" + "%% comment\n".repeat(600) + "A-->B";
    await writeFile(join(root, name), source);
    const app = factory(() => ({ polpoDir: join(root, ".polpo"), workDir: root, agentWorkDir: root, fs: new NodeFileSystem(), emit: () => {} }));
    const list = await (await app.request("/list")).json();
    expect(JSON.stringify(list)).toContain("text/vnd.mermaid");
    const preview = await (await app.request(`/preview?path=${name}`)).json();
    expect(preview.data).toMatchObject({ mimeType: "text/vnd.mermaid", type: "text", previewable: true, truncated: true });
    const response = await app.request(`/read?path=${name}`);
    expect(response.headers.get("content-type")).toContain("text/vnd.mermaid");
    expect(await response.text()).toBe(source);
    const denied = await app.request("/read?path=../outside.mmd"); expect(denied.status).toBe(400);
  });
});
