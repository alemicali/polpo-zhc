export const THEMES = {
  light: { bg: "#f7f7ef", fg: "#182d29", accent: "#3c7968" },
  dark: { bg: "#182d29", fg: "#f7f7ef", accent: "#b6e1cd" },
  accent: { bg: "#d1ece1", fg: "#182d29", accent: "#265c50" },
} as const;
const LAYOUTS = ["title", "content", "split"] as const;
export type Theme = keyof typeof THEMES;
export type Layout = typeof LAYOUTS[number];
export type Shape = "text" | "rect" | "ellipse";
export type SlideElement = {
  id: string;
  type: Shape;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  color?: string;
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
const isPercent = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 100;

function isElement(value: unknown): value is SlideElement {
  return isRecord(value) && typeof value.id === "string" && (value.type === "text" || value.type === "rect" || value.type === "ellipse")
    && isPercent(value.x) && isPercent(value.y) && isPercent(value.w) && isPercent(value.h) && value.x + value.w <= 100.001 && value.y + value.h <= 100.001
    && isText(value.text) && (value.color === undefined || isHex(value.color))
    && (value.fontSize === undefined || (isPercent(value.fontSize) && value.fontSize >= 1 && value.fontSize <= 12));
}

function isSlide(value: unknown): value is Slide {
  return isRecord(value) && typeof value.id === "string" && LAYOUTS.includes(value.layout as Layout)
    && (value.theme === undefined || (typeof value.theme === "string" && Object.hasOwn(THEMES, value.theme)))
    && typeof value.title === "string" && typeof value.body === "string" && isText(value.secondary) && isText(value.notes)
    && (value.hidden === undefined || typeof value.hidden === "boolean")
    && (value.elements === undefined || (Array.isArray(value.elements) && value.elements.every(isElement)
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
