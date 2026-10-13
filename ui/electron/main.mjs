import { app, BrowserWindow, dialog, shell } from "electron";

import { spawn } from "node:child_process";
import { resolve, dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 3890;
const HEALTH_URL = `http://localhost:${SERVER_PORT}/api/v1/health`;
const CONFIG_DIR = join(homedir(), ".polpo-desktop");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

let serverProcess = null;
let mainWindow = null;

// Smoke test (CI): POLPO_SMOKE_TEST=<result file> opens the app with the project folder given as
// argument, checks the window loads the UI and the UI talks to the server, writes the result and exits.
const SMOKE_RESULT = process.env.POLPO_SMOKE_TEST;

/** An error dialog, or a log line in the smoke test (a dialog would wait forever in CI). */
function showError(title, message) {
  if (SMOKE_RESULT) console.error(`[Polpo] ${title}: ${message}`);
  else dialog.showErrorBox(title, message);
}

// ── Config persistence ───────────────────────────────────────────────────

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Work directory resolution ────────────────────────────────────────────

async function resolveWorkDir() {
  // 1. CLI argument: ./Polpo.AppImage /path/to/project
  //    argv[0] is always the executable (electron binary or AppImage mount).
  //    Everything after that is user args + flags.
  //    We skip argv[0], the APPIMAGE env path, and any --flags.
  const skip = new Set([process.argv[0]]);
  if (process.env.APPIMAGE) skip.add(process.env.APPIMAGE);

  console.log("[Polpo] process.argv:", process.argv);
  console.log("[Polpo] APPIMAGE env:", process.env.APPIMAGE);

  const cliArg = process.argv.slice(1).find((a) => {
    if (skip.has(a)) return false;
    if (a.startsWith("--")) return false;
    return true;
  });

  console.log("[Polpo] Detected CLI arg:", cliArg);

  if (cliArg) {
    const dir = resolve(cliArg);
    mkdirSync(dir, { recursive: true });
    saveConfig({ workDir: dir });
    return dir;
  }

  // 2. Saved from previous session
  const config = loadConfig();
  if (config.workDir && existsSync(config.workDir)) {
    return config.workDir;
  }

  // 3. First launch — ask the user
  const result = await dialog.showOpenDialog({
    title: "Select your project directory",
    message: "Choose the directory where Polpo should work",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: homedir(),
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const dir = result.filePaths[0];
  saveConfig({ workDir: dir });
  return dir;
}

// ── Health check ─────────────────────────────────────────────────────────

function checkServerHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(maxRetries = 30, exited = () => false) {
  for (let i = 0; i < maxRetries; i++) {
    if (await checkServerHealth()) return true;
    if (exited()) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Sidecar binary resolution ────────────────────────────────────────────

function findServerBinary() {
  // In packaged app: resources/polpo-server (or .exe on Windows)
  const ext = process.platform === "win32" ? ".exe" : "";
  const resourcePath = join(process.resourcesPath, `polpo-server${ext}`);
  if (existsSync(resourcePath)) return resourcePath;

  // Dev fallback: look for compiled binary next to electron dir
  const devPath = resolve(__dirname, "..", "binaries", `polpo-server${ext}`);
  if (existsSync(devPath)) return devPath;

  return null;
}

// ── Server lifecycle ─────────────────────────────────────────────────────

async function ensureServer(workDir) {
  // 1. Check if server is already running (user started it separately)
  if (await checkServerHealth()) {
    console.log("[Polpo] Server already running on port", SERVER_PORT);
    return true;
  }

  // 2. Find and spawn the sidecar binary
  const binary = findServerBinary();
  if (!binary) {
    console.error("[Polpo] Server binary not found");
    showError(
      "Polpo Server Not Found",
      "Could not find the Polpo server binary. Please reinstall the application."
    );
    return false;
  }

  console.log("[Polpo] Starting server:", binary);
  console.log("[Polpo] Working directory:", workDir);
  // The server's external packages (playwright-core, sharp) ship next to it in node_modules:
  // found through NODE_PATH wherever Polpo was started from.
  const modulesDir = join(dirname(binary), "node_modules");
  const nodePath = [modulesDir, process.env.NODE_PATH].filter(Boolean).join(delimiter);
  const logPath = join(app.getPath("logs"), "server.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} ${binary} serve -d ${workDir}\n`);
  let output = "";
  const keep = (data) => {
    log.write(data);
    output = (output + data).slice(-4000);
  };

  serverProcess = spawn(binary, ["serve", "-p", String(SERVER_PORT), "-d", workDir], {
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_PATH: nodePath },
  });

  serverProcess.stdout.on("data", (data) => {
    process.stdout.write(`[server] ${data}`);
    keep(data);
  });

  serverProcess.stderr.on("data", (data) => {
    process.stderr.write(`[server] ${data}`);
    keep(data);
  });

  let exitCode = null;
  serverProcess.on("exit", (code) => {
    console.log(`[Polpo] Server exited with code ${code}`);
    exitCode = code ?? -1;
    serverProcess = null;
  });
  serverProcess.on("error", (err) => {
    keep(`${err.message}\n`);
    exitCode = -1;
    serverProcess = null;
  });

  // 3. Wait for server to be healthy (stop early if it exits)
  const ready = await waitForServer(30, () => exitCode !== null);
  if (!ready) {
    console.error("[Polpo] Server failed to start");
    const reason = exitCode !== null ? `The Polpo server exited with code ${exitCode}.` : "The Polpo server did not start in time.";
    const lastLines = output.trim().split(/\r?\n/).slice(-12).join("\n");
    showError(
      "Server Start Failed",
      `${reason}\n\n${lastLines || "(no output)"}\n\nFull log: ${logPath}`
    );
    return false;
  }

  console.log("[Polpo] Server is ready");
  return true;
}

function killServer() {
  if (serverProcess) {
    console.log("[Polpo] Shutting down server...");
    serverProcess.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill("SIGKILL");
      }
    }, 5000);
    serverProcess = null;
  }
}

// ── Window ───────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Polpo",
    icon: join(__dirname, "..", "dist", "icons", "icon-512.png"),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // Allow file:// to call localhost API
    },
  });

  // Load the built React app from dist/
  const indexPath = join(__dirname, "..", "dist", "index.html");
  console.log("[Polpo] __dirname:", __dirname);
  console.log("[Polpo] indexPath:", indexPath);
  console.log("[Polpo] indexPath exists:", existsSync(indexPath));
  if (SMOKE_RESULT) watchSmokeTest(mainWindow);
  openLinksInBrowser(mainWindow);
  mainWindow.loadFile(indexPath);

  // Open DevTools in development / debug
  if (process.argv.includes("--devtools") || process.env.POLPO_DEVTOOLS) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Web pages go to the default browser, not a bare Electron window: provider logins
 * (window.open of the OAuth page) need the real browser, with its saved sessions and
 * passkeys, and some providers refuse embedded browsers. The app itself stays on file://.
 */
function openLinksInBrowser(win) {
  const external = (url) => /^(https?|mailto):/i.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:")) return;
    event.preventDefault();
    if (external(url)) shell.openExternal(url).catch(() => {});
  });
}

// ── Smoke test ──────────────────────────────────────────────────────────

/** Pages the usage check opens: each must render without hitting an error boundary. */
const SMOKE_PAGES = ["dashboard", "chat", "agents", "tasks", "missions", "skills", "memory", "schedules", "events", "files", "config"];

/**
 * The window must load every local file (no file:// errors), render the app into #root and reach the
 * server (an API request answered without error) within 45 s. With POLPO_SMOKE_CHAT_REPLY it is also
 * used: a chat message to Polpo must get that reply (the CI runs a mock model), and the main pages
 * must render without an error boundary. The result goes to SMOKE_RESULT.
 */
function watchSmokeTest(win) {
  const fileErrors = [];
  const apiOk = [];
  const consoleErrors = [];
  const { session } = win.webContents;
  session.webRequest.onErrorOccurred(({ url, error }) => {
    if (url.startsWith("file:")) fileErrors.push(`${url}: ${error}`);
  });
  session.webRequest.onCompleted(({ url, statusCode }) => {
    if (url.startsWith(`http://localhost:${SERVER_PORT}/`) && statusCode < 400) apiOk.push(url);
  });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  win.webContents.on("did-fail-load", (_event, _code, description, url) => fileErrors.push(`${url}: ${description}`));

  win.webContents.once("did-finish-load", async () => {
    let rendered = 0;
    for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
      rendered = await win.webContents.executeJavaScript('document.getElementById("root")?.childElementCount ?? 0').catch(() => 0);
      if (rendered > 0 && apiOk.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const loaded = fileErrors.length === 0 && rendered > 0 && apiOk.length > 0;
    const usage = loaded && process.env.POLPO_SMOKE_CHAT_REPLY ? await smokeUsage(win, process.env.POLPO_SMOKE_CHAT_REPLY) : undefined;
    const ok = loaded && (!usage || usage.ok);
    const result = { ok, rendered, api: apiOk.slice(0, 5), fileErrors, usage, consoleErrors: consoleErrors.slice(0, 20) };
    writeFileSync(SMOKE_RESULT, JSON.stringify(result, null, 2));
    console.log("[Polpo] smoke test:", JSON.stringify(result));
    killServer();
    app.exit(ok ? 0 : 1);
  });
}

/** Use the app as a person would: a chat turn through the UI's API base, then the main pages. */
async function smokeUsage(win, expectedReply) {
  const run = (code) => win.webContents.executeJavaScript(code);
  // the same base URL and endpoint the chat page uses (VITE_POLPO_API_URL)
  const chat = await run(`fetch("http://localhost:${SERVER_PORT}/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "Hello from the desktop smoke test" }] }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, error: String(e) }))`).catch((e) => ({ status: 0, error: String(e) }));
  const reply = chat?.body?.choices?.[0]?.message?.content ?? "";
  const chatOk = chat?.status === 200 && reply.includes(expectedReply);

  const pages = [];
  for (const page of SMOKE_PAGES) {
    await run(`location.hash = "#/${page}"`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const state = await run(`({
      rendered: (document.getElementById("root")?.innerText ?? "").trim().length,
      crashed: [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes("Dettagli tecnici")),
      hash: location.hash,
    })`).catch((e) => ({ rendered: 0, crashed: true, error: String(e) }));
    pages.push({ page, ok: state.rendered > 0 && !state.crashed, ...state });
  }
  const ok = chatOk && pages.every((p) => p.ok);
  return { ok, chat: { ok: chatOk, status: chat?.status, reply: reply.slice(0, 200), error: chat?.error ?? chat?.body?.error?.message }, pages };
}

// ── Auto-updater ────────────────────────────────────────────────────────

async function setupAutoUpdater() {
  let autoUpdater;
  try {
    const mod = await import("electron-updater");
    autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater;
  } catch {
    console.log("[Polpo] electron-updater not available, skipping auto-update");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[Polpo] Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[Polpo] Update available:", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[Polpo] App is up to date");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[Polpo] Download: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[Polpo] Update downloaded:", info.version);
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: `Polpo ${info.version} has been downloaded.`,
        detail: "The update will be installed when you restart the app.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true);
        }
      });
    }
  });

  autoUpdater.on("error", (err) => {
    console.log("[Polpo] Auto-update error:", err.message);
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

// ── App lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const workDir = await resolveWorkDir();
  if (!workDir) {
    app.quit();
    return;
  }

  const serverOk = await ensureServer(workDir);
  if (!serverOk) {
    if (SMOKE_RESULT) {
      writeFileSync(SMOKE_RESULT, JSON.stringify({ ok: false, error: "the server did not start" }, null, 2));
      app.exit(1);
    } else app.quit();
    return;
  }

  createWindow();

  // Check for updates after window is up (non-blocking)
  if (!SMOKE_RESULT) setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS, apps stay active until Cmd+Q
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  killServer();
});
