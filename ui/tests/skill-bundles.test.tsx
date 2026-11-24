/**
 * Skill bundles in the dashboard: the upload dialog (dropzone → preview → install), and the skill
 * page as a file browser (tree, the selected file in place of SKILL.md, ?file= deep links, relative
 * links in SKILL.md, downloads).
 */
import { act, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const SKILL_MD = "# Alpha\n\nRead [the API](references/api.md) first, or [the site](https://example.com).";
const FILES = [
  { path: "SKILL.md", size: 120 },
  { path: "assets/logo.png", size: 2048 },
  { path: "references/api.md", size: 40 },
  { path: "scripts/run.py", size: 30 },
  { path: "data/config.json", size: 20 },
];
const TEXTS: Record<string, string> = {
  "SKILL.md": `---\nname: alpha\ndescription: Does alpha\n---\n${SKILL_MD}`,
  "references/api.md": "# API reference\n\nBack to [the skill](../SKILL.md).",
  "scripts/run.py": "print('hi')",
  "data/config.json": "{\"a\":1}",
};

const install = vi.fn();
const previewFn = vi.fn();
const client = {
  getSkillContent: vi.fn(async () => ({ name: "alpha", description: "Does alpha", source: "project", path: "/p/.polpo/skills/alpha", content: SKILL_MD })),
  getOrchestratorSkillContent: vi.fn(async () => ({ name: "helper", description: "Polpo's", source: "project", path: "/p/.polpo/.agent/skills/helper", content: "# Helper" })),
  getSkillFileText: vi.fn(async (_name: string, path: string) => TEXTS[path] ?? ""),
};
const fileUrl = (name: string, pool: string) => (path: string, opts?: { download?: boolean }) => `/api/v1/skills${pool === "orchestrator" ? "/orchestrator" : ""}/${name}/files/${path}${opts?.download ? "?download=1" : ""}`;

vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client }),
  useSkills: () => ({ skills: [{ name: "alpha", description: "Does alpha", source: "project", path: "/p/.polpo/skills/alpha", assignedTo: ["dev"] }], isLoading: false }),
  useOrchestratorSkills: () => ({ skills: [{ name: "helper", description: "Polpo's", source: "project", path: "/p/.polpo/.agent/skills/helper" }], isLoading: false }),
  useAgents: () => ({ agents: [{ name: "dev" }, { name: "ops" }], teams: [{ name: "main", agents: [{ name: "dev" }] }] }),
  useSkillFiles: (name: string, pool: string) => ({
    data: { name, source: "project", files: pool === "orchestrator" ? [{ path: "SKILL.md", size: 10 }] : FILES, truncated: false, totalBytes: 2258 },
    isLoading: false, error: null, refetch: async () => undefined,
    fileUrl: fileUrl(name, pool),
    downloadUrl: (format = "skill") => `/api/v1/skills/${name}/download${format === "zip" ? "?format=zip" : ""}`,
  }),
  // the upload hook with the real state machine, the API faked
  useSkillBundleUpload: () => {
    const [current, setCurrent] = useState<unknown>(null);
    const [result, setResult] = useState<unknown>(null);
    return {
      current, result, isUploading: false, isInstalling: false, error: null,
      preview: async (file: Blob, filename: string) => { const p = await previewFn(file, filename); setCurrent(p); return p; },
      install: async (opts: unknown) => { const r = await install(opts); setResult(r); return r; },
      reset: () => { setCurrent(null); setResult(null); },
    };
  },
}));
// markdown: a tiny renderer that keeps links (through the components the page passes)
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children, components }: { children: string; components?: { a?: (p: ComponentProps<"a">) => ReactNode } }) => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const m of children.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      parts.push(children.slice(last, m.index));
      const A = components?.a;
      parts.push(A ? <A key={m.index} href={m[2]}>{m[1]}</A> : <a key={m.index} href={m[2]}>{m[1]}</a>);
      last = m.index! + m[0].length;
    }
    parts.push(children.slice(last));
    return <div data-testid="markdown">{parts}</div>;
  },
}));
vi.mock("@/components/shared/agent-avatar", () => ({ AgentAvatar: () => null }));

import { TooltipProvider } from "../src/components/ui/tooltip";
import { SkillDetailPage } from "../src/pages/skill-detail";
import { SkillUploadDialog } from "../src/components/skills/skill-upload-dialog";
import { buildFileTree, crc32, resolveSkillLink, skillFileKind, stripFrontmatter, zipStored, fenced, archiveFromFiles, suggestName } from "../src/lib/skill-files";

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
  install.mockReset();
  previewFn.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const byText = (text: string | RegExp, sel = "button, a") => [...document.body.querySelectorAll(sel)].find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) as HTMLElement | undefined;

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

test("the file tree, kinds, relative links, frontmatter, zip", async () => {
  const tree = buildFileTree(FILES);
  expect(tree.children.map((c) => `${c.kind}:${c.name}`)).toEqual(["file:SKILL.md", "dir:assets", "dir:data", "dir:references", "dir:scripts"]);
  expect(tree.children.find((c) => c.name === "assets")!.size).toBe(2048);
  expect(skillFileKind("references/api.md")).toBe("markdown");
  expect(skillFileKind("scripts/run.py")).toBe("code");
  expect(skillFileKind("data/config.json")).toBe("json");
  expect(skillFileKind("assets/logo.png")).toBe("image");
  expect(skillFileKind("assets/doc.pdf")).toBe("pdf");
  expect(skillFileKind("assets/font.woff2")).toBe("binary");
  const known = new Set(FILES.map((f) => f.path));
  expect(resolveSkillLink("references/api.md", "SKILL.md", known)).toBe("references/api.md");
  expect(resolveSkillLink("./references/api.md#usage", "SKILL.md", known)).toBe("references/api.md");
  expect(resolveSkillLink("../SKILL.md", "references/api.md", known)).toBe("SKILL.md");
  expect(resolveSkillLink("../../etc/passwd", "references/api.md")).toBeNull();
  expect(resolveSkillLink("https://example.com", "SKILL.md")).toBeNull();
  expect(resolveSkillLink("#top", "SKILL.md")).toBeNull();
  expect(resolveSkillLink("references/missing.md", "SKILL.md", known)).toBeNull();
  expect(stripFrontmatter(TEXTS["SKILL.md"]!)).toBe(SKILL_MD);
  expect(fenced("a ``` b", "md")).toBe("````md\na ``` b\n````");
  expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
  const zip = zipStored([{ path: "a/SKILL.md", data: new TextEncoder().encode("x") }]);
  expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(suggestName("My_Skill v2")).toBe("my-skill-v2");
  // a dropped folder becomes a zip named after it; an archive goes as is
  const folder = await archiveFromFiles([{ file: new File(["x"], "SKILL.md"), path: "alpha/SKILL.md" }, { file: new File(["y"], "a.md"), path: "alpha/references/a.md" }]);
  expect(folder.filename).toBe("alpha.zip");
  const archive = new File(["PK"], "alpha.skill");
  expect((await archiveFromFiles([{ file: archive, path: "alpha.skill" }])).blob).toBe(archive);
});

test("the skill page: SKILL.md by default, tree navigation replaces it, ?file= deep link, relative links, downloads", async () => {
  await renderPage("/skills/alpha");
  // the tree, SKILL.md selected and rendered (no frontmatter)
  expect(q('[role="tree"]')).toBeTruthy();
  expect(q('[data-path="SKILL.md"]')!.getAttribute("aria-current")).toBe("true");
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# Alpha");
  // download the whole skill (.skill and .zip) and the file
  await act(async () => { byText("Download", "button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await flush();
  expect(byText("alpha.skill", "a")?.getAttribute("href")).toBe("/api/v1/skills/alpha/download");
  expect(byText("alpha.zip", "a")?.getAttribute("href")).toBe("/api/v1/skills/alpha/download?format=zip");
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(q('a[aria-label="Download SKILL.md"]')!.getAttribute("href")).toBe("/api/v1/skills/alpha/files/SKILL.md?download=1");

  // a file in the tree replaces SKILL.md in the main pane, and the URL says which
  await act(async () => { q('[data-path="scripts/run.py"]')!.click(); });
  await flush();
  expect(where.current).toBe("/skills/alpha?file=scripts%2Frun.py");
  expect(q('[data-testid="skill-file-view"]')!.getAttribute("data-kind")).toBe("code");
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("print('hi')");
  expect(q('[data-testid="skill-file-view"]')!.textContent).not.toContain("# Alpha");

  // JSON pretty
  await act(async () => { q('[data-path="data/config.json"]')!.click(); });
  await flush();
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain('"a": 1');

  // an image is shown from its URL
  await act(async () => { q('[data-path="assets/logo.png"]')!.click(); });
  await flush();
  expect(q('[data-testid="skill-file-view"] img')!.getAttribute("src")).toBe("/api/v1/skills/alpha/files/assets/logo.png");
});

test("?file= opens a file directly; a relative link in SKILL.md opens that file in place", async () => {
  await renderPage("/skills/alpha?file=references%2Fapi.md");
  expect(q('[data-path="references/api.md"]')!.getAttribute("aria-current")).toBe("true");
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# API reference");
  // its own relative link goes back to SKILL.md
  await act(async () => { q('[data-skill-file="SKILL.md"]')!.click(); });
  await flush();
  expect(where.current).toBe("/skills/alpha");
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# Alpha");
  // SKILL.md's link to the reference opens it; the external one stays external
  const external = byText("the site", "a")!;
  expect(external.getAttribute("target")).toBe("_blank");
  await act(async () => { q('[data-skill-file="references/api.md"]')!.click(); });
  await flush();
  expect(where.current).toBe("/skills/alpha?file=references%2Fapi.md");
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# API reference");
  // raw markdown on demand
  await act(async () => { (q('[aria-label="Raw"]') as HTMLButtonElement).click(); });
  await flush();
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("```markdown");
});

test("orchestrator skills open in the same browser (?pool=orchestrator)", async () => {
  await renderPage("/skills/helper?pool=orchestrator");
  expect(client.getOrchestratorSkillContent).toHaveBeenCalledWith("helper");
  expect(q('[data-testid="skill-file-view"]')!.textContent).toContain("# Helper");
  expect(document.body.textContent).toContain("One of Polpo's own skills");
});

test("upload: dropzone → preview with conflicts and name errors → install with the choices → summary", async () => {
  previewFn.mockResolvedValue({
    uploadId: "su_1", archiveName: "bundle.zip", ignored: ["__MACOSX/x"], warnings: ["1 file(s) were marked executable"],
    limits: {},
    skills: [
      { name: "alpha", folder: "alpha", description: "Does alpha", files: [{ path: "SKILL.md", size: 10 }], totalBytes: 10, errors: [], warnings: ["Frontmatter keys outside the spec are kept but ignored: owner"], exists: { agent: { project: true, global: false }, orchestrator: { project: false, global: false } } },
      { name: "Bad_Name", folder: "Bad_Name", description: "Bad", files: [{ path: "SKILL.md", size: 10 }], totalBytes: 10, errors: ["The name \"Bad_Name\" must use only lowercase letters, digits and single hyphens (not at the start or end)"], warnings: [], exists: { agent: { project: false, global: false }, orchestrator: { project: false, global: false } } },
      { name: "broken", folder: "broken", description: "", files: [], totalBytes: 0, errors: ["SKILL.md has no description (say what the skill does and when to use it)"], warnings: [], exists: { agent: { project: false, global: false }, orchestrator: { project: false, global: false } } },
    ],
  });
  install.mockResolvedValue({ installed: [{ name: "alpha", from: "alpha", path: "/x", replaced: true, files: 1 }, { name: "bad-name", from: "Bad_Name", path: "/y", replaced: false, files: 1 }], skipped: [], errors: [], assigned: [{ skill: "alpha", agent: "dev" }] });
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/skills"]}><SkillUploadDialog open onOpenChange={() => undefined} /></MemoryRouter>,
  ));
  expect(q('[data-testid="skill-dropzone"]')).toBeTruthy();
  const input = q('[data-testid="skill-file-input"]') as HTMLInputElement;
  const file = new File(["PK"], "bundle.zip", { type: "application/zip" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect(previewFn).toHaveBeenCalledWith(file, "bundle.zip");
  // the preview: names, conflict, name error with a suggested name, a blocking error, warnings
  expect(q('[data-testid="bundle-skill-alpha"]')!.textContent).toContain("A skill named alpha exists");
  expect(q('[data-testid="bundle-skill-alpha"]')!.textContent).toContain("outside the spec");
  expect((q('[aria-label="New name for Bad_Name"]') as HTMLInputElement).value).toBe("bad-name");
  expect(q('[data-testid="bundle-skill-broken"]')!.textContent).toContain("no description");
  expect((q('[aria-label="Install broken"]') as HTMLButtonElement).disabled).toBe(true);
  expect(document.body.textContent).toContain("marked executable");
  // assign to an agent, install
  await act(async () => { byText("dev", "button")!.click(); });
  const installBtn = byText("Install 2 skills", "button")!;
  await act(async () => { installBtn.click(); });
  await flush();
  expect(install).toHaveBeenCalledWith({
    pool: "agent", global: false, onConflict: "replace", skills: ["alpha", "Bad_Name"], renames: { Bad_Name: "bad-name" }, assignTo: ["dev"],
  });
  const summary = q('[data-testid="skill-install-summary"]')!;
  expect(summary.textContent).toContain("replaced");
  expect(summary.textContent).toContain("from Bad_Name");
  expect(summary.textContent).toContain("assigned to dev");
});
