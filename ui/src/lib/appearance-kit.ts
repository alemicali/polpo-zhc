/**
 * The dashboard's look, resolved and applied — one source for two places:
 *
 * - index.html: vite.config.ts inlines `bootScriptSource()` as a classic <script> in <head>, right
 *   after /runtime-config.js, so the theme class, palette, custom design tokens and theme-color are
 *   on <html> before the stylesheet paints (no flash of the default look on reload);
 * - the app (lib/appearance.ts, main.tsx): the same functions, through `appearanceKit()`.
 *
 * Layers, field by field (theme, palette, custom tokens): what this browser chose (localStorage,
 * scoped to the API and the instance), else the instance's default (settings.appearance, inlined
 * by the UI server into runtime-config.js, cached in localStorage), else the built-in default.
 *
 * Everything lives inside `appearanceKit` and uses no imports and no DOM lib types, because the
 * inline script is its source text (Function.prototype.toString) and vite.config.ts (a Node
 * project) imports this file. Keep it that way.
 */

export type BootTheme = "light" | "dark" | "system";

export type TokenGroup = "brand" | "surfaces" | "text" | "borders" | "sidebar" | "charts" | "agents" | "status" | "typography" | "shape";
/**
 * How a token is checked: a colour, a font stack, a radius (px, 0–24), a box-shadow, a font size
 * (rem 0.5–6 or px 8–96), a font weight (100–900), a letter-spacing (em -0.1–0.3, px -3–6, 0 or
 * normal) or a text case (uppercase, none, capitalize, lowercase).
 */
export type TokenKind = "color" | "font" | "radius" | "shadow" | "size" | "weight" | "tracking" | "case" | "gradient" | "opacity" | "blur";

/** A gradient token (buttonGradient): two colours and an angle in degrees. */
export interface GradientValue { from: string; to: string; angle: number }
export type TokenValue = string | number | GradientValue;
/** A mode's design tokens: any subset (radii and blur in px, weight and opacity numbers, buttonGradient an object, the rest CSS values). */
export type TokenMap = Record<string, TokenValue>;

/** A web font to load (settings.appearance.fonts): Google Fonts by family, or an https stylesheet on an allowed host. */
export interface WebFont {
  family: string;
  source: "google" | "url";
  url?: string;
  weights?: string;
}

export interface BootCustom {
  enabled: boolean;
  /** Fill the tokens not given from those given (default true). */
  derive: boolean;
  light: TokenMap;
  dark: TokenMap;
  /** Web fonts this look loads (from the instance: settings.appearance.fonts). */
  fonts?: WebFont[];
}

/** The instance's default look as the API gives it (validated server side). */
export interface InstanceAppearance {
  theme?: BootTheme;
  palette?: string;
  custom?: { enabled?: boolean; derive?: boolean; light?: TokenMap; dark?: TokenMap };
  fonts?: WebFont[];
}

/** The instance's branding as the API gives it (public display fields; settings.branding). */
export interface InstanceBranding {
  productName?: string;
  tagline?: string;
  logoUrl?: string;
  /** The logo in dark mode (falls back to logoUrl). */
  logoDarkUrl?: string;
  /** How the logo is shown: "box" (default) in a tile, "none" bare. */
  logoFrame?: "box" | "none";
}

export interface ResolveInput {
  /** What this browser chose (raw localStorage values; null when not chosen). */
  stored: { theme: string | null; palette: string | null; custom: string | null };
  /** The instance's default, or null when unknown. */
  instance: InstanceAppearance | null;
  /** Does the OS prefer dark? */
  prefersDark: boolean;
}

export type LayerSource = "browser" | "instance" | "default";

export interface ResolvedAppearance {
  theme: BootTheme;
  dark: boolean;
  palette: string;
  custom: BootCustom;
  /** The overrides stylesheet, or null when custom tokens are off. */
  css: string | null;
  /** For <meta name="theme-color">. */
  themeColor: string;
  /** The web fonts to load: this look's and the instance's. */
  fonts: WebFont[];
  sources: { theme: LayerSource; palette: LayerSource; custom: LayerSource };
}

/** Just enough of window/document for the kit (no DOM lib: vite.config.ts is a Node project). */
interface KitElement {
  id: string;
  textContent: string | null;
  classList: { toggle(name: string, force?: boolean): unknown };
  dataset: Record<string, string | undefined>;
  lastElementChild?: KitElement | null;
  setAttribute(name: string, value: string): void;
  getAttribute?(name: string): string | null;
  remove(): void;
  appendChild(child: KitElement): unknown;
}
interface KitDocument {
  title: string;
  documentElement: KitElement;
  head: KitElement;
  getElementById(id: string): KitElement | null;
  querySelector(selector: string): KitElement | null;
  querySelectorAll?(selector: string): ArrayLike<KitElement>;
  createElement(tag: string): KitElement;
}
interface KitStorage { getItem(key: string): string | null }
export interface KitWindow {
  document: KitDocument;
  location: { origin: string };
  localStorage?: KitStorage;
  matchMedia?: (query: string) => { matches: boolean };
  __POLPO_RUNTIME_CONFIG__?: { baseUrl?: string; appearance?: InstanceAppearance | null; branding?: InstanceBranding | null } | undefined;
}

export function appearanceKit() {
  const PALETTES = ["tide", "lovable", "chatgpt", "claude", "brutal", "editorial", "redline", "cyber", "mono"];
  const DEFAULT_PALETTE = "tide";
  const DEFAULT_THEME: BootTheme = "dark";
  /** Page background per palette, [light, dark] (index.css), for the browser chrome. */
  const THEME_COLORS: Record<string, [string, string]> = {
    tide: ["#f5fafb", "#0a0e1a"],
    lovable: ["#f7f5f2", "#171615"],
    chatgpt: ["#ffffff", "#212121"],
    claude: ["#f7f6f2", "#1f1e1b"],
    brutal: ["#ffffff", "#000000"],
    editorial: ["#f8f1e4", "#1c1612"],
    redline: ["#f5f5f1", "#151513"],
    cyber: ["#f2f6fa", "#03060d"],
    mono: ["#ffffff", "#0b0b0b"],
  };
  /**
   * Every design token: [CSS custom property, group, kind]. The same list as APPEARANCE_TOKENS in
   * packages/core/src/appearance.ts (a test checks it).
   */
  const TOKENS: Record<string, [string, TokenGroup, TokenKind]> = {
    primary: ["--primary", "brand", "color"],
    secondary: ["--secondary", "brand", "color"],
    accent: ["--accent", "brand", "color"],
    buttonPrimaryBg: ["--button-primary-bg", "brand", "color"],
    buttonGradient: ["--button-primary-bg", "brand", "gradient"],
    buttonPrimaryForeground: ["--button-primary-foreground", "brand", "color"],
    shadowButtonPrimary: ["--shadow-button-primary", "brand", "shadow"],
    background: ["--background", "surfaces", "color"],
    card: ["--card", "surfaces", "color"],
    popover: ["--popover", "surfaces", "color"],
    muted: ["--muted", "surfaces", "color"],
    overlay: ["--overlay", "surfaces", "color"],
    canvas: ["--canvas", "surfaces", "color"],
    canvasForeground: ["--canvas-foreground", "surfaces", "color"],
    stage: ["--stage", "surfaces", "color"],
    stageForeground: ["--stage-foreground", "surfaces", "color"],
    foreground: ["--foreground", "text", "color"],
    mutedForeground: ["--muted-foreground", "text", "color"],
    cardForeground: ["--card-foreground", "text", "color"],
    popoverForeground: ["--popover-foreground", "text", "color"],
    primaryForeground: ["--primary-foreground", "text", "color"],
    secondaryForeground: ["--secondary-foreground", "text", "color"],
    accentForeground: ["--accent-foreground", "text", "color"],
    border: ["--border", "borders", "color"],
    input: ["--input", "borders", "color"],
    ring: ["--ring", "borders", "color"],
    sidebar: ["--sidebar", "sidebar", "color"],
    sidebarForeground: ["--sidebar-foreground", "sidebar", "color"],
    sidebarPrimary: ["--sidebar-primary", "sidebar", "color"],
    sidebarPrimaryForeground: ["--sidebar-primary-foreground", "sidebar", "color"],
    sidebarAccent: ["--sidebar-accent", "sidebar", "color"],
    sidebarAccentForeground: ["--sidebar-accent-foreground", "sidebar", "color"],
    sidebarBorder: ["--sidebar-border", "sidebar", "color"],
    sidebarRing: ["--sidebar-ring", "sidebar", "color"],
    sidebarOpacity: ["--sidebar-opacity", "sidebar", "opacity"],
    sidebarBlur: ["--sidebar-blur", "sidebar", "blur"],
    chart1: ["--chart-1", "charts", "color"],
    chart2: ["--chart-2", "charts", "color"],
    chart3: ["--chart-3", "charts", "color"],
    chart4: ["--chart-4", "charts", "color"],
    chart5: ["--chart-5", "charts", "color"],
    agent1: ["--agent-1", "agents", "color"],
    agent2: ["--agent-2", "agents", "color"],
    agent3: ["--agent-3", "agents", "color"],
    agent4: ["--agent-4", "agents", "color"],
    agent5: ["--agent-5", "agents", "color"],
    agent6: ["--agent-6", "agents", "color"],
    agent7: ["--agent-7", "agents", "color"],
    agent8: ["--agent-8", "agents", "color"],
    agent9: ["--agent-9", "agents", "color"],
    agent10: ["--agent-10", "agents", "color"],
    agent1Foreground: ["--agent-1-foreground", "agents", "color"],
    agent2Foreground: ["--agent-2-foreground", "agents", "color"],
    agent3Foreground: ["--agent-3-foreground", "agents", "color"],
    agent4Foreground: ["--agent-4-foreground", "agents", "color"],
    agent5Foreground: ["--agent-5-foreground", "agents", "color"],
    agent6Foreground: ["--agent-6-foreground", "agents", "color"],
    agent7Foreground: ["--agent-7-foreground", "agents", "color"],
    agent8Foreground: ["--agent-8-foreground", "agents", "color"],
    agent9Foreground: ["--agent-9-foreground", "agents", "color"],
    agent10Foreground: ["--agent-10-foreground", "agents", "color"],
    destructive: ["--destructive", "status", "color"],
    destructiveForeground: ["--destructive-foreground", "status", "color"],
    success: ["--success", "status", "color"],
    successForeground: ["--success-foreground", "status", "color"],
    warning: ["--warning", "status", "color"],
    warningForeground: ["--warning-foreground", "status", "color"],
    info: ["--info", "status", "color"],
    infoForeground: ["--info-foreground", "status", "color"],
    statusRunning: ["--status-running", "status", "color"],
    statusQueued: ["--status-queued", "status", "color"],
    statusAssigned: ["--status-assigned", "status", "color"],
    fontFamily: ["--app-font-family", "typography", "font"],
    headingFont: ["--app-heading-font", "typography", "font"],
    monoFont: ["--app-mono-font", "typography", "font"],
    textDisplay: ["--text-display", "typography", "size"],
    textH1: ["--text-h1", "typography", "size"],
    textH2: ["--text-h2", "typography", "size"],
    textH3: ["--text-h3", "typography", "size"],
    textBody: ["--text-body", "typography", "size"],
    textSmall: ["--text-small", "typography", "size"],
    textCaption: ["--text-caption", "typography", "size"],
    textMicro: ["--text-micro", "typography", "size"],
    textXs: ["--text-xs", "typography", "size"],
    textSm: ["--text-sm", "typography", "size"],
    textBase: ["--text-base", "typography", "size"],
    textLg: ["--text-lg", "typography", "size"],
    textXl: ["--text-xl", "typography", "size"],
    text2xl: ["--text-2xl", "typography", "size"],
    text3xl: ["--text-3xl", "typography", "size"],
    headingWeight: ["--font-weight-heading", "typography", "weight"],
    fontWeightNormal: ["--font-weight-normal", "typography", "weight"],
    fontWeightMedium: ["--font-weight-medium", "typography", "weight"],
    fontWeightSemibold: ["--font-weight-semibold", "typography", "weight"],
    fontWeightBold: ["--font-weight-bold", "typography", "weight"],
    headingTracking: ["--tracking-heading", "typography", "tracking"],
    labelTracking: ["--tracking-label", "typography", "tracking"],
    labelCase: ["--label-transform", "typography", "case"],
    radius: ["--radius", "shape", "radius"],
    radiusCard: ["--radius-card", "shape", "radius"],
    radiusControl: ["--radius-control", "shape", "radius"],
    radiusBadge: ["--radius-badge", "shape", "radius"],
    radiusPill: ["--radius-pill", "shape", "radius"],
    radiusAvatar: ["--radius-avatar", "shape", "radius"],
    radiusDialog: ["--radius-dialog", "shape", "radius"],
    shadowControl: ["--shadow-control", "shape", "shadow"],
    shadowCard: ["--shadow-card", "shape", "shadow"],
    shadowRaised: ["--shadow-raised", "shape", "shadow"],
    shadowDialog: ["--shadow-dialog", "shape", "shadow"],
    shadowGlow: ["--shadow-glow", "shape", "shadow"],
    shadowGlowStrong: ["--shadow-glow-strong", "shape", "shadow"],
    surfaceBlur: ["--surface-blur", "shape", "blur"],
    overlayBlur: ["--overlay-blur", "shape", "blur"],
    glowBlur: ["--glow-blur", "shape", "blur"],
  };
  /**
   * What a token is derived from when not given (derive on), in order: the first given or
   * derived source wins. "contrast:x" is a readable text colour on x.
   */
  const DERIVE: Array<[string, string]> = [
    ["accent", "secondary"],
    ["card", "background"],
    ["popover", "card"],
    ["sidebar", "background"],
    ["cardForeground", "foreground"],
    ["popoverForeground", "foreground"],
    ["sidebarForeground", "foreground"],
    ["primaryForeground", "contrast:primary"],
    ["secondaryForeground", "contrast:secondary"],
    ["accentForeground", "contrast:accent"],
    ["ring", "primary"],
    ["input", "border"],
    ["sidebarBorder", "border"],
    ["sidebarPrimary", "primary"],
    ["sidebarPrimaryForeground", "contrast:sidebarPrimary"],
    ["sidebarAccent", "accent"],
    ["sidebarAccentForeground", "contrast:sidebarAccent"],
    ["sidebarRing", "sidebarPrimary"],
    ["chart1", "primary"],
    ["destructiveForeground", "contrast:destructive"],
    ["successForeground", "contrast:success"],
    ["warningForeground", "contrast:warning"],
    ["infoForeground", "contrast:info"],
    ["canvasForeground", "contrast:canvas"],
    ["stageForeground", "contrast:stage"],
    ["agent1Foreground", "contrast:agent1"],
    ["agent2Foreground", "contrast:agent2"],
    ["agent3Foreground", "contrast:agent3"],
    ["agent4Foreground", "contrast:agent4"],
    ["agent5Foreground", "contrast:agent5"],
    ["agent6Foreground", "contrast:agent6"],
    ["agent7Foreground", "contrast:agent7"],
    ["agent8Foreground", "contrast:agent8"],
    ["agent9Foreground", "contrast:agent9"],
    ["agent10Foreground", "contrast:agent10"],
    ["statusRunning", "info"],
    ["statusAssigned", "primary"],
    ["statusQueued", "mutedForeground"],
    // the primary button's text: readable on its gradient, else on its fill (else --primary-foreground, in CSS)
    ["buttonPrimaryForeground", "contrast:buttonGradient"],
    ["buttonPrimaryForeground", "contrast:buttonPrimaryBg"],
  ];
  /** The numeric tokens' bounds (the same as APPEARANCE_NUMBER_RANGES in packages/core/src/appearance.ts). */
  const RANGES: Record<string, [number, number]> = {
    radius: [0, 24], radiusCard: [0, 32], radiusControl: [0, 32], radiusBadge: [0, 999], radiusPill: [0, 999], radiusAvatar: [0, 999], radiusDialog: [0, 32],
    headingWeight: [100, 900], fontWeightNormal: [100, 900], fontWeightMedium: [100, 900], fontWeightSemibold: [100, 900], fontWeightBold: [100, 900],
    sidebarOpacity: [0.5, 1], sidebarBlur: [0, 24], surfaceBlur: [0, 24], overlayBlur: [0, 24], glowBlur: [0, 96],
  };
  const GRADIENT_ANGLE = 135;
  /** The font services a web font stylesheet may come from (APPEARANCE_FONT_HOSTS on the server). */
  const FONT_HOSTS = ["fonts.googleapis.com", "fonts.bunny.net", "use.typekit.net", "api.fontshare.com", "rsms.me"];
  /** Where each service's font files come from (preconnected along with the stylesheet's host). */
  const FONT_FILE_HOSTS: Record<string, string> = {
    "fonts.googleapis.com": "https://fonts.gstatic.com",
    "api.fontshare.com": "https://cdn.fontshare.com",
    "use.typekit.net": "https://p.typekit.net",
  };
  const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
  const MAX_WEB_FONTS = 8;
  const WEB_FONT_PREFIX = "polpo-webfont-";
  const STYLE_ID = "polpo-appearance-overrides";
  const KEYS = { theme: "polpo-theme", palette: "polpo-palette", custom: "polpo-appearance" };
  /** The instance the API serves, remembered per API (the project is only known after a request). */
  const LAST_SCOPE_KEY = "polpo-appearance-scope";
  /** The instance's default look, cached per API for when runtime-config.js does not carry it. */
  const INSTANCE_KEY = "polpo-instance-appearance";
  const COLOR_RE = /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:oklch|oklab|lab|lch|hsla?|rgba?)\(\s*[0-9a-zA-Z.%\s,/+-]{1,80}\))$/;
  /** The instance's branding, cached per API for when runtime-config.js does not carry it. */
  const BRANDING_KEY = "polpo-instance-branding";
  const DEFAULT_PRODUCT_NAME = "Polpo ZHC";
  const DEFAULT_PRODUCT_TAGLINE = "AI Factory";
  const LOGO_PRELOAD_ID = "polpo-brand-logo-preload";
  /**
   * Fonts the dashboard ships (public/fonts, @font-face in index.css): the file to preload when a
   * look uses the family, so it never flashes in late. Relative to the app's base.
   */
  const BUNDLED_FONTS: Record<string, string> = {
    "Inter Tight": "fonts/inter-tight/inter-tight-latin-wght-normal.woff2",
  };
  const FONT_PRELOAD_PREFIX = "polpo-font-preload-";
  const FONT_RE = /^[A-Za-z0-9 ,"'_.-]{1,200}$/;
  const SHADOW_RE = /^(none|[0-9a-zA-Z.%\s,/#()+-]{1,240})$/;
  /** A font size: a number of rem or px (ranges checked in tokenValue). */
  const SIZE_RE = /^(\d{1,2}(?:\.\d{1,4})?|\.\d{1,4})(rem|px)$/;
  /** A letter-spacing: a number of em or px (ranges checked in tokenValue). */
  const TRACKING_RE = /^(-?(?:\d(?:\.\d{1,4})?|\.\d{1,4}))(em|px)$/;
  const CASES = ["uppercase", "none", "capitalize", "lowercase"];

  function slug(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "default";
  }

  /** The API the dashboard talks to, as a storage scope. */
  function apiScope(baseUrl: string, origin: string): string {
    const raw = baseUrl || origin || "local";
    try {
      const url = new URL(raw, origin || undefined);
      return slug(`${url.origin}${url.pathname.replace(/\/+$/, "")}`);
    } catch {
      return slug(raw);
    }
  }

  function scopedKey(key: string, api: string, instance: string): string {
    return `${key}:${api}:${instance}`;
  }

  function isTheme(v: unknown): v is BootTheme {
    return v === "light" || v === "dark" || v === "system";
  }

  function isPalette(v: unknown): v is string {
    return typeof v === "string" && PALETTES.indexOf(v) >= 0;
  }

  /**
   * A token's value when valid (see TokenKind), else undefined. Numbers out of range are clamped
   * (radius 0–24, weight 100–900); sizes and trackings out of range are refused.
   */
  function tokenValue(name: string, value: unknown): TokenValue | undefined {
    const def = TOKENS[name];
    if (!def) return undefined;
    const kind = def[2];
    if (kind === "radius" || kind === "weight" || kind === "opacity" || kind === "blur") {
      if (typeof value !== "number" || !isFinite(value)) return undefined;
      const range = RANGES[name] || [0, 24];
      const n = Math.min(range[1], Math.max(range[0], value));
      return kind === "weight" ? Math.round(n) : n;
    }
    if (kind === "gradient") {
      if (!value || typeof value !== "object") return undefined;
      const g = value as Record<string, unknown>;
      const from = typeof g.from === "string" ? g.from.trim() : "";
      const to = typeof g.to === "string" ? g.to.trim() : "";
      const angle = g.angle === undefined || g.angle === null ? GRADIENT_ANGLE : g.angle;
      if (!COLOR_RE.test(from) || !COLOR_RE.test(to) || typeof angle !== "number" || !isFinite(angle)) return undefined;
      return { from, to, angle: Math.round(Math.min(360, Math.max(0, angle))) };
    }
    const s = typeof value === "string" ? value.trim() : "";
    if (kind === "color") return COLOR_RE.test(s) ? s : undefined;
    if (kind === "font") return FONT_RE.test(s) ? s : undefined;
    if (kind === "size") {
      const m = SIZE_RE.exec(s);
      if (!m) return undefined;
      const n = parseFloat(m[1]);
      return (m[2] === "rem" ? n >= 0.5 && n <= 6 : n >= 8 && n <= 96) ? s : undefined;
    }
    if (kind === "tracking") {
      if (s === "0" || s === "normal") return s;
      const m = TRACKING_RE.exec(s);
      if (!m) return undefined;
      const n = parseFloat(m[1]);
      return (m[2] === "em" ? n >= -0.1 && n <= 0.3 : n >= -3 && n <= 6) ? s : undefined;
    }
    if (kind === "case") return CASES.indexOf(s) >= 0 ? s : undefined;
    return SHADOW_RE.test(s) && !/url\s*\(/i.test(s) ? s : undefined;
  }

  /** A mode's valid tokens (the old `text` is foreground). */
  function normalizeTokens(value: unknown): TokenMap {
    const out: TokenMap = {};
    if (!value || typeof value !== "object") return out;
    const v = value as Record<string, unknown>;
    for (const name of Object.keys(v)) {
      const key = name === "text" ? "foreground" : name;
      if (key === "foreground" && name === "text" && v.foreground !== undefined) continue;
      const ok = tokenValue(key, v[name]);
      if (ok !== undefined) out[key] = ok;
    }
    return out;
  }

  /** Custom tokens from a stored or API value (also the old single-theme shape { primary, accent, … }). */
  function normalizeCustom(value: unknown): BootCustom {
    const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const legacy = !v.light && !v.dark && (v.primary || v.secondary || v.accent || v.text || v.fontFamily || v.radius !== undefined)
      ? normalizeTokens({ primary: v.primary, secondary: v.secondary || v.accent, text: v.text, fontFamily: v.fontFamily, radius: v.radius })
      : null;
    const fonts = normalizeWebFonts(v.fonts);
    return {
      enabled: v.enabled === true,
      derive: v.derive !== false,
      light: normalizeTokens(v.light || legacy),
      dark: normalizeTokens(v.dark || legacy),
      ...(fonts.length ? { fonts } : {}),
    };
  }

  /** Weights as Google Fonts takes them ("400;600;700" or "300..800"), or null. */
  function fontWeights(raw: unknown): string | null {
    const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    const ok = (n: number) => n >= 100 && n <= 900;
    const range = /^(\d{3})\s*\.\.\s*(\d{3})$/.exec(s);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      return ok(a) && ok(b) && a < b ? `${a}..${b}` : null;
    }
    const parts = s.split(/[\s;,]+/).filter(Boolean);
    if (!parts.length || parts.length > 9) return null;
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d{3}$/.test(p) || !ok(Number(p))) return null;
      if (nums.indexOf(Number(p)) === -1) nums.push(Number(p));
    }
    return nums.sort((a, b) => a - b).join(";");
  }

  /** An https stylesheet on an allowed font host (display=swap added where the service takes it), or null. */
  function fontUrl(raw: unknown): string | null {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (s.length > 512 || !/^https:\/\/[^\s"'<>\\`]+$/.test(s)) return null;
    let url: URL;
    try { url = new URL(s); } catch { return null; }
    url.hash = "";
    if (url.protocol !== "https:" || url.username || url.password || url.port || FONT_HOSTS.indexOf(url.hostname) === -1) return null;
    if ((url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.bunny.net" || url.hostname === "api.fontshare.com") && !url.searchParams.has("display")) {
      return `${url.href}${url.search ? "&" : "?"}display=swap`;
    }
    return url.href;
  }

  /** One web font when valid (the server's parseWebFont rules), else null. */
  function normalizeWebFont(value: unknown): WebFont | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    const family = typeof v.family === "string" ? v.family.trim().replace(/\s+/g, " ") : "";
    if (!FONT_FAMILY_RE.test(family)) return null;
    if (v.source === "google") {
      if (v.url) return null;
      if (v.weights === undefined || v.weights === null || v.weights === "") return { family, source: "google" };
      const weights = fontWeights(v.weights);
      return weights ? { family, source: "google", weights } : null;
    }
    if (v.source === "url") {
      const url = fontUrl(v.url);
      return url ? { family, source: "url", url } : null;
    }
    return null;
  }

  /** The valid web fonts of one or two lists: at most 8, one per family (the first wins). */
  function normalizeWebFonts(value: unknown, more?: unknown): WebFont[] {
    const out: WebFont[] = [];
    for (const list of [value, more]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const font = normalizeWebFont(item);
        if (!font || out.length >= MAX_WEB_FONTS) continue;
        if (out.some((f) => f.family.toLowerCase() === font.family.toLowerCase())) continue;
        out.push(font);
      }
    }
    return out;
  }

  /** A web font's stylesheet URL. */
  function webFontHref(font: WebFont): string {
    if (font.source === "google") {
      return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family).replace(/%20/g, "+")}${font.weights ? `:wght@${font.weights}` : ""}&display=swap`;
    }
    return font.url || "";
  }

  function parseJson(raw: string | null): unknown {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** How light a colour is, 0–1 (an estimate good enough to pick black or white text), or null. */
  function lightness(color: string): number | null {
    const c = color.trim().toLowerCase();
    if (c.charAt(0) === "#") {
      let hex = c.slice(1);
      if (hex.length === 3 || hex.length === 4) hex = hex.split("").map((x) => x + x).join("");
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      return isNaN(r + g + b) ? null : 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const m = /^([a-z]+)\(\s*([^)]*)\)$/.exec(c);
    if (!m) return null;
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    const num = (s: string | undefined, scale: number) => {
      if (!s) return NaN;
      return s.slice(-1) === "%" ? parseFloat(s) / 100 : parseFloat(s) / scale;
    };
    if (m[1] === "rgb" || m[1] === "rgba") {
      const r = num(parts[0], 255);
      const g = num(parts[1], 255);
      const b = num(parts[2], 255);
      return isNaN(r + g + b) ? null : 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    if (m[1] === "hsl" || m[1] === "hsla") {
      const l = num(parts[2], 100);
      return isNaN(l) ? null : l;
    }
    // oklch / oklab: L is 0–1 (or %); lab / lch: 0–100
    const l = num(parts[0], m[1] === "lab" || m[1] === "lch" ? 100 : 1);
    return isNaN(l) ? null : l;
  }

  /** A readable text colour on a background (null when the colour cannot be read). */
  function contrastOn(color: string): string | null {
    const l = lightness(color);
    if (l === null) return null;
    const perceptual = color.charAt(0) !== "#" && !/^rgba?\(/i.test(color.trim());
    return l > (perceptual ? 0.7 : 0.62) ? "#0f172a" : "#ffffff";
  }

  /** A readable text colour on a gradient: by the average lightness of its two ends. */
  function contrastOnGradient(g: GradientValue): string | null {
    const a = lightness(g.from);
    const b = lightness(g.to);
    if (a === null || b === null) return null;
    const limit = (c: string) => (c.charAt(0) !== "#" && !/^rgba?\(/i.test(c.trim()) ? 0.7 : 0.62);
    return (a + b) / 2 > (limit(g.from) + limit(g.to)) / 2 ? "#0f172a" : "#ffffff";
  }

  /** A gradient's CSS; with `percent` each end is mixed with transparent (the hover state: 90%, like bg-primary/90). */
  function gradientCss(g: GradientValue, percent?: number): string {
    const end = (c: string) => (percent ? `color-mix(in oklab, ${c} ${percent}%, transparent)` : c);
    return `linear-gradient(${g.angle}deg, ${end(g.from)}, ${end(g.to)})`;
  }

  /** A mode's tokens with what derive adds; `derived` names the added ones. */
  function deriveTokens(tokens: TokenMap, derive: boolean): { tokens: TokenMap; derived: string[] } {
    const out: TokenMap = {};
    for (const k of Object.keys(tokens)) out[k] = tokens[k];
    const derived: string[] = [];
    if (!derive) return { tokens: out, derived };
    for (const rule of DERIVE) {
      const target = rule[0];
      if (out[target] !== undefined) continue;
      const contrast = rule[1].indexOf("contrast:") === 0;
      const from = out[contrast ? rule[1].slice(9) : rule[1]];
      let value: string | null;
      if (contrast && from && typeof from === "object") value = contrastOnGradient(from);
      else if (typeof from !== "string") continue;
      else value = contrast ? contrastOn(from) : from;
      if (value === null) continue;
      out[target] = value;
      derived.push(target);
    }
    return { tokens: out, derived };
  }

  function declarations(tokens: TokenMap): string {
    const lines: string[] = [];
    for (const name of Object.keys(TOKENS)) {
      const value = tokens[name];
      if (value === undefined) continue;
      const css = TOKENS[name][0];
      const kind = TOKENS[name][2];
      if (typeof value === "object") {
        // buttonGradient, after buttonPrimaryBg (TOKENS order): a gradient wins over a solid fill
        lines.push(`  ${css}: ${gradientCss(value)};`);
        lines.push(`  --button-primary-hover-bg: ${gradientCss(value, 90)};`);
        continue;
      }
      // a shadow is composed with Tailwind's rings (shadow-card / shadow-raised): "none" would void the list
      const out = kind === "radius" || kind === "blur" ? `${value}px` : kind === "shadow" && value === "none" ? "0 0 #0000" : value;
      lines.push(`  ${css}: ${out};`);
      if (name === "buttonPrimaryBg") lines.push(`  --button-primary-hover-bg: color-mix(in oklab, ${value} 90%, transparent);`);
      // the primary button's glow: on hover, the look's strong glow in the primary adds to it (none stays none)
      if (name === "shadowButtonPrimary") {
        lines.push(`  --shadow-button-primary-hover: ${value === "none" ? "0 0 #0000"
          : `${value}, var(--shadow-glow-strong) color-mix(in oklch, var(--primary) 55%, transparent)`};`);
      }
      // a backdrop-filter only when blurring: any value but none makes the sidebar a containing block
      if (name === "sidebarBlur") lines.push(`  --sidebar-backdrop: ${typeof value === "number" && value > 0 ? `blur(${value}px)` : "none"};`);
      // the sans font is also Tailwind's --font-sans
      if (name === "fontFamily") lines.push(`  --font-sans: ${value};`);
    }
    return lines.join("\n");
  }

  /**
   * The overrides stylesheet. Selectors outrank the palettes' (:root[data-palette="x"]): the inline
   * boot script adds it to <head> before the stylesheet loads, so order alone would not win.
   */
  function overridesCss(custom: BootCustom): string | null {
    if (!custom.enabled) return null;
    const light = deriveTokens(custom.light, custom.derive).tokens;
    const dark = deriveTokens(custom.dark, custom.derive).tokens;
    // Only the variables: index.css reads every token by name (body and headings, code, the
    // shadow-card / shadow-raised utilities, the type scale), palettes included.
    const blocks = [
      "html:root, html:root[data-palette] {", declarations(light), "}",
      "html:root.dark, html:root.dark[data-palette] {", declarations(dark), "}",
    ];
    return blocks.join("\n");
  }

  /** The look to show (pure): browser choice, else instance default, else built-in default, field by field. */
  function resolve(input: ResolveInput): ResolvedAppearance {
    const inst = input.instance && typeof input.instance === "object" ? input.instance : null;
    let theme: BootTheme = DEFAULT_THEME;
    let themeSource: LayerSource = "default";
    if (isTheme(input.stored.theme)) { theme = input.stored.theme; themeSource = "browser"; }
    else if (inst && isTheme(inst.theme)) { theme = inst.theme; themeSource = "instance"; }
    let palette = DEFAULT_PALETTE;
    let paletteSource: LayerSource = "default";
    if (isPalette(input.stored.palette)) { palette = input.stored.palette; paletteSource = "browser"; }
    else if (inst && isPalette(inst.palette)) { palette = inst.palette; paletteSource = "instance"; }
    const storedCustom = parseJson(input.stored.custom);
    let custom = normalizeCustom(null);
    let customSource: LayerSource = "default";
    if (storedCustom && typeof storedCustom === "object") { custom = normalizeCustom(storedCustom); customSource = "browser"; }
    else if (inst && inst.custom && typeof inst.custom === "object") { custom = normalizeCustom(inst.custom); customSource = "instance"; }
    // the instance's web fonts are part of its look (a browser's own look keeps its own fonts)
    const instFonts = inst ? normalizeWebFonts(inst.fonts) : [];
    if (customSource !== "browser" && instFonts.length) custom = { ...custom, fonts: instFonts };
    const dark = theme === "system" ? input.prefersDark : theme === "dark";
    const colorsFor = THEME_COLORS[palette] || THEME_COLORS[DEFAULT_PALETTE];
    const bg = custom.enabled ? (dark ? custom.dark : custom.light).background : undefined;
    return {
      theme, dark, palette, custom,
      // this look's web fonts and the instance's (a browser's look may name an instance font)
      fonts: normalizeWebFonts(custom.fonts, instFonts),
      css: overridesCss(custom),
      themeColor: typeof bg === "string" ? bg : colorsFor[dark ? 1 : 0],
      sources: { theme: themeSource, palette: paletteSource, custom: customSource },
    };
  }

  /** The bundled font families a look uses (its custom fonts, either mode). */
  function bundledFontsUsed(custom: BootCustom): string[] {
    if (!custom.enabled) return [];
    const fonts: string[] = [];
    for (const mode of [custom.light, custom.dark]) {
      for (const key of ["fontFamily", "headingFont"]) {
        const value = mode[key];
        if (typeof value === "string") fonts.push(value);
      }
    }
    return Object.keys(BUNDLED_FONTS).filter((family) => fonts.some((stack) => stack.indexOf(family) !== -1));
  }

  /** A preload for each bundled font the look uses; none left for the others. */
  function applyFontPreloads(doc: KitDocument, custom: BootCustom, assetBase: string): void {
    const used = bundledFontsUsed(custom);
    for (const family of Object.keys(BUNDLED_FONTS)) {
      const id = FONT_PRELOAD_PREFIX + slug(family);
      let link = doc.getElementById(id);
      if (used.indexOf(family) === -1) {
        if (link) link.remove();
        continue;
      }
      if (!link) {
        link = doc.createElement("link");
        link.id = id;
        link.setAttribute("rel", "preload");
        link.setAttribute("as", "font");
        link.setAttribute("type", "font/woff2");
        link.setAttribute("crossorigin", "anonymous");
        doc.head.appendChild(link);
      }
      link.setAttribute("href", assetBase + BUNDLED_FONTS[family]);
    }
  }

  /**
   * A preconnect and a stylesheet per web font; the ones no longer used are removed. On the first
   * paint (the inline script) the stylesheets are render-blocking like index.html's own font
   * stylesheets, so the first frame already knows the families (font-display: swap).
   */
  function applyWebFonts(doc: KitDocument, fonts: WebFont[], firstPaint: boolean): void {
    const wanted: Record<string, true> = {};
    for (const font of fonts) {
      const href = webFontHref(font);
      let host = "";
      try { host = new URL(href).hostname; } catch { continue; }
      const id = WEB_FONT_PREFIX + slug(font.family);
      wanted[id] = true;
      const origins = [`https://${host}`];
      if (FONT_FILE_HOSTS[host]) origins.push(FONT_FILE_HOSTS[host]);
      for (const origin of origins) {
        const pid = `${WEB_FONT_PREFIX}preconnect-${slug(origin.slice(8))}`;
        wanted[pid] = true;
        if (doc.getElementById(pid)) continue;
        const pre = doc.createElement("link");
        pre.id = pid;
        pre.setAttribute("rel", "preconnect");
        pre.setAttribute("href", origin);
        if (origin !== `https://${host}`) pre.setAttribute("crossorigin", "anonymous");
        doc.head.appendChild(pre);
      }
      let link = doc.getElementById(id);
      if (!link) {
        link = doc.createElement("link");
        link.id = id;
        link.setAttribute("rel", "stylesheet");
        if (firstPaint) link.setAttribute("blocking", "render");
        doc.head.appendChild(link);
      }
      if (!link.getAttribute || link.getAttribute("href") !== href) link.setAttribute("href", href);
    }
    const existing = doc.querySelectorAll ? doc.querySelectorAll(`link[id^="${WEB_FONT_PREFIX}"]`) : [];
    const stale: KitElement[] = [];
    for (let i = 0; i < existing.length; i++) if (!wanted[existing[i].id]) stale.push(existing[i]);
    for (const el of stale) el.remove();
  }

  /** Put a resolved look on the page: the theme class, the palette, the overrides stylesheet, theme-color, fonts. */
  function apply(doc: KitDocument, r: ResolvedAppearance, assetBase = "/", firstPaint = false): void {
    try { applyFontPreloads(doc, r.custom, assetBase); } catch { /* the look applies anyway */ }
    try { applyWebFonts(doc, r.fonts || [], firstPaint); } catch { /* the look applies anyway */ }
    const root = doc.documentElement;
    root.classList.toggle("dark", r.dark);
    root.dataset.palette = r.palette;
    let style = doc.getElementById(STYLE_ID);
    if (r.css) {
      if (!style) {
        style = doc.createElement("style");
        style.id = STYLE_ID;
      }
      if (style.textContent !== r.css) style.textContent = r.css;
      // last in <head>, after the stylesheets (they may have been added since)
      if (doc.head.lastElementChild !== style) doc.head.appendChild(style);
    } else if (style) {
      style.remove();
    }
    const meta = doc.querySelector("meta[name=\"theme-color\"]");
    if (meta) meta.setAttribute("content", r.themeColor);
  }

  function storageGet(win: KitWindow, key: string): string | null {
    try { return win.localStorage ? win.localStorage.getItem(key) : null; } catch { return null; }
  }

  /** Where this page's choices live: the API scope and the last instance seen on it. */
  function scopes(win: KitWindow, buildBaseUrl: string): { api: string; instance: string } {
    const rc = win.__POLPO_RUNTIME_CONFIG__ || {};
    const api = apiScope((rc.baseUrl !== undefined && rc.baseUrl !== null ? rc.baseUrl : buildBaseUrl) || "", win.location ? win.location.origin : "");
    return { api, instance: storageGet(win, `${LAST_SCOPE_KEY}:${api}`) || "default" };
  }

  /** The instance default: runtime-config.js when it carries one (even empty), else the cached copy. */
  function instanceDefault(win: KitWindow, api: string): InstanceAppearance | null {
    const rc = win.__POLPO_RUNTIME_CONFIG__;
    if (rc && Object.prototype.hasOwnProperty.call(rc, "appearance") && rc.appearance !== undefined) return rc.appearance || null;
    const cached = parseJson(storageGet(win, `${INSTANCE_KEY}:${api}`));
    return cached && typeof cached === "object" ? cached as InstanceAppearance : null;
  }

  /** Everything resolve() needs, read from the page (never throws). */
  function read(win: KitWindow, buildBaseUrl: string, scopeOverride?: string): ResolveInput {
    const s = scopes(win, buildBaseUrl);
    const instance = scopeOverride || s.instance;
    let prefersDark = true;
    try { prefersDark = win.matchMedia ? win.matchMedia("(prefers-color-scheme: dark)").matches : true; } catch { /* keep dark */ }
    return {
      stored: {
        theme: storageGet(win, scopedKey(KEYS.theme, s.api, instance)),
        palette: storageGet(win, scopedKey(KEYS.palette, s.api, instance)),
        custom: storageGet(win, scopedKey(KEYS.custom, s.api, instance)),
      },
      instance: instanceDefault(win, s.api),
      prefersDark,
    };
  }

  /** Resolve and apply from the page's state; a failure leaves the page's default look. */
  function boot(win: KitWindow, buildBaseUrl: string, assetBase = "/"): ResolvedAppearance | null {
    let r: ResolvedAppearance | null = null;
    try {
      r = resolve(read(win, buildBaseUrl));
      apply(win.document, r, assetBase, true);
    } catch {
      r = null;
    }
    // the branding after the look: the logo to preload depends on the theme just applied
    try { bootBranding(win, buildBaseUrl, r ? r.dark : true); } catch { /* keep the page's defaults */ }
    return r;
  }

  // ── Branding: the product name, the logo ─────────────────────────────

  /** Only the display fields, as strings; an unknown frame is the default. */
  function normalizeBranding(value: unknown): InstanceBranding {
    const out: InstanceBranding = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    const v = value as Record<string, unknown>;
    for (const key of ["productName", "tagline", "logoUrl", "logoDarkUrl"] as const) {
      const field = v[key];
      if (typeof field === "string" && field.trim()) out[key] = field.trim();
    }
    if (v.logoFrame === "box" || v.logoFrame === "none") out.logoFrame = v.logoFrame;
    return out;
  }

  /** The instance branding: runtime-config.js when it carries one (even empty), else the cached copy. */
  function instanceBranding(win: KitWindow, api: string): InstanceBranding | null {
    const rc = win.__POLPO_RUNTIME_CONFIG__;
    if (rc && Object.prototype.hasOwnProperty.call(rc, "branding") && rc.branding !== undefined) return rc.branding ? normalizeBranding(rc.branding) : null;
    const cached = parseJson(storageGet(win, `${BRANDING_KEY}:${api}`));
    return cached && typeof cached === "object" ? normalizeBranding(cached) : null;
  }

  /**
   * The browser tab: the product name, then " · page" when there is one; without a product name
   * the default ("Polpo ZHC — AI Factory", or "Polpo ZHC · page").
   */
  function brandingTitle(b: InstanceBranding | null | undefined, page?: string): string {
    const name = b && b.productName;
    if (page) return `${name || DEFAULT_PRODUCT_NAME} · ${page}`;
    return name || `${DEFAULT_PRODUCT_NAME} — ${DEFAULT_PRODUCT_TAGLINE}`;
  }

  /** A logo URL the page may load: http(s), a data: image, or a path on the API. */
  function logoHref(url: string | undefined, baseUrl: string): string | null {
    if (!url) return null;
    if (url.charAt(0) === "/" && url.charAt(1) !== "/") return `${baseUrl}${url}`;
    return /^(https?:\/\/|data:image\/)/i.test(url) ? url : null;
  }

  /** The logo shown first: in dark mode the dark one (else the logo), otherwise the logo. */
  function brandingLogo(b: InstanceBranding | null | undefined, dark: boolean, baseUrl: string): string | null {
    if (!b) return null;
    return (dark ? logoHref(b.logoDarkUrl, baseUrl) : null) || logoHref(b.logoUrl, baseUrl);
  }

  /** Put the branding on the page: the title (and the home-screen name), a preload for the logo. */
  function applyBranding(doc: KitDocument, b: InstanceBranding | null, dark: boolean, baseUrl: string, page?: string): void {
    if (b || page) doc.title = brandingTitle(b, page);
    if (!b) return;
    if (b.productName) {
      const meta = doc.querySelector("meta[name=\"apple-mobile-web-app-title\"]");
      if (meta) meta.setAttribute("content", b.productName);
    }
    const href = brandingLogo(b, dark, baseUrl);
    let link = doc.getElementById(LOGO_PRELOAD_ID);
    if (!href) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = doc.createElement("link");
      link.id = LOGO_PRELOAD_ID;
      link.setAttribute("rel", "preload");
      link.setAttribute("as", "image");
      link.setAttribute("fetchpriority", "high");
      doc.head.appendChild(link);
    }
    link.setAttribute("href", href);
  }

  function bootBranding(win: KitWindow, buildBaseUrl: string, dark: boolean): InstanceBranding | null {
    const rc = win.__POLPO_RUNTIME_CONFIG__ || {};
    const baseUrl = (rc.baseUrl !== undefined && rc.baseUrl !== null ? rc.baseUrl : buildBaseUrl) || "";
    const b = instanceBranding(win, scopes(win, buildBaseUrl).api);
    applyBranding(win.document, b, dark, baseUrl);
    return b;
  }

  return {
    PALETTES, DEFAULT_PALETTE, DEFAULT_THEME, THEME_COLORS, TOKENS, DERIVE, STYLE_ID, KEYS, LAST_SCOPE_KEY, INSTANCE_KEY,
    slug, apiScope, scopedKey, isTheme, isPalette, tokenValue, normalizeTokens, normalizeCustom, lightness, contrastOn, deriveTokens,
    overridesCss, resolve, apply, read, boot, instanceDefault,
    BUNDLED_FONTS, FONT_PRELOAD_PREFIX, bundledFontsUsed,
    RANGES, GRADIENT_ANGLE, FONT_HOSTS, WEB_FONT_PREFIX, normalizeWebFont, normalizeWebFonts, webFontHref, fontWeights, fontUrl, gradientCss, contrastOnGradient, applyWebFonts,
    BRANDING_KEY, DEFAULT_PRODUCT_NAME, DEFAULT_PRODUCT_TAGLINE, LOGO_PRELOAD_ID,
    normalizeBranding, instanceBranding, brandingTitle, brandingLogo, applyBranding, bootBranding,
  };
}

export type AppearanceKit = ReturnType<typeof appearanceKit>;

/**
 * The inline <head> script: the kit's own source, run on the page. `buildBaseUrl` is the API URL
 * baked in at build time (VITE_POLPO_API_URL), used when runtime-config.js does not name one;
 * `assetBase` the app's base (Vite's `base`), for the bundled fonts.
 */
export function bootScriptSource(buildBaseUrl = "", assetBase = "/"): string {
  const source = `(function(){try{(${appearanceKit.toString()})().boot(window,${JSON.stringify(buildBaseUrl)},${JSON.stringify(assetBase)});}catch(e){}})();`;
  // never let the source close the <script> element it is inlined in
  return source.replace(/<\/(script)/gi, "<\\/$1");
}
