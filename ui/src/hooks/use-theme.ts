import { useCallback } from "react";
import { setBrowserChoice, useResolvedAppearance } from "@/lib/appearance";

type Theme = "light" | "dark" | "system";

/**
 * Light, dark or the OS's. This browser's choice wins; without one, the instance's default
 * (settings.appearance.theme), else dark. Applied by lib/appearance.ts (and before the first
 * paint by the inline script in index.html).
 */
export function useTheme() {
  const resolved = useResolvedAppearance();
  const setTheme = useCallback((t: Theme) => setBrowserChoice("theme", t), []);
  return { theme: resolved.theme, resolved: resolved.dark ? "dark" : "light", setTheme } as const;
}
