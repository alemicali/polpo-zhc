/**
 * Bootstrap Iconify with the offline `logos` pack so brand icons
 * (Telegram, Slack, WhatsApp, Gmail, Webhook, …) render without hitting
 * the Iconify CDN at runtime.
 *
 * Imports the whole pack (~600 KB JSON) once and registers it. Tree-shaking
 * of icon JSON isn't useful with the standard import, so accept the cost
 * for now and revisit if bundle pressure grows.
 *
 * Call from main.tsx before React mounts.
 */

import { addCollection } from "@iconify/react";
import logosPack from "@iconify-json/logos/icons.json";
import vscodeIconsPack from "@iconify-json/vscode-icons/icons.json";

let booted = false;

export function bootstrapIconify(): void {
  if (booted) return;
  booted = true;
  // Type-assert: the JSON shape matches Iconify's IconifyJSON schema
  addCollection(logosPack as Parameters<typeof addCollection>[0]);
  // VS Code's file/folder icon set — used by the coding page's changes/files
  // panels to render per-extension icons. Pack is ~3.5 MB raw JSON; gzip
  // compresses it to ~500 KB which we accept for offline rendering.
  addCollection(vscodeIconsPack as Parameters<typeof addCollection>[0]);
}
