import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { DESIGN_BLANK_BOARD_STYLE } from "./artifact-content-palette";

export type Artboard = { id: string; name: string; x: number; y: number; width: number; height: number; html: string };
export type DesignPage = { id: string; name: string; boards: Artboard[] };
export type DesignWorkspace = { pages: DesignPage[] };

export const BLANK_BOARD =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + DESIGN_BLANK_BOARD_STYLE + '</style></head><body></body></html>';

export function createBoard(id: string, name: string, html = BLANK_BOARD, x = 0, y = 0): Artboard {
  return { id, name, html, x, y, width: 1024, height: 680 };
}

const MARKER = "data-polpo-design-workspace";
type Element = DefaultTreeAdapterTypes.Element;

export function findDesignMetadata(html: string) {
  if (!html.includes(MARKER)) return;
  const pending: DefaultTreeAdapterTypes.Node[] = [parse(html, { sourceCodeLocationInfo: true })];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "script" && node.attrs.some((a) => a.name === MARKER))
      return node as Element;
    if ("childNodes" in node) pending.push(...node.childNodes);
  }
}

export function readDesign(html: string): DesignWorkspace {
  const standard = { pages: [{ id: "page-1", name: "Page 1", boards: [createBoard("board-1", "Artboard 1", html)] }] };
  const node = findDesignMetadata(html);
  const range = node?.sourceCodeLocation;
  const text = node?.childNodes[0];
  if (!range || !text || !("value" in text)) return standard;
  try {
    const stored = JSON.parse(text.value);
    if (stored.version !== 1 || !Array.isArray(stored.pages) || !stored.pages.length) return standard;
    const pages = stored.pages as DesignPage[];
    if (
      !pages.every(
        (p) =>
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          Array.isArray(p.boards) &&
          p.boards.length &&
          p.boards.every(
            (b) =>
              typeof b.id === "string" &&
              typeof b.name === "string" &&
              typeof b.html === "string" &&
              [b.width, b.height, b.x, b.y].every(Number.isFinite) &&
              b.width > 0 &&
              b.height > 0,
          ),
      )
    )
      return standard;
    pages[0].boards[0].html = html.slice(0, range.startOffset) + html.slice(range.endOffset);
    return { pages };
  } catch {
    return standard;
  }
}

// The primary artboard stays a standalone HTML document. The other boards use an inert JSON payload.
export function writeDesign(workspace: DesignWorkspace): string {
  const first = workspace.pages[0].boards[0];
  const meta = {
    version: 1,
    pages: workspace.pages.map((p, pi) => ({
      ...p,
      boards: p.boards.map((b, bi) => (pi === 0 && bi === 0 ? { ...b, html: "" } : b)),
    })),
  };
  const serialized = JSON.stringify(meta).replaceAll("<", "\\u003c");
  return first.html + '<script type="application/json" ' + MARKER + ">" + serialized + "</script>";
}
