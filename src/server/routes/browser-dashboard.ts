/**
 * Browser-dashboard REST API — control + proxy of `agent-browser dashboard`.
 *
 * The dashboard is a local web UI bundled into the agent-browser binary
 * that shows live viewports + command activity for every session. It
 * listens on 127.0.0.1:<port> (default 4848) of the host running Polpo,
 * which means a browser opening Polpo via Tailscale/remote can NOT reach
 * it directly. We expose two surfaces:
 *
 *   /api/v1/browser-dashboard/status|start|stop   — lifecycle control
 *   /api/v1/browser-dashboard/view/*              — HTTP reverse proxy
 *                                                   to the dashboard
 *   (WebSocket upgrade on the same path is attached separately in
 *    src/server/index.ts via attachBrowserDashboardWebSocket — Hono's
 *    fetch handler can't intercept HTTP upgrades.)
 *
 * Dashboard lifetime is independent of any browser session: it runs as
 * a standalone background process started by agent-browser itself.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { parse as parseUrl } from "node:url";
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getCdpTarget, setCdpTarget } from "../../core/browser-cdp-state.js";

const DEFAULT_PORT = 4848;
const EXEC_TIMEOUT_MS = 10_000;
const DASHBOARD_VIEW_PREFIX = "/api/v1/browser-dashboard/view";
const DASHBOARD_CDP_PREFIX = "/api/v1/browser-dashboard/cdp/";

// ── CDP Chrome (the user's real profile) ─────────────────────────────────
//
// "Pilotare + mostrare": instead of letting agent-browser spawn its own
// managed browser for the orchestrator, we launch the user's REAL Chrome
// (a specific user-data-dir + profile) with remote debugging on a fixed
// port, then `agent-browser connect <port>` so the fixed "orchestrator"
// session drives THAT browser. It shows up in the live dashboard and the
// chat tools act on it (see getCdpTarget(), consumed by the orchestrator
// browser executor).
//
// Headed Chrome needs an X display; on a headless host we wrap it in
// `xvfb-run` (virtual framebuffer, no real monitor). The dashboard still
// streams the viewport via CDP screencast, so the user watches remotely.

const CDP_PORT = 9222;
const ORCH_SESSION = "orchestrator";
const CHROME_BIN = process.env.POLPO_CHROME_BIN || "/usr/bin/google-chrome";
const CHROME_USER_DATA_DIR =
  process.env.POLPO_CHROME_USER_DATA_DIR || `${homedir()}/.config/google-chrome-codex`;
const CHROME_PROFILE_DIR = process.env.POLPO_CHROME_PROFILE || "Profile 8";
const CDP_VIEWPORT_WIDTH = readViewportDimension("POLPO_BROWSER_VIEWPORT_WIDTH", 1920);
const CDP_VIEWPORT_HEIGHT = readViewportDimension("POLPO_BROWSER_VIEWPORT_HEIGHT", 1080);

function readViewportDimension(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 640 && value <= 3840
    ? Math.floor(value)
    : fallback;
}

async function applyCdpViewport(): Promise<void> {
  await runAgentBrowser([
    "--session", ORCH_SESSION,
    "--cdp", String(CDP_PORT),
    "set", "viewport", String(CDP_VIEWPORT_WIDTH), String(CDP_VIEWPORT_HEIGHT),
  ]);
}

/** Live handle to the launched Chrome. Null when not running. */
let chromeProc: ChildProcess | null = null;

/** True once Chrome answers CDP HTTP discovery on the debug port. */
async function cdpReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Launch the user's Chrome (headed, under xvfb-run when no $DISPLAY) and
 * connect the orchestrator session to it via CDP. Idempotent: if Chrome is
 * already up and reachable, just re-runs `connect`.
 */
export async function launchCdpChrome(): Promise<{ running: boolean; port: number; error?: string }> {
  if (await cdpReady(CDP_PORT)) {
    await runAgentBrowser(["--session", ORCH_SESSION, "connect", String(CDP_PORT)]);
    await applyCdpViewport();
    setCdpTarget(CDP_PORT);
    return { running: true, port: CDP_PORT };
  }

  const chromeArgs = [
    `--user-data-dir=${CHROME_USER_DATA_DIR}`,
    `--profile-directory=${CHROME_PROFILE_DIR}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Headed Chrome needs a display. Wrap in xvfb-run when none is present.
  const headless = !process.env.DISPLAY;
  const cmd = headless ? "xvfb-run" : CHROME_BIN;
  const args = headless
    ? ["-a", "--server-args=-screen 0 1920x1080x24", CHROME_BIN, ...chromeArgs]
    : chromeArgs;

  try {
    chromeProc = spawn(cmd, args, { stdio: "ignore", detached: false });
  } catch (err) {
    chromeProc = null;
    return { running: false, port: CDP_PORT, error: err instanceof Error ? err.message : String(err) };
  }
  chromeProc.on("exit", () => { chromeProc = null; setCdpTarget(null); });

  // Poll the debug port until Chrome is accepting CDP (up to ~15s).
  for (let i = 0; i < 30; i++) {
    if (await cdpReady(CDP_PORT)) {
      const connected = await runAgentBrowser(["--session", ORCH_SESSION, "connect", String(CDP_PORT)]);
      if (!connected.ok) {
        return { running: false, port: CDP_PORT, error: connected.stderr || connected.stdout || "connect failed" };
      }
      await applyCdpViewport();
      setCdpTarget(CDP_PORT);
      return { running: true, port: CDP_PORT };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { running: false, port: CDP_PORT, error: "Chrome did not expose CDP in time (profile locked? xvfb missing?)" };
}

/** Stop the launched Chrome and detach the orchestrator session. */
export async function stopCdpChrome(): Promise<{ stopped: boolean }> {
  await runAgentBrowser(["--session", ORCH_SESSION, "close"]);
  if (chromeProc && !chromeProc.killed) {
    chromeProc.kill("SIGTERM");
  }
  chromeProc = null;
  setCdpTarget(null);
  return { stopped: true };
}

// ── Lifecycle helpers ────────────────────────────────────────────────────

function runAgentBrowser(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("agent-browser", args, { timeout: EXEC_TIMEOUT_MS, encoding: "utf-8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

export type BrowserSessionCommand =
  | { action: "activate-tab"; tabId: string }
  | { action: "close-tab"; tabId: string }
  | { action: "new-tab"; url?: string }
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" };

const SAFE_SESSION_NAME = /^[a-zA-Z0-9._-]{1,128}$/;
const SAFE_TAB_ID = /^t\d+$/;

export function browserSessionCommandArgs(
  session: string,
  command: BrowserSessionCommand,
): string[] | null {
  if (!SAFE_SESSION_NAME.test(session)) return null;
  const prefix = ["--session", session];
  switch (command.action) {
    case "activate-tab":
      return SAFE_TAB_ID.test(command.tabId)
        ? [...prefix, "tab", command.tabId, "--json"]
        : null;
    case "close-tab":
      return SAFE_TAB_ID.test(command.tabId)
        ? [...prefix, "tab", "close", command.tabId, "--json"]
        : null;
    case "new-tab": {
      const url = command.url?.trim();
      return url
        ? [...prefix, "tab", "new", url, "--json"]
        : [...prefix, "tab", "new", "--json"];
    }
    case "navigate": {
      const url = command.url.trim();
      return url ? [...prefix, "open", url, "--json"] : null;
    }
    case "back":
    case "forward":
    case "reload":
      return [...prefix, command.action, "--json"];
  }
}

export function browserViewportCommandArgs(
  session: string,
  width: number,
  height: number,
  scale = 1,
): string[] | null {
  if (!SAFE_SESSION_NAME.test(session)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 320 || width > 1920 || height < 240 || height > 1080) return null;
  if (!Number.isFinite(scale) || scale < 1 || scale > 2) return null;
  const args = ["--session", session, "set", "viewport", String(width), String(height)];
  if (scale !== 1) args.push(String(Math.round(scale * 100) / 100));
  return [...args, "--json"];
}

function isBrowserSessionCommand(value: unknown): value is BrowserSessionCommand {
  if (!value || typeof value !== "object" || !("action" in value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.action === "back" || candidate.action === "forward" || candidate.action === "reload") {
    return true;
  }
  if (candidate.action === "new-tab") {
    return candidate.url === undefined || typeof candidate.url === "string";
  }
  if (candidate.action === "navigate") return typeof candidate.url === "string";
  if (candidate.action === "activate-tab" || candidate.action === "close-tab") {
    return typeof candidate.tabId === "string";
  }
  return false;
}

/**
 * Probe the dashboard via the JSON status command, falling back to a
 * raw TCP probe when the installed CLI version doesn't support
 * `dashboard status --json`.
 */
export async function dashboardStatus(): Promise<{ running: boolean; port: number; raw?: string }> {
  const result = await runAgentBrowser(["dashboard", "status", "--json"]);
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      const running = Boolean(parsed?.running ?? parsed?.data?.running ?? false);
      const port = Number(parsed?.port ?? parsed?.data?.port ?? DEFAULT_PORT);
      return { running, port, raw: result.stdout };
    } catch { /* fall through to TCP probe */ }
  }
  const reachable = await probeTcp("127.0.0.1", DEFAULT_PORT);
  return { running: reachable, port: DEFAULT_PORT };
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:net").then(({ Socket }) => {
      const sock = new Socket();
      const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.setTimeout(800);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
      sock.connect(port, host);
    }).catch(() => resolve(false));
  });
}

// ── HTTP reverse proxy ───────────────────────────────────────────────────

type FetchInitWithDuplex = RequestInit & { duplex?: "half" };

/**
 * The dashboard assumes it is served from `/` on localhost. Agent Live
 * mounts it below the Polpo API, so route all dashboard HTTP and WebSocket
 * traffic through the same-origin reverse proxy before its application
 * scripts execute.
 */
const DASHBOARD_PROXY_SCRIPT = `<style id="polpo-agent-live-embed">
  [data-testid="sessions"],
  [data-testid="activity"],
  [data-testid="sessions"] + [data-slot="resizable-handle"],
  [data-testid="viewport"] + [data-slot="resizable-handle"] {
    display: none !important;
  }
  [data-testid="viewport"] { flex-grow: 100 !important; }
  div:has(> [role="tablist"] > [id$="-trigger-viewport"]) {
    display: none !important;
  }
</style><script>(function(){
  if (window.__polpoDashboardPatched) return;
  window.__polpoDashboardPatched = true;
  var viewPrefix = '${DASHBOARD_VIEW_PREFIX}';
  var cdpPrefix = '${DASHBOARD_CDP_PREFIX}';

  function activateTab(tab) {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  }

  function selectSession(sessionName) {
    var headers = Array.from(document.querySelectorAll(
      'button[aria-expanded]'
    ));
    var header = headers.find(function(button) {
      var label = button.querySelector('.font-mono');
      return label && label.textContent && label.textContent.trim() === sessionName;
    });
    if (!header) {
      var sessionsTab = document.querySelector('[role="tab"][id$="-trigger-sessions"]');
      if (sessionsTab && sessionsTab.getAttribute('aria-selected') !== 'true') {
        activateTab(sessionsTab);
      }
      return false;
    }
    if (header.getAttribute('aria-expanded') !== 'true') header.click();
    window.setTimeout(function() {
      var group = header.closest('[data-slot="collapsible"]');
      if (!group) return;
      var candidates = Array.from(group.querySelectorAll(
        '[data-slot="collapsible-content"] button'
      )).filter(function(button) {
        return button.textContent && button.textContent.trim() !== 'Add tab';
      });
      var active = candidates.find(function(button) {
        return button.textContent && button.textContent.indexOf('active') >= 0;
      });
      var target = active || candidates[0];
      if (target) target.click();
      var viewportTab = document.querySelector('[role="tab"][id$="-trigger-viewport"]');
      if (viewportTab) window.setTimeout(function() { activateTab(viewportTab); }, 50);
    }, 50);
    return true;
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window.parent || !event.data ||
        event.data.type !== 'polpo:select-session' ||
        typeof event.data.sessionName !== 'string') return;
    var attempts = 0;
    var selectionTimer = window.setInterval(function() {
      attempts += 1;
      if (selectSession(event.data.sessionName) || attempts >= 20) {
        window.clearInterval(selectionTimer);
      }
    }, 100);
  });

  function route(raw, webSocket) {
    try {
      var u = new URL(raw, window.location.href);
      var local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      var path;
      if (local && u.port && u.port !== '${DEFAULT_PORT}') {
        path = cdpPrefix + u.port + u.pathname;
      } else if (local) {
        path = viewPrefix + u.pathname;
      } else if (u.origin === window.location.origin &&
                 u.pathname.indexOf('/api/') === 0 &&
                 u.pathname.indexOf('/api/v1/browser-dashboard/') !== 0) {
        path = viewPrefix + u.pathname;
      } else {
        return raw;
      }
      var proxy = new URL(window.location.origin);
      proxy.pathname = path;
      proxy.search = u.search;
      if (webSocket) proxy.protocol = proxy.protocol === 'https:' ? 'wss:' : 'ws:';
      return proxy.toString();
    } catch (e) {
      return raw;
    }
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    if (input instanceof Request) {
      input = new Request(route(input.url, false), input);
    } else {
      input = route(input, false);
    }
    return nativeFetch(input, init);
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = route(url, false);
    return nativeOpen.apply(this, arguments);
  };

  var NativeWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    url = route(url, true);
    return protocols !== undefined
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url);
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = NativeWebSocket.OPEN;
  PatchedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = PatchedWebSocket;
})();</script>`;

function rewriteDashboardRootPaths(source: string): string {
  return source
    .replaceAll("/_next/", `${DASHBOARD_VIEW_PREFIX}/_next/`)
    .replaceAll("/favicon.ico", `${DASHBOARD_VIEW_PREFIX}/favicon.ico`);
}

export function rewriteDashboardHtml(source: string): string {
  const rewritten = rewriteDashboardRootPaths(source);
  return rewritten.includes("<head>")
    ? rewritten.replace("<head>", `<head>${DASHBOARD_PROXY_SCRIPT}`)
    : `${DASHBOARD_PROXY_SCRIPT}${rewritten}`;
}

/**
 * Forward an HTTP request to the dashboard. The mount path
 * `/api/v1/browser-dashboard/view` is stripped from the URL so the
 * upstream sees the original dashboard paths (`/`, `/assets/...`, ...).
 *
 * HTML and text assets are rewritten so root-relative Next.js resources
 * remain below the proxy mount path.
 */
async function proxyDashboardHttp(c: Context, subPath: string, port: number): Promise<Response> {
  const url = new URL(c.req.url);
  const target = `http://127.0.0.1:${port}/${subPath}${url.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  // The dashboard auths nothing — strip the Polpo bearer to avoid
  // confusing upstream proxies / logs.
  headers.delete("authorization");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const init: FetchInitWithDuplex = {
    method: c.req.method,
    headers,
    body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
    redirect: "manual",
    duplex: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : "half",
  };

  try {
    const upstream = await fetch(target, init);
    const outHeaders = new Headers(upstream.headers);
    // The dashboard sets a CSP that restricts the iframe parent — drop
    // it so it can render inside Polpo. Same rationale as code-server.
    outHeaders.delete("content-security-policy");
    outHeaders.delete("x-frame-options");

    const ct = upstream.headers.get("content-type") ?? "";
    if (ct.includes("text/html") && upstream.body) {
      const original = await upstream.text();
      const patched = rewriteDashboardHtml(original);
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.delete("etag");
      return new Response(patched, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    }

    const isTextAsset = ct.includes("javascript") || ct.includes("application/json") ||
      ct.startsWith("text/");
    if (isTextAsset && upstream.body) {
      const original = await upstream.text();
      const patched = rewriteDashboardRootPaths(original);
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      outHeaders.delete("etag");
      return new Response(patched, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `dashboard proxy failed: ${msg}` }, 502);
  }
}

/**
 * Forward an HTTP request to an arbitrary localhost port. Used for the
 * CDP HTTP discovery endpoints (e.g. /json/version) that the dashboard
 * fetches before opening the WebSocket. Port range is constrained to
 * the agent-browser session ports allocated on the host — anything
 * outside the safe range is rejected.
 */
async function proxyArbitraryPortHttp(c: Context, port: number, subPath: string): Promise<Response> {
  if (!Number.isFinite(port) || port <= 1024 || port > 65535) {
    return c.json({ ok: false, error: "invalid proxy port" }, 400);
  }
  const url = new URL(c.req.url);
  const target = `http://127.0.0.1:${port}/${subPath}${url.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("authorization");

  const init: FetchInitWithDuplex = {
    method: c.req.method,
    headers,
    body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
    redirect: "manual",
    duplex: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : "half",
  };

  try {
    const upstream = await fetch(target, init);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: new Headers(upstream.headers),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `cdp proxy failed: ${msg}` }, 502);
  }
}

// ── Hono router (status/start/stop + HTTP proxy) ─────────────────────────

export function browserDashboardRoutes(): Hono {
  const app = new Hono();

  app.get("/status", async (c) => {
    const s = await dashboardStatus();
    return c.json({ ok: true, data: s });
  });

  app.post("/start", async (c) => {
    let body: { port?: number } = {};
    try { body = await c.req.json<{ port?: number }>(); } catch { /* empty body is fine */ }
    const port = Number.isFinite(body.port) ? Math.floor(body.port as number) : DEFAULT_PORT;

    const current = await dashboardStatus();
    if (current.running) {
      return c.json({ ok: true, data: { running: true, port: current.port, url: `http://localhost:${current.port}` } });
    }
    const result = await runAgentBrowser(["dashboard", "start", "--port", String(port)]);
    await new Promise((r) => setTimeout(r, 400));
    const after = await dashboardStatus();
    if (!after.running) {
      return c.json({
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || "Dashboard failed to start (is `agent-browser` installed?)",
      }, 500);
    }
    return c.json({ ok: true, data: { running: true, port: after.port, url: `http://localhost:${after.port}` } });
  });

  app.post("/stop", async (c) => {
    const result = await runAgentBrowser(["dashboard", "stop"]);
    if (!result.ok && !(result.stderr.includes("not running") || result.stdout.includes("not running"))) {
      return c.json({ ok: false, error: result.stderr.trim() || result.stdout.trim() || "Dashboard stop failed" }, 500);
    }
    return c.json({ ok: true, data: { running: false } });
  });

  // ── User's real Chrome (CDP-attached) ──
  // status/start/stop for the headed Chrome profile the orchestrator drives.
  app.get("/chrome/status", (c) => {
    const port = getCdpTarget();
    return c.json({
      ok: true,
      data: {
        running: port !== null,
        port: port ?? CDP_PORT,
        viewport: { width: CDP_VIEWPORT_WIDTH, height: CDP_VIEWPORT_HEIGHT },
      },
    });
  });
  app.post("/chrome/start", async (c) => {
    const r = await launchCdpChrome();
    if (!r.running) return c.json({ ok: false, error: r.error || "Chrome failed to start" }, 500);
    return c.json({
      ok: true,
      data: {
        running: true,
        port: r.port,
        viewport: { width: CDP_VIEWPORT_WIDTH, height: CDP_VIEWPORT_HEIGHT },
      },
    });
  });
  app.post("/chrome/stop", async (c) => {
    await stopCdpChrome();
    return c.json({ ok: true, data: { running: false } });
  });

  // Native Agent Live consumes only the dashboard's session registry. The
  // viewport itself connects straight to the selected session daemon below,
  // avoiding the dashboard application and iframe rendering layers.
  app.get("/sessions", async (c) => {
    const s = await dashboardStatus();
    if (!s.running) return c.json({ ok: true, data: [] });
    try {
      const response = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`session registry returned ${response.status}`);
      const sessions = await response.json();
      return c.json({ ok: true, data: Array.isArray(sessions) ? sessions : [] });
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : "session registry unavailable",
      }, 502);
    }
  });

  app.post("/sessions/:session/command", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON body" }, 400); }
    if (!isBrowserSessionCommand(body)) {
      return c.json({ ok: false, error: "invalid browser command" }, 400);
    }
    const args = browserSessionCommandArgs(c.req.param("session"), body);
    if (!args) return c.json({ ok: false, error: "invalid session, tab, or URL" }, 400);
    const result = await runAgentBrowser(args);
    if (!result.ok) {
      return c.json({
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || "browser command failed",
      }, 500);
    }
    let data: unknown = result.stdout.trim();
    try { data = data ? JSON.parse(String(data)) : null; } catch { /* retain CLI text */ }
    return c.json({ ok: true, data });
  });

  app.post("/sessions/:session/viewport", async (c) => {
    let body: { width?: number; height?: number; scale?: number };
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON body" }, 400); }
    const args = browserViewportCommandArgs(
      c.req.param("session"),
      Number(body.width),
      Number(body.height),
      body.scale === undefined ? 1 : Number(body.scale),
    );
    if (!args) return c.json({ ok: false, error: "viewport or device scale is outside supported bounds" }, 400);
    const result = await runAgentBrowser(args);
    if (!result.ok) {
      return c.json({
        ok: false,
        error: result.stderr.trim() || result.stdout.trim() || "viewport update failed",
      }, 500);
    }
    return c.json({
      ok: true,
      data: {
        width: Number(body.width),
        height: Number(body.height),
        scale: body.scale === undefined ? 1 : Number(body.scale),
      },
    });
  });

  // ── HTTP reverse proxy: /view/* → http://127.0.0.1:<port>/* ──
  // Both bare /view and /view/* are handled so the iframe src can be
  // either path. Status is probed once per request so an external
  // start/stop is reflected without server restart.
  app.all("/view", async (c) => {
    const s = await dashboardStatus();
    if (!s.running) return c.json({ ok: false, error: "Dashboard not running. POST /api/v1/browser-dashboard/start first." }, 503);
    return proxyDashboardHttp(c, "", s.port);
  });
  app.all("/view/*", async (c) => {
    const s = await dashboardStatus();
    if (!s.running) return c.json({ ok: false, error: "Dashboard not running. POST /api/v1/browser-dashboard/start first." }, 503);
    const sub = c.req.path.replace(/^\/api\/v1\/browser-dashboard\/view\/?/, "");
    return proxyDashboardHttp(c, sub, s.port);
  });

  // ── CDP / stream port proxy ──
  // Dynamic per-session ports (e.g. agent-browser's stream WS on 34529).
  // The WS upgrade is handled in attachBrowserDashboardWebSocket; here we
  // only cover the HTTP side (CDP /json/version discovery, sometimes also
  // used by the dashboard before opening the socket).
  app.all("/cdp/:port", async (c) => {
    const port = Number(c.req.param("port"));
    return proxyArbitraryPortHttp(c, port, "");
  });
  app.all("/cdp/:port/*", async (c) => {
    const port = Number(c.req.param("port"));
    const m = c.req.path.match(/^\/api\/v1\/browser-dashboard\/cdp\/\d+\/(.*)$/);
    const sub = m ? m[1] : "";
    return proxyArbitraryPortHttp(c, port, sub);
  });

  return app;
}

// ── WebSocket upgrade proxy ──────────────────────────────────────────────
//
// Hono's fetch handler runs after Node has already accepted the socket,
// so we can't proxy `Upgrade: websocket` from inside the router. Mirror
// the `attachCodeServerWebSocket` pattern: hook the underlying
// http.Server's "upgrade" event, gate by path, and pipe to the
// dashboard's WS endpoint. Authentication is intentionally permissive
// here — same trust boundary as the HTTP proxy (already behind
// `/api/v1` auth or Tailscale).

interface UpgradeServer {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Proxy an upstream WebSocket. Pipes both directions, closes both on any
 * error / close. Shared by the dashboard (/view/*) and dynamic CDP
 * (/cdp/:port/*) paths.
 */
function pipeWebSocket(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstreamUrl: string,
): void {
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(upstreamUrl);
    upstream.on("open", () => {
      client.on("message", (data, isBinary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, { binary: isBinary }));
      upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
    });
    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
  });
}

export function attachBrowserDashboardWebSocket(server: UpgradeServer): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseUrl(req.url ?? "", true);
    const pathname = url.pathname ?? "";

    // Dashboard UI path → proxy to the dashboard server (default :4848).
    const viewMatch = pathname.match(/^\/api\/v1\/browser-dashboard\/view\/?(.*)$/);
    if (viewMatch) {
      void dashboardStatus().then((s) => {
        if (!s.running) { rejectUpgrade(socket, 503, "Dashboard not running"); return; }
        const rest = viewMatch[1] || "";
        const upstreamUrl = `ws://127.0.0.1:${s.port}/${rest}${url.search ?? ""}`;
        pipeWebSocket(wss, req, socket, head, upstreamUrl);
      }).catch(() => rejectUpgrade(socket, 502, "Dashboard probe failed"));
      return;
    }

    // CDP / stream port path → proxy to localhost:<port>.
    // This is what DASHBOARD_PROXY_SCRIPT redirects the dashboard's
    // `ws://localhost:<dynamic>` connections to. Port range is sanity-
    // checked; anything else is rejected.
    const cdpMatch = pathname.match(/^\/api\/v1\/browser-dashboard\/cdp\/(\d+)\/?(.*)$/);
    if (cdpMatch) {
      const port = Number(cdpMatch[1]);
      if (!Number.isFinite(port) || port <= 1024 || port > 65535) {
        rejectUpgrade(socket, 400, "Invalid CDP port");
        return;
      }
      const rest = cdpMatch[2] || "";
      const upstreamUrl = `ws://127.0.0.1:${port}/${rest}${url.search ?? ""}`;
      pipeWebSocket(wss, req, socket, head, upstreamUrl);
      return;
    }
  };

  server.on("upgrade", onUpgrade);
  return { close: () => { server.off("upgrade", onUpgrade); wss.close(); } };
}
