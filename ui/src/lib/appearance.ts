import { useCallback, useEffect, useState } from "react";
import { config } from "@/lib/config";

export type AppearanceMode = "light" | "dark";

export interface AppearanceThemeSettings {
  primary: string;
  secondary: string;
  text: string;
  fontFamily: string;
  radius: number;
}

export interface AppearanceSettings {
  enabled: boolean;
  light: AppearanceThemeSettings;
  dark: AppearanceThemeSettings;
}

const STORAGE_KEY_PREFIX = "polpo-appearance";
export const APPEARANCE_SCOPE_EVENT = "polpo-appearance-scope-change";
const VALUE_EVENT = "polpo-appearance-change";
const STYLE_ID = "polpo-appearance-overrides";
let currentScope = "default";

export const DEFAULT_LIGHT_APPEARANCE: AppearanceThemeSettings = {
  primary: "#2563eb",
  secondary: "#f1f5f9",
  text: "#0f172a",
  fontFamily: "\"Satoshi\", ui-sans-serif, system-ui, sans-serif",
  radius: 8,
};

export const DEFAULT_DARK_APPEARANCE: AppearanceThemeSettings = {
  primary: "#60a5fa",
  secondary: "#1f2937",
  text: "#f8fafc",
  fontFamily: "\"Satoshi\", ui-sans-serif, system-ui, sans-serif",
  radius: 8,
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  enabled: false,
  light: DEFAULT_LIGHT_APPEARANCE,
  dark: DEFAULT_DARK_APPEARANCE,
};

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "default";
}

function apiScope(): string {
  const raw = config.baseUrl || (typeof window !== "undefined" ? window.location.origin : "local");
  try {
    const url = new URL(raw, window.location.origin);
    const path = url.pathname.replace(/\/+$/, "");
    return slug(`${url.origin}${path}`);
  } catch {
    return slug(raw);
  }
}

export function instanceScope(): string {
  return currentScope;
}

export function scopedStorageKey(key: string): string {
  return `${key}:${apiScope()}:${instanceScope()}`;
}

function storageKey(): string {
  return scopedStorageKey(STORAGE_KEY_PREFIX);
}

function normalizeTheme(
  value: Partial<AppearanceThemeSettings> | null | undefined,
  fallback: AppearanceThemeSettings,
): AppearanceThemeSettings {
  return {
    primary: isHexColor(value?.primary ?? "") ? value!.primary! : fallback.primary,
    secondary: isHexColor(value?.secondary ?? "") ? value!.secondary! : fallback.secondary,
    text: isHexColor(value?.text ?? "") ? value!.text! : fallback.text,
    fontFamily: typeof value?.fontFamily === "string" && value.fontFamily.trim() && !/[;{}\n\r]/.test(value.fontFamily)
      ? value.fontFamily.trim()
      : fallback.fontFamily,
    radius: typeof value?.radius === "number"
      ? Math.min(24, Math.max(0, value.radius))
      : fallback.radius,
  };
}

function normalizeAppearance(value: Partial<AppearanceSettings & AppearanceThemeSettings & { accent?: string }> | null | undefined): AppearanceSettings {
  const legacyTheme = value
    ? normalizeTheme(
        {
          primary: value.primary,
          secondary: value.secondary ?? value.accent,
          text: value.text,
          fontFamily: value.fontFamily,
          radius: value.radius,
        },
        DEFAULT_LIGHT_APPEARANCE,
      )
    : DEFAULT_LIGHT_APPEARANCE;

  return {
    enabled: value?.enabled === true,
    light: normalizeTheme(value?.light ?? legacyTheme, DEFAULT_LIGHT_APPEARANCE),
    dark: normalizeTheme(value?.dark ?? (value?.light ? undefined : legacyTheme), DEFAULT_DARK_APPEARANCE),
  };
}

function readableForeground(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.62 ? "#0f172a" : "#ffffff";
}

function ensureStyleElement(): HTMLStyleElement {
  let element = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ID;
    document.head.appendChild(element);
  }
  return element;
}

function removeInlineAppearanceProperties(): void {
  const root = document.documentElement;
  for (const property of appearanceProperties) {
    root.style.removeProperty(property);
  }
}

function themeCss(theme: AppearanceThemeSettings): string {
  const properties: Record<string, string> = {
    "--primary": theme.primary,
    "--ring": theme.primary,
    "--sidebar-primary": theme.primary,
    "--primary-foreground": readableForeground(theme.primary),
    "--sidebar-primary-foreground": readableForeground(theme.primary),
    "--secondary": theme.secondary,
    "--accent": theme.secondary,
    "--secondary-foreground": readableForeground(theme.secondary),
    "--accent-foreground": readableForeground(theme.secondary),
    "--foreground": theme.text,
    "--card-foreground": theme.text,
    "--popover-foreground": theme.text,
    "--sidebar-foreground": theme.text,
    "--radius": `${theme.radius}px`,
    "--app-font-family": theme.fontFamily,
    "--font-sans": theme.fontFamily,
  };

  return Object.entries(properties)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");
}

function applyThemeStyles(settings: AppearanceSettings): void {
  const style = ensureStyleElement();
  style.textContent = [
    ":root, :root[data-palette] {",
    themeCss(settings.light),
    "}",
    ":root.dark, :root.dark[data-palette] {",
    themeCss(settings.dark),
    "}",
  ].join("\n");
}

const appearanceProperties = [
  "--primary",
  "--ring",
  "--sidebar-primary",
  "--primary-foreground",
  "--sidebar-primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent",
  "--accent-foreground",
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
  "--sidebar-foreground",
  "--radius",
  "--app-font-family",
  "--font-sans",
];

function clearAppearanceStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

export function applyAppearance(settings: AppearanceSettings): void {
  removeInlineAppearanceProperties();
  if (!settings.enabled) {
    clearAppearanceStyle();
    return;
  }

  applyThemeStyles(settings);
}

function readAppearance(): AppearanceSettings {
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(storageKey()) ?? "null"));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function setAppearanceScope(scope: { org?: string; project?: string }): void {
  const nextScope = slug(scope.org ?? scope.project ?? "default");
  if (currentScope === nextScope) return;
  currentScope = nextScope;
  window.dispatchEvent(new Event(APPEARANCE_SCOPE_EVENT));
}

export function useAppearance() {
  const [appearance, setAppearanceState] = useState<AppearanceSettings>(readAppearance);

  const setAppearance = useCallback((next: AppearanceSettings) => {
    const normalized = normalizeAppearance(next);
    setAppearanceState(normalized);
    try { localStorage.setItem(storageKey(), JSON.stringify(normalized)); } catch { /* ignore */ }
    applyAppearance(normalized);
    window.dispatchEvent(new Event(VALUE_EVENT));
  }, []);

  const resetAppearance = useCallback(() => {
    setAppearance(DEFAULT_APPEARANCE);
  }, [setAppearance]);

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    const syncScopedAppearance = () => {
      const scoped = readAppearance();
      setAppearanceState(scoped);
      applyAppearance(scoped);
    };
    window.addEventListener(APPEARANCE_SCOPE_EVENT, syncScopedAppearance);
    window.addEventListener(VALUE_EVENT, syncScopedAppearance);
    return () => {
      window.removeEventListener(APPEARANCE_SCOPE_EVENT, syncScopedAppearance);
      window.removeEventListener(VALUE_EVENT, syncScopedAppearance);
    };
  }, []);

  return { appearance, setAppearance, resetAppearance } as const;
}

export function bootstrapAppearance(): void {
  const applySaved = () => applyAppearance(readAppearance());
  applySaved();

  window.addEventListener(APPEARANCE_SCOPE_EVENT, applySaved);
}
