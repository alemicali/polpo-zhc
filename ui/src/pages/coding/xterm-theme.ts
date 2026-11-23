import type { ITheme, Terminal } from "@xterm/xterm";
import { APPEARANCE_CHANGE_EVENT } from "@/lib/appearance";

/**
 * xterm.js draws on a canvas, so it cannot read CSS variables: build its theme from the look's
 * tokens at runtime (background = --card, cursor = --primary, selection = --accent, the ANSI colours
 * from the status and chart tokens) and apply it again whenever the appearance changes.
 */

const FALLBACK_FONT = "Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** Resolve any CSS colour (var(), color-mix(), oklch()…) to #rrggbb[aa], which xterm can parse. */
function resolver(): { color: (css: string) => string | undefined; dispose: () => void } {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return {
    color(css) {
      probe.style.color = "";
      probe.style.color = css;
      const computed = getComputedStyle(probe).color;
      if (!computed || !ctx) return undefined;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = computed;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ""}`;
    },
    dispose() {
      probe.remove();
    },
  };
}

/** A bright ANSI variant: the colour pulled toward the foreground (lighter on dark, darker on light). */
const bright = (token: string) => `color-mix(in oklch, var(${token}) 75%, var(--foreground))`;

export function terminalTheme(): ITheme {
  const r = resolver();
  try {
    const c = (css: string) => r.color(css);
    return {
      background: c("var(--card)"),
      foreground: c("var(--card-foreground)"),
      cursor: c("var(--primary)"),
      cursorAccent: c("var(--card)"),
      selectionBackground: c("color-mix(in oklch, var(--accent) 80%, transparent)"),
      selectionForeground: c("var(--accent-foreground)"),
      black: c("var(--muted)"),
      red: c("var(--destructive)"),
      green: c("var(--success)"),
      yellow: c("var(--warning)"),
      blue: c("var(--info)"),
      magenta: c("var(--chart-5)"),
      cyan: c("var(--chart-1)"),
      white: c("color-mix(in oklch, var(--card-foreground) 80%, var(--card))"),
      brightBlack: c("var(--muted-foreground)"),
      brightRed: c(bright("--destructive")),
      brightGreen: c(bright("--success")),
      brightYellow: c(bright("--warning")),
      brightBlue: c(bright("--info")),
      brightMagenta: c(bright("--chart-5")),
      brightCyan: c(bright("--chart-1")),
      brightWhite: c("var(--card-foreground)"),
    };
  } finally {
    r.dispose();
  }
}

/** The terminal's font size in px: the look's small text (--text-small, 13px by default). */
export function terminalFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--text-small").trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 13;
  if (raw.endsWith("rem")) {
    const base = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.round(n * base);
  }
  return Math.round(n);
}

export function terminalFontFamily(): string {
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return font || FALLBACK_FONT;
}

/**
 * Apply the look's theme and mono font to a terminal now and on every appearance change (the
 * palette, light/dark, custom tokens). Returns the cleanup.
 */
export function followAppearance(term: Terminal): () => void {
  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      term.options.theme = terminalTheme();
      term.options.fontFamily = terminalFontFamily();
      term.options.fontSize = terminalFontSize();
    });
  };
  apply();
  window.addEventListener(APPEARANCE_CHANGE_EVENT, apply);
  // The look lands on <html> (the dark class, data attributes, inline custom tokens).
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-palette", "data-theme"] });
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener(APPEARANCE_CHANGE_EVENT, apply);
    observer.disconnect();
  };
}
