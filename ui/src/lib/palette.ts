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

import { useCallback, useEffect, useState } from "react";

export type Palette = "tide" | "brutal" | "editorial" | "cyber" | "mono";

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

const DEFAULT_PALETTE: Palette = "tide";
const STORAGE_KEY = "polpo-palette";

function isPalette(v: string | null): v is Palette {
  return !!v && PALETTES.some((p) => p.id === v);
}

function applyPalette(p: Palette) {
  document.documentElement.dataset.palette = p;
}

/**
 * Read/write the current palette. Persists to localStorage so the choice
 * survives reloads. Same shape as useTheme() for symmetry.
 */
export function usePalette() {
  const [palette, setPaletteState] = useState<Palette>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return isPalette(saved) ? saved : DEFAULT_PALETTE;
    } catch {
      return DEFAULT_PALETTE;
    }
  });

  const setPalette = useCallback((p: Palette) => {
    setPaletteState(p);
    try { localStorage.setItem(STORAGE_KEY, p); } catch { /* ignore */ }
    applyPalette(p);
  }, []);

  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  return { palette, setPalette } as const;
}

/**
 * Apply the saved palette as early as possible (before React mounts) to
 * avoid a flash of wrong colours. Call from main.tsx.
 */
export function bootstrapPalette(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    applyPalette(isPalette(saved) ? saved : DEFAULT_PALETTE);
  } catch {
    applyPalette(DEFAULT_PALETTE);
  }
}
