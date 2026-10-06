import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CHANGELOG,
  formatChangelogDate,
  groupChangelogByDate,
  unseenHighlights,
  type ChangelogEntry,
} from "../src/lib/changelog";

const STORAGE_KEY = "polpo-whats-new-seen";

// The seen-state store caches localStorage at first use: load a fresh copy per test.
async function loadModules() {
  vi.resetModules();
  const store = await import("../src/hooks/use-whats-new");
  const drawer = await import("../src/hooks/use-whats-new-drawer");
  const { WhatsNewBar } = await import("../src/components/whats-new/whats-new-bar");
  return { ...store, ...drawer, WhatsNewBar };
}

const entries: ChangelogEntry[] = [
  { id: "b", date: "2026-10-06", kind: "new", title: "Second highlight… newest", summary: "S1", body: "", highlight: true, cta: { label: "Prova", to: "/chat?newGroup=1" } },
  { id: "a", date: "2026-10-06", kind: "new", title: "Older highlight", summary: "S2", body: "", highlight: true },
  { id: "c", date: "2026-10-05", kind: "improved", title: "Not highlighted", summary: "S3", body: "" },
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test("changelog data: unique ids, newest first, Italian dates, grouped by day", () => {
  expect(new Set(CHANGELOG.map((e) => e.id)).size).toBe(CHANGELOG.length);
  const dates = CHANGELOG.map((e) => e.date);
  expect([...dates].sort().reverse()).toEqual(dates);
  expect(formatChangelogDate("2026-10-06")).toBe("6 ottobre 2026");
  expect(groupChangelogByDate(CHANGELOG).map((g) => [g.date, g.entries.length])).toEqual([["2026-10-06", 6], ["2026-10-05", 1]]);
  expect(CHANGELOG.find((e) => e.id === "2026-10-06-group-chats")?.cta?.to).toBe("/chat?newGroup=1");
  expect(unseenHighlights(CHANGELOG, new Set()).map((e) => e.id)).toEqual(CHANGELOG.filter((e) => e.highlight).map((e) => e.id));
});

test("top bar: the newest unseen news (highlights first), how many more, a click opens the drawer", async () => {
  const { WhatsNewBar, useWhatsNewOpen } = await loadModules();
  let open: boolean | undefined;
  function Drawer() {
    const current = useWhatsNewOpen();
    useEffect(() => { open = current; });
    return null;
  }
  await act(async () => root.render(
    <MemoryRouter>
      <WhatsNewBar entries={entries} />
      <Drawer />
    </MemoryRouter>,
  ));
  expect(container.textContent).toContain("Second highlight… newest");
  expect(container.textContent).toContain("+2");
  expect(open).toBe(false);
  await act(async () => { (container.querySelector('button[aria-label^="Novità:"]') as HTMLButtonElement).click(); });
  expect(open).toBe(true);
});

test("top bar: the X sets everything as seen, and it stays hidden", async () => {
  const { WhatsNewBar, useHasUnseenChangelog } = await loadModules();
  let hasUnseen: boolean | undefined;
  function Dot() {
    const current = useHasUnseenChangelog(entries);
    useEffect(() => { hasUnseen = current; });
    return null;
  }
  await act(async () => root.render(
    <MemoryRouter>
      <WhatsNewBar entries={entries} />
      <Dot />
    </MemoryRouter>,
  ));
  expect(hasUnseen).toBe(true);
  await act(async () => { (container.querySelector('[aria-label="Nascondi le novità"]') as HTMLButtonElement).click(); });
  expect(container.textContent).toBe("");
  expect(hasUnseen).toBe(false);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).sort()).toEqual(["a", "b", "c"]);
});

test("top bar: only what is still unseen; nothing when all is seen", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(["b", "a"]));
  const { WhatsNewBar } = await loadModules();
  await act(async () => root.render(<MemoryRouter><WhatsNewBar entries={entries} /></MemoryRouter>));
  expect(container.textContent).toContain("Not highlighted");
  expect(container.textContent).not.toContain("+");
  localStorage.setItem(STORAGE_KEY, JSON.stringify(["a", "b", "c"]));
  const fresh = await loadModules();
  await act(async () => root.render(<MemoryRouter><fresh.WhatsNewBar entries={entries} /></MemoryRouter>));
  expect(container.textContent).toBe("");
});

test("blocked storage: the bar still works for this visit", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const { WhatsNewBar } = await loadModules();
  await act(async () => root.render(<MemoryRouter><WhatsNewBar entries={entries} /></MemoryRouter>));
  expect(container.textContent).toContain("Second highlight… newest");
  await act(async () => { (container.querySelector('[aria-label="Nascondi le novità"]') as HTMLButtonElement).click(); });
  expect(container.textContent).toBe("");
});
