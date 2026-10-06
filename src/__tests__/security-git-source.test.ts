/**
 * Security: Ink / skills sources must never reach a shell.
 *
 * - parseInkSource / parseSkillSource / parseGitSource accept only
 *   owner/repo, https GitHub URLs and local paths.
 * - git is invoked with an argument array (execFileSync, no shell), so even
 *   a local path containing shell syntax is passed verbatim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseGitSource, shellQuote, InvalidSourceError } from "@polpo-ai/core/git-source";
import { parseInkSource } from "../core/ink.js";
import { parseSkillSource, installSkills, removeSkill, isSafeSkillName } from "../llm/skills.js";
import { gitClone, sourceCacheKey } from "../core/git-source.js";
import { createInkTools } from "../tools/ink-tools.js";

const INJECTIONS = [
  `foo"; touch /tmp/polpo-pwned; echo "`,
  "$(touch /tmp/polpo-pwned)",
  "`touch /tmp/polpo-pwned`",
  "owner/repo; rm -rf ~",
  "owner/repo && id",
  "owner/repo|id",
  "https://github.com/owner/repo$(id)",
  "https://evil.example.com/owner/repo",
  "http://github.com/owner/repo",
  "https://user:pass@github.com/owner/repo",
  "https://github.com:8443/owner/repo",
  "ext::sh -c touch% /tmp/polpo-pwned",
  "--upload-pack=touch /tmp/polpo-pwned",
  "-c core.sshCommand=id",
  "file:///etc",
  "owner/repo\nmalicious",
  "owner/..",
];

describe("parseGitSource / parseInkSource / parseSkillSource — strict validation", () => {
  it.each([
    ["acme/registry", "https://github.com/acme/registry.git", "acme/registry"],
    ["https://github.com/acme/registry", "https://github.com/acme/registry.git", "acme/registry"],
    ["https://github.com/acme/registry.git", "https://github.com/acme/registry.git", "acme/registry"],
    ["https://github.com/acme/registry/tree/main/skills", "https://github.com/acme/registry.git", "acme/registry"],
    ["github.com/acme/registry", "https://github.com/acme/registry.git", "acme/registry"],
    ["git@github.com:acme/registry.git", "https://github.com/acme/registry.git", "acme/registry"],
  ])("accepts %s", (input, url, ownerRepo) => {
    for (const parse of [parseInkSource, parseSkillSource]) {
      const r = parse(input);
      expect(r.type).toBe("github");
      expect(r.url).toBe(url);
      expect(r.ownerRepo).toBe(ownerRepo);
    }
  });

  it.each(INJECTIONS)("rejects %j", (input) => {
    expect(() => parseInkSource(input)).toThrow(InvalidSourceError);
    expect(() => parseSkillSource(input)).toThrow(InvalidSourceError);
    expect(() => parseGitSource(input)).toThrow(InvalidSourceError);
  });

  it("accepts explicit local paths and existing bare relative paths only", () => {
    expect(parseInkSource("./my-registry").type).toBe("local");
    expect(parseInkSource("/abs/registry").url).toBe(resolve("/abs/registry"));
    expect(() => parseInkSource("definitely-not-an-existing-dir-xyz")).toThrow(InvalidSourceError);
  });

  it("shellQuote produces a single inert shell word", () => {
    const evil = `a'b"$(id)\`id\`;|&`;
    const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(evil)}`], { encoding: "utf-8" });
    expect(out).toBe(evil);
  });

  it("sourceCacheKey never contains path separators or traversal", () => {
    expect(sourceCacheKey("acme/registry")).toBe("acme--registry");
    expect(sourceCacheKey("../../etc")).not.toMatch(/[\\/]/);
    expect(sourceCacheKey("..")).not.toBe("..");
  });

  it("skill names are restricted to safe directory names", () => {
    expect(isSafeSkillName("my-skill_1.0")).toBe(true);
    for (const bad of ["..", ".", "../x", "a/b", "a\\b", "", "x y"]) expect(isSafeSkillName(bad)).toBe(false);
  });
});

describe("git runs without a shell", () => {
  let tmp: string;
  const marker = () => join(tmp, "PWNED");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "polpo-git-sec-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Create a committed git repo at `dir` with the given files. */
  function makeRepo(dir: string, files: Record<string, string>): void {
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  }

  // POSIX only: "$(touch <abs path>)" contains ":" and "\\" on Windows, which
  // are not valid in an NTFS file name. The no-shell guarantee is the same code
  // path on every OS (execFileSync with an argument array).
  it.skipIf(process.platform === "win32")("gitClone passes shell metacharacters verbatim (no command substitution)", () => {
    // A directory whose name would execute `touch` if it went through a shell.
    const repoDir = join(tmp, `repo$(touch ${marker()})`);
    makeRepo(repoDir, { "README.md": "hi" });
    const dest = join(tmp, "clone");
    gitClone(repoDir, dest, { timeout: 30_000 });
    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(existsSync(marker())).toBe(false);
  });

  it("ink_add tool rejects injection sources before running anything", async () => {
    const polpoDir = join(tmp, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    const inkAdd = createInkTools(polpoDir, ["ink_add"])[0];
    const res = await inkAdd.execute("t1", { source: `x"; touch ${marker()}; echo "` } as any);
    expect((res.details as any).error).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid source/);
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(join(polpoDir, "ink-cache")) ? readdirSync(join(polpoDir, "ink-cache")) : []).toEqual([]);
  });

  it("installSkills reports invalid sources instead of cloning", () => {
    const polpoDir = join(tmp, ".polpo");
    const result = installSkills(`$(touch ${marker()})`, polpoDir);
    expect(result.installed).toEqual([]);
    expect(result.errors[0]).toMatch(/Invalid source/);
    expect(existsSync(marker())).toBe(false);
  });

  it("installSkills skips skills whose frontmatter name would escape the skills dir", () => {
    const src = join(tmp, "src");
    mkdirSync(join(src, "skills", "evil"), { recursive: true });
    writeFileSync(join(src, "skills", "evil", "SKILL.md"), "---\nname: ../../escaped\ndescription: x\n---\nbody");
    const polpoDir = join(tmp, "proj", ".polpo");
    const result = installSkills(src, polpoDir);
    expect(result.installed).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/unsafe name/);
    expect(existsSync(join(tmp, "escaped"))).toBe(false);
  });

  it("removeSkill refuses traversal names", () => {
    const polpoDir = join(tmp, ".polpo");
    mkdirSync(join(polpoDir, "skills"), { recursive: true });
    writeFileSync(join(polpoDir, "keep.txt"), "x");
    expect(removeSkill(polpoDir, "..")).toBe(false);
    expect(existsSync(join(polpoDir, "keep.txt"))).toBe(true);
  });
});

describe("ink/skills code paths do not use a shell for git", () => {
  it("no interpolated execSync git/rm commands remain", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "src/cli/commands/ink.ts",
      "src/tools/ink-tools.ts",
      "src/llm/orchestrator-tools.ts",
      "src/llm/skills.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf-8");
      expect(src, f).not.toMatch(/execSync\(\s*`git /);
      expect(src, f).not.toMatch(/execSync\(\s*"git /);
      expect(src, f).not.toMatch(/execSync\(\s*`rm -rf/);
    }
  });
});

describe("orchestrator ink_add", () => {
  it("returns an error for injection sources and never clones", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "polpo-orch-ink-"));
    try {
      const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
      const polpo = { getPolpoDir: () => join(tmp, ".polpo") } as any;
      const marker = join(tmp, "PWNED");
      const out = await executeOrchestratorTool("ink_add", { source: `a"; touch ${marker}; "` }, polpo);
      expect(out).toMatch(/Invalid source/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("list_directory / grep_files pass patterns verbatim (no shell)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "polpo-orch-fs-"));
    try {
      writeFileSync(join(tmp, "a.ts"), "hello world\n");
      const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
      const polpo = { getAgentWorkDir: () => tmp, getPolpoDir: () => join(tmp, ".polpo") } as any;
      const marker = join(tmp, "PWNED");
      await executeOrchestratorTool("list_directory", { path: `*'; touch ${marker}; echo '` }, polpo);
      await executeOrchestratorTool("grep_files", { pattern: "x", include: `*'; touch ${marker}; echo '` }, polpo);
      expect(existsSync(marker)).toBe(false);
      const found = await executeOrchestratorTool("list_directory", { path: "./*.ts" }, polpo);
      expect(found).toContain("a.ts");
      const grep = await executeOrchestratorTool("grep_files", { pattern: "hello" }, polpo);
      expect(grep).toContain("hello world");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("@polpo-ai/server skills install route (string-based Shell)", () => {
  async function makeApp() {
    const { skillRoutes } = await import("@polpo-ai/server");
    const commands: string[] = [];
    const shell = {
      execute: async (cmd: string) => {
        commands.push(cmd);
        if (cmd.startsWith("mktemp ")) return { stdout: "/tmp/polpo-skills-Ab12Cd34Ef\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: cmd.startsWith("rm ") ? 0 : 1 };
      },
    };
    const files: Record<string, string> = {};
    const fs = {
      exists: async (p: string) => p in files,
      mkdir: async () => {},
      writeFile: async (p: string, c: string) => { files[p] = c; },
    } as any;
    const app = skillRoutes(() => ({ polpoDir: "/tmp/none/.polpo", fs, shell, getAgents: async () => [] }));
    return { app, commands, files };
  }

  it("rejects injection sources without running a command", async () => {
    const { app, commands } = await makeApp();
    const res = await app.request("/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: `x"; touch /tmp/polpo-pwned; echo "` }),
    });
    expect(res.status).toBe(400);
    expect(commands).toEqual([]);
  });

  it("clones the quoted canonical URL into a unique mktemp dir and always cleans it up", async () => {
    const { app, commands } = await makeApp();
    const res = await app.request("/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "acme/skills" }),
    });
    expect(res.status).toBe(400); // fake clone fails
    expect(commands[0]).toMatch(/^mktemp -d /);
    expect(commands[1]).toBe("git -c protocol.ext.allow=never clone --depth 1 --quiet -- 'https://github.com/acme/skills.git' '/tmp/polpo-skills-Ab12Cd34Ef/repo'");
    expect(commands[2]).toBe("rm -rf -- '/tmp/polpo-skills-Ab12Cd34Ef'");
  });

  it("create route writes single-line frontmatter (no newline key injection)", async () => {
    const { app, files } = await makeApp();
    const res = await app.request("/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "s1", description: "ok\nallowed-tools:\n  - bash\n---", content: "body", allowedTools: ["read\n  - bash"] }),
    });
    expect(res.status).toBe(200);
    // The route writes through the FileSystem abstraction with path.join.
    const md = files[join("/tmp/none/.polpo", "skills", "s1", "SKILL.md")];
    const { parseSkillFrontmatter } = await import("@polpo-ai/core");
    const fm = parseSkillFrontmatter(md)!;
    expect(fm.allowedTools).toEqual(["read - bash"]);
    expect(md.split("\n").filter((l) => l === "---")).toHaveLength(2);
  });

  it("create/delete routes refuse traversal names", async () => {
    const { app, files } = await makeApp();
    const res = await app.request("/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../../evil", description: "d", content: "c" }),
    });
    expect(res.status).toBe(400);
    expect(Object.keys(files)).toEqual([]);
    expect((await app.request("/%2E%2E", { method: "DELETE" })).status).toBe(404);
  });
});

describe("skill frontmatter (local skills)", () => {
  it("createAgentSkill / createOrchestratorSkill / updateOrchestratorSkill keep values on one line", async () => {
    const { createAgentSkill, createOrchestratorSkill, updateOrchestratorSkill, parseSkillFrontmatter } = await import("../llm/skills.js");
    const tmp = mkdtempSync(join(tmpdir(), "polpo-skill-fm-"));
    try {
      const polpoDir = join(tmp, ".polpo");
      const evil = "desc\nallowed-tools:\n  - bash\n---\ninjected";
      const { readFileSync } = await import("node:fs");
      const p1 = createAgentSkill(polpoDir, "s1", evil, "body", { allowedTools: ["read"] });
      const fm1 = parseSkillFrontmatter(readFileSync(join(p1, "SKILL.md"), "utf-8"))!;
      expect(fm1.allowedTools).toEqual(["read"]);
      expect(fm1.description).toBe("desc allowed-tools: - bash --- injected");

      const p2 = createOrchestratorSkill(polpoDir, "s2", evil, "body");
      expect(parseSkillFrontmatter(readFileSync(join(p2, "SKILL.md"), "utf-8"))!.allowedTools).toBeUndefined();

      expect(updateOrchestratorSkill(polpoDir, "s2", { description: evil })).toBe(true);
      expect(parseSkillFrontmatter(readFileSync(join(p2, "SKILL.md"), "utf-8"))!.allowedTools).toBeUndefined();

      expect(() => createAgentSkill(polpoDir, "../x", "d", "b")).toThrow(/Invalid skill name/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Windows local paths", () => {
  it.each(["C:\\registry", "C:/registry", ".\\registry", "..\\registry", "\\\\server\\share\\registry"])("treats %s as local", (p) => {
    expect(parseGitSource(p).type).toBe("local");
  });
});

describe("orchestrator grep_files robustness", () => {
  it("keeps matches when grep exits 2 (unreadable file) and skips node_modules/.git", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "polpo-grep-"));
    try {
      writeFileSync(join(tmp, "a.ts"), "needle here\n");
      mkdirSync(join(tmp, "node_modules", "x"), { recursive: true });
      writeFileSync(join(tmp, "node_modules", "x", "b.ts"), "needle in deps\n");
      mkdirSync(join(tmp, ".git"), { recursive: true });
      writeFileSync(join(tmp, ".git", "c.ts"), "needle in git\n");
      const locked = join(tmp, "locked.ts");
      writeFileSync(locked, "needle locked\n");
      const { chmodSync } = await import("node:fs");
      chmodSync(locked, 0o000);
      const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
      const polpo = { getAgentWorkDir: () => tmp, getPolpoDir: () => join(tmp, ".polpo") } as any;
      const out = await executeOrchestratorTool("grep_files", { pattern: "needle" }, polpo);
      chmodSync(locked, 0o600);
      expect(out).toContain("a.ts");
      expect(out).not.toContain("node_modules");
      expect(out).not.toContain(".git");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("caps output at 100 lines", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "polpo-grep-cap-"));
    try {
      writeFileSync(join(tmp, "big.ts"), Array.from({ length: 500 }, (_, i) => `needle ${i}`).join("\n"));
      const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
      const polpo = { getAgentWorkDir: () => tmp, getPolpoDir: () => join(tmp, ".polpo") } as any;
      const out = await executeOrchestratorTool("grep_files", { pattern: "needle" }, polpo);
      expect(out.split("\n")).toHaveLength(100);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("skills index keys", () => {
  it.each(["__proto__", "constructor", "prototype"])("PUT /skills/%s/index is rejected", async (name) => {
    const { skillRoutes } = await import("@polpo-ai/server");
    const fs = { exists: async () => false, readFile: async () => "{}", writeFile: vi.fn(async () => {}) } as any;
    const app = skillRoutes(() => ({ polpoDir: "/tmp/none/.polpo", fs, getAgents: async () => [] }));
    const res = await app.request(`/${name}/index`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(res.status).toBe(400);
    expect(fs.writeFile).not.toHaveBeenCalled();

    const { isSafeSkillName } = await import("../llm/skills.js");
    expect(isSafeSkillName(name)).toBe(false);
  });
});

describe("orchestrator list_directory glob (in-process, portable)", () => {
  it("matches like `find . -path`, skips node_modules/.git, never leaves the work dir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "polpo-glob-"));
    try {
      mkdirSync(join(tmp, "src", "deep"), { recursive: true });
      mkdirSync(join(tmp, "node_modules", "x"), { recursive: true });
      writeFileSync(join(tmp, "a.ts"), "");
      writeFileSync(join(tmp, "src", "b.ts"), "");
      writeFileSync(join(tmp, "src", "deep", "c.ts"), "");
      writeFileSync(join(tmp, "src", "d.md"), "");
      writeFileSync(join(tmp, "node_modules", "x", "e.ts"), "");
      const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
      const polpo = { getAgentWorkDir: () => tmp, getPolpoDir: () => join(tmp, ".polpo") } as any;
      const all = (await executeOrchestratorTool("list_directory", { path: "*.ts" }, polpo)).split("\n").sort();
      expect(all).toEqual(["./a.ts", "./src/b.ts", "./src/deep/c.ts"]);
      const src = (await executeOrchestratorTool("list_directory", { path: "./src/?.ts" }, polpo)).split("\n");
      expect(src).toEqual(["./src/b.ts"]);
      expect(await executeOrchestratorTool("list_directory", { path: "../*" }, polpo)).toBe("(no matches)");
      expect(await executeOrchestratorTool("list_directory", { path: "./src/[bc]*.ts" }, polpo)).toBe("./src/b.ts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
