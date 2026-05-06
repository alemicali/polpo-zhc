/**
 * Iconify pack loaders — lazy by design.
 *
 * The full `logos` and `vscode-icons` JSON packs are ~7 MB and ~3.5 MB raw
 * respectively. Importing them eagerly from main.tsx drowned the entry
 * chunk (13 MB → 4.4 MB gz). Each pack is now behind its own dynamic import
 * so it lands in a separate chunk and is fetched only when a component that
 * needs it mounts.
 */
import { addCollection } from "@iconify/react";

let logosPromise: Promise<void> | null = null;
let vscodePromise: Promise<void> | null = null;

/** Lazy-loads the `logos` pack (Telegram, Slack, OpenAI, Anthropic, …). */
export function ensureLogosPack(): Promise<void> {
  if (!logosPromise) {
    logosPromise = import("@iconify-json/logos/icons.json")
      .then(({ default: pack }) => {
        addCollection(pack as Parameters<typeof addCollection>[0]);
      })
      .catch((err) => {
        // Don't block the UI on a failed JSON fetch — fall through to the
        // fallback rendering each component already has.
        logosPromise = null;
        console.warn("[iconify] logos pack failed to load", err);
      });
  }
  return logosPromise;
}

/** Lazy-loads the `vscode-icons` pack (file-type icons in the Changes panel). */
export function ensureVscodeIconsPack(): Promise<void> {
  if (!vscodePromise) {
    vscodePromise = import("@iconify-json/vscode-icons/icons.json")
      .then(({ default: pack }) => {
        addCollection(pack as Parameters<typeof addCollection>[0]);
      })
      .catch((err) => {
        vscodePromise = null;
        console.warn("[iconify] vscode-icons pack failed to load", err);
      });
  }
  return vscodePromise;
}
