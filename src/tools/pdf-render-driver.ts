/**
 * HTML → PDF driver for pdf_create in a remote sandbox (open Polpo's pdf-render.mjs model): it is
 * written into the VM and run there with node, so Chromium renders next to the agent's files.
 * It uses playwright-core from the VM's global node_modules and the Chromium agent-browser
 * installed (the runner image has both).
 *
 *   node <driver> <params.json> <output.pdf>
 *
 * params: { html?, htmlPath?, pdf: <page.pdf options without path>, waitUntil }
 * stdout on success: {"success":true,"bytes":N}; stderr on failure: {"success":false,"error":"..."}
 */
export const PDF_RENDER_DRIVER = String.raw`
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";

const [paramsPath, outPath] = process.argv.slice(2);
function fail(message) {
  process.stderr.write(JSON.stringify({ success: false, error: String(message) }));
  process.exit(1);
}

function findChromium() {
  if (process.env.POLPO_CHROMIUM_EXECUTABLE) return process.env.POLPO_CHROMIUM_EXECUTABLE;
  const roots = [join(process.env.HOME || "/root", ".agent-browser", "browsers")];
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && (e.name === "chrome" || e.name === "chrome-headless-shell")) found.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  found.sort((a, b) => (a.endsWith("/chrome") === b.endsWith("/chrome") ? b.localeCompare(a) : a.endsWith("/chrome") ? -1 : 1));
  for (const c of [...found, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    try { if (statSync(c).isFile()) return c; } catch {}
  }
  fail("Chromium not found in the sandbox (agent-browser install puts it in ~/.agent-browser/browsers)");
}

let chromium;
try {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  ({ chromium } = createRequire(join(globalRoot, "noop.js"))("playwright-core"));
} catch (err) {
  fail("playwright-core is not installed in the sandbox: " + (err && err.message ? err.message : err));
}

const params = JSON.parse(readFileSync(paramsPath, "utf8"));
const html = params.htmlPath ? readFileSync(params.htmlPath, "utf8") : params.html;
let browser;
try {
  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: params.waitUntil || "networkidle", timeout: 30000 });
  const pdf = await page.pdf(params.pdf || {});
  writeFileSync(outPath, pdf);
  process.stdout.write(JSON.stringify({ success: true, bytes: pdf.byteLength }));
} catch (err) {
  fail(err && err.message ? err.message : err);
} finally {
  if (browser) await browser.close().catch(() => {});
}
`;
