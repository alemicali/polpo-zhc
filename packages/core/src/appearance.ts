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
 * The dashboard's navigation sidebar: classic (every page in one list) or drill-in (top-level
 * entries that open their pages as a second level inside the sidebar). The instance default is
 * settings.appearance.sidebarStyle (classic when unset); a person may choose their own.
 */
export const SIDEBAR_STYLES = ["classic", "drill-in"] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];

/** The fields of settings.appearance. */
const APPEARANCE_FIELDS: readonly string[] = ["theme", "palette", "custom", "fonts", "sidebarStyle"];

/**
 * How a token's value is checked: colour, font stack, radius (px; 0–24, card and control radius
 * 0–32; badge, pill and avatar 0–999, 999 = fully round), box-shadow, font size (rem 0.5–6 / px 8–96), font weight (100–900), letter-spacing (em
 * -0.1–0.3 / px -3–6, 0, normal), text case (uppercase, none, capitalize, lowercase), a gradient
 * ({ from, to, angle }: two colours and 0–360 degrees), an opacity (0.5–1), a blur (px 0–24).
 */
export type AppearanceTokenKind = "color" | "font" | "radius" | "shadow" | "size" | "weight" | "tracking" | "case" | "gradient" | "opacity" | "blur";

/** Editor groups, in the order the dashboard shows them. */
export const APPEARANCE_TOKEN_GROUPS = ["brand", "surfaces", "text", "borders", "sidebar", "charts", "agents", "status", "typography", "shape"] as const;
export type AppearanceTokenGroup = (typeof APPEARANCE_TOKEN_GROUPS)[number];

/**
 * Every design token an appearance may set: its name (camelCase), the CSS custom property it
 * writes, its group and kind. Keep in step with ui/src/lib/appearance-kit.ts (a test checks it).
 */
export const APPEARANCE_TOKENS = {
  primary: { css: "--primary", group: "brand", kind: "color" },
  secondary: { css: "--secondary", group: "brand", kind: "color" },
  accent: { css: "--accent", group: "brand", kind: "color" },
  buttonPrimaryBg: { css: "--button-primary-bg", group: "brand", kind: "color" },
  buttonGradient: { css: "--button-primary-bg", group: "brand", kind: "gradient" },
  buttonPrimaryForeground: { css: "--button-primary-foreground", group: "brand", kind: "color" },
  shadowButtonPrimary: { css: "--shadow-button-primary", group: "brand", kind: "shadow" },
  background: { css: "--background", group: "surfaces", kind: "color" },
  card: { css: "--card", group: "surfaces", kind: "color" },
  popover: { css: "--popover", group: "surfaces", kind: "color" },
  muted: { css: "--muted", group: "surfaces", kind: "color" },
  overlay: { css: "--overlay", group: "surfaces", kind: "color" },
  canvas: { css: "--canvas", group: "surfaces", kind: "color" },
  canvasForeground: { css: "--canvas-foreground", group: "surfaces", kind: "color" },
  stage: { css: "--stage", group: "surfaces", kind: "color" },
  stageForeground: { css: "--stage-foreground", group: "surfaces", kind: "color" },
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
  sidebarOpacity: { css: "--sidebar-opacity", group: "sidebar", kind: "opacity" },
  sidebarBlur: { css: "--sidebar-blur", group: "sidebar", kind: "blur" },
  chart1: { css: "--chart-1", group: "charts", kind: "color" },
  chart2: { css: "--chart-2", group: "charts", kind: "color" },
  chart3: { css: "--chart-3", group: "charts", kind: "color" },
  chart4: { css: "--chart-4", group: "charts", kind: "color" },
  chart5: { css: "--chart-5", group: "charts", kind: "color" },
  agent1: { css: "--agent-1", group: "agents", kind: "color" },
  agent2: { css: "--agent-2", group: "agents", kind: "color" },
  agent3: { css: "--agent-3", group: "agents", kind: "color" },
  agent4: { css: "--agent-4", group: "agents", kind: "color" },
  agent5: { css: "--agent-5", group: "agents", kind: "color" },
  agent6: { css: "--agent-6", group: "agents", kind: "color" },
  agent7: { css: "--agent-7", group: "agents", kind: "color" },
  agent8: { css: "--agent-8", group: "agents", kind: "color" },
  agent9: { css: "--agent-9", group: "agents", kind: "color" },
  agent10: { css: "--agent-10", group: "agents", kind: "color" },
  agent1Foreground: { css: "--agent-1-foreground", group: "agents", kind: "color" },
  agent2Foreground: { css: "--agent-2-foreground", group: "agents", kind: "color" },
  agent3Foreground: { css: "--agent-3-foreground", group: "agents", kind: "color" },
  agent4Foreground: { css: "--agent-4-foreground", group: "agents", kind: "color" },
  agent5Foreground: { css: "--agent-5-foreground", group: "agents", kind: "color" },
  agent6Foreground: { css: "--agent-6-foreground", group: "agents", kind: "color" },
  agent7Foreground: { css: "--agent-7-foreground", group: "agents", kind: "color" },
  agent8Foreground: { css: "--agent-8-foreground", group: "agents", kind: "color" },
  agent9Foreground: { css: "--agent-9-foreground", group: "agents", kind: "color" },
  agent10Foreground: { css: "--agent-10-foreground", group: "agents", kind: "color" },
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
  textXs: { css: "--text-xs", group: "typography", kind: "size" },
  textSm: { css: "--text-sm", group: "typography", kind: "size" },
  textBase: { css: "--text-base", group: "typography", kind: "size" },
  textLg: { css: "--text-lg", group: "typography", kind: "size" },
  textXl: { css: "--text-xl", group: "typography", kind: "size" },
  text2xl: { css: "--text-2xl", group: "typography", kind: "size" },
  text3xl: { css: "--text-3xl", group: "typography", kind: "size" },
  headingWeight: { css: "--font-weight-heading", group: "typography", kind: "weight" },
  fontWeightNormal: { css: "--font-weight-normal", group: "typography", kind: "weight" },
  fontWeightMedium: { css: "--font-weight-medium", group: "typography", kind: "weight" },
  fontWeightSemibold: { css: "--font-weight-semibold", group: "typography", kind: "weight" },
  fontWeightBold: { css: "--font-weight-bold", group: "typography", kind: "weight" },
  headingTracking: { css: "--tracking-heading", group: "typography", kind: "tracking" },
  labelTracking: { css: "--tracking-label", group: "typography", kind: "tracking" },
  labelCase: { css: "--label-transform", group: "typography", kind: "case" },
  radius: { css: "--radius", group: "shape", kind: "radius" },
  radiusCard: { css: "--radius-card", group: "shape", kind: "radius" },
  radiusControl: { css: "--radius-control", group: "shape", kind: "radius" },
  radiusBadge: { css: "--radius-badge", group: "shape", kind: "radius" },
  radiusPill: { css: "--radius-pill", group: "shape", kind: "radius" },
  radiusAvatar: { css: "--radius-avatar", group: "shape", kind: "radius" },
  radiusDialog: { css: "--radius-dialog", group: "shape", kind: "radius" },
  shadowControl: { css: "--shadow-control", group: "shape", kind: "shadow" },
  shadowCard: { css: "--shadow-card", group: "shape", kind: "shadow" },
  shadowRaised: { css: "--shadow-raised", group: "shape", kind: "shadow" },
  shadowDialog: { css: "--shadow-dialog", group: "shape", kind: "shadow" },
  shadowGlow: { css: "--shadow-glow", group: "shape", kind: "shadow" },
  shadowGlowStrong: { css: "--shadow-glow-strong", group: "shape", kind: "shadow" },
  surfaceBlur: { css: "--surface-blur", group: "shape", kind: "blur" },
  overlayBlur: { css: "--overlay-blur", group: "shape", kind: "blur" },
  glowBlur: { css: "--glow-blur", group: "shape", kind: "blur" },
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
/** The numeric tokens' bounds: the radii (px), the heading weight, the sidebar's opacity and blur (px). */
export const APPEARANCE_NUMBER_RANGES: Record<string, readonly [number, number]> = {
  radius: [APPEARANCE_RADIUS_MIN, APPEARANCE_RADIUS_MAX],
  radiusCard: [0, 32],
  radiusControl: [0, 32],
  radiusBadge: [0, 999],
  radiusPill: [0, 999],
  radiusAvatar: [0, 999],
  radiusDialog: [0, 32],
  headingWeight: [100, 900],
  fontWeightNormal: [100, 900],
  fontWeightMedium: [100, 900],
  fontWeightSemibold: [100, 900],
  fontWeightBold: [100, 900],
  sidebarOpacity: [0.5, 1],
  sidebarBlur: [0, 24],
  surfaceBlur: [0, 24],
  overlayBlur: [0, 24],
  glowBlur: [0, 96],
};
/** A gradient's default angle (degrees), when not given. */
export const APPEARANCE_GRADIENT_ANGLE = 135;
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

/** A gradient token (buttonGradient): two colours and an angle in degrees (default 135). */
export interface AppearanceGradient { from: string; to: string; angle?: number }
type NumberTokenName = "radius" | "radiusCard" | "radiusControl" | "radiusBadge" | "radiusPill" | "radiusAvatar" | "radiusDialog"
  | "headingWeight" | "fontWeightNormal" | "fontWeightMedium" | "fontWeightSemibold" | "fontWeightBold"
  | "sidebarOpacity" | "sidebarBlur" | "surfaceBlur" | "overlayBlur" | "glowBlur";
/** The agent colours (agent1 … agent10): avatars, badges, team colours, tool kinds. */
export const AGENT_COLOR_COUNT = 10;
/** An agent's colour choice (settings → agent identity.color): one of the agent colour tokens. */
export const AGENT_COLOR_TOKEN = /^agent(?:[1-9]|10)$/;

/** A stable 1…10 from an agent's name (FNV-1a): the same agent, the same colour, everywhere (dashboard, MCP cards). */
export function agentColorIndexFromName(name: string): number {
  let h = 0x811c9dc5;
  const s = name.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % AGENT_COLOR_COUNT) + 1;
}

/** An agent's colour index (1…10): its chosen colour (identity.color "agent3", or 3) when valid, else from its name. */
export function agentColorIndex(name: string | undefined, chosen?: unknown): number {
  if (typeof chosen === "number" && Number.isInteger(chosen) && chosen >= 1 && chosen <= AGENT_COLOR_COUNT) return chosen;
  if (typeof chosen === "string" && AGENT_COLOR_TOKEN.test(chosen.trim())) return Number(chosen.trim().slice(5));
  return agentColorIndexFromName(name ?? "");
}

/**
 * The tokens an MCP card (a widget in a third-party host) takes from the instance's look, per mode:
 * the brand and status colours and the agent colours. Only what the instance's custom look sets
 * (the palettes' own values live in the dashboard's stylesheet); the card falls back to the host's
 * colours, then its own light/dark defaults.
 */
export const WIDGET_TOKEN_NAMES = [
  "primary", "success", "warning", "info", "destructive",
  ...Array.from({ length: AGENT_COLOR_COUNT }, (_, i) => `agent${i + 1}`),
  ...Array.from({ length: AGENT_COLOR_COUNT }, (_, i) => `agent${i + 1}Foreground`),
] as const;

/** The instance look's tokens for the MCP cards: { light, dark } of WIDGET_TOKEN_NAMES that are colours, or undefined. */
export function widgetAppearance(a: AppearanceSettings | undefined): { light?: Record<string, string>; dark?: Record<string, string> } | undefined {
  if (!a?.custom?.enabled) return undefined;
  const pick = (tokens: AppearanceTokens | undefined) => {
    const out: Record<string, string> = {};
    for (const name of WIDGET_TOKEN_NAMES) {
      const v = (tokens as Record<string, unknown> | undefined)?.[name];
      if (typeof v === "string" && APPEARANCE_COLOR.test(v)) out[name] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const light = pick(a.custom.light);
  const dark = pick(a.custom.dark);
  return light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : undefined;
}
/** Token values for one mode: any subset of APPEARANCE_TOKENS (radii in px, headingWeight, sidebarOpacity and sidebarBlur numbers; buttonGradient an object; the rest strings). */
export type AppearanceTokens = Partial<Record<Exclude<AppearanceTokenName, NumberTokenName | "buttonGradient">, string>>
  & Partial<Record<NumberTokenName, number>> & { buttonGradient?: AppearanceGradient };
/** @deprecated the old five-field shape; still accepted (text = foreground). */
export type AppearanceColors = AppearanceTokens & { text?: string };

export interface AppearanceCustom {
  enabled: boolean;
  /** Fill the tokens not given from those given (foregrounds by contrast, ring from primary…). Default true. */
  derive?: boolean;
  light?: AppearanceTokens;
  dark?: AppearanceTokens;
}

/**
 * A web font the dashboard loads (settings.appearance.fonts), so a font stack can name it:
 * "google" builds the Google Fonts css2 URL from the family and weights; "url" takes an https
 * stylesheet on one of APPEARANCE_FONT_HOSTS. index.html's inline script adds it (preconnect and
 * stylesheet) before the first paint; the families use font-display: swap.
 */
export interface AppearanceWebFont {
  family: string;
  source: "google" | "url";
  /** The stylesheet (source "url" only). */
  url?: string;
  /** Weights: a list (400;600;700) or a range for a variable font (300..800). Google only; default: the regular weight. */
  weights?: string;
}

export interface AppearanceSettings {
  theme?: AppearanceTheme;
  palette?: AppearancePalette;
  custom?: AppearanceCustom;
  /** Web fonts to load (any mode's font stacks may name them). */
  fonts?: AppearanceWebFont[];
  /** The navigation sidebar everyone gets by default (classic when unset). */
  sidebarStyle?: SidebarStyle;
}

/** The font services a web font stylesheet may come from. */
export const APPEARANCE_FONT_HOSTS = ["fonts.googleapis.com", "fonts.bunny.net", "use.typekit.net", "api.fontshare.com", "rsms.me"] as const;
/** At most this many web fonts. */
export const APPEARANCE_MAX_WEB_FONTS = 8;
/** A web font's family: letters, digits, spaces, _ and -, 1–64 characters, starting with a letter or digit. */
export const APPEARANCE_FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
/** The fonts the dashboard ships itself (self-hosted in ui/public/fonts): no web font needed. */
export const APPEARANCE_BUNDLED_FONTS = ["Inter Tight"] as const;
/** The fonts index.html declares from font services: no web font needed. */
export const APPEARANCE_PRELOADED_FONTS = ["Satoshi", "IBM Plex Sans", "Inter", "JetBrains Mono", "Newsreader"] as const;

/** Weights as Google Fonts takes them ("400;600;700" or "300..800"), or null when not valid. */
export function normalizeFontWeights(raw: string): string | null {
  const s = raw.trim();
  const ok = (n: number) => n >= 100 && n <= 900;
  const range = /^(\d{3})\s*\.\.\s*(\d{3})$/.exec(s);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    return ok(a) && ok(b) && a < b ? `${a}..${b}` : null;
  }
  const parts = s.split(/[\s;,]+/).filter(Boolean);
  if (!parts.length || parts.length > 9 || parts.some((p) => !/^\d{3}$/.test(p) || !ok(Number(p)))) return null;
  return [...new Set(parts.map(Number))].sort((a, b) => a - b).join(";");
}

/** An https stylesheet on an allowed font host (font-display swap added where the service takes it), or null. */
export function normalizeFontUrl(raw: string): string | null {
  const s = raw.trim();
  if (s.length > 512 || !/^https:\/\/[^\s"'<>\\`]+$/.test(s)) return null;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  url.hash = "";
  if (!(APPEARANCE_FONT_HOSTS as readonly string[]).includes(url.hostname)) return null;
  if (["fonts.googleapis.com", "fonts.bunny.net", "api.fontshare.com"].includes(url.hostname) && !url.searchParams.has("display")) {
    // appended as is: searchParams.set would re-encode the rest (family=Inter:wght@400;700)
    return `${url.href}${url.search ? "&" : "?"}display=swap`;
  }
  return url.href;
}

/** The stylesheet URL of a (valid) web font. */
export function webFontHref(font: AppearanceWebFont): string {
  if (font.source === "google") {
    const family = encodeURIComponent(font.family).replace(/%20/g, "+");
    return `https://fonts.googleapis.com/css2?family=${family}${font.weights ? `:wght@${font.weights}` : ""}&display=swap`;
  }
  return font.url ?? "";
}

/** One web font, checked; an error names the field. */
export function parseWebFont(raw: unknown, path: string): AppearanceWebFont {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must be an object { family, source, url?, weights? }`);
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !["family", "source", "url", "weights"].includes(k));
  if (unknown.length) throw new Error(`${path}: unknown field ${unknown.join(", ")} (use family, source, url, weights)`);
  const family = typeof r.family === "string" ? r.family.trim().replace(/\s+/g, " ") : "";
  if (!APPEARANCE_FONT_FAMILY.test(family)) throw new Error(`${path}.family must be a font family name: letters, digits, spaces, _ and -, up to 64 characters (e.g. Manrope)`);
  if (r.source !== "google" && r.source !== "url") throw new Error(`${path}.source must be google or url`);
  const out: AppearanceWebFont = { family, source: r.source };
  if (r.source === "google") {
    if (r.url !== undefined && r.url !== null && r.url !== "") throw new Error(`${path}.url is only for source url (google builds the URL from family and weights)`);
    if (r.weights !== undefined && r.weights !== null && r.weights !== "") {
      const weights = typeof r.weights === "string" || typeof r.weights === "number" ? normalizeFontWeights(String(r.weights)) : null;
      if (!weights) throw new Error(`${path}.weights must be weights 100–900 like 400;600;700, or a range like 300..800 for a variable font`);
      out.weights = weights;
    }
    return out;
  }
  const url = typeof r.url === "string" ? normalizeFontUrl(r.url) : null;
  if (!url) throw new Error(`${path}.url must be an https stylesheet URL on ${APPEARANCE_FONT_HOSTS.join(", ")}`);
  out.url = url;
  return out;
}

/** The web fonts, checked: at most APPEARANCE_MAX_WEB_FONTS, one per family. */
export function parseWebFonts(raw: unknown, path: string): AppearanceWebFont[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${path} must be a list of web fonts [{ family, source: "google" | "url", url?, weights? }]`);
  if (raw.length > APPEARANCE_MAX_WEB_FONTS) throw new Error(`${path} takes at most ${APPEARANCE_MAX_WEB_FONTS} web fonts`);
  const out: AppearanceWebFont[] = [];
  raw.forEach((item, i) => {
    const font = parseWebFont(item, `${path}[${i}]`);
    if (out.some((f) => f.family.toLowerCase() === font.family.toLowerCase())) throw new Error(`${path}[${i}].family ${font.family} is given twice`);
    out.push(font);
  });
  return out;
}

/** Generic families and ones on (nearly) every device: never "not loaded". */
const SYSTEM_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont",
  "arial", "helvetica", "helvetica neue", "georgia", "times", "times new roman", "cambria", "courier", "courier new",
  "segoe ui", "roboto", "cascadia code", "menlo", "monaco", "consolas", "sf mono", "verdana", "tahoma",
]);

/**
 * The families an appearance's font stacks name that the dashboard does not load (not bundled, not
 * declared by index.html, not a web font, not a generic or common system family): they show only
 * on devices that have them installed.
 */
export function unloadedFontFamilies(a: AppearanceSettings | undefined): string[] {
  if (!a) return [];
  const loaded = new Set<string>([...APPEARANCE_BUNDLED_FONTS, ...APPEARANCE_PRELOADED_FONTS, ...(a.fonts ?? []).map((f) => f.family)].map((f) => f.toLowerCase()));
  const out: string[] = [];
  for (const mode of [a.custom?.light, a.custom?.dark]) {
    for (const key of ["fontFamily", "headingFont", "monoFont"] as const) {
      const stack = mode?.[key];
      if (typeof stack !== "string") continue;
      for (const part of stack.split(",")) {
        const family = part.trim().replace(/^["']|["']$/g, "").trim();
        const low = family.toLowerCase();
        if (!family || SYSTEM_FONTS.has(low) || loaded.has(low) || out.includes(family)) continue;
        out.push(family);
      }
    }
  }
  return out;
}

/** A gradient token's value, checked: { from, to, angle? } (colours; 0–360 degrees, default 135). */
export function parseAppearanceGradient(value: unknown, path: string): AppearanceGradient {
  const hint = `${path} must be a gradient { from, to, angle }: two colours (#rrggbb, oklch(…), hsl(…), rgb(…)) and an angle 0–360 (default ${APPEARANCE_GRADIENT_ANGLE})`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(hint);
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !["from", "to", "angle"].includes(k));
  if (unknown.length) throw new Error(`${path}: unknown field ${unknown.join(", ")} (use from, to, angle)`);
  const color = (c: unknown, field: string) => {
    const s = typeof c === "string" ? c.trim() : "";
    if (!APPEARANCE_COLOR.test(s)) throw new Error(`${path}.${field} must be a colour: #rrggbb, #rgb, oklch(…), hsl(…) or rgb(…)`);
    return s.startsWith("#") ? s.toLowerCase() : s;
  };
  const angle = v.angle === undefined || v.angle === null ? APPEARANCE_GRADIENT_ANGLE : v.angle;
  if (typeof angle !== "number" || !Number.isFinite(angle) || angle < 0 || angle > 360) throw new Error(`${path}.angle must be a number of degrees from 0 to 360`);
  return { from: color(v.from, "from"), to: color(v.to, "to"), angle: Math.round(angle) };
}

/** One token's value, checked; an error names the field and what it takes. */
export function parseAppearanceToken(name: AppearanceTokenName, value: unknown, path: string): string | number | AppearanceGradient {
  if (APPEARANCE_TOKENS[name].kind === "gradient") return parseAppearanceGradient(value, path);
  const kind: AppearanceTokenKind = APPEARANCE_TOKENS[name].kind;
  if (kind === "radius" || kind === "blur") {
    const [min, max] = APPEARANCE_NUMBER_RANGES[name] ?? [APPEARANCE_RADIUS_MIN, APPEARANCE_RADIUS_MAX];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${path} must be a number of px from ${min} to ${max}`);
    }
    return Math.round(value * 2) / 2;
  }
  if (kind === "opacity") {
    const [min, max] = APPEARANCE_NUMBER_RANGES[name] ?? [0, 1];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${path} must be an opacity from ${min} to ${max} (e.g. 0.85)`);
    }
    return Math.round(value * 100) / 100;
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
  const out: Record<string, string | number | AppearanceGradient> = {};
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
  if (r.sidebarStyle !== undefined && r.sidebarStyle !== null) {
    if (!(SIDEBAR_STYLES as readonly unknown[]).includes(r.sidebarStyle)) throw new Error(`${path}.sidebarStyle must be one of ${SIDEBAR_STYLES.join(", ")}`);
    out.sidebarStyle = r.sidebarStyle as SidebarStyle;
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
  if (r.fonts !== undefined && r.fonts !== null) {
    const fonts = parseWebFonts(r.fonts, `${path}.fonts`);
    if (fonts.length) out.fonts = fonts;
  }
  const unknown = Object.keys(r).filter((k) => !APPEARANCE_FIELDS.includes(k));
  if (unknown.length) throw new Error(`${path}: unknown field ${unknown.join(", ")} (use ${APPEARANCE_FIELDS.join(", ")})`);
  return out;
}

/** Is an appearance empty (nothing chosen: the built-in defaults)? */
export function isEmptyAppearance(a: AppearanceSettings | undefined): boolean {
  return !a || (a.theme === undefined && a.palette === undefined && a.custom === undefined && !a.fonts?.length && a.sidebarStyle === undefined);
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
  attempt(() => { Object.assign(value, parseAppearanceSettings({ sidebarStyle: r.sidebarStyle }, path)); });
  for (const k of Object.keys(r)) if (!APPEARANCE_FIELDS.includes(k)) problems.push(`${path}: unknown field ${k}`);
  if (r.fonts !== undefined && r.fonts !== null) {
    if (!Array.isArray(r.fonts)) {
      problems.push(`${path}.fonts must be a list of web fonts`);
    } else {
      const fonts: AppearanceWebFont[] = [];
      r.fonts.forEach((item, i) => attempt(() => {
        if (fonts.length >= APPEARANCE_MAX_WEB_FONTS) throw new Error(`${path}.fonts takes at most ${APPEARANCE_MAX_WEB_FONTS} web fonts`);
        const font = parseWebFont(item, `${path}.fonts[${i}]`);
        if (!fonts.some((f) => f.family.toLowerCase() === font.family.toLowerCase())) fonts.push(font);
      }));
      if (fonts.length) value.fonts = fonts;
    }
  }
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
