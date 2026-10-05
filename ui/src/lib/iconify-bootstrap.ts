import { addCollection } from "@iconify/react";
import { logosSubset, vscodeIconsSubset } from "@/generated/icon-subsets";

let logosLoaded = false;
let vscodeLoaded = false;

/** Registers only the logo glyphs referenced by the UI. */
export function ensureLogosPack(): Promise<void> {
  if (!logosLoaded) {
    addCollection(logosSubset as Parameters<typeof addCollection>[0]);
    logosLoaded = true;
  }
  return Promise.resolve();
}

/** Registers the curated file-type subset used by the Changes panel. */
export function ensureVscodeIconsPack(): Promise<void> {
  if (!vscodeLoaded) {
    addCollection(vscodeIconsSubset as Parameters<typeof addCollection>[0]);
    vscodeLoaded = true;
  }
  return Promise.resolve();
}
