import { app, BrowserWindow, dialog } from "electron";
import pkg from "electron-updater";
const { autoUpdater } = pkg;
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = 3890;
const HEALTH_URL = `http://localhost:${SERVER_PORT}/api/v1/health`;
const CONFIG_DIR = join(homedir(), ".polpo-desktop");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

let serverProcess = null;
let mainWindow = null;

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

async function waitForServer(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    if (await checkServerHealth()) return true;
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
    dialog.showErrorBox(
      "Polpo Server Not Found",
      "Could not find the Polpo server binary. Please reinstall the application."
    );
    return false;
  }

  console.log("[Polpo] Starting server:", binary);
  console.log("[Polpo] Working directory:", workDir);
  serverProcess = spawn(binary, ["serve", "-p", String(SERVER_PORT), "-d", workDir], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  serverProcess.stdout.on("data", (data) => {
    process.stdout.write(`[server] ${data}`);
  });

  serverProcess.stderr.on("data", (data) => {
    process.stderr.write(`[server] ${data}`);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[Polpo] Server exited with code ${code}`);
    serverProcess = null;
  });

  // 3. Wait for server to be healthy
  const ready = await waitForServer(30);
  if (!ready) {
    console.error("[Polpo] Server failed to start within 15s");
    dialog.showErrorBox(
      "Server Start Failed",
      "Polpo server did not start in time. Check logs for details."
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
  mainWindow.loadFile(indexPath);

  // Open DevTools in development / debug
  if (process.argv.includes("--devtools") || process.env.POLPO_DEVTOOLS) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Auto-updater ────────────────────────────────────────────────────────

function setupAutoUpdater() {
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
    // Notify the user — install on next restart
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

  // Check for updates (non-blocking, silent on first launch)
  autoUpdater.checkForUpdates().catch(() => {
    // Ignore errors — offline, no releases yet, etc.
  });
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
    app.quit();
    return;
  }

  createWindow();

  // Check for updates after window is up (non-blocking)
  setupAutoUpdater();

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
