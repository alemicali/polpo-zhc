import { useState, useEffect, useCallback } from "react";
import { APPEARANCE_SCOPE_EVENT, scopedStorageKey } from "@/lib/appearance";

type Theme = "light" | "dark" | "system";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const resolved = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function readTheme(): Theme {
  const saved = localStorage.getItem(scopedStorageKey("polpo-theme")) as Theme | null;
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "dark";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return readTheme();
  });

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(scopedStorageKey("polpo-theme"), t);
    applyTheme(t);
  }, []);

  // Apply on mount + listen for system changes
  useEffect(() => {
    applyTheme(theme);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  useEffect(() => {
    const syncScopedTheme = () => {
      const next = readTheme();
      setThemeState(next);
      applyTheme(next);
    };
    window.addEventListener(APPEARANCE_SCOPE_EVENT, syncScopedTheme);
    return () => window.removeEventListener(APPEARANCE_SCOPE_EVENT, syncScopedTheme);
  }, []);

  const resolved: "light" | "dark" =
    theme === "system" ? getSystemTheme() : theme;

  return { theme, resolved, setTheme } as const;
}

export function bootstrapTheme(): void {
  const applySaved = () => applyTheme(readTheme());
  applySaved();

  window.addEventListener(APPEARANCE_SCOPE_EVENT, applySaved);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", () => {
    if (readTheme() === "system") applyTheme("system");
  });
}
