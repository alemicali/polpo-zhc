/**
 * Browser automation tools powered by agent-browser.
 *
 * Uses the agent-browser CLI (https://github.com/vercel-labs/agent-browser)
 * with --json output for structured results. Where it runs follows the agent's sandbox:
 *   - remote sandbox (Daytona, E2B): through the workspace shell, inside the VM (the runner
 *     image ships agent-browser + Chromium; otherwise it is installed on first use);
 *   - this machine (no sandbox, bubblewrap, docker): as a child process, behind the sandbox
 *     network proxy (browser-network-guard.ts).
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

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import { withHostTempDir, writeBytes } from "./tool-fs.js";
import { assertWebUrl } from "./browser-url-guard.js";
import { assertPathAllowed, resolveAllowedPaths } from "./path-sandbox.js";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveToolOutputDir, withToolOutputOffload } from "./tool-output.js";
import { browserProxyContext, proxyArgs, type BrowserNetworkGuard } from "./browser-network-guard.js";

/** Agent browser results above this are saved in full to a file (head + tail + path for the model). */
const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT = 30_000;

/**
 * Cleanup an agent-browser session: close the session.
 * Profile data is automatically persisted by agent-browser when --profile is used.
 * Called by the engine on agent exit.
 */
export async function cleanupAgentBrowserSession(session: string, shell?: Shell): Promise<void> {
  // a browser in a remote sandbox is closed there
  if (shell && await shellIsRemote(shell)) {
    await shell.execute(sandboxBrowserCommand(["close"], { session }), { timeout: 10_000 }).catch(() => undefined);
    return;
  }
  try {
    // Argument array, no shell: the session is derived from the agent name.
    execFileSync("agent-browser", ["--session", session, "close"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Already closed
  }
}

// ─── Helpers ───

/** Execute agent-browser CLI command and return parsed result */
function execBrowser(
  args: string[],
  options: { session?: string; profileDir?: string; timeout?: number; cwd?: string } = {},
): { success: boolean; data?: any; error?: string; raw: string } {
  const sessionArgs = options.session ? ["--session", options.session] : [];
  const profileArgs = options.profileDir ? ["--profile", options.profileDir] : [];
  try {
    const raw = execFileSync("agent-browser", [...sessionArgs, ...profileArgs, ...args, "--json"], {
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

/** Execute agent-browser command async with signal support.
 *  Exported so the orchestrator-side wrappers (src/llm/orchestrator-browser-tools.ts)
 *  can reuse the same CLI bridge as the agent-side tools — single source of truth.
 */
export function execBrowserAsync(
  args: string[],
  options: {
    session?: string; profileDir?: string; cdp?: number; timeout?: number; cwd?: string; signal?: AbortSignal;
    /** Proxy the browser must use (the sandbox network rule); ignored when attached to an external Chrome. */
    proxy?: string;
    /** Keep only the last N chars of the raw output (default 50,000). Infinity keeps everything. */
    maxOutputBytes?: number;
  } = {},
): Promise<{ success: boolean; data?: any; error?: string; raw: string }> {
  return new Promise((resolve) => {
    const sessionArgs = options.session ? ["--session", options.session] : [];
    // When attaching to an external Chrome via CDP, --profile is meaningless
    // (that Chrome already owns its user-data-dir) so it's dropped.
    const cdpArgs = options.cdp ? ["--cdp", String(options.cdp)] : [];
    const profileArgs = options.cdp || !options.profileDir ? [] : ["--profile", options.profileDir];
    const fullArgs = [...sessionArgs, ...cdpArgs, ...profileArgs, ...(options.cdp ? [] : proxyArgs(options.proxy)), ...args, "--json"];

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
      const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
      if (raw.length > maxOutput) {
        raw = raw.slice(-maxOutput) + "\n[truncated]";
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
  // No slicing here: createBrowserTools wraps every tool with
  // withToolOutputOffload, which saves results above MAX_OUTPUT_BYTES in full.
  return {
    content: [{ type: "text", text }],
    details: result.data,
  };
}

/** Agent-side CLI call: the raw output is kept whole so large results can be offloaded, not lost. */
function execAgentBrowser(
  args: string[],
  options: { session?: string; profileDir?: string; timeout?: number; cwd?: string; signal?: AbortSignal } = {},
): ReturnType<typeof execBrowserAsync> {
  return execBrowserAsync(args, { ...options, proxy: browserProxyContext.getStore()?.proxy, maxOutputBytes: Infinity });
}

type BrowserCallResult = { success: boolean; data?: any; error?: string; raw: string };

/**
 * One agent-browser call, wherever the browser runs. `profile: false` leaves the persistent
 * profile out (close); `saves` is the file the command writes (screenshots), already checked
 * against the allowed paths.
 */
export type BrowserExec = (args: string[], options?: { signal?: AbortSignal; timeout?: number; profile?: boolean; saves?: string }) => Promise<BrowserCallResult>;

/** Quote an argument for a POSIX shell command line. */
function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Where agent profiles live inside a sandbox VM (persistent across runs on a reused VM). */
export const SANDBOX_BROWSER_PROFILES = ".polpo/browser-profiles";

/** The agent-browser command line run in a sandbox (exported for tests). */
export function sandboxBrowserCommand(args: string[], options: { session?: string; profileName?: string } = {}): string {
  const parts = ["agent-browser"];
  if (options.session) parts.push("--session", shq(options.session));
  // the profile lives in the VM user's home: the host path means nothing there
  if (options.profileName) parts.push("--profile", `"$HOME"/${shq(`${SANDBOX_BROWSER_PROFILES}/${options.profileName}`)}`);
  for (const a of args) parts.push(shq(a));
  parts.push("--json");
  return parts.join(" ");
}

/** Parse agent-browser --json output from a shell result (agent-browser emits JSON on failure too). */
function parseShellBrowserResult(result: { stdout: string; stderr: string; exitCode: number }): BrowserCallResult {
  const raw = (result.stdout || result.stderr || "").trim();
  if (result.exitCode !== 0) {
    try {
      const parsed = JSON.parse(raw);
      return { success: false, error: parsed.error ?? raw, data: parsed.data, raw };
    } catch {
      return { success: false, error: raw || `agent-browser exited with ${result.exitCode}`, raw };
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return { success: parsed.success ?? true, data: parsed.data ?? parsed, raw };
  } catch {
    return { success: true, data: raw, raw };
  }
}

/** Libraries agent-browser's Chromium links against (Debian names; the runner image has them). */
const CHROMIUM_LIBS = "libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 " +
  "libxss1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 libwayland-client0 libxshmfence1 libxfixes3 libxext6 libxcursor1 " +
  "libxi6 libxtst6 libxrender1 libxinerama1 libdbus-1-3 libatspi2.0-0 libdrm2 libx11-xcb1 fonts-liberation";

/** True when agent-browser and a Chromium for it are there (its own download, or a system Chrome). */
export const AGENT_BROWSER_CHECK_COMMAND =
  "command -v agent-browser >/dev/null && { ls -d \"$HOME\"/.agent-browser/browsers/*/ >/dev/null 2>&1 || command -v chromium google-chrome chromium-browser >/dev/null; }";

/**
 * Installs what is missing in a VM without the runner image: the CLI (global npm, with sudo when
 * needed), Chromium's libraries (apt, best effort) and Chromium itself, in the VM user's home.
 */
export const AGENT_BROWSER_INSTALL_COMMAND =
  "(command -v agent-browser >/dev/null || npm i -g agent-browser >/dev/null 2>&1 || sudo -n npm i -g agent-browser >/dev/null 2>&1)" +
  ` && (sudo -n sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${CHROMIUM_LIBS}' >/dev/null 2>&1 || true)` +
  " && agent-browser install >/dev/null 2>&1 && command -v agent-browser";

const browserReady = new WeakMap<Shell, Promise<string | undefined>>();

/**
 * agent-browser in the sandbox: present in the runner image; otherwise installed on first use
 * (once per shell). Resolves to an error message when it cannot be made available.
 */
export function ensureSandboxBrowser(shell: Shell): Promise<string | undefined> {
  let ready = browserReady.get(shell);
  if (!ready) {
    ready = (async () => {
      const found = await shell.execute(AGENT_BROWSER_CHECK_COMMAND, { timeout: 20_000 }).catch(() => undefined);
      if (found?.exitCode === 0) return undefined;
      const installed = await shell.execute(AGENT_BROWSER_INSTALL_COMMAND, { timeout: 600_000 }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String(err?.message ?? err) }));
      if (installed.exitCode === 0) return undefined;
      return "agent-browser is not installed in the sandbox and could not be installed there " +
        `(${(installed.stderr || installed.stdout || `exit ${installed.exitCode}`).trim().slice(0, 300)}). ` +
        "Use the Polpo runner image for this provider (settings.sandbox.providers.<provider>.snapshot or .template).";
    })();
    browserReady.set(shell, ready);
    // a failed attempt is retried on the next call (the VM may have network by then)
    void ready.then((err) => { if (err) browserReady.delete(shell); });
  }
  return ready;
}

/** Run agent-browser in the sandbox through its shell (the browser lives where the agent's files live). */
async function execSandboxBrowser(
  shell: Shell,
  args: string[],
  options: { session?: string; profileName?: string; timeout?: number; cwd?: string; saves?: string },
): Promise<BrowserCallResult> {
  const missing = await ensureSandboxBrowser(shell);
  if (missing) return { success: false, error: missing, raw: missing };
  try {
    // agent-browser does not create the folder of the file it saves
    const mkdir = options.saves ? `mkdir -p ${shq(dirname(options.saves))} && ` : "";
    const result = await shell.execute(mkdir + sandboxBrowserCommand(args, options), { cwd: options.cwd, timeout: options.timeout ?? DEFAULT_TIMEOUT });
    return parseShellBrowserResult(result);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return { success: false, error: message, raw: message };
  }
}

/** True when the shell runs commands on another machine (a remote sandbox VM). */
export async function shellIsRemote(shell: Shell | undefined): Promise<boolean> {
  if (!shell?.isRemote) return false;
  try {
    return await shell.isRemote();
  } catch {
    return false;
  }
}

// ─── Tool: browser_navigate ───

const BrowserNavigateSchema = Type.Object({
  url: Type.String({ description: "URL to navigate to (e.g. 'https://example.com')" }),
});

function createBrowserNavigateTool(exec: BrowserExec): AgentTool<typeof BrowserNavigateSchema> {
  return {
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open a URL in the browser. Launches the browser if not already running.",
    parameters: BrowserNavigateSchema,
    async execute(_id, params, signal) {
      const result = await exec(["open", assertWebUrl(params.url, "browser_navigate")], { signal });
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

function createBrowserSnapshotTool(exec: BrowserExec): AgentTool<typeof BrowserSnapshotSchema> {
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
      const result = await exec(args, { signal, timeout: 15_000 });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_click ───

const BrowserClickSchema = Type.Object({
  selector: Type.String({ description: "Element ref from snapshot (e.g. '@e2') or CSS selector" }),
});

function createBrowserClickTool(exec: BrowserExec): AgentTool<typeof BrowserClickSchema> {
  return {
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element. Use refs from snapshot (e.g. @e2) for reliable targeting.",
    parameters: BrowserClickSchema,
    async execute(_id, params, signal) {
      const result = await exec(["click", params.selector], { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_fill ───

const BrowserFillSchema = Type.Object({
  selector: Type.String({ description: "Element ref from snapshot (e.g. '@e3') or CSS selector" }),
  text: Type.String({ description: "Text to fill into the input" }),
});

function createBrowserFillTool(exec: BrowserExec): AgentTool<typeof BrowserFillSchema> {
  return {
    name: "browser_fill",
    label: "Browser Fill",
    description: "Clear an input field and type new text. Use refs from snapshot for targeting.",
    parameters: BrowserFillSchema,
    async execute(_id, params, signal) {
      const result = await exec(["fill", params.selector, params.text], { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_type ───

const BrowserTypeSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector" }),
  text: Type.String({ description: "Text to type (appends to existing content)" }),
});

function createBrowserTypeTool(exec: BrowserExec): AgentTool<typeof BrowserTypeSchema> {
  return {
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an element without clearing it first. Use for appending text.",
    parameters: BrowserTypeSchema,
    async execute(_id, params, signal) {
      const result = await exec(["type", params.selector, params.text], { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_press ───

const BrowserPressSchema = Type.Object({
  key: Type.String({ description: "Key to press (e.g. 'Enter', 'Tab', 'Control+a', 'Escape')" }),
});

function createBrowserPressTool(exec: BrowserExec): AgentTool<typeof BrowserPressSchema> {
  return {
    name: "browser_press",
    label: "Browser Press Key",
    description: "Press a keyboard key. Supports modifiers like 'Control+a', 'Shift+Enter'.",
    parameters: BrowserPressSchema,
    async execute(_id, params, signal) {
      const result = await exec(["press", params.key], { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_screenshot ───

const BrowserScreenshotSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "File path to save screenshot (default: auto-generated temp path)" })),
  full_page: Type.Optional(Type.Boolean({ description: "Capture full page, not just viewport" })),
});

function createBrowserScreenshotTool(exec: BrowserExec, cwd: string, allowedPaths?: string[]): AgentTool<typeof BrowserScreenshotSchema> {
  return {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Take a screenshot of the current page. Returns the file path of the saved image.",
    parameters: BrowserScreenshotSchema,
    async execute(_id, params, signal) {
      const args = ["screenshot"];
      let target: string | undefined;
      if (params.path) {
        target = resolve(cwd, params.path);
        // same guard as the file tools (also keeps screenshots out of .polpo)
        assertPathAllowed(target, resolveAllowedPaths(cwd, allowedPaths), "browser_screenshot");
        args.push(target);
      }
      if (params.full_page) args.push("--full");
      const result = await exec(args, { signal, saves: target });
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

function createBrowserGetTool(exec: BrowserExec): AgentTool<typeof BrowserGetSchema> {
  return {
    name: "browser_get",
    label: "Browser Get Info",
    description: "Get information from the browser: element text/html/value, page title, or current URL.",
    parameters: BrowserGetSchema,
    async execute(_id, params, signal) {
      const args = ["get", params.what];
      if (params.selector) args.push(params.selector);
      const result = await exec(args, { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_select ───

const BrowserSelectSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector for the <select> element" }),
  value: Type.String({ description: "Option value to select" }),
});

function createBrowserSelectTool(exec: BrowserExec): AgentTool<typeof BrowserSelectSchema> {
  return {
    name: "browser_select",
    label: "Browser Select",
    description: "Select an option from a dropdown <select> element.",
    parameters: BrowserSelectSchema,
    async execute(_id, params, signal) {
      const result = await exec(["select", params.selector, params.value], { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_hover ───

const BrowserHoverSchema = Type.Object({
  selector: Type.String({ description: "Element ref or CSS selector to hover" }),
});

function createBrowserHoverTool(exec: BrowserExec): AgentTool<typeof BrowserHoverSchema> {
  return {
    name: "browser_hover",
    label: "Browser Hover",
    description: "Hover over an element to trigger hover states, tooltips, or dropdown menus.",
    parameters: BrowserHoverSchema,
    async execute(_id, params, signal) {
      const result = await exec(["hover", params.selector], { signal });
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

function createBrowserScrollTool(exec: BrowserExec): AgentTool<typeof BrowserScrollSchema> {
  return {
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the page in a direction. Useful for loading lazy content or navigating long pages.",
    parameters: BrowserScrollSchema,
    async execute(_id, params, signal) {
      const args = ["scroll", params.direction];
      if (params.pixels) args.push(String(params.pixels));
      const result = await exec(args, { signal });
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

function createBrowserWaitTool(exec: BrowserExec): AgentTool<typeof BrowserWaitSchema> {
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
      const result = await exec(args, { signal, timeout: 60_000 });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_eval ───

const BrowserEvalSchema = Type.Object({
  javascript: Type.String({ description: "JavaScript code to execute in the browser page context" }),
});

function createBrowserEvalTool(exec: BrowserExec): AgentTool<typeof BrowserEvalSchema> {
  return {
    name: "browser_eval",
    label: "Browser Evaluate JS",
    description: "Execute JavaScript in the browser page context and return the result. " +
      "Use for reading DOM properties, manipulating the page, or extracting data not available via snapshot.",
    parameters: BrowserEvalSchema,
    async execute(_id, params, signal) {
      // Use base64 encoding for safe transport of complex JS
      const b64 = Buffer.from(params.javascript).toString("base64");
      const result = await exec(["eval", b64, "-b"], { signal });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_close ───

const BrowserCloseSchema = Type.Object({});

function createBrowserCloseTool(exec: BrowserExec): AgentTool<typeof BrowserCloseSchema> {
  return {
    name: "browser_close",
    label: "Browser Close",
    description: "Close the browser session. Profile data (cookies, login) is saved automatically.",
    parameters: BrowserCloseSchema,
    async execute(_id, _params, signal) {
      const result = await exec(["close"], { signal, profile: false });
      return browserResult(result);
    },
  };
}

// ─── Tool: browser_back / browser_forward / browser_reload ───

const BrowserNavActionSchema = Type.Object({});

function createBrowserBackTool(exec: BrowserExec): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_back",
    label: "Browser Back",
    description: "Navigate back in browser history.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await exec(["back"], { signal }));
    },
  };
}

function createBrowserForwardTool(exec: BrowserExec): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_forward",
    label: "Browser Forward",
    description: "Navigate forward in browser history.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await exec(["forward"], { signal }));
    },
  };
}

function createBrowserReloadTool(exec: BrowserExec): AgentTool<typeof BrowserNavActionSchema> {
  return {
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page.",
    parameters: BrowserNavActionSchema,
    async execute(_id, _params, signal) {
      return browserResult(await exec(["reload"], { signal }));
    },
  };
}

const BrowserUserAgentSchema = Type.Object({
  userAgent: Type.String({ minLength: 1, maxLength: 512, description: "Exact User-Agent string to apply to the current browser session" }),
});

function createBrowserSetUserAgentTool(exec: BrowserExec): AgentTool<typeof BrowserUserAgentSchema> {
  return {
    name: "browser_set_user_agent",
    label: "Set Browser User-Agent",
    description: "Override the browser User-Agent for the current session and reload the active page. Use this to test mobile, desktop, crawler, or custom client behavior.",
    parameters: BrowserUserAgentSchema,
    async execute(_id, params, signal) {
      return browserResult(await exec(["--user-agent", params.userAgent, "reload"], { signal }));
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

function createBrowserTabsTool(exec: BrowserExec): AgentTool<typeof BrowserTabsSchema> {
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
          if (params.url) args.push(assertWebUrl(params.url, "browser_tabs"));
          break;
        case "switch":
          if (params.index !== undefined) args.push(String(params.index));
          break;
        case "close":
          args.push("close");
          if (params.index !== undefined) args.push(String(params.index));
          break;
      }
      const result = await exec(args, { signal });
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
  | "browser_reload" | "browser_tabs" | "browser_set_user_agent";

export const ALL_BROWSER_TOOL_NAMES: BrowserToolName[] = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_fill",
  "browser_type", "browser_press", "browser_screenshot", "browser_get",
  "browser_select", "browser_hover", "browser_scroll", "browser_wait",
  "browser_eval", "browser_close", "browser_back", "browser_forward",
  "browser_reload", "browser_tabs", "browser_set_user_agent",
];

/**
 * Enforce the sandbox network rule on the browser running here: refuse navigations it forbids,
 * run everything else behind the proxy. A browser in a remote sandbox follows the VM's network.
 */
function guardedByNetwork(tool: AgentTool<any>, network: BrowserNetworkGuard | undefined, inSandbox: () => Promise<boolean>): AgentTool<any> {
  if (!network) return tool;
  return {
    ...tool,
    async execute(id, params: any, signal, ...rest) {
      if (await inSandbox()) return tool.execute(id, params, signal, ...rest);
      if (tool.name === "browser_navigate") {
        const refusal = await network.checkUrl(String(params.url ?? ""));
        if (refusal) return { content: [{ type: "text", text: `Browser error: ${refusal}` }], details: { error: refusal } };
      }
      const proxy = await network.proxyUrl();
      return browserProxyContext.run({ proxy }, () => tool.execute(id, params, signal, ...rest));
    },
  };
}

/**
 * Create browser automation tools powered by agent-browser CLI.
 *
 * @param cwd - Working directory for resolving relative file paths (screenshots)
 * @param session - Browser session name for isolation (default: agent name or "default")
 * @param allowedTools - Optional filter: only include tools with these names
 * @param profileDir - Persistent browser profile directory. Passed as --profile to agent-browser.
 *                     Stores cookies, localStorage, auth state across sessions.
 *                     Typically `.polpo/browser-profiles/<agent>/`.
 * @param toolOutputDir - Where results above 50 KB are saved in full (default: resolveToolOutputDir()).
 * @param allowedPaths - Directories the agent may write to (screenshots), like the file tools; default [cwd].
 * @param network - The agent's sandbox network rule: navigations are checked against it and the browser runs behind the sandbox proxy.
 * @param runtime - Where the agent's tools act. With a `shell` into a remote sandbox (Daytona, E2B)
 *   agent-browser runs there, through the shell (sessions, profiles and screenshots stay in the VM).
 *   Otherwise it runs on this machine; screenshots are then saved through `fs` when one is given.
 */
export function createBrowserTools(
  cwd: string,
  session: string = "default",
  allowedTools?: string[],
  profileDir?: string,
  toolOutputDir: string = resolveToolOutputDir({ agentName: session }),
  allowedPaths?: string[],
  network?: BrowserNetworkGuard,
  runtime: { shell?: Shell; fs?: FileSystem } = {},
): AgentTool<any>[] {
  const { shell, fs } = runtime;
  const inSandbox = () => shellIsRemote(shell);
  const profileName = profileDir ? basename(profileDir).replace(/[^A-Za-z0-9._-]/g, "_") || "default" : undefined;
  const exec: BrowserExec = async (args, options = {}) => {
    const withProfile = options.profile !== false;
    if (shell && await inSandbox()) {
      return execSandboxBrowser(shell, args, { session, profileName: withProfile ? profileName : undefined, timeout: options.timeout, cwd, saves: options.saves });
    }
    const hostOptions = { session, profileDir: withProfile ? profileDir : undefined, signal: options.signal, timeout: options.timeout };
    // the browser runs here but the agent's files may not: save to a private file, then through fs
    if (options.saves && fs) {
      const target = options.saves;
      return withHostTempDir(async (dir) => {
        const hostPath = join(dir, basename(target) || "screenshot.png");
        const result = await execAgentBrowser(args.map((a) => (a === target ? hostPath : a)), hostOptions);
        if (!result.success) return result;
        await writeBytes(fs, target, await readFile(hostPath));
        const swap = (value: unknown): unknown => typeof value === "string" ? value.split(hostPath).join(target)
          : Array.isArray(value) ? value.map(swap)
          : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]))
          : value;
        return { ...result, data: swap(result.data), raw: result.raw.split(hostPath).join(target) };
      });
    }
    if (options.saves) await mkdir(dirname(options.saves), { recursive: true }).catch(() => undefined);
    return execAgentBrowser(args, hostOptions);
  };
  const factories: Record<BrowserToolName, () => AgentTool<any>> = {
    browser_navigate: () => createBrowserNavigateTool(exec),
    browser_snapshot: () => createBrowserSnapshotTool(exec),
    browser_click: () => createBrowserClickTool(exec),
    browser_fill: () => createBrowserFillTool(exec),
    browser_type: () => createBrowserTypeTool(exec),
    browser_press: () => createBrowserPressTool(exec),
    browser_screenshot: () => createBrowserScreenshotTool(exec, cwd, allowedPaths),
    browser_get: () => createBrowserGetTool(exec),
    browser_select: () => createBrowserSelectTool(exec),
    browser_hover: () => createBrowserHoverTool(exec),
    browser_scroll: () => createBrowserScrollTool(exec),
    browser_wait: () => createBrowserWaitTool(exec),
    browser_eval: () => createBrowserEvalTool(exec),
    browser_close: () => createBrowserCloseTool(exec),
    browser_back: () => createBrowserBackTool(exec),
    browser_forward: () => createBrowserForwardTool(exec),
    browser_reload: () => createBrowserReloadTool(exec),
    browser_tabs: () => createBrowserTabsTool(exec),
    browser_set_user_agent: () => createBrowserSetUserAgentTool(exec),
  };

  const names = allowedTools
    ? ALL_BROWSER_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_BROWSER_TOOL_NAMES;

  return names.map(n => withToolOutputOffload(guardedByNetwork(factories[n](), network, inSandbox), { dir: toolOutputDir, maxChars: MAX_OUTPUT_BYTES, fs }));
}
