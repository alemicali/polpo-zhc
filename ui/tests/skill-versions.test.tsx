/**
 * Skill versions in the dashboard: the Versions tab (list with number, date, author, source, files,
 * size), two selected → the diff, a version's files read-only in the same file browser, restore with a
 * confirmation, download links, a deleted skill restorable from its page; and the desktop layout whose
 * left column (tree, details) is sticky with its own scroll while the file pane scrolls.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const VERSIONS = [
  { version: 3, createdAt: "2026-11-20T10:00:00.000Z", author: "mcp:Claude", source: "upload", files: 3, totalBytes: 3000, hash: "c", description: "Alpha v3" },
  { version: 2, createdAt: "2026-11-19T10:00:00.000Z", author: "person:ada@example.com", source: "edit", files: 2, totalBytes: 2048, hash: "b" },
  { version: 1, createdAt: "2026-11-18T10:00:00.000Z", author: "cli", source: "git", files: 1, totalBytes: 100, hash: "a" },
];
const DIFF = {
  skill: "alpha", a: VERSIONS[2], b: VERSIONS[0], unchanged: 1, summary: { added: 1, removed: 0, changed: 2 },
  files: [
    { path: "SKILL.md", status: "changed", additions: 1, deletions: 1, diff: "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1,2 +1,2 @@\n # Alpha\n-old line\n+new line\n" },
    { path: "assets/logo.png", status: "changed", binary: true, sizeA: 10, sizeB: 12 },
    { path: "references/api.md", status: "added", additions: 1, deletions: 0, diff: "--- /dev/null\n+++ b/references/api.md\n@@ -0,0 +1,1 @@\n+# API\n" },
  ],
};
const state = { deleted: false };
const restore = vi.fn(async (n: number) => ({ name: "alpha", restoredFrom: n, version: { ...VERSIONS[0], version: 4, source: "restore", restoredFrom: n } }));
const diff = vi.fn(async () => DIFF);
const versionFiles = vi.fn(async (n: number) => ({ name: "alpha", version: VERSIONS.find((v) => v.version === n), files: [{ path: "SKILL.md", size: 50 }, { path: "old.md", size: 5 }], totalBytes: 55, truncated: false }));
const client = {
  getSkillContent: vi.fn(async () => ({ name: "alpha", description: "Does alpha", source: "project", path: "/p/.polpo/skills/alpha", content: "# Alpha now" })),
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
  useSkillVersions: (name: string) => ({
    data: {
      name, pool: "agent", scope: "project", versions: VERSIONS, ...(state.deleted ? { deletedAt: "2026-11-21T10:00:00.000Z", deletedBy: "person:ada@example.com" } : { current: 3 }),
      retention: { maxVersions: 20, maxBytes: 50 * 1024 * 1024, deletedDays: 30 },
    },
    isLoading: false, error: null, refetch: async () => undefined,
    files: versionFiles, diff, restore,
    fileUrl: (v: number, path: string, opts?: { download?: boolean }) => `/api/v1/skills/${name}/versions/${v}/files/${path}${opts?.download ? "?download=1" : ""}`,
    readText: async () => "",
    downloadUrl: (v: number) => `/api/v1/skills/${name}/versions/${v}/download`,
  }),
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("@/components/shared/agent-avatar", () => ({ AgentAvatar: () => null }));

import { TooltipProvider } from "../src/components/ui/tooltip";
import { SkillDetailPage } from "../src/pages/skill-detail";
import { versionAuthor } from "../src/components/skills/skill-versions";

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
  state.deleted = false;
  restore.mockClear();
  diff.mockClear();
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
});

test("the Versions tab lists versions; two selected show the diff", async () => {
  await renderPage("/skills/alpha");
  await click(byText(/Versions \(3\)/, "button"));
  expect(where.current).toBe("/skills/alpha?tab=versions");
  const rows = qa('[data-testid="version-row"]');
  expect(rows.map((r) => r.getAttribute("data-version"))).toEqual(["3", "2", "1"]);
  expect(rows[0].textContent).toContain("Current");
  expect(rows[0].textContent).toContain("Claude (MCP)");
  expect(rows[0].textContent).toContain("Upload");
  expect(rows[0].textContent).toContain("3 files");
  expect(rows[1].textContent).toContain("ada@example.com");
  expect(rows[1].textContent).toContain("2.0 KB");
  expect(rows[2].textContent).toContain("Git");
  expect(q('a[aria-label="Download version 2"]')!.getAttribute("href")).toBe("/api/v1/skills/alpha/versions/2/download");
  // the current one cannot be restored
  expect(q('[aria-label="Restore version 3"]')).toBeNull();

  await click(q('[aria-label="Select version 1 to compare"]'));
  await click(q('[aria-label="Select version 3 to compare"]'));
  expect(diff).toHaveBeenCalledWith(1, 3);
  const view = q('[data-testid="version-diff"]')!;
  expect(view.textContent).toContain("v1 → v3");
  expect(view.textContent).toContain("1 added · 0 removed · 2 changed · 1 unchanged");
  const files = qa('[data-testid="diff-file"]');
  expect(files.map((f) => `${f.getAttribute("data-status")}:${f.getAttribute("data-path")}`)).toEqual(["changed:SKILL.md", "changed:assets/logo.png", "added:references/api.md"]);
  const lines = qa('[data-testid="diff-file"][data-path="SKILL.md"] [data-line]');
  expect(lines.map((l) => l.getAttribute("data-line"))).toEqual(["hunk", "ctx", "del", "add"]);
  expect(lines[2].className).toContain("text-destructive");
  expect(lines[3].className).toContain("text-success");
  expect(files[1].textContent).toContain("Binary file");
  // a third selection replaces the oldest
  await click(q('[aria-label="Select version 2 to compare"]'));
  expect(diff).toHaveBeenLastCalledWith(2, 3);
});

test("restore asks for confirmation, then restores", async () => {
  await renderPage("/skills/alpha?tab=versions");
  await click(q('[aria-label="Restore version 1"]'));
  expect(restore).not.toHaveBeenCalled();
  const dialog = q('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Restore version 1?");
  expect(dialog.textContent).toContain("kept as a version first");
  // cancel does nothing
  await click(byText("Cancel", "button"));
  expect(restore).not.toHaveBeenCalled();
  await click(q('[aria-label="Restore version 1"]'));
  await click([...q('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Restore") as HTMLElement);
  expect(restore).toHaveBeenCalledWith(1);
  expect(q('[role="dialog"]')).toBeNull();
});

test("a version's files open read-only in the same file browser", async () => {
  await renderPage("/skills/alpha?tab=versions");
  await click(q('[aria-label="View the files of version 2"]'));
  expect(where.current).toBe("/skills/alpha?version=2");
  expect(versionFiles).toHaveBeenCalledWith(2);
  const banner = q('[data-testid="version-banner"]')!;
  expect(banner.textContent).toContain("Version 2 (read-only)");
  expect(banner.textContent).toContain("ada@example.com");
  // the tree is the version's
  expect(q('[data-path="old.md"]')).toBeTruthy();
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# Alpha at v2");
  expect(client.getSkillVersionFileText).toHaveBeenCalledWith("alpha", 2, "SKILL.md", "agent");
  expect(q('a[aria-label="Download SKILL.md"]')!.getAttribute("href")).toBe("/api/v1/skills/alpha/versions/2/files/SKILL.md?download=1");
  // restore from the banner, confirmed
  await click(byText(/Restore/, "button"));
  await click([...q('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Restore") as HTMLElement);
  expect(restore).toHaveBeenCalledWith(2);
  expect(where.current).toBe("/skills/alpha");
  // back to the current files
  expect(q('[data-testid="version-banner"]')).toBeNull();
  expect(q('[data-path="old.md"]')).toBeNull();
});

test("a deleted skill shows its versions and can be restored", async () => {
  state.deleted = true;
  await renderPage("/skills/alpha");
  expect(document.body.textContent).toContain("Deleted");
  expect(q('[data-testid="skill-versions"]')!.textContent).toContain("This skill was deleted");
  // no version is current: each can be restored
  expect(q('[aria-label="Restore version 3"]')).toBeTruthy();
  expect(versionAuthor("person:ada@example.com")).toBe("ada@example.com");
  expect(versionAuthor("polpo")).toBe("Polpo");
});
