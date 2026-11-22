// @vitest-environment node
/**
 * Theme guard: the dashboard's screens must take their look from the design tokens (index.css,
 * Configuration → Appearance), not from fixed colours or sizes. This scans ui/src for
 *
 * - palette: Tailwind palette colours (bg-emerald-500, text-zinc-400, border-amber-300/40,
 *   from-sky-400, bg-white, text-black…) — use the tokens: bg-success, text-warning, border-info/30,
 *   text-muted-foreground, bg-card, text-primary-foreground…;
 * - literal: colour literals in code (#rrggbb, rgb(…), rgba(…), hsl(…), oklch(…)) — use the token
 *   (var(--primary), color-mix(in oklch, var(--info) 20%, transparent)…);
 * - textSize: arbitrary font sizes (text-[10px], text-[0.8rem]) — use the type scale: text-display,
 *   text-h1, text-h2, text-h3, text-body, text-small, text-caption, text-micro (or text-label);
 *
 * and compares each file with ui/tests/theme-guard.baseline.json: a file may only go DOWN. New
 * files start at zero.
 *
 * After a sweep that removed violations, lower the baseline (the test prints the files to update):
 *
 *   UPDATE_THEME_BASELINE=1 npx vitest run --config ui/vitest.config.ts ui/tests/theme-guard.test.ts
 *
 * then commit the new baseline. Never raise it to make new code pass: use a token instead, or, for
 * a real exception (a vendor's brand colour, a QR code), add the file to ALLOWLIST below with why.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BASELINE_FILE = fileURLToPath(new URL("./theme-guard.baseline.json", import.meta.url));

/** Files (relative to ui/src, / separated) or folders (ending in /) whose colours are legitimate. */
const ALLOWLIST: Array<[string, string]> = [
  ["lib/palette.ts", "the palettes' swatches"],
  ["lib/appearance-kit.ts", "the built-in theme colours and contrast colours"],
  ["lib/artifact-frame-doc.ts", "the sandboxed artifact document's own stylesheet"],
  ["generated/", "generated icon data"],
  ["components/connectors/connector-icon.tsx", "vendor brand colours"],
  ["components/shared/channel-logo.tsx", "vendor brand colours"],
  ["components/shared/provider-icon.tsx", "vendor brand colours"],
  ["components/shared/brand-mark.tsx", "the logo preview tile"],
  ["components/config/appearance-editor.tsx", "the appearance preview's inline variables and swatches"],
  ["components/layout/pwa-install-qr-button.tsx", "a QR code must stay black on white"],
  ["components/ui/chart.tsx", "shadcn chart: inline styles from the chart config"],
  ["components/ui/progress.tsx", "shadcn progress: inline transform"],
];

const PALETTE = /\b(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|divide|from|via|to|fill|stroke|decoration|placeholder|caret|accent|shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d{1,3})?\b/g;
const LITERAL = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g;
const TEXT_SIZE = /\btext-\[\d*\.?\d+(?:px|rem|em)\]/g;

type Counts = { palette: number; literal: number; textSize: number };
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
  };
}

function scan(): Baseline {
  const out: Baseline = {};
  for (const file of files(SRC).sort()) {
    const rel = relative(SRC, file).split(sep).join("/");
    if (allowed(rel)) continue;
    const c = count(readFileSync(file, "utf8"));
    if (c.palette || c.literal || c.textSize) out[rel] = c;
  }
  return out;
}

function totals(b: Baseline): Counts {
  const t = { palette: 0, literal: 0, textSize: 0 };
  for (const c of Object.values(b)) { t.palette += c.palette; t.literal += c.literal; t.textSize += c.textSize; }
  return t;
}

describe("theme guard", () => {
  it("knows the patterns", () => {
    expect(count('className="bg-emerald-500 text-zinc-400 border-amber-300/40 bg-white"').palette).toBe(4);
    expect(count('className="bg-success text-warning border-info/30 text-muted-foreground"').palette).toBe(0);
    expect(count('style={{ color: "#ff0000", background: "rgba(0,0,0,.2)" }} oklch(0.5 0.1 200)').literal).toBe(3);
    expect(count('className="text-[10px] text-[0.8rem] text-h1 text-[var(--x)]"').textSize).toBe(2);
    expect(count("// bg-red-500 in a comment\n/* text-[9px] */ const url = \"https://x.dev/#abc\";").palette).toBe(0);
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
      const b = baseline[file] ?? { palette: 0, literal: 0, textSize: 0 };
      for (const k of ["palette", "literal", "textSize"] as const) {
        if (c[k] > b[k]) worse.push(`${file}: ${k} ${b[k]} → ${c[k]}`);
      }
    }
    for (const [file, b] of Object.entries(baseline)) {
      const c = now[file] ?? { palette: 0, literal: 0, textSize: 0 };
      if (c.palette < b.palette || c.literal < b.literal || c.textSize < b.textSize) better.push(file);
    }
    if (better.length) {
      console.info(`theme guard: ${better.length} file(s) improved — lower the baseline (UPDATE_THEME_BASELINE=1): ${better.join(", ")}`);
    }
    expect(worse, "Use the design tokens (see the comment at the top of ui/tests/theme-guard.test.ts)").toEqual([]);
  });
});
