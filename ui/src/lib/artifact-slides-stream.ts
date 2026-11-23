import { Allow, parse } from "partial-json";
import { isSlide, isSlideElement, parseSlides, type Slide, type SlideElement } from "@/components/artifacts/artifact-slides-format";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import { projectArtifactText } from "./artifact-stream-text";

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPartial(text: string): Record<string, unknown> {
  try { return fields(parse(text, Allow.COLLECTION)); } catch { return {}; }
}

function projectItems<T extends { id: string }>(items: unknown[], base: T[], project: (fields: Record<string, unknown>, previous?: T) => T | undefined) {
  const previous = new Map(base.map(item => [item.id, item]));
  const projected = new Map<string, T>();
  for (const item of items) {
    const draft = fields(item);
    if (typeof draft.id !== "string" || !draft.id || projected.has(draft.id)) continue;
    const original = previous.get(draft.id);
    const result = project(draft, original) ?? original;
    if (result) projected.set(draft.id, result);
  }
  return projected;
}

function projectElement(draft: Record<string, unknown>, previous?: SlideElement): SlideElement | undefined {
  // A partial media source must never displace the last valid element.
  const candidate = { ...previous, ...draft };
  if (isSlideElement(candidate)) return candidate;
}

function projectSlide(draft: Record<string, unknown>, previous?: Slide): Slide | undefined {
  const { elements, ...properties } = draft;
  const candidate = { layout: "content", title: "", body: "", ...previous, ...properties };
  if (Array.isArray(elements)) {
    const original = previous?.elements ?? [];
    const projected = projectItems(elements, original, projectElement);
    if (!previous && typeof draft.title !== "string" && typeof draft.body !== "string" && !projected.size) return;
    Object.assign(candidate, { elements: [...projected.values(), ...original.filter(element => !projected.has(element.id))] });
  } else if (!previous && typeof draft.title !== "string" && typeof draft.body !== "string") {
    return;
  }
  if (isSlide(candidate)) return candidate;
}

export function projectSlidesStream(tool: ToolCallInfo, args: Record<string, unknown>, base?: string): string | undefined {
  const kind = args.kind !== undefined && args.kind !== "slides" && tool.state === "preparing" && tool.argumentsText
    ? readPartial(tool.argumentsText).kind
    : args.kind;
  if (kind !== undefined && kind !== "slides") return;
  const source = projectArtifactText(tool, args, base);
  if (source && parseSlides(source.text)) return source.text;
  if (typeof args.content !== "string") {
    if (tool.state !== "preparing" || !Array.isArray(args.edits) || base === undefined) return;
    // A replacement may cut a quoted value in the middle of the deck. Recover
    // earlier closed edits instead of guessing at the malformed JSON suffix.
    const closed = readPartial(tool.argumentsText ?? "");
    const settled = projectArtifactText({ ...tool, state: "calling" }, closed, base);
    return settled && parseSlides(settled.text) ? settled.text : undefined;
  }
  if (!source || source.complete || !source.text.trimStart().startsWith("{")) return;
  // Both the tool envelope and its serialized content arrive in pieces. Allow open
  // slide and element containers, but wait for strings to close before displaying them.
  const draft = readPartial(source.text);
  if (draft.version !== 1 || !Array.isArray(draft.slides)) return;

  const original = base ? parseSlides(base)?.slides ?? [] : [];
  const projected = projectItems(draft.slides, original, projectSlide);
  if (!projected.size) return;
  return JSON.stringify({ version: 1, slides: [...projected.values(), ...original.filter(slide => !projected.has(slide.id))] });
}
