/**
 * Skill versions in the dashboard, a lifecycle like an agent's: the header badges (production,
 * "Draft has changes" / "Draft out of date"); the Versions tab with the draft (changed files, external
 * changes, its diff from production, publish dialog with bump + note, discard, stale warning with
 * rebase/discard), production (rollback, confirmed), the versions (semver, production badge, author,
 * source, note, download, compare two, roll back to one, restore one into the draft), the history;
 * a version's files read-only in the same file browser; a deleted skill restorable from its page;
 * the setting in Configuration; and the desktop layout whose left column is sticky.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const VERSIONS = [
  { version: 3, semver: "1.1.0", createdAt: "2026-11-20T10:00:00.000Z", author: "mcp:Claude", source: "publish", files: 3, totalBytes: 3000, hash: "c", description: "Alpha v3", note: "New API docs", bump: "minor" },
  { version: 2, semver: "1.0.1", createdAt: "2026-11-19T10:00:00.000Z", author: "person:ada@example.com", source: "external", files: 2, totalBytes: 2048, hash: "b", external: true, bump: "patch" },
  { version: 1, createdAt: "2026-11-18T10:00:00.000Z", author: "cli", source: "git", files: 1, totalBytes: 100, hash: "a" },
];
const EVENTS = [
  { id: "e3", action: "publish", from: "1.0.1", fromVersion: 2, to: "1.1.0", toVersion: 3, actor: "mcp:Claude", at: "2026-11-20T10:00:00.000Z", note: "New API docs", direct: true },
  { id: "e2", action: "publish", from: "1.0.0", fromVersion: 1, to: "1.0.1", toVersion: 2, actor: "person:ada@example.com", at: "2026-11-19T10:00:00.000Z" },
  { id: "e1", action: "migration", to: "1.0.0", toVersion: 1, actor: "system:migration", at: "2026-11-18T10:00:00.000Z" },
];
const DIFF = {
  skill: "alpha", from: "v1", to: "1.1.0", a: VERSIONS[2], b: VERSIONS[0], unchanged: 1, summary: { added: 1, removed: 0, changed: 2 },
  files: [
    { path: "SKILL.md", status: "changed", additions: 1, deletions: 1, diff: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,2 +1,2 @@\n # Alpha\n-old line\n+new line\n" },
    { path: "assets/logo.png", status: "changed", binary: true, sizeA: 10, sizeB: 12 },
    { path: "references/api.md", status: "added", additions: 1, deletions: 0, diff: "--- /dev/null\n+++ b/references/api.md\n@@ -0,0 +1,1 @@\n+# API\n" },
  ],
};
const DRAFT_DIFF = {
  skill: "alpha", from: "1.1.0", to: "draft", unchanged: 2, summary: { added: 1, removed: 0, changed: 0 },
  files: [{ path: "notes.md", status: "added", additions: 1, deletions: 0, diff: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,1 @@\n+draft note\n" }],
};
const state = { deleted: false, hasChanges: true, external: false, stale: false };
const draftState = () => ({
  skill: "alpha", pool: "agent", scope: "project", latest: "1.1.0", versions: 3,
  production: { version: 3, semver: "1.1.0", createdAt: "2026-11-20T10:00:00.000Z", author: "mcp:Claude", note: "New API docs" },
  draft: {
    exists: state.hasChanges, hasChanges: state.hasChanges, external: state.external, stale: state.stale,
    baseVersion: state.stale ? "1.2.0" : "1.1.0",
    ...(state.stale ? { warning: "alpha's draft is based on 1.2.0, production is now 1.1.0" } : {}),
    updatedAt: "2026-11-21T10:00:00.000Z", updatedBy: "person:ada@example.com",
    changes: state.hasChanges ? [{ path: "notes.md", status: "added" }] : [],
    suggestedBump: "minor", nextVersion: "1.2.0",
  },
});
const restore = vi.fn(async (n: number, opts?: { publish?: boolean }) => ({ name: "alpha", restoredFrom: n, mode: opts?.publish === false ? "draft" : "publish", draft: !state.deleted, ...(state.deleted ? { published: "1.1.1" } : {}) }));
const diff = vi.fn(async (a: number | string, b: number | string) => (a === "production" && b === "draft" ? DRAFT_DIFF : DIFF));
const publish = vi.fn(async (_opts?: unknown) => ({ name: "alpha", version: { ...VERSIONS[0], version: 4, semver: "1.2.0" } }));
const rollback = vi.fn(async (_opts?: unknown) => ({ name: "alpha", from: "1.1.0", to: VERSIONS[1], folderReset: false, event: EVENTS[0] }));
const discardDraft = vi.fn(async () => true);
const rebaseDraft = vi.fn(async () => ({ dropped: false }));
const versionFiles = vi.fn(async (n: number) => ({ name: "alpha", version: VERSIONS.find((v) => v.version === n), files: [{ path: "SKILL.md", size: 50 }, { path: "old.md", size: 5 }], totalBytes: 55, truncated: false }));
const client = {
  getSkillContent: vi.fn(async (_name: string, _opts?: unknown) => ({ name: "alpha", description: "Does alpha", source: "project", path: "/p/.polpo/skills/alpha", content: "# Alpha now" })),
  getOrchestratorSkillContent: vi.fn(async () => { throw new Error("nope"); }),
  getSkillFileText: vi.fn(async () => "---\nname: alpha\n---\n# Alpha now"),
  getSkillVersionFileText: vi.fn(async (_name: string, version: number, path: string) => (path === "SKILL.md" ? `---\nname: alpha\n---\n# Alpha at v${version}` : "old notes")),
};

vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client }),
  useSkills: () => ({ skills: state.deleted ? [] : [{ name: "alpha", description: "Does alpha", source: "project", path: "/p/.polpo/skills/alpha", assignedTo: [] }], isLoading: false }),
  useOrchestratorSkills: () => ({ skills: [], isLoading: false }),
  useAgents: () => ({ agents: [], teams: [] }),
  useSkillFiles: (name: string) => ({
    data: { name, source: "project", files: [{ path: "SKILL.md", size: 60 }], truncated: false, totalBytes: 60 },
    isLoading: false, error: null, refetch: async () => undefined,
    fileUrl: (path: string) => `/api/v1/skills/${name}/files/${path}`,
    downloadUrl: () => `/api/v1/skills/${name}/download`,
  }),
  useSkillVersions: (name: string) => {
    const s = state.deleted ? undefined : draftState();
    return {
      data: {
        name, pool: "agent", scope: "project", versions: VERSIONS,
        ...(state.deleted ? { deletedAt: "2026-11-21T10:00:00.000Z", deletedBy: "person:ada@example.com" } : { current: 3, production: "1.1.0", latest: "1.1.0", state: s, events: EVENTS }),
        retention: { maxVersions: 20, maxBytes: 50 * 1024 * 1024, deletedDays: 30 },
      },
      state: s,
      isLoading: false, error: null, refetch: async () => undefined,
      files: versionFiles, diff, restore, publish, rollback, discardDraft, rebaseDraft,
      fileUrl: (v: number, path: string, opts?: { download?: boolean }) => `/api/v1/skills/${name}/versions/${v}/files/${path}${opts?.download ? "?download=1" : ""}`,
      readText: async () => "",
      downloadUrl: (v: number) => `/api/v1/skills/${name}/versions/${v}/download`,
    };
  },
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("@/components/shared/agent-avatar", () => ({ AgentAvatar: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { TooltipProvider } from "../src/components/ui/tooltip";
import { SkillDetailPage } from "../src/pages/skill-detail";
import { versionAuthor, versionEventLabel, versionLabel, versionSourceLabel } from "../src/lib/skill-versions";
import { SkillVersioningSetting } from "../src/components/config/skill-versioning-setting";

let container: HTMLDivElement;
let root: Root;
const where = { current: "" };
function Where() {
  const loc = useLocation();
  useEffect(() => { where.current = `${loc.pathname}${loc.search}`; });
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.assign(state, { deleted: false, hasChanges: true, external: false, stale: false });
  for (const f of [restore, diff, publish, rollback, discardDraft, rebaseDraft]) f.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.body.querySelectorAll(sel)] as HTMLElement[];
const byText = (text: string | RegExp, sel = "button, a") => [...document.body.querySelectorAll(sel)].find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) as HTMLElement | undefined;
const click = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await flush(); };
const dialogButton = (label: string) => [...q('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLElement;

async function renderPage(path: string) {
  await act(async () => root.render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/skills/:skillName" element={<><SkillDetailPage /><Where /></>} /></Routes>
      </MemoryRouter>
    </TooltipProvider>,
  ));
  await flush();
}

test("desktop layout: the left column is sticky with its own scroll, the file pane scrolls on its own", async () => {
  await renderPage("/skills/alpha");
  const scroll = q('[data-testid="skill-detail-scroll"]')!;
  expect(scroll.className).toContain("lg:overflow-hidden");
  expect(scroll.firstElementChild!.className).toMatch(/lg:grid-rows-1/);
  expect(scroll.firstElementChild!.className).toMatch(/lg:h-full/);
  const side = q('[data-testid="skill-detail-sidebar"]')!;
  for (const c of ["lg:sticky", "lg:top-0", "lg:self-start", "lg:max-h-full", "lg:overflow-y-auto"]) expect(side.className.split(/\s+/)).toContain(c);
  expect(side.querySelector('[role="tree"]')).toBeTruthy();
  const main = q('[data-testid="skill-detail-main"]')!;
  expect(main.className.split(/\s+/)).toContain("lg:overflow-y-auto");
  expect(main.querySelector('[data-testid="skill-file-view"]')).toBeTruthy();
  // mobile: one scroll (no lg: prefix on the overflow of the page)
  expect(scroll.className.split(/\s+/)).toContain("overflow-auto");
  // the files shown are the folder, i.e. the draft
  expect(client.getSkillContent).toHaveBeenCalledWith("alpha", { view: "draft" });
  expect(side.textContent).toContain("Files (draft)");
});

test("header: production version and the draft's state", async () => {
  await renderPage("/skills/alpha");
  expect(q('[data-testid="skill-version-badges"]')!.textContent).toBe("v1.1.0Draft has changes");
  await act(async () => root.unmount());
  root = createRoot(container);
  state.stale = true;
  await renderPage("/skills/alpha");
  expect(q('[data-testid="skill-version-badges"]')!.textContent).toBe("v1.1.0Draft out of date");
  await act(async () => root.unmount());
  root = createRoot(container);
  state.stale = false;
  state.hasChanges = false;
  await renderPage("/skills/alpha");
  expect(q('[data-testid="skill-version-badges"]')!.textContent).toBe("v1.1.0");
});

test("draft: changed files, external changes, the diff from production; publish with bump and note", async () => {
  state.external = true;
  await renderPage("/skills/alpha?tab=versions");
  const draft = q('[data-testid="skill-draft"]')!;
  expect(draft.textContent).toContain("Draft has changes");
  expect(draft.textContent).toContain("1 file changed");
  expect(draft.textContent).toContain("next 1.2.0 (minor)");
  expect(q('[data-testid="draft-external"]')!.textContent).toContain("External changes");
  const changes = qa('[data-testid="draft-changes"] li');
  expect(changes.map((c) => `${c.getAttribute("data-status")}:${c.getAttribute("data-change-path")}`)).toEqual(["added:notes.md"]);
  expect(diff).toHaveBeenCalledWith("production", "draft");
  const view = draft.querySelector('[data-testid="version-diff"]')!;
  expect(view.textContent).toContain("1.1.0 → draft");
  expect(view.querySelector('[data-line="add"]')!.textContent).toBe("+draft note");

  await click(q('[data-testid="open-publish"]'));
  const dialog = q('[data-testid="publish-dialog"]')!;
  expect(dialog.textContent).toContain("Publish version 1.2.0");
  expect(dialog.textContent).toContain("agents use it from their next run");
  expect(byText(/minor · suggested/, "button")?.getAttribute("data-state")).toBe("on");
  await click(byText(/^patch/, "button"));
  expect(q('[data-testid="publish-dialog"]')!.textContent).toContain("Publish version 1.1.1");
  await click(byText(/^major/, "button"));
  expect(q('[data-testid="publish-dialog"]')!.textContent).toContain("Publish version 2.0.0");
  const note = q('textarea[aria-label="Release note"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Notes file");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(q('[data-testid="publish-confirm"]'));
  expect(publish).toHaveBeenCalledWith({ bump: "major", note: "Notes file" });
  expect(q('[data-testid="publish-dialog"]')).toBeNull();
});

test("discard asks first", async () => {
  await renderPage("/skills/alpha?tab=versions");
  await click(q('[aria-label="Discard the draft"]'));
  expect(discardDraft).not.toHaveBeenCalled();
  expect(q('[role="dialog"]')!.textContent).toContain("Discard the draft?");
  await click(dialogButton("Discard"));
  expect(discardDraft).toHaveBeenCalled();
});

test("a stale draft (production rolled back): warning, rebase or discard, no publish", async () => {
  state.stale = true;
  await renderPage("/skills/alpha?tab=versions");
  const warning = q('[data-testid="draft-stale"]')!;
  expect(warning.textContent).toContain("alpha's draft is based on 1.2.0, production is now 1.1.0");
  expect((q('[data-testid="open-publish"]') as HTMLButtonElement).disabled).toBe(true);
  await click(q('[data-testid="rebase-draft"]'));
  expect(rebaseDraft).toHaveBeenCalled();
  await click(q('[data-testid="discard-stale"]'));
  await click(dialogButton("Discard"));
  expect(discardDraft).toHaveBeenCalled();
});

test("versions: semver labels, production, author, source, note; two selected show the diff", async () => {
  await renderPage("/skills/alpha");
  await click(byText(/Versions \(3\)/, "button"));
  expect(where.current).toBe("/skills/alpha?tab=versions");
  const rows = qa('[data-testid="version-row"]');
  expect(rows.map((r) => r.querySelector('[data-testid="version-label"]')!.textContent)).toEqual(["1.1.0", "1.0.1", "v1"]);
  expect(rows[0].textContent).toContain("Production");
  expect(rows[0].textContent).toContain("Claude (MCP)");
  expect(rows[0].textContent).toContain("Published");
  expect(rows[0].textContent).toContain("“New API docs”");
  expect(rows[0].textContent).toContain("3 files");
  expect(rows[1].textContent).toContain("ada@example.com");
  expect(rows[1].textContent).toContain("Found on disk");
  expect(rows[1].textContent).toContain("External");
  expect(rows[1].textContent).toContain("2.0 KB");
  expect(rows[2].textContent).toContain("Git");
  expect(q('a[aria-label="Download version 1.0.1"]')!.getAttribute("href")).toBe("/api/v1/skills/alpha/versions/2/download");
  expect(q('[data-testid="production-version"]')!.textContent).toBe("1.1.0");
  // production cannot be rolled back to
  expect(q('[aria-label="Roll production to version 1.1.0"]')).toBeNull();

  await click(q('[aria-label="Select version v1 to compare"]'));
  await click(q('[aria-label="Select version 1.1.0 to compare"]'));
  expect(diff).toHaveBeenLastCalledWith(1, 3);
  const view = qa('[data-testid="version-diff"]').at(-1)!;
  expect(view.textContent).toContain("v1 → 1.1.0");
  expect(view.textContent).toContain("1 added · 0 removed · 2 changed · 1 unchanged");
  const files = [...view.querySelectorAll('[data-testid="diff-file"]')] as HTMLElement[];
  expect(files.map((f) => `${f.getAttribute("data-status")}:${f.getAttribute("data-path")}`)).toEqual(["changed:SKILL.md", "changed:assets/logo.png", "added:references/api.md"]);
  const lines = [...view.querySelectorAll('[data-path="SKILL.md"] [data-line]')] as HTMLElement[];
  expect(lines.map((l) => l.getAttribute("data-line"))).toEqual(["hunk", "ctx", "del", "add"]);
  expect(lines[2].className).toContain("text-destructive");
  expect(lines[3].className).toContain("text-success");
  expect(files[1].textContent).toContain("Binary file");
  // a third selection replaces the oldest
  await click(q('[aria-label="Select version 1.0.1 to compare"]'));
  expect(diff).toHaveBeenLastCalledWith(2, 3);
});

test("rollback asks first: from the production card (to the previous one) and from a version", async () => {
  await renderPage("/skills/alpha?tab=versions");
  const rb = q('[data-testid="rollback"]')!;
  expect(rb.textContent).toContain("Rollback to 1.0.1");
  await click(rb);
  expect(rollback).not.toHaveBeenCalled();
  const dialog = q('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Roll production back to 1.0.1?");
  expect(dialog.textContent).toContain("Production goes back from 1.1.0 to 1.0.1; agents use it from their next run");
  expect(dialog.textContent).toContain("The draft keeps its changes and becomes out of date");
  await click(dialogButton("Cancel"));
  expect(rollback).not.toHaveBeenCalled();
  await click(q('[data-testid="rollback"]'));
  await click(dialogButton("Roll back"));
  expect(rollback).toHaveBeenCalledWith({ to: 2 });
  expect(q('[role="dialog"]')).toBeNull();

  await click(q('[aria-label="Roll production to version v1"]'));
  expect(q('[role="dialog"]')!.textContent).toContain("Roll production back to v1?");
  await click(dialogButton("Roll back"));
  expect(rollback).toHaveBeenLastCalledWith({ to: 1 });
});

test("restore into the draft asks first and leaves production alone", async () => {
  await renderPage("/skills/alpha?tab=versions");
  await click(q('[aria-label="Restore version v1 into the draft"]'));
  expect(restore).not.toHaveBeenCalled();
  const dialog = q('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Restore v1 into the draft?");
  expect(dialog.textContent).toContain("Production does not change");
  expect(dialog.textContent).toContain("The draft's unpublished changes are replaced");
  await click(dialogButton("Restore"));
  expect(restore).toHaveBeenCalledWith(1, { publish: false });
  expect(q('[role="dialog"]')).toBeNull();
});

test("history: publishes, rollbacks, migration with who, when, note and applied directly", async () => {
  await renderPage("/skills/alpha?tab=versions");
  const rows = qa('[data-testid="history-row"]');
  expect(rows.map((r) => r.getAttribute("data-action"))).toEqual(["publish", "publish", "migration"]);
  expect(rows[0].textContent).toContain("Published");
  expect(rows[0].textContent).toContain("1.0.1 → 1.1.0");
  expect(rows[0].textContent).toContain("Applied directly");
  expect(rows[0].textContent).toContain("“New API docs”");
  expect(rows[1].textContent).toContain("ada@example.com");
  expect(rows[1].textContent).not.toContain("Applied directly");
  expect(rows[2].textContent).toContain("Versioning enabled");
  expect(rows[2].textContent).toContain("migration");
});

test("a version's files open read-only in the same file browser; restore from there goes into the draft", async () => {
  await renderPage("/skills/alpha?tab=versions");
  await click(q('[aria-label="View the files of version 1.0.1"]'));
  expect(where.current).toBe("/skills/alpha?version=2");
  expect(versionFiles).toHaveBeenCalledWith(2);
  const banner = q('[data-testid="version-banner"]')!;
  expect(banner.textContent).toContain("Version 1.0.1 (read-only)");
  expect(banner.textContent).toContain("ada@example.com");
  // the tree is the version's
  expect(q('[data-path="old.md"]')).toBeTruthy();
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# Alpha at v2");
  expect(client.getSkillVersionFileText).toHaveBeenCalledWith("alpha", 2, "SKILL.md", "agent");
  expect(q('a[aria-label="Download SKILL.md"]')!.getAttribute("href")).toBe("/api/v1/skills/alpha/versions/2/files/SKILL.md?download=1");
  await click(byText(/Restore into draft/, "button"));
  expect(q('[role="dialog"]')!.textContent).toContain("Restore 1.0.1 into the draft?");
  await click(dialogButton("Restore"));
  expect(restore).toHaveBeenCalledWith(2, { publish: false });
  expect(where.current).toBe("/skills/alpha");
  expect(q('[data-testid="version-banner"]')).toBeNull();
  expect(q('[data-path="old.md"]')).toBeNull();
});

test("a deleted skill shows its versions and can be restored", async () => {
  state.deleted = true;
  await renderPage("/skills/alpha");
  expect(document.body.textContent).toContain("Deleted");
  expect(q('[data-testid="skill-versions"]')!.textContent).toContain("This skill was deleted");
  // no draft or production: each version can be restored
  expect(q('[data-testid="skill-draft"]')).toBeNull();
  expect(q('[data-testid="skill-production"]')).toBeNull();
  await click(q('[aria-label="Restore version 1.1.0"]'));
  expect(q('[role="dialog"]')!.textContent).toContain("published as a new version");
  await click(dialogButton("Restore"));
  expect(restore).toHaveBeenCalledWith(3, { publish: false });
});

test("labels", () => {
  expect(versionAuthor("person:ada@example.com")).toBe("ada@example.com");
  expect(versionAuthor("polpo")).toBe("Polpo");
  expect(versionAuthor("system:migration")).toBe("migration");
  expect(versionSourceLabel({ source: "restore", restoredFrom: 2 })).toBe("Restore of v2");
  expect(versionSourceLabel({ source: "publish" })).toBe("Published");
  expect(versionSourceLabel({ source: "external" })).toBe("Found on disk");
  expect(versionLabel({ version: 3, semver: "1.2.0" })).toBe("1.2.0");
  expect(versionLabel({ version: 3 })).toBe("v3");
  expect(versionEventLabel("rollback")).toBe("Rollback");
  expect(versionEventLabel("rebase")).toBe("Draft rebased");
});

test("settings: API, MCP and chat changes to skills published at once, switchable", async () => {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const onSaved = vi.fn();
  await act(async () => root.render(<SkillVersioningSetting autoPublish onSaved={onSaved} />));
  expect(q('[data-testid="skill-versioning-setting"]')!.textContent).toContain("API, MCP and chat changes to skills are published at once");
  const sw = q('[aria-label="Publish API, MCP and chat changes to skills at once"]')!;
  expect(sw.getAttribute("data-state")).toBe("checked");
  await click(sw);
  expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { skills: { versioning: { autoPublishApiUpdates: false } } } });
  expect(calls.at(-1)!.url).toContain("/api/v1/config/settings");
  expect(onSaved).toHaveBeenCalled();
  expect(sw.getAttribute("data-state")).toBe("unchecked");
  vi.unstubAllGlobals();
});
