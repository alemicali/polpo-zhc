/**
 * Browser automation tools powered by agent-browser.
 *
 * Uses the agent-browser CLI (https://github.com/vercel-labs/agent-browser)
 * via child_process with --json output for structured results.
 *
 * The agent-browser CLI manages a daemon process that keeps the browser alive
 * between commands, making sequential tool calls fast (no cold-start per command).
 *
 * Requires `agent-browser` to be installed globally or in PATH.
 * Install: `npm install -g agent-browser && agent-browser install`
 *
 * Session isolation: Each agent gets its own browser session via --session flag,
 * preventing cross-agent interference when multiple agents use browser tools.
 */

import { execSync, spawn as spawnChild } from "node:child_process";
import { resolve, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT = 30_000;

// ─── Helpers ───

/** Execute an agent-browser CLI command and return parsed result */
function execBrowser(
  args: string[],
  options: { session?: string; timeout?: number; cwd?: string } = {},
): { success: boolean; data?: any; error?: string; raw: string } {
  const sessionArgs = options.session ? ["--session", options.session] : [];
  const cmd = ["agent-browser", ...sessionArgs, ...args, "--json"].join(" ");
  try {
    const raw = execSync(cmd, {
      encoding: "utf-8",
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    try {
      const parsed = JSON.parse(raw);
      return { success: parsed.success ?? true, data: parsed.data ?? parsed, raw };
    } catch {
      return { success: true, data: raw, raw };
    }
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    return { success: false, error: stderr || stdout || err.message, raw: stderr || stdout };
  }
}

/** Execute agent-browser command async with signal support */
function execBrowserAsync(
  args: string[],
  options: { session?: string; timeout?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<{ success: boolean; data?: any; error?: string; raw: string }> {
  return new Promise((resolve) => {
    const sessionArgs = options.session ? ["--session", options.session] : [];
    const fullArgs = [...sessionArgs, ...args, "--json"];

    const child = spawnChild("agent-browser", fullArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, options.timeout ?? DEFAULT_TIMEOUT);

    const onAbort = () => { killed = true; child.kill("SIGTERM"); };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));

    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      let raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw.length > MAX_OUTPUT_BYTES) {
        raw = raw.slice(-MAX_OUTPUT_BYTES) + "\n[truncated]";
      }
      try {
        const parsed = JSON.parse(raw);
        resolve({ success: parsed.success ?? (code === 0), data: parsed.data ?? parsed, raw });
      } catch {
        resolve({ success: code === 0, data: raw, raw });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ success: false, error: err.message, raw: err.message });
    });
  });
}

function browserResult(result: { success: boolean; data?: any; error?: string; raw: string }): AgentToolResult<any> {
  if (!result.success) {
    return {
      content: [{ type: "text", text: `Browser error: ${result.error ?? result.raw}` }],
      details: { error: result.error ?? result.raw },
    };
  }
  const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
  return {
    content: [{ type: "text", text: text.slice(0, MAX_OUTPUT_BYTES) }],
    details: result.data,
  };
}

// ─── Tool: browser_navigate ───

const BrowserNavigateSchema = Type.Object({
  url: Type.String({ description: "URL to navigate to (e.g. 'https://example.com')" }),
});

function createBrowserNavigateTool(session: string): AgentTool<typeof BrowserNavigateSchema> {
  return {
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open a URL in the browser. Launches the browser if not already running.",
    parameters: BrowserNavigateSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["open", params.url], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_snapshot ───

const BrowserSnapshotSchema = Type.Object({
  interactive_only: Type.Optional(Type.Boolean({ description: "Only show interactive elements (buttons, inputs, links)" })),
  compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements" })),
  max_depth: Type.Optional(Type.Number({ description: "Limit tree depth" })),
  selector: Type.Optional(Type.String({ description: "Scope snapshot to a CSS selector" })),
});

function createBrowserSnapshotTool(session: string): AgentTool<typeof BrowserSnapshotSchema> {
  return {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Get the accessibility tree of the current page with element refs (e.g. @e1, @e2). " +
      "Use refs to interact with elements. Best way to understand page structure for AI.",
    parameters: BrowserSnapshotSchema,
    async execute(_id, params, signal) {
      const args = ["snapshot"];
      if (params.interactive_only) args.push("-i");
      if (params.compact) args.push("-c");
      if (params.max_depth) args.push("-d", String(params.max_depth));
      if (params.selector) args.push("-s", params.selector);
      const result = await execBrowserAsync(args, { session, signal, timeout: 15_000 });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_click ───

const BrowserClickSchema = Type.Object({
  selector: Type.String({ description: "Element ref from snapshot (e.g. '@e2') or CSS selector" }),
});

function createBrowserClickTool(session: string): AgentTool<typeof BrowserClickSchema> {
  return {
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element. Use refs from snapshot (e.g. @e2) for reliable targeting.",
    parameters: BrowserClickSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["click", params.selector], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_fill ───

const BrowserFillSchema = Type.Object({
  selector: Type.String({ description: "Element ref from snapshot (e.g. '@e3') or CSS selector" }),
  text: Type.String({ description: "Text to fill into the input" }),
});

function createBrowserFillTool(session: string): AgentTool<typeof BrowserFillSchema> {
  return {
    name: "browser_fill",
    label: "Browser Fill",
    description: "Clear an input field and type new text. Use refs from snapshot for targeting.",
    parameters: BrowserFillSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["fill", params.selector, params.text], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_type ───

const BrowserTypeSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector" }),
  text: Type.String({ description: "Text to type (appends to existing content)" }),
});

function createBrowserTypeTool(session: string): AgentTool<typeof BrowserTypeSchema> {
  return {
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an element without clearing it first. Use for appending text.",
    parameters: BrowserTypeSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["type", params.selector, params.text], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_press ───

const BrowserPressSchema = Type.Object({
  key: Type.String({ description: "Key to press (e.g. 'Enter', 'Tab', 'Control+a', 'Escape')" }),
});

function createBrowserPressTool(session: string): AgentTool<typeof BrowserPressSchema> {
  return {
    name: "browser_press",
    label: "Browser Press Key",
    description: "Press a keyboard key. Supports modifiers like 'Control+a', 'Shift+Enter'.",
    parameters: BrowserPressSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["press", params.key], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_screenshot ───

const BrowserScreenshotSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "File path to save screenshot (default: auto-generated temp path)" })),
  full_page: Type.Optional(Type.Boolean({ description: "Capture full page, not just viewport" })),
});

function createBrowserScreenshotTool(session: string, cwd: string): AgentTool<typeof BrowserScreenshotSchema> {
  return {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current page. Returns the file path of the saved image.",
    parameters: BrowserScreenshotSchema,
    async execute(_id, params, signal) {
      const args = ["screenshot"];
      if (params.path) args.push(resolve(cwd, params.path));
      if (params.full_page) args.push("--full");
      const result = await execBrowserAsync(args, { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_get ───

const BrowserGetSchema = Type.Object({
  what: Type.Union([
    Type.Literal("text"),
    Type.Literal("html"),
    Type.Literal("value"),
    Type.Literal("title"),
    Type.Literal("url"),
  ], { description: "What to retrieve: text, html, value, title, or url" }),
  selector: Type.Optional(Type.String({ description: "Element ref or CSS selector (required for text/html/value)" })),
});

function createBrowserGetTool(session: string): AgentTool<typeof BrowserGetSchema> {
  return {
    name: "browser_get",
    label: "Browser Get Info",
    description: "Get information from the browser: element text/html/value, page title, or current URL.",
    parameters: BrowserGetSchema,
    async execute(_id, params, signal) {
      const args = ["get", params.what];
      if (params.selector) args.push(params.selector);
      const result = await execBrowserAsync(args, { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_select ───

const BrowserSelectSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector for the <select> element" }),
  value: Type.String({ description: "Option value to select" }),
});

function createBrowserSelectTool(session: string): AgentTool<typeof BrowserSelectSchema> {
  return {
    name: "browser_select",
    label: "Browser Select",
    description: "Select an option from a dropdown <select> element.",
    parameters: BrowserSelectSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["select", params.selector, params.value], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_hover ───

const BrowserHoverSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector to hover" }),
});

function createBrowserHoverTool(session: string): AgentTool<typeof BrowserHoverSchema> {
  return {
    name: "browser_hover",
    label: "Browser Hover",
    description: "Hover over an element to trigger hover states, tooltips, or dropdown menus.",
    parameters: BrowserHoverSchema,
    async execute(_id, params, signal) {
      const result = await execBrowserAsync(["hover", params.selector], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_scroll ───

const BrowserScrollSchema = Type.Object({
  direction: Type.Union([
    Type.Literal("up"),
    Type.Literal("down"),
    Type.Literal("left"),
    Type.Literal("right"),
  ], { description: "Scroll direction" }),
  pixels: Type.Optional(Type.Number({ description: "Number of pixels to scroll (default: varies)" })),
});

function createBrowserScrollTool(session: string): AgentTool<typeof BrowserScrollSchema> {
  return {
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the page in a direction. Useful for loading lazy content or navigating long pages.",
    parameters: BrowserScrollSchema,
    async execute(_id, params, signal) {
      const args = ["scroll", params.direction];
      if (params.pixels) args.push(String(params.pixels));
      const result = await execBrowserAsync(args, { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_wait ───

const BrowserWaitSchema = Type.Object({
  selector: Type.Optional(Type.String({ description: "CSS selector or ref to wait for" })),
  text: Type.Optional(Type.String({ description: "Wait for text to appear on page" })),
  url: Type.Optional(Type.String({ description: "Wait for URL pattern (glob)" })),
  timeout_ms: Type.Optional(Type.Number({ description: "Wait for milliseconds" })),
  load_state: Type.Optional(Type.Union([
    Type.Literal("load"),
    Type.Literal("domcontentloaded"),
    Type.Literal("networkidle"),
  ], { description: "Wait for load state" })),
});

function createBrowserWaitTool(session: string): AgentTool<typeof BrowserWaitSchema> {
  return {
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for an element, text, URL pattern, or load state. Use after navigation or actions that trigger async content.",
    parameters: BrowserWaitSchema,
    async execute(_id, params, signal) {
      const args = ["wait"];
      if (params.selector) args.push(params.selector);
      if (params.text) args.push("--text", params.text);
      if (params.url) args.push("--url", params.url);
      if (params.timeout_ms) args.push(String(params.timeout_ms));
      if (params.load_state) args.push("--load", params.load_state);
      const result = await execBrowserAsync(args, { session, signal, timeout: 60_000 });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_eval ───

const BrowserEvalSchema = Type.Object({
  javascript: Type.String({ description: "JavaScript code to execute in the browser page context" }),
});

function createBrowserEvalTool(session: string): AgentTool<typeof BrowserEvalSchema> {
  return {
    name: "browser_eval",
    label: "Browser Evaluate JS",
    description: "Execute JavaScript in the browser page context and return the result. " +
      "Use for reading DOM properties, manipulating the page, or extracting data not available via snapshot.",
    parameters: BrowserEvalSchema,
    async execute(_id, params, signal) {
      // Use base64 encoding for safe transport of complex JS
      const b64 = Buffer.from(params.javascript).toString("base64");
      const result = await execBrowserAsync(["eval", b64, "-b"], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_close ───

const BrowserCloseSchema = Type.Object({});

function createBrowserCloseTool(session: string): AgentTool<typeof BrowserCloseSchema> {
  return {
    name: "browser_close",
    label: "Browser Close",
    description: "Close the browser session. Call this when done with browser interactions to free resources.",
    parameters: BrowserCloseSchema,
    async execute(_id, _params, signal) {
      const result = await execBrowserAsync(["close"], { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_back / browser_forward / browser_reload ───

const BrowserNavActionSchema = Type.Object({});

function createBrowserBackTool(session: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_back",
    label: "Browser Back",
    description: "Navigate back in browser history.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await execBrowserAsync(["back"], { session, signal }));
    },
  };
}

function createBrowserForwardTool(session: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_forward",
    label: "Browser Forward",
    description: "Navigate forward in browser history.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await execBrowserAsync(["forward"], { session, signal }));
    },
  };
}

function createBrowserReloadTool(session: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await execBrowserAsync(["reload"], { session, signal }));
    },
  };
}

// ─── Tool: browser_tabs ───

const BrowserTabsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("new"),
    Type.Literal("switch"),
    Type.Literal("close"),
  ], { description: "Tab action: list, new, switch, or close" }),
  index: Type.Optional(Type.Number({ description: "Tab index for switch/close actions" })),
  url: Type.Optional(Type.String({ description: "URL to open in new tab" })),
});

function createBrowserTabsTool(session: string): AgentTool<typeof BrowserTabsSchema> {
  return {
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "Manage browser tabs: list open tabs, open new tab, switch to tab, or close tab.",
    parameters: BrowserTabsSchema,
    async execute(_id, params, signal) {
      const args = ["tab"];
      switch (params.action) {
        case "list":
          break;
        case "new":
          args.push("new");
          if (params.url) args.push(params.url);
          break;
        case "switch":
          if (params.index !== undefined) args.push(String(params.index));
          break;
        case "close":
          args.push("close");
          if (params.index !== undefined) args.push(String(params.index));
          break;
      }
      const result = await execBrowserAsync(args, { session, signal });
      return browserResult(result);
    },
  };
}

// ─── Factory ───

export type BrowserToolName =
  | "browser_navigate" | "browser_snapshot" | "browser_click" | "browser_fill"
  | "browser_type" | "browser_press" | "browser_screenshot" | "browser_get"
  | "browser_select" | "browser_hover" | "browser_scroll" | "browser_wait"
  | "browser_eval" | "browser_close" | "browser_back" | "browser_forward"
  | "browser_reload" | "browser_tabs";

export const ALL_BROWSER_TOOL_NAMES: BrowserToolName[] = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_fill",
  "browser_type", "browser_press", "browser_screenshot", "browser_get",
  "browser_select", "browser_hover", "browser_scroll", "browser_wait",
  "browser_eval", "browser_close", "browser_back", "browser_forward",
  "browser_reload", "browser_tabs",
];

/**
 * Create browser automation tools.
 *
 * @param cwd - Working directory for resolving relative file paths (screenshots)
 * @param session - Browser session name for isolation (default: agent name or "default")
 * @param allowedTools - Optional filter: only include tools with these names
 */
export function createBrowserTools(
  cwd: string,
  session: string = "default",
  allowedTools?: string[],
): AgentTool<any>[] {
  const factories: Record<BrowserToolName, () => AgentTool<any>> = {
    browser_navigate: () => createBrowserNavigateTool(session),
    browser_snapshot: () => createBrowserSnapshotTool(session),
    browser_click: () => createBrowserClickTool(session),
    browser_fill: () => createBrowserFillTool(session),
    browser_type: () => createBrowserTypeTool(session),
    browser_press: () => createBrowserPressTool(session),
    browser_screenshot: () => createBrowserScreenshotTool(session, cwd),
    browser_get: () => createBrowserGetTool(session),
    browser_select: () => createBrowserSelectTool(session),
    browser_hover: () => createBrowserHoverTool(session),
    browser_scroll: () => createBrowserScrollTool(session),
    browser_wait: () => createBrowserWaitTool(session),
    browser_eval: () => createBrowserEvalTool(session),
    browser_close: () => createBrowserCloseTool(session),
    browser_back: () => createBrowserBackTool(session),
    browser_forward: () => createBrowserForwardTool(session),
    browser_reload: () => createBrowserReloadTool(session),
    browser_tabs: () => createBrowserTabsTool(session),
  };

  const names = allowedTools
    ? ALL_BROWSER_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_BROWSER_TOOL_NAMES;

  return names.map(n => factories[n]());
}
