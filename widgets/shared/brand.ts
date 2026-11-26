/**
 * The official marks of what a run executes with or on, for the MCP widgets: the same marks as
 * the dashboard's <BrandIcon> (ui/src/components/shared/brand-icon.tsx), bundled into the widget
 * document (inline SVG; Daytona's and E2B's own PNGs as data URIs), so the widgets load nothing.
 *
 * Monochrome marks (Anthropic, OpenAI, OpenCode, Tailscale) take the text colour (visible in dark mode);
 * Daytona has a light and a dark variant (the host's data-theme picks one, see style.css).
 */
import type { BrandMark } from "../../src/server/mcp-run-view.js";
import { BRAND_VECTORS } from "../../ui/src/generated/brand-icons.js";
import { BEDROCK_GRADIENT, BEDROCK_PATH, OPENAI_PATH, VERTEX_PATHS } from "./lobe-marks.generated.js";
import daytonaLight from "../../ui/public/brand-icons/daytona-light.png";
import daytonaDark from "../../ui/public/brand-icons/daytona-dark.png";
import e2b from "../../ui/public/brand-icons/e2b.png";

export const BRAND_TITLES: Record<BrandMark, string> = {
  polpo: "Polpo", "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", anthropic: "Anthropic", openai: "OpenAI",
  bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", "api-key": "API key",
  daytona: "Daytona", e2b: "E2B", host: "This server", ephemeral: "Ephemeral sandbox", tailscale: "Tailscale",
};

const SVG = "http://www.w3.org/2000/svg";
let gradientSeq = 0;

function svg(size: number, label: string, mark: string, mono = false): SVGSVGElement {
  const el = document.createElementNS(SVG, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  el.setAttribute("data-brand", mark);
  el.setAttribute("class", `mark${mono ? " mark-mono" : ""}`);
  const title = document.createElementNS(SVG, "title");
  title.textContent = label;
  el.append(title);
  return el;
}

function path(d: string, fill?: string): SVGPathElement {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  if (fill) p.setAttribute("fill", fill);
  return p;
}

function img(src: string, size: number, label: string, mark: string, cls = ""): HTMLImageElement {
  const el = document.createElement("img");
  el.src = src;
  el.alt = label;
  el.title = label;
  el.width = size;
  el.height = size;
  el.className = `mark mark-img ${cls}`.trim();
  el.setAttribute("data-brand", mark);
  return el;
}

/** A glyph in a tile, for marks that are not brands (this server, an API key, an ephemeral sandbox). */
function glyph(text: string, size: number, label: string, mark: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "mark mark-glyph";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  el.setAttribute("data-brand", mark);
  el.title = label;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.72)}px`;
  el.textContent = text;
  return el;
}

/** The mark of an engine, auth provider or computer, `size` px square. */
export function brandMark(name: BrandMark | string, size = 16, title?: string): Element {
  const label = title ?? BRAND_TITLES[name as BrandMark] ?? name;
  switch (name) {
    case "claude-code": case "anthropic": case "tailscale": case "opencode": {
      const v = BRAND_VECTORS[name];
      const mono = name !== "claude-code";
      const el = svg(size, label, name, mono);
      el.append(path(v.path, mono ? undefined : v.hex));
      return el;
    }
    case "codex": case "openai": {
      const el = svg(size, label, name, true);
      el.append(path(OPENAI_PATH));
      return el;
    }
    case "bedrock": {
      const el = svg(size, label, name);
      const id = `polpo-bedrock-${++gradientSeq}`;
      const defs = document.createElementNS(SVG, "defs");
      const g = document.createElementNS(SVG, "linearGradient");
      g.setAttribute("id", id);
      for (const [k, v] of [["x1", "80%"], ["x2", "20%"], ["y1", "20%"], ["y2", "80%"]]) g.setAttribute(k, v);
      for (const [offset, color] of BEDROCK_GRADIENT) {
        const stop = document.createElementNS(SVG, "stop");
        stop.setAttribute("offset", offset);
        stop.setAttribute("stop-color", color);
        g.append(stop);
      }
      defs.append(g);
      el.append(defs, path(BEDROCK_PATH, `url(#${id})`));
      return el;
    }
    case "vertex": {
      const el = svg(size, label, name);
      for (const [d, fill] of VERTEX_PATHS) el.append(path(d, fill));
      return el;
    }
    case "daytona": {
      const wrap = document.createElement("span");
      wrap.className = "mark mark-pair";
      wrap.setAttribute("data-brand", name);
      wrap.append(img(daytonaLight, size, label, name, "mark-light"), img(daytonaDark, size, label, name, "mark-dark"));
      return wrap;
    }
    case "e2b": return img(e2b, size, label, name);
    case "polpo": return glyph("🐙", size, label, name);
    case "host": return glyph("▣", size, label, name);
    case "ephemeral": return glyph("◇", size, label, name);
    case "api-key": return glyph("⚿", size, label, name);
    default: return glyph(label.slice(0, 1).toUpperCase(), size, label, String(name));
  }
}

/**
 * A model followed by the engine that runs it, the dashboard's rule (ModelWithEngine):
 * "Sonnet 4.5 · [mark] Claude Code Harness", "gpt-6 · [mark] Polpo"; compact: the mark only (the
 * label in the tooltip). The tooltip names the model, the engine and how it authenticates.
 */
export function modelWithEngine(
  model: string | undefined,
  engine: { mark: BrandMark | string; label: string; kind?: string; id?: string },
  opts: { size?: number; compact?: boolean; auth?: string } = {},
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "marks model-engine";
  wrap.title = [model ? `Model: ${model}` : "", `Engine: ${engine.label}`, opts.auth ? `Auth: ${opts.auth}` : ""].filter(Boolean).join("\n");
  if (model) {
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model;
    const sep = document.createElement("span");
    sep.className = "muted";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "·";
    wrap.append(name, sep);
  }
  const mark = document.createElement("span");
  mark.className = "marks engine-mark";
  mark.setAttribute("data-engine", engine.id ?? String(engine.mark));
  if (engine.kind) mark.setAttribute("data-engine-kind", engine.kind);
  mark.append(brandMark(engine.mark, opts.size ?? 14, engine.label));
  if (opts.compact) mark.setAttribute("aria-label", engine.label);
  else {
    const label = document.createElement("span");
    label.className = "engine-label";
    label.textContent = engine.label;
    mark.append(label);
  }
  wrap.append(mark);
  return wrap;
}
