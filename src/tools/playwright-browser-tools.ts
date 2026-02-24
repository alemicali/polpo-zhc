/**
 * Browser automation tools powered by Playwright with persistent profiles.
 *
 * Uses playwright-core's `launchPersistentContext()` to maintain cookies,
 * localStorage, and auth state across sessions. Each agent gets its own
 * profile directory (`.polpo/browser-profiles/<name>/`), so browser logins
 * (e.g. X/Twitter, Google) persist between runs.
 *
 * The browser context is lazily launched on first tool use and kept alive
 * for the lifetime of the agent process. Call `cleanupPlaywrightContext()`
 * on shutdown to gracefully close (profile data is auto-saved to disk).
 *
 * Requires `playwright-core` (already in dependencies).
 * Chromium must be installed: `npx playwright install chromium`
 */

import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

// Lazy-loaded playwright types (avoid import at module level)
type Browser = import("playwright-core").Browser;
type BrowserContext = import("playwright-core").BrowserContext;
type Page = import("playwright-core").Page;

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT = 30_000;

// ─── Persistent context management ───

/** Active contexts keyed by profile directory */
const contexts = new Map<string, { context: BrowserContext; browser?: Browser }>();

/**
 * Get or create a persistent browser context for the given profile directory.
 * Uses Chromium with a persistent user data dir so cookies/auth persist.
 */
async function getContext(profileDir: string): Promise<{ context: BrowserContext; page: Page }> {
  let entry = contexts.get(profileDir);

  if (!entry) {
    mkdirSync(profileDir, { recursive: true });
    const { chromium } = await import("playwright-core");

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Europe/Rome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
    });

    entry = { context };
    contexts.set(profileDir, entry);
  }

  const pages = entry.context.pages();
  const page = pages.length > 0 ? pages[pages.length - 1] : await entry.context.newPage();
  return { context: entry.context, page };
}

/** Get the currently active page (last focused) or create one. */
async function getActivePage(profileDir: string): Promise<Page> {
  const { context } = await getContext(profileDir);
  const pages = context.pages();
  return pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
}

/**
 * Close the persistent context. Profile data is automatically saved to disk.
 * Called by engine.ts on agent shutdown.
 */
export async function cleanupPlaywrightContext(profileDir: string): Promise<void> {
  const entry = contexts.get(profileDir);
  if (entry) {
    await entry.context.close().catch(() => {});
    contexts.delete(profileDir);
  }
}

// ─── Helpers ───

function ok(text: string, details?: any): AgentToolResult<any> {
  const trimmed = text.length > MAX_OUTPUT_BYTES
    ? text.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]"
    : text;
  return {
    content: [{ type: "text", text: trimmed }],
    details: details ?? {},
  };
}

function err(message: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: `Browser error: ${message}` }],
    details: { error: message },
  };
}

// ─── Tool: browser_navigate ───

const BrowserNavigateSchema = Type.Object({
  url: Type.String({ description: "URL to navigate to (e.g. 'https://x.com')" }),
  wait_until: Type.Optional(Type.Union([
    Type.Literal("load"),
    Type.Literal("domcontentloaded"),
    Type.Literal("networkidle"),
    Type.Literal("commit"),
  ], { description: "When to consider navigation done (default: domcontentloaded)" })),
});

function createNavigateTool(profileDir: string): AgentTool<typeof BrowserNavigateSchema> {
  return {
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open a URL in the browser. The browser keeps cookies and login sessions from previous runs.",
    parameters: BrowserNavigateSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        const response = await page.goto(params.url, {
          waitUntil: params.wait_until ?? "domcontentloaded",
          timeout: DEFAULT_TIMEOUT,
        });
        const status = response?.status() ?? 0;
        const title = await page.title();
        const url = page.url();
        return ok(`Navigated to: ${url}\nTitle: ${title}\nStatus: ${status}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_snapshot ───

const BrowserSnapshotSchema = Type.Object({
  selector: Type.Optional(Type.String({ description: "Scope snapshot to a CSS selector" })),
});

function createSnapshotTool(profileDir: string): AgentTool<typeof BrowserSnapshotSchema> {
  return {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Get the accessibility tree of the current page. Shows interactive elements with refs (e.g. [ref=e1]) for targeting.",
    parameters: BrowserSnapshotSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        const root = params.selector
          ? page.locator(params.selector)
          : page;
        const snapshot = await (root as any).accessibility?.snapshot?.() ?? null;
        if (snapshot) {
          return ok(JSON.stringify(snapshot, null, 2));
        }
        // Fallback: get structured content via aria
        const ariaTree = await page.evaluate(() => {
          function walk(el: Element, depth: number): string {
            const role = el.getAttribute("role") || el.tagName.toLowerCase();
            const name = el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || "";
            const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
              ? (el.childNodes[0] as Text).textContent?.trim().slice(0, 80) ?? ""
              : "";
            const indent = "  ".repeat(depth);
            let line = `${indent}[${role}]`;
            if (name) line += ` name="${name}"`;
            if (text) line += ` "${text}"`;
            const lines = [line];
            for (const child of el.children) {
              lines.push(walk(child, depth + 1));
            }
            return lines.join("\n");
          }
          return walk(document.body, 0);
        });
        return ok(ariaTree);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_click ───

const BrowserClickSchema = Type.Object({
  selector: Type.String({ description: "CSS selector, text selector ('text=Click me'), or role selector ('role=button[name=Submit]')" }),
});

function createClickTool(profileDir: string): AgentTool<typeof BrowserClickSchema> {
  return {
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element on the page. Supports CSS selectors, text selectors (text=...), and role selectors (role=...).",
    parameters: BrowserClickSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        await page.click(params.selector, { timeout: DEFAULT_TIMEOUT });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return ok(`Clicked: ${params.selector}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_fill ───

const BrowserFillSchema = Type.Object({
  selector: Type.String({ description: "CSS or role selector for the input field" }),
  text: Type.String({ description: "Text to fill into the input (clears existing content)" }),
});

function createFillTool(profileDir: string): AgentTool<typeof BrowserFillSchema> {
  return {
    name: "browser_fill",
    label: "Browser Fill",
    description: "Clear an input field and type new text. For appending, use browser_type instead.",
    parameters: BrowserFillSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        await page.fill(params.selector, params.text, { timeout: DEFAULT_TIMEOUT });
        return ok(`Filled "${params.selector}" with: ${params.text.slice(0, 100)}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_type ───

const BrowserTypeSchema = Type.Object({
  selector: Type.String({ description: "CSS or role selector for the input" }),
  text: Type.String({ description: "Text to type (appends to existing content)" }),
  delay: Type.Optional(Type.Number({ description: "Delay between keystrokes in ms (for triggering key handlers)" })),
});

function createTypeTool(profileDir: string): AgentTool<typeof BrowserTypeSchema> {
  return {
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an element without clearing it first. Simulates real keystrokes. Use delay for sites that need key-by-key input.",
    parameters: BrowserTypeSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        await page.locator(params.selector).pressSequentially(params.text, {
          delay: params.delay ?? 0,
          timeout: DEFAULT_TIMEOUT,
        });
        return ok(`Typed into "${params.selector}": ${params.text.slice(0, 100)}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_press ───

const BrowserPressSchema = Type.Object({
  key: Type.String({ description: "Key to press (e.g. 'Enter', 'Tab', 'Control+a', 'Escape')" }),
  selector: Type.Optional(Type.String({ description: "Optional: focus this element before pressing" })),
});

function createPressTool(profileDir: string): AgentTool<typeof BrowserPressSchema> {
  return {
    name: "browser_press",
    label: "Browser Press Key",
    description: "Press a keyboard key. Supports modifiers like 'Control+a', 'Shift+Enter'.",
    parameters: BrowserPressSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        if (params.selector) {
          await page.press(params.selector, params.key, { timeout: DEFAULT_TIMEOUT });
        } else {
          await page.keyboard.press(params.key);
        }
        return ok(`Pressed: ${params.key}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_screenshot ───

const BrowserScreenshotSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "File path to save screenshot (default: auto-generated)" })),
  full_page: Type.Optional(Type.Boolean({ description: "Capture full scrollable page" })),
  selector: Type.Optional(Type.String({ description: "Capture only this element" })),
});

function createScreenshotTool(profileDir: string, cwd: string): AgentTool<typeof BrowserScreenshotSchema> {
  return {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current page or a specific element.",
    parameters: BrowserScreenshotSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        const filePath = params.path
          ? resolve(cwd, params.path)
          : join(cwd, `.polpo/tmp/screenshot-${Date.now()}.png`);

        mkdirSync(resolve(filePath, ".."), { recursive: true });

        if (params.selector) {
          await page.locator(params.selector).screenshot({ path: filePath, timeout: DEFAULT_TIMEOUT });
        } else {
          await page.screenshot({ path: filePath, fullPage: params.full_page ?? false });
        }
        return ok(`Screenshot saved: ${filePath}`, { path: filePath });
      } catch (e: any) {
        return err(e.message);
      }
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
  ], { description: "What to retrieve" }),
  selector: Type.Optional(Type.String({ description: "Element selector (required for text/html/value)" })),
});

function createGetTool(profileDir: string): AgentTool<typeof BrowserGetSchema> {
  return {
    name: "browser_get",
    label: "Browser Get Info",
    description: "Get text content, inner HTML, input value, page title, or current URL.",
    parameters: BrowserGetSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        let result: string;
        switch (params.what) {
          case "title":
            result = await page.title();
            break;
          case "url":
            result = page.url();
            break;
          case "text":
            result = await page.locator(params.selector!).innerText({ timeout: DEFAULT_TIMEOUT });
            break;
          case "html":
            result = await page.locator(params.selector!).innerHTML({ timeout: DEFAULT_TIMEOUT });
            break;
          case "value":
            result = await page.locator(params.selector!).inputValue({ timeout: DEFAULT_TIMEOUT });
            break;
          default:
            result = "Unknown property";
        }
        return ok(result);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_select ───

const BrowserSelectSchema = Type.Object({
  selector: Type.String({ description: "CSS selector for the <select> element" }),
  value: Type.String({ description: "Option value to select" }),
});

function createSelectTool(profileDir: string): AgentTool<typeof BrowserSelectSchema> {
  return {
    name: "browser_select",
    label: "Browser Select",
    description: "Select an option from a dropdown.",
    parameters: BrowserSelectSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        await page.selectOption(params.selector, params.value, { timeout: DEFAULT_TIMEOUT });
        return ok(`Selected "${params.value}" in ${params.selector}`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_hover ───

const BrowserHoverSchema = Type.Object({
  selector: Type.String({ description: "Element selector to hover" }),
});

function createHoverTool(profileDir: string): AgentTool<typeof BrowserHoverSchema> {
  return {
    name: "browser_hover",
    label: "Browser Hover",
    description: "Hover over an element to trigger hover states or tooltips.",
    parameters: BrowserHoverSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        await page.hover(params.selector, { timeout: DEFAULT_TIMEOUT });
        return ok(`Hovered: ${params.selector}`);
      } catch (e: any) {
        return err(e.message);
      }
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
  pixels: Type.Optional(Type.Number({ description: "Pixels to scroll (default: 500)" })),
  selector: Type.Optional(Type.String({ description: "Scroll within this element instead of the page" })),
});

function createScrollTool(profileDir: string): AgentTool<typeof BrowserScrollSchema> {
  return {
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the page or a specific element.",
    parameters: BrowserScrollSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        const px = params.pixels ?? 500;
        const deltaX = params.direction === "left" ? -px : params.direction === "right" ? px : 0;
        const deltaY = params.direction === "up" ? -px : params.direction === "down" ? px : 0;

        if (params.selector) {
          await page.locator(params.selector).evaluate(
            (el, { dx, dy }) => el.scrollBy(dx, dy),
            { dx: deltaX, dy: deltaY },
          );
        } else {
          await page.mouse.wheel(deltaX, deltaY);
        }
        return ok(`Scrolled ${params.direction} ${px}px`);
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_wait ───

const BrowserWaitSchema = Type.Object({
  selector: Type.Optional(Type.String({ description: "Wait for this element to appear" })),
  text: Type.Optional(Type.String({ description: "Wait for this text to appear on page" })),
  url: Type.Optional(Type.String({ description: "Wait for URL to match (glob pattern)" })),
  timeout_ms: Type.Optional(Type.Number({ description: "Max wait time in ms (default: 30000)" })),
  state: Type.Optional(Type.Union([
    Type.Literal("visible"),
    Type.Literal("hidden"),
    Type.Literal("attached"),
    Type.Literal("detached"),
  ], { description: "Element state to wait for (default: visible)" })),
  load_state: Type.Optional(Type.Union([
    Type.Literal("load"),
    Type.Literal("domcontentloaded"),
    Type.Literal("networkidle"),
  ], { description: "Wait for page load state" })),
});

function createWaitTool(profileDir: string): AgentTool<typeof BrowserWaitSchema> {
  return {
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for an element, text, URL pattern, or load state.",
    parameters: BrowserWaitSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT;

        if (params.load_state) {
          await page.waitForLoadState(params.load_state, { timeout });
          return ok(`Page reached "${params.load_state}" state`);
        }
        if (params.url) {
          await page.waitForURL(params.url, { timeout });
          return ok(`URL matched: ${page.url()}`);
        }
        if (params.text) {
          await page.getByText(params.text).waitFor({ state: "visible", timeout });
          return ok(`Text found: "${params.text}"`);
        }
        if (params.selector) {
          await page.locator(params.selector).waitFor({
            state: params.state ?? "visible",
            timeout,
          });
          return ok(`Element ready: ${params.selector}`);
        }
        // Fallback: just wait for a duration
        if (params.timeout_ms) {
          await page.waitForTimeout(params.timeout_ms);
          return ok(`Waited ${params.timeout_ms}ms`);
        }
        return ok("Nothing to wait for — provide selector, text, url, or timeout_ms");
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_eval ───

const BrowserEvalSchema = Type.Object({
  javascript: Type.String({ description: "JavaScript code to execute in the page context. Must be an expression or IIFE." }),
});

function createEvalTool(profileDir: string): AgentTool<typeof BrowserEvalSchema> {
  return {
    name: "browser_eval",
    label: "Browser Evaluate JS",
    description: "Execute JavaScript in the browser page context and return the result.",
    parameters: BrowserEvalSchema,
    async execute(_id, params) {
      try {
        const page = await getActivePage(profileDir);
        const result = await page.evaluate(params.javascript);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return ok(text ?? "undefined");
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_close ───

const BrowserCloseSchema = Type.Object({});

function createCloseTool(profileDir: string): AgentTool<typeof BrowserCloseSchema> {
  return {
    name: "browser_close",
    label: "Browser Close",
    description: "Close the browser. Profile data (cookies, login) is saved automatically.",
    parameters: BrowserCloseSchema,
    async execute() {
      try {
        await cleanupPlaywrightContext(profileDir);
        return ok("Browser closed. Profile data saved.");
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Tool: browser_back / browser_forward / browser_reload ───

const BrowserNavActionSchema = Type.Object({});

function createBackTool(profileDir: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_back",
    label: "Browser Back",
    description: "Navigate back in browser history.",
    parameters: BrowserNavActionSchema,
    async execute() {
      try {
        const page = await getActivePage(profileDir);
        await page.goBack({ timeout: DEFAULT_TIMEOUT });
        return ok(`Back to: ${page.url()}`);
      } catch (e: any) { return err(e.message); }
    },
  };
}

function createForwardTool(profileDir: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_forward",
    label: "Browser Forward",
    description: "Navigate forward in browser history.",
    parameters: BrowserNavActionSchema,
    async execute() {
      try {
        const page = await getActivePage(profileDir);
        await page.goForward({ timeout: DEFAULT_TIMEOUT });
        return ok(`Forward to: ${page.url()}`);
      } catch (e: any) { return err(e.message); }
    },
  };
}

function createReloadTool(profileDir: string): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page.",
    parameters: BrowserNavActionSchema,
    async execute() {
      try {
        const page = await getActivePage(profileDir);
        await page.reload({ timeout: DEFAULT_TIMEOUT });
        return ok(`Reloaded: ${page.url()}`);
      } catch (e: any) { return err(e.message); }
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
  index: Type.Optional(Type.Number({ description: "Tab index for switch/close" })),
  url: Type.Optional(Type.String({ description: "URL for new tab" })),
});

function createTabsTool(profileDir: string): AgentTool<typeof BrowserTabsSchema> {
  return {
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "Manage browser tabs: list, open new, switch to, or close a tab.",
    parameters: BrowserTabsSchema,
    async execute(_id, params) {
      try {
        const { context } = await getContext(profileDir);
        const pages = context.pages();

        switch (params.action) {
          case "list": {
            const list = await Promise.all(pages.map(async (p, i) => {
              const title = await p.title().catch(() => "");
              return `[${i}] ${p.url()} — ${title}`;
            }));
            return ok(list.join("\n") || "No tabs open");
          }
          case "new": {
            const page = await context.newPage();
            if (params.url) {
              await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
            }
            return ok(`Opened tab ${pages.length}: ${page.url()}`);
          }
          case "switch": {
            const idx = params.index ?? 0;
            if (idx < 0 || idx >= pages.length) return err(`Tab index ${idx} out of range (0-${pages.length - 1})`);
            await pages[idx].bringToFront();
            return ok(`Switched to tab ${idx}: ${pages[idx].url()}`);
          }
          case "close": {
            const idx = params.index ?? pages.length - 1;
            if (idx < 0 || idx >= pages.length) return err(`Tab index ${idx} out of range`);
            await pages[idx].close();
            return ok(`Closed tab ${idx}`);
          }
          default:
            return err("Unknown tab action");
        }
      } catch (e: any) {
        return err(e.message);
      }
    },
  };
}

// ─── Factory ───

export type { BrowserToolName } from "./browser-tools.js";
import type { BrowserToolName } from "./browser-tools.js";
import { ALL_BROWSER_TOOL_NAMES } from "./browser-tools.js";

/**
 * Create browser tools using Playwright with a persistent profile.
 *
 * Profile directory stores cookies, localStorage, and auth state.
 * The browser context is lazily launched on first tool use.
 *
 * @param cwd - Working directory for resolving relative paths
 * @param profileDir - Absolute path to the browser profile directory
 * @param allowedTools - Optional filter: only include tools with these names
 */
export function createPlaywrightBrowserTools(
  cwd: string,
  profileDir: string,
  allowedTools?: string[],
): AgentTool<any>[] {
  const factories: Record<BrowserToolName, () => AgentTool<any>> = {
    browser_navigate: () => createNavigateTool(profileDir),
    browser_snapshot: () => createSnapshotTool(profileDir),
    browser_click: () => createClickTool(profileDir),
    browser_fill: () => createFillTool(profileDir),
    browser_type: () => createTypeTool(profileDir),
    browser_press: () => createPressTool(profileDir),
    browser_screenshot: () => createScreenshotTool(profileDir, cwd),
    browser_get: () => createGetTool(profileDir),
    browser_select: () => createSelectTool(profileDir),
    browser_hover: () => createHoverTool(profileDir),
    browser_scroll: () => createScrollTool(profileDir),
    browser_wait: () => createWaitTool(profileDir),
    browser_eval: () => createEvalTool(profileDir),
    browser_close: () => createCloseTool(profileDir),
    browser_back: () => createBackTool(profileDir),
    browser_forward: () => createForwardTool(profileDir),
    browser_reload: () => createReloadTool(profileDir),
    browser_tabs: () => createTabsTool(profileDir),
  };

  const names = allowedTools
    ? ALL_BROWSER_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_BROWSER_TOOL_NAMES;

  return names.map(n => factories[n]());
}
