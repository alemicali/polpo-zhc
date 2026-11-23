import { expect, test } from "vitest";
import { parseSlides, type Slide } from "../src/components/artifacts/artifact-slides-format";
import type { ToolCallInfo } from "../src/hooks/use-polpo";
import { projectSlidesStream } from "../src/lib/artifact-slides-stream";
import { artifactStreamArgs } from "../src/lib/artifact-stream-text";

const tool = (argumentsText: string, name = "artifact_create"): ToolCallInfo => ({
  id: "call_slides", name, state: "preparing", argumentsText,
});

const deck = (...slides: Slide[]) => JSON.stringify({ version: 1, slides });

function project(call: ToolCallInfo, base?: string) {
  const source = projectSlidesStream(call, artifactStreamArgs(call), base);
  if (source === undefined) return;
  const parsed = parseSlides(source);
  expect(parsed).not.toBeNull();
  return parsed!.slides;
}

test("completed titles and body values reach a valid deck as successive slides stream", () => {
  const first: Slide = { id: "s1", layout: "title", title: 'Seed "plan"', body: "Soil\n& seeds" };
  const second: Slide = { id: "s2", layout: "content", title: "Water schedule", body: "Water after sunset" };
  // Tool argument order is arbitrary. The kind can arrive after the deck contents.
  const raw = JSON.stringify({ title: "Garden", content: deck(first, second), type: "html", kind: "slides" });
  const observed: string[] = [];
  for (let end = 1; end <= raw.length; end++) {
    const slides = project(tool(raw.slice(0, end)));
    if (observed.length) expect(slides).toBeDefined();
    if (!slides) continue;
    expect(slides[0].title).toBe(first.title);
    expect(["", first.body]).toContain(slides[0].body);
    if (slides.length > 1) expect(slides[1].title).toBe(second.title);
    const signature = slides.map(slide => slide.title).join(", ");
    if (observed.at(-1) !== signature) observed.push(signature);
    if (end < raw.length) expect(slides.length).toBeLessThanOrEqual(2);
  }
  expect(observed).toEqual([first.title, `${first.title}, ${second.title}`]);
  expect(project(tool(raw))).toEqual([first, second]);
});

test("a partial replacement preserves untouched slides and media, while the complete deck controls deletions", () => {
  const saved: Slide = { id: "s1", layout: "content", title: "Old headline", body: "Keep until changed",
    elements: [{ id: "i1", type: "image", x: 0, y: 0, w: 10, h: 10, src: "data:image/png;base64,AAAA" }],
  };
  const later: Slide = { id: "s2", layout: "content", title: "Later existing slide", body: "Existing body" };
  const replacement: Slide = { id: "s1", layout: "content", title: "New headline", body: "Updated body",
    elements: [{ ...saved.elements![0], src: "data:image/png;base64,BBBB" }],
  };
  const base = deck(saved, later);
  const raw = JSON.stringify({ id: "art_garden", content: deck(replacement) });
  const beforeBody = tool(raw.slice(0, raw.indexOf("Updated body") + 2), "artifact_update");
  expect(project(beforeBody, base)).toEqual([{ ...saved, title: replacement.title }, later]);
  const withinMedia = tool(raw.slice(0, raw.indexOf("BBBB") + 2), "artifact_update");
  expect(project(withinMedia, base)).toEqual([{ ...replacement, elements: saved.elements }, later]);
  expect(project(tool(raw, "artifact_update"), base)).toEqual([replacement]);
});

test("partial find/replace only returns a valid slide deck, then converges on the committed replacement", () => {
  const saved: Slide = { id: "s1", layout: "title", title: "Before", body: "Body" };
  const expected = { ...saved, title: "After", body: "Changed body" };
  const base = deck(saved);
  const raw = JSON.stringify({ id: "art_garden", edits: [
    { find: '"Body"', replace: '"Changed body"' }, { find: '"Before"', replace: '"After"' },
  ] });
  const unfinished = tool(raw.slice(0, raw.indexOf("After") + 2), "artifact_update");
  expect(project(unfinished, base)).toEqual([{ ...saved, body: expected.body }]);
  expect(project(tool(raw, "artifact_update"), base)).toEqual([expected]);

  const textArgs = JSON.stringify({ id: "art_garden", edits: [{ find: "Before", replace: "After" }] });
  const openText = tool(textArgs.slice(0, textArgs.indexOf("After") + 2), "artifact_update");
  expect(project(openText, base)).toEqual([{ ...saved, title: "Af" }]);
});

test("completed invalid decks and other workspace kinds are ignored", () => {
  const raw = JSON.stringify({ kind: "design", content: deck({ id: "s", layout: "title", title: "A", body: "" }) });
  const invalid = JSON.stringify({ kind: "slides", content: '{"version":1,"slides":[]}' });
  expect(project(tool(raw))).toBeUndefined();
  expect(project(tool(invalid))).toBeUndefined();
});
