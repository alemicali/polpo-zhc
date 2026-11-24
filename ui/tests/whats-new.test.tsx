import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CHANGELOG,
  changelogPublishedAt,
  formatChangelogDate,
  formatChangelogDateTime,
  formatChangelogOnline,
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
  delete (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__;
});

/** A local time, as an ISO string (the page shows the person's time zone). */
const localIso = (day: string, h: number, m: number) => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y!, mo! - 1, d!, h, m).toISOString();
};

test("changelog data: unique ids, newest first, Italian dates, grouped by day", () => {
  expect(new Set(CHANGELOG.map((e) => e.id)).size).toBe(CHANGELOG.length);
  const dates = CHANGELOG.map((e) => e.date);
  expect([...dates].sort().reverse()).toEqual(dates);
  expect(formatChangelogDate("2026-10-06")).toBe("6 ottobre 2026");
  expect(groupChangelogByDate(CHANGELOG).map((g) => [g.date, g.entries.length])).toEqual([
    ["2026-11-24", 6], ["2026-11-23", 9], ["2026-11-22", 22], ["2026-11-21", 3], ["2026-11-19", 2], ["2026-11-17", 5], ["2026-11-16", 1], ["2026-11-09", 1], ["2026-11-03", 2], ["2026-10-31", 2], ["2026-10-25", 2], ["2026-10-15", 1], ["2026-10-14", 1], ["2026-10-13", 3], ["2026-10-12", 3], ["2026-10-11", 4], ["2026-10-10", 2], ["2026-10-06", 8], ["2026-10-05", 1],
  ]);
  expect(CHANGELOG.find((e) => e.id === "2026-10-06-group-chats")?.cta?.to).toBe("/chat?newGroup=1");
  // the newest news lead the bar (agents talking live, threads, sending anywhere, learning, recurring checks), then group chats and the Telegram news
  expect(unseenHighlights(CHANGELOG, new Set()).slice(0, 18).map((e) => e.id)).toEqual([
    "2026-11-24-global-search", "2026-11-24-channels-like-connectors", "2026-11-24-chat-history-clean", "2026-11-24-whatsapp-business", "2026-11-24-drill-in-sidebar", "2026-11-23-artifact-workspaces", "2026-11-23-data-ui", "2026-11-22-theme-everything", "2026-11-22-opencode", "2026-11-22-harness-gateways", "2026-11-22-task-tool-scope", "2026-11-22-connector-accounts", "2026-11-22-dependency-results", "2026-11-22-mission-cost", "2026-11-22-run-context", "2026-11-22-polpo-does-it-all", "2026-11-22-theme-everywhere", "2026-11-22-appearance-config-mcp",
  ]);
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

test("online time: the instance's recorded time wins, the entry's publishedAt is the fallback, never invented", () => {
  const entry: ChangelogEntry = { id: "x", date: "2026-11-22", kind: "improved", title: "X", summary: "", body: "", publishedAt: localIso("2026-11-22", 9, 0) };
  expect(changelogPublishedAt(entry, { x: localIso("2026-11-22", 18, 52) })?.toISOString()).toBe(localIso("2026-11-22", 18, 52));
  expect(changelogPublishedAt(entry, {})?.toISOString()).toBe(localIso("2026-11-22", 9, 0));
  expect(changelogPublishedAt({ ...entry, publishedAt: "not a date" }, { x: "nope" })).toBeUndefined();
  expect(changelogPublishedAt({ ...entry, publishedAt: undefined })).toBeUndefined();
  // Italian, local time zone
  expect(formatChangelogDateTime(new Date(2026, 10, 22, 18, 52))).toBe("22 nov 2026 · 18:52");
  expect(formatChangelogDateTime(new Date(2026, 10, 22, 8, 5))).toBe("22 nov 2026 · 08:05");
  const now = new Date(2026, 10, 22, 20, 0);
  expect(formatChangelogOnline(new Date(2026, 10, 22, 18, 52), now)).toBe("online alle 18:52");
  expect(formatChangelogOnline(new Date(2026, 10, 21, 9, 3), now)).toBe("online il 21 nov alle 09:03");
  expect(formatChangelogOnline(new Date(2025, 11, 31, 23, 59), now)).toBe("online il 31 dic 2025 alle 23:59");
});

test("timeline order: newest day first; inside a day the latest online first, entries without a time after them in written order", () => {
  const day: ChangelogEntry[] = [
    { id: "p", date: "2026-11-22", kind: "new", title: "P", summary: "", body: "" },
    { id: "q", date: "2026-11-22", kind: "new", title: "Q", summary: "", body: "" },
    { id: "r", date: "2026-11-22", kind: "new", title: "R", summary: "", body: "", publishedAt: localIso("2026-11-22", 9, 0) },
    { id: "s", date: "2026-11-22", kind: "new", title: "S", summary: "", body: "" },
    { id: "t", date: "2026-11-21", kind: "new", title: "T", summary: "", body: "" },
  ];
  const groups = groupChangelogByDate(day, { s: localIso("2026-11-22", 18, 52), q: localIso("2026-11-22", 12, 0) });
  expect(groups.map((g) => [g.date, g.entries.map((e) => e.id)])).toEqual([
    ["2026-11-22", ["s", "q", "r", "p"]],
    ["2026-11-21", ["t"]],
  ]);
  // without any time: as written
  const untimed = day.map(({ publishedAt: _unused, ...entry }) => entry);
  expect(groupChangelogByDate(untimed).flatMap((g) => g.entries.map((e) => e.id))).toEqual(["p", "q", "r", "s", "t"]);
});

test("changelog page: date and time from runtime-config.js, the latest first, and what arrived since the last visit is marked", async () => {
  // last visit: the person had seen "a" (and the older ones), not "b"
  localStorage.setItem(STORAGE_KEY, JSON.stringify(["a", "c"]));
  globalThis.__POLPO_RUNTIME_CONFIG__ = { whatsNewPublishedAt: { b: localIso("2026-10-06", 18, 52), a: localIso("2026-10-06", 9, 15) } };
  const { ChangelogTimeline } = await import("../src/components/whats-new/changelog-timeline");
  const { useChangelogUnreadSnapshot, markAllChangelogSeen } = await loadModules();
  function Page() {
    const unread = useChangelogUnreadSnapshot(true, entries);
    useEffect(() => markAllChangelogSeen(entries), []);
    return <ChangelogTimeline entries={[...entries].reverse()} unreadIds={unread} onAction={() => {}} />;
  }
  await act(async () => root.render(<MemoryRouter><Page /></MemoryRouter>));
  const articles = [...container.querySelectorAll("article")];
  expect(articles.map((a) => a.id)).toEqual(["b", "a", "c"]);
  // the row shows the time, the full date and time on hover
  expect(articles[0]!.querySelector("time")!.textContent).toBe("18:52");
  expect(articles[0]!.querySelector("time")!.getAttribute("title")).toContain("6 ott 2026 · 18:52");
  expect(articles[1]!.querySelector("time")!.textContent).toBe("09:15");
  expect(articles[2]!.querySelector("time")).toBeNull(); // no time recorded: the day only
  // the mark stays while the page is open, even though opening it set everything as seen
  expect(articles.map((a) => a.textContent!.includes("Non letta"))).toEqual([true, false, false]);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).sort()).toEqual(["a", "b", "c"]);
});

test("changelog page: a first visit marks nothing as unread", async () => {
  const { ChangelogTimeline } = await import("../src/components/whats-new/changelog-timeline");
  const { useChangelogUnreadSnapshot } = await loadModules();
  function Page() {
    return <ChangelogTimeline entries={entries} unreadIds={useChangelogUnreadSnapshot(true, entries)} onAction={() => {}} />;
  }
  await act(async () => root.render(<MemoryRouter><Page /></MemoryRouter>));
  expect(container.textContent).not.toContain("Non letta");
});

test("top bar: says when the newest news went online", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 6, 20, 0));
  try {
    globalThis.__POLPO_RUNTIME_CONFIG__ = { whatsNewPublishedAt: { b: localIso("2026-10-06", 18, 52) } };
    const { WhatsNewBar } = await loadModules();
    await act(async () => root.render(<MemoryRouter><WhatsNewBar entries={entries} /></MemoryRouter>));
    expect(container.textContent).toContain("online alle 18:52");
    expect(container.querySelector('button[aria-label^="Novità:"]')!.getAttribute("aria-label")).toContain("online alle 18:52");
  } finally {
    vi.useRealTimers();
  }
});
