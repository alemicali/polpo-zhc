/**
 * Skill bundles: .skill / .zip archives (Agent Skills format), validation and safety, install into
 * the pools, the REST upload (preview → install, conflicts), and an installed skill's files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  SkillBundleError, crc32, installSkillBundle, listSkillFiles, parseSkillBundle, readSkillFrontmatter, readZipArchive,
  resolveSkillFile, setFrontmatterName, specNameErrors, writeZipArchive, zipSkillDir, readSkillTextFiles,
} from "../llm/skill-bundle.js";
import { buildSkillPrompt, installSkills, loadAgentSkills, assignSkillToAgent } from "../llm/skills.js";
import { skillRoutes } from "../server/routes/skills.js";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

// ── a raw zip writer that can produce hostile archives ──
interface RawEntry { name: string; data?: Buffer | string; mode?: number; method?: 0 | 8; declaredSize?: number; flags?: number; crc?: number }
function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const size = e.declaredSize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(e.flags ?? 0, 6); l.writeUInt16LE(method, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(size, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.flags ?? 0, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, name, body); centrals.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const skillMd = (name: string, description = `Does ${name} things. Use when ${name} is mentioned.`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nSee [the API](references/api.md) and run scripts/run.py.\n`;

const zipOf = (files: Record<string, string>) => writeZipArchive(Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) })));

let tmp: string;
let home: string;
let polpoDir: string;
const prevHome = process.env.HOME;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "polpo-skill-bundles-"));
  home = join(tmp, "home");
  mkdirSync(home);
  process.env.HOME = home; // the global pool (~/.polpo) lives in the test's home
  polpoDir = join(tmp, "project", ".polpo");
  mkdirSync(polpoDir, { recursive: true });
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("archive parsing", () => {
  it("reads a .skill file (folder at the root, as skill-creator packages it)", () => {
    const zip = zipOf({ "pdf-tools/SKILL.md": skillMd("pdf-tools", "Fill PDF forms. Use for PDFs.", "license: MIT\nmetadata:\n  version: \"1.0\"\n"), "pdf-tools/references/api.md": "# API", "pdf-tools/scripts/run.py": "print(1)" });
    const { preview } = parseSkillBundle(zip, { filename: "pdf-tools.skill" });
    expect(preview.skills).toHaveLength(1);
    const s = preview.skills[0];
    expect(s).toMatchObject({ name: "pdf-tools", folder: "pdf-tools", description: "Fill PDF forms. Use for PDFs.", license: "MIT", errors: [] });
    expect(s.metadata).toEqual({ version: "1.0" });
    expect(s.files.map((f) => f.path)).toEqual(["SKILL.md", "references/api.md", "scripts/run.py"]);
    expect(s.totalBytes).toBe(s.files.reduce((a, f) => a + f.size, 0));
  });

  it("reads a flat .zip (SKILL.md at the archive root)", () => {
    const { preview } = parseSkillBundle(zipOf({ "SKILL.md": skillMd("flat-skill"), "references/api.md": "x" }), { filename: "whatever.zip" });
    expect(preview.skills[0]).toMatchObject({ name: "flat-skill", folder: "", errors: [] });
    expect(preview.skills[0].files.map((f) => f.path)).toContain("references/api.md");
  });

  it("finds several skills; a SKILL.md nested in a skill is just one of its files", () => {
    const { preview } = parseSkillBundle(zipOf({
      "skills/alpha/SKILL.md": skillMd("alpha"), "skills/beta/SKILL.md": skillMd("beta"),
      "skills/beta/examples/demo/SKILL.md": skillMd("demo"), "README.md": "outside",
    }));
    expect(preview.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(preview.skills[1].files.map((f) => f.path)).toContain("examples/demo/SKILL.md");
    expect(preview.warnings.join(" ")).toMatch(/outside any skill folder.*README\.md/);
  });

  it("drops junk (__MACOSX, .DS_Store, ._*, __pycache__) and reports it", () => {
    const { preview } = parseSkillBundle(zipOf({
      "s/SKILL.md": skillMd("s"), "__MACOSX/s/._SKILL.md": "x", "s/.DS_Store": "x", "s/._run.py": "x", "s/scripts/__pycache__/a.pyc": "x",
    }));
    expect(preview.skills[0].files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(preview.ignored).toHaveLength(4);
  });

  it("refuses path traversal, absolute paths and symlinks", () => {
    expect(() => readZipArchive(rawZip([{ name: "s/SKILL.md", data: "x" }, { name: "../evil.sh", data: "x" }]))).toThrow(/Unsafe path/);
    expect(() => readZipArchive(rawZip([{ name: "s/../../evil", data: "x" }]))).toThrow(/Unsafe path/);
    expect(() => readZipArchive(rawZip([{ name: "/etc/passwd", data: "x" }]))).toThrow(/Unsafe path/);
    expect(() => readZipArchive(rawZip([{ name: "C:\\evil.txt", data: "x" }]))).toThrow(/Unsafe path/);
    expect(() => readZipArchive(rawZip([{ name: "s/link", data: "/etc/passwd", mode: 0o120777 }]))).toThrow(/symlink/);
    try { readZipArchive(rawZip([{ name: "../x", data: "x" }])); } catch (e) { expect((e as SkillBundleError).code).toBe("UNSAFE_ARCHIVE"); }
  });

  it("stops zip bombs: declared sizes, real inflated size, file count, totals", () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41); // compresses to a few KB
    const limits = { maxArchiveBytes: 1024 * 1024, maxTotalBytes: 3 * 1024 * 1024, maxFiles: 5, maxFileBytes: 2 * 1024 * 1024, maxPathLength: 255 };
    // lies about its size: inflating stops at the declared size
    expect(() => readZipArchive(rawZip([{ name: "s/SKILL.md", data: big, declaredSize: 100 }]), limits)).toThrow(/zip bomb|declared/);
    // per file
    expect(() => readZipArchive(rawZip([{ name: "a", data: Buffer.alloc(2 * 1024 * 1024 + 1) }]), limits)).toThrow(/limit per file/);
    // total
    expect(() => readZipArchive(rawZip([{ name: "a", data: big }, { name: "b", data: big }]), limits)).toThrow(/uncompressed/);
    // count
    expect(() => readZipArchive(rawZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: "x" }))), limits)).toThrow(/entries/);
    // archive size
    expect(() => readZipArchive(Buffer.alloc(limits.maxArchiveBytes + 1), limits)).toThrow(/archive is/);
  });

  it("refuses corrupt, encrypted and non-zip input", () => {
    expect(() => readZipArchive(Buffer.from("not a zip at all, definitely not"))).toThrow(/Not a zip/);
    expect(() => readZipArchive(rawZip([{ name: "a", data: "hello", crc: 1 }]))).toThrow(/CRC/);
    expect(() => readZipArchive(rawZip([{ name: "a", data: "hello", flags: 1 }]))).toThrow(/encrypted/);
  });

  it("keeps executable bits out and says so", () => {
    const { preview, contents } = parseSkillBundle(rawZip([{ name: "s/SKILL.md", data: skillMd("s") }, { name: "s/scripts/run.sh", data: "echo", mode: 0o100755 }]));
    expect(preview.warnings.join(" ")).toMatch(/executable/);
    const r = installSkillBundle({ preview, contents }, join(tmp, "pool"));
    expect(r.installed).toHaveLength(1);
    expect(statSync(join(tmp, "pool", "s", "scripts", "run.sh")).mode & 0o111).toBe(0);
  });

  it("no SKILL.md: a clear error (and a hint for skill.md in lowercase)", () => {
    expect(() => parseSkillBundle(zipOf({ "a/readme.md": "x" }))).toThrow(/No SKILL\.md/);
    expect(() => parseSkillBundle(zipOf({ "a/skill.md": skillMd("a") }))).toThrow(/in capitals/);
  });
});

describe("frontmatter validation (Agent Skills spec)", () => {
  it("name: lowercase, digits, single hyphens, ≤ 64", () => {
    expect(specNameErrors("pdf-tools")).toEqual([]);
    expect(specNameErrors("PDF_Tools")).toHaveLength(1);
    expect(specNameErrors("-pdf")).toHaveLength(1);
    expect(specNameErrors("pdf--tools")).toHaveLength(1);
    expect(specNameErrors("a".repeat(65)).join(" ")).toMatch(/64/);
  });

  it("errors and warnings in the preview", () => {
    const { preview } = parseSkillBundle(zipOf({
      "no-fm/SKILL.md": "# just markdown",
      "bad-yaml/SKILL.md": "---\nname: [oops\n---\n",
      "no-desc/SKILL.md": "---\nname: no-desc\n---\nbody",
      "long-desc/SKILL.md": `---\nname: long-desc\ndescription: ${"x".repeat(1025)}\n---\n`,
      "Bad_Name/SKILL.md": skillMd("Bad_Name"),
      "warns/SKILL.md": skillMd("claude-helper", "Has <b>tags</b>. Use always.", "owner: me\n"),
    }));
    const by = Object.fromEntries(preview.skills.map((s) => [s.folder, s]));
    expect(by["no-fm"].errors.join(" ")).toMatch(/no YAML frontmatter/);
    expect(by["bad-yaml"].errors.join(" ")).toMatch(/not valid YAML/);
    expect(by["no-desc"].errors.join(" ")).toMatch(/no description/);
    expect(by["long-desc"].errors.join(" ")).toMatch(/1024/);
    expect(by["Bad_Name"].errors.join(" ")).toMatch(/lowercase/);
    const w = by["warns"].warnings.join(" ");
    expect(by["warns"].errors).toEqual([]);
    expect(w).toMatch(/reserved word/);
    expect(w).toMatch(/XML\/HTML tags/);
    expect(w).toMatch(/outside the spec.*owner/);
    expect(w).toMatch(/folder is "warns"/);
  });

  it("parses frontmatter strictly and rewrites only the name", () => {
    const md = skillMd("old-name", "Desc. Use it.", "license: MIT\n");
    expect(readSkillFrontmatter(md)).toMatchObject({ ok: true, fm: { name: "old-name", license: "MIT" } });
    const renamed = setFrontmatterName(md, "new-name");
    expect(renamed).toContain("name: new-name");
    expect(renamed).toContain("license: MIT");
    expect(renamed.split("---")[2]).toBe(md.split("---")[2]);
  });
});

describe("install", () => {
  const bundle = () => parseSkillBundle(zipOf({ "alpha/SKILL.md": skillMd("alpha"), "alpha/references/api.md": "# API", "beta/SKILL.md": skillMd("beta") }));

  it("installs every skill with its files", () => {
    const pool = join(tmp, "pool");
    const r = installSkillBundle(bundle(), pool);
    expect(r.installed.map((i) => i.name)).toEqual(["alpha", "beta"]);
    expect(readFileSync(join(pool, "alpha", "references", "api.md"), "utf8")).toBe("# API");
    expect(existsSync(join(pool, ".staging"))).toBe(false);
  });

  it("conflicts: fail (default), skip, replace, rename", () => {
    const pool = join(tmp, "pool");
    installSkillBundle(bundle(), pool, { skills: ["alpha"] });
    writeFileSync(join(pool, "alpha", "stale.txt"), "old");
    expect(installSkillBundle(bundle(), pool, { skills: ["alpha"] }).errors[0].error).toMatch(/exists/);
    expect(installSkillBundle(bundle(), pool, { skills: ["alpha"], onConflict: "skip" }).skipped).toHaveLength(1);
    const replaced = installSkillBundle(bundle(), pool, { skills: ["alpha"], onConflict: "replace" });
    expect(replaced.installed[0]).toMatchObject({ name: "alpha", replaced: true });
    expect(existsSync(join(pool, "alpha", "stale.txt"))).toBe(false);
    const renamed = installSkillBundle(bundle(), pool, { skills: ["alpha"], renames: { alpha: "alpha-two" } });
    expect(renamed.installed[0]).toMatchObject({ name: "alpha-two", from: "alpha" });
    expect(readFileSync(join(pool, "alpha-two", "SKILL.md"), "utf8")).toMatch(/^---\nname: alpha-two\n/);
    // an invalid name can be fixed by a rename, a rename to an invalid name is refused
    const bad = parseSkillBundle(zipOf({ "Bad/SKILL.md": skillMd("Bad_Name") }));
    expect(installSkillBundle(bad, pool).errors).toHaveLength(1);
    expect(installSkillBundle(bad, pool, { renames: { Bad_Name: "good-name" } }).installed[0].name).toBe("good-name");
    expect(installSkillBundle(bad, pool, { renames: { Bad_Name: "../x" } }).errors[0].error).toMatch(/lowercase/);
  });

  it("installSkills takes a local .skill file (CLI / chat path)", () => {
    const file = join(tmp, "alpha.skill");
    writeFileSync(file, zipOf({ "alpha/SKILL.md": skillMd("alpha"), "alpha/scripts/run.py": "print(1)" }));
    const r = installSkills(file, polpoDir);
    expect(r.errors).toEqual([]);
    expect(r.installed.map((s) => s.name)).toEqual(["alpha"]);
    expect(existsSync(join(polpoDir, "skills", "alpha", "scripts", "run.py"))).toBe(true);
    expect(installSkills(file, polpoDir).skipped.map((s) => s.name)).toEqual(["alpha"]);
    expect(installSkills(file, polpoDir, { force: true }).installed).toHaveLength(1);
  });
});

describe("installed skill files", () => {
  it("lists, resolves path-safely, zips back", () => {
    const pool = join(tmp, "pool");
    installSkillBundle(parseSkillBundle(zipOf({ "alpha/SKILL.md": skillMd("alpha"), "alpha/references/api.md": "# API", "alpha/assets/logo.png": "\x89PNG" })), pool);
    const dir = join(pool, "alpha");
    writeFileSync(join(tmp, "secret.txt"), "secret");
    symlinkSync(join(tmp, "secret.txt"), join(dir, "leak.txt"));
    expect(listSkillFiles(dir).files.map((f) => f.path)).toEqual(["SKILL.md", "assets/logo.png", "references/api.md"]);
    expect(resolveSkillFile(dir, "references/api.md")).toBe(join(dir, "references", "api.md"));
    for (const bad of ["../secret.txt", "/etc/passwd", "references/../../secret.txt", "leak.txt", "references", "nope.md", ""]) {
      expect(resolveSkillFile(dir, bad), bad).toBeUndefined();
    }
    const again = parseSkillBundle(zipSkillDir(dir, "alpha"));
    expect(again.preview.skills[0].files.map((f) => f.path)).toEqual(["SKILL.md", "assets/logo.png", "references/api.md"]);
  });
});

describe("runtime: agents see bundled files", () => {
  it("the prompt names the skill folder and its files; harness gets the text files", () => {
    const file = join(tmp, "alpha.skill");
    writeFileSync(file, writeZipArchive([
      { path: "alpha/SKILL.md", data: Buffer.from(skillMd("alpha")) },
      { path: "alpha/references/api.md", data: Buffer.from("# API") },
      { path: "alpha/assets/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
    ]));
    installSkills(file, polpoDir);
    const skills = loadAgentSkills(join(tmp, "project"), polpoDir, "dev", ["alpha"]);
    expect(skills[0].dir).toBe(join(polpoDir, "skills", "alpha"));
    expect(skills[0].files?.map((f) => f.path)).toEqual(["assets/logo.png", "references/api.md"]);
    const prompt = buildSkillPrompt(skills);
    expect(prompt).toContain(`Skill folder: \`${join(polpoDir, "skills", "alpha")}\``);
    expect(prompt).toContain("- references/api.md (5 B)");
    // via an agent's symlink the real folder is shown
    assignSkillToAgent(polpoDir, "dev", "alpha", join(polpoDir, "skills", "alpha"));
    expect(loadAgentSkills(join(tmp, "project"), polpoDir, "dev")[0].dir).toBe(join(polpoDir, "skills", "alpha"));
    const text = readSkillTextFiles(skills[0].dir!);
    expect(text.files).toEqual([{ path: "references/api.md", content: "# API" }]);
    expect(text.skipped).toEqual(["assets/logo.png"]);
  });
});

describe("REST", () => {
  const app = (agents: string[] = ["dev"]) => {
    const emit = vi.fn();
    return { emit, app: skillRoutes(() => ({ polpoDir, workDir: join(tmp, "project"), getAgents: async () => agents.map((name) => ({ name })), emit })) };
  };
  const upload = (a: ReturnType<typeof app>["app"], zip: Buffer, query = "", filename = "bundle.skill", renames?: Record<string, string>) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(zip)], filename));
    if (renames) form.append("renames", JSON.stringify(renames));
    return a.request(`/upload${query}`, { method: "POST", body: form });
  };
  const bundle = zipOf({ "alpha/SKILL.md": skillMd("alpha"), "alpha/references/api.md": "# API", "alpha/assets/x.html": "<script>alert(1)</script>" });

  it("dry run previews and stages; install by uploadId with assignment", async () => {
    const { app: a, emit } = app();
    const res = await upload(a, bundle, "?dryRun=1");
    expect(res.status).toBe(200);
    const { data } = await res.json() as any;
    expect(data.uploadId).toMatch(/^su_/);
    expect(data.skills[0]).toMatchObject({ name: "alpha", errors: [], exists: { agent: { project: false, global: false } } });
    expect(existsSync(join(polpoDir, "skills", "alpha"))).toBe(false);
    const ins = await a.request(`/upload/${data.uploadId}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignTo: ["dev"] }) });
    expect(ins.status).toBe(201);
    const out = await ins.json() as any;
    expect(out.data.installed[0].name).toBe("alpha");
    expect(out.data.assigned).toEqual([{ skill: "alpha", agent: "dev" }]);
    expect(lstatSync(join(polpoDir, "agents", "dev", "skills", "alpha")).isSymbolicLink()).toBe(true);
    expect(emit).toHaveBeenCalledWith("skill:changed", expect.objectContaining({ action: "installed", skillName: "alpha" }));
    // the staged upload is gone
    expect((await a.request(`/upload/${data.uploadId}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    // the preview now says the name is taken
    const again = await (await upload(a, bundle, "?dryRun=1")).json() as any;
    expect(again.data.skills[0].exists.agent.project).toBe(true);
  });

  it("direct install, conflicts (409), replace, rename, global and orchestrator pools", async () => {
    const { app: a } = app();
    expect((await upload(a, bundle)).status).toBe(201);
    const conflict = await upload(a, bundle);
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).code).toBe("CONFLICT");
    expect((await upload(a, bundle, "?onConflict=replace")).status).toBe(201);
    expect((await upload(a, bundle, "", "b.skill", { alpha: "alpha-copy" })).status).toBe(201);
    expect(existsSync(join(polpoDir, "skills", "alpha-copy", "references", "api.md"))).toBe(true);
    expect((await upload(a, bundle, "?global=1")).status).toBe(201);
    expect(existsSync(join(home, ".polpo", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect((await upload(a, bundle, "?pool=orchestrator")).status).toBe(201);
    expect(existsSync(join(polpoDir, ".agent", "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  it("refuses bad archives with 422/413 and a missing file with 400", async () => {
    const { app: a } = app();
    const bad = await upload(a, rawZip([{ name: "../evil", data: "x" }]));
    expect(bad.status).toBe(422);
    expect((await bad.json() as any).code).toBe("UNSAFE_ARCHIVE");
    expect((await upload(a, zipOf({ "x/SKILL.md": "# no frontmatter" }))).status).toBe(422);
    expect((await a.request("/upload", { method: "POST", body: new FormData() })).status).toBe(400);
  });

  it("files: list, read (raw, content type, literal or encoded slashes), path safety, download", async () => {
    const { app: a } = app();
    await upload(a, bundle);
    await upload(a, bundle, "?pool=orchestrator");
    for (const prefix of ["", "/orchestrator"]) {
      const list = await (await a.request(`${prefix}/alpha/files`)).json() as any;
      expect(list.data.files.map((f: any) => f.path)).toEqual(["SKILL.md", "assets/x.html", "references/api.md"]);
      const md = await a.request(`${prefix}/alpha/files/references/api.md`);
      expect(md.status).toBe(200);
      expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(await md.text()).toBe("# API");
      expect((await a.request(`${prefix}/alpha/files/references%2Fapi.md`)).status).toBe(200);
      // HTML is never served as HTML inline; everything is sandboxed
      const html = await a.request(`${prefix}/alpha/files/assets/x.html`);
      expect(html.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(html.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect((await a.request(`${prefix}/alpha/files/assets/x.html?download=1`)).headers.get("content-disposition")).toMatch(/^attachment/);
      for (const bad of ["..%2F..%2Fpolpo.json", "%2Fetc%2Fpasswd", "references/..%2F..%2F..%2Fx", "nope.md"]) {
        expect((await a.request(`${prefix}/alpha/files/${bad}`)).status, bad).toBe(404);
      }
      expect((await a.request(`${prefix}/missing/files`)).status).toBe(404);
      const dl = await a.request(`${prefix}/alpha/download?format=zip`);
      expect(dl.headers.get("content-disposition")).toContain("alpha.zip");
      const parsed = parseSkillBundle(Buffer.from(await dl.arrayBuffer()));
      expect(parsed.preview.skills[0].name).toBe("alpha");
      expect((await a.request(`${prefix}/alpha/download`)).headers.get("content-disposition")).toContain("alpha.skill");
    }
  });
});

describe("MCP: upload in two steps, files", () => {
  /** MCP deps whose API is the real skill routes (+ /files/read of the instance). */
  const mcp = (instanceFiles: Record<string, Buffer> = {}) => {
    const app = skillRoutes(() => ({ polpoDir, workDir: join(tmp, "project"), getAgents: async () => [{ name: "dev" }], emit: () => undefined }));
    const api = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
      if (path.startsWith("/api/v1/files/read")) {
        const p = new URL(`http://x${path}`).searchParams.get("path")!;
        const b = instanceFiles[p];
        return b ? { status: 200, body: null, headers: new Headers({ "content-type": "application/zip" }), bytes: new Uint8Array(b) } : { status: 404, body: { ok: false, error: "nope" }, headers: new Headers() };
      }
      if (path.startsWith("/api/v1/agents")) return { status: 200, body: { ok: true, data: [{ name: "dev" }] }, headers: new Headers() };
      const sub = path.replace(/^\/api\/v1\/skills/, "") || "/";
      const init: RequestInit = { method };
      if (body instanceof FormData) init.body = body;
      else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
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
    return { call };
  };
  const bundle = zipOf({ "alpha/SKILL.md": skillMd("alpha"), "alpha/references/api.md": "# API", "alpha/assets/bin.dat": "\u0000\u0001\u0002" });

  it("prepare (base64, in chunks, or a file of the instance) → finalize", async () => {
    const { call } = mcp({ "attachments/alpha.skill": bundle });
    const prep = await call("polpo_skill_upload_prepare", { archive: { base64: bundle.toString("base64"), filename: "alpha.skill" } });
    expect(prep.isError).toBeFalsy();
    expect(prep.structuredContent.skills[0]).toMatchObject({ name: "alpha", errors: [], name_taken: false });
    expect(existsSync(join(polpoDir, "skills", "alpha"))).toBe(false);
    const fin = await call("polpo_skill_upload_finalize", { upload_id: prep.structuredContent.upload_id, assign_to: ["dev"] });
    expect(fin.structuredContent).toMatchObject({ installed: [{ name: "alpha", from: "alpha", replaced: false, files: 3 }], assigned: ["alpha → dev"] });
    // chunks
    const b64 = bundle.toString("base64");
    const first = await call("polpo_skill_upload_prepare", { archive: { base64: b64.slice(0, 400), filename: "alpha.skill", more: true } });
    const id = first.structuredContent.chunk_id;
    const last = await call("polpo_skill_upload_prepare", { archive: { base64: b64.slice(400), append_to: id } });
    expect(last.structuredContent.skills[0]).toMatchObject({ name: "alpha", name_taken: true });
    const clash = await call("polpo_skill_upload_finalize", { upload_id: last.structuredContent.upload_id });
    expect(clash).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/on_conflict/) }] });
    const renamed = await call("polpo_skill_upload_finalize", { upload_id: last.structuredContent.upload_id, renames: { alpha: "alpha-two" } });
    expect(renamed.structuredContent.installed[0].name).toBe("alpha-two");
    // a file of the instance, into the orchestrator's pool
    const fromPath = await call("polpo_skill_upload_prepare", { archive: { path: "attachments/alpha.skill" }, pool: "orchestrator" });
    const orch = await call("polpo_skill_upload_finalize", { upload_id: fromPath.structuredContent.upload_id, pool: "orchestrator" });
    expect(orch.structuredContent.installed[0].name).toBe("alpha");
    expect(existsSync(join(polpoDir, ".agent", "skills", "alpha", "references", "api.md"))).toBe(true);
    // not a skill
    expect(await call("polpo_skill_upload_prepare", { archive: { base64: Buffer.from("nope").toString("base64") } })).toMatchObject({ isError: true });
  });

  it("lists and reads a skill's files; polpo_skill_get lists them too", async () => {
    const { call } = mcp();
    installSkillBundle(parseSkillBundle(bundle), join(polpoDir, "skills"));
    const files = await call("polpo_skill_files", { name: "alpha" });
    expect(files.structuredContent.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "assets/bin.dat", "references/api.md"]);
    const md = await call("polpo_skill_file_read", { name: "alpha", path: "references/api.md" });
    expect(md.structuredContent).toMatchObject({ path: "references/api.md", text: "# API" });
    const bin = await call("polpo_skill_file_read", { name: "alpha", path: "assets/bin.dat" });
    expect(bin.structuredContent.text).toBeUndefined();
    expect((await call("polpo_skill_file_read", { name: "alpha", path: "assets/bin.dat", encoding: "base64" })).structuredContent.base64).toBe(Buffer.from([0, 1, 2]).toString("base64"));
    expect(await call("polpo_skill_file_read", { name: "alpha", path: "../../polpo.json" })).toMatchObject({ isError: true });
    const got = await call("polpo_skill_get", { name: "alpha" });
    expect(got.content[0].text).toContain("- references/api.md");
    expect(got.structuredContent.skill.files).toHaveLength(3);
  });
});
