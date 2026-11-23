import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@polpo-ai/react", () => ({
  useEvents: () => ({ events: [] }),
  useTasks: () => ({ tasks: [{ id: "task-1", title: "Write the Q4 report", missionId: "m-1" }] }),
  useMissions: () => ({ missions: [{ id: "m-1", name: "Quarter close" }] }),
}));
vi.mock("@/hooks/use-polpo", () => ({ useProjectInfo: () => ({ info: { project: "Polpo" } }) }));
vi.mock("@/lib/branding", () => ({ productName: () => "Polpo", useInstanceBranding: () => ({}) }));
// the live renderer is tested on its own: here only which artifact it is given matters
vi.mock("@/components/artifacts/artifact-view", () => ({
  ArtifactView: ({ artifact, content }: { artifact: { title: string }; content: string }) => <div data-testid="artifact-view">{artifact.title}: {content}</div>,
}));

vi.mock("@/components/artifacts/artifact-doc-editor", () => ({
  ArtifactDocEditor: ({ content, readOnly }: { content: string; readOnly?: boolean }) =>
    <div data-testid="doc-reader" data-read-only={readOnly}>{content}</div>,
}));

import { TooltipProvider } from "../src/components/ui/tooltip";
import { ArtifactsPage } from "../src/pages/artifacts";
import {
  ARTIFACTS_LAYOUT_KEY, artifactOrigin, formatArtifactSize, groupArtifactsByType, nextArtifactSort, readArtifactsLayout,
  relativeTime, sortArtifacts, writeArtifactsLayout,
} from "../src/lib/artifacts-list";
import type { ArtifactSummary } from "../src/lib/artifacts-api";

const base = { version: 1, createdAt: "2026-11-20T10:00:00.000Z" };
const LIST: ArtifactSummary[] = [
  { ...base, id: "art_a", title: "Sales dashboard", type: "html", kind: "dashboard", createdBy: "analyst", size: 2048, updatedAt: "2026-11-22T10:00:00.000Z", taskId: "task-1", missionId: "m-1" },
  { ...base, id: "art_b", title: "Architecture", type: "mermaid", createdBy: "person:ada@example.com", size: 300, updatedAt: "2026-11-23T09:00:00.000Z", sessionId: "s-1" },
  { ...base, id: "art_c", title: "Notes", type: "doc", createdBy: "polpo", size: 90_000, updatedAt: "2026-11-21T10:00:00.000Z" },
];

test("sizes, times, origins, grouping and sorting", () => {
  expect(formatArtifactSize(300)).toBe("300 B");
  expect(formatArtifactSize(2048)).toBe("2.0 KB");
  expect(formatArtifactSize(90_000)).toBe("88 KB");
  const now = Date.parse("2026-11-23T10:00:00.000Z");
  expect(relativeTime("2026-11-23T09:59:30.000Z", now)).toBe("just now");
  expect(relativeTime("2026-11-23T09:00:00.000Z", now)).toBe("1h ago");
  expect(relativeTime("2026-11-21T10:00:00.000Z", now)).toBe("2d ago");
  expect(artifactOrigin(LIST[0]!, { task: () => "Report", mission: () => "Close" })).toEqual({ label: "Close · Report", to: "/tasks/task-1" });
  expect(artifactOrigin(LIST[1]!)).toEqual({ label: "Chat", to: "/chat?session=s-1" });
  expect(artifactOrigin(LIST[2]!)).toBeNull();
  expect(groupArtifactsByType(LIST).map((g) => g.type)).toEqual(["html", "doc", "mermaid"]);
  const by = { author: (a: ArtifactSummary) => a.createdBy, origin: () => "" };
  expect(sortArtifacts(LIST, { key: "updatedAt", dir: "desc" }, by).map((a) => a.id)).toEqual(["art_b", "art_a", "art_c"]);
  expect(sortArtifacts(LIST, { key: "title", dir: "asc" }, by).map((a) => a.title)).toEqual(["Architecture", "Notes", "Sales dashboard"]);
  expect(sortArtifacts(LIST, { key: "size", dir: "desc" }, by).map((a) => a.id)).toEqual(["art_c", "art_a", "art_b"]);
  expect(nextArtifactSort({ key: "title", dir: "asc" }, "title")).toEqual({ key: "title", dir: "desc" });
  expect(nextArtifactSort({ key: "title", dir: "asc" }, "size")).toEqual({ key: "size", dir: "desc" });
});

test("the layout choice survives blocked storage", () => {
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readArtifactsLayout()).toBe("table");
  expect(() => writeArtifactsLayout("preview")).not.toThrow();
  spy.mockRestore();
  set.mockRestore();
});

let root: Root;
let container: HTMLDivElement;
function Where() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}${l.search}`}</output>;
}
const where = () => document.querySelector("[data-testid='location']")?.textContent ?? "";

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(String(url), "http://x").pathname;
    const id = /\/artifacts\/([^/]+)$/.exec(path)?.[1];
    const data = id
      ? { ...LIST.find((a) => a.id === decodeURIComponent(id))!, content: `content of ${id}`, versions: [] }
      : LIST;
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
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

async function render(path = "/artifacts") {
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rowTitles = () => [...container.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("a")?.textContent);

test("the table is the default: columns, origin, sorting, keyboard", async () => {
  await render();
  expect(container.querySelector("table")).not.toBeNull();
  const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
  expect(headers.slice(0, 6)).toEqual(["Name", "Type", "Created by", "From", "Size", "Updated"]);
  expect(rowTitles()).toEqual(["Architecture", "Sales dashboard", "Notes"]);
  const sales = container.querySelectorAll("tbody tr")[1]!;
  expect(sales.textContent).toContain("Dashboard");
  expect(sales.textContent).toContain("analyst");
  expect(sales.textContent).toContain("Quarter close · Write the Q4 report");
  expect(sales.textContent).toContain("2.0 KB");
  expect(container.querySelectorAll("tbody tr")[2]!.textContent).toContain("Polpo");
  expect(container.querySelectorAll("tbody tr")[0]!.textContent).toContain("ada@example.com");
  // every row keeps its link to the artifact's own page
  expect(container.querySelector("tbody tr a")!.getAttribute("href")).toBe("/artifacts/art_b");

  const nameHeader = [...container.querySelectorAll("thead button")].find((b) => b.textContent === "Name")!;
  await act(async () => { (nameHeader as HTMLButtonElement).click(); });
  expect(rowTitles()).toEqual(["Architecture", "Notes", "Sales dashboard"]);
  expect(nameHeader.closest("th")!.getAttribute("aria-sort")).toBe("ascending");

  const grid = container.querySelector<HTMLElement>("[aria-label='Artifacts']")!;
  const key = async (k: string) => act(async () => { grid.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  await key("ArrowDown");
  await key("ArrowDown");
  expect(container.querySelectorAll("tbody tr")[1]!.getAttribute("data-state")).toBe("selected");
  await key("Enter");
  expect(where()).toBe("/artifacts/art_c");
});

test("the Preview layout: list grouped by type, the selected artifact live, arrows move it; the choice is remembered", async () => {
  await render();
  const previewToggle = container.querySelector<HTMLButtonElement>("[aria-label='Preview']")!;
  await act(async () => { previewToggle.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(window.localStorage.getItem(ARTIFACTS_LAYOUT_KEY)).toBe("preview");
  expect(container.querySelector("table")).toBeNull();
  const listbox = container.querySelector<HTMLElement>("[role='listbox']")!;
  expect(listbox.textContent).toContain("Pages · 1");
  expect(listbox.textContent).toContain("Documents · 1");
  // the first in the list is shown
  expect(container.querySelector("[data-testid='artifact-view']")!.textContent).toBe("Sales dashboard: content of art_a");
  await act(async () => { listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(where()).toContain("selected=art_c");
  const doc = container.querySelector("[data-testid='doc-reader']")!;
  expect(doc.textContent).toBe("content of art_c");
  expect(doc.getAttribute("data-read-only")).toBe("true");
  expect(container.querySelector("[role='option'][aria-selected='true']")!.textContent).toContain("Notes");

  // a new visit opens in Preview
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.querySelector("[role='listbox']")).not.toBeNull();
});

test("on a phone, Preview opens the artifact's page instead", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.localStorage.setItem(ARTIFACTS_LAYOUT_KEY, "preview");
  await render();
  const notes = [...container.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent?.includes("Notes"))!;
  await act(async () => { notes.click(); });
  expect(where()).toBe("/artifacts/art_c");
});
