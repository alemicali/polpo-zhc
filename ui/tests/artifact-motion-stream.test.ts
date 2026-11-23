import { expect, test } from "vitest";
import { parseMotion, sceneOffsets, type MotionLayer, type MotionProject, type MotionScene } from "../src/components/artifacts/artifact-motion-model";
import type { ToolCallInfo } from "../src/hooks/use-polpo";
import { projectMotionStream } from "../src/lib/artifact-motion-stream";
import { artifactStreamArgs } from "../src/lib/artifact-stream-text";

function project(argumentsText: string, base?: string): string | undefined {
  const tool: ToolCallInfo = { id: "motion-call", name: base ? "artifact_update" : "artifact_create", state: "preparing", argumentsText };
  return projectMotionStream(tool, artifactStreamArgs(tool), base);
}

const heading: MotionLayer = { id: "heading", type: "text", x: 20, y: 30, width: 320, height: 80, color: "#ffffff", text: 'Opening "title"' };
const circle: MotionLayer = { id: "circle", type: "ellipse", x: 4, y: 60, width: 36, height: 36, color: "#f3f3f3" };
const intro: MotionScene = { id: "intro", name: "Opening", duration: 3, background: "#102030", layers: [heading, circle] };
const outro: MotionScene = { id: "outro", name: "Closing", duration: 2, background: "#405060", layers: [] };
const original: MotionProject = { version: 1, width: 1280, height: 720, scenes: [intro, outro] };
const base = JSON.stringify(original);

test("Motion paints finished scene and layer properties while the JSON arguments stream", () => {
  const args = JSON.stringify({ type: "html", kind: "motion", content: base });
  const states: string[] = [];
  for (let end = 1; end <= args.length; end++) {
    const content = project(args.slice(0, end));
    if (!content) continue;
    const draft = parseMotion(content)!;
    const signature = draft.scenes.map(scene => `${scene.id}:${scene.layers.map(layer => layer.id).join(",")}`).join("|");
    if (states.at(-1) !== signature) states.push(signature);
    expect(draft.scenes[0].background).toBe(intro.background);
    const text = draft.scenes[0].layers[0]?.text;
    if (text !== undefined) expect(text).toBe(heading.text);
  }
  expect(states).toEqual(["intro:", "intro:heading", "intro:heading,circle", "intro:heading,circle|outro:"]);
  expect(project(args)).toBe(base);
});

test("a partial update preserves sibling layers, scene order and established timeline positions", () => {
  const content = JSON.stringify({
    ...original,
    width: 1024,
    scenes: [{ ...outro, duration: 5, background: "#ffeecc" }, { ...intro, layers: [{ ...heading, text: "New opening" }] }],
  });
  const args = JSON.stringify({ id: "art_motion", content });
  const center = args.indexOf("New opening") + "New opening".length + 3;
  const partial = parseMotion(project(args.slice(0, center), base)!);
  expect(partial?.scenes.map(scene => scene.id)).toEqual(["intro", "outro"]);
  expect(partial?.scenes[0].layers).toEqual([{ ...heading, text: "New opening" }, circle]);
  expect(partial?.scenes[1].background).toBe("#ffeecc");
  expect(partial?.width).toBe(1280);
  expect(sceneOffsets(partial!)).toEqual([0, 3, 5]);
  expect(project(args, base)).toBe(content);
});

test("Motion tool edits apply as complete pairs to the persisted source", () => {
  const args = JSON.stringify({ id: "art_motion", edits: [{ find: "#102030", replace: "#ffffff" }, { find: "#405060", replace: "#eef066" }] });
  const early = args.slice(0, args.indexOf("#eef066") + 3);
  const draft = parseMotion(project(early, base)!);
  expect(draft?.scenes.map(scene => scene.background)).toEqual(["#ffffff", "#405060"]);
  expect(parseMotion(project(args, base)!)?.scenes.map(scene => scene.background)).toEqual(["#ffffff", "#eef066"]);
  expect(project(args.slice(0, args.indexOf("#ffffff") + 3), base)).toBeUndefined();
});

test("an invalid layer cannot erase the last valid snapshot, and complete malformed content is rejected", () => {
  const content = JSON.stringify({ ...original, scenes: [{ ...intro, layers: [{ ...heading, width: 0 }] }, outro] });
  const args = JSON.stringify({ id: "art_motion", content });
  const early = args.slice(0, args.indexOf("Closing") - 1);
  expect(parseMotion(project(early, base)!)?.scenes[0].layers).toEqual(intro.layers);
  expect(project(args, base)).toBeUndefined();
  expect(project(JSON.stringify({ kind: "slides", content: base }))).toBeUndefined();
});
