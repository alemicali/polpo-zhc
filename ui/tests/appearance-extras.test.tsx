/**
 * The appearance extras: web fonts (validated the same in the dashboard and on the server, loaded
 * by the inline <head> script), the primary button's fill or gradient, card and control radius,
 * the sidebar's opacity and blur — their CSS output, their defaults (today's look) and validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appearanceKit, bootScriptSource } from "@/lib/appearance-kit";
import { parseImportedAppearance } from "@/lib/appearance-import";
import {
  APPEARANCE_FONT_HOSTS, APPEARANCE_NUMBER_RANGES, parseAppearanceSettings, sanitizeAppearanceSettings, unloadedFontFamilies, webFontHref,
} from "../../packages/core/src/appearance";

const UI = resolve(process.cwd(), process.cwd().endsWith("/ui") ? "." : "ui");
const kit = appearanceKit();
const css = (light: Record<string, unknown>, dark: Record<string, unknown> = {}) => kit.overridesCss(kit.normalizeCustom({ enabled: true, light, dark }))!;

describe("web fonts", () => {
  const bad = [
    { family: "Evil", source: "url", url: "https://evil.example.com/font.css" },
    { family: "Plain", source: "url", url: "http://fonts.googleapis.com/css2?family=Plain" },
    { family: "Port", source: "url", url: "https://fonts.googleapis.com:8443/css2?family=Port" },
    { family: "Creds", source: "url", url: "https://user:pw@fonts.bunny.net/css?family=x" },
    { family: "Lookalike", source: "url", url: "https://fonts.googleapis.com.evil.io/css" },
    { family: "Quote", source: "url", url: "https://rsms.me/inter.css\"><script>" },
    { family: "Inter; } body {", source: "google" },
    { family: "Manrope", source: "google", weights: "950" },
    { family: "Manrope", source: "google", weights: "700..300" },
    { family: "Manrope", source: "google", url: "https://fonts.googleapis.com/css2?family=Manrope" },
    { family: "Manrope", source: "ftp" },
  ];

  it("are refused on the server unless https on an allowed host, with a clean family and weights", () => {
    for (const font of bad) expect(() => parseAppearanceSettings({ fonts: [font] }), JSON.stringify(font)).toThrow(/settings\.appearance\.fonts\[0\]/);
    expect(() => parseAppearanceSettings({ fonts: "Manrope" })).toThrow(/list of web fonts/);
    expect(() => parseAppearanceSettings({ fonts: Array.from({ length: 9 }, (_, i) => ({ family: `F${i}`, source: "google" })) })).toThrow(/at most 8/);
    expect(() => parseAppearanceSettings({ fonts: [{ family: "A", source: "google" }, { family: "a", source: "google" }] })).toThrow(/twice/);
    expect(parseAppearanceSettings({ fonts: [
      { family: " Manrope ", source: "google", weights: "700, 400 600" },
      { family: "Roboto Flex", source: "google", weights: "300..800" },
      { family: "Bunny", source: "url", url: "https://fonts.bunny.net/css?family=bunny:400" },
      { family: "Inter", source: "url", url: "https://rsms.me/inter/inter.css" },
    ] }).fonts).toEqual([
      { family: "Manrope", source: "google", weights: "400;600;700" },
      { family: "Roboto Flex", source: "google", weights: "300..800" },
      { family: "Bunny", source: "url", url: "https://fonts.bunny.net/css?family=bunny:400&display=swap" },
      { family: "Inter", source: "url", url: "https://rsms.me/inter/inter.css" },
    ]);
    expect(APPEARANCE_FONT_HOSTS).toEqual(kit.FONT_HOSTS);
  });

  it("from the config file: the bad ones are dropped, the rest kept", () => {
    const { value, problems } = sanitizeAppearanceSettings({ fonts: [bad[0], { family: "Manrope", source: "google" }] });
    expect(value.fonts).toEqual([{ family: "Manrope", source: "google" }]);
    expect(problems.join(" ")).toMatch(/fonts\[0\]\.url/);
  });

  it("are checked the same in the dashboard (the kit), and build the same URL", () => {
    for (const font of bad) expect(kit.normalizeWebFont(font), JSON.stringify(font)).toBeNull();
    const google = { family: "Space Grotesk", source: "google" as const, weights: "400;700" };
    expect(kit.webFontHref(google)).toBe("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap");
    expect(kit.webFontHref(google)).toBe(webFontHref(google));
  });

  it("names the families a look uses but nobody loads", () => {
    expect(unloadedFontFamilies({ custom: { enabled: true, light: { fontFamily: "\"Manrope\", \"Inter Tight\", Georgia, sans-serif", headingFont: "Satoshi" } } })).toEqual(["Manrope"]);
    expect(unloadedFontFamilies({ custom: { enabled: true, light: { fontFamily: "Manrope, sans-serif" } }, fonts: [{ family: "Manrope", source: "google" }] })).toEqual([]);
  });

  it("import with a look", () => {
    expect(parseImportedAppearance('{"fonts":[{"family":"Manrope","source":"google"}]}')).toEqual({ ok: true, value: { fonts: [{ family: "Manrope", source: "google" }] } });
    expect(parseImportedAppearance('{"fonts":[{"family":"X","source":"url","url":"https://evil.example.com/x.css"}]}')).toMatchObject({ ok: false });
  });
});

describe("the inline <head> script loads web fonts before the first paint", () => {
  const run = (rc: unknown) => {
    (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = rc;
    new Function(bootScriptSource(""))();
  };
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#0a0e1a">';
    localStorage.clear();
  });
  afterEach(() => {
    delete (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__;
  });

  it("adds a preconnect and a render-blocking stylesheet per instance font (runtime-config.js)", () => {
    run({ appearance: { fonts: [{ family: "Manrope", source: "google", weights: "400;700" }, { family: "Inter", source: "url", url: "https://rsms.me/inter/inter.css" }] } });
    const manrope = document.getElementById("polpo-webfont-manrope")!;
    expect(manrope.getAttribute("rel")).toBe("stylesheet");
    expect(manrope.getAttribute("blocking")).toBe("render");
    expect(manrope.getAttribute("href")).toBe("https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap");
    expect(document.getElementById("polpo-webfont-inter")!.getAttribute("href")).toBe("https://rsms.me/inter/inter.css");
    const preconnects = [...document.querySelectorAll('link[rel="preconnect"]')].map((l) => l.getAttribute("href"));
    expect(preconnects).toEqual(expect.arrayContaining(["https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://rsms.me"]));
    expect(document.querySelector('link[href="https://fonts.gstatic.com"]')!.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("drops fonts no longer used, and never loads a bad one (a cached or tampered value)", () => {
    run({ appearance: { fonts: [{ family: "Manrope", source: "google" }] } });
    expect(document.getElementById("polpo-webfont-manrope")).not.toBeNull();
    run({ appearance: { fonts: [{ family: "Evil", source: "url", url: "https://evil.example.com/x.css" }] } });
    expect(document.querySelectorAll('link[id^="polpo-webfont-"]')).toHaveLength(0);
  });

  it("loads a browser's own fonts and the instance's", () => {
    const api = kit.apiScope("", window.location.origin);
    localStorage.setItem(`polpo-appearance:${api}:default`, JSON.stringify({ enabled: true, light: {}, dark: {}, fonts: [{ family: "Sora", source: "google" }] }));
    run({ appearance: { fonts: [{ family: "Manrope", source: "google" }] } });
    expect(document.getElementById("polpo-webfont-sora")).not.toBeNull();
    expect(document.getElementById("polpo-webfont-manrope")).not.toBeNull();
  });
});

describe("the primary button", () => {
  it("keeps today's look by default: the primary colour, hover at 90%, its foreground", () => {
    const index = readFileSync(resolve(UI, "src/index.css"), "utf8");
    expect(index).toContain("--button-primary-bg: var(--primary);");
    expect(index).toContain("--button-primary-hover-bg: color-mix(in oklab, var(--primary) 90%, transparent);");
    expect(index).toContain("--button-primary-foreground: var(--primary-foreground);");
    const button = readFileSync(resolve(UI, "src/components/ui/button.tsx"), "utf8");
    expect(button).toContain('default: "bg-button-primary text-button-primary-foreground hover:bg-button-primary-hover"');
    // the other variants keep their own colours
    expect(button).toContain("bg-destructive text-destructive-foreground");
    expect(button).toContain("bg-secondary text-secondary-foreground");
  });

  it("a solid fill: the fill, a derived hover and readable text", () => {
    const out = css({ buttonPrimaryBg: "#fde047" });
    expect(out).toContain("--button-primary-bg: #fde047;");
    expect(out).toContain("--button-primary-hover-bg: color-mix(in oklab, #fde047 90%, transparent);");
    expect(out).toContain("--button-primary-foreground: #0f172a;");
  });

  it("a gradient: built from checked parts, wins over a solid fill, readable text on it", () => {
    const out = css({ buttonPrimaryBg: "#000000", buttonGradient: { from: "#7c3aed", to: "#db2777", angle: 90 } });
    expect(out).toContain("--button-primary-bg: linear-gradient(90deg, #7c3aed, #db2777);");
    expect(out.indexOf("linear-gradient(90deg, #7c3aed")).toBeGreaterThan(out.indexOf("--button-primary-bg: #000000"));
    expect(out).toContain("--button-primary-hover-bg: linear-gradient(90deg, color-mix(in oklab, #7c3aed 90%, transparent), color-mix(in oklab, #db2777 90%, transparent));");
    expect(out).toContain("--button-primary-foreground: #ffffff;");
    expect(css({ buttonGradient: { from: "#fef08a", to: "#fde68a" } })).toContain("--button-primary-foreground: #0f172a;");
    expect(kit.tokenValue("buttonGradient", { from: "#123456", to: "#654321" })).toEqual({ from: "#123456", to: "#654321", angle: 135 });
    expect(css({ buttonGradient: { from: "#7c3aed", to: "#db2777" }, buttonPrimaryForeground: "#111111" })).toContain("--button-primary-foreground: #111111;");
  });

  it("refuses bad gradients (dashboard and server)", () => {
    for (const g of [{ from: "red; } body {", to: "#000000" }, { from: "#000000" }, { from: "#000000", to: "#ffffff", angle: "90deg" }, "linear-gradient(#000, #fff)"]) {
      expect(kit.tokenValue("buttonGradient", g), JSON.stringify(g)).toBeUndefined();
      expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { buttonGradient: g } } })).toThrow(/buttonGradient/);
    }
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { buttonGradient: { from: "#000000", to: "#ffffff", angle: 400 } } } })).toThrow(/angle/);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { buttonGradient: { from: "#000000", to: "#ffffff", stops: 3 } } } })).toThrow(/unknown field stops/);
  });
});

describe("card and control radius", () => {
  it("default to today's (rounded-xl, rounded-md from --radius); cards and controls use them", () => {
    const index = readFileSync(resolve(UI, "src/index.css"), "utf8");
    expect(index).toContain("--radius-card: calc(var(--radius) + 4px);");
    expect(index).toContain("--radius-control: calc(var(--radius) - 2px);");
    expect(readFileSync(resolve(UI, "src/components/ui/card.tsx"), "utf8")).toContain("rounded-card");
    for (const file of ["button", "input", "select", "textarea"]) {
      expect(readFileSync(resolve(UI, `src/components/ui/${file}.tsx`), "utf8"), file).toContain("rounded-control");
    }
  });

  it("set apart, in px, 0–32", () => {
    const out = css({ radius: 8, radiusCard: 20, radiusControl: 4 });
    expect(out).toContain("--radius: 8px;");
    expect(out).toContain("--radius-card: 20px;");
    expect(out).toContain("--radius-control: 4px;");
    expect(kit.tokenValue("radiusCard", 99)).toBe(32);
    expect(kit.tokenValue("radius", 30)).toBe(24);
    expect(APPEARANCE_NUMBER_RANGES.radiusCard).toEqual(kit.RANGES.radiusCard);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { radiusCard: 33 } } })).toThrow(/0 to 32/);
    expect(parseAppearanceSettings({ custom: { enabled: true, light: { radiusCard: 32 } } }).custom?.light?.radiusCard).toBe(32);
  });
});

describe("sidebar translucency", () => {
  it("defaults to opaque without a backdrop filter; falls back to opaque without backdrop-filter support", () => {
    const index = readFileSync(resolve(UI, "src/index.css"), "utf8");
    expect(index).toMatch(/--sidebar-opacity: 1;\s*--sidebar-blur: 0px;\s*--sidebar-backdrop: none;/);
    const utility = index.slice(index.indexOf("@utility sidebar-surface {"), index.indexOf("@utility sidebar-surface-floating"));
    expect(utility).toMatch(/^@utility sidebar-surface {\s*background-color: var\(--sidebar\);\s*@supports \(\(backdrop-filter/);
    expect(utility).toContain("color-mix(in oklab, var(--sidebar) calc(var(--sidebar-opacity) * 100%), transparent)");
    expect(readFileSync(resolve(UI, "src/components/layout/sidebar.tsx"), "utf8")).toContain("sidebar-surface");
    expect(readFileSync(resolve(UI, "src/components/layout/bottom-nav.tsx"), "utf8")).toContain("sidebar-surface-floating");
  });

  it("an opacity and a blur: the variables, the backdrop only when blurring", () => {
    const out = css({ sidebarOpacity: 0.8, sidebarBlur: 12 });
    expect(out).toContain("--sidebar-opacity: 0.8;");
    expect(out).toContain("--sidebar-blur: 12px;");
    expect(out).toContain("--sidebar-backdrop: blur(12px);");
    expect(css({ sidebarBlur: 0 })).toContain("--sidebar-backdrop: none;");
    expect(kit.tokenValue("sidebarOpacity", 0.1)).toBe(0.5);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { sidebarOpacity: 0.3 } } })).toThrow(/opacity from 0.5 to 1/);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { sidebarBlur: 30 } } })).toThrow(/0 to 24/);
  });
});
