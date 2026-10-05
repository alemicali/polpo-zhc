import { execFile } from "node:child_process";
import { readFile, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { chromium, type Browser, type Page } from "playwright-core";
import type { CodingSessionState, CodingSessionStore } from "../../core/coding-session-store.js";
import type { CodeServerManager, CodeServerTheme } from "../code-server.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const POLPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INSPECTION_IDLE_MS = 30_000;
const RESOLUTION_CACHE_MS = 5_000;

interface InspectionSession {
  browser: Browser;
  page: Page;
  expiry?: ReturnType<typeof setTimeout>;
}

const inspectionSessions = new Map<string, Promise<InspectionSession>>();
const previewResolutionCache = new Map<string, { localOrigin: string; expiresAt: number }>();

export interface AppPreviewTarget {
  port: number;
  url: string;
  label: string;
  infrastructure: boolean;
  cwd?: string;
}

interface AppPreviewRouteDeps {
  codingSessionStore: CodingSessionStore;
  codeServerManager?: CodeServerManager;
  agentWorkDir: string;
}

interface ConfiguredTarget {
  port: number;
  localPort: number;
  url: string;
}

interface LocalListener {
  port: number;
  pid?: number;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

export function extractServeTargets(value: unknown): ConfiguredTarget[] {
  const web = (value as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> })?.Web;
  if (!web || typeof web !== "object") return [];

  const targets: ConfiguredTarget[] = [];
  for (const [authority, config] of Object.entries(web)) {
    const proxy = config?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string") continue;
    try {
      const local = new URL(proxy);
      if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(local.hostname)) continue;
      const localPort = parsePort(local.port);
      const publicUrl = new URL(`https://${authority}`);
      const port = parsePort(publicUrl.port) ?? 443;
      if (!localPort) continue;
      targets.push({ port, localPort, url: `${publicUrl.origin}/` });
    } catch {
      // Ignore malformed or non-HTTP proxy entries from unrelated Serve rules.
    }
  }
  return targets.sort((a, b) => a.port - b.port);
}

export function parseLocalListeners(output: string): LocalListener[] {
  const listeners = new Map<number, LocalListener>();
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    const localAddress = columns[3];
    if (!localAddress) continue;
    const match = localAddress.match(/:(\d+)$/);
    if (!match) continue;
    const address = localAddress.slice(0, -match[0].length);
    const isLocal = address === "127.0.0.1"
      || address === "0.0.0.0"
      || address === "localhost"
      || address === "*"
      || address === "[::]"
      || address === "[::1]";
    if (!isLocal) continue;
    const port = Number(match[1]);
    const pidMatch = line.match(/pid=(\d+)/);
    listeners.set(port, { port, pid: pidMatch ? Number(pidMatch[1]) : undefined });
  }
  return [...listeners.values()];
}

function processLabel(command: string, infrastructure: boolean): string {
  const normalized = command.toLowerCase();
  if (infrastructure && normalized.includes("vite")) return "Polpo UI";
  if (infrastructure) return "Polpo API";
  if (normalized.includes("next-server") || normalized.includes("next start") || normalized.includes("next dev")) return "Next.js";
  if (normalized.includes("vite")) return "Vite";
  if (normalized.includes("nuxt")) return "Nuxt";
  if (normalized.includes("python") || normalized.includes("uvicorn") || normalized.includes("gunicorn")) return "Python server";
  if (normalized.includes("node")) return "Node.js";
  return "Local service";
}

async function describeListener(listener: LocalListener): Promise<{ label: string; infrastructure: boolean; cwd?: string }> {
  if (!listener.pid) return { label: "Local service", infrastructure: false };
  try {
    const [rawCommand, cwd] = await Promise.all([
      readFile(`/proc/${listener.pid}/cmdline`, "utf8"),
      readlink(`/proc/${listener.pid}/cwd`).catch(() => ""),
    ]);
    const command = rawCommand.replaceAll("\0", " ");
    const normalized = command.toLowerCase();
    const infrastructure = normalized.includes("dist/cli/index.js serve")
      || (cwd.startsWith(`${POLPO_ROOT}/ui`) && normalized.includes("vite"));
    return { label: processLabel(command, infrastructure), infrastructure, ...(cwd ? { cwd } : {}) };
  } catch {
    return { label: "Local service", infrastructure: false };
  }
}

async function command(name: string, args: string[]): Promise<string> {
  const result = await execFileAsync(name, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

async function resolveLocalPreviewUrl(rawUrl: string): Promise<string> {
  const requested = new URL(rawUrl);
  if (requested.protocol !== "http:" && requested.protocol !== "https:") throw new Error("Preview URL must use HTTP or HTTPS");
  const cached = previewResolutionCache.get(requested.origin);
  if (cached && cached.expiresAt > Date.now()) {
    const local = new URL(cached.localOrigin);
    local.pathname = requested.pathname;
    local.search = requested.search;
    local.hash = requested.hash;
    return local.toString();
  }
  const [serveStatusRaw, listenersRaw] = await Promise.all([
    command("tailscale", ["serve", "status", "--json"]),
    command("ss", ["-H", "-ltnp"]),
  ]);
  const target = extractServeTargets(JSON.parse(serveStatusRaw)).find((candidate) => {
    try {
      return new URL(candidate.url).origin === requested.origin;
    } catch {
      return false;
    }
  });
  if (!target) throw new Error("URL is not an active Tailscale App Preview target");
  const activePorts = new Set(parseLocalListeners(listenersRaw).map((listener) => listener.port));
  if (!activePorts.has(target.localPort)) throw new Error("The preview service is no longer running");
  const local = new URL(`http://127.0.0.1:${target.localPort}`);
  previewResolutionCache.set(requested.origin, {
    localOrigin: local.origin,
    expiresAt: Date.now() + RESOLUTION_CACHE_MS,
  });
  local.pathname = requested.pathname;
  local.search = requested.search;
  local.hash = requested.hash;
  return local.toString();
}

async function withPreviewPage<T>(
  rawUrl: string,
  viewport: { width: number; height: number },
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  const localUrl = await resolveLocalPreviewUrl(rawUrl);
  const browser = await chromium.launch({
    executablePath: process.env.POLPO_CHROMIUM_EXECUTABLE || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.goto(localUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await Promise.allSettled([
      page.waitForLoadState("load", { timeout: 3_000 }),
      page.waitForLoadState("networkidle", { timeout: 2_000 }),
      page.evaluate(async () => {
        const assetsReady = Promise.allSettled([
          document.fonts.ready,
          ...Array.from(document.images)
            .filter((image) => !image.complete)
            .map((image) => image.decode()),
        ]);
        await Promise.race([
          assetsReady,
          new Promise<void>((resolve) => window.setTimeout(resolve, 2_000)),
        ]);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
    ]);
    return await operation(page);
  } finally {
    await browser.close();
  }
}

async function getInspectionPage(rawUrl: string, viewport: { width: number; height: number }): Promise<Page> {
  const localUrl = await resolveLocalPreviewUrl(rawUrl);
  const key = `${localUrl}|${viewport.width}x${viewport.height}`;
  let pending = inspectionSessions.get(key);
  if (!pending) {
    pending = (async () => {
      const browser = await chromium.launch({
        executablePath: process.env.POLPO_CHROMIUM_EXECUTABLE || "/usr/bin/google-chrome",
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const page = await browser.newPage({ viewport });
        await page.goto(localUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
        return { browser, page };
      } catch (error) {
        await browser.close();
        throw error;
      }
    })();
    inspectionSessions.set(key, pending);
    void pending.catch(() => inspectionSessions.delete(key));
  }

  const session = await pending;
  if (session.expiry) clearTimeout(session.expiry);
  session.expiry = setTimeout(() => {
    inspectionSessions.delete(key);
    void session.browser.close();
  }, INSPECTION_IDLE_MS);
  session.expiry.unref?.();
  return session.page;
}

function readViewport(value: unknown): { width: number; height: number } {
  const input = value as { width?: unknown; height?: unknown } | undefined;
  const width = Number(input?.width);
  const height = Number(input?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || width > 3840 || height < 160 || height > 3840) {
    throw new Error("Invalid preview viewport");
  }
  return { width: Math.floor(width), height: Math.floor(height) };
}

export async function discoverAppPreviewTargets(excludedPorts = new Set<number>()): Promise<{
  hostname?: string;
  targets: AppPreviewTarget[];
  suggested?: AppPreviewTarget;
}> {
  const [tailscaleStatusRaw, serveStatusRaw, listenersRaw] = await Promise.all([
    command("tailscale", ["status", "--json"]),
    command("tailscale", ["serve", "status", "--json"]),
    command("ss", ["-H", "-ltnp"]),
  ]);
  const tailscaleStatus = JSON.parse(tailscaleStatusRaw) as { Self?: { DNSName?: string } };
  const hostname = tailscaleStatus.Self?.DNSName?.replace(/\.$/, "");
  const configured = extractServeTargets(JSON.parse(serveStatusRaw));
  const listeners = new Map(parseLocalListeners(listenersRaw).map((listener) => [listener.port, listener]));

  const targets = (await Promise.all(configured.map(async (target): Promise<AppPreviewTarget | undefined> => {
    const listener = listeners.get(target.localPort);
    if (!listener) return undefined;
    const details = await describeListener(listener);
    return {
      port: target.port,
      url: target.url,
      label: details.label,
      infrastructure: details.infrastructure,
      ...(details.cwd ? { cwd: details.cwd } : {}),
    };
  }))).filter((target): target is AppPreviewTarget => Boolean(target));

  const suggested = targets.find((target) => !target.infrastructure && !excludedPorts.has(target.port));
  return { hostname, targets, suggested };
}

async function resolveActivePreviewTarget(rawUrl: string): Promise<{
  target: ConfiguredTarget;
  listener: LocalListener;
  details: Awaited<ReturnType<typeof describeListener>>;
}> {
  const requested = new URL(rawUrl);
  if (requested.protocol !== "http:" && requested.protocol !== "https:") {
    throw new Error("Preview URL must use HTTP or HTTPS");
  }

  const [serveStatusRaw, listenersRaw] = await Promise.all([
    command("tailscale", ["serve", "status", "--json"]),
    command("ss", ["-H", "-ltnp"]),
  ]);
  const target = extractServeTargets(JSON.parse(serveStatusRaw)).find((candidate) => {
    try {
      return new URL(candidate.url).origin === requested.origin;
    } catch {
      return false;
    }
  });
  if (!target) throw new Error("URL is not an active Tailscale App Preview target");

  const listener = parseLocalListeners(listenersRaw).find((candidate) => candidate.port === target.localPort);
  if (!listener) throw new Error("The preview service is no longer running");
  return { target, listener, details: await describeListener(listener) };
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  return realpath(absolute).catch(() => absolute);
}

export async function ensurePreviewWorkspace(
  store: CodingSessionStore,
  agentWorkDir: string,
  cwd: string,
): Promise<{ state: CodingSessionState; workspaceId: string }> {
  const canonicalCwd = await canonicalPath(cwd);
  const { state } = await store.getState();
  let workspace = undefined as CodingSessionState["workspaces"][number] | undefined;

  for (const candidate of state.workspaces) {
    const candidatePath = await canonicalPath(resolve(agentWorkDir, candidate.cwd));
    if (candidatePath === canonicalCwd) {
      workspace = candidate;
      break;
    }
  }

  if (workspace) return { state, workspaceId: workspace.id };

  const workspaceId = `workspace_preview_${nanoid(8)}`;
  const terminalId = `terminal_preview_${nanoid(8)}`;
  const nextState: CodingSessionState = {
    ...state,
    workspaces: [
      ...state.workspaces,
      { id: workspaceId, name: basename(canonicalCwd) || "App Preview", cwd: canonicalCwd },
    ],
    terminals: [
      ...state.terminals,
      { id: terminalId, workspaceId, label: "App Preview", revision: 0 },
    ],
    activeId: terminalId,
  };
  return { state: await store.saveState(nextState), workspaceId };
}

function codeServerSessionId(workspaceId: string): string {
  return `vscode_${workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

export function appPreviewRoutes(getDeps?: () => AppPreviewRouteDeps): Hono {
  const app = new Hono();

  app.get("/targets", async (c) => {
    const excludedPorts = new Set(
      (c.req.query("excludePorts") ?? "")
        .split(",")
        .map((value) => parsePort(value.trim()))
        .filter((port): port is number => port !== undefined),
    );
    try {
      const discovery = await discoverAppPreviewTargets(excludedPorts);
      return c.json({ ok: true, data: discovery });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not inspect Tailscale Serve",
      }, 503);
    }
  });

  app.post("/code-server/start", async (c) => {
    try {
      const deps = getDeps?.();
      if (!deps?.codeServerManager) {
        return c.json({ ok: false, error: "code-server is not available on this server." }, 501);
      }
      const body = await c.req.json().catch(() => undefined) as {
        url?: unknown;
        cwd?: unknown;
        theme?: unknown;
        force?: unknown;
      } | undefined;
      if (typeof body?.url !== "string" && typeof body?.cwd !== "string") throw new Error("Preview URL or workspace is required");
      const theme: CodeServerTheme = body.theme === "light" ? "light" : "dark";
      let requestedCwd: string;
      if (typeof body.cwd === "string" && body.cwd.trim()) {
        requestedCwd = body.cwd;
      } else {
        const resolvedTarget = await resolveActivePreviewTarget(body.url as string);
        if (resolvedTarget.details.infrastructure) throw new Error("Platform services cannot be opened as App Preview workspaces");
        if (!resolvedTarget.details.cwd) throw new Error("Could not determine the preview process working directory");
        requestedCwd = resolvedTarget.details.cwd;
      }
      const cwd = await canonicalPath(requestedCwd);
      const { state, workspaceId } = await ensurePreviewWorkspace(deps.codingSessionStore, deps.agentWorkDir, cwd);
      const sessionId = codeServerSessionId(workspaceId);
      const running = deps.codeServerManager.getSession(sessionId);
      const force = body.force === true || Boolean(running && await canonicalPath(running.cwd) !== cwd);
      const info = await deps.codeServerManager.ensureSession(sessionId, cwd, { force, theme });
      const now = new Date().toISOString();
      const existing = state.codeServers.find((session) => session.id === sessionId);
      const nextState = await deps.codingSessionStore.saveState({
        ...state,
        codeServers: [
          ...state.codeServers.filter((session) => session.id !== sessionId),
          {
            id: sessionId,
            workspaceId,
            cwd: info.cwd,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          },
        ],
      });
      const request = new URL(c.req.url);
      const directUrl = `${request.protocol}//${request.hostname}:${info.port}/`;

      return c.json({
        ok: true,
        data: {
          ...info,
          directUrl,
          workspaceId,
          workspaceName: basename(info.cwd) || "App Preview",
          state: nextState,
        },
      });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not open App Preview in VS Code",
      }, 400);
    }
  });

  app.post("/screenshot", async (c) => {
    try {
      const body = await c.req.json() as { url?: unknown; viewport?: unknown; fullPage?: unknown; selector?: unknown };
      if (typeof body.url !== "string") throw new Error("Preview URL is required");
      const viewport = readViewport(body.viewport);
      if (body.selector !== undefined && (typeof body.selector !== "string" || !body.selector.trim() || body.selector.length > 2_000)) {
        throw new Error("Invalid screenshot selector");
      }
      const image = await withPreviewPage(body.url, viewport, async (page) => {
        if (typeof body.selector === "string") {
          const element = page.locator(body.selector).first();
          await element.waitFor({ state: "visible", timeout: 5_000 });
          return element.screenshot({ type: "png", animations: "disabled", timeout: 5_000 });
        }
        return page.screenshot({
          type: "png",
          fullPage: body.fullPage === true,
          animations: "disabled",
        });
      });
      return new Response(new Uint8Array(image), {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store",
          "x-polpo-screenshot-target": typeof body.selector === "string" ? "element" : "viewport",
        },
      });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "Screenshot failed" }, 400);
    }
  });

  app.post("/inspect", async (c) => {
    try {
      const body = await c.req.json() as { url?: unknown; viewport?: unknown; x?: unknown; y?: unknown };
      if (typeof body.url !== "string") throw new Error("Preview URL is required");
      const viewport = readViewport(body.viewport);
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > viewport.width || y < 0 || y > viewport.height) {
        throw new Error("Invalid inspection coordinates");
      }
      const page = await getInspectionPage(body.url, viewport);
      const node = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!element) return null;

        const quote = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const selectorFor = (target: HTMLElement): string => {
          if (target.id) return `#${CSS.escape(target.id)}`;
          const testId = target.getAttribute("data-testid");
          if (testId) return `[data-testid="${quote(testId)}"]`;
          const path: string[] = [];
          let current: HTMLElement | null = target;
          while (current && current !== document.body && path.length < 6) {
            let part = current.tagName.toLowerCase();
            const name = current.getAttribute("name");
            if (name) {
              part += `[name="${quote(name)}"]`;
              path.unshift(part);
              break;
            }
            const siblings = current.parentElement
              ? [...current.parentElement.children].filter((item) => item.tagName === current?.tagName)
              : [];
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            path.unshift(part);
            current = current.parentElement;
          }
          return path.join(" > ");
        };

        const rect = element.getBoundingClientRect();
        const attributes = Object.fromEntries(
          ["id", "class", "name", "role", "aria-label", "data-testid", "href", "type"]
            .map((name) => [name, element.getAttribute(name)])
            .filter((entry): entry is [string, string] => entry[1] !== null),
        );
        return {
          tagName: element.tagName.toLowerCase(),
          selector: selectorFor(element),
          text: (element.innerText || element.textContent || "").trim().slice(0, 500),
          attributes,
          outerHTML: element.outerHTML.slice(0, 2_000),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }, { x, y });
      if (!node) return c.json({ ok: false, error: "No element found at these coordinates" }, 404);
      return c.json({ ok: true, data: node });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "Inspection failed" }, 400);
    }
  });

  return app;
}
