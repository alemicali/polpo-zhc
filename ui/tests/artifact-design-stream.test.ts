import { expect, test } from "vitest";
import type { ToolCallInfo } from "../src/hooks/use-polpo";
import { artifactStreamArgs } from "../src/lib/artifact-stream-text";
import { projectDesignStream } from "../src/lib/artifact-design-stream";
import { createBoard, readDesign, writeDesign } from "../src/components/artifacts/design-workspace";

function draft(raw: string, base?: string, state: ToolCallInfo["state"] = "preparing") {
  const tool: ToolCallInfo = {
    id: "call_1",
    state,
    name: base === undefined ? "artifact_create" : "artifact_update",
    argumentsText: raw,
  };
  return projectDesignStream(tool, artifactStreamArgs(tool), base);
}
function args(html: string) {
  return JSON.stringify({ kind: "design", type: "html", content: html });
}
const main = "<main><h1>First heading</h1><p>Second paragraph</p></main>";
const actualText = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent;

test("renders completed descendants of open wrappers and never emits half a word", () => {
  const stream = args(main);
  expect(draft(stream.slice(0, stream.indexOf("heading") + 2))).toBeUndefined();
  const early = draft(stream.slice(0, stream.indexOf("paragraph") + 2))!;
  expect(actualText(early)).toContain("First heading");
  expect(actualText(early)).not.toContain("Second");
  expect(actualText(draft(stream)!)).toContain("First headingSecond paragraph");
});
test("preserves previously committed siblings and other boards until the replacement finishes", () => {
  const first = createBoard("old", "Primary", "<main><h1>Old heading</h1><p>Keep until ready</p></main>");
  const extra = createBoard("two", "Second board", "<p>Second canvas</p>");
  const base = writeDesign({
    pages: [
      { id: "one", name: "First page", boards: [first, extra] },
      { id: "second", name: "More", boards: [createBoard("three", "Three", "<p>Other page</p>")] },
    ],
  });
  const raw = args(main);
  const live = readDesign(draft(raw.slice(0, raw.indexOf("paragraph") + 1), base)!);
  expect(actualText(live.pages[0].boards[0].html)).toContain("First headingKeep until ready");
  expect(live.pages.map((p) => p.id)).toEqual(["one", "second"]);
  expect(actualText(live.pages[0].boards[1].html)).toContain("Second canvas");
  const final = readDesign(draft(raw, base)!);
  expect(final.pages).toHaveLength(1);
  expect(final.pages[0].boards).toHaveLength(1);
});
test("projects completed sections of nested artboards and strips all executable markup", () => {
  const first = createBoard("one", "First", "<!doctype html><main><p>First</p></main>");
  const second = createBoard(
    "two",
    "Second",
    '<main><h2>Second</h2><script>document.body.dataset.pendingExecuted="yes"</script><img src="https://example.test/test" onerror="throw 1"><p>Later text</p></main>',
  );
  const raw = args(writeDesign({ pages: [{ id: "p", name: "Page", boards: [first, second] }] }));
  const live = readDesign(draft(raw.slice(0, raw.indexOf("Later") + 3))!);
  expect(live.pages[0].boards).toHaveLength(2);
  const html = live.pages[0].boards[1].html;
  expect(actualText(html)).toContain("Second");
  expect(actualText(html)).not.toContain("Lat");
  expect(html).not.toContain("pendingExecuted");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("example.test");
});
test("waits for complete edit replacements and drops cancelled or unrelated calls", () => {
  const base = "<h1>Old heading</h1><p>Old text</p>";
  const raw = JSON.stringify({
    id: "art_demo",
    edits: [
      { find: "Old heading", replace: "New heading" },
      { find: "Old text", replace: "New text" },
    ],
  });
  expect(draft(raw.slice(0, raw.indexOf("New heading") + 3), base)).toBeUndefined();
  const projected = readDesign(draft(raw.slice(0, raw.indexOf("New text") + 3), base)!);
  expect(actualText(projected.pages[0].boards[0].html)).toContain("New headingOld text");
  expect(draft(args(main), undefined, "error")).toBeUndefined();
  expect(draft(JSON.stringify({ kind: "data", content: main }))).toBeUndefined();
});
