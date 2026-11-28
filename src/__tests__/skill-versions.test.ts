/**
 * Skill versions: every change recorded as a copy of the whole folder (upload replace, edit, create,
 * local install with force, restore), retention, diffs, restore round trip, deleted skills, both pools,
 * the REST routes (path safety included) and the MCP tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillBundle, writeZipArchive } from "../llm/skill-bundle.js";
import {
  createAgentSkill, createOrchestratorSkill, installSkillBundleToPool, installSkills, removeSkill, updateAgentSkill, updateOrchestratorSkill,
} from "../llm/skills.js";
import {
  diffSkillVersions, listSkillVersionFiles, listSkillVersions, purgeDeletedSkillVersions, restoreSkillVersion, skillVersionsDir, unifiedDiff,
} from "../llm/skill-versions.js";
import { skillRoutes } from "../server/routes/skills.js";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

const skillMd = (name: string, body = "Do the thing.", description = `Does ${name} things.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const zipOf = (files: Record<string, string>) => writeZipArchive(Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) })));

let tmp: string;
let home: string;
let polpoDir: string;
const prevHome = process.env.HOME;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "polpo-skill-versions-"));
  home = join(tmp, "home");
  mkdirSync(home);
  process.env.HOME = home;
  polpoDir = join(tmp, "project", ".polpo");
  mkdirSync(polpoDir, { recursive: true });
});
afterEach(() => {
  process.env.HOME = prevHome;
  delete process.env.POLPO_SKILL_VERSIONS_KEEP;
  delete process.env.POLPO_SKILL_VERSIONS_MAX_MB;
  delete process.env.POLPO_SKILL_VERSIONS_DELETED_DAYS;
  rmSync(tmp, { recursive: true, force: true });
});

const agent = (name: string) => ({ pool: "agent" as const, name });
const versions = (name: string, pool: "agent" | "orchestrator" = "agent", global = false) => listSkillVersions(polpoDir, { pool, global, name })?.versions ?? [];

describe("recording", () => {
  it("records create, edit and upload replace with author and source; the latest is the current state", () => {
    createAgentSkill(polpoDir, "alpha", "First.", "Version one.", { author: "person:ada@example.com" });
    updateAgentSkill(polpoDir, "alpha", { content: "Version two." }, false, "coach");
    const bundle = parseSkillBundle(zipOf({ "alpha/SKILL.md": skillMd("alpha", "Version three."), "alpha/references/api.md": "# API" }));
    const r = installSkillBundleToPool(polpoDir, bundle, { onConflict: "replace", author: "mcp:Claude" });
    expect(r.installed[0]).toMatchObject({ name: "alpha", replaced: true });

    const h = listSkillVersions(polpoDir, agent("alpha"))!;
    expect(h.current).toBe(3);
    expect(h.versions.map((v) => [v.version, v.source, v.author, v.files])).toEqual([
      [3, "upload", "mcp:Claude", 2], [2, "edit", "coach", 1], [1, "create", "person:ada@example.com", 1],
    ]);
    expect(h.versions[2]).toMatchObject({ name: "alpha", description: "First." });
    expect(h.versions[0].totalBytes).toBeGreaterThan(0);
    // each version is a copy of the whole folder, outside the pool
    const dir = skillVersionsDir(polpoDir, agent("alpha"));
    expect(dir.startsWith(join(polpoDir, "skill-versions", "agent", "project"))).toBe(true);
    expect(readFileSync(join(dir, "1", "SKILL.md"), "utf8")).toContain("Version one.");
    expect(readFileSync(join(dir, "3", "references", "api.md"), "utf8")).toBe("# API");
    expect(existsSync(join(polpoDir, "skills", "alpha", "1"))).toBe(false);
  });

  it("a skill that predates versioning is captured first as 1.0.0; outside changes ride along a direct publish, flagged external", () => {
    const dir = join(polpoDir, "skills", "legacy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd("legacy", "Old."));
    updateAgentSkill(polpoDir, "legacy", { content: "New." }, false, "person:ada@example.com");
    expect(versions("legacy").map((v) => [v.version, v.semver, v.source, v.author])).toEqual([
      [2, "1.0.1", "edit", "person:ada@example.com"], [1, "1.0.0", "external", "system:migration"],
    ]);
    // changed outside Polpo, then edited directly: one version holding both, flagged external
    writeFileSync(join(dir, "notes.md"), "hand-made");
    updateAgentSkill(polpoDir, "legacy", { content: "Newer." }, false, "coach");
    expect(versions("legacy").map((v) => [v.semver, v.source, !!v.external])).toEqual([["1.1.0", "edit", true], ["1.0.1", "edit", false], ["1.0.0", "external", false]]);
    // nothing changed: nothing recorded
    updateAgentSkill(polpoDir, "legacy", { content: "Newer." }, false, "coach");
    expect(versions("legacy")).toHaveLength(3);
  });

  it("a local install with force records the replaced skill and the new one (source local)", () => {
    createAgentSkill(polpoDir, "beta", "Mine.", "Mine.", { author: "cli" });
    const src = join(tmp, "src", "beta");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), skillMd("beta", "Theirs."));
    const r = installSkills(join(tmp, "src"), polpoDir, { force: true, author: "cli" });
    expect(r.installed.map((s) => s.name)).toEqual(["beta"]);
    expect(versions("beta").map((v) => [v.source, v.author])).toEqual([["local", "cli"], ["create", "cli"]]);
  });

  it("both pools, project and global", () => {
    createOrchestratorSkill(polpoDir, "helper", "Polpo's.", "One.", { author: "polpo" });
    updateOrchestratorSkill(polpoDir, "helper", { description: "Polpo's own." }, false, "polpo");
    expect(versions("helper", "orchestrator").map((v) => [v.source, v.description])).toEqual([["edit", "Polpo's own."], ["create", "Polpo's."]]);
    expect(existsSync(join(polpoDir, "skill-versions", "orchestrator", "project", "helper", "index.json"))).toBe(true);
    createAgentSkill(polpoDir, "shared", "Everywhere.", "One.", { global: true, author: "cli" });
    expect(versions("shared", "agent", true)).toHaveLength(1);
    expect(existsSync(join(home, ".polpo", "skill-versions", "agent", "global", "shared", "1", "SKILL.md"))).toBe(true);
    expect(versions("shared")).toHaveLength(0);
  });
});

describe("retention", () => {
  it("keeps the last N versions (numbers never reused) and a size cap; the latest always stays", () => {
    process.env.POLPO_SKILL_VERSIONS_KEEP = "3";
    createAgentSkill(polpoDir, "gamma", "G.", "v1");
    for (let i = 2; i <= 6; i++) updateAgentSkill(polpoDir, "gamma", { content: `v${i}` });
    expect(versions("gamma").map((v) => v.version)).toEqual([6, 5, 4]);
    const dir = skillVersionsDir(polpoDir, agent("gamma"));
    expect(existsSync(join(dir, "1"))).toBe(false);
    expect(existsSync(join(dir, "4", "SKILL.md"))).toBe(true);
    // a 1 MB cap with ~600 KB versions: only the latest fits
    process.env.POLPO_SKILL_VERSIONS_KEEP = "20";
    process.env.POLPO_SKILL_VERSIONS_MAX_MB = "1";
    updateAgentSkill(polpoDir, "gamma", { content: "x".repeat(600_000) });
    updateAgentSkill(polpoDir, "gamma", { content: "y".repeat(600_000) });
    expect(versions("gamma").map((v) => v.version)).toEqual([8]);
  });
});

describe("diff", () => {
  it("unified diff with hunks and counts", () => {
    const a = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n") + "\n";
    const b = a.replace("two", "TWO").replace("nine\n", "nine\nnine and a half\n");
    const d = unifiedDiff(a, b, "a/x", "b/x")!;
    expect(d).toMatchObject({ additions: 2, deletions: 1 });
    expect(d.text).toBe([
      "--- a/x", "+++ b/x",
      "@@ -1,5 +1,5 @@", " one", "-two", "+TWO", " three", " four", " five",
      "@@ -7,4 +7,5 @@", " seven", " eight", " nine", "+nine and a half", " ten", "",
    ].join("\n"));
    expect(unifiedDiff("", "a\nb\n")!.text).toContain("@@ -0,0 +1,2 @@\n+a\n+b");
    expect(unifiedDiff("same\n", "same\n")!.additions).toBe(0);
  });

  it("files added, removed, changed (binary only named)", () => {
    installSkillBundleToPool(polpoDir, parseSkillBundle(zipOf({ "d/SKILL.md": skillMd("d", "A"), "d/old.md": "gone", "d/bin.dat": "\u0000\u0001", "d/same.md": "same" })));
    installSkillBundleToPool(polpoDir, parseSkillBundle(zipOf({ "d/SKILL.md": skillMd("d", "B"), "d/new.md": "hello", "d/bin.dat": "\u0000\u0002", "d/same.md": "same" })), { onConflict: "replace" });
    const diff = diffSkillVersions(polpoDir, agent("d"), 1, 2);
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 2 });
    expect(diff.unchanged).toBe(1);
    const by = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(by["new.md"]).toMatchObject({ status: "added", diff: expect.stringContaining("+hello") });
    expect(by["old.md"]).toMatchObject({ status: "removed", diff: expect.stringContaining("-gone") });
    expect(by["bin.dat"]).toMatchObject({ status: "changed", binary: true });
    expect(by["bin.dat"].diff).toBeUndefined();
    expect(by["SKILL.md"].diff).toContain("-A\n+B");
  });
});

describe("restore and delete", () => {
  it("restore round trip: the current state is kept, the restore is a new version", () => {
    installSkillBundleToPool(polpoDir, parseSkillBundle(zipOf({ "r/SKILL.md": skillMd("r", "first"), "r/a.md": "a" })));
    installSkillBundleToPool(polpoDir, parseSkillBundle(zipOf({ "r/SKILL.md": skillMd("r", "second"), "r/b.md": "b" })), { onConflict: "replace" });
    const r = restoreSkillVersion(polpoDir, agent("r"), 1, "person:ada@example.com");
    expect(r.published).toMatchObject({ version: 3, source: "restore", restoredFrom: 1, author: "person:ada@example.com" });
    const dir = join(polpoDir, "skills", "r");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("first");
    expect(existsSync(join(dir, "a.md"))).toBe(true);
    expect(existsSync(join(dir, "b.md"))).toBe(false);
    expect(listSkillVersionFiles(polpoDir, agent("r"), 3).files.map((f) => f.path)).toEqual(["SKILL.md", "a.md"]);
    // undo the restore
    restoreSkillVersion(polpoDir, agent("r"), 2);
    expect(existsSync(join(dir, "b.md"))).toBe(true);
    expect(() => restoreSkillVersion(polpoDir, agent("r"), 99)).toThrow(/no version 99/);
  });

  it("a deleted skill keeps its history, can be restored, and is purged after the grace period", () => {
    createAgentSkill(polpoDir, "gone", "G.", "kept");
    expect(removeSkill(polpoDir, "gone", false, "person:ada@example.com")).toBe(true);
    const h = listSkillVersions(polpoDir, agent("gone"))!;
    expect(h.deletedAt).toBeTruthy();
    expect(h.deletedBy).toBe("person:ada@example.com");
    expect(h.current).toBeUndefined();
    restoreSkillVersion(polpoDir, agent("gone"), 1);
    expect(readFileSync(join(polpoDir, "skills", "gone", "SKILL.md"), "utf8")).toContain("kept");
    const back = listSkillVersions(polpoDir, agent("gone"))!;
    expect(back.deletedAt).toBeUndefined();
    // brought back exactly as it was: its last version is production again
    expect(back.current).toBe(1);
    expect(back.events?.[0]).toMatchObject({ action: "publish", to: "1.0.0" });
    // delete again; 31 days later the history is purged
    removeSkill(polpoDir, "gone");
    expect(purgeDeletedSkillVersions(polpoDir, "agent", false, Date.now() + 29 * 86_400_000)).toEqual([]);
    expect(purgeDeletedSkillVersions(polpoDir, "agent", false, Date.now() + 31 * 86_400_000)).toEqual(["gone"]);
    expect(listSkillVersions(polpoDir, agent("gone"))).toBeUndefined();
  });
});

describe("REST", () => {
  const app = () => {
    const emit = vi.fn();
    return { emit, app: skillRoutes(() => ({ polpoDir, workDir: join(tmp, "project"), getAgents: async () => [{ name: "dev" }], emit, author: () => "person:ada@example.com" })) };
  };
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("records edits by the request's author; list, files, file, diff, restore, download — both pools", async () => {
    const { app: a, emit } = app();
    expect((await a.request("/create", json({ name: "alpha", description: "A.", content: "one" }))).status).toBe(201);
    expect((await a.request("/alpha", { ...json({ content: "two" }), method: "PUT" })).status).toBe(200);
    expect((await a.request("/orchestrator", json({ name: "helper", description: "H.", content: "one" }))).status).toBe(201);
    expect((await a.request("/orchestrator/helper", { ...json({ content: "two" }), method: "PUT" })).status).toBe(200);
    for (const prefix of ["", "/orchestrator"]) {
      const name = prefix ? "helper" : "alpha";
      const list = await (await a.request(`${prefix}/${name}/versions`)).json() as any;
      expect(list.data).toMatchObject({ name, scope: "project", current: 2, retention: { maxVersions: 20, maxBytes: 50 * 1024 * 1024 } });
      expect(list.data.versions.map((v: any) => [v.version, v.source, v.author])).toEqual([[2, "edit", "person:ada@example.com"], [1, "create", "person:ada@example.com"]]);
      const files = await (await a.request(`${prefix}/${name}/versions/1/files`)).json() as any;
      expect(files.data.files.map((f: any) => f.path)).toEqual(["SKILL.md"]);
      const file = await a.request(`${prefix}/${name}/versions/1/files/SKILL.md`);
      expect(file.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await file.text()).toContain("one");
      const diff = await (await a.request(`${prefix}/${name}/versions/1/diff/2`)).json() as any;
      expect(diff.data.files[0]).toMatchObject({ path: "SKILL.md", status: "changed", additions: 1, deletions: 1 });
      const restored = await a.request(`${prefix}/${name}/versions/1/restore`, { method: "POST" });
      expect(restored.status).toBe(200);
      expect((await restored.json() as any).data).toMatchObject({ restoredFrom: 1, version: { version: 3, source: "restore", author: "person:ada@example.com" } });
      const dl = await a.request(`${prefix}/${name}/versions/2/download`);
      expect(dl.headers.get("content-disposition")).toContain(`${name}-1.0.1.skill`);
      expect(parseSkillBundle(Buffer.from(await dl.arrayBuffer())).preview.skills[0].name).toBe(name);
    }
    expect(emit).toHaveBeenCalledWith("skill:changed", expect.objectContaining({ action: "updated", skillName: "alpha" }));
  });

  it("path safety and errors on version reads", async () => {
    const { app: a } = app();
    await a.request("/create", json({ name: "alpha", description: "A.", content: "one" }));
    writeFileSync(join(polpoDir, "polpo.json"), "{\"secret\":true}");
    for (const bad of ["..%2F..%2F..%2F..%2Fpolpo.json", "%2Fetc%2Fpasswd", "x/..%2F..%2F..%2Findex.json", "nope.md"]) {
      expect((await a.request(`/alpha/versions/1/files/${bad}`)).status, bad).toBe(404);
    }
    expect((await a.request("/alpha/versions/9/files")).status).toBe(404);
    expect((await a.request("/alpha/versions/abc/files")).status).toBe(400);
    expect((await a.request("/missing/versions")).status).toBe(404);
    expect((await a.request("/alpha/versions/1/diff/7")).status).toBe(404);
  });

  it("a deleted skill: its versions stay listed and restore brings it back", async () => {
    const { app: a, emit } = app();
    await a.request("/create", json({ name: "alpha", description: "A.", content: "one" }));
    expect((await a.request("/alpha", { method: "DELETE" })).status).toBe(200);
    const list = await (await a.request("/alpha/versions")).json() as any;
    expect(list.data).toMatchObject({ deletedAt: expect.any(String), deletedBy: "person:ada@example.com" });
    expect((await a.request("/alpha/versions/1/restore", { method: "POST" })).status).toBe(200);
    expect(existsSync(join(polpoDir, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(emit).toHaveBeenCalledWith("skill:changed", expect.objectContaining({ action: "created", skillName: "alpha" }));
  });
});

describe("MCP", () => {
  const mcp = () => {
    const app = skillRoutes(() => ({ polpoDir, workDir: join(tmp, "project"), getAgents: async () => [{ name: "dev" }], emit: () => undefined, author: () => "mcp:Claude" }));
    const api = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
      const sub = path.replace(/^\/api\/v1\/skills/, "") || "/";
      const init: RequestInit = { method };
      if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
      const res = await app.request(sub, init);
      const type = res.headers.get("content-type") ?? "";
      if (type.startsWith("application/json")) return { status: res.status, body: await res.json(), headers: res.headers };
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, body: Buffer.from(bytes).toString("utf8"), headers: res.headers, bytes };
    };
    const deps: McpDeps = { api, version: "x", toolsets: ["all"] };
    const rpc = (method: string, params: Record<string, unknown> = {}) => handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await (await rpc("tools/call", { name, arguments: args })).json()).result;
      await expectValidOutput(deps, async () => (await (await rpc("tools/list")).json()).result.tools, name, result);
      return result;
    };
    return { call, rpc };
  };

  it("versions, diff, restore (confirm), get counts versions; read vs admin scopes", async () => {
    const { call, rpc } = mcp();
    expect((await call("polpo_skill_create", { name: "alpha", description: "A.", content: "one" })).isError).toBeFalsy();
    await call("polpo_skill_update", { name: "alpha", content: "two" });
    const list = await call("polpo_skill_versions", { name: "alpha" });
    expect(list.structuredContent).toMatchObject({ name: "alpha", current: 2, total: 2 });
    expect(list.structuredContent.versions[0]).toMatchObject({ version: 2, author: "mcp:Claude", source: "edit", current: true });
    expect(list.content[0].text).toContain("1.0.1 (production)");
    const diff = await call("polpo_skill_version_diff", { name: "alpha", a: 1, b: 2 });
    expect(diff.structuredContent.files).toEqual([{ path: "SKILL.md", status: "changed", additions: 1, deletions: 1 }]);
    expect(diff.structuredContent.diff).toContain("-one\n+two");
    const unconfirmed = await call("polpo_skill_restore", { name: "alpha", version: 1 });
    expect(unconfirmed).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/confirm: true/) }] });
    const restored = await call("polpo_skill_restore", { name: "alpha", version: 1, confirm: true });
    expect(restored.structuredContent).toEqual({ name: "alpha", restored_from: 1, version: 3, published: "1.0.2", draft: false });
    expect(readFileSync(join(polpoDir, "skills", "alpha", "SKILL.md"), "utf8")).toContain("one");
    const got = await call("polpo_skill_get", { name: "alpha" });
    expect(got.structuredContent.skill).toMatchObject({ versions: 3, current_version: 3 });
    expect(got.content[0].text).toMatch(/version: 1\.0\.2 in production .*3 versions/);
    expect(await call("polpo_skill_version_diff", { name: "alpha", a: 1, b: 9 })).toMatchObject({ isError: true });
    // the scope matrix: list and diff are reads, restore needs admin
    const tools = (await (await rpc("tools/list")).json()).result.tools as Array<{ name: string; annotations: Record<string, unknown> }>;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(by.polpo_skill_versions).toMatchObject({ readOnlyHint: true });
    expect(by.polpo_skill_version_diff).toMatchObject({ readOnlyHint: true });
    expect(by.polpo_skill_restore).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
