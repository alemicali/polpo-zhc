import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatChangelogDayLong, type ChangelogEntry } from "../src/lib/changelog";

const ACCORDION_KEY = "polpo-whats-new-accordion";

const entries: ChangelogEntry[] = [
  { id: "b", date: "2026-10-06", kind: "new", title: "Gruppi", summary: "Riassunto B", body: "Dettaglio **B**", highlight: true, cta: { label: "Prova", to: "/chat?newGroup=1" } },
  { id: "a", date: "2026-10-06", kind: "fixed", title: "Correzione", summary: "Riassunto A", body: "Dettaglio A" },
  { id: "c", date: "2026-10-05", kind: "improved", title: "Più veloce", summary: "Riassunto C", body: "Dettaglio C" },
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

async function render(props: { focusId?: string; unreadIds?: ReadonlySet<string>; onAction?: (to: string) => void } = {}) {
  vi.resetModules();
  const { ChangelogTimeline } = await import("../src/components/whats-new/changelog-timeline");
  await act(async () => root.render(
    <MemoryRouter>
      <ChangelogTimeline entries={entries} publishedAt={{}} onAction={props.onAction ?? (() => {})} unreadIds={props.unreadIds} focusId={props.focusId} />
    </MemoryRouter>,
  ));
}

const dayTrigger = (date: string) => container.querySelector<HTMLButtonElement>(`[data-changelog-day="${date}"] h2 button`)!;
const entryTrigger = (id: string) => container.querySelector<HTMLButtonElement>(`#${id}-trigger`)!;
const panel = (trigger: HTMLElement) => document.getElementById(trigger.getAttribute("aria-controls")!)!;
const click = (el: HTMLElement) => act(async () => { el.click(); });
const buttonNamed = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(name))!;

test("Italian long day: capitalised weekday", () => {
  expect(formatChangelogDayLong("2026-11-22")).toBe("Domenica 22 novembre 2026");
  expect(formatChangelogDayLong("2026-10-06")).toBe("Martedì 6 ottobre 2026");
  expect(formatChangelogDayLong("nope")).toBe("nope");
});

test("grouped by day, sticky day headers, newest day open, every entry collapsed", async () => {
  await render();
  const days = [...container.querySelectorAll("[data-changelog-day]")].map((d) => d.getAttribute("data-changelog-day"));
  expect(days).toEqual(["2026-10-06", "2026-10-05"]);
  const header = container.querySelector("[data-changelog-day] h2")!;
  expect(header.className).toContain("sticky");
  expect(header.className).toContain("top-0");
  expect(dayTrigger("2026-10-06").textContent).toContain("Martedì 6 ottobre 2026");
  expect(dayTrigger("2026-10-06").textContent).toContain("2 novità");
  // newest day open, older closed (and out of the tab order)
  expect(dayTrigger("2026-10-06").getAttribute("aria-expanded")).toBe("true");
  expect(dayTrigger("2026-10-05").getAttribute("aria-expanded")).toBe("false");
  expect(panel(dayTrigger("2026-10-05")).hasAttribute("inert")).toBe(true);
  expect(panel(dayTrigger("2026-10-06")).hasAttribute("inert")).toBe(false);
  // entries: only the row, no details yet
  for (const id of ["b", "a", "c"]) expect(entryTrigger(id).getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).toContain("Gruppi");
  expect(container.textContent).not.toContain("Riassunto B");
  expect(container.textContent).not.toContain("Prova");
});

test("click expands an entry (summary, details, button) and collapses it again; several can be open", async () => {
  const onAction = vi.fn();
  await render({ onAction });
  const trigger = entryTrigger("b");
  expect(trigger.tagName).toBe("BUTTON");
  expect(trigger.getAttribute("type")).toBe("button"); // Enter / Space activate it natively
  await click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const details = panel(trigger);
  expect(details.getAttribute("role")).toBe("region");
  expect(details.getAttribute("aria-labelledby")).toBe("b-trigger");
  expect(details.hasAttribute("inert")).toBe(false);
  expect(details.textContent).toContain("Riassunto B");
  expect(details.textContent).toContain("Dettaglio");
  await click(buttonNamed("Prova"));
  expect(onAction).toHaveBeenCalledWith("/chat?newGroup=1");

  await click(entryTrigger("a"));
  expect(entryTrigger("a").getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  await click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(details.hasAttribute("inert")).toBe(true);
});

test("a day header folds and unfolds its group", async () => {
  await render();
  await click(dayTrigger("2026-10-05"));
  expect(dayTrigger("2026-10-05").getAttribute("aria-expanded")).toBe("true");
  expect(panel(dayTrigger("2026-10-05")).hasAttribute("inert")).toBe(false);
  await click(dayTrigger("2026-10-06"));
  expect(dayTrigger("2026-10-06").getAttribute("aria-expanded")).toBe("false");
});

test("keyboard: arrows, Home and End move between visible rows and day headers", async () => {
  await render();
  const list = container.querySelector("ol")!;
  const key = (k: string) => act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  dayTrigger("2026-10-06").focus();
  expect(list.contains(document.activeElement)).toBe(true);
  await key("ArrowDown");
  expect(document.activeElement).toBe(entryTrigger("b"));
  await key("ArrowDown");
  expect(document.activeElement).toBe(entryTrigger("a"));
  await key("ArrowDown"); // the older day's header; its rows are folded, so skipped
  expect(document.activeElement).toBe(dayTrigger("2026-10-05"));
  await key("ArrowDown");
  expect(document.activeElement).toBe(dayTrigger("2026-10-05"));
  await key("Home");
  expect(document.activeElement).toBe(dayTrigger("2026-10-06"));
  await key("End");
  expect(document.activeElement).toBe(dayTrigger("2026-10-05"));
  await key("ArrowUp");
  expect(document.activeElement).toBe(entryTrigger("a"));
});

test("Espandi tutto opens every day and entry; Comprimi tutto closes them", async () => {
  await render();
  await click(buttonNamed("Espandi tutto"));
  for (const date of ["2026-10-06", "2026-10-05"]) expect(dayTrigger(date).getAttribute("aria-expanded")).toBe("true");
  for (const id of ["b", "a", "c"]) expect(entryTrigger(id).getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Riassunto C");
  expect(buttonNamed("Espandi tutto").disabled).toBe(true);
  await click(buttonNamed("Comprimi tutto"));
  for (const date of ["2026-10-06", "2026-10-05"]) expect(dayTrigger(date).getAttribute("aria-expanded")).toBe("false");
  for (const id of ["b", "a", "c"]) expect(entryTrigger(id).getAttribute("aria-expanded")).toBe("false");
  expect(buttonNamed("Comprimi tutto").disabled).toBe(true);
});

test("what the person opens and closes is remembered per viewer", async () => {
  await render();
  await click(entryTrigger("a"));
  await click(dayTrigger("2026-10-06")); // close the newest day
  await click(dayTrigger("2026-10-05")); // open the older one
  expect(JSON.parse(localStorage.getItem(ACCORDION_KEY)!)).toEqual({
    days: { "2026-10-06": false, "2026-10-05": true },
    entries: ["a"],
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(dayTrigger("2026-10-06").getAttribute("aria-expanded")).toBe("false");
  expect(dayTrigger("2026-10-05").getAttribute("aria-expanded")).toBe("true");
  expect(entryTrigger("a").getAttribute("aria-expanded")).toBe("true");
  expect(entryTrigger("b").getAttribute("aria-expanded")).toBe("false");
});

test("blocked or broken storage: defaults, and toggling still works for this visit", async () => {
  localStorage.setItem(ACCORDION_KEY, "{not json");
  await render();
  expect(dayTrigger("2026-10-06").getAttribute("aria-expanded")).toBe("true");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  await click(entryTrigger("b"));
  expect(entryTrigger("b").getAttribute("aria-expanded")).toBe("true");
});

test("deep link: #<entry-id> opens its day and the entry, and scrolls to it", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
  try {
    await render({ focusId: "c" });
    expect(dayTrigger("2026-10-05").getAttribute("aria-expanded")).toBe("true");
    expect(entryTrigger("c").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Riassunto C");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("c"));
    expect(document.activeElement).toBe(entryTrigger("c"));
    // an unknown id changes nothing
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.clear();
    await render({ focusId: "nope" });
    expect(dayTrigger("2026-10-05").getAttribute("aria-expanded")).toBe("false");
  } finally {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

test("unread entries: highlighted row with a dot, counted on their day's header", async () => {
  await render({ unreadIds: new Set(["a"]) });
  expect(dayTrigger("2026-10-06").textContent).toContain("1 non letta");
  expect(dayTrigger("2026-10-05").textContent).not.toContain("non lett");
  const article = document.getElementById("a")!;
  expect(article.textContent).toContain("Non letta");
  expect(article.className).toContain("border-primary/30");
  expect(document.getElementById("b")!.textContent).not.toContain("Non letta");
  expect(entryTrigger("a").getAttribute("aria-expanded")).toBe("false"); // unread, still collapsed
});
