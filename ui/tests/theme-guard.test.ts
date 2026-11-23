// @vitest-environment node
/**
 * Theme guard: the dashboard's screens take their whole look from the design tokens (index.css,
 * Configuration → Appearance): nothing fixed. This scans ui/src for
 *
 * - palette: Tailwind palette colours (bg-emerald-500, text-zinc-400, border-amber-300/40,
 *   from-sky-400, bg-white, text-black…) — use the tokens: bg-success, text-warning, border-info/30,
 *   text-muted-foreground, bg-card, bg-canvas, bg-overlay, bg-agent-3, text-agent-3-foreground…;
 * - literal: colour literals in code (#rrggbb, rgb(…), rgba(…), hsl(…), oklch(…), also inside
 *   arbitrary classes like bg-[#…]) and named colours in styles and SVG (fill="white",
 *   style={{ color: "black" }}) — use the token (var(--primary), fill="var(--chart-1)",
 *   color-mix(in oklch, var(--info) 20%, transparent)…);
 * - textSize: arbitrary font sizes (text-[10px], text-[0.8rem]) and fixed sizes in styles
 *   (fontSize: 12, fontSize="10") — use the type scale: text-display, text-h1, text-h2, text-h3,
 *   text-body, text-small, text-caption, text-micro (or text-label), text-xs … text-3xl (tokens too),
 *   or var(--text-micro) in a style;
 * - shape: fixed corners, shadows and blurs — rounded-full and rounded-[…] (use rounded-pill,
 *   rounded-badge, rounded-avatar, rounded-dialog, rounded-card, rounded-control, rounded-xs …
 *   rounded-4xl, which follow the look's radius; not the bare rounded, a fixed 0.25rem), Tailwind's shadow, shadow-xs … shadow-2xl,
 *   shadow-[…], drop-shadow* (use shadow-control, shadow-card, shadow-raised, shadow-glow,
 *   shadow-glow-strong with glow-success…), backdrop-blur, backdrop-blur-sm … and blur-sm …
 *   (use backdrop-blur-surface, backdrop-blur-overlay, blur-glow), and borderRadius / boxShadow
 *   literals in styles;
 * - font: arbitrary font families, weights, letter-spacing and line heights (font-[…],
 *   tracking-[…], leading-[…], font-thin / font-light / font-extrabold / font-black, and
 *   fontFamily / fontWeight / letterSpacing / lineHeight literals in styles) — use font-sans,
 *   font-mono, font-heading, font-normal / font-medium / font-semibold / font-bold (tokens),
 *   tracking-heading, tracking-label, Tailwind's named tracking-* and leading-*;
 *
 * and compares each file with ui/tests/theme-guard.baseline.json: a file may only go DOWN. New
 * files start at zero. The baseline is zero everywhere: keep it there.
 *
 * Never raise the baseline to make new code pass: use a token, or add one (docs/appearance.md).
 * Only files that define the tokens or draw vendors' own marks are in ALLOWLIST below.
 *
 *   UPDATE_THEME_BASELINE=1 npx vitest run --config ui/vitest.config.ts ui/tests/theme-guard.test.ts
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BASELINE_FILE = fileURLToPath(new URL("./theme-guard.baseline.json", import.meta.url));

/** Files (relative to ui/src, / separated) or folders (ending in /) whose colours are legitimate. */
const ALLOWLIST: Array<[string, string]> = [
  // token definitions
  ["lib/palette.ts", "token definitions: the palettes' swatches"],
  ["lib/appearance-kit.ts", "token definitions: the built-in theme colours, contrast colours, token kinds"],
  ["lib/artifact-frame-doc.ts", "token definitions: the sandboxed artifact document's own stylesheet (its tokens)"],
  ["components/config/appearance-editor.tsx", "token definitions: the token editor (colour inputs take #rrggbb) and its preview"],
  // vendors' own marks
  ["generated/", "generated brand icon data"],
  ["components/connectors/connector-icon.tsx", "vendor brand marks"],
  ["components/shared/channel-logo.tsx", "vendor brand marks"],
  ["components/shared/provider-icon.tsx", "vendor brand marks"],
];

const NAMED = "white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|lime|aqua|fuchsia|olive";
const PALETTE = /\b(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|divide|from|via|to|fill|stroke|decoration|placeholder|caret|accent|shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d{1,3})?\b/g;
const LITERAL = new RegExp([
  /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/.source,
  // named colours in styles and SVG attributes
  `\\b(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke|stopColor|caretColor)\\s*:\\s*["'\`](?:${NAMED})["'\`]`,
  `\\b(?:fill|stroke|stopColor|stop-color|color)=\\{?["'\`](?:${NAMED})["'\`]`,
].join("|"), "g");
const TEXT_SIZE = new RegExp([
  /\btext-\[(?:length:)?\d*\.?\d+(?:px|rem|em|pt|%)?\]/.source,
  /\bfontSize\s*:\s*(?:\d|["'`]\s*\d)/.source,
  /\bfontSize=\{?\s*["'`]?\d/.source,
].join("|"), "g");
const SHAPE = new RegExp([
  /(?<![-\w])rounded(?:-[a-z]{1,2})?-full(?![-\w])/.source,
  // bare rounded / rounded-t…: Tailwind's fixed 0.25rem (rounded-xs follows the look)
  /(?<=["'`\s:])rounded(?:-[trblse]{1,2})?(?=["'`\s])/.source,
  /(?<![-\w])rounded(?:-[a-z]{1,2})?-\[(?!inherit\]|var\()/.source,
  /(?<![-\w])shadow-(?:2xs|xs|sm|md|lg|xl|2xl|inner)(?![-\w])/.source,
  /(?<=["'`\s:])shadow(?=["'`\s])/.source,
  /(?<![-\w])shadow-\[(?!var\()/.source,
  /(?<![-\w])(?:drop-shadow|inset-shadow|text-shadow)(?:-[\w[\]/.]+)?(?=["'`\s])/.source,
  /(?<![-\w])backdrop-blur(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|\[[^\]]*\]))?(?=["'`\s])/.source,
  /(?<![-\w])blur-(?:xs|sm|md|lg|xl|2xl|3xl|\[[^\]]*\])(?=["'`\s])/.source,
  /\b(?:borderRadius|boxShadow)\s*:\s*(?:\d|["'`](?!\s*var\())/.source,
].join("|"), "g");
const FONT = new RegExp([
  /(?<![-\w])(?:font|tracking|leading)-\[(?!var\()/.source,
  /(?<![-\w])font-(?:thin|extralight|light|extrabold|black)(?![-\w])/.source,
  /\b(?:fontFamily|fontWeight|letterSpacing|lineHeight)\s*:\s*(?:\d|["'`](?!\s*var\())/.source,
  /\b(?:fontFamily|fontWeight)=\{?\s*["'`\d]/.source,
].join("|"), "g");

const KINDS = ["palette", "literal", "textSize", "shape", "font"] as const;
type Kind = (typeof KINDS)[number];
type Counts = Record<Kind, number>;
const ZERO: Counts = { palette: 0, literal: 0, textSize: 0, shape: 0, font: 0 };
type Baseline = Record<string, Counts>;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function allowed(rel: string): boolean {
  return ALLOWLIST.some(([path]) => (path.endsWith("/") ? rel.startsWith(path) : rel === path));
}

/** The source without comments (block and line; a // after a quote or colon is a URL, kept). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function count(text: string): Counts {
  const c = code(text);
  return {
    palette: (c.match(PALETTE) ?? []).length,
    literal: (c.match(LITERAL) ?? []).length,
    textSize: (c.match(TEXT_SIZE) ?? []).length,
    shape: (c.match(SHAPE) ?? []).length,
    font: (c.match(FONT) ?? []).length,
  };
}

function scan(): Baseline {
  const out: Baseline = {};
  for (const file of files(SRC).sort()) {
    const rel = relative(SRC, file).split(sep).join("/");
    if (allowed(rel)) continue;
    const c = count(readFileSync(file, "utf8"));
    if (KINDS.some((k) => c[k])) out[rel] = c;
  }
  return out;
}

function totals(b: Baseline): Counts {
  const t = { ...ZERO };
  for (const c of Object.values(b)) for (const k of KINDS) t[k] += c[k] ?? 0;
  return t;
}

describe("theme guard", () => {
  it("knows the patterns", () => {
    expect(count('className="bg-emerald-500 text-zinc-400 border-amber-300/40 bg-white"').palette).toBe(4);
    expect(count('className="bg-success text-warning border-info/30 text-muted-foreground bg-agent-3 bg-canvas"').palette).toBe(0);
    expect(count('style={{ color: "#ff0000", background: "rgba(0,0,0,.2)" }} oklch(0.5 0.1 200)').literal).toBe(3);
    expect(count('className="bg-[#123456]" fill="white" style={{ color: "black" }} stroke="var(--border)" fill="none"').literal).toBe(3);
    expect(count('className="text-[10px] text-[0.8rem] text-h1 text-[var(--x)]" style={{ fontSize: 12 }} fontSize="10"').textSize).toBe(4);
    expect(count('style={{ fontSize: "var(--text-micro)" }} tick={{ className: "text-micro" }}').textSize).toBe(0);
    expect(count('className="rounded-full rounded-t-full rounded-[3px] shadow-lg shadow shadow-[0_0_4px_red] backdrop-blur-sm blur-3xl drop-shadow rounded rounded-l"').shape).toBe(11);
    expect(count('className="rounded-pill rounded-avatar rounded-[inherit] rounded-[var(--r)] shadow-card shadow-glow glow-success backdrop-blur-surface blur-glow" style={{ borderRadius: "var(--radius)" }}').shape).toBe(0);
    expect(count('style={{ borderRadius: 4, boxShadow: "0 0 2px" }}').shape).toBe(2);
    expect(count('className="font-[550] tracking-[0.2em] leading-[1.7] font-black font-semibold tracking-label" style={{ fontFamily: "Arial", fontWeight: 600 }}').font).toBe(6);
    expect(count("// bg-red-500 rounded-full in a comment\n/* text-[9px] */ const url = \"https://x.dev/#abc\";").palette).toBe(0);
  });

  it("no file adds fixed colours or sizes (the baseline only goes down)", () => {
    const now = scan();
    if (process.env.UPDATE_THEME_BASELINE) {
      writeFileSync(BASELINE_FILE, `${JSON.stringify({ totals: totals(now), files: now }, null, 2)}\n`);
      return;
    }
    const baseline = (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { files: Baseline }).files;
    const worse: string[] = [];
    const better: string[] = [];
    for (const [file, c] of Object.entries(now)) {
      const b = { ...ZERO, ...baseline[file] };
      for (const k of KINDS) {
        if (c[k] > b[k]) worse.push(`${file}: ${k} ${b[k]} → ${c[k]}`);
      }
    }
    for (const [file, b] of Object.entries(baseline)) {
      const c = now[file] ?? ZERO;
      if (KINDS.some((k) => c[k] < (b[k] ?? 0))) better.push(file);
    }
    if (better.length) {
      console.info(`theme guard: ${better.length} file(s) improved — lower the baseline (UPDATE_THEME_BASELINE=1): ${better.join(", ")}`);
    }
    expect(worse, "Use the design tokens (see the comment at the top of ui/tests/theme-guard.test.ts)").toEqual([]);
  });

  it("the baseline is zero: nothing fixed anywhere", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { totals: Counts; files: Baseline };
    expect(baseline.totals).toEqual(ZERO);
    expect(scan()).toEqual({});
  });
});
