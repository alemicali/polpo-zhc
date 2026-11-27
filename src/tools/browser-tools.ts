/**
 * Browser automation tools powered by agent-browser.
 *
 * Uses the agent-browser CLI (https://github.com/vercel-labs/agent-browser)
 * with --json output for structured results. Where it runs follows the agent's sandbox:
 *   - remote sandbox (Daytona, E2B): through the workspace shell, inside the VM (the runner
 *     image ships agent-browser + Google Chrome; otherwise they are installed on first use). There
 *     the browser is headed by default, on the computer's desktop (agent.browserHeaded: false: headless);
 *   - this machine (no sandbox, bubblewrap, docker): as a child process, behind the sandbox
 *     network proxy (browser-network-guard.ts). Headed only with agent.browserHeaded: true.
 *
 * The browser is always real Google Chrome (agent-chrome.ts), never Chromium: sites flag Chromium
 * as a bot. A server without Chrome gets a clear error, not a Chromium fallback.
 *
 * The agent-browser CLI manages a daemon process that keeps the browser alive
 * between commands, making sequential tool calls fast (no cold-start per command).
 *
 * Requires `agent-browser` in PATH (`npm install -g agent-browser`) and Google Chrome.
 *
 * Session isolation: Each agent gets its own browser session via --session flag,
 * preventing cross-agent interference when multiple agents use browser tools.
 */

import { execFileSync, spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import { withHostTempDir, writeBytes } from "./tool-fs.js";
import { assertWebUrl } from "./browser-url-guard.js";
import { assertPathAllowed, resolveAllowedPaths } from "./path-sandbox.js";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveToolOutputDir, withToolOutputOffload } from "./tool-output.js";
import { browserProxyContext, proxyArgs, type BrowserNetworkGuard } from "./browser-network-guard.js";
import type { ResolvedVault } from "../vault/index.js";
import { createSecretMasker, formatVaultRef, resolveEnvFromVault } from "../vault/env-from-vault.js";
import { decideEgress, decideRemoteEgress, shellHost, type BrowserEgressConfig } from "./browser-egress.js";
import { DESKTOP_DISPLAY, DESKTOP_DISPLAY_COMMAND, ensureDesktopDisplay } from "../sandbox/desktop.js";
import { waitForAgentControl, type ComputerControlStore } from "../sandbox/computer-control.js";
import { hostChromeArgs, SANDBOX_CHROME_FLAGS, SANDBOX_CHROME_INSTALL_COMMAND } from "./agent-chrome.js";

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
    /** Headed: a visible window on this X display (agent.browserHeaded). */
    display?: string;
    /** The browser agent-browser launches (Google Chrome, agent-chrome.ts); ignored when attached over CDP. */
    executablePath?: string;
  } = {},
): Promise<{ success: boolean; data?: any; error?: string; raw: string }> {
  return new Promise((resolve) => {
    const sessionArgs = [...(options.session ? ["--session", options.session] : []), ...(options.display && !options.cdp ? ["--headed"] : [])];
    // When attaching to an external Chrome via CDP, --profile is meaningless
    // (that Chrome already owns its user-data-dir) so it's dropped.
    const cdpArgs = options.cdp ? ["--cdp", String(options.cdp)] : [];
    const profileArgs = options.cdp || !options.profileDir ? [] : ["--profile", options.profileDir];
    const chromeArgs = options.cdp || !options.executablePath ? [] : ["--executable-path", options.executablePath];
    const fullArgs = [...sessionArgs, ...cdpArgs, ...chromeArgs, ...profileArgs, ...(options.cdp ? [] : proxyArgs(options.proxy)), ...args, "--json"];

    const child = spawnChild("agent-browser", fullArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.display && !options.cdp ? { env: { ...process.env, DISPLAY: options.display } } : {}),
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

/**
 * Commands that never launch a browser: they run without Google Chrome (closing a session works
 * on a server whose Chrome was removed).
 */
const NO_LAUNCH_COMMANDS = new Set(["close", "session"]);

/**
 * agent-browser on this server with Google Chrome (`--executable-path`): an error result, not a
 * Chromium fallback, when Chrome is not installed. Exported for tests and Polpo's own browser.
 */
export function execChromeBrowserAsync(args: string[], options: Parameters<typeof execBrowserAsync>[1] = {}): ReturnType<typeof execBrowserAsync> {
  if (options.cdp || NO_LAUNCH_COMMANDS.has(args[0] ?? "")) return execBrowserAsync(args, options);
  const chrome = hostChromeArgs();
  if (!chrome.ok) {
    return Promise.resolve({ success: false, error: chrome.error, raw: chrome.error });
  }
  return execBrowserAsync(args, { ...options, executablePath: chrome.path });
}

/** Agent-side CLI call: the raw output is kept whole so large results can be offloaded, not lost. */
function execAgentBrowser(
  args: string[],
  options: { session?: string; profileDir?: string; timeout?: number; cwd?: string; signal?: AbortSignal; display?: string } = {},
): ReturnType<typeof execBrowserAsync> {
  return execChromeBrowserAsync(args, { ...options, proxy: browserProxyContext.getStore()?.proxy, maxOutputBytes: Infinity });
}

type BrowserCallResult = { success: boolean; data?: any; error?: string; raw: string };

/**
 * One agent-browser call, wherever the browser runs. `profile: false` leaves the persistent
 * profile out (close); `saves` is the file the command writes (screenshots), already checked
 * against the allowed paths.
 */
export type BrowserExec = (args: string[], options?: {
  signal?: AbortSignal; timeout?: number; profile?: boolean; saves?: string;
  /** A secret for one argument (the arg equal to BROWSER_SECRET_ARG): never in a command line that is logged. */
  secret?: string;
}) => Promise<BrowserCallResult>;

/** Stands for the secret among an exec's args; on the host it becomes the value, in a sandbox an environment variable. */
export const BROWSER_SECRET_ARG = "\u0000polpo-secret\u0000";
const BROWSER_SECRET_ENV = "POLPO_BROWSER_SECRET";

/** Quote an argument for a POSIX shell command line. */
function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Where agent profiles live inside a sandbox VM (persistent across runs on a reused VM). */
export const SANDBOX_BROWSER_PROFILES = ".polpo/browser-profiles";

/** The agent-browser command line run in a sandbox (exported for tests). */
export function sandboxBrowserCommand(args: string[], options: { session?: string; profileName?: string; proxy?: string; headed?: boolean } = {}): string {
  // headed: a window on the computer's virtual display (started first when it is not up; its
  // failure leaves agent-browser to say there is no display). Always Google Chrome (--no-sandbox as root).
  // (a command that never launches a browser, like close, needs neither)
  const launches = !NO_LAUNCH_COMMANDS.has(args[0] ?? "");
  const parts = options.headed && launches
    ? [`(${DESKTOP_DISPLAY_COMMAND}) >/dev/null 2>&1;`, `DISPLAY=${DESKTOP_DISPLAY}`, "agent-browser", "--headed", SANDBOX_CHROME_FLAGS]
    : launches ? ["agent-browser", SANDBOX_CHROME_FLAGS] : ["agent-browser"];
  if (options.session) parts.push("--session", shq(options.session));
  // the profile lives in the VM user's home: the host path means nothing there
  if (options.profileName) parts.push("--profile", `"$HOME"/${shq(`${SANDBOX_BROWSER_PROFILES}/${options.profileName}`)}`);
  // the egress proxy inside the VM (the tailnet forwarder, see sandbox/tailnet-egress.ts)
  for (const a of proxyArgs(options.proxy)) parts.push(shq(a));
  // a secret comes from the command's environment, so the command line (which sandboxes log) never holds it
  for (const a of args) parts.push(a === BROWSER_SECRET_ARG ? `"$${BROWSER_SECRET_ENV}"` : shq(a));
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

/** True when agent-browser and Google Chrome are there (never Chromium: sites flag it as a bot). */
export const AGENT_BROWSER_CHECK_COMMAND = "command -v agent-browser >/dev/null && command -v google-chrome >/dev/null";

/**
 * Installs what is missing in a VM without the runner image: the CLI (global npm, with sudo when
 * needed) and Google Chrome (Google's .deb with apt-get, which brings its libraries: only when
 * `command -v google-chrome` fails).
 */
export const AGENT_BROWSER_INSTALL_COMMAND =
  "(command -v agent-browser >/dev/null || npm i -g agent-browser >/dev/null 2>&1 || sudo -n npm i -g agent-browser >/dev/null 2>&1)" +
  " && command -v agent-browser >/dev/null" +
  ` && (${SANDBOX_CHROME_INSTALL_COMMAND})`;

const browserReady = new WeakMap<Shell, Promise<string | undefined>>();

/**
 * agent-browser and Google Chrome in the sandbox: present in the runner image; otherwise installed
 * on first use (once per shell). Resolves to an error message when they cannot be made available.
 */
export function ensureSandboxBrowser(shell: Shell): Promise<string | undefined> {
  let ready = browserReady.get(shell);
  if (!ready) {
    ready = (async () => {
      const found = await shell.execute(AGENT_BROWSER_CHECK_COMMAND, { timeout: 20_000 }).catch(() => undefined);
      if (found?.exitCode === 0) return undefined;
      const installed = await shell.execute(AGENT_BROWSER_INSTALL_COMMAND, { timeout: 600_000 }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String(err?.message ?? err) }));
      if (installed.exitCode === 0) return undefined;
      return "agent-browser and Google Chrome are not both installed in the sandbox and could not be installed there " +
        `(${(installed.stderr || installed.stdout || `exit ${installed.exitCode}`).trim().slice(0, 300)}). ` +
        "Use the Polpo runner image for this provider (settings.sandbox.providers.<provider>.snapshot or .template).";
    })();
    browserReady.set(shell, ready);
    // a failed attempt is retried on the next call (the VM may have network by then)
    void ready.then((err) => { if (err) browserReady.delete(shell); });
  }
  return ready;
}

/** Shells whose computer has no display to offer: a default-headed browser runs headless there. */
const noDefaultDisplay = new WeakSet<Shell>();

/** Run agent-browser in the sandbox through its shell (the browser lives where the agent's files live). */
async function execSandboxBrowser(
  shell: Shell,
  args: string[],
  options: {
    session?: string; profileName?: string; timeout?: number; cwd?: string; saves?: string; secret?: string; proxy?: string;
    /** true: headed (the computer's desktop), an error without a display; "default": headed when the display can be had, else headless. */
    headed?: boolean | "default";
  },
): Promise<BrowserCallResult> {
  const missing = await ensureSandboxBrowser(shell);
  if (missing) return { success: false, error: missing, raw: missing };
  let headed = false;
  const launches = !NO_LAUNCH_COMMANDS.has(args[0] ?? "");
  if (launches && (options.headed === true || (options.headed === "default" && !noDefaultDisplay.has(shell)))) {
    const noDisplay = await ensureSandboxDisplay(shell);
    // an agent that asked for a headed browser is told; by default it runs headless (and the
    // display is not tried again on this shell)
    if (noDisplay && options.headed === true) return { success: false, error: noDisplay, raw: noDisplay };
    if (noDisplay) noDefaultDisplay.add(shell);
    headed = !noDisplay;
  }
  try {
    // agent-browser does not create the folder of the file it saves
    const mkdir = options.saves ? `mkdir -p ${shq(dirname(options.saves))} && ` : "";
    const env = options.secret !== undefined ? { env: { [BROWSER_SECRET_ENV]: options.secret } } : {};
    const result = await shell.execute(mkdir + sandboxBrowserCommand(args, { ...options, headed }), { cwd: options.cwd, timeout: options.timeout ?? DEFAULT_TIMEOUT, ...env });
    return parseShellBrowserResult(result);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return { success: false, error: message, raw: message };
  }
}

const displayReady = new WeakMap<Shell, Promise<string | undefined>>();

/**
 * The virtual display's packages in the sandbox (Xvfb, openbox): in the runner image (vm-4);
 * otherwise installed once per shell. Resolves to an error message when they cannot be.
 */
export function ensureSandboxDisplay(shell: Shell): Promise<string | undefined> {
  let ready = displayReady.get(shell);
  if (!ready) {
    ready = ensureDesktopDisplay({
      exec: async (command, o = {}) => {
        const r = await shell.execute(command, { timeout: o.timeoutMs ?? 30_000, ...(o.env ? { env: o.env } : {}) });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      },
    });
    displayReady.set(shell, ready);
    void ready.then((err) => { if (err) displayReady.delete(shell); });
  }
  return ready;
}

/** The X display a headed browser on this server opens on: $DISPLAY, else Polpo's virtual display. */
export async function hostBrowserDisplay(): Promise<string> {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  // Polpo's display is already up (the server's Browser Live, or an earlier run): share it, so a
  // task runner does not start a display of its own nobody watches
  if (existsSync("/tmp/.X11-unix/X99")) return ":99";
  const { ensureBrowserDisplay } = await import("../server/routes/browser-dashboard.js");
  return ensureBrowserDisplay();
}

/** agent-browser's CDP websocket (ws://127.0.0.1:PORT/devtools/browser/…) as the HTTP endpoint scripts use (/json/new…). */
export function cdpHttpUrl(wsUrl: string | undefined): string | undefined {
  if (!wsUrl) return undefined;
  try {
    const u = new URL(wsUrl);
    if (!/^(ws|wss|http|https):$/.test(u.protocol) || !u.port) return undefined;
    return `${u.protocol === "wss:" || u.protocol === "https:" ? "https" : "http"}://${u.hostname}:${u.port}`;
  } catch {
    return undefined;
  }
}

/** One shell command: the session's CDP URL when the session exists (never launches a browser). */
export function sandboxCdpUrlCommand(session: string): string {
  return `if agent-browser session list --json 2>/dev/null | grep -qF ${shq(JSON.stringify(session))}; then agent-browser --session ${shq(session)} get cdp-url --json 2>/dev/null; fi; true`;
}

function parseCdpUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw.trim()) as { data?: { cdpUrl?: unknown } };
    return typeof parsed?.data?.cdpUrl === "string" ? parsed.data.cdpUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The environment an agent's commands get for its own browser: POLPO_BROWSER_SESSION always,
 * CDP_URL (http://127.0.0.1:PORT) while its agent-browser session runs, so scripts drive the same
 * signed-in browser (/json/new, /json/list…), and DISPLAY when it is headed. Looked up per call and
 * never launching a browser: no session, no CDP_URL. Never fails a command (errors: what is known).
 */
export async function agentBrowserEnv(o: { session: string; shell?: Shell; /** agent.browserHeaded (unset: headed on a remote computer) */ headed?: boolean; remote?: boolean }): Promise<Record<string, string>> {
  const env: Record<string, string> = { POLPO_BROWSER_SESSION: o.session };
  try {
    let ws: string | undefined;
    if (o.remote && o.shell) {
      const r = await o.shell.execute(sandboxCdpUrlCommand(o.session), { timeout: 10_000 });
      ws = parseCdpUrl(r.stdout);
      if (effectiveBrowserHeaded(o.headed, true)) env.DISPLAY = DESKTOP_DISPLAY;
    } else {
      const list = await execBrowserAsync(["session", "list"], { timeout: 10_000 });
      const sessions = (list.data as { sessions?: unknown } | undefined)?.sessions;
      if (Array.isArray(sessions) && sessions.includes(o.session)) {
        const r = await execBrowserAsync(["get", "cdp-url"], { session: o.session, timeout: 10_000 });
        ws = typeof (r.data as { cdpUrl?: unknown } | undefined)?.cdpUrl === "string" ? (r.data as { cdpUrl: string }).cdpUrl : undefined;
      }
      if (effectiveBrowserHeaded(o.headed, false)) env.DISPLAY = await hostBrowserDisplay();
    }
    const http = cdpHttpUrl(ws);
    if (http) env.CDP_URL = http;
  } catch { /* what is known */ }
  return env;
}

/**
 * Whether an agent's browser is headed: on a remote computer (a desktop to show it on) unless
 * agent.browserHeaded is false; on this server only when it is true.
 */
export function effectiveBrowserHeaded(setting: boolean | undefined, remote: boolean): boolean {
  return remote ? setting !== false : setting === true;
}

/** What an agent's prompt says about its browser (Polpo's Chrome only, headed, CDP_URL, take control). */
export function browserPromptNote(o: { headed?: boolean; computer?: { id: string; name?: string }; takeover?: boolean; session?: string }): string {
  const session = o.session ? `'${o.session}'` : "\"$POLPO_BROWSER_SESSION\"";
  const lines = [
    "",
    "## Your browser",
    "- Use Polpo's browser only: the browser_* tools, or for scripts the same browser over CDP (below). It is real Google Chrome with your profile and sign-ins. "
      + "Never launch a browser of your own (no Playwright/Puppeteer launch(), no `chromium`/`google-chrome`/`npx playwright install`, no `agent-browser` without your session): "
      + "Chromium and headless browsers get flagged as bots by sites like Google Maps, Instagram and Facebook, and they have none of your sign-ins. "
      + "Scripts connect to $CDP_URL (Playwright connectOverCDP, Puppeteer connect({ browserURL }), a CDP client) instead of launching.",
    "- Your bash commands get CDP_URL (http://127.0.0.1:PORT) while your browser session is open: it is YOUR browser (the one browser_* drives, "
      + "with your profile and sign-ins). Scripts can drive it over CDP (GET $CDP_URL/json/list, PUT $CDP_URL/json/new?<url>), e.g. a skill's Python CDP client. "
      + `Open the browser first (browser_navigate) if CDP_URL is not set; in a shell without it, \`agent-browser --session ${session} get cdp-url\` gives ws://127.0.0.1:PORT/…, whose http://127.0.0.1:PORT is the same endpoint.`,
  ];
  if (o.headed) lines.push(`- Your browser is headed: its window is on ${o.computer ? `computer "${o.computer.name ?? o.computer.id}"'s` : "this server's"} virtual display (DISPLAY is set in your commands), which a person can watch live.`);
  if (o.takeover) {
    lines.push("- When a site needs a person (a login with their password, a 2FA code, a CAPTCHA, a consent only they can give), do not ask for the password or the code: "
      + "call request_computer_takeover with the reason, the page and what they should do. A person takes control of your computer's desktop, does it, and gives it back; "
      + "you never see what they type. Then continue from where the page is (browser_snapshot first). While a person has control, your browser tools wait.");
  }
  return lines.join("\n");
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
    description: "Open a URL in your browser (Polpo's real Google Chrome, with your profile and sign-ins). Launches it if not already running. "
      + "Always browse with these browser_* tools (or $CDP_URL from scripts): never launch a Chromium/Chrome/Playwright browser of your own.",
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
  text: Type.Optional(Type.String({ description: "Text to fill into the input" })),
  from_vault: Type.Optional(Type.String({
    description: "Fill a secret from your vault instead of text: \"service.key\", e.g. \"github.password\" (vault_list shows them). "
      + "The value goes into the field without ever being shown to you.",
  })),
});

function createBrowserFillTool(exec: BrowserExec, vault?: ResolvedVault): AgentTool<typeof BrowserFillSchema> {
  return {
    name: "browser_fill",
    label: "Browser Fill",
    description: "Clear an input field and type new text. Use refs from snapshot for targeting. "
      + "For a password, token or any credential, use from_vault (\"service.key\") instead of text: never copy secrets into text.",
    parameters: BrowserFillSchema,
    async execute(_id, params, signal) {
      const hasText = typeof params.text === "string";
      if (hasText === !!params.from_vault) {
        return browserResult({ success: false, error: "give either text or from_vault", raw: "" });
      }
      if (!params.from_vault) return browserResult(await exec(["fill", params.selector, params.text!], { signal }));
      const resolved = resolveEnvFromVault({ [`FILL`]: params.from_vault }, vault);
      if (resolved.errors.length > 0) {
        return browserResult({ success: false, error: `from_vault: ${resolved.errors.join("; ").replace(/^FILL: /, "")}`, raw: "" });
      }
      const secret = resolved.env.FILL!;
      const mask = createSecretMasker([secret]);
      const result = await exec(["fill", params.selector, BROWSER_SECRET_ARG], { signal, secret });
      const masked = { ...result, raw: mask(result.raw), ...(result.error ? { error: mask(result.error) } : {}),
        ...(result.data !== undefined ? { data: JSON.parse(mask(JSON.stringify(result.data))) } : {}) };
      if (!masked.success) return browserResult(masked);
      return { content: [{ type: "text", text: `Filled ${params.selector} with ${formatVaultRef(params.from_vault)} from the vault.` }], details: { from_vault: formatVaultRef(params.from_vault) } };
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
 * The proxy each agent-browser session was started with: a change needs a restart (the proxy is set
 * at launch). Keyed by where the browser runs ("host:" or "vm:") and the session.
 */
const sessionEgress = new Map<string, string | undefined>();

/** Forget the sessions' proxies (tests). */
export function resetBrowserEgressSessions(): void {
  sessionEgress.clear();
}

/**
 * The agent's egress proxy (a residential line, see browser-egress.ts): the browser runs behind it while
 * it is reachable, otherwise directly, or not at all for a profile signed in through it.
 * - On this server, a sandbox network rule takes precedence (its own proxy).
 * - In a remote computer's VM, the computer's egress goes through Tailscale there (egress.tailnet):
 *   the browser in the VM uses the tailnet forwarder. Without it, a browser in a VM goes out from the VM.
 */
function withEgress(
  tool: AgentTool<any>, egress: BrowserEgressConfig | undefined, network: BrowserNetworkGuard | undefined,
  inSandbox: () => Promise<boolean>, session: string, profileDir: string | undefined,
  remote: { host?: () => ReturnType<typeof shellHost> | undefined; profilePath?: string; close: () => Promise<unknown> },
): AgentTool<any> {
  if (!egress) return tool;
  return {
    ...tool,
    async execute(id, params: any, signal, ...rest) {
      const vm = await inSandbox();
      if (vm && !egress.tailnet) return tool.execute(id, params, signal, ...rest);
      if (!vm && (network || egress.tailnet)) return tool.execute(id, params, signal, ...rest);
      const host = vm ? remote.host?.() : undefined;
      if (vm && !host) return tool.execute(id, params, signal, ...rest);
      const decision = vm
        ? await decideRemoteEgress(egress as BrowserEgressConfig & { tailnet: NonNullable<BrowserEgressConfig["tailnet"]> }, host!, remote.profilePath)
        : await decideEgress(egress, profileDir);
      if (decision.refusal) return { content: [{ type: "text", text: `Browser error: ${decision.refusal}` }], details: { error: decision.refusal, egress: decision.label } };
      // the proxy is fixed when the browser starts: switching means a fresh browser on the same profile
      const key = `${vm ? "vm" : "host"}:${session}`;
      if (!sessionEgress.has(key) ? decision.proxy !== undefined : sessionEgress.get(key) !== decision.proxy) {
        if (tool.name !== "browser_close") {
          await (vm ? remote.close() : execAgentBrowser(["close"], { session, timeout: 15_000 })).catch(() => undefined);
        }
      }
      sessionEgress.set(key, decision.proxy);
      return decision.proxy
        ? browserProxyContext.run({ proxy: decision.proxy }, () => tool.execute(id, params, signal, ...rest))
        : tool.execute(id, params, signal, ...rest);
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
  runtime: {
    shell?: Shell; fs?: FileSystem; vault?: ResolvedVault; egress?: BrowserEgressConfig;
    /**
     * agent.browserHeaded: a visible window (the computer's virtual display, or this server's).
     * Unset: headed on a remote computer (when its display can be had), headless on this server.
     */
    headed?: boolean;
    /** The computer it runs on: while a person holds its desktop, the browser waits (computer-control.ts). */
    control?: { computerId: string; store: Pick<ComputerControlStore, "heldByPerson">; pollMs?: number; maxWaitMs?: number };
  } = {},
): AgentTool<any>[] {
  const { shell, fs, vault, egress, headed, control } = runtime;
  const inSandbox = () => shellIsRemote(shell);
  const profileName = profileDir ? basename(profileDir).replace(/[^A-Za-z0-9._-]/g, "_") || "default" : undefined;
  const exec: BrowserExec = async (args, options = {}) => {
    const withProfile = options.profile !== false;
    // a person holds the computer's desktop (take control): never act at the same time
    if (control) {
      const blocked = await waitForAgentControl(control.store, control.computerId, {
        ...(options.signal ? { signal: options.signal } : {}), ...(control.pollMs ? { pollMs: control.pollMs } : {}), ...(control.maxWaitMs !== undefined ? { maxWaitMs: control.maxWaitMs } : {}),
      });
      if (blocked) return { success: false, error: blocked, raw: blocked };
    }
    if (shell && await inSandbox()) {
      // a proxy here is the computer's egress (the tailnet forwarder in the VM); none: the VM's own network
      const proxy = browserProxyContext.getStore()?.proxy;
      // headed by default on a remote computer (its desktop); false: headless
      const sandboxHeaded = headed === undefined ? "default" as const : headed;
      return execSandboxBrowser(shell, args, { session, profileName: withProfile ? profileName : undefined, timeout: options.timeout, cwd, saves: options.saves, secret: options.secret, ...(proxy ? { proxy } : {}), headed: sandboxHeaded });
    }
    // on the host the arguments go straight to the process (no shell, no log)
    if (options.secret !== undefined) args = args.map((a) => (a === BROWSER_SECRET_ARG ? options.secret! : a));
    const display = headed === true ? await hostBrowserDisplay().catch(() => undefined) : undefined;
    const hostOptions = { session, profileDir: withProfile ? profileDir : undefined, signal: options.signal, timeout: options.timeout, ...(display ? { display } : {}) };
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
    browser_fill: () => createBrowserFillTool(exec, vault),
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

  // the VM side of the egress: one host per toolset (its tailnet checks are cached per computer)
  let host: ReturnType<typeof shellHost> | undefined;
  const remote = {
    host: () => (shell ? (host ??= shellHost(shell, fs)) : undefined),
    profilePath: profileName ? `${SANDBOX_BROWSER_PROFILES}/${profileName}` : undefined,
    close: () => exec(["close"], { profile: false, timeout: 15_000 }),
  };
  return names.map(n => withToolOutputOffload(
    withEgress(guardedByNetwork(factories[n](), network, inSandbox), egress, network, inSandbox, session, profileDir, remote),
    { dir: toolOutputDir, maxChars: MAX_OUTPUT_BYTES, fs },
  ));
}
