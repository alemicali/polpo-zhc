/**
 * The look before the first paint: the pure resolver (browser choice > instance default > built-in),
 * token derivation, the inline <head> script (the kit's own source, as vite.config.ts inlines it),
 * the import parser and the dark-mode logo fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appearanceKit, bootScriptSource, type InstanceAppearance } from "@/lib/appearance-kit";
import { parseImportedAppearance } from "@/lib/appearance-import";
import { brandLogoCandidates } from "@/lib/brand-logo";
import { APPEARANCE_TOKENS, APPEARANCE_PALETTES } from "../../packages/core/src/appearance";

const kit = appearanceKit();
const none = { theme: null, palette: null, custom: null };

describe("resolve: browser choice, else instance default, else built-in", () => {
  it("uses the built-in default with nothing chosen", () => {
    const r = kit.resolve({ stored: none, instance: null, prefersDark: false });
    expect(r).toMatchObject({ theme: "dark", dark: true, palette: "tide", css: null, themeColor: "#0a0e1a" });
    expect(r.sources).toEqual({ theme: "default", palette: "default", custom: "default" });
  });

  it("uses the instance default, field by field, and the browser's choice over it", () => {
    const instance: InstanceAppearance = { theme: "light", palette: "claude", custom: { enabled: true, light: { primary: "#c96442" } } };
    const r = kit.resolve({ stored: none, instance, prefersDark: true });
    expect(r).toMatchObject({ theme: "light", dark: false, palette: "claude", themeColor: "#f7f6f2" });
    expect(r.sources).toEqual({ theme: "instance", palette: "instance", custom: "instance" });
    expect(r.css).toContain("--primary: #c96442;");
    const mine = kit.resolve({ stored: { theme: "system", palette: null, custom: null }, instance, prefersDark: true });
    expect(mine).toMatchObject({ theme: "system", dark: true, palette: "claude" });
    expect(mine.sources).toEqual({ theme: "browser", palette: "instance", custom: "instance" });
  });

  it("ignores invalid values from storage or the API", () => {
    const r = kit.resolve({ stored: { theme: "purple", palette: "nope", custom: "{not json" }, instance: { theme: "x" as never, palette: "y" }, prefersDark: false });
    expect(r).toMatchObject({ theme: "dark", palette: "tide", css: null });
  });

  it("reads the old single-theme shape a browser may have stored", () => {
    const r = kit.resolve({ stored: { ...none, custom: JSON.stringify({ enabled: true, primary: "#112233", accent: "#445566", text: "#000000", radius: 4 }) }, instance: null, prefersDark: false });
    expect(r.custom.light).toMatchObject({ primary: "#112233", secondary: "#445566", foreground: "#000000", radius: 4 });
    expect(r.css).toContain("--accent: #445566;");
  });
});

describe("design tokens", () => {
  it("are the same list as the server's (packages/core/src/appearance.ts)", () => {
    expect(Object.keys(kit.TOKENS).sort()).toEqual(Object.keys(APPEARANCE_TOKENS).sort());
    for (const [name, [css, group, kind]] of Object.entries(kit.TOKENS)) {
      expect({ css, group, kind }, name).toEqual(APPEARANCE_TOKENS[name as keyof typeof APPEARANCE_TOKENS]);
    }
    expect(kit.PALETTES).toEqual([...APPEARANCE_PALETTES]);
  });

  it("derive the rest from a few: foregrounds by contrast, ring and sidebar from primary, surfaces from background", () => {
    const { tokens, derived } = kit.deriveTokens({ primary: "#1d4ed8", background: "oklch(0.98 0.01 80)", foreground: "#111111", border: "#dddddd" }, true);
    expect(tokens).toMatchObject({
      primaryForeground: "#ffffff", ring: "#1d4ed8", sidebarPrimary: "#1d4ed8", sidebarRing: "#1d4ed8", chart1: "#1d4ed8",
      card: "oklch(0.98 0.01 80)", popover: "oklch(0.98 0.01 80)", sidebar: "oklch(0.98 0.01 80)",
      cardForeground: "#111111", popoverForeground: "#111111", sidebarForeground: "#111111", input: "#dddddd", sidebarBorder: "#dddddd",
    });
    expect(derived).toContain("ring");
    expect(kit.deriveTokens({ primary: "#fde047" }, true).tokens.primaryForeground).toBe("#0f172a");
    expect(kit.deriveTokens({ primary: "oklch(0.9 0.1 100)" }, true).tokens.primaryForeground).toBe("#0f172a");
    expect(kit.deriveTokens({ primary: "hsl(220 80% 30%)" }, true).tokens.primaryForeground).toBe("#ffffff");
    // given tokens win; derive off adds nothing
    expect(kit.deriveTokens({ primary: "#1d4ed8", ring: "#ff0000" }, true).tokens.ring).toBe("#ff0000");
    expect(kit.deriveTokens({ primary: "#1d4ed8" }, false)).toEqual({ tokens: { primary: "#1d4ed8" }, derived: [] });
  });

  it("refuse values that could break out of the stylesheet", () => {
    expect(kit.tokenValue("primary", "red; } body { display: none")).toBeUndefined();
    expect(kit.tokenValue("fontFamily", "Inter; } * {")).toBeUndefined();
    expect(kit.tokenValue("shadowCard", "0 0 1px url(https://x)")).toBeUndefined();
    expect(kit.tokenValue("radius", 99)).toBe(24);
    expect(kit.tokenValue("primary", "oklch(0.6 0.115 205)")).toBe("oklch(0.6 0.115 205)");
    expect(kit.tokenValue("nope", "#fff")).toBeUndefined();
  });

  it("outrank the palettes and style fonts and cards when set", () => {
    const css = kit.overridesCss(kit.normalizeCustom({ enabled: true, light: { headingFont: "\"Newsreader\", serif", monoFont: "monospace", shadowCard: "none" }, dark: {} }))!;
    expect(css).toContain("html:root, html:root[data-palette] {");
    expect(css).toContain("html:root.dark, html:root.dark[data-palette] {");
    expect(css).toMatch(/h1.*font-family: var\(--app-heading-font\)/);
    expect(css).toMatch(/code.*font-family: var\(--app-mono-font\)/);
    expect(css).toContain("box-shadow: var(--shadow-card)");
  });
});

describe("the inline <head> script", () => {
  const run = (rc: unknown) => {
    (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = rc;
    new Function(bootScriptSource(""))();
  };

  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#0a0e1a">';
    document.documentElement.className = "dark";
    delete document.documentElement.dataset.palette;
    localStorage.clear();
  });
  afterEach(() => {
    delete (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__;
  });

  it("is self-contained and never closes its <script>", () => {
    const src = bootScriptSource("https://api.example.com");
    expect(src).not.toMatch(/<\/script/i);
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
    expect(src).toContain("\"https://api.example.com\"");
  });

  it("paints the instance default from runtime-config.js before anything else runs", () => {
    run({ appearance: { theme: "light", palette: "redline", custom: { enabled: true, light: { primary: "#e93f33" } } } });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.palette).toBe("redline");
    expect(document.getElementById("polpo-appearance-overrides")?.textContent).toContain("--primary: #e93f33;");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f5f5f1");
  });

  it("uses this browser's choices, under the instance it saw last", () => {
    const api = kit.apiScope("", window.location.origin);
    localStorage.setItem(`polpo-appearance-scope:${api}`, "shoplix");
    localStorage.setItem(`polpo-palette:${api}:shoplix`, "mono");
    localStorage.setItem(`polpo-theme:${api}:default`, "light"); // another instance's: not this one
    run({ appearance: { palette: "claude" } });
    expect(document.documentElement.dataset.palette).toBe("mono");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("falls back to the cached instance default without runtime-config.js (Electron, nginx)", () => {
    const api = kit.apiScope("", window.location.origin);
    localStorage.setItem(`polpo-instance-appearance:${api}`, JSON.stringify({ theme: "light", palette: "cyber" }));
    run(undefined);
    expect(document.documentElement.dataset.palette).toBe("cyber");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("never throws, even when storage does", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      expect(() => run({ appearance: { theme: "light" } })).not.toThrow();
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });
});

describe("import and the dark-mode logo", () => {
  it("imports a whole look or just the tokens, and refuses bad ones", () => {
    expect(parseImportedAppearance('{"theme":"light","palette":"mono"}')).toEqual({ ok: true, value: { theme: "light", palette: "mono" } });
    const tokens = parseImportedAppearance('{"light":{"primary":"#123456"},"dark":{}}');
    expect(tokens).toMatchObject({ ok: true, value: { custom: { enabled: true, light: { primary: "#123456" } } } });
    expect(parseImportedAppearance('{"light":{"primary":"red;}"}}')).toMatchObject({ ok: false });
    expect(parseImportedAppearance('{"custom":{"light":{"nope":"#fff"}}}')).toMatchObject({ ok: false });
    expect(parseImportedAppearance("not json")).toMatchObject({ ok: false });
  });

  it("shows the dark-mode logo in dark mode, the logo otherwise and as its fallback", () => {
    const b = { logoUrl: "https://cdn.example.com/light.png", logoDarkUrl: "https://cdn.example.com/dark.png" };
    expect(brandLogoCandidates(b, true)).toEqual(["https://cdn.example.com/dark.png", "https://cdn.example.com/light.png"]);
    expect(brandLogoCandidates(b, false)).toEqual(["https://cdn.example.com/light.png"]);
    expect(brandLogoCandidates({ logoUrl: b.logoUrl }, true)).toEqual([b.logoUrl]);
    expect(brandLogoCandidates({ logoDarkUrl: b.logoDarkUrl }, false)).toEqual([]);
    expect(brandLogoCandidates(undefined, true)).toEqual([]);
  });
});
