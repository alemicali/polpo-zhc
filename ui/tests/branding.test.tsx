/**
 * The branding on the first frame: the inline <head> script puts the product name in the title and
 * preloads the theme's logo before React mounts; BrandMark and the product name render the instance
 * branding on their very first render (runtime-config.js, else the cached copy), never the defaults
 * in between; the logo framed in a box or bare; the bundled Inter Tight font.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const UI = resolve(process.cwd(), process.cwd().endsWith("/ui") ? "." : "ui");
import { renderToStaticMarkup } from "react-dom/server";
import { appearanceKit, bootScriptSource } from "@/lib/appearance-kit";

type RC = Record<string, unknown> | undefined;
const kit = appearanceKit();
const setRc = (rc: RC) => { (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = rc; };
const runHead = (rc: RC) => { setRc(rc); new Function(bootScriptSource("", "/"))(); };
const ACME = { productName: "Acme Ops", tagline: "Internal AI", logoUrl: "https://cdn.example.com/light.png", logoDarkUrl: "https://cdn.example.com/dark.png" };

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#0a0e1a"><meta name="apple-mobile-web-app-title" content="Polpo ZHC"><title>Polpo ZHC — AI Factory</title>';
  document.documentElement.className = "dark";
  localStorage.clear();
});
afterEach(() => {
  setRc(undefined);
  vi.resetModules();
});

describe("the inline <head> script: the title and the logo before React mounts", () => {
  it("puts the product name in the title and preloads the dark logo in dark mode", () => {
    runHead({ branding: ACME });
    expect(document.title).toBe("Acme Ops");
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content")).toBe("Acme Ops");
    const link = document.getElementById("polpo-brand-logo-preload")!;
    expect(link.getAttribute("rel")).toBe("preload");
    expect(link.getAttribute("as")).toBe("image");
    expect(link.getAttribute("href")).toBe(ACME.logoDarkUrl);
  });

  it("preloads the light logo in light mode, and a managed logo from the API", () => {
    runHead({ baseUrl: "https://api.example.com", appearance: { theme: "light" }, branding: { logoUrl: "/api/v1/config/branding/logo", logoDarkUrl: "/api/v1/config/branding/logo-dark" } });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.getElementById("polpo-brand-logo-preload")?.getAttribute("href")).toBe("https://api.example.com/api/v1/config/branding/logo");
    expect(document.title).toBe("Polpo ZHC — AI Factory"); // no name: the default
  });

  it("uses the cached branding without runtime-config.js (Electron, nginx)", () => {
    const api = kit.apiScope("", window.location.origin);
    localStorage.setItem(`${kit.BRANDING_KEY}:${api}`, JSON.stringify({ productName: "Cached Co", logoUrl: "https://cdn.example.com/c.png" }));
    runHead(undefined);
    expect(document.title).toBe("Cached Co");
    expect(document.getElementById("polpo-brand-logo-preload")?.getAttribute("href")).toBe("https://cdn.example.com/c.png");
  });

  it("leaves the defaults when nothing is configured, and refuses odd logo URLs", () => {
    runHead({});
    expect(document.title).toBe("Polpo ZHC — AI Factory");
    expect(document.getElementById("polpo-brand-logo-preload")).toBeNull();
    runHead({ branding: { logoUrl: "javascript:alert(1)" } });
    expect(document.getElementById("polpo-brand-logo-preload")).toBeNull();
  });

  it("titles a page after the product name", () => {
    expect(kit.brandingTitle({ productName: "Acme Ops" }, "Missions")).toBe("Acme Ops · Missions");
    expect(kit.brandingTitle({ productName: "Acme Ops" })).toBe("Acme Ops");
    expect(kit.brandingTitle(null, "Missions")).toBe("Polpo ZHC · Missions");
    expect(kit.brandingTitle({})).toBe("Polpo ZHC — AI Factory");
  });
});

describe("the first render: the instance branding, never the defaults first", () => {
  it("BrandMark and the product name come from runtime-config.js on the very first render", async () => {
    setRc({ branding: ACME });
    const { BrandMark } = await import("@/components/shared/brand-mark");
    const { productName, useInstanceBranding } = await import("@/lib/branding");
    function Chrome() {
      const branding = useInstanceBranding();
      return <div><BrandMark /><h1>{productName(branding)}</h1></div>;
    }
    const html = renderToStaticMarkup(<Chrome />);
    expect(html).toContain(`src="${ACME.logoDarkUrl}"`);
    expect(html).toContain("<h1>Acme Ops</h1>");
    expect(html).not.toContain("Polpo ZHC");
    expect(html).not.toContain("🐙");
  });

  it("falls back to this browser's cached copy, else the defaults", async () => {
    const api = kit.apiScope("", window.location.origin);
    localStorage.setItem(`${kit.BRANDING_KEY}:${api}`, JSON.stringify({ productName: "Cached Co" }));
    let mod = await import("@/lib/branding");
    expect(mod.productName(mod.getInstanceBranding())).toBe("Cached Co");
    localStorage.clear();
    vi.resetModules();
    mod = await import("@/lib/branding");
    expect(mod.getInstanceBranding()).toBeNull();
    expect(mod.productName(mod.getInstanceBranding())).toBe("Polpo ZHC");
  });

  it("a new branding (API, an admin's save) updates the title, the cache and the components", async () => {
    setRc({ branding: {} });
    const mod = await import("@/lib/branding");
    mod.setInstanceBranding({ productName: "New Name", logoFrame: "none" });
    expect(document.title).toBe("New Name");
    const api = kit.apiScope("", window.location.origin);
    expect(JSON.parse(localStorage.getItem(`${kit.BRANDING_KEY}:${api}`)!)).toEqual({ productName: "New Name", logoFrame: "none" });
    expect(mod.documentTitle("Agents")).toBe("New Name · Agents");
  });
});

describe("the logo frame", () => {
  it("box (the default): the tile, square", async () => {
    const { BrandMark } = await import("@/components/shared/brand-mark");
    const html = renderToStaticMarkup(<BrandMark branding={{ logoUrl: "https://cdn.example.com/l.png" }} className="h-7 w-7 rounded-md" />);
    expect(html).toContain('data-logo-frame="box"');
    expect(html).toContain("bg-primary/10");
    expect(html).toContain("w-7");
    expect(html).toContain("h-full w-full object-contain");
  });

  it("none: bare at the same height, its own width, no background", async () => {
    const { BrandMark } = await import("@/components/shared/brand-mark");
    const html = renderToStaticMarkup(<BrandMark branding={{ logoUrl: "https://cdn.example.com/l.png", logoFrame: "none" }} className="h-7 w-7 rounded-md" />);
    expect(html).toContain('data-logo-frame="none"');
    expect(html).not.toContain("bg-primary/10");
    expect(html).toContain("h-7");
    expect(html).toContain("w-auto");
    expect(html).not.toMatch(/class="[^"]*\bw-7\b/);
    expect(html).toContain("bg-transparent");
    expect(html).toContain("h-full w-auto max-w-full object-contain");
  });
});

describe("Inter Tight, bundled", () => {
  const css = readFileSync(resolve(UI, "src/index.css"), "utf8");

  it("is a named font option in the appearance editor", async () => {
    const { FONT_PRESETS } = await import("@/lib/font-presets");
    expect(FONT_PRESETS).toContainEqual({ label: "Inter Tight", value: "\"Inter Tight\", ui-sans-serif, system-ui, sans-serif" });
  });

  it("is declared with @font-face (variable 100–900, swap, latin + latin-ext) on self-hosted files", () => {
    const faces = css.match(/@font-face\s*{[^}]*}/g)!.filter((f) => f.includes("\"Inter Tight\""));
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face).toContain("font-display: swap");
      expect(face).toContain("font-weight: 100 900");
    }
    for (const file of ["inter-tight-latin-wght-normal.woff2", "inter-tight-latin-ext-wght-normal.woff2"]) {
      expect(css).toContain(`/fonts/inter-tight/${file}`);
      expect(existsSync(resolve(UI, "public/fonts/inter-tight", file))).toBe(true);
    }
  });

  it("is preloaded only when a look uses it", () => {
    runHead({ appearance: { custom: { enabled: true, light: { headingFont: "\"Inter Tight\", sans-serif" }, dark: {} } } });
    const link = document.getElementById("polpo-font-preload-inter-tight")!;
    expect(link.getAttribute("as")).toBe("font");
    expect(link.getAttribute("crossorigin")).toBe("anonymous");
    expect(link.getAttribute("href")).toBe("/fonts/inter-tight/inter-tight-latin-wght-normal.woff2");
    runHead({ appearance: { custom: { enabled: true, light: { fontFamily: "\"Satoshi\", sans-serif" }, dark: {} } } });
    expect(document.getElementById("polpo-font-preload-inter-tight")).toBeNull();
  });
});
