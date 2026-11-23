import { expect, test } from "vitest";
import { newDocTab, readDocTabs, writeDocTabs } from "../src/components/artifacts/artifact-doc-tabs";

test("keeps a legacy single-tab document byte-for-byte", () => {
  const markdown = "  # Heading\r\n\r\nPlain Markdown.\n\n";
  const document = readDocTabs(markdown);
  expect(document.tabs).toEqual([{ id: "main", title: "Tab 1", content: markdown }]);
  expect(writeDocTabs(document)).toBe(markdown);
});

test("retains tab ids, order, Unicode titles and Markdown across a source edit", () => {
  const first = { id: "main", title: "First", content: "  # Heading\n\nUnique draft phrase\r\n\n\r" };
  const second = { id: "tab-2", title: "Design — 研究", content: "\n\nSecond tab body\r\n\n" };
  const multi = writeDocTabs({ tabs: [first, second] });
  const reloaded = readDocTabs(multi.replace("Unique draft phrase", "Revised phrase"));
  expect(reloaded.tabs).toEqual([{ ...first, content: first.content.replace("Unique draft phrase", "Revised phrase") }, second]);

  const reordered = readDocTabs(writeDocTabs({ ...reloaded, tabs: [...reloaded.tabs].reverse() }));
  expect(reordered.namespace).toBe(reloaded.namespace);
  expect(reordered.tabs.map((tab) => tab.id)).toEqual(["tab-2", "main"]);
  expect(newDocTab(reordered.tabs, second)).toMatchObject({ title: "Design — 研究 copy", content: second.content });
});

test("a manually damaged tab header remains editable as ordinary Markdown", () => {
  const markdown = writeDocTabs({
    tabs: [{ id: "main", title: "First", content: "First body" }, { id: "duplicate", title: "Second", content: "Second body" }],
  }).replace(" duplicate ", " main ");
  expect(readDocTabs(markdown)).toEqual({ tabs: [{ id: "main", title: "Tab 1", content: markdown }] });
});
