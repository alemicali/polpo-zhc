import { Allow, parse as parsePartial } from "partial-json";
import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import { artifactStaticPreview } from "@/components/artifacts/artifact-static-preview";
import {
  createBoard,
  findDesignMetadata,
  readDesign,
  writeDesign,
  type Artboard,
  type DesignPage,
} from "@/components/artifacts/design-workspace";
import { projectArtifactText } from "./artifact-stream-text";

type Parent = DefaultTreeAdapterTypes.ParentNode;
type Child = DefaultTreeAdapterTypes.ChildNode;
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const NONVISUAL = new Set(["base", "head", "link", "meta", "noscript", "script", "style", "template", "title"]);

function sameLayer(a: Child, b: Child) {
  if (!("tagName" in a) || !("tagName" in b) || a.tagName !== b.tagName) return false;
  const sourceId = a.attrs.find((attr) => attr.name === "id")?.value;
  return !sourceId || b.attrs.some((attr) => attr.name === "id" && attr.value === sourceId);
}

function visual(node: Child): boolean {
  if (!("tagName" in node)) return false;
  if (NONVISUAL.has(node.tagName)) return false;
  if (node.tagName === "html" || node.tagName === "body") return node.childNodes.some(visual);
  return true;
}

// Open wrappers can expose finished descendants. Their missing siblings keep the previous
// layout until the wrapper closes. A partial text node or raw-text element is never projected.
function projectChildren(parent: Parent, previous: Parent | undefined, text: string): boolean {
  const old = previous?.childNodes ?? [];
  const remaining = new Set(old);
  const next: Child[] = [];
  let produced = false;
  for (const [index, child] of parent.childNodes.entries()) {
    if (!("tagName" in child)) continue;
    const prior =
      old[index] && remaining.has(old[index]) && sameLayer(child, old[index])
        ? old[index]
        : old.find((other) => remaining.has(other) && sameLayer(child, other));
    if (prior) remaining.delete(prior);
    const element = prior && "tagName" in prior ? prior : undefined;
    const loc = child.sourceCodeLocation;
    const closed =
      !!loc?.endTag ||
      !!(
        loc?.startTag &&
        (VOID.has(child.tagName) ||
          text.slice(loc.startTag.endOffset - 2, loc.startTag.endOffset) === "/>" ||
          loc.endOffset < text.length)
      );
    if (child.tagName === "script" || child.tagName === "template" || child.tagName === "noscript") continue;
    if (closed) {
      next.push(child);
      produced = visual(child) || produced;
      continue;
    }
    if (child.tagName === "style" || child.tagName === "title") {
      if (element) next.push(element);
      continue;
    }
    const descendants = projectChildren(child, element, text);
    if (descendants || child.tagName === "html" || child.tagName === "head" || child.tagName === "body")
      next.push(child);
    else if (element) next.push(element);
    produced = descendants || produced;
  }
  for (const node of remaining) next.push(node);
  parent.childNodes = next;
  return produced;
}

function staticBoard(text: string, previous: string | undefined, complete: boolean) {
  if (!text.trimStart().startsWith("<")) return;
  const tree = parse(text, { sourceCodeLocationInfo: true });
  if (!complete && !projectChildren(tree, previous === undefined ? undefined : parse(previous), text)) return;
  return artifactStaticPreview(serialize(tree));
}

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => (v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : {});
function partialPages(text: string, mask: number): unknown[] {
  try {
    const doc = record(parsePartial(text, mask));
    return doc.version === 1 && Array.isArray(doc.pages) ? doc.pages : [];
  } catch {
    return [];
  }
}

function retainedBoard(b: Artboard): Artboard {
  return { ...b, html: artifactStaticPreview(b.html) };
}

export function projectDesignStream(
  tool: ToolCallInfo,
  args: Record<string, unknown>,
  base?: string,
): string | undefined {
  if (!["preparing", "calling", "completed"].includes(tool.state)) return;
  if (args.kind !== "design" && !(args.kind === undefined && tool.name === "artifact_update" && base !== undefined))
    return;
  if (args.type !== undefined && args.type !== "html") return;
  let input = args;
  if (tool.state === "preparing" && Array.isArray(args.edits) && typeof args.content !== "string") {
    let pairs: unknown;
    try {
      pairs = record(parsePartial(tool.argumentsText ?? "", Allow.COLLECTION)).edits;
    } catch {
      return;
    }
    if (!Array.isArray(pairs)) return;
    const edits = [];
    for (const item of pairs) {
      const edit = record(item);
      if (typeof edit.find !== "string" || typeof edit.replace !== "string") break;
      edits.push(edit);
    }
    if (!edits.length) return;
    input = { ...args, edits };
  }
  const source = projectArtifactText(tool, input, base);
  if (!source || !source.text.trimStart().startsWith("<")) return;
  const prior = base !== undefined ? readDesign(base) : undefined;
  const descriptor = findDesignMetadata(source.text);
  const oldBoard = prior?.pages[0]?.boards[0];
  const beforeMetadata = descriptor?.sourceCodeLocation
    ? source.text.slice(0, descriptor.sourceCodeLocation.startOffset)
    : source.text;
  const lead = staticBoard(beforeMetadata, oldBoard?.html, source.complete || !!descriptor);
  const body = descriptor?.childNodes[0];
  const payload = body && "value" in body ? body.value : "";
  const closed = partialPages(payload, Allow.COLLECTION);
  const relaxed = partialPages(payload, Allow.COLLECTION | Allow.STR);
  const pages: DesignPage[] = [];
  const seen = new Set<string>();
  let any = !!lead;
  for (const [pageIndex, value] of closed.entries()) {
    const page = record(value);
    if (typeof page.id !== "string" || typeof page.name !== "string" || !Array.isArray(page.boards)) continue;
    const oldPage = prior?.pages.find((p) => p.id === page.id);
    const incoming = record(relaxed[pageIndex]).boards;
    const boards: Artboard[] = [];
    for (const [boardIndex, item] of page.boards.entries()) {
      const b = record(item);
      if (typeof b.id !== "string" || typeof b.name !== "string" || seen.has(b.id)) continue;
      const previous = oldPage?.boards.find((o) => o.id === b.id);
      const board = previous ?? createBoard(b.id, b.name);
      const draft = record(Array.isArray(incoming) ? incoming[boardIndex] : undefined).html;
      const image =
        pageIndex === 0 && boardIndex === 0
          ? lead
          : typeof draft === "string"
            ? staticBoard(draft, previous?.html, typeof b.html === "string")
            : undefined;
      if (!image && !previous) continue;
      const next = { ...board, name: b.name, html: image ?? artifactStaticPreview(board.html) };
      for (const key of ["x", "y", "height", "width"] as const) {
        const n = b[key];
        if (
          typeof n === "number" &&
          Number.isFinite(n) &&
          Math.abs(n) <= 65536 &&
          (key === "x" || key === "y" || n > 0)
        )
          next[key] = n;
      }
      seen.add(next.id);
      boards.push(next);
      any ||= !!image;
    }
    if (!source.complete)
      for (const board of oldPage?.boards ?? []) if (!seen.has(board.id)) boards.push(retainedBoard(board));
    if (boards.length) pages.push({ id: page.id, name: page.name, boards });
  }
  if (!pages.length && lead) {
    const first = prior?.pages[0];
    const primary = { ...(oldBoard ?? createBoard("board-1", "Artboard 1")), html: lead };
    pages.push({
      id: first?.id ?? "page-1",
      name: first?.name ?? "Page 1",
      boards: [primary, ...(!source.complete && first ? first.boards.slice(1).map(retainedBoard) : [])],
    });
  }
  if (!any || !pages.length) return;
  if (!source.complete)
    for (const p of prior?.pages ?? [])
      if (!pages.some((n) => n.id === p.id)) pages.push({ ...p, boards: p.boards.map(retainedBoard) });
  if (!descriptor && !prior && pages.length === 1 && pages[0].boards.length === 1) return pages[0].boards[0].html;
  return writeDesign({ pages });
}
