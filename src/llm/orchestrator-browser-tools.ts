/**
 * Browser tools exposed to the orchestrator (chat surface).
 *
 * These are thin wrappers around `agent-browser` CLI — same bridge used
 * by agent-side tools in src/tools/browser-tools.ts. The difference is
 * the session: agents get one session per agent-name, the orchestrator
 * always uses a fixed `"orchestrator"` session so the user sees a
 * single, persistent browser in the Agent Live tab.
 *
 * Profile dir: <polpoDir>/browser-profiles/orchestrator — cookies and
 * auth survive across chat sessions (same pattern as agent profiles).
 *
 * The 6 tools mirror the most-used agent-side ones: navigate, snapshot,
 * click, fill, get, screenshot. Snapshot returns the accessibility tree
 * with @ref ids the model uses to target click/fill.
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { execBrowserAsync } from "../tools/browser-tools.js";
import { getCdpTarget } from "../core/browser-cdp-state.js";
import type { Orchestrator } from "../core/orchestrator.js";

/** Fixed session: gives the live-view a single, stable target. */
const ORCH_SESSION = "orchestrator";

function profileDirFor(polpo: Orchestrator): string {
  const dir = join(polpo.getPolpoDir(), "browser-profiles", ORCH_SESSION);
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

function summarize(result: { success: boolean; data?: any; error?: string; raw: string }): string {
  if (!result.success) return `Browser error: ${result.error ?? result.raw}`;
  if (typeof result.data === "string") return result.data;
  return JSON.stringify(result.data, null, 2);
}

// ── Tool definitions (typebox / Tool format used by ALL_ORCHESTRATOR_TOOLS) ──

export const browserNavigateTool: Tool = {
  name: "browser_navigate",
  description: "Open a URL in the orchestrator's browser. Launches the browser if it isn't running. The user can watch it live in the Agent Live tab.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to navigate to (e.g. 'https://example.com')" }),
  }),
};

export const browserSnapshotTool: Tool = {
  name: "browser_snapshot",
  description: "Get the accessibility tree of the current page with element refs (e.g. @e1, @e2). Use refs returned here to target browser_click / browser_fill. Best first call after browser_navigate to understand page structure.",
  parameters: Type.Object({
    interactive_only: Type.Optional(Type.Boolean({ description: "Only show interactive elements (buttons, inputs, links)" })),
    compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements" })),
    max_depth: Type.Optional(Type.Number({ description: "Limit tree depth" })),
    selector: Type.Optional(Type.String({ description: "Scope snapshot to a CSS selector" })),
  }),
};

export const browserClickTool: Tool = {
  name: "browser_click",
  description: "Click an element. Use a @ref from browser_snapshot (e.g. '@e2') for reliable targeting; CSS selectors are accepted too.",
  parameters: Type.Object({
    selector: Type.String({ description: "Element ref from snapshot (e.g. '@e2') or CSS selector" }),
  }),
};

export const browserFillTool: Tool = {
  name: "browser_fill",
  description: "Clear an input field and type new text. Use refs from browser_snapshot for targeting.",
  parameters: Type.Object({
    selector: Type.String({ description: "Element ref or CSS selector" }),
    text: Type.String({ description: "Text to fill into the input" }),
  }),
};

export const browserGetTool: Tool = {
  name: "browser_get",
  description: "Read info from the current page: title, url, text/html/value of an element, attribute, etc. Use after browser_navigate to extract data without a screenshot.",
  parameters: Type.Object({
    what: Type.Union([
      Type.Literal("title"), Type.Literal("url"),
      Type.Literal("text"), Type.Literal("html"), Type.Literal("value"),
      Type.Literal("count"), Type.Literal("box"),
    ], { description: "What to fetch" }),
    selector: Type.Optional(Type.String({ description: "Element ref or CSS selector (required for text/html/value/count/box)" })),
  }),
};

export const browserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description: "Take a screenshot of the current page. Saved under the project workdir; the returned path can be opened with open_file. The Agent Live tab already shows the live viewport — use this only when you need a persisted image.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Output path (default: auto-generated under .polpo/output/)" })),
    full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default: viewport only)" })),
  }),
};

export const ALL_ORCHESTRATOR_BROWSER_TOOLS: Tool[] = [
  browserNavigateTool, browserSnapshotTool, browserClickTool,
  browserFillTool, browserGetTool, browserScreenshotTool,
];

export const ORCHESTRATOR_BROWSER_TOOL_NAMES = new Set(
  ALL_ORCHESTRATOR_BROWSER_TOOLS.map(t => t.name),
);

// ── Executor ─────────────────────────────────────────────────────────────

export async function executeOrchestratorBrowserTool(
  name: string,
  args: Record<string, unknown>,
  polpo: Orchestrator,
): Promise<string> {
  const session = ORCH_SESSION;
  // When the user launched their real Chrome (Agent Live tab → "Launch my
  // Chrome"), it's CDP-attached on this port and we drive THAT browser.
  // Otherwise fall back to agent-browser's managed profile for the session.
  const cdpPort = getCdpTarget();
  const base = cdpPort
    ? { session, cdp: cdpPort }
    : { session, profileDir: profileDirFor(polpo) };

  switch (name) {
    case "browser_navigate": {
      const url = String(args.url ?? "");
      if (!url) return "Error: 'url' is required.";
      const r = await execBrowserAsync(["open", url], base);
      return summarize(r);
    }
    case "browser_snapshot": {
      const cli = ["snapshot"];
      if (args.interactive_only) cli.push("-i");
      if (args.compact) cli.push("-c");
      if (typeof args.max_depth === "number") cli.push("-d", String(args.max_depth));
      if (args.selector) cli.push("-s", String(args.selector));
      const r = await execBrowserAsync(cli, { ...base, timeout: 15_000 });
      return summarize(r);
    }
    case "browser_click": {
      const sel = String(args.selector ?? "");
      if (!sel) return "Error: 'selector' is required.";
      const r = await execBrowserAsync(["click", sel], base);
      return summarize(r);
    }
    case "browser_fill": {
      const sel = String(args.selector ?? "");
      const text = String(args.text ?? "");
      if (!sel) return "Error: 'selector' is required.";
      const r = await execBrowserAsync(["fill", sel, text], base);
      return summarize(r);
    }
    case "browser_get": {
      const what = String(args.what ?? "");
      if (!what) return "Error: 'what' is required.";
      const cli = ["get", what];
      if (args.selector) cli.push(String(args.selector));
      const r = await execBrowserAsync(cli, base);
      return summarize(r);
    }
    case "browser_screenshot": {
      const cli = ["screenshot"];
      if (args.path) cli.push(String(args.path));
      if (args.full_page) cli.push("--full-page");
      const r = await execBrowserAsync(cli, { ...base, timeout: 20_000 });
      return summarize(r);
    }
    default:
      return `Error: Unknown orchestrator browser tool "${name}".`;
  }
}
