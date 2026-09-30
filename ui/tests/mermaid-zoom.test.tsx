import { expect, test } from "vitest";
import { readFileSync } from "node:fs";

const stylesheet = readFileSync("ui/src/components/shared/mermaid-file-preview.css", "utf8");

test("Mermaid zoom overrides Streamdown's inline raster hint and transition", () => {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  try {
    const rule = Array.from(style.sheet!.cssRules).find(rule =>
      rule.type === CSSRule.STYLE_RULE && (rule as CSSStyleRule).selectorText === '[data-streamdown="mermaid"] [role="application"]',
    ) as CSSStyleRule;
    expect(rule).toBeDefined();
    expect(rule.style.getPropertyValue("will-change")).toBe("auto");
    expect(rule.style.getPropertyPriority("will-change")).toBe("important");
    expect(rule.style.getPropertyValue("transition")).toBe("none");
    expect(rule.style.getPropertyPriority("transition")).toBe("important");

    // Fullscreen is portaled outside .mermaid-file-canvas. It must still match.
    const portal = document.createElement("div");
    portal.dataset.streamdown = "mermaid";
    const surface = document.createElement("div");
    surface.setAttribute("role", "application");
    portal.append(surface);
    expect(surface.matches(rule.selectorText)).toBe(true);
    portal.removeAttribute("data-streamdown");
    expect(surface.matches(rule.selectorText)).toBe(false);
  } finally {
    style.remove();
  }
});
