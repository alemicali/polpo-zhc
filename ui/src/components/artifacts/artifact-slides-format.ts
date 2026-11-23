import { SLIDE_THEMES } from "./artifact-content-palette";

/** The slide themes (content colours: shown as chosen and written into the .pptx). */
export const THEMES = SLIDE_THEMES;
const LAYOUTS = ["title", "content", "split"] as const;
export type Theme = keyof typeof THEMES;
export type Layout = typeof LAYOUTS[number];
export type Shape = "text" | "rect" | "ellipse";
export type SlideElement = {
  id: string;
  type: Shape | "image" | "video" | "table";
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  color?: string;
  src?: string;
  alt?: string;
  poster?: string;
  cells?: string[][];
  header?: boolean;
  fontSize?: number;
};
export type Slide = {
  id: string;
  layout: Layout;
  theme?: Theme;
  title: string;
  body: string;
  secondary?: string;
  notes?: string;
  hidden?: boolean;
  elements?: SlideElement[];
};
type Deck = { version: 1; slides: Slide[] };

const starter: Deck = { version: 1, slides: [{ id: "slide-1", layout: "title", title: "Untitled presentation", body: "" }] };
export const SLIDES_STARTER = JSON.stringify(starter, null, 2);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isHex = (value: unknown): value is string => typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value);
const isText = (value: unknown): boolean => value === undefined || typeof value === "string";
export const MAX_SLIDE_TABLE_DIMENSION = 20;
const imageData = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const videoData = /^data:video\/(?:mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/;
const isPercent = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 100;

export function isLinkableSlideVideo(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === "https:" && !url.username && !url.password && /\.(?:mp4|webm)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isSlideTable(cells: unknown): cells is string[][] {
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_SLIDE_TABLE_DIMENSION) return false;
  const first: unknown = cells[0];
  if (!Array.isArray(first) || first.length < 1 || first.length > MAX_SLIDE_TABLE_DIMENSION) return false;
  return cells.every((row: unknown) => Array.isArray(row) && row.length === first.length && row.every((cell: unknown) => typeof cell === "string"));
}

export function slideTableFontSize(element: SlideElement): number {
  const rows = element.cells?.length ?? 1;
  const columns = element.cells?.[0]?.length ?? 1;
  return Math.max(0.32, Math.min(1.7, element.h / rows / 2.8, element.w / columns / 7));
}

export function isSlideElement(value: unknown): value is SlideElement {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return false;
  if (!isPercent(value.x) || !isPercent(value.y) || !isPercent(value.w) || !isPercent(value.h) || value.x + value.w > 100.001 || value.y + value.h > 100.001) return false;
  if (value.type === "table") {
    return value.w > 0 && value.h > 0 && isSlideTable(value.cells) && (value.header === undefined || typeof value.header === "boolean");
  }
  if (value.type === "image" || value.type === "video") {
    if (!value.w || !value.h || typeof value.src !== "string" || !isText(value.alt)) return false;
    if (value.type === "image") return imageData.test(value.src);
    return (videoData.test(value.src) || isLinkableSlideVideo(value.src)) && (value.poster === undefined || (typeof value.poster === "string" && imageData.test(value.poster)));
  }
  return (value.type === "text" || value.type === "rect" || value.type === "ellipse") && isText(value.text) && (value.color === undefined || isHex(value.color))
    && (value.fontSize === undefined || (isPercent(value.fontSize) && value.fontSize >= 1 && value.fontSize <= 12));
}

export function isSlide(value: unknown): value is Slide {
  return isRecord(value) && typeof value.id === "string" && LAYOUTS.includes(value.layout as Layout)
    && (value.theme === undefined || (typeof value.theme === "string" && Object.hasOwn(THEMES, value.theme)))
    && typeof value.title === "string" && typeof value.body === "string" && isText(value.secondary) && isText(value.notes)
    && (value.hidden === undefined || typeof value.hidden === "boolean")
    && (value.elements === undefined || (Array.isArray(value.elements) && value.elements.every(isSlideElement)
      && new Set(value.elements.map((element) => element.id)).size === value.elements.length));
}

export function parseSlides(content: string): Deck | null {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.slides) || !value.slides.length || !value.slides.every(isSlide)) return null;
    if (new Set(value.slides.map((slide) => slide.id)).size !== value.slides.length) return null;
    return { version: 1, slides: value.slides };
  } catch {
    return null;
  }
}
