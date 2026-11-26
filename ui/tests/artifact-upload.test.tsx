import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@polpo-ai/react", () => ({
  useEvents: () => ({ events: [] }),
  useTasks: () => ({ tasks: [] }),
  useMissions: () => ({ missions: [] }),
}));
vi.mock("@/hooks/use-polpo", () => ({ useProjectInfo: () => ({ info: { project: "Polpo" } }) }));
vi.mock("@/lib/branding", () => ({ productName: () => "Polpo", useInstanceBranding: () => ({}) }));
vi.mock("@/components/artifacts/artifact-view", () => ({
  ArtifactView: ({ content }: { content: string }) => <div data-testid="artifact-view">{content}</div>,
}));
vi.mock("@/components/artifacts/artifact-doc-editor", () => ({
  ArtifactDocEditor: ({ content }: { content: string }) => <div data-testid="doc-editor">{content}</div>,
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("sonner", () => ({
  toast: Object.assign((m: string) => toasts.push(m), {
    loading: (m: string) => { toasts.push(m); return "t"; }, success: (m: string) => toasts.push(m), error: (m: string) => toasts.push(`error: ${m}`),
  }),
}));

import { TooltipProvider } from "../src/components/ui/tooltip";
import { ArtifactsPage } from "../src/pages/artifacts";
import { artifactsApi } from "../src/lib/artifacts-api";
import { prepareArtifactFile } from "../src/lib/artifact-upload";

type Call = { method: string; path: string; search: string; body: unknown };
let root: Root;
let container: HTMLDivElement;
let calls: Call[];
const MB = 1024 * 1024;

const BIG = {
  id: "art_big", title: "Huge report", type: "doc", version: 3, createdBy: "analyst", size: 42 * MB, content: "", contentOmitted: true,
  excerpt: "# Huge", blob: { sha256: "a".repeat(64), size: 42 * MB }, createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z",
  usage: { count: 2, bytes: 80 * MB, currentBytes: 42 * MB, maxCount: 30, maxBytes: 500 * MB },
  versions: [{ version: 2, content: "", size: 40 * MB, blob: { sha256: "b".repeat(64), size: 40 * MB }, at: "2026-11-22T10:00:00.000Z" }],
};
const SMALL = { ...BIG, id: "art_small", title: "Notes", size: 12, content: "# Notes", contentOmitted: undefined, blob: undefined, versions: [], usage: { count: 0, bytes: 0, currentBytes: 12, maxCount: 30, maxBytes: 500 * MB } };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  toasts.length = 0;
  calls = [];
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), "http://x");
    const body = init?.body instanceof Blob ? await init.body.text() : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, search: u.search, body });
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status });
    if (u.pathname === "/api/v1/artifacts") return ok([SMALL]);
    if (u.pathname === "/api/v1/artifacts/upload") return ok({ ...SMALL, id: "art_new", title: u.searchParams.get("title") }, 201);
    if (u.pathname === "/api/v1/artifacts/uploads") {
      const size = Number(u.searchParams.get("append_to") ? 10 : 4);
      return ok({ uploadId: "upl_abcdefghijkl", size, complete: u.searchParams.get("more") !== "true" });
    }
    if (u.pathname.endsWith("/finalize")) return ok({ ...SMALL, id: "art_parts", ...body });
    if (u.pathname === "/api/v1/artifacts/art_big/read") {
      if (u.searchParams.get("outline")) return ok({ text: "Tabs:\n  0. intro \"Intro\"", size: 42 * MB });
      const offset = Number(u.searchParams.get("offset"));
      return ok({ text: offset ? "…page two" : "# Huge report page one", size: 42 * MB, start: offset, end: offset + 65536, more: true });
    }
    if (u.pathname === "/api/v1/artifacts/art_big") return ok(BIG);
    if (u.pathname === "/api/v1/artifacts/art_big/content" && init?.method === "PUT") return ok({ ...SMALL, id: "art_big", version: 4, content: body });
    if (u.pathname === "/api/v1/artifacts/art_small") return ok(SMALL);
    return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Where() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
const location = () => document.querySelector("[data-testid='location']")?.textContent ?? "";

const settle = () => act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); });

async function render(path: string) {
  await act(async () => root.render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/artifacts" element={<ArtifactsPage />} />
          <Route path="/artifacts/:artifactId" element={<ArtifactsPage />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  ));
  await settle();
}

const choose = async (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
};

test("spreadsheets are converted to a sheets workspace; Word files are refused with a hint", async () => {
  const csv = await prepareArtifactFile(new File(["Name,Total\nEU,10\n"], "sales.csv"));
  expect(csv).toMatchObject({ title: "sales", filename: "sales.json", type: "html", kind: "sheets" });
  expect(JSON.parse(await csv.file.text())).toEqual({ version: 1, sheets: [{ name: "sales", cells: { A1: "Name", B1: "Total", A2: "EU", B2: "10" } }] });
  await expect(prepareArtifactFile(new File(["x"], "memo.docx"))).rejects.toThrow(/not converted yet/);
  const md = new File(["# x"], "x.md");
  expect((await prepareArtifactFile(md)).file).toBe(md);
});

test("a large file goes in parts with progress, then is finalized", async () => {
  const progress: number[] = [];
  const created = await artifactsApi.upload(new File(["0123456789"], "big.md"), { partBytes: 4, onProgress: (sent) => progress.push(sent) });
  expect(created.id).toBe("art_parts");
  expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual([
    "POST /api/v1/artifacts/uploads?more=true&filename=big.md",
    "POST /api/v1/artifacts/uploads?append_to=upl_abcdefghijkl&more=true&filename=big.md",
    "POST /api/v1/artifacts/uploads?append_to=upl_abcdefghijkl&filename=big.md",
    "POST /api/v1/artifacts/uploads/upl_abcdefghijkl/finalize",
  ]);
  expect(calls.slice(0, 3).map((c) => c.body)).toEqual(["0123", "4567", "89"]);
  expect(progress).toEqual([0, 4, 10, 10]);
});

test("the Artifacts page uploads chosen or dropped files and opens the new artifact", async () => {
  await render("/artifacts");
  const input = container.querySelector<HTMLInputElement>("[data-testid='artifact-upload-input']")!;
  expect(input.getAttribute("accept")).toContain(".xlsx");
  await choose(input, new File(["# Plan"], "plan.md", { type: "text/markdown" }));
  const upload = calls.find((c) => c.path === "/api/v1/artifacts/upload")!;
  expect(upload.search).toBe("?title=plan&filename=plan.md");
  expect(upload.body).toBe("# Plan");
  expect(location()).toBe("/artifacts/art_new");

  await act(async () => root.unmount());
  root = createRoot(container);
  await render("/artifacts");
  const zone = container.querySelector<HTMLElement>("[data-testid='artifact-drop-zone']")!;
  const files = [new File(["a"], "a.md"), new File(["b"], "b.svg")];
  const transfer = { types: ["Files"], files };
  const drag = (type: string) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { dataTransfer: transfer }); return event; };
  await act(async () => { zone.dispatchEvent(drag("dragenter")); });
  expect(container.textContent).toContain("Drop files to upload them as artifacts");
  await act(async () => { zone.dispatchEvent(drag("drop")); });
  await settle();
  expect(calls.filter((c) => c.path === "/api/v1/artifacts/upload").map((c) => c.search)).toEqual(["?title=plan&filename=plan.md", "?title=a&filename=a.md", "?title=b&filename=b.svg"]);
  expect(toasts).toEqual(expect.arrayContaining(["a uploaded", "b uploaded"]));
});

test("an artifact over the viewer limit shows its size, outline and a preview by pages, never the editor; its content can be replaced", async () => {
  await render("/artifacts/art_big");
  const view = container.querySelector("[data-testid='artifact-large-view']")!;
  expect(view).not.toBeNull();
  expect(container.querySelector("[data-testid='doc-editor']")).toBeNull();
  expect(view.textContent).toContain("This artifact is 42.0 MB");
  expect(view.textContent).toContain('0. intro "Intro"');
  expect(view.textContent).toContain("# Huge report page one");
  const more = [...view.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show more"))!;
  await act(async () => { more.click(); });
  await settle();
  expect(view.textContent).toContain("# Huge report page one…page two");
  expect(calls.some((c) => c.path === "/api/v1/artifacts/art_big/read" && c.search.includes("offset=65536"))).toBe(true);

  const input = container.querySelector<HTMLInputElement>("[data-testid='artifact-replace-input']")!;
  await choose(input, new File(["# Shorter"], "short.md"));
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put).toMatchObject({ path: "/api/v1/artifacts/art_big/content", search: "?expectedVersion=3&filename=short.md", body: "# Shorter" });
  expect(toasts).toContain("Content replaced (version 4)");
  expect(container.querySelector("[data-testid='artifact-large-view']")).toBeNull();
});

test("the version history shows how much of the version limit is used", async () => {
  await render("/artifacts/art_big");
  const trigger = container.querySelector<HTMLButtonElement>("[aria-label='Artifact actions for Huge report']")!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  const item = [...document.querySelectorAll("[role='menuitem']")].find((el) => el.textContent?.includes("Version history"));
  await act(async () => { (item as HTMLElement).click(); });
  await settle();
  const usage = document.querySelector("[data-testid='artifact-version-usage']")!;
  expect(usage.textContent).toBe("2 earlier versions, 80.0 MB of 500.0 MB (at most 30; the oldest are removed first)");
  expect(document.body.textContent).toContain("40.0 MB");
});
