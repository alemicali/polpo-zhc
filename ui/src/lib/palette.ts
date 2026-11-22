/**
 * Palette layer — sits on top of the light/dark theme so the user picks
 * BOTH a mode (light/dark/system) AND a palette personality.
 *
 * Each palette overrides not only colours but also geometry (`--radius`)
 * and shadow tokens to give a genuinely different feel — not just a
 * different hue on the same skeleton.
 *
 * Implementation: each palette is a pair of CSS variable blocks defined in
 * index.css, scoped by `data-palette="..."` on the <html> element. Switching
 * is just an attribute swap.
 */

import { useCallback } from "react";
import { setBrowserChoice, useResolvedAppearance } from "@/lib/appearance";

export type Palette = "tide" | "lovable" | "chatgpt" | "claude" | "brutal" | "editorial" | "redline" | "cyber" | "mono";

export interface PaletteMeta {
  id: Palette;
  name: string;
  /** One-line vibe — shown under the palette name in the picker. */
  blurb: string;
  /** Three colour stops shown as a mini swatch in the picker (light variant). */
  swatchLight: [string, string, string];
  /** Three colour stops shown as a mini swatch in the picker (dark variant). */
  swatchDark: [string, string, string];
}

export const PALETTES: PaletteMeta[] = [
  {
    id: "tide",
    name: "Tide Pool",
    blurb: "Coastal teal · soft & friendly",
    swatchLight: ["oklch(0.985 0.006 215)", "oklch(0.6 0.115 205)", "oklch(0.7 0.155 30)"],
    swatchDark:  ["oklch(0.1 0.025 260)",   "oklch(0.7 0.15 200)",  "oklch(0.68 0.18 330)"],
  },
  {
    id: "lovable",
    name: "Lovable",
    blurb: "Warm workspace · royal blue · generous surfaces",
    swatchLight: ["#f7f5f2", "#1b1b1b", "#315efb"],
    swatchDark: ["#171615", "#f5f2ed", "#7590ff"],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    blurb: "Neutral monochrome · quiet chrome · high contrast",
    swatchLight: ["#ffffff", "#0d0d0d", "#e7e7e7"],
    swatchDark: ["#212121", "#ececec", "#2f2f2f"],
  },
  {
    id: "claude",
    name: "Claude",
    blurb: "Warm paper · terracotta · editorial type",
    swatchLight: ["#f7f6f2", "#2f2e2b", "#c96442"],
    swatchDark: ["#1f1e1b", "#eeeae3", "#e08b6c"],
  },
  {
    id: "brutal",
    name: "Brutalist",
    blurb: "Black & white · zero radius · hard shadow",
    swatchLight: ["oklch(1 0 0)",            "oklch(0 0 0)",         "oklch(0.62 0.22 25)"],
    swatchDark:  ["oklch(0 0 0)",            "oklch(1 0 0)",         "oklch(0.7 0.22 25)"],
  },
  {
    id: "editorial",
    name: "Editorial",
    blurb: "Warm cream · large radius · ink red",
    swatchLight: ["oklch(0.965 0.022 75)",   "oklch(0.42 0.13 25)",  "oklch(0.66 0.12 75)"],
    swatchDark:  ["oklch(0.165 0.022 50)",   "oklch(0.7 0.13 35)",   "oklch(0.74 0.12 75)"],
  },
  {
    id: "redline",
    name: "Redline Paper",
    blurb: "Newsprint white · signal red · zero radius",
    swatchLight: ["#f5f5f1", "#171717", "#e93f33"],
    swatchDark: ["#151513", "#f3f3ee", "#ff6257"],
  },
  {
    id: "cyber",
    name: "Cyber",
    blurb: "Neon on near-black · sharp · glow",
    swatchLight: ["oklch(0.97 0.005 240)",   "oklch(0.55 0.16 200)", "oklch(0.62 0.22 335)"],
    swatchDark:  ["oklch(0.08 0.02 250)",    "oklch(0.78 0.18 195)", "oklch(0.7 0.25 335)"],
  },
  {
    id: "mono",
    name: "Mono",
    blurb: "Pure greys · single hue accent · zero radius",
    swatchLight: ["oklch(1 0 0)",            "oklch(0.18 0 0)",      "oklch(0.55 0.16 250)"],
    swatchDark:  ["oklch(0.1 0 0)",          "oklch(0.95 0 0)",      "oklch(0.65 0.18 250)"],
  },
];

/**
 * The current palette: this browser's choice, else the instance's default
 * (settings.appearance.palette), else Tide. Same shape as useTheme().
 */
export function usePalette() {
  const resolved = useResolvedAppearance();
  const palette = (PALETTES.some((p) => p.id === resolved.palette) ? resolved.palette : "tide") as Palette;
  const setPalette = useCallback((p: Palette) => setBrowserChoice("palette", p), []);
  return { palette, setPalette } as const;
}
