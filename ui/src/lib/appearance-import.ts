import { kit, type InstanceAppearance } from "@/lib/appearance";

/** A look from imported JSON ({ theme, palette, custom } or just the custom tokens), or an error. */
export function parseImportedAppearance(text: string): { ok: true; value: InstanceAppearance } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "Not valid JSON" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Expected an object" };
  const r = raw as Record<string, unknown>;
  const looksCustom = "light" in r || "dark" in r || "enabled" in r;
  const custom = (looksCustom ? r : r.custom) as unknown;
  const out: InstanceAppearance = {};
  if (r.theme !== undefined) {
    if (!kit.isTheme(r.theme)) return { ok: false, error: "theme must be light, dark or system" };
    out.theme = r.theme;
  }
  if (r.palette !== undefined) {
    if (!kit.isPalette(r.palette)) return { ok: false, error: `palette must be one of ${kit.PALETTES.join(", ")}` };
    out.palette = r.palette;
  }
  if (custom !== undefined) {
    if (!custom || typeof custom !== "object") return { ok: false, error: "custom must be an object" };
    const c = custom as Record<string, unknown>;
    for (const mode of ["light", "dark"] as const) {
      const tokens = c[mode];
      if (tokens === undefined) continue;
      if (!tokens || typeof tokens !== "object") return { ok: false, error: `${mode} must be an object of tokens` };
      for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
        const key = name === "text" ? "foreground" : name;
        if (!kit.TOKENS[key]) return { ok: false, error: `${mode}.${name} is not a token` };
        if (kit.tokenValue(key, value) === undefined) return { ok: false, error: `${mode}.${name}: ${String(value)} is not valid` };
      }
    }
    const n = kit.normalizeCustom(c);
    out.custom = { enabled: c.enabled === undefined ? true : n.enabled, derive: n.derive, light: n.light, dark: n.dark };
  }
  if (out.theme === undefined && out.palette === undefined && out.custom === undefined) return { ok: false, error: "Nothing to import (theme, palette or custom)" };
  return { ok: true, value: out };
}
