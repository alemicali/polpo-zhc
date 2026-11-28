/**
 * Skill lifecycle (like agents'): draft vs production, publish with semver bump and note, rollback,
 * discard and rebase of the draft, external changes (files edited on disk) as a pending draft, the
 * runtime loading production, migration of histories from before semver, events, and the REST + MCP
 * surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSkill, getSkillByName, loadAgentSkills, updateAgentSkill, updateOrchestratorSkill, createOrchestratorSkill, removeSkill,
  loadOrchestratorSkills,
} from "../llm/skills.js";
import {
  diffSkillRefs, discardSkillDraft, ensureSkillVersioning, listSkillVersions, migrateSkillVersions, onSkillLifecycle, productionSkillFolder,
  publishSkillDraft, rebaseSkillDraft, restoreSkillVersion, rollbackSkill, runtimeSkillDir, skillVersionState, skillVersionsDir,
  type SkillLifecycleNotice,
} from "../llm/skill-versions.js";
import { skillRoutes } from "../server/routes/skills.js";
import { handleMcpRequest, type ApiResponse, type McpDeps } from "../server/mcp.js";
import { expectValidOutput } from "./helpers/mcp-output.js";

const skillMd = (name: string, body = "Do the thing.", description = `Does ${name} things.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

let tmp: string;
let home: string;
let polpoDir: string;
let workDir: string;
const prevHome = process.env.HOME;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "polpo-skill-lifecycle-"));
  home = join(tmp, "home");
  mkdirSync(home);
  process.env.HOME = home;
  workDir = join(tmp, "project");
  polpoDir = join(workDir, ".polpo");
  mkdirSync(polpoDir, { recursive: true });
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

const ref = (name: string) => ({ pool: "agent" as const, name });
const skillFile = (name: string) => join(polpoDir, "skills", name, "SKILL.md");
/** What an agent with this skill gets in its prompt. */
const runtimeBody = (name: string) => loadAgentSkills(workDir, polpoDir, "dev", [name])[0]?.content;

describe("draft vs production", () => {
  it("a new skill is 1.0.0 in production; draft edits never reach agents until published", () => {
    createAgentSkill(polpoDir, "alpha", "First.", "Version one.", { author: "person:ada@example.com" });
    let st = skillVersionState(polpoDir, ref("alpha"))!;
    expect(st.production).toMatchObject({ semver: "1.0.0", author: "person:ada@example.com" });
    expect(st.draft.hasChanges).toBe(false);
    expect(existsSync(join(productionSkillFolder(polpoDir, ref("alpha")), "SKILL.md"))).toBe(true);
    expect(runtimeBody("alpha")).toBe("Version one.");

    // a dashboard edit: only the draft changes
    updateAgentSkill(polpoDir, "alpha", { content: "Version two." }, false, "person:bob@example.com", { mode: "draft" });
    expect(readFileSync(skillFile("alpha"), "utf8")).toContain("Version two.");
    expect(runtimeBody("alpha")).toBe("Version one.");
    expect(getSkillByName(workDir, polpoDir, "alpha")!.content).toBe("Version one.");
    expect(getSkillByName(workDir, polpoDir, "alpha", "agent", "draft")!.content).toBe("Version two.");
    st = skillVersionState(polpoDir, ref("alpha"))!;
    expect(st.draft).toMatchObject({
      hasChanges: true, external: false, stale: false, baseVersion: "1.0.0", updatedBy: "person:bob@example.com",
      changes: [{ path: "SKILL.md", status: "changed" }], suggestedBump: "patch", nextVersion: "1.0.1",
    });

    // publish with a note: production moves, agents get it
    const v = publishSkillDraft(polpoDir, ref("alpha"), { actor: "person:ada@example.com", note: "Clearer steps" });
    expect(v).toMatchObject({ semver: "1.0.1", previous: "1.0.0", note: "Clearer steps", author: "person:ada@example.com", source: "publish" });
    expect(runtimeBody("alpha")).toBe("Version two.");
    expect(skillVersionState(polpoDir, ref("alpha"))!.draft.hasChanges).toBe(false);
    expect(() => publishSkillDraft(polpoDir, ref("alpha"), { actor: "x" })).toThrow(/no draft changes/);
  });

  it("bumps: suggested (description → minor, removed file → major), explicit bump and version", () => {
    createAgentSkill(polpoDir, "b", "One.", "Body.");
    updateAgentSkill(polpoDir, "b", { description: "Two." }, false, "x", { mode: "draft" });
    expect(skillVersionState(polpoDir, ref("b"))!.draft.suggestedBump).toBe("minor");
    expect(publishSkillDraft(polpoDir, ref("b"), { actor: "x" }).semver).toBe("1.1.0");
    writeFileSync(join(polpoDir, "skills", "b", "extra.md"), "x");
    expect(publishSkillDraft(polpoDir, ref("b"), { actor: "x", bump: "patch" }).semver).toBe("1.1.1");
    rmSync(join(polpoDir, "skills", "b", "extra.md"));
    expect(skillVersionState(polpoDir, ref("b"))!.draft.suggestedBump).toBe("major");
    expect(() => publishSkillDraft(polpoDir, ref("b"), { actor: "x", version: "1.0.5" })).toThrow(/above the latest/);
    expect(publishSkillDraft(polpoDir, ref("b"), { actor: "x", version: "3.0.0" })).toMatchObject({ semver: "3.0.0", bump: "custom" });
  });

  it("direct mode (the default for API callers) publishes at once, noted \"Applied directly\"", () => {
    createAgentSkill(polpoDir, "d", "D.", "one");
    updateAgentSkill(polpoDir, "d", { content: "two" }, false, "mcp:Claude");
    const h = listSkillVersions(polpoDir, ref("d"))!;
    expect(h.versions[0]).toMatchObject({ semver: "1.0.1", note: "Applied directly", author: "mcp:Claude" });
    expect(h.events?.[0]).toMatchObject({ action: "publish", from: "1.0.0", to: "1.0.1", actor: "mcp:Claude", direct: true });
    expect(runtimeBody("d")).toBe("two");
  });
});

describe("external changes", () => {
  it("files edited on disk are a pending draft (external), not production; publish or discard them", () => {
    createAgentSkill(polpoDir, "ext", "E.", "original");
    writeFileSync(skillFile("ext"), skillMd("ext", "hand-edited", "E."));
    writeFileSync(join(polpoDir, "skills", "ext", "notes.md"), "mine");
    expect(runtimeBody("ext")).toBe("original");
    const st = skillVersionState(polpoDir, ref("ext"))!;
    expect(st.draft).toMatchObject({ hasChanges: true, external: true, stale: false, suggestedBump: "minor" });
    expect(st.draft.changes).toEqual([{ path: "SKILL.md", status: "changed" }, { path: "notes.md", status: "added" }]);
    const d = diffSkillRefs(polpoDir, ref("ext"), "production", "draft");
    expect(d).toMatchObject({ from: "1.0.0", to: "draft", summary: { added: 1, changed: 1, removed: 0 } });

    // discard: back to production's files
    expect(discardSkillDraft(polpoDir, ref("ext"), "person:ada@example.com")).toBe(true);
    expect(readFileSync(skillFile("ext"), "utf8")).toContain("original");
    expect(existsSync(join(polpoDir, "skills", "ext", "notes.md"))).toBe(false);
    expect(skillVersionState(polpoDir, ref("ext"))!.draft.hasChanges).toBe(false);

    // edited again on disk, then published: flagged external
    writeFileSync(skillFile("ext"), skillMd("ext", "hand-edited again", "E."));
    const v = publishSkillDraft(polpoDir, ref("ext"), { actor: "person:ada@example.com" });
    expect(v).toMatchObject({ semver: "1.0.1", external: true });
    expect(runtimeBody("ext")).toBe("hand-edited again");
  });

  it("a Polpo draft edited further on disk is external too", () => {
    createAgentSkill(polpoDir, "mix", "M.", "one");
    updateAgentSkill(polpoDir, "mix", { content: "two" }, false, "person:ada@example.com", { mode: "draft" });
    expect(skillVersionState(polpoDir, ref("mix"))!.draft.external).toBe(false);
    writeFileSync(join(polpoDir, "skills", "mix", "more.md"), "x");
    expect(skillVersionState(polpoDir, ref("mix"))!.draft.external).toBe(true);
  });
});

describe("rollback", () => {
  it("production goes back (repeated rollbacks walk back); the folder follows when there is no draft", () => {
    createAgentSkill(polpoDir, "r", "R.", "one");
    updateAgentSkill(polpoDir, "r", { content: "two" });
    updateAgentSkill(polpoDir, "r", { content: "three" });
    expect(runtimeBody("r")).toBe("three");
    const back = rollbackSkill(polpoDir, ref("r"), { actor: "person:ada@example.com", note: "regression" });
    expect(back).toMatchObject({ from: "1.0.2", to: { semver: "1.0.1" }, folderReset: true });
    expect(runtimeBody("r")).toBe("two");
    expect(readFileSync(skillFile("r"), "utf8")).toContain("two");
    expect(skillVersionState(polpoDir, ref("r"))!.draft.hasChanges).toBe(false);
    expect(rollbackSkill(polpoDir, ref("r"), { actor: "x" }).to.semver).toBe("1.0.0");
    expect(runtimeBody("r")).toBe("one");
    // to a given version (semver or number)
    expect(rollbackSkill(polpoDir, ref("r"), { actor: "x", to: "1.0.2" }).to.semver).toBe("1.0.2");
    expect(rollbackSkill(polpoDir, ref("r"), { actor: "x", to: 2 }).to.semver).toBe("1.0.1");
    expect(() => rollbackSkill(polpoDir, ref("r"), { actor: "x", to: "1.0.1" })).toThrow(/already runs/);
    expect(() => rollbackSkill(polpoDir, ref("r"), { actor: "x", to: "9.9.9" })).toThrow(/no version/);
    const events = listSkillVersions(polpoDir, ref("r"))!.events!;
    expect(events[events.length - 1 - 3]).toMatchObject({ action: "rollback", from: "1.0.2", to: "1.0.1", actor: "person:ada@example.com", note: "regression" });
    // the next publish is numbered above the highest
    updateAgentSkill(polpoDir, "r", { content: "four" });
    expect(listSkillVersions(polpoDir, ref("r"))!.versions[0].semver).toBe("1.0.3");
  });

  it("a pending draft survives a rollback as stale: publish refused until rebased (file by file) or discarded", () => {
    createAgentSkill(polpoDir, "s", "S.", "one");
    writeFileSync(join(polpoDir, "skills", "s", "ref.md"), "v1");
    publishSkillDraft(polpoDir, ref("s"), { actor: "x" }); // 1.1.0: ref.md added
    updateAgentSkill(polpoDir, "s", { content: "two" }); // 1.1.1
    // a draft on 1.1.1: a new file
    writeFileSync(join(polpoDir, "skills", "s", "new.md"), "draft file");
    rollbackSkill(polpoDir, ref("s"), { actor: "x", to: "1.0.0" });
    const st = skillVersionState(polpoDir, ref("s"))!;
    expect(st.production?.semver).toBe("1.0.0");
    expect(st.draft).toMatchObject({ hasChanges: true, stale: true, baseVersion: "1.1.1" });
    expect(st.draft.warning).toMatch(/based on 1\.1\.1, production is now 1\.0\.0/);
    expect(() => publishSkillDraft(polpoDir, ref("s"), { actor: "x" })).toThrow(/rebase it onto production/);
    expect(() => updateAgentSkill(polpoDir, "s", { content: "x" })).toThrow(/rebase/);
    // rebase: the draft keeps the file it added; the rest becomes production's (1.0.0)
    const r = rebaseSkillDraft(polpoDir, ref("s"), "person:ada@example.com");
    expect(r).toMatchObject({ dropped: false, from: "1.1.1", to: "1.0.0" });
    expect(readFileSync(skillFile("s"), "utf8")).toContain("one");
    expect(existsSync(join(polpoDir, "skills", "s", "ref.md"))).toBe(false);
    expect(readFileSync(join(polpoDir, "skills", "s", "new.md"), "utf8")).toBe("draft file");
    expect(skillVersionState(polpoDir, ref("s"))!.draft).toMatchObject({ stale: false, changes: [{ path: "new.md", status: "added" }] });
    expect(publishSkillDraft(polpoDir, ref("s"), { actor: "x" }).semver).toBe("1.2.0");
  });
});

describe("restore", () => {
  it("draft mode restores into the draft; publish mode makes a new version", () => {
    createAgentSkill(polpoDir, "rs", "R.", "one");
    updateAgentSkill(polpoDir, "rs", { content: "two" });
    const r = restoreSkillVersion(polpoDir, ref("rs"), "1.0.0", "person:ada@example.com", { mode: "draft" });
    expect(r).toMatchObject({ restoredFrom: 1, draft: true });
    expect(r.published).toBeUndefined();
    expect(runtimeBody("rs")).toBe("two");
    expect(skillVersionState(polpoDir, ref("rs"))!.draft).toMatchObject({ hasChanges: true, source: "restore", restoredFrom: 1 });
    const p = restoreSkillVersion(polpoDir, ref("rs"), 1, "person:ada@example.com", { mode: "publish" });
    expect(p.published).toMatchObject({ semver: "1.0.2", source: "restore", restoredFrom: 1, note: "Restored 1.0.0" });
    expect(runtimeBody("rs")).toBe("one");
  });
});

describe("runtime resolution", () => {
  it("agents with a skills folder (symlinks), the orchestrator pool and global skills all load production", () => {
    createAgentSkill(polpoDir, "linked", "L.", "prod body");
    const linkDir = join(polpoDir, "agents", "dev", "skills");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(polpoDir, "skills", "linked"), join(linkDir, "linked"));
    updateAgentSkill(polpoDir, "linked", { content: "draft body", description: "Draft desc." }, false, "x", { mode: "draft" });
    const [s] = loadAgentSkills(workDir, polpoDir, "dev");
    expect(s).toMatchObject({ content: "prod body", description: "L." });
    expect(s.dir).toBe(productionSkillFolder(polpoDir, ref("linked")));
    expect(runtimeSkillDir(join(linkDir, "linked"))).toBe(productionSkillFolder(polpoDir, ref("linked")));

    createOrchestratorSkill(polpoDir, "helper", "H.", "polpo prod");
    updateOrchestratorSkill(polpoDir, "helper", { content: "polpo draft" }, false, "x", { mode: "draft" });
    expect(loadOrchestratorSkills(polpoDir).find((x) => x.name === "helper")?.content).toBe("polpo prod");

    createAgentSkill(polpoDir, "glob", "G.", "global prod", { global: true });
    updateAgentSkill(polpoDir, "glob", { content: "global draft" }, true, "x", { mode: "draft" });
    expect(loadAgentSkills(workDir, polpoDir, "other-agent", ["glob"])[0]?.content).toBe("global prod");
    expect(existsSync(join(home, ".polpo", "skills", ".production", "glob", "SKILL.md"))).toBe(true);
  });

  it("a skill not yet under versioning loads from its folder; .production is never a skill", () => {
    const dir = join(polpoDir, "skills", "fresh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd("fresh", "as dropped"));
    expect(runtimeBody("fresh")).toBe("as dropped");
    createAgentSkill(polpoDir, "other", "O.", "x");
    expect(loadAgentSkills(workDir, polpoDir, "dev", [".production"])).toEqual([]);
    expect(() => createAgentSkill(polpoDir, ".production", "bad", "x")).toThrow();
  });
});

describe("migration", () => {
  it("a history from before semver: the folder as it ran becomes 1.0.0 in production, older versions 0.0.n", () => {
    // a schema-1 history: versions 1 and 2, the folder changed on disk since
    const hist = skillVersionsDir(polpoDir, ref("old"));
    for (const n of [1, 2]) {
      mkdirSync(join(hist, String(n)), { recursive: true });
      writeFileSync(join(hist, String(n), "SKILL.md"), skillMd("old", `v${n}`));
    }
    writeFileSync(join(hist, "index.json"), JSON.stringify({
      skill: "old", pool: "agent", scope: "project", next: 3,
      versions: [1, 2].map((n) => ({ version: n, createdAt: "2026-01-0" + n + "T00:00:00.000Z", author: "cli", source: "edit", files: 1, totalBytes: 10, hash: `h${n}` })),
    }));
    mkdirSync(join(polpoDir, "skills", "old"), { recursive: true });
    writeFileSync(skillFile("old"), skillMd("old", "edited on disk before the upgrade"));
    // and a skill with no history at all
    mkdirSync(join(polpoDir, "skills", "bare"), { recursive: true });
    writeFileSync(skillFile("bare"), skillMd("bare", "bare"));

    expect(migrateSkillVersions(polpoDir).sort()).toEqual(["bare", "old"]);
    const h = listSkillVersions(polpoDir, ref("old"))!;
    expect(h.versions.map((v) => [v.version, v.semver, v.source])).toEqual([[3, "1.0.0", "external"], [2, "0.0.2", "edit"], [1, "0.0.1", "edit"]]);
    expect(h.current).toBe(3);
    expect(h.events?.[0]).toMatchObject({ action: "migration", to: "1.0.0", actor: "system:migration" });
    // agents keep running what they ran
    expect(runtimeBody("old")).toBe("edited on disk before the upgrade");
    expect(skillVersionState(polpoDir, ref("old"))!.draft.hasChanges).toBe(false);
    expect(listSkillVersions(polpoDir, ref("bare"))!.versions[0]).toMatchObject({ semver: "1.0.0", bump: "initial" });
    // idempotent
    expect(migrateSkillVersions(polpoDir)).toEqual([]);
    expect(listSkillVersions(polpoDir, ref("old"))!.versions).toHaveLength(3);
    // a rollback to a migrated older version works
    expect(rollbackSkill(polpoDir, ref("old"), { actor: "x", to: "0.0.1" }).to.version).toBe(1);
    expect(runtimeBody("old")).toBe("v1");
  });

  it("production's copy is re-materialised when missing", () => {
    createAgentSkill(polpoDir, "m", "M.", "body");
    rmSync(productionSkillFolder(polpoDir, ref("m")), { recursive: true, force: true });
    ensureSkillVersioning(polpoDir, ref("m"));
    expect(runtimeBody("m")).toBe("body");
  });
});

describe("delete", () => {
  it("deleting a skill removes production's copy; restoring brings both back", () => {
    createAgentSkill(polpoDir, "gone", "G.", "kept");
    removeSkill(polpoDir, "gone");
    expect(existsSync(productionSkillFolder(polpoDir, ref("gone")))).toBe(false);
    restoreSkillVersion(polpoDir, ref("gone"), "1.0.0", "x", { mode: "draft" }); // a deleted skill is always published
    expect(runtimeBody("gone")).toBe("kept");
    expect(skillVersionState(polpoDir, ref("gone"))!.production?.semver).toBe("1.0.0");
  });
});

describe("events", () => {
  it("publishes and rollbacks notify listeners (the server's skill:published / skill:rolled-back)", () => {
    const seen: SkillLifecycleNotice[] = [];
    const off = onSkillLifecycle((n) => seen.push(n));
    try {
      createAgentSkill(polpoDir, "ev", "E.", "one", { author: "person:ada@example.com" });
      updateAgentSkill(polpoDir, "ev", { content: "two" }, false, "coach", { mode: "draft" });
      publishSkillDraft(polpoDir, ref("ev"), { actor: "person:ada@example.com", note: "n" });
      rollbackSkill(polpoDir, ref("ev"), { actor: "person:bob@example.com" });
    } finally { off(); }
    expect(seen.map((n) => [n.action, n.version.semver, n.from, n.event.actor])).toEqual([
      ["published", "1.0.0", undefined, "person:ada@example.com"],
      ["published", "1.0.1", "1.0.0", "person:ada@example.com"],
      ["rolled-back", "1.0.0", "1.0.1", "person:bob@example.com"],
    ]);
  });
});

describe("REST", () => {
  const app = (autoPublish = true) => {
    const emit = vi.fn();
    return {
      emit,
      app: skillRoutes(() => ({ polpoDir, workDir, getAgents: async () => [{ name: "dev" }], emit, author: () => "person:ada@example.com", autoPublish: () => autoPublish })),
    };
  };
  const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  it("PUT publish flag and setting; versioning, publish, diff, rollback, discard, rebase; content views", async () => {
    const { app: a, emit } = app(false);
    expect((await a.request("/create", send("POST", { name: "alpha", description: "A.", content: "one" }))).status).toBe(201);
    // the setting off: an update without publish is a draft
    let r = await (await a.request("/alpha", send("PUT", { content: "two" }))).json() as any;
    expect(r.data.versioning).toMatchObject({ mode: "draft", production: { semver: "1.0.0" }, draft: { hasChanges: true, nextVersion: "1.0.1" } });
    expect((await (await a.request("/alpha/content")).json() as any).data).toMatchObject({ content: "one", view: "production", versioning: { draft: { hasChanges: true } } });
    expect((await (await a.request("/alpha/content?view=draft")).json() as any).data.content).toBe("two");
    const diff = await (await a.request("/alpha/diff")).json() as any;
    expect(diff.data).toMatchObject({ from: "1.0.0", to: "draft", files: [{ path: "SKILL.md", status: "changed", additions: 1, deletions: 1 }] });
    const pub = await (await a.request("/alpha/publish", send("POST", { bump: "minor", note: "Better" }))).json() as any;
    expect(pub.data.version).toMatchObject({ semver: "1.1.0", note: "Better", author: "person:ada@example.com" });
    expect((await a.request("/alpha/publish", send("POST", {}))).status).toBe(400);
    // publish: true → published at once
    r = await (await a.request("/alpha", send("PUT", { content: "three", publish: true, note: "direct" }))).json() as any;
    expect(r.data.versioning).toMatchObject({ mode: "publish", production: { semver: "1.1.1" } });
    const list = await (await a.request("/alpha/versions")).json() as any;
    expect(list.data).toMatchObject({ production: "1.1.1", latest: "1.1.1", current: 3, state: { draft: { hasChanges: false } } });
    expect(list.data.events[0]).toMatchObject({ action: "publish", to: "1.1.1", actor: "person:ada@example.com" });
    // version files by semver, diff by semver
    expect((await (await a.request("/alpha/versions/1.0.0/files")).json() as any).data.version.version).toBe(1);
    expect((await (await a.request("/alpha/versions/1.0.0/diff/1.1.0")).json() as any).data).toMatchObject({ from: "1.0.0", to: "1.1.0" });
    // draft, then rollback: stale → 409, rebase, discard
    await a.request("/alpha", send("PUT", { content: "four", publish: false }));
    const rb = await (await a.request("/alpha/rollback", send("POST", { to: "1.0.0", note: "oops" }))).json() as any;
    expect(rb.data).toMatchObject({ from: "1.1.1", to: { semver: "1.0.0" }, folderReset: false, state: { draft: { stale: true } } });
    expect((await a.request("/alpha/publish", send("POST", {}))).status).toBe(409);
    const rebased = await (await a.request("/alpha/draft/rebase", send("POST"))).json() as any;
    expect(rebased.data).toMatchObject({ dropped: false, from: "1.1.1", to: "1.0.0", state: { draft: { stale: false } } });
    const discarded = await (await a.request("/alpha/draft", send("DELETE"))).json() as any;
    expect(discarded.data).toMatchObject({ discarded: true, state: { draft: { hasChanges: false } } });
    expect((await (await a.request("/alpha/versioning")).json() as any).data).toMatchObject({ production: { semver: "1.0.0" }, latest: "1.1.1" });
    // restore with publish: false → the draft
    const rs = await (await a.request("/alpha/versions/1.1.1/restore", send("POST", { publish: false }))).json() as any;
    expect(rs.data).toMatchObject({ mode: "draft", draft: true, restoredFrom: 3 });
    expect(emit).toHaveBeenCalledWith("skill:changed", expect.objectContaining({ skillName: "alpha" }));
    // orchestrator pool
    await a.request("/orchestrator", send("POST", { name: "helper", description: "H.", content: "one" }));
    r = await (await a.request("/orchestrator/helper", send("PUT", { content: "two" }))).json() as any;
    expect(r.data.versioning).toMatchObject({ mode: "draft" });
    expect((await (await a.request("/orchestrator/helper/publish", send("POST", {}))).json() as any).data.version.semver).toBe("1.0.1");
  });

  it("the setting on (default): API updates publish at once", async () => {
    const { app: a } = app(true);
    await a.request("/create", send("POST", { name: "beta", description: "B.", content: "one" }));
    const r = await (await a.request("/beta", send("PUT", { content: "two" }))).json() as any;
    expect(r.data.versioning).toMatchObject({ mode: "publish", production: { semver: "1.0.1" } });
  });
});

describe("MCP", () => {
  const mcp = () => {
    const app = skillRoutes(() => ({ polpoDir, workDir, getAgents: async () => [{ name: "dev" }], emit: () => undefined, author: () => "mcp:Claude" }));
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
    return { call };
  };

  it("update to the draft, draft show, diff, publish, rollback (confirm), discard (confirm)", async () => {
    const { call } = mcp();
    await call("polpo_skill_create", { name: "alpha", description: "A.", content: "one" });
    const upd = await call("polpo_skill_update", { name: "alpha", content: "two", publish: false });
    expect(upd.structuredContent).toMatchObject({ mode: "draft", production: "1.0.0", draft: { has_changes: true, next_version: "1.0.1" } });
    expect(upd.content[0].text).toContain("Saved in the draft");
    const show = await call("polpo_skill_draft", { name: "alpha" });
    expect(show.structuredContent).toMatchObject({ action: "show", production: "1.0.0", draft: { has_changes: true, external: false } });
    const diff = await call("polpo_skill_version_diff", { name: "alpha" });
    expect(diff.structuredContent).toMatchObject({ from: "1.0.0", to: "draft" });
    expect(diff.structuredContent.diff).toContain("-one\n+two");
    const pub = await call("polpo_skill_publish", { name: "alpha", note: "Better" });
    expect(pub.structuredContent).toMatchObject({ version: "1.0.1", previous: "1.0.0", production: "1.0.1" });
    const versions = await call("polpo_skill_versions", { name: "alpha" });
    expect(versions.structuredContent).toMatchObject({ production: "1.0.1", current: 2 });
    expect(versions.structuredContent.versions[0]).toMatchObject({ semver: "1.0.1", note: "Better", current: true });
    expect((await call("polpo_skill_rollback", { name: "alpha" })).isError).toBe(true);
    const rb = await call("polpo_skill_rollback", { name: "alpha", confirm: true });
    expect(rb.structuredContent).toMatchObject({ to: "1.0.0", from: "1.0.1", draft_kept: false });
    writeFileSync(skillFile("alpha"), skillMd("alpha", "on disk", "A."));
    const ext = await call("polpo_skill_draft", { name: "alpha" });
    expect(ext.structuredContent.draft).toMatchObject({ has_changes: true, external: true });
    expect(ext.content[0].text).toContain("outside Polpo");
    expect((await call("polpo_skill_draft", { name: "alpha", action: "discard" })).isError).toBe(true);
    const disc = await call("polpo_skill_draft", { name: "alpha", action: "discard", confirm: true });
    expect(disc.structuredContent).toMatchObject({ discarded: true, production: "1.0.0" });
    const got = await call("polpo_skill_get", { name: "alpha" });
    expect(got.structuredContent.skill).toMatchObject({ production: "1.0.0" });
  });
});
