/**
 * The instance's default look (settings.appearance): theme, palette and custom design tokens per
 * mode. Everyone sees it unless they customize their own browser. The same rules for the config
 * file, the API and MCP: anything not valid is refused with a message naming the field.
 *
 * custom.light / custom.dark take any subset of the dashboard's design tokens (APPEARANCE_TOKENS:
 * the CSS custom properties of ui/src/index.css). With custom.derive (default true) the dashboard
 * fills what is left from what is given: foregrounds by contrast, ring and sidebar from primary,
 * card and popover from background… (ui/src/lib/appearance-kit.ts).
 */

export const APPEARANCE_THEMES = ["light", "dark", "system"] as const;
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

/** The dashboard's palettes (ui/src/lib/palette.ts). */
export const APPEARANCE_PALETTES = ["tide", "lovable", "chatgpt", "claude", "brutal", "editorial", "redline", "cyber", "mono"] as const;
export type AppearancePalette = (typeof APPEARANCE_PALETTES)[number];

/**
 * How a token's value is checked: colour, font stack, radius (px 0–24), box-shadow, font size
 * (rem 0.5–6 / px 8–96), font weight (100–900), letter-spacing (em -0.1–0.3 / px -3–6, 0,
 * normal), text case (uppercase, none, capitalize, lowercase).
 */
export type AppearanceTokenKind = "color" | "font" | "radius" | "shadow" | "size" | "weight" | "tracking" | "case";

/** Editor groups, in the order the dashboard shows them. */
export const APPEARANCE_TOKEN_GROUPS = ["brand", "surfaces", "text", "borders", "sidebar", "charts", "status", "typography", "shape"] as const;
export type AppearanceTokenGroup = (typeof APPEARANCE_TOKEN_GROUPS)[number];

/**
 * Every design token an appearance may set: its name (camelCase), the CSS custom property it
 * writes, its group and kind. Keep in step with ui/src/lib/appearance-kit.ts (a test checks it).
 */
export const APPEARANCE_TOKENS = {
  primary: { css: "--primary", group: "brand", kind: "color" },
  secondary: { css: "--secondary", group: "brand", kind: "color" },
  accent: { css: "--accent", group: "brand", kind: "color" },
  background: { css: "--background", group: "surfaces", kind: "color" },
  card: { css: "--card", group: "surfaces", kind: "color" },
  popover: { css: "--popover", group: "surfaces", kind: "color" },
  muted: { css: "--muted", group: "surfaces", kind: "color" },
  foreground: { css: "--foreground", group: "text", kind: "color" },
  mutedForeground: { css: "--muted-foreground", group: "text", kind: "color" },
  cardForeground: { css: "--card-foreground", group: "text", kind: "color" },
  popoverForeground: { css: "--popover-foreground", group: "text", kind: "color" },
  primaryForeground: { css: "--primary-foreground", group: "text", kind: "color" },
  secondaryForeground: { css: "--secondary-foreground", group: "text", kind: "color" },
  accentForeground: { css: "--accent-foreground", group: "text", kind: "color" },
  border: { css: "--border", group: "borders", kind: "color" },
  input: { css: "--input", group: "borders", kind: "color" },
  ring: { css: "--ring", group: "borders", kind: "color" },
  sidebar: { css: "--sidebar", group: "sidebar", kind: "color" },
  sidebarForeground: { css: "--sidebar-foreground", group: "sidebar", kind: "color" },
  sidebarPrimary: { css: "--sidebar-primary", group: "sidebar", kind: "color" },
  sidebarPrimaryForeground: { css: "--sidebar-primary-foreground", group: "sidebar", kind: "color" },
  sidebarAccent: { css: "--sidebar-accent", group: "sidebar", kind: "color" },
  sidebarAccentForeground: { css: "--sidebar-accent-foreground", group: "sidebar", kind: "color" },
  sidebarBorder: { css: "--sidebar-border", group: "sidebar", kind: "color" },
  sidebarRing: { css: "--sidebar-ring", group: "sidebar", kind: "color" },
  chart1: { css: "--chart-1", group: "charts", kind: "color" },
  chart2: { css: "--chart-2", group: "charts", kind: "color" },
  chart3: { css: "--chart-3", group: "charts", kind: "color" },
  chart4: { css: "--chart-4", group: "charts", kind: "color" },
  chart5: { css: "--chart-5", group: "charts", kind: "color" },
  destructive: { css: "--destructive", group: "status", kind: "color" },
  destructiveForeground: { css: "--destructive-foreground", group: "status", kind: "color" },
  success: { css: "--success", group: "status", kind: "color" },
  successForeground: { css: "--success-foreground", group: "status", kind: "color" },
  warning: { css: "--warning", group: "status", kind: "color" },
  warningForeground: { css: "--warning-foreground", group: "status", kind: "color" },
  info: { css: "--info", group: "status", kind: "color" },
  infoForeground: { css: "--info-foreground", group: "status", kind: "color" },
  statusRunning: { css: "--status-running", group: "status", kind: "color" },
  statusQueued: { css: "--status-queued", group: "status", kind: "color" },
  statusAssigned: { css: "--status-assigned", group: "status", kind: "color" },
  fontFamily: { css: "--app-font-family", group: "typography", kind: "font" },
  headingFont: { css: "--app-heading-font", group: "typography", kind: "font" },
  monoFont: { css: "--app-mono-font", group: "typography", kind: "font" },
  textDisplay: { css: "--text-display", group: "typography", kind: "size" },
  textH1: { css: "--text-h1", group: "typography", kind: "size" },
  textH2: { css: "--text-h2", group: "typography", kind: "size" },
  textH3: { css: "--text-h3", group: "typography", kind: "size" },
  textBody: { css: "--text-body", group: "typography", kind: "size" },
  textSmall: { css: "--text-small", group: "typography", kind: "size" },
  textCaption: { css: "--text-caption", group: "typography", kind: "size" },
  textMicro: { css: "--text-micro", group: "typography", kind: "size" },
  headingWeight: { css: "--font-weight-heading", group: "typography", kind: "weight" },
  headingTracking: { css: "--tracking-heading", group: "typography", kind: "tracking" },
  labelTracking: { css: "--tracking-label", group: "typography", kind: "tracking" },
  labelCase: { css: "--label-transform", group: "typography", kind: "case" },
  radius: { css: "--radius", group: "shape", kind: "radius" },
  shadowCard: { css: "--shadow-card", group: "shape", kind: "shadow" },
  shadowRaised: { css: "--shadow-raised", group: "shape", kind: "shadow" },
} as const satisfies Record<string, { css: string; group: AppearanceTokenGroup; kind: AppearanceTokenKind }>;

export type AppearanceTokenName = keyof typeof APPEARANCE_TOKENS;
export const APPEARANCE_TOKEN_NAMES = Object.keys(APPEARANCE_TOKENS) as AppearanceTokenName[];

/** A colour in a syntax the dashboard's CSS uses: #rgb, #rrggbb(aa), or oklch/oklab/lab/lch/hsl/hsla/rgb/rgba(…). */
export const APPEARANCE_COLOR = /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:oklch|oklab|lab|lch|hsla?|rgba?)\(\s*[0-9a-zA-Z.%\s,/+-]{1,80}\))$/;
/** Legacy: #rrggbb only. */
export const APPEARANCE_HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * A CSS font stack: family names (quoted or not) separated by commas. No characters that could end
 * the declaration or open another (; { } < > \ / ( ) url…), at most 200 characters.
 */
export const APPEARANCE_FONT = /^[A-Za-z0-9 ,"'_.-]{1,200}$/;
/** A box-shadow: lengths, colours (as above) and commas; "none". No ; { } < > \ or url(). */
export const APPEARANCE_SHADOW = /^(none|[0-9a-zA-Z.%\s,/#()+-]{1,240})$/;
export const APPEARANCE_RADIUS_MIN = 0;
export const APPEARANCE_RADIUS_MAX = 24;
/** A font size (the type scale): rem 0.5–6 or px 8–96. */
export const APPEARANCE_SIZE = /^(\d{1,2}(?:\.\d{1,4})?|\.\d{1,4})(rem|px)$/;
export const APPEARANCE_SIZE_RANGE = { rem: [0.5, 6], px: [8, 96] } as const;
/** A letter-spacing: em -0.1–0.3 or px -3–6, or 0 / normal. */
export const APPEARANCE_TRACKING = /^(-?(?:\d(?:\.\d{1,4})?|\.\d{1,4}))(em|px)$/;
export const APPEARANCE_TRACKING_RANGE = { em: [-0.1, 0.3], px: [-3, 6] } as const;
/** A font weight: 100–900. */
export const APPEARANCE_WEIGHT_MIN = 100;
export const APPEARANCE_WEIGHT_MAX = 900;
/** The label case (text-transform). */
export const APPEARANCE_CASES = ["uppercase", "none", "capitalize", "lowercase"] as const;

/** The fonts the dashboard loads (any safe stack is accepted; others need the font installed on the viewer's device). */
export const APPEARANCE_FONT_PRESETS: Record<string, string> = {
  Satoshi: "\"Satoshi\", ui-sans-serif, system-ui, sans-serif",
  System: "ui-sans-serif, system-ui, sans-serif",
  Inter: "\"Inter\", ui-sans-serif, system-ui, sans-serif",
  "Inter Tight": "\"Inter Tight\", ui-sans-serif, system-ui, sans-serif",
  "IBM Plex Sans": "\"IBM Plex Sans\", ui-sans-serif, system-ui, sans-serif",
  Newsreader: "\"Newsreader\", Georgia, serif",
  Serif: "ui-serif, Georgia, Cambria, \"Times New Roman\", Times, serif",
  Mono: "\"JetBrains Mono\", ui-monospace, \"Cascadia Code\", monospace",
};

/** Token values for one mode: any subset of APPEARANCE_TOKENS (radius in px and headingWeight numbers, the rest strings). */
export type AppearanceTokens = Partial<Record<Exclude<AppearanceTokenName, "radius" | "headingWeight">, string>> & { radius?: number; headingWeight?: number };
/** @deprecated the old five-field shape; still accepted (text = foreground). */
export type AppearanceColors = AppearanceTokens & { text?: string };

export interface AppearanceCustom {
  enabled: boolean;
  /** Fill the tokens not given from those given (foregrounds by contrast, ring from primary…). Default true. */
  derive?: boolean;
  light?: AppearanceTokens;
  dark?: AppearanceTokens;
}

export interface AppearanceSettings {
  theme?: AppearanceTheme;
  palette?: AppearancePalette;
  custom?: AppearanceCustom;
}

/** One token's value, checked; an error names the field and what it takes. */
export function parseAppearanceToken(name: AppearanceTokenName, value: unknown, path: string): string | number {
  const kind: AppearanceTokenKind = APPEARANCE_TOKENS[name].kind;
  if (kind === "radius") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < APPEARANCE_RADIUS_MIN || value > APPEARANCE_RADIUS_MAX) {
      throw new Error(`${path} must be a number of px from ${APPEARANCE_RADIUS_MIN} to ${APPEARANCE_RADIUS_MAX}`);
    }
    return Math.round(value * 2) / 2;
  }
  if (kind === "weight") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < APPEARANCE_WEIGHT_MIN || value > APPEARANCE_WEIGHT_MAX) {
      throw new Error(`${path} must be a font weight from ${APPEARANCE_WEIGHT_MIN} to ${APPEARANCE_WEIGHT_MAX} (e.g. 600)`);
    }
    return Math.round(value);
  }
  const s = typeof value === "string" ? value.trim() : "";
  if (kind === "size") {
    const m = APPEARANCE_SIZE.exec(s);
    const range = m ? APPEARANCE_SIZE_RANGE[m[2] as "rem" | "px"] : null;
    const n = m ? parseFloat(m[1]) : NaN;
    if (!m || !range || n < range[0] || n > range[1]) throw new Error(`${path} must be a font size: rem 0.5–6 or px 8–96 (e.g. 1.5rem, 13px)`);
    return s;
  }
  if (kind === "tracking") {
    if (s === "0" || s === "normal") return s;
    const m = APPEARANCE_TRACKING.exec(s);
    const range = m ? APPEARANCE_TRACKING_RANGE[m[2] as "em" | "px"] : null;
    const n = m ? parseFloat(m[1]) : NaN;
    if (!m || !range || n < range[0] || n > range[1]) throw new Error(`${path} must be a letter-spacing: em -0.1–0.3 or px -3–6, 0 or normal (e.g. 0.06em)`);
    return s;
  }
  if (kind === "case") {
    if (!(APPEARANCE_CASES as readonly string[]).includes(s)) throw new Error(`${path} must be one of ${APPEARANCE_CASES.join(", ")}`);
    return s;
  }
  if (kind === "color") {
    if (!APPEARANCE_COLOR.test(s)) throw new Error(`${path} must be a colour: #rrggbb, #rgb, oklch(…), hsl(…) or rgb(…)`);
    return s.startsWith("#") ? s.toLowerCase() : s;
  }
  if (kind === "font") {
    if (!APPEARANCE_FONT.test(s)) throw new Error(`${path} must be a CSS font stack of names, commas and quotes (e.g. "Inter", sans-serif)`);
    return s;
  }
  if (!APPEARANCE_SHADOW.test(s) || /url\s*\(/i.test(s)) throw new Error(`${path} must be a box-shadow (e.g. 0 1px 2px rgb(0 0 0 / 10%)) or none`);
  return s;
}

/** A mode's tokens, checked (the old `text` becomes foreground). */
export function parseAppearanceTokens(raw: unknown, path: string): AppearanceTokens {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be an object of tokens`);
  const r = { ...(raw as Record<string, unknown>) };
  if (r.text !== undefined) {
    if (r.foreground === undefined) r.foreground = r.text;
    delete r.text;
  }
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(r)) {
    if (value === undefined || value === null) continue;
    if (!(key in APPEARANCE_TOKENS)) {
      throw new Error(`${path}: unknown token ${key} (tokens: ${APPEARANCE_TOKEN_NAMES.join(", ")})`);
    }
    out[key] = parseAppearanceToken(key as AppearanceTokenName, value, `${path}.${key}`);
  }
  return out as AppearanceTokens;
}

/** The appearance of a raw value, or an error naming the first bad field. */
export function parseAppearanceSettings(raw: unknown, path = "settings.appearance"): AppearanceSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be an object`);
  const r = raw as Record<string, unknown>;
  const out: AppearanceSettings = {};
  if (r.theme !== undefined && r.theme !== null) {
    if (!(APPEARANCE_THEMES as readonly unknown[]).includes(r.theme)) throw new Error(`${path}.theme must be one of ${APPEARANCE_THEMES.join(", ")}`);
    out.theme = r.theme as AppearanceTheme;
  }
  if (r.palette !== undefined && r.palette !== null) {
    if (!(APPEARANCE_PALETTES as readonly unknown[]).includes(r.palette)) throw new Error(`${path}.palette must be one of ${APPEARANCE_PALETTES.join(", ")}`);
    out.palette = r.palette as AppearancePalette;
  }
  if (r.custom !== undefined && r.custom !== null) {
    if (typeof r.custom !== "object" || Array.isArray(r.custom)) throw new Error(`${path}.custom must be an object`);
    const c = r.custom as Record<string, unknown>;
    if (c.enabled !== undefined && typeof c.enabled !== "boolean") throw new Error(`${path}.custom.enabled must be true or false`);
    if (c.derive !== undefined && typeof c.derive !== "boolean") throw new Error(`${path}.custom.derive must be true or false`);
    const unknown = Object.keys(c).filter((k) => !["enabled", "derive", "light", "dark"].includes(k));
    if (unknown.length) throw new Error(`${path}.custom: unknown field ${unknown.join(", ")} (use enabled, derive, light, dark)`);
    const light = parseAppearanceTokens(c.light, `${path}.custom.light`);
    const dark = parseAppearanceTokens(c.dark, `${path}.custom.dark`);
    out.custom = {
      enabled: c.enabled === true,
      ...(c.derive === false ? { derive: false } : {}),
      ...(Object.keys(light).length ? { light } : {}),
      ...(Object.keys(dark).length ? { dark } : {}),
    };
  }
  const unknown = Object.keys(r).filter((k) => !["theme", "palette", "custom"].includes(k));
  if (unknown.length) throw new Error(`${path}: unknown field ${unknown.join(", ")} (use theme, palette, custom)`);
  return out;
}

/** Is an appearance empty (nothing chosen: the built-in defaults)? */
export function isEmptyAppearance(a: AppearanceSettings | undefined): boolean {
  return !a || (a.theme === undefined && a.palette === undefined && a.custom === undefined);
}

/**
 * The valid part of a raw appearance (from the config file), and what was dropped: a bad theme,
 * palette, flag or token is left out (its default applies), never the whole look, and never an
 * error — a cosmetic mistake must not stop the instance. The API refuses bad input instead
 * (parseAppearanceSettings).
 */
export function sanitizeAppearanceSettings(raw: unknown, path = "settings.appearance"): { value: AppearanceSettings; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { value: {}, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) return { value: {}, problems: [`${path} must be an object`] };
  const r = raw as Record<string, unknown>;
  const value: AppearanceSettings = {};
  const attempt = (fn: () => void) => { try { fn(); } catch (err) { problems.push(err instanceof Error ? err.message : String(err)); } };
  attempt(() => { Object.assign(value, parseAppearanceSettings({ theme: r.theme }, path)); });
  attempt(() => { Object.assign(value, parseAppearanceSettings({ palette: r.palette }, path)); });
  for (const k of Object.keys(r)) if (!["theme", "palette", "custom"].includes(k)) problems.push(`${path}: unknown field ${k}`);
  if (r.custom !== undefined && r.custom !== null) {
    if (typeof r.custom !== "object" || Array.isArray(r.custom)) {
      problems.push(`${path}.custom must be an object`);
    } else {
      const c = r.custom as Record<string, unknown>;
      const custom: AppearanceCustom = { enabled: c.enabled === true };
      if (c.enabled !== undefined && typeof c.enabled !== "boolean") problems.push(`${path}.custom.enabled must be true or false`);
      if (c.derive === false) custom.derive = false;
      else if (c.derive !== undefined && c.derive !== true) problems.push(`${path}.custom.derive must be true or false`);
      for (const mode of ["light", "dark"] as const) {
        const tokens = c[mode];
        if (tokens === undefined || tokens === null) continue;
        if (typeof tokens !== "object" || Array.isArray(tokens)) { problems.push(`${path}.custom.${mode} must be an object of tokens`); continue; }
        const out: Record<string, unknown> = {};
        for (const [name, v] of Object.entries(tokens as Record<string, unknown>)) {
          attempt(() => { Object.assign(out, parseAppearanceTokens({ [name]: v }, `${path}.custom.${mode}`)); });
        }
        if (Object.keys(out).length) custom[mode] = out as AppearanceTokens;
      }
      for (const k of Object.keys(c)) if (!["enabled", "derive", "light", "dark"].includes(k)) problems.push(`${path}.custom: unknown field ${k}`);
      value.custom = custom;
    }
  }
  return { value, problems };
}
