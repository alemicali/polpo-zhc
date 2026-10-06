import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, type Location } from "react-router-dom";
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
  const { WhatsNewBanner } = await import("../src/components/whats-new/whats-new-banner");
  return { ...store, WhatsNewBanner };
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
  expect(groupChangelogByDate(CHANGELOG).map((g) => [g.date, g.entries.length])).toEqual([["2026-10-06", 4], ["2026-10-05", 1]]);
  expect(CHANGELOG[0].cta?.to).toBe("/chat?newGroup=1");
  expect(unseenHighlights(CHANGELOG, new Set()).map((e) => e.id)).toEqual(CHANGELOG.filter((e) => e.highlight).map((e) => e.id));
});

test("banner shows the newest unseen highlight, steps through them and dismiss persists by id", async () => {
  const { WhatsNewBanner, markAllChangelogSeen, useHasUnseenChangelog } = await loadModules();
  let hasUnseen: boolean | undefined;
  function Dot() {
    const current = useHasUnseenChangelog(entries);
    useEffect(() => { hasUnseen = current; });
    return null;
  }
  await act(async () => root.render(
    <MemoryRouter>
      <WhatsNewBanner entries={entries} />
      <Dot />
    </MemoryRouter>,
  ));
  expect(container.textContent).toContain("Second highlight… newest");
  expect(container.textContent).toContain("Novità");
  expect(container.querySelector('a[href="/changelog"]')?.textContent).toBe("Tutte le novità");
  expect(container.textContent).not.toContain("Not highlighted");

  await act(async () => { (container.querySelector('[aria-label="Novità successiva"]') as HTMLButtonElement).click(); });
  expect(container.textContent).toContain("Older highlight");

  await act(async () => { (container.querySelector('[aria-label="Chiudi le novità"]') as HTMLButtonElement).click(); });
  expect(container.textContent).toBe("");
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["b", "a"]);
  // The non-highlighted entry is still unread (nav dot) until the changelog page is opened.
  expect(hasUnseen).toBe(true);
  await act(async () => { markAllChangelogSeen(entries); });
  expect(hasUnseen).toBe(false);
});

test("banner remembers what was seen and the CTA marks its entry seen", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(["a"]));
  const { WhatsNewBanner } = await loadModules();
  let location: Location | undefined;
  function Where() {
    const current = useLocation();
    useEffect(() => { location = current; });
    return null;
  }
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <WhatsNewBanner entries={entries} />
      <Where />
    </MemoryRouter>,
  ));
  // Only one unseen highlight → no stepper.
  expect(container.querySelector('[aria-label="Novità successiva"]')).toBeNull();
  const cta = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Prova"))!;
  await act(async () => { cta.click(); });
  expect(`${location!.pathname}${location!.search}`).toBe("/chat?newGroup=1");
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).sort()).toEqual(["a", "b"]);
  expect(container.textContent).toBe("");
});

test("blocked storage: the banner still works for this visit", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const { WhatsNewBanner } = await loadModules();
  await act(async () => root.render(
    <MemoryRouter>
      <WhatsNewBanner entries={entries} />
    </MemoryRouter>,
  ));
  expect(container.textContent).toContain("Second highlight… newest");
  await act(async () => { (container.querySelector('[aria-label="Chiudi le novità"]') as HTMLButtonElement).click(); });
  expect(container.textContent).toBe("");
});
